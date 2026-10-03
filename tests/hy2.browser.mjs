import { test, expect } from '@playwright/test';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';
import { newSubscription } from '../dist/server/shared/subscriptions.js';

test('HY2 generation separates blocking errors from certificate and name warnings', async ({
  page,
}, info) => {
  await login(page);
  const uri =
    'hysteria2://test-only@example.com:20120?insecure=1&pinSHA256=' + 'ab'.repeat(32) + '#HY2';
  const resource = await api(page, '/api/nodes', {
    name: 'HY2 diagnostics ' + info.project.name,
    source: 'local',
    content: uri + '\n' + uri,
  });
  let saved;
  try {
    saved = await api(page, '/api/subscriptions', {
      ...newSubscription(),
      name: 'HY2 diagnostics ' + info.project.name,
      inputs: [{ kind: 'resource', id: resource.id }],
      formats: ['singbox', 'xray'],
    });
    await page.goto('/submeld/#/subscriptions');
    await page
      .locator('.plan-row')
      .filter({ hasText: saved.name })
      .getByRole('button', { name: '管理方案' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '预览输出', exact: true }).click();
    const errors = dialog.getByRole('alert');
    await expect(errors).toContainText('生成错误');
    await expect(errors).toContainText('证书解析连接文件');
    await expect(errors).not.toContainText('跳过证书链验证');
    await expect(errors).not.toContainText('名称重复');
    await dialog.getByText('提示（不导致生成失败）', { exact: true }).click();
    const warnings = dialog.locator('details.diagnostics');
    await expect(warnings).toContainText('跳过证书链验证');
    await expect(warnings).toContainText('追加序号');
    await expect(dialog).toContainText('同一公钥续签的证书仍可通过');
    await dialog.getByLabel('预览格式').selectOption('xray');
    await dialog.getByRole('button', { name: '预览输出', exact: true }).click();
    await expect(dialog.getByLabel('生成结果')).toHaveValue(/pinnedPeerCertSha256/);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await noOverflow(page);
  } finally {
    await cleanup(page, { resource, plan: saved?.id });
  }
});
