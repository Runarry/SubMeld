/* global document, window */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';

const raw = (name) => ({
  type: 'ss',
  name,
  server: 'example.com',
  port: 443,
  cipher: 'aes-128-gcm',
  password: 'public-browser-sync',
});
const content = (...names) => JSON.stringify({ proxies: names.map(raw) });
const source = (page, name, ...nodes) =>
  api(page, '/api/nodes', { name, source: 'local', content: content(...nodes) });
const native = (page, resource, body) =>
  api(page, '/upstream/sub-store/api/sub/' + resource.upstreamName, body, body ? 'PATCH' : 'GET');
const focus = (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test('node deletion and script exclusion display verified upstream outcomes', async ({
  page,
}, info) => {
  await login(page);
  const resource = await source(page, 'actions-' + randomUUID(), 'remove', 'keep');
  try {
    await native(page, resource, { mergeSources: 'localFirst', url: '' });
    await page.goto('/submeld/#/nodes?resource=' + resource.id);
    await page
      .locator('.node-row')
      .filter({ hasText: 'remove' })
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已核验删除 1 个、排除 0 个' }),
    ).toBeVisible();
    await expect(page.locator('.node-row')).toHaveCount(1);
    expect((await native(page, resource)).data.content).not.toContain('remove');
    await native(page, resource, {
      process: [
        {
          type: 'Script Operator',
          args: {
            mode: 'script',
            content:
              'function operator(proxies) { return [...proxies,' +
              JSON.stringify(raw('generated')) +
              ']; }',
          },
        },
      ],
    });
    await focus(page);
    const generated = page.locator('.node-row').filter({ hasText: 'generated' });
    await generated.getByRole('button', { name: '排除', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '排除节点', exact: true })).toContainText(
      '原始内容保留',
    );
    await page.getByRole('button', { name: '确认排除', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已核验删除 0 个、排除 1 个' }),
    ).toBeVisible();
    await expect(generated).toHaveCount(0);
    expect(
      JSON.parse((await native(page, resource)).data.content).proxies.map((node) => node.name),
    ).toEqual(['keep']);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('node-sync-actions.png'), fullPage: true });
  } finally {
    await cleanup(page, { resource });
  }
});

test('foreground polling preserves unchanged selections and coalesces reads; visibility and focus refresh changed snapshots', async ({
  page,
}) => {
  await page.clock.install();
  await login(page);
  const resource = await source(page, 'polling-' + randomUUID(), 'before');
  let release;
  try {
    await page.goto('/submeld/#/nodes?resource=' + resource.id);
    const checkbox = page.getByRole('checkbox', { name: '选择 before', exact: true });
    await checkbox.check();
    const started = Promise.withResolvers();
    release = Promise.withResolvers();
    let reads = 0;
    await page.route('**/api/nodes?*', async (route) => {
      reads++;
      const response = await route.fetch();
      if (reads === 1) {
        started.resolve();
        await release.promise;
      }
      await route.fulfill({ response });
    });
    await page.clock.fastForward(30000);
    await started.promise;
    await focus(page);
    await page.clock.fastForward(30000);
    expect(reads).toBe(1);
    release.resolve();
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).toBeChecked();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(30000);
    expect(reads).toBe(1);
    await native(page, resource, { content: content('after') });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('checkbox', { name: '选择 after', exact: true })).not.toBeChecked();
    await expect(checkbox).toHaveCount(0);
    await expect(page.locator('.selection-bar')).toContainText('已选 0');
    await native(page, resource, { content: content('focused') });
    await focus(page);
    await expect(page.getByRole('checkbox', { name: '选择 focused', exact: true })).toBeVisible();
  } finally {
    release?.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await cleanup(page, { resource });
  }
});

test('failed and partial list reads are not displayed as an empty upstream and stale rows cannot mutate', async ({
  page,
}, info) => {
  await login(page);
  const resource = await source(page, 'read-failure-' + randomUUID(), 'kept');
  try {
    await page.goto('/submeld/#/nodes?resource=' + resource.id);
    const row = page.locator('.node-row').filter({ hasText: 'kept' });
    await expect(row).toBeVisible();
    await page.route('**/api/nodes?*', (route) =>
      route.fulfill({
        status: 503,
        json: { code: 'SUB_STORE_UNAVAILABLE', message: '受控上游不可用' },
      }),
    );
    await page.getByRole('button', { name: '刷新上游', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '下面是上次读取结果' })).toBeVisible();
    await expect(row.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    await expect(row.getByRole('checkbox')).toBeDisabled();
    await expect(
      page.getByText('当前没有节点。可添加订阅地址或粘贴节点文本。', { exact: true }),
    ).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('node-sync-stale.png'), fullPage: true });
    await page.unrouteAll({ behavior: 'wait' });
    await page.route('**/api/nodes?*', (route) =>
      route.fulfill({
        status: 200,
        json: {
          nodes: [],
          resources: [resource],
          total: 0,
          complete: false,
          readAt: new Date().toISOString(),
          errors: [{ resourceId: resource.id, message: '受控预览失败' }],
        },
      }),
    );
    await focus(page);
    await expect(page.getByText(/部分订阅读取失败/)).toBeVisible();
    await expect(
      page.getByText('当前没有节点。可添加订阅地址或粘贴节点文本。', { exact: true }),
    ).toHaveCount(0);
    await page.unrouteAll({ behavior: 'wait' });
    await focus(page);
    await expect(row.getByRole('button', { name: '删除', exact: true })).toBeEnabled();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await cleanup(page, { resource });
  }
});

test('partial deletion keeps confirmed counts, refreshes upstream rows and requires a new selection', async ({
  page,
}, info) => {
  await login(page);
  const name = 'partial-' + randomUUID();
  const resources = [await source(page, name + '-a', name), await source(page, name + '-b', name)];
  try {
    await page.goto('/submeld/#/nodes?search=' + name);
    await expect(page.locator('.node-row')).toHaveCount(2);
    for (const checkbox of await page.locator('.node-row input[type=checkbox]').all())
      await checkbox.check();
    let attempts = 0;
    await page.route('**/api/nodes/delete', async (route) => {
      attempts++;
      const nodes = route.request().postDataJSON().nodes;
      const result = await api(page, '/api/nodes/delete', { nodes: [nodes[0]] });
      const pending = resources.find((resource) => resource.id === nodes[1].resourceId);
      result.resources.push({
        resourceId: pending.id,
        name: pending.name,
        state: 'notAttempted',
        deleted: 0,
        excluded: 0,
        message: '尚未执行。',
      });
      await route.fulfill({
        status: 502,
        json: {
          code: 'UPSTREAM_PARTIAL_WRITE',
          message: '未能确认全部操作完成。已核验删除 1 个、排除 0 个。',
          nodeMutation: result,
        },
      });
    });
    await page.getByRole('button', { name: '删除所选', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '删除节点', exact: true })).toHaveCount(0);
    await expect(page.locator('.node-row')).toHaveCount(1);
    await expect(
      page.getByRole('status').filter({ hasText: '未能确认全部操作完成' }),
    ).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: '尚未执行' })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除所选', exact: true })).toBeDisabled();
    expect(attempts).toBe(1);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('node-sync-partial.png'), fullPage: true });
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    for (const resource of resources) await cleanup(page, { resource });
  }
});
