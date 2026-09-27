/* global window, document */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { UUID, node } from './fixtures.mjs';
import { parse } from 'yaml';
import { newSubscription } from '../dist/server/shared/subscriptions.js';
const password = 'SubMeld-UI-Test-Only-2026';
async function login(page, next = 'subscriptions') {
  await page.goto('/submeld/');
  await page.getByLabel('管理员密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '增强订阅', exact: true }).click();
  if (next === 'workbench') {
    await page.getByRole('button', { name: '转换工作台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '转换工作台', exact: true })).toBeVisible();
  }
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
  await other.goto('/submeld/');
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
  await p3Api(page, '/upstream/sub-store/api/subs', {
    name: name + '-source',
    source: 'local',
    content:
      'vless://' + UUID + '@example.com:443?security=tls&type=tcp#' + encodeURIComponent(name),
    process: [],
  });
  const listing = await (await page.request.get('/api/sources')).json();
  const source = listing.sources.find((s) => s.name === name + '-source');
  expect(source).toBeTruthy();
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
      r
        .url()
        .includes(
          kind === 'node'
            ? '/api/nodes?page='
            : kind === 'chain'
              ? '/api/chains?page='
              : '/api/sources?page=',
        ),
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
      r
        .url()
        .includes(
          kind === 'node'
            ? '/api/nodes?page='
            : kind === 'chain'
              ? '/api/chains?page='
              : '/api/sources?page=',
        ),
    );
    await next.click();
    await loading;
    await expect(page.getByRole('button', { name: '刷新可选输入', exact: true })).toBeEnabled();
  }
  await page.getByLabel('可选输入', { exact: true }).selectOption(id);
  await page.getByRole('button', { name: '添加输入', exact: true }).click();
}

test('P3 late artifact responses cannot restore a preview after leaving the scheme', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = 'P3迟到预览-' + testInfo.project.name;
  await p3Fixture(page, name);
  await page.getByRole('button', { name: '增强订阅', exact: true }).click();
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
  await page.getByRole('button', { name: '上游节点预览', exact: true }).click();
  release();
  await finished;
  await page.unroute('**/api/subscriptions/*/artifacts/uri');
  await expect(page.getByLabel('已发布订阅内容', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '增强订阅', exact: true }).click();
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
  await page.getByRole('button', { name: '增强订阅', exact: true }).click();
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
  await page.getByRole('button', { name: '增强订阅', exact: true }).click();
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

test('two-hop chains save, swap, publish mixed subscriptions and protect referenced local nodes', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = '链式流程-' + testInfo.project.name;
  const padding = await p3Api(page, '/api/nodes', {
    drafts: Array.from({ length: 26 }, (_, i) => ({ ...node('ss'), name: name + '-分页-' + i })),
  });
  const created = await p3Api(page, '/api/nodes', {
    drafts: [
      { ...node('ss'), name: name + '-前置' },
      { ...node('ss'), name: name + '-出口' },
    ],
  });
  const [entry, exit] = created.nodes;
  let chain, subscription;
  try {
    await page.getByRole('button', { name: '本地节点', exact: true }).click();
    await page.getByRole('button', { name: '新建链式代理', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建链式代理', exact: true });
    await dialog.getByLabel('链名称', { exact: true }).fill(name);
    await expect(page.getByRole('button', { name: '刷新候选节点', exact: true })).toBeEnabled();
    for (const [label, id] of [
      ['前置代理', entry.id],
      ['出口代理', exit.id],
    ]) {
      const previous = page.getByRole('button', { name: '上一页候选节点', exact: true });
      while (await previous.isEnabled()) {
        await previous.click();
        await expect(page.getByRole('button', { name: '刷新候选节点', exact: true })).toBeEnabled();
      }
      const option = page.getByLabel(label, { exact: true }).locator('option[value="' + id + '"]');
      while (!(await option.count())) {
        await page.getByRole('button', { name: '下一页候选节点', exact: true }).click();
        await expect(page.getByRole('button', { name: '刷新候选节点', exact: true })).toBeEnabled();
      }
      await page.getByLabel(label, { exact: true }).selectOption(id);
    }
    await page.getByRole('button', { name: '交换两跳顺序', exact: true }).click();
    await expect(page.getByLabel('前置代理', { exact: true })).toHaveValue(exit.id);
    await page.getByRole('button', { name: '交换两跳顺序', exact: true }).click();
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/chains') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存链式代理', exact: true }).click();
    chain = await (await saved).json();
    await expect(page.getByRole('status')).toContainText('链式代理已保存');
    await expect(page.locator('.chain-path')).toHaveText(
      '本机 → ' + entry.name + ' → ' + exit.name + ' → 目标',
    );
    await page.getByRole('button', { name: '关闭链编辑', exact: true }).click();
    await page.getByRole('button', { name: '增强订阅', exact: true }).click();
    await page.getByRole('button', { name: '新建订阅方案', exact: true }).click();
    await page.getByLabel('方案名称', { exact: true }).fill(name);
    await selectP3Input(page, 'chain', chain.id);
    await selectP3Input(page, 'node', entry.id);
    await expect(page.getByText('URI／Base64 仅发布普通节点', { exact: false })).toBeVisible();
    await page.getByLabel('Mihomo 完整配置', { exact: true }).check();
    const issued = page.waitForResponse(
      (r) => r.url().endsWith('/api/subscriptions') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存订阅方案', exact: true }).click();
    const result = await (await issued).json();
    subscription = result.subscription;
    await expect(
      page.getByRole('button', { name: '预览 Mihomo 完整配置', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '预览 Mihomo 完整配置', exact: true }).click();
    const content = await page.getByLabel('已发布订阅内容', { exact: true }).inputValue();
    const full = parse(content);
    expect(full['proxy-groups'][0].proxies).toEqual([name, entry.name]);
    expect(full.proxies[0]['dialer-proxy']).toBe(full.proxies[1].name);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载订阅内容', exact: true }).click();
    expect(await readFile(await (await download).path(), 'utf8')).toBe(content);
    await page.getByRole('button', { name: '预览 URI', exact: true }).click();
    await expect(page.getByLabel('已发布订阅内容', { exact: true })).toHaveValue(
      /^ss:\/\/[^\r\n]+$/,
    );
    await p3Api(
      page,
      '/api/nodes/' + entry.id,
      { revision: entry.revision, changes: { server: 'updated.example.com' } },
      'PATCH',
    );
    await expect
      .poll(async () => await (await page.request.get(result.urls.mihomo)).text())
      .toContain('updated.example.com');
    await page.getByRole('button', { name: '关闭方案编辑', exact: true }).click();
    await page.getByRole('button', { name: '本地节点', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
    const row = page.locator('.library-main .library-list > li').filter({ hasText: entry.name });
    while (!(await row.count())) {
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
    }
    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('节点正被链式代理引用');
    await page.screenshot({ path: testInfo.outputPath('chains.png'), fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    testInfo.setTimeout(testInfo.timeout + 10000);
    if (subscription) await removeChainTestRecord(page, '/api/subscriptions/' + subscription.id);
    if (chain) await removeChainTestRecord(page, '/api/chains/' + chain.id);
    for (const saved of [...created.nodes, ...padding.nodes])
      await removeChainTestRecord(page, '/api/nodes/' + saved.id);
  }
});

test('two-hop chain conflict keeps edits, member status refreshes, and deleting a chain preserves nodes', async ({
  page,
}, testInfo) => {
  await login(page);
  const name = '链式冲突-' + testInfo.project.name;
  const created = await p3Api(page, '/api/nodes', {
    drafts: [
      { ...node('ss'), name: name + '-A' },
      { ...node('ss'), name: name + '-B' },
    ],
  });
  const [entry, exit] = created.nodes;
  const chain = await p3Api(page, '/api/chains', {
    name,
    entryNodeId: entry.id,
    exitNodeId: exit.id,
  });
  try {
    await page.getByRole('button', { name: '本地节点', exact: true }).click();
    const region = page.getByRole('region', { name: '链式代理管理', exact: true });
    const row = region.locator('.library-list > li').filter({ hasText: name });
    await row.getByRole('button', { name: '编辑链', exact: true }).click();
    await page.getByLabel('链名称', { exact: true }).fill('未保存链名称');
    await p3Api(
      page,
      '/api/chains/' + chain.id,
      { revision: 1, name: name + '-服务器版本' },
      'PATCH',
    );
    await page.getByRole('button', { name: '保存链式代理', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('链式代理已修改');
    await expect(page.getByLabel('链名称', { exact: true })).toHaveValue('未保存链名称');
    await page.getByRole('button', { name: '重新载入链版本', exact: true }).click();
    await expect(page.getByLabel('链名称', { exact: true })).toHaveValue(name + '-服务器版本');
    await page.getByRole('button', { name: '关闭链编辑', exact: true }).click();
    await p3Api(page, '/api/nodes/' + exit.id, { revision: 1, enabled: false }, 'PATCH');
    await region.getByRole('button', { name: '刷新链式代理', exact: true }).click();
    await expect(region.getByText('成员已停用', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: '禁用链', exact: true }).click();
    await expect(row.getByText('禁用', { exact: true })).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: '删除链', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect((await page.request.get('/api/nodes/' + entry.id)).ok()).toBe(true);
    expect((await page.request.get('/api/nodes/' + exit.id)).ok()).toBe(true);
  } finally {
    await removeChainTestRecord(page, '/api/chains/' + chain.id);
    for (const saved of created.nodes) await removeChainTestRecord(page, '/api/nodes/' + saved.id);
  }
});

async function removeChainTestRecord(page, path) {
  const response = await page.request.get(path);
  if (response.status() === 404) return;
  expect(response.ok()).toBe(true);
  const current = await response.json();
  await p3Api(page, path, { revision: current.revision }, 'DELETE');
}
