/* global window, document */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { UUID } from './fixtures.mjs';
const password = 'SubMeld-UI-Test-Only-2026';
async function login(page) {
  await page.goto('/');
  await page.getByLabel('管理员密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '从输入到可用链接。' })).toBeVisible();
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
  await login(page);
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
  await login(page);
  await expect(page.getByLabel('节点输入', { exact: true })).toHaveValue('');
  await expect(page.getByText('从一条节点开始', { exact: true })).toBeVisible();
});
test('manual form generates real URI and a response arriving after an edit is discarded', async ({
  page,
}) => {
  await login(page);
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
