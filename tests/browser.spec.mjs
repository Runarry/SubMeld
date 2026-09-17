/* global window, document */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { UUID } from './fixtures.mjs';
import { newSubscription } from '../dist/server/shared/subscriptions.js';
const password = 'SubMeld-UI-Test-Only-2026';
async function login(page, next = 'subscriptions') {
  await page.goto('/');
  await page.getByLabel('管理员密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '订阅方案', exact: true })).toBeVisible();
  if (next === 'workbench') {
    await page.getByRole('button', { name: '转换工作台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '转换工作台', exact: true })).toBeVisible();
  }
}
async function showPlanSettings(page) {
  const name = page.getByLabel('方案名称', { exact: true });
  if (await name.isVisible()) return;
  await page.getByRole('button', { name: '方案设置', exact: true }).click();
  await expect(name).toBeVisible();
}
async function showPlanPublish(page) {
  const reset = page.getByRole('button', { name: '重置私人地址', exact: true });
  if (await reset.isVisible()) return;
  await page.getByRole('button', { name: '发布与地址', exact: true }).click();
  await expect(reset).toBeVisible();
}
test('login, YAML upload, editing, URI/Base64 copy/download, exclusion and logout', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.testCopied = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value) => {
          window.testCopied = value;
        },
      },
    });
  });
  await login(page, 'workbench');
  const yaml =
    'proxies:\n  - {type: vless, name: Uploaded, server: example.com, port: 443, uuid: ' +
    UUID +
    ', tls: true, servername: tls.example.com}\n  - {type: trojan, name: Broken, server: example.com, port: 443}\n';
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'nodes.yaml', mimeType: 'text/yaml', buffer: Buffer.from(yaml) });
  await page.getByRole('button', { name: '解析节点', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('Uploaded');
  await page.getByLabel('名称', { exact: true }).fill('浏览器已编辑');
  await page.getByLabel('SNI', { exact: true }).fill('edited.example.com');
  await page.getByRole('button', { name: '生成 URI 与 Base64', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('请修正或明确排除错误节点');
  await page.getByRole('button', { name: /Broken/ }).click();
  await page.getByLabel('明确排除此项，不参与导出', { exact: true }).check();
  await page.getByRole('button', { name: '生成 URI 与 Base64', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已生成');
  const uri = await page.getByLabel('输出预览', { exact: true }).inputValue();
  expect(new URL(uri).searchParams.get('sni')).toBe('edited.example.com');
  expect(decodeURIComponent(new URL(uri).hash.slice(1))).toBe('浏览器已编辑');
  await page.getByRole('button', { name: '复制 URI', exact: true }).click();
  expect(await page.evaluate(() => window.testCopied)).toBe(uri);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .txt', exact: true }).click();
  const download = await downloaded;
  expect(await readFile(await download.path(), 'utf8')).toBe(uri);
  await page.getByRole('button', { name: 'Base64', exact: true }).click();
  const base64 = await page.getByLabel('输出预览', { exact: true }).inputValue();
  expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(uri);
  await page.getByRole('button', { name: '复制 Base64', exact: true }).click();
  expect(await page.evaluate(() => window.testCopied)).toBe(base64);
  await page.getByLabel('查看同批解码内容', { exact: true }).check();
  await expect(page.getByLabel('输出预览', { exact: true })).toHaveValue(uri);
  const decodedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .txt', exact: true }).click();
  expect(await readFile(await (await decodedDownload).path(), 'utf8')).toBe(base64);
  await page.screenshot({ path: testInfo.outputPath('workbench.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  await page.getByRole('button', { name: /浏览器已编辑/ }).click();
  await page.getByLabel('名称', { exact: true }).fill('再次修改');
  await expect(page.getByRole('button', { name: '复制 Base64', exact: true })).toBeDisabled();
  await expect(page.getByLabel('输出预览', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理员登录', exact: true })).toBeVisible();
  await login(page, 'workbench');
  await expect(page.getByLabel('节点输入', { exact: true })).toHaveValue('');
  await expect(page.getByText('从一条节点开始', { exact: true })).toBeVisible();
});
test('manual form generates real URI and a response arriving after an edit is discarded', async ({
  page,
}) => {
  await login(page, 'workbench');
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Manual');
  await page.getByLabel('服务器', { exact: true }).fill('example.com');
  await page.getByLabel('UUID', { exact: true }).fill(UUID);
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const fetched = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route('**/api/convert/produce', async (route) => {
    const response = await route.fetch();
    entered();
    await waiting;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '生成 URI 与 Base64', exact: true }).click();
  await fetched;
  await page.getByLabel('名称', { exact: true }).fill('Changed while generating');
  release();
  await expect(page.getByRole('status')).toContainText('已忽略旧生成结果');
  await expect(page.getByRole('button', { name: '复制 URI', exact: true })).toBeDisabled();
  await page.unroute('**/api/convert/produce');
  await page.getByRole('button', { name: '生成 URI 与 Base64', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已生成');
  expect(
    decodeURIComponent(
      new URL(await page.getByLabel('输出预览', { exact: true }).inputValue()).hash.slice(1),
    ),
  ).toBe('Changed while generating');
});

test('P2 saves selected nodes, reloads, edits without resending secrets, toggles, sorts and exports three targets', async ({
  page,
}, testInfo) => {
  await login(page, 'workbench');
  const suffix = testInfo.project.name;
  const name = 'P2保存-' + suffix,
    second = 'P2第二-' + suffix;
  await page
    .getByLabel('节点输入', { exact: true })
    .fill(
      'vless://' +
        UUID +
        '@example.com:443?security=tls&sni=tls.example.com#' +
        encodeURIComponent(name) +
        '\nss://' +
        Buffer.from('aes-128-gcm:test-password').toString('base64') +
        '@example.com:8388#' +
        encodeURIComponent(second),
    );
  await page.getByRole('button', { name: '解析节点', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue(name);
  await page.getByLabel('保存选择 ' + name, { exact: true }).check();
  await page.getByLabel('保存选择 ' + second, { exact: true }).check();
  await page.getByRole('button', { name: '另存为本地节点（2）', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已另存');
  await page.reload();
  await page.getByRole('button', { name: '本地节点', exact: true }).click();
  const row = page.locator('.library-list li').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.locator('.library-editor').getByLabel('UUID', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  const updated = name + '改';
  await page.locator('.library-editor').getByLabel('名称', { exact: true }).fill(updated);
  const patch = page.waitForRequest((r) => r.method() === 'PATCH');
  await page.getByRole('button', { name: '保存本地节点', exact: true }).click();
  const body = (await patch).postDataJSON();
  expect(body.changes).toEqual({ name: updated });
  await expect(page.locator('.library').getByRole('status')).toContainText('已保存');
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  await row.getByRole('button', { name: '禁用', exact: true }).click();
  await expect(page.getByLabel('选择本地节点 ' + updated, { exact: true })).toBeDisabled();
  await row.getByRole('button', { name: '启用', exact: true }).click();
  await page.getByLabel('选择本地节点 ' + updated, { exact: true }).check();
  await page.getByLabel('选择本地节点 ' + second, { exact: true }).check();
  await page.getByRole('button', { name: '载入所选到工作台', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('独立副本');
  await page.getByRole('button', { name: new RegExp(second) }).click();
  const up = page.getByRole('button', { name: '上移', exact: true });
  if (await up.isEnabled()) await up.click();
  expect(await page.locator('.node-row').first().innerText()).toContain(second);
  for (const target of ['Mihomo', 'sing-box', 'Xray']) {
    await page.getByRole('button', { name: target, exact: true }).click();
    await page.getByRole('button', { name: '生成 ' + target, exact: true }).click();
    await expect(page.getByLabel('输出预览', { exact: true })).toBeVisible();
    const full = await page.getByLabel('输出预览', { exact: true }).inputValue();
    expect(full).toContain('127.0.0.1');
    expect(full).toContain(second);
    const downloadEvent = page.waitForEvent('download');
    await page
      .getByRole('button', { name: target === 'Mihomo' ? '下载 .yaml' : '下载 .json', exact: true })
      .click();
    expect(await readFile(await (await downloadEvent).path(), 'utf8')).toBe(full);
    await page.getByRole('combobox', { name: '配置内容', exact: true }).selectOption('nodes');
    const fragment = await page.getByLabel('输出预览', { exact: true }).inputValue();
    expect(fragment).not.toContain('127.0.0.1');
    await page.getByRole('combobox', { name: '配置内容', exact: true }).selectOption('full');
  }
  await page.getByLabel('本地监听端口', { exact: true }).fill('1081');
  await expect(page.getByLabel('输出预览', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mihomo', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制 Mihomo', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('p2-workbench.png'), fullPage: true });
  await page.getByRole('button', { name: '本地节点', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .locator('.library-list li')
    .filter({ hasText: updated })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  await expect(page.locator('.library-list li').filter({ hasText: updated })).toHaveCount(0);
});
test('P2 two pages preserve conflicting edits; new local nodes and explicit secret clearing work', async ({
  page,
  context,
}, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: '本地节点', exact: true }).click();
  const name = '冲突-' + testInfo.project.name;
  await page.getByRole('combobox', { name: '新建协议', exact: true }).selectOption('ss');
  await page.getByRole('button', { name: '新建本地节点', exact: true }).click();
  const editor = page.locator('.library-editor');
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByLabel('服务器', { exact: true }).fill('example.com');
  await editor.getByLabel('密码', { exact: true }).fill('only-browser-secret');
  await page.getByRole('button', { name: '保存本地节点', exact: true }).click();
  await expect(page.locator('.library').getByRole('status')).toContainText('已保存');
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: '本地节点', exact: true }).click();
  await page
    .locator('.library-list li')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await other
    .locator('.library-list li')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await editor.getByLabel('名称', { exact: true }).fill(name + '新');
  await page.getByRole('button', { name: '保存本地节点', exact: true }).click();
  await expect(page.locator('.library').getByRole('status')).toContainText('已保存');
  await other
    .locator('.library-editor')
    .getByLabel('名称', { exact: true })
    .fill(name + '未提交');
  await other.getByRole('button', { name: '保存本地节点', exact: true }).click();
  await expect(other.locator('.library').getByRole('status')).toContainText('其他页面修改');
  await expect(other.locator('.library-editor').getByLabel('名称', { exact: true })).toHaveValue(
    name + '未提交',
  );
  await other.getByRole('button', { name: '重新载入服务器版本', exact: true }).click();
  await expect(other.locator('.library-editor').getByLabel('名称', { exact: true })).toHaveValue(
    name + '新',
  );
  await other.getByRole('button', { name: '清空密码', exact: true }).click();
  const patch = other.waitForRequest((r) => r.method() === 'PATCH');
  await other.getByRole('button', { name: '保存本地节点', exact: true }).click();
  expect((await patch).postDataJSON().changes.auth.password).toBeNull();
  await expect(other.locator('.library').getByRole('status')).toContainText('修正节点');
  await other.close();
});
test('P2 target failure retains other outputs and delayed render cannot restore an edited preview', async ({
  page,
}, testInfo) => {
  await login(page, 'workbench');
  await page
    .getByLabel('节点输入', { exact: true })
    .fill('hysteria2://test-password@example.com:443?sni=tls.example.com#' + testInfo.project.name);
  await page.getByRole('button', { name: '解析节点', exact: true }).click();
  await page.getByRole('button', { name: 'Mihomo', exact: true }).click();
  await page.getByRole('button', { name: '生成 Mihomo', exact: true }).click();
  await expect(page.getByLabel('输出预览', { exact: true })).toBeVisible();
  const previous = await page.getByLabel('输出预览', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Xray', exact: true }).click();
  await page.getByRole('button', { name: '生成 Xray', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('此目标生成失败');
  await page.getByRole('button', { name: 'Mihomo', exact: true }).click();
  await expect(page.getByLabel('输出预览', { exact: true })).toHaveValue(previous);
  let entered, release;
  const fetched = new Promise((r) => (entered = r)),
    waiting = new Promise((r) => (release = r));
  await page.route('**/api/convert/render', async (route) => {
    const response = await route.fetch();
    entered();
    await waiting;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '生成 Mihomo', exact: true }).click();
  await fetched;
  await page.getByLabel('名称', { exact: true }).fill('生成期间修改');
  release();
  await expect(page.getByRole('status')).toContainText('已忽略旧生成结果');
  await expect(page.getByRole('button', { name: '复制 Mihomo', exact: true })).toBeDisabled();
});

async function openLocalImport(page) {
  await page.getByRole('button', { name: '本地节点', exact: true }).click();
  await page.getByRole('button', { name: '导入节点', exact: true }).click();
  return page.getByRole('region', { name: '本地节点导入', exact: true });
}
const importUri = (name, insecure = false) =>
  'vless://' +
  UUID +
  '@example.com:443?security=tls&sni=tls.example.com' +
  (insecure ? '&allowInsecure=1' : '') +
  '#' +
  encodeURIComponent(name);
test('local import previews paginated URI nodes, preserves manual edits and saves duplicates with warnings', async ({
  page,
}, testInfo) => {
  await login(page);
  const initial = (await (await page.request.get('/api/nodes')).json()).total;
  const createdIds = [];
  try {
    await page.getByRole('button', { name: '本地节点', exact: true }).click();
    await page.getByRole('button', { name: '新建本地节点', exact: true }).click();
    await page
      .locator('.library-editor')
      .getByLabel('名称', { exact: true })
      .fill('尚未保存的独立表单');
    await page.getByRole('button', { name: '导入节点', exact: true }).dispatchEvent('click');
    const panel = page.getByRole('region', { name: '本地节点导入', exact: true });
    await expect(page.getByRole('dialog', { name: '导入节点', exact: true })).toBeVisible();
    const prefix = '直接导入-' + testInfo.project.name,
      duplicate = prefix + '重复';
    await panel
      .getByLabel('本地节点导入内容', { exact: true })
      .fill(
        Array.from({ length: 26 }, (_, i) =>
          importUri(i < 2 ? duplicate : prefix + i, i === 0),
        ).join('\n'),
      );
    await panel.getByRole('button', { name: '解析导入内容', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('已解析 26 项');
    await expect(panel.getByText('共 26 项 · 已选 26 项', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('UUID', { exact: true })).toHaveAttribute('type', 'password');
    await expect(panel.locator('.diagnostics')).toContainText('关闭证书验证');
    await panel.getByLabel('SNI', { exact: true }).fill('import-edited.example.com');
    await panel.getByRole('button', { name: '导入下一页', exact: true }).click();
    await expect(panel.locator('.node-row')).toHaveCount(1);
    await expect(panel.getByLabel('导入选择第 26 项', { exact: true })).toBeChecked();
    let entered, release, created;
    const fetched = new Promise((r) => (entered = r)),
      waiting = new Promise((r) => (release = r));
    await page.route('**/api/nodes', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      created = await response.json();
      createdIds.push(...created.nodes.map((node) => node.id));
      entered();
      await waiting;
      await route.fulfill({ response });
    });
    await panel.getByRole('button', { name: '添加所选节点', exact: true }).click();
    await fetched;
    await expect(panel.getByLabel('本地节点导入内容', { exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '正在添加…', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '关闭导入', exact: true })).toBeDisabled();
    release();
    await expect(panel.getByRole('status')).toContainText('已添加 26 个');
    await expect(page.locator('.library-main .pagination')).toContainText(
      '第 ' + Math.ceil((initial + 26) / 25) + ' 页',
    );
    await expect(panel.getByLabel('本地节点导入内容', { exact: true })).toHaveValue('');
    await expect(page.locator('.library-editor').getByLabel('名称', { exact: true })).toHaveValue(
      '尚未保存的独立表单',
    );
    await page.unroute('**/api/nodes');
    const first = await (await page.request.get('/api/nodes/' + created.nodes[0].id)).json();
    expect(first.draft.tls.serverName).toBe('import-edited.example.com');
    expect(first.draft.tls.insecure).toBe(true);
    expect(created.nodes[0].name).toBe(duplicate);
    expect(created.nodes[1].name).toBe(duplicate);
    await panel.getByLabel('本地节点导入内容', { exact: true }).fill(importUri(duplicate));
    await panel.getByRole('button', { name: '解析导入内容', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('已解析 1 项');
    const addedResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/nodes') && response.request().method() === 'POST',
    );
    await panel.getByRole('button', { name: '添加所选节点', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('已添加 1 个');
    createdIds.push(...(await (await addedResponse).json()).nodes.map((node) => node.id));
    expect((await (await page.request.get('/api/nodes')).json()).total).toBe(initial + 27);
    await expect(panel.getByRole('button', { name: '关闭导入', exact: true })).toBeEnabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('local-import.png'), fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: '本地节点', exact: true }).click();
    expect((await (await page.request.get('/api/nodes')).json()).total).toBe(initial + 27);
    expect(
      (await (await page.request.get('/api/nodes/' + created.nodes[0].id)).json()).draft.tls
        .serverName,
    ).toBe('import-edited.example.com');
    await expect(page.getByRole('region', { name: '本地节点导入', exact: true })).toHaveCount(0);
  } finally {
    for (const id of createdIds) {
      const response = await page.request.delete('/api/nodes/' + id, {
        headers: { Origin: 'http://127.0.0.1:3210', 'X-SubMeld-Request': '1' },
        data: { revision: 1 },
      });
      expect(response.ok()).toBe(true);
    }
  }
});
test('local YAML import retains failed rows and maps save errors back to the selected original row', async ({
  page,
}, testInfo) => {
  await login(page);
  const panel = await openLocalImport(page);
  const initial = (await (await page.request.get('/api/nodes')).json()).total;
  const name = '文件节点-' + testInfo.project.name;
  const yaml =
    'proxies:\n  - {type: vless, name: 不选择, server: example.com, port: 443, uuid: ' +
    UUID +
    '}\n  - {type: unsupported, name: 不支持协议, server: example.com, port: 443}\n  - {type: ss, name: ' +
    name +
    ', server: example.com, port: 8388, cipher: aes-128-gcm, password: only-test-file-secret}\n';
  await panel
    .locator('input[type=file]')
    .setInputFiles({ name: 'nodes.yaml', mimeType: 'text/yaml', buffer: Buffer.from(yaml) });
  await panel.getByRole('button', { name: '解析导入内容', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已解析 3 项');
  await panel.getByRole('button', { name: '添加所选节点', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('尚未解析成功');
  expect((await (await page.request.get('/api/nodes')).json()).total).toBe(initial);
  await panel.getByLabel('导入选择第 1 项', { exact: true }).uncheck();
  await panel.getByLabel('导入选择第 2 项', { exact: true }).uncheck();
  await panel.locator('.node-row').nth(2).click();
  await panel.getByLabel('名称', { exact: true }).fill(name + '已编辑');
  await panel.getByLabel('端口', { exact: true }).fill('0');
  await panel.getByRole('button', { name: '添加所选节点', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('修正节点字段');
  await expect(panel.locator('.editor .diagnostics')).toContainText('端口必须');
  await expect(panel.getByLabel('名称', { exact: true })).toHaveValue(name + '已编辑');
  await expect(panel.getByLabel('导入选择第 3 项', { exact: true })).toBeChecked();
  await expect(panel.getByLabel('本地节点导入内容', { exact: true })).toHaveValue(yaml);
  expect((await (await page.request.get('/api/nodes')).json()).total).toBe(initial);
  await panel.getByLabel('端口', { exact: true }).fill('8388');
  await panel.getByRole('button', { name: '添加所选节点', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已添加 1 个');
  await expect(page.locator('.library-list li').filter({ hasText: name + '已编辑' })).toHaveCount(
    1,
  );
});
test('local import invalidates edited input, discards delayed parse and file reads, and cancels without saving', async ({
  page,
}, testInfo) => {
  await login(page);
  let panel = await openLocalImport(page);
  const initial = (await (await page.request.get('/api/nodes')).json()).total;
  const uri = importUri('取消导入-' + testInfo.project.name);
  const input = panel.getByLabel('本地节点导入内容', { exact: true });
  await input.fill(Buffer.from(uri).toString('base64'));
  await panel.getByLabel('本地节点导入格式', { exact: true }).selectOption('base64');
  await panel.getByRole('button', { name: '解析导入内容', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已解析 1 项');
  await panel.getByLabel('本地节点导入格式', { exact: true }).selectOption('auto');
  await expect(panel.getByRole('button', { name: '添加所选节点', exact: true })).toBeDisabled();
  await expect(panel.locator('.node-row')).toHaveCount(0);
  let entered, release;
  const fetched = new Promise((r) => (entered = r)),
    waiting = new Promise((r) => (release = r));
  await page.route('**/api/convert/parse', async (route) => {
    const response = await route.fetch();
    entered();
    await waiting;
    await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: '解析导入内容', exact: true }).click();
  await fetched;
  await input.fill('解析返回前修改');
  release();
  await expect(panel.getByRole('button', { name: '解析导入内容', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('解析返回前修改');
  await expect(panel.locator('.node-row')).toHaveCount(0);
  await page.unroute('**/api/convert/parse');
  await page.evaluate(() => {
    const read = window.File.prototype.arrayBuffer;
    window.File.prototype.arrayBuffer = async function () {
      window.File.prototype.arrayBuffer = read;
      window.importReadStarted = true;
      await new Promise((resolve) => {
        window.releaseImportRead = resolve;
      });
      return read.call(this);
    };
  });
  await panel
    .locator('input[type=file]')
    .setInputFiles({ name: 'delayed.txt', mimeType: 'text/plain', buffer: Buffer.from(uri) });
  await expect.poll(() => page.evaluate(() => window.importReadStarted)).toBe(true);
  await input.fill('读取文件时修改');
  await page.evaluate(() => window.releaseImportRead());
  await expect(panel.getByRole('button', { name: '解析导入内容', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('读取文件时修改');
  await panel
    .locator('input[type=file]')
    .setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from([255]) });
  await expect(panel.getByRole('status')).toContainText('不是有效的 UTF-8');
  await panel.locator('input[type=file]').setInputFiles({
    name: 'too-large.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(4 * 1024 * 1024 + 1, 65),
  });
  await expect(panel.getByRole('status')).toContainText('超过 4 MiB');
  await input.fill(uri);
  await panel.getByRole('button', { name: '解析导入内容', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已解析 1 项');
  await panel.getByRole('button', { name: '关闭导入', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '导入节点', exact: true }).click();
  panel = page.getByRole('region', { name: '本地节点导入', exact: true });
  await expect(panel.getByLabel('本地节点导入内容', { exact: true })).toHaveValue('');
  await panel.getByLabel('本地节点导入内容', { exact: true }).fill(uri);
  await page.getByRole('button', { name: '转换工作台', exact: true }).click();
  await page.getByRole('button', { name: '本地节点', exact: true }).click();
  await expect(page.getByRole('region', { name: '本地节点导入', exact: true })).toHaveCount(0);
  expect((await (await page.request.get('/api/nodes')).json()).total).toBe(initial);
});

async function p3Api(page, path, data, method = 'POST') {
  const response = await page.request.fetch(path, {
    method,
    data,
    headers: {
      Origin: new URL(page.url()).origin,
      'Content-Type': 'application/json',
      'X-SubMeld-Request': '1',
    },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function p3Fixture(page, name) {
  const source = await p3Api(page, '/api/sources', {
    name: name + '-source',
    format: 'uri',
    text: 'vless://' + UUID + '@example.com:443?security=tls&type=tcp#' + name,
  });
  const issued = await p3Api(page, '/api/subscriptions', {
    ...newSubscription(),
    name,
    inputs: [{ kind: 'source', id: source.id }],
  });
  await expect.poll(async () => (await page.request.get(issued.urls.uri)).status()).toBe(200);
  return { source, issued };
}
async function selectP3Input(page, kind, id) {
  if ((await page.getByLabel('输入类型', { exact: true }).inputValue()) !== kind) {
    const loading = page.waitForResponse((r) =>
      r.url().includes(kind === 'node' ? '/api/nodes?page=' : '/api/sources?page='),
    );
    await page.getByLabel('输入类型', { exact: true }).selectOption(kind);
    await loading;
  }
  await expect(page.getByRole('button', { name: '刷新可选输入', exact: true })).toBeEnabled();
  const choice = page.getByLabel('可选输入', { exact: true }).locator('option[value="' + id + '"]');
  while (!(await choice.count())) {
    const next = page.getByRole('button', { name: '下一页输入', exact: true });
    await expect(next).toBeEnabled();
    const loading = page.waitForResponse((r) =>
      r.url().includes(kind === 'node' ? '/api/nodes?page=' : '/api/sources?page='),
    );
    await next.click();
    await loading;
    await expect(page.getByRole('button', { name: '刷新可选输入', exact: true })).toBeEnabled();
  }
  await page.getByLabel('可选输入', { exact: true }).selectOption(id);
  await page.getByRole('button', { name: '添加输入', exact: true }).click();
}

test('P3 source copy, ordered target filters, address updates, export, reset and transient clearing', async ({
  page,
  request,
}, testInfo) => {
  await page.addInitScript(() => {
    window.testCopied = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value) => {
          window.testCopied = value;
        },
      },
    });
  });
  await login(page);
  const suffix = testInfo.project.name,
    sourceName = 'P3来源-' + suffix,
    subName = 'P3组合-' + suffix;
  await page.getByRole('button', { name: '来源管理', exact: true }).click();
  await page.getByRole('button', { name: '新建文本来源', exact: true }).click();
  await page.getByLabel('来源名称', { exact: true }).fill(sourceName);
  await page.getByLabel('来源正文', { exact: true }).fill('not-a-node');
  await page.getByRole('button', { name: '解析并保存来源', exact: true }).click();
  await expect(page.getByLabel('来源正文', { exact: true })).toHaveValue('not-a-node');
  await expect(page.getByRole('button', { name: '解析并保存来源', exact: true })).toBeEnabled();
  const sourceText =
    'vless://' +
    UUID +
    '@example.com:443?security=tls&type=tcp#P3-v-' +
    suffix +
    '\nhysteria2://p3-test@example.com:443#P3-h-' +
    suffix;
  await page.getByLabel('来源正文', { exact: true }).fill(sourceText);
  const savedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/sources') && r.request().method() === 'POST' && r.status() === 201,
  );
  await page.getByRole('button', { name: '解析并保存来源', exact: true }).click();
  const saved = await (await savedResponse).json();
  await page.getByLabel('选择来源节点 P3-v-' + suffix, { exact: true }).check();
  const copiedResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/nodes') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '复制所选为本地节点', exact: true }).click();
  const copied = await (await copiedResponse).json();
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  await page.getByRole('button', { name: '新建订阅方案', exact: true }).click();
  await page.getByLabel('方案名称', { exact: true }).fill(subName);
  await selectP3Input(page, 'source', saved.id);
  await selectP3Input(page, 'node', copied.nodes[0].id);
  await page.getByRole('button', { name: '上移输入', exact: true }).nth(1).click();
  await page.getByLabel('名称前缀', { exact: true }).fill('订阅-');
  for (const name of ['Mihomo 完整配置', 'sing-box 完整配置', 'Xray 完整配置'])
    await page.getByLabel(name, { exact: true }).check();
  const xray = page
    .locator('fieldset.target-filter')
    .filter({ has: page.locator('legend').filter({ hasText: 'Xray' }) });
  await xray.getByLabel('HYSTERIA2', { exact: true }).uncheck();
  await xray.getByLabel('TUIC', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存订阅方案', exact: true }).click();
  const uriField = page.getByLabel('URI 订阅地址', { exact: true });
  await expect(uriField).toBeVisible();
  const oldUrl = await uriField.inputValue();
  const previewButton = page.getByRole('button', { name: '预览 URI', exact: true });
  await expect(previewButton).toBeEnabled();
  await page.getByRole('button', { name: '复制 URI 地址', exact: true }).click();
  expect(await page.evaluate(() => window.testCopied)).toBe(oldUrl);
  await previewButton.click();
  const output = await page.getByLabel('已发布订阅内容', { exact: true }).inputValue();
  expect(output.split('\n').map((v) => new URL(v).protocol)).toEqual([
    'vless:',
    'vless:',
    'hysteria2:',
  ]);
  expect(await (await request.get(oldUrl)).text()).toBe(output);
  await expect(page.getByRole('button', { name: '预览 Xray 完整配置', exact: true })).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载订阅内容', exact: true }).click();
  expect(await readFile(await (await downloading).path(), 'utf8')).toBe(output);
  await showPlanSettings(page);
  await page.getByLabel('名称前缀', { exact: true }).fill('更新-');
  await page.getByRole('button', { name: '保存订阅方案', exact: true }).click();
  await expect
    .poll(async () => decodeURIComponent(await (await request.get(oldUrl)).text()))
    .toContain('更新-');
  await showPlanPublish(page);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '重置私人地址', exact: true }).click();
  await expect(uriField).not.toHaveValue(oldUrl);
  const newUrl = await uriField.inputValue();
  expect((await request.get(oldUrl)).status()).toBe(404);
  expect((await request.get(newUrl)).status()).toBe(200);
  const head = await request.head(newUrl);
  expect(head.status()).toBe(200);
  expect(await head.text()).toBe('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '来源管理', exact: true }).click();
  await expect(uriField).toHaveCount(0);
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  const row = page.locator('.library-list > li').filter({ hasText: subName });
  await row.getByRole('button', { name: '编辑方案', exact: true }).click();
  await showPlanSettings(page);
  await expect(page.getByLabel('方案名称', { exact: true })).toHaveValue(subName);
  await expect(uriField).toHaveCount(0);
  await page.getByRole('button', { name: '关闭方案编辑', exact: true }).click();
  await row.getByRole('button', { name: '停用方案', exact: true }).click();
  await expect.poll(async () => (await request.get(newUrl)).status()).toBe(404);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('方案名称', { exact: true })).toHaveCount(0);
});

test('P3 two pages retain source and subscription edits on revision conflicts', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = 'P3冲突-' + testInfo.project.name;
  const fixture = await p3Fixture(page, name);
  const other = await page.context().newPage();
  await other.goto('/');
  for (const p of [page, other]) {
    await p.getByRole('button', { name: '订阅方案', exact: true }).click();
    await p
      .locator('.library-list > li')
      .filter({ hasText: name })
      .getByRole('button', { name: '编辑方案', exact: true })
      .click();
    await showPlanSettings(p);
  }
  await page.getByLabel('名称前缀', { exact: true }).fill('first-');
  await other.getByLabel('名称前缀', { exact: true }).fill('unsaved-');
  await page.getByRole('button', { name: '保存订阅方案', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存订阅方案', exact: true })).toBeEnabled();
  await other.getByRole('button', { name: '保存订阅方案', exact: true }).click();
  await expect(other.getByRole('button', { name: '重新载入方案版本', exact: true })).toBeVisible();
  await expect(other.getByLabel('名称前缀', { exact: true })).toHaveValue('unsaved-');
  await other.getByRole('button', { name: '重新载入方案版本', exact: true }).click();
  await expect(other.getByLabel('名称前缀', { exact: true })).toHaveValue('first-');
  for (const p of [page, other]) {
    await p.getByRole('button', { name: '来源管理', exact: true }).click();
    await p
      .locator('.library-list > li')
      .filter({ hasText: fixture.source.name })
      .getByRole('button', { name: '编辑来源', exact: true })
      .click();
  }
  await page.getByLabel('来源名称', { exact: true }).fill(name + '-changed');
  await other
    .getByLabel('来源正文', { exact: true })
    .fill(fixture.source.text + '\n' + fixture.source.text);
  await page.getByRole('button', { name: '解析并保存来源', exact: true }).click();
  await expect(page.getByRole('button', { name: '解析并保存来源', exact: true })).toBeEnabled();
  await other.getByRole('button', { name: '解析并保存来源', exact: true }).click();
  await expect(other.getByRole('button', { name: '重新载入来源版本', exact: true })).toBeVisible();
  await expect(other.getByLabel('来源正文', { exact: true })).toHaveValue(
    fixture.source.text + '\n' + fixture.source.text,
  );
  await other.close();
});

test('P3 late artifact responses cannot restore a preview after leaving the scheme', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = 'P3迟到预览-' + testInfo.project.name;
  await p3Fixture(page, name);
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  await page
    .locator('.library-list > li')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑方案', exact: true })
    .click();
  let release, entered, delivered;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    fetched = new Promise((resolve) => {
      entered = resolve;
    }),
    finished = new Promise((resolve) => {
      delivered = resolve;
    });
  await page.route('**/api/subscriptions/*/artifacts/uri', async (route) => {
    const response = await route.fetch();
    entered();
    await waiting;
    await route.fulfill({ response });
    delivered();
  });
  await page.getByRole('button', { name: '预览 URI', exact: true }).click();
  await fetched;
  await page.getByRole('button', { name: '来源管理', exact: true }).click();
  release();
  await finished;
  await page.unroute('**/api/subscriptions/*/artifacts/uri');
  await expect(page.getByLabel('已发布订阅内容', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  await page
    .locator('.library-list > li')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑方案', exact: true })
    .click();
  await expect(page.getByLabel('已发布订阅内容', { exact: true })).toHaveCount(0);
});

test('P3 one-time addresses arriving after navigation remain cleared', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = 'P3迟到地址-' + testInfo.project.name;
  const fixture = await p3Fixture(page, name + '-input');
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  await page.getByRole('button', { name: '新建订阅方案', exact: true }).click();
  await page.getByLabel('方案名称', { exact: true }).fill(name);
  await selectP3Input(page, 'source', fixture.source.id);
  let release, entered, delivered;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    fetched = new Promise((resolve) => {
      entered = resolve;
    }),
    finished = new Promise((resolve) => {
      delivered = resolve;
    });
  await page.route('**/api/subscriptions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    entered();
    await waiting;
    await route.fulfill({ response });
    delivered();
  });
  await page.getByRole('button', { name: '保存订阅方案', exact: true }).click();
  await fetched;
  await page.getByRole('button', { name: '转换工作台', exact: true }).click();
  release();
  await finished;
  await page.unroute('**/api/subscriptions');
  await expect(page.getByLabel('URI 订阅地址', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  await page
    .locator('.library-list > li')
    .filter({
      has: page.locator('.node-name', { hasText: name }).filter({ hasNotText: name + '-input' }),
    })
    .getByRole('button', { name: '编辑方案', exact: true })
    .click();
  await expect(page.getByLabel('URI 订阅地址', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
});

async function createRemote(page, name, path = '/subscription?fail=2') {
  await page.getByRole('button', { name: '来源管理', exact: true }).click();
  await page.getByRole('button', { name: '新建远端来源', exact: true }).click();
  await page.getByLabel('来源名称', { exact: true }).fill(name);
  const url =
    'https://source.test' +
    path +
    (path.includes('?') ? '&' : '?') +
    'name=' +
    encodeURIComponent(name);
  await page.getByLabel('来源 URL', { exact: true }).fill(url);
  await page.getByLabel('Authorization', { exact: true }).fill('Bearer browser-fixture-only');
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/sources') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '保存远端来源', exact: true }).click();
  const source = await (await response).json();
  await expect(page.getByRole('button', { name: '保存远端来源', exact: true })).toBeEnabled();
  return { ...source, url };
}
test('P4 remote creation, copy, subscription, failure retention and refresh preserve unsaved edits', async ({
  page,
  request,
}, testInfo) => {
  await login(page);
  const name = 'P4流程-' + testInfo.project.name,
    source = await createRemote(page, name);
  await expect(page.getByLabel('来源 URL', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Authorization', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await page.getByLabel('选择来源节点 ' + name + '-1', { exact: true }).check();
  await page.getByRole('button', { name: '复制所选为本地节点', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('已复制');
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  await page.getByRole('button', { name: '新建订阅方案', exact: true }).click();
  await page.getByLabel('方案名称', { exact: true }).fill(name + '-方案');
  await selectP3Input(page, 'source', source.id);
  await page.getByRole('button', { name: '保存订阅方案', exact: true }).click();
  await expect(page.getByLabel('URI 订阅地址', { exact: true })).toBeVisible();
  const privateUrl = await page.getByLabel('URI 订阅地址', { exact: true }).inputValue();
  await expect.poll(async () => (await request.get(privateUrl)).status()).toBe(200);
  const before = await (await request.get(privateUrl)).text();
  await page.getByRole('button', { name: '来源管理', exact: true }).click();
  const row = page.locator('.library-main > .library-list > li').filter({ hasText: name });
  await row.getByRole('button', { name: '编辑来源', exact: true }).click();
  await page.getByLabel('来源 URL', { exact: true }).fill('https://source.test/unsaved');
  await page.getByRole('dialog').getByRole('button', { name: '刷新远端来源', exact: true }).click();
  await expect(row).toContainText('HTTP 503');
  expect(await (await request.get(privateUrl)).text()).toBe(before);
  await expect(page.getByLabel('来源 URL', { exact: true })).toHaveValue(
    'https://source.test/unsaved',
  );
  await page.getByLabel('选择来源节点 ' + name + '-1', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: '刷新远端来源', exact: true }).click();
  await expect
    .poll(async () => decodeURIComponent(await (await request.get(privateUrl)).text()))
    .toContain(name + '-3');
  await expect(page.getByLabel('选择来源节点 ' + name + '-3', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('来源 URL', { exact: true })).toHaveValue(
    'https://source.test/unsaved',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
});
test('P4 remote secret deltas, explicit clear and two-page revision conflicts keep unsaved values', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = 'P4秘密-' + testInfo.project.name,
    source = await createRemote(page, name, '/subscription');
  await expect(page.getByLabel('选择来源节点 ' + name + '-1', { exact: true })).toBeVisible();
  const other = await page.context().newPage();
  await other.goto('/');
  await other.getByRole('button', { name: '来源管理', exact: true }).click();
  await other
    .locator('.library-main > .library-list > li')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑来源', exact: true })
    .click();
  await other.getByLabel('Authorization', { exact: true }).fill('Bearer unsaved-fixture');
  await page.getByLabel('来源名称', { exact: true }).fill(name + '-changed');
  const sent = page.waitForRequest(
    (r) => r.url().endsWith('/api/sources/' + source.id) && r.method() === 'PATCH',
  );
  await page.getByRole('button', { name: '保存远端来源', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.url).toBeUndefined();
  expect(body.headers).toBeUndefined();
  await expect(page.getByRole('button', { name: '保存远端来源', exact: true })).toBeEnabled();
  await other.getByRole('button', { name: '保存远端来源', exact: true }).click();
  await expect(other.getByRole('button', { name: '重新载入来源版本', exact: true })).toBeVisible();
  await expect(other.getByLabel('Authorization', { exact: true })).toHaveValue(
    'Bearer unsaved-fixture',
  );
  await page.getByRole('button', { name: '清空 Authorization', exact: true }).click();
  const cleared = page.waitForRequest(
    (r) => r.url().endsWith('/api/sources/' + source.id) && r.method() === 'PATCH',
  );
  await page.getByRole('button', { name: '保存远端来源', exact: true }).click();
  expect((await cleared).postDataJSON().headers.authorization).toBeNull();
  await expect(page.getByRole('button', { name: '保存远端来源', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭来源编辑', exact: true }).click();
  await page
    .locator('.library-main > .library-list > li')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑来源', exact: true })
    .click();
  await expect(page.getByLabel('Authorization', { exact: true })).toHaveValue('');
  await other.close();
});
test('P4 a never-successful remote stays editable and cannot be selected as subscription input', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = 'P4失败-' + testInfo.project.name,
    source = await createRemote(page, name, '/failure');
  const row = page.locator('.library-main > .library-list > li').filter({ hasText: name });
  await expect(row).toContainText('HTTP 503');
  await expect(row).toContainText('尚无成功快照');
  await expect(page.getByLabel('来源 URL', { exact: true })).toHaveValue(source.url);
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  await page.getByRole('button', { name: '新建订阅方案', exact: true }).click();
  await expect(
    page.getByLabel('可选输入', { exact: true }).locator('option[value="' + source.id + '"]'),
  ).toHaveJSProperty('disabled', true);
  await expect(page.getByLabel('可选输入', { exact: true })).not.toHaveValue(source.id);
});
test('P4 late remote details cannot restore URL or authorization after leaving the page', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = 'P4迟到-' + testInfo.project.name,
    source = await createRemote(page, name, '/subscription');
  await page.getByRole('button', { name: '关闭来源编辑', exact: true }).click();
  let release, entered;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const fetched = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route('**/api/sources/' + source.id, async (route) => {
    const response = await route.fetch();
    entered();
    await wait;
    await route.fulfill({ response });
  });
  await page
    .locator('.library-main > .library-list > li')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑来源', exact: true })
    .click();
  await fetched;
  await page.getByRole('button', { name: '订阅方案', exact: true }).click();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByLabel('来源 URL', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '来源管理', exact: true }).click();
  await page.getByRole('button', { name: '新建远端来源', exact: true }).click();
  await expect(page.getByLabel('来源 URL', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Authorization', { exact: true })).toHaveValue('');
});
