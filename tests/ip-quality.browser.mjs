import { test, expect } from '@playwright/test';
import { login, navigate, noOverflow } from './browser-helpers.mjs';
import { IpQualityService } from '../dist/server/ip-quality.js';
import { qualityFetch, qualityDns } from './ip-quality-fixtures.mjs';

const endpoint = '**/api/ip-quality/query';
async function report(ip = '1.1.1.1') {
  return new IpQualityService({ fetch: qualityFetch, resolve: qualityDns }).query({ ip });
}
const respond = (route, value) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });

test('IP quality is manual, authenticated, source-specific and usable on desktop and mobile', async ({
  page,
}, info) => {
  await login(page);
  const requests = [],
    external = [];
  await page.route('https://**/*', (route) => {
    external.push(route.request().url());
    return route.abort();
  });
  const result = await report();
  result.status = 'partial';
  const blocked = result.sources.find((source) => source.id === 'scamalytics');
  Object.assign(blocked, { status: 'unavailable', message: '来源返回 HTTP 403，未取得有效数据。' });
  delete blocked.data;
  result.sources.find((source) => source.id === 'ipinfo').cached = true;
  const blacklist = result.dnsbl.find((item) => item.id === 'spamcop');
  Object.assign(blacklist, { status: 'listed', answers: ['127.0.0.2'], message: '名单命中' });
  result.blacklist.listed = 1;
  await page.route(endpoint, async (route) => {
    requests.push(route.request());
    await respond(route, result);
  });
  await navigate(page, 'IP 质量');
  await expect(page).toHaveURL(/#\/ip-quality$/);
  await expect(page.getByRole('heading', { name: 'IP 质量', exact: true })).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByLabel('公网 IP', { exact: true }).fill('1.1.1.1');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByRole('region', { name: '查询结果', exact: true })).toContainText(
    '部分来源可用',
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].postDataJSON()).toEqual({ ip: '1.1.1.1', refresh: false });
  const headers = await requests[0].allHeaders();
  expect(headers['x-submeld-request']).toBe('1');
  expect(headers.cookie).toContain('submeld-session=');
  await expect(page.locator('[data-source="scamalytics"]')).toContainText('HTTP 403');
  await expect(page.locator('[data-source="dbip"]')).toContainText('不支持指定 IP');
  await expect(page.locator('[data-source="ipinfo"]')).toContainText('缓存');
  await expect(page.locator('[data-source="ipapi"]')).toContainText('12.5%');
  await expect(page.locator('[data-source="ipapi"]')).toContainText('网段统计');
  await expect(page.locator('[data-source="abuseipdb"]')).toContainText('0 / 100');
  await expect(page.locator('[data-source="ipdata"]')).toContainText('未知');
  await expect(page.locator('[data-source="ipinfo"] dd', { hasText: '否' })).not.toHaveCount(0);
  await expect(page.getByRole('region', { name: 'DNSBL 黑名单', exact: true })).toContainText(
    '参与查询 5 项 · 有效结果 5 项 · 命中 1 项',
  );
  await expect(page.locator('[data-dnsbl="spamcop"]')).toContainText('127.0.0.2');
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('ip-quality-results.png'), fullPage: true });
  await page.getByRole('button', { name: '重新查询', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].postDataJSON()).toEqual({ ip: '1.1.1.1', refresh: true });
  expect(external).toHaveLength(0);
});

test('IP quality rejects invalid input and preserves partial IPv6 results without history', async ({
  page,
}, info) => {
  await login(page);
  let requests = 0;
  await page.route(endpoint, async (route) => {
    requests++;
    await respond(route, await report('2606:4700:4700::1111'));
  });
  await navigate(page, 'IP 质量');
  for (const ip of ['198.18.0.1', 'https://example.com', '1.1.1.1:443']) {
    await page.getByLabel('公网 IP', { exact: true }).fill(ip);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('单个有效的公网');
  }
  expect(requests).toBe(0);
  await page.getByLabel('公网 IP', { exact: true }).fill('2606:4700:4700::1111');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByRole('region', { name: '查询结果', exact: true })).toContainText('IPv6');
  await expect(page.getByRole('region', { name: 'DNSBL 黑名单', exact: true })).toContainText(
    '参与查询 1 项',
  );
  await expect(page.locator('[data-dnsbl="sem-ipv6"]')).toContainText('未命中');
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('ip-quality-ipv6.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'IP 质量', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '查询结果', exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
});

test('stopping or leaving IP quality cancels requests and late replies cannot replace a new query', async ({
  page,
}) => {
  await login(page);
  const pending = [];
  let immediate = false;
  await page.route(endpoint, async (route) => {
    if (immediate) return respond(route, await report('8.8.8.8'));
    pending.push(route);
  });
  await navigate(page, 'IP 质量');
  await page.getByLabel('公网 IP', { exact: true }).fill('1.1.1.1');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已停止');
  immediate = true;
  await page.getByLabel('公网 IP', { exact: true }).fill('8.8.8.8');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const overview = page.getByRole('region', { name: '查询结果', exact: true });
  await expect(overview).toContainText('8.8.8.8');
  await respond(pending[0], await report());
  await expect(overview).toContainText('8.8.8.8');
  immediate = false;
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await navigate(page, '节点');
  await navigate(page, 'IP 质量');
  await respond(pending[1], await report());
  await expect(page.getByRole('region', { name: '查询结果', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('公网 IP', { exact: true })).toHaveValue('');
});

test('expired session from IP query returns to login and discards results', async ({ page }) => {
  await login(page);
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAUTHENTICATED', message: '请先登录。' }),
    }),
  );
  await navigate(page, 'IP 质量');
  await page.getByLabel('公网 IP', { exact: true }).fill('1.1.1.1');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByLabel('管理员密码', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '查询结果', exact: true })).toHaveCount(0);
});
