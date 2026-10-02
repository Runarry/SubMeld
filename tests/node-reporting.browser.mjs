/* global document */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';

const settingsPath = '/api/integrations/node-reporting';
test('reporting settings manage tokens and accept machine snapshots without a browser session', async ({
  page,
  request,
  context,
}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await api(page, settingsPath, { enabled: false }, 'PATCH');
  await page.getByRole('button', { name: '节点', exact: true }).click();
  const id = randomUUID();
  const a = { ...toUpstream(node('ss')), name: 'reported-A-' + info.project.name };
  const b = { ...toUpstream(node('ss')), name: 'reported-B-' + info.project.name, port: 444 };
  const send = (token, proxies) =>
    request.put('/api/node-reports/' + id, {
      headers: { Authorization: 'Bearer ' + token },
      data: { name: 'browser-report', content: JSON.stringify({ proxies }) },
    });
  let resource;
  try {
    await page.getByRole('button', { name: '上报设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上报设置', exact: true });
    await dialog.getByRole('button', { name: /生成上报 Token|重置上报 Token/ }).click();
    const input = dialog.getByLabel('上报 Token', { exact: true });
    await expect(input).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    const token = await input.inputValue();
    await dialog.getByRole('button', { name: '复制 Token', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('已复制上报 Token');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
    await expect(dialog.getByLabel('上报接口', { exact: true })).toHaveValue(
      'http://127.0.0.1:3210/api/node-reports/<machineId>',
    );
    await dialog.getByLabel('启用节点上报', { exact: true }).check();
    await dialog.getByRole('button', { name: '保存上报设置', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('已启用节点上报');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('reporting-settings.png'), fullPage: true });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const response = await send(token, [a, b]);
    expect(response.status(), await response.text()).toBe(201);
    resource = (await api(page, '/api/nodes/resources')).resources.find((r) => r.id === id);
    expect(resource).toBeTruthy();
    await page.getByRole('button', { name: '刷新上游', exact: true }).click();
    await expect(page.locator('.node-row').filter({ hasText: a.name })).toBeVisible();
    await expect(page.locator('.node-row').filter({ hasText: b.name })).toBeVisible();
    expect((await send(token, [{ ...a, port: 8443 }])).status()).toBe(200);
    await page.getByRole('button', { name: '刷新上游', exact: true }).click();
    await expect(page.locator('.node-row').filter({ hasText: a.name })).toHaveCount(1);
    await expect(page.locator('.node-row').filter({ hasText: b.name })).toHaveCount(0);
    await page.getByRole('button', { name: '上报设置', exact: true }).click();
    await expect(dialog.getByLabel('启用节点上报', { exact: true })).toBeChecked();
    await expect(input).toHaveCount(0);
    await dialog.getByRole('button', { name: '重置上报 Token', exact: true }).click();
    await expect(input).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    const replacement = await input.inputValue();
    expect(replacement).not.toBe(token);
    expect((await send(token, [a])).status()).toBe(401);
    expect((await send(replacement, [a])).status()).toBe(200);
    await dialog.getByLabel('启用节点上报', { exact: true }).uncheck();
    await dialog.getByRole('button', { name: '保存上报设置', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('已停用节点上报');
    expect((await send(replacement, [a])).status()).toBe(403);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await noOverflow(page);
  } finally {
    await api(page, settingsPath, { enabled: false }, 'PATCH');
    await cleanup(page, { resource });
  }
});

test('token copy falls back to a selected field and closing removes its plaintext', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = () => false;
  });
  await login(page);
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await page.getByRole('button', { name: '上报设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上报设置', exact: true });
  await dialog.getByRole('button', { name: /生成上报 Token|重置上报 Token/ }).click();
  const input = dialog.getByLabel('上报 Token', { exact: true });
  await expect(input).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: '复制 Token', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('手动复制');
  expect(await input.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual(
    [0, 43],
  );
  await noOverflow(page);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '上报设置', exact: true }).click();
  await expect(dialog.getByText('已配置共用 Token。', { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
});
