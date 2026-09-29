/* global document, window */
import { test, expect } from '@playwright/test';
import { login } from './browser-helpers.mjs';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';

test.use({
  baseURL: 'http://submeld-http.test:3211',
  launchOptions: {
    args: ['--host-resolver-rules=MAP submeld-http.test 127.0.0.1', '--no-proxy-server'],
  },
});

async function api(page, path, body, method = body === undefined ? 'GET' : 'POST') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-SubMeld-Request': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(value));
      return value;
    },
    { path, body, method },
  );
}

test('production HTTP supports login, native pages and honest clipboard fallback', async ({
  page,
  context,
}, info) => {
  await login(page);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof navigator.clipboard)).toBe('undefined');
  const cookie = (await context.cookies()).find((c) => c.name === 'submeld-session');
  expect(cookie).toMatchObject({ secure: false, httpOnly: true, sameSite: 'Strict' });
  const wrongOrigin = await page.request.post('http://127.0.0.1:3211/api/auth/logout', {
    headers: { Origin: 'http://other.example', 'X-SubMeld-Request': '1' },
    data: {},
  });
  expect(wrongOrigin.status()).toBe(403);
  await page.reload();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  const name = 'http-share-' + info.project.name;
  const resource = await api(page, '/api/nodes', {
    name,
    source: 'local',
    content: JSON.stringify({ proxies: [toUpstream(node('ss'))] }),
  });
  let plan;
  try {
    plan = await api(page, '/api/subscriptions', {
      ...newSubscription(),
      name,
      inputs: [{ kind: 'resource', id: resource.id }],
      formats: ['mihomo'],
    });
    await page.getByRole('button', { name: '输出方案', exact: true }).click();
    await page
      .locator('.plan-row')
      .filter({ hasText: name })
      .getByRole('button', { name: '管理方案' })
      .click();
    const dialog = page.getByRole('dialog', { name: '管理输出方案', exact: true });
    await dialog.getByRole('button', { name: '创建分享地址', exact: true }).click();
    const input = dialog.getByLabel('Mihomo 完整配置 分享地址', { exact: true });
    await expect(input).toBeVisible();
    const url = await input.inputValue();
    expect(url).toMatch(/^http:\/\/submeld-http\.test:3211\/share\/file\//);
    expect(await page.evaluate(async (url) => (await fetch(url)).status, url)).toBe(200);
    await page.evaluate(() =>
      document.addEventListener(
        'copy',
        () => {
          const input = document.activeElement;
          document.documentElement.dataset.copiedSelection = input.value.slice(
            input.selectionStart,
            input.selectionEnd,
          );
        },
        { once: true },
      ),
    );
    await dialog.getByRole('button', { name: '复制', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('已复制分享地址。');
    expect(await page.evaluate(() => document.documentElement.dataset.copiedSelection)).toBe(url);
    await page.evaluate(() => {
      document.execCommand = () => false;
    });
    await dialog.getByRole('button', { name: '复制', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      '无法自动复制，请从分享地址输入框手动复制。',
    );
    expect(await input.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe(
      url,
    );
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.goto('/');
    await expect(
      page.getByText(/^(Subscription|订阅管理)$/, { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.goto('/submeld/');
    await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  } finally {
    if (plan) {
      const current = await api(page, '/api/subscriptions/' + plan.id);
      await api(page, '/api/subscriptions/' + plan.id, { revision: current.revision }, 'DELETE');
    }
    await api(page, '/upstream/sub-store/api/sub/' + resource.upstreamName, undefined, 'DELETE');
  }
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理员登录', exact: true })).toBeVisible();
  expect((await context.cookies()).some((c) => c.name === 'submeld-session')).toBe(false);
  expect(await page.evaluate(async () => (await fetch('/api/auth/me')).status)).toBe(401);
});
