import { test, expect } from '@playwright/test';
import { login, navigate, api, noOverflow } from './browser-helpers.mjs';
import { websiteRoutingPresets } from '../dist/server/shared/website-routing.js';

const routePath = '/api/website-routing/sites';
const row = (page, id) => page.locator(`tr[data-site-id="${id}"]`);
async function replaceSites(page, presets) {
  const previous = (await api(page, routePath)).sites;
  for (const site of previous) await api(page, routePath + '/' + site.id, {}, 'DELETE');
  for (const preset of presets) await api(page, routePath, { presetId: preset.key });
  return (await api(page, routePath)).sites;
}
const trace = (ip = '8.8.8.8', loc = 'US') => `ip=${ip}\nloc=${loc}\n`;
function fulfill(route, body, headers = {}, status = 200) {
  return route.fulfill({
    status,
    body,
    headers: {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': '*',
      ...headers,
    },
  });
}

test('website probes are manual browser requests with honest results, IP grouping and responsive layout', async ({
  page,
  context,
}, info) => {
  await login(page);
  const sites = await replaceSites(page, websiteRoutingPresets);
  const requests = [];
  await context.addCookies([
    {
      name: 'probe-secret',
      value: 'must-not-send',
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
    },
  ]);
  await page.route('https://**/*', async (route) => {
    requests.push(route.request());
    const host = new URL(route.request().url()).hostname;
    if (host === 'claude.ai')
      return fulfill(route, trace('2606:4700:4700:0000:0000:0000:0000:1111'));
    if (host === 'x.com') return fulfill(route, trace('198.18.0.1'));
    if (host === 'gateway.discord.gg') return route.abort('failed');
    if (host === 'gitlab.com') return fulfill(route, 'Forbidden', {}, 403);
    if (host === 'registry.npmjs.org') return fulfill(route, '<html>not a trace</html>');
    if (host === 'www.cloudflare-cn.com') return fulfill(route, trace('1.1.1.1', 'AU'));
    if (host === 'www.qualcomm.cn') return fulfill(route, trace('9.9.9.9', 'XX'));
    if (host === 'necaptcha.nosdn.127.net') return fulfill(route, '', { 'cdn-user-ip': '8.8.4.4' });
    if (host === 'perfops.byte-test.com')
      return fulfill(route, '', { 'x-response-cinfo': '149.112.112.112' });
    return fulfill(route, trace());
  });
  await navigate(page, '网站分流测试');
  await expect(page.locator('tr[data-site-id]')).toHaveCount(11);
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  await expect(page.getByRole('button', { name: '全部重测', exact: true })).toBeVisible();
  expect(requests).toHaveLength(11);
  for (const request of requests) {
    const headers = await request.allHeaders();
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    expect(headers['x-submeld-request']).toBeUndefined();
    expect(new URL(request.url()).searchParams.get('_submeld')).toBeTruthy();
  }
  expect(requests.filter((request) => request.method() === 'HEAD')).toHaveLength(2);
  await expect(page.locator('.ip-group').filter({ hasText: '8.8.8.8' })).toContainText('2 个网站');
  await expect(page.locator('.ip-group').filter({ hasText: '8.8.8.8' })).toContainText(
    'Cloudflare、ChatGPT',
  );
  await expect(page.locator('.routing-state[data-state="success"]')).toHaveCount(7);
  await expect(page.locator('.routing-state[data-state="invalid"]')).toHaveCount(2);
  await expect(page.locator('.routing-state[data-state="unavailable"]')).toHaveCount(2);
  const find = (domain) =>
    row(page, sites.find((site) => new URL(site.url).hostname === domain).id);
  await expect(find('claude.ai')).toContainText('2606:4700:4700::1111');
  await expect(find('claude.ai')).toContainText('IPv6');
  await expect(find('www.qualcomm.cn')).toContainText('未知');
  await expect(find('gitlab.com')).toContainText('HTTP 403');
  await expect(find('gateway.discord.gg')).toContainText('网络、跨域或重定向限制');
  await expect(find('www.cloudflare.com')).toContainText(/\d+ ms/);
  await expect(find('www.cloudflare.com').locator('time')).not.toHaveText('—');
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('website-routing-results.png'), fullPage: true });
  const firstUrl = requests
    .find((request) => new URL(request.url()).hostname === 'chatgpt.com')
    .url();
  await find('chatgpt.com').getByRole('button', { name: '单项重测' }).click();
  await expect.poll(() => requests.length).toBe(12);
  expect(requests.at(-1).url()).not.toBe(firstUrl);
});

test('website presets and normalized custom domains persist across devices without starting probes', async ({
  page,
  browser,
}, info) => {
  await login(page);
  await replaceSites(page, []);
  const probes = [];
  await page.route('https://**/*', (route) => {
    probes.push(route.request().url());
    return route.abort();
  });
  await navigate(page, '网站分流测试');
  await expect(page.getByText('尚未添加网站', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加网站', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: '添加网站' });
  await dialog.getByRole('combobox', { name: '预置网站', exact: true }).selectOption('chatgpt');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.locator('tr[data-site-id]')).toHaveCount(1);
  await page.getByRole('button', { name: '添加网站', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: '添加网站' });
  await dialog.getByRole('combobox', { name: '添加方式', exact: true }).selectOption('custom');
  await dialog
    .getByLabel('网站域名或网址', { exact: true })
    .fill('http://EXAMPLE.test/path?secret=discard#fragment');
  await dialog.getByLabel('网站名称（可选）', { exact: true }).fill('自定义网站');
  await expect(dialog).toContainText('实际检测域名：example.test');
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('website-routing-add.png'), fullPage: true });
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.locator('tr[data-site-id]')).toHaveCount(2);
  await page.getByRole('button', { name: '添加网站', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: '添加网站' });
  await dialog.getByRole('combobox', { name: '添加方式', exact: true }).selectOption('custom');
  await dialog.getByLabel('网站域名或网址', { exact: true }).fill('https://example.test:443/other');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('该网站已在列表中。');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(probes).toHaveLength(0);
  const second = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const device = await second.newPage();
    await login(device);
    await navigate(device, '网站分流测试');
    await expect(device.locator('tr[data-site-id]')).toHaveCount(2);
    await expect(device.locator('.routing-state[data-state="idle"]')).toHaveCount(2);
    await expect(device.getByText('自定义网站', { exact: true })).toBeVisible();
    await device.getByRole('button', { name: '移除', exact: true }).first().click();
    await expect(device.locator('tr[data-site-id]')).toHaveCount(1);
  } finally {
    await second.close();
  }
  await page.reload();
  await expect(page.locator('tr[data-site-id]')).toHaveCount(1);
  await page.getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.getByText('尚未添加网站', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('尚未添加网站', { exact: true })).toBeVisible();
  expect(probes).toHaveLength(0);
});

test('website batch limits concurrency and ignores late responses after removal, stop or leaving the page', async ({
  page,
}) => {
  await login(page);
  const sites = await replaceSites(page, websiteRoutingPresets);
  const pending = [];
  let immediate = false;
  await page.route('https://**/*', (route) => {
    if (immediate) return fulfill(route, trace('9.9.9.9'));
    pending.push(route);
  });
  await navigate(page, '网站分流测试');
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  await expect.poll(() => pending.length).toBe(4);
  await expect(page.locator('.routing-state[data-state="running"]')).toHaveCount(4);
  await expect(page.locator('.routing-state[data-state="queued"]')).toHaveCount(7);
  await row(page, sites[0].id).getByRole('button', { name: '移除' }).click();
  await expect(row(page, sites[0].id)).toHaveCount(0);
  await expect.poll(() => pending.length).toBe(5);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('.routing-state[data-state="cancelled"]')).toHaveCount(10);
  immediate = true;
  await row(page, sites[1].id).getByRole('button', { name: '单项重测' }).click();
  await expect(row(page, sites[1].id)).toContainText('9.9.9.9');
  for (const route of pending) await fulfill(route, trace('1.1.1.1'));
  await expect(row(page, sites[1].id)).toContainText('9.9.9.9');
  await expect(page.locator('.ip-group')).toHaveCount(1);
  immediate = false;
  await row(page, sites[2].id).getByRole('button', { name: '单项重测' }).click();
  await expect.poll(() => pending.length).toBe(6);
  await navigate(page, '节点');
  await navigate(page, '网站分流测试');
  await expect(page.locator('.routing-state[data-state="idle"]')).toHaveCount(10);
  await fulfill(pending.at(-1), trace('1.1.1.1'));
  await expect(page.locator('.ip-group')).toHaveCount(0);
  await expect(page.locator('.routing-state[data-state="idle"]')).toHaveCount(10);
});

test('website timeout aborts a browser probe after eight seconds and retains an honest result', async ({
  page,
}) => {
  await login(page);
  const [site] = await replaceSites(page, [websiteRoutingPresets[0]]);
  await page.clock.install();
  const pending = [];
  await page.route('https://**/*', (route) => {
    pending.push(route);
  });
  await navigate(page, '网站分流测试');
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.clock.fastForward(8001);
  await expect(row(page, site.id)).toContainText('已超时');
  await expect(row(page, site.id)).toContainText('检测超过 8 秒');
  await expect(page.getByRole('button', { name: '全部重测', exact: true })).toBeVisible();
  await fulfill(pending[0], trace());
  await expect(page.locator('.ip-group')).toHaveCount(0);
});
