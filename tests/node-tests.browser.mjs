/* global document, window */
import { test, expect } from '@playwright/test';
import { node } from './fixtures.mjs';
import { DEFAULT_PROBE_URL } from '../dist/server/shared/node-tests.js';

async function api(page, path, body, method = 'POST') {
  const response = await page.request.fetch(path, {
    method,
    data: body,
    headers: {
      Origin: 'http://127.0.0.1:3210',
      'Content-Type': 'application/json',
      'X-SubMeld-Request': '1',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function login(page) {
  await page.goto('/submeld/');
  await page.getByLabel('管理员密码', { exact: true }).fill('SubMeld-UI-Test-Only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
}
async function rowOnPages(page, name) {
  const row = page.locator('.library-main > .library-list > li').filter({ hasText: name });
  await expect(page.locator('.library-main > .library-list')).toBeVisible();
  while (!(await row.count())) {
    const next = page.getByRole('button', { name: '下一页', exact: true });
    await expect(next).toBeEnabled();
    const response = page.waitForResponse(
      (response) =>
        /\/api\/(nodes|sources)\?page=/.test(response.url()) &&
        response.request().method() === 'GET',
    );
    await next.click();
    await response;
    await expect(page.getByRole('button', { name: /^(刷新列表|刷新来源列表)$/ })).toBeEnabled();
  }
  return row;
}
async function completed(page) {
  await expect
    .poll(
      async () => (await (await page.request.get('/api/node-tests/current')).json()).batch?.state,
      { timeout: 15000 },
    )
    .toBe('completed');
}
async function cleanup(page, paths) {
  const current = await (await page.request.get('/api/node-tests/current')).json();
  if (current.batch?.state === 'running') {
    await api(page, '/api/node-tests/' + current.batch.id + '/cancel', {});
    await expect
      .poll(
        async () => (await (await page.request.get('/api/node-tests/current')).json()).batch.state,
      )
      .not.toBe('running');
  }
  await api(page, '/api/node-tests/settings', { url: DEFAULT_PROBE_URL }, 'PATCH');
  for (const path of paths) {
    const response = await page.request.get(path);
    if (response.status() === 404) continue;
    const value = await response.json();
    await api(page, path, { revision: value.revision }, 'DELETE');
  }
}

test('node tests support disabled nodes, batch progress, saved results and manual core updates', async ({
  page,
}, testInfo) => {
  test.setTimeout(45000);
  await login(page);
  const name = '实际测试界面-' + testInfo.project.name;
  const { nodes } = await api(page, '/api/nodes', {
    drafts: [
      { ...node('ss'), name: name + '-A' },
      { ...node('ss'), name: name + '-B' },
    ],
  });
  await api(page, '/api/nodes/' + nodes[0].id, { revision: 1, enabled: false }, 'PATCH');
  try {
    await page.getByRole('button', { name: '本地节点', exact: true }).click();
    const row = await rowOnPages(page, name + '-A');
    await row.getByRole('checkbox', { name: '选择本地节点 ' + name + '-A', exact: true }).check();
    const second = await rowOnPages(page, name + '-B');
    await second
      .getByRole('checkbox', { name: '选择本地节点 ' + name + '-B', exact: true })
      .check();
    await expect(
      page.getByRole('button', { name: '载入所选到工作台', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '测试所选本地节点', exact: true }).click();
    await page.getByRole('button', { name: '查看测试进度', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: '测试进度' })).toBeVisible();
    await page.getByRole('button', { name: '增强订阅', exact: true }).click();
    await completed(page);
    await page.getByRole('button', { name: '节点测试', exact: true }).click();
    await expect(page.locator('.test-results li')).toHaveCount(6);
    await page.reload();
    await expect(page.locator('.test-results li')).toHaveCount(6);
    await expect(page.locator('.test-results li').first()).toContainText('HTTPS 24.5 ms');
    await page.getByLabel('HTTPS 测试地址', { exact: true }).fill('https://example.com/probe');
    await page.getByRole('button', { name: '保存测试地址', exact: true }).click();
    await expect(page.locator('.test-results .warning-note')).toHaveCount(6);
    await page.getByRole('button', { name: '检查最新正式版', exact: true }).click();
    const xray = page
      .locator('.kernel-card')
      .filter({ has: page.getByRole('heading', { name: 'Xray', exact: true }) });
    await expect(xray).toContainText('最新正式版：26.3.27');
    await xray.getByRole('button', { name: '更新 Xray', exact: true }).click();
    await expect(xray.getByRole('button', { name: '更新 Xray', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('node-tests.png'), fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: '本地节点', exact: true }).click();
    const saved = await rowOnPages(page, name + '-A');
    await expect(saved).toContainText('需重测');
    await saved.getByRole('button', { name: '查看测试结果', exact: true }).click();
    await expect(page.locator('.test-results li')).toHaveCount(3);
  } finally {
    await cleanup(
      page,
      nodes.map((node) => '/api/nodes/' + node.id),
    );
  }
});
