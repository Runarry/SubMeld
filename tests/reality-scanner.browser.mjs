import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login, navigate, api, noOverflow } from './browser-helpers.mjs';

const base = '/api/reality-scanner';
test.beforeEach(async ({ page }) => {
  await login(page);
  const status = await api(page, base + '/status');
  if (status.active) {
    await api(page, base + '/scans/' + status.active.id + '/cancel', {});
    await expect.poll(async () => (await api(page, base + '/status')).active).toBeNull();
  }
  for (const scan of (await api(page, base + '/scans')).scans)
    await api(page, base + '/scans/' + scan.id, {}, 'DELETE');
  await navigate(page, 'REALITY 扫描');
  await expect(page.getByRole('heading', { name: 'REALITY 扫描', exact: true })).toBeVisible();
});
async function fixturePort(page) {
  return (await (await page.request.get('/__scanner_fixture')).json()).port;
}
async function prepare(page, targets) {
  await page.getByLabel('扫描目标', { exact: true }).fill(targets);
  await page.getByLabel('目标端口', { exact: true }).fill(String(await fixturePort(page)));
  await expect(page.getByRole('button', { name: '开始扫描', exact: true })).toBeEnabled();
}

test('finite scanner input, real TLS results, details, downloads and history fit desktop and narrow screens', async ({
  page,
  context,
}, info) => {
  await expect(page.getByText(/执行位置：SubMeld 服务器/)).toBeVisible();
  await expect(page.getByText(/不验证证书信任链/)).toBeVisible();
  await page.getByLabel('扫描目标', { exact: true }).fill('0.0.0.0/0');
  await expect(page.getByRole('alert')).toContainText('超过 65,536');
  await expect(page.getByRole('button', { name: '开始扫描', exact: true })).toBeDisabled();
  await page.getByLabel('扫描目标', { exact: true }).fill('https://not-a-target.test');
  await expect(page.getByRole('alert')).toContainText('不要包含 URL');
  await page.getByRole('combobox', { name: '输入方式', exact: true }).selectOption('url');
  await page.getByLabel('网页 URL', { exact: true }).fill('https://scanner-fixture.test/');
  await page.getByRole('button', { name: '提取域名', exact: true }).click();
  await expect(page.getByLabel('扫描目标', { exact: true })).toHaveValue('localhost');
  await page.getByRole('combobox', { name: '输入方式', exact: true }).selectOption('file');
  await page.getByLabel('目标文件').setInputFiles({
    name: 'targets.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('127.0.0.1\n127.0.0.1/32'),
  });
  await page.getByLabel('目标端口', { exact: true }).fill(String(await fixturePort(page)));
  await expect(page.getByText('去重后 1 个目标', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '开始扫描', exact: true }).click();
  const progress = page.getByRole('region', { name: '扫描进度' });
  await expect(progress).toContainText('已完成');
  await expect(progress).toContainText('候选 1');
  const table = page.getByRole('table', { name: 'REALITY 扫描结果' });
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table).toContainText('*.scanner.test');
  await expect(table).toContainText('TLS 1.3');
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('reality-scanner.png'), fullPage: true });
  const results = page.getByRole('region', { name: '扫描结果', exact: true });
  await results.scrollIntoViewIfNeeded();
  await results.screenshot({ path: info.outputPath('reality-results.png') });
  await table.getByRole('button', { name: '详情' }).click();
  const dialog = page.getByRole('dialog', { name: '扫描结果详情' });
  await expect(dialog).toContainText('SubMeld Test Issuer');
  await expect(dialog).toContainText('不能据此推导可用 SNI');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: '复制目标地址' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '127.0.0.1:' + (await fixturePort(page)),
  );
  await page.screenshot({ path: info.outputPath('reality-detail.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(table.getByRole('button', { name: '详情' })).toBeFocused();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV', exact: true }).click();
  const download = await downloadEvent;
  const content = await readFile(await download.path(), 'utf8');
  expect(content).toContain('CERT_DOMAIN');
  expect(content).toContain('*.scanner.test');
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  const history = page.getByRole('table', { name: '扫描历史记录' });
  await expect(history).toContainText('已完成');
  await history.getByRole('button', { name: '查看', exact: true }).click();
  await expect(progress).toContainText('已完成');
  await page.reload();
  await expect(progress).toContainText('已完成');
  await expect(table).toContainText('*.scanner.test');
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await history.getByRole('button', { name: '删除', exact: true }).click();
  await expect(history).toContainText('暂无扫描历史');
});

test('active scan survives navigation and refresh, cancellation keeps the real partial result', async ({
  page,
}) => {
  await prepare(page, '127.0.0.1\nlocalhost');
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('超时（秒）', { exact: true }).fill('30');
  await page.getByRole('button', { name: '开始扫描', exact: true }).click();
  const progress = page.getByRole('region', { name: '扫描进度' });
  await expect(progress).toContainText('已处理 1 / 2');
  await navigate(page, '网站分流测试');
  await navigate(page, 'REALITY 扫描');
  await expect(progress).toContainText('已处理 1 / 2');
  await page.reload();
  await expect(progress).toContainText('已处理 1 / 2');
  await page.getByRole('button', { name: '停止扫描', exact: true }).click();
  await expect(progress).toContainText('已取消');
  await expect(progress).toContainText('候选 1');
  await page.getByRole('combobox', { name: '结果筛选', exact: true }).selectOption('all');
  await expect(page.getByRole('table', { name: 'REALITY 扫描结果' })).toContainText(
    '*.scanner.test',
  );
  await expect(page.getByRole('button', { name: '开始扫描', exact: true })).toBeDisabled();
  await noOverflow(page);
});

test('real finite CIDR results support filter, search, pagination and filtered export', async ({
  page,
}) => {
  await prepare(page, '127.0.0.0/27');
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('并发数', { exact: true }).fill('32');
  await page.getByLabel('超时（秒）', { exact: true }).fill('1');
  await page.getByRole('button', { name: '开始扫描', exact: true }).click();
  await expect(page.getByRole('region', { name: '扫描进度' })).toContainText('已完成');
  await page.getByRole('combobox', { name: '结果筛选', exact: true }).selectOption('all');
  const table = page.getByRole('table', { name: 'REALITY 扫描结果' });
  await expect(table.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(7);
  await page.getByRole('combobox', { name: '结果筛选', exact: true }).selectOption('failed');
  await expect(page.getByText('第 1 页 · 共 31 项', { exact: true })).toBeVisible();
  await page.getByLabel('搜索结果', { exact: true }).fill('127.0.0.2');
  await expect(page.getByText('第 1 页 · 共 11 项', { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'IP TXT', exact: true }).click();
  const content = await readFile(await (await downloadEvent).path(), 'utf8');
  expect(content.trim().split('\n')).toHaveLength(11);
  expect(content).not.toContain('127.0.0.1\n');
  await noOverflow(page);
});
