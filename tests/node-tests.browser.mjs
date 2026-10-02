import { test, expect } from '@playwright/test';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { DEFAULT_PROBE_URL } from '../dist/server/shared/node-tests.js';
async function source(page, name) {
  const a = node('ss'),
    b = node('ss');
  a.name = name + '-A';
  b.name = name + '-B';
  b.port = 444;
  return api(page, '/api/nodes', {
    name,
    source: 'local',
    content: JSON.stringify({ proxies: [a, b].map(toUpstream) }),
  });
}

test('HY2 mport and certificate pins remain selectable with per-core compatibility results', async ({
  page,
}, info) => {
  await login(page);
  const resource = await api(page, '/api/nodes', {
    name: 'HY2-' + info.project.name,
    source: 'local',
    content:
      'hysteria2://test-only@example.com:20120?sni=example.com&insecure=1&mport=20120-20200&pinSHA256=' +
      'ab'.repeat(32) +
      '#HY2-test',
  });
  try {
    await page.getByRole('button', { name: '节点', exact: true }).click();
    await page.getByRole('combobox', { name: '所属订阅', exact: true }).selectOption(resource.id);
    await expect(page.locator('.node-row')).toHaveCount(1);
    await expect(page.locator('.node-row')).not.toContainText('连接字段无法');
    await page.locator('.node-row').getByRole('button', { name: '测试', exact: true }).click();
    await page.getByRole('button', { name: '三内核检查', exact: true }).click();
    await page.getByRole('button', { name: '开始三内核检查', exact: true }).click();
    await expect
      .poll(async () => (await api(page, '/api/node-tests/current')).batch?.state)
      .toBe('completed');
    const results = (await api(page, '/api/node-tests/current')).batch.results;
    expect(results.find((r) => r.core === 'mihomo').status).toBe('passed');
    expect(results.find((r) => r.core === 'singbox').message).toContain('pinSHA256');
    expect(results.find((r) => r.core === 'xray').message).toContain('Hysteria2');
    await expect(page.locator('.test-results > li')).toHaveCount(3);
    await noOverflow(page);
  } finally {
    await cleanup(page, { resource });
  }
});
test('unified batch testing includes excluded originals and retains results and settings', async ({
  page,
}, info) => {
  await login(page);
  const resource = await source(page, 'tests-' + info.project.name);
  try {
    await api(
      page,
      '/upstream/sub-store/api/sub/' + resource.upstreamName,
      { process: [{ type: 'Regex Filter', args: { regex: [], keep: true } }] },
      'PATCH',
    );
    await page.getByRole('button', { name: '节点', exact: true }).click();
    await page.getByRole('combobox', { name: '所属订阅', exact: true }).selectOption(resource.id);
    await expect(page.locator('.node-row')).toHaveCount(2);
    for (const checkbox of await page.locator('.node-row input[type=checkbox]').all())
      await checkbox.check();
    await expect(page.locator('.selection-bar')).toContainText('已选 2');
    await page.getByRole('button', { name: '测试所选', exact: true }).click();
    await page.getByRole('button', { name: '三内核检查', exact: true }).click();
    await page.getByRole('button', { name: '开始三内核检查', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: '测试进度' })).toBeVisible();
    await expect
      .poll(async () => (await api(page, '/api/node-tests/current')).batch.state, {
        timeout: 15000,
      })
      .toBe('completed');
    await expect(page.locator('.test-results > li')).toHaveCount(6);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('unified-tests.png'), fullPage: true });
    await page.getByRole('button', { name: '节点', exact: true }).click();
    await page.getByRole('combobox', { name: '所属订阅', exact: true }).selectOption(resource.id);
    await expect(page.locator('.node-test-summary').first()).toContainText('Mihomo：通过');
    await page
      .locator('.node-test-summary')
      .first()
      .getByRole('button', { name: '查看测试结果', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '节点测试', exact: true })).toBeVisible();
    await page.getByLabel('HTTPS 测试地址', { exact: true }).fill('https://127.0.0.1/');
    await page.getByRole('button', { name: '保存测试地址', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '公网 HTTPS' })).toBeVisible();
    await page.getByRole('button', { name: '使用默认测试地址', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存测试地址', exact: true })).toBeDisabled();
    await expect(page.getByLabel('HTTPS 测试地址', { exact: true })).toHaveValue(DEFAULT_PROBE_URL);
    await page.getByRole('button', { name: '检查最新正式版', exact: true }).click();
    await expect(page.getByRole('region', { name: '内核管理', exact: true })).toContainText('最新');
  } finally {
    await cleanup(page, { resource });
  }
});
test('batch cancellation remains available after navigation', async ({ page }, info) => {
  await login(page);
  const resource = await source(page, 'cancel-' + info.project.name);
  try {
    await page.getByRole('button', { name: '节点', exact: true }).click();
    await page.getByRole('combobox', { name: '所属订阅', exact: true }).selectOption(resource.id);
    await page
      .locator('.node-row')
      .first()
      .getByRole('button', { name: '测试', exact: true })
      .click();
    await page.getByRole('button', { name: '三内核检查', exact: true }).click();
    await page.getByRole('button', { name: '开始三内核检查', exact: true }).click();
    await page.getByRole('button', { name: '输出方案', exact: true }).click();
    await page.getByRole('button', { name: '测试中心', exact: true }).click();
    await page.getByRole('button', { name: '三内核检查', exact: true }).click();
    await page.getByRole('button', { name: '取消测试', exact: true }).click();
    await expect
      .poll(async () => (await api(page, '/api/node-tests/current')).batch.state)
      .toBe('cancelled');
  } finally {
    await cleanup(page, { resource });
  }
});
