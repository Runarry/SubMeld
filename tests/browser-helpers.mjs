/* global document, window */
import { expect } from '@playwright/test';
export async function login(page) {
  await page.goto('/submeld/');
  await page.getByLabel('管理员密码', { exact: true }).fill('SubMeld-UI-Test-Only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
}
export async function navigate(page, name) {
  const nav = page.getByRole('navigation', { name: '管理页面' });
  const direct = nav.getByRole('button', { name, exact: true }).first();
  if (await direct.isVisible()) await direct.click();
  else {
    await nav.getByRole('button', { name: '更多', exact: true }).click();
    await page
      .getByLabel('更多页面', { exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  }
}
export async function api(page, path, body, method = body === undefined ? 'GET' : 'POST') {
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
export async function cleanup(page, { resource, chain, plan } = {}) {
  const current = await api(page, '/api/node-tests/current');
  if (current.batch?.state === 'running') {
    await api(page, '/api/node-tests/' + current.batch.id + '/cancel', {});
    await expect
      .poll(async () => (await api(page, '/api/node-tests/current')).batch.state)
      .not.toBe('running');
  }
  for (const [type, id] of [
    ['subscriptions', plan],
    ['chains', chain],
  ])
    if (id) {
      const response = await page.request.get('/api/' + type + '/' + id);
      if (response.ok()) {
        const value = await response.json();
        await api(page, '/api/' + type + '/' + id, { revision: value.revision }, 'DELETE');
      }
    }
  if (resource)
    await api(page, '/upstream/sub-store/api/sub/' + resource.upstreamName, undefined, 'DELETE');
}
export async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
