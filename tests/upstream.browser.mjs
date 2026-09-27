/* global document, window, caches */
import { test, expect } from '@playwright/test';
import { UUID } from './fixtures.mjs';
async function login(page) {
  await page.goto('/submeld/');
  await page.getByLabel('管理员密码', { exact: true }).fill('SubMeld-UI-Test-Only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
}
async function native(page, path, body, method = 'POST') {
  const response = await page.request.fetch('/upstream/sub-store' + path, {
    method,
    data: body,
    headers: { Origin: 'http://127.0.0.1:3210', 'Content-Type': 'application/json' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('Sub-Store offline cache preserves enhanced navigation, reloads and fresh assets', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: '打开 Sub-Store', exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.goBack();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '打开 Sub-Store', exact: true }).click();
  await page.goto('/submeld/#/nodes');
  await expect(page.getByRole('heading', { name: '本地节点', exact: true })).toBeVisible();
  await page.goto('/submeld/');
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  const asset = await page.locator('script[src*="/submeld/assets/"]').getAttribute('src');
  // Poison only this test's disposable browser cache, proving enhanced scripts
  // are fetched from the server even when the native runtime cache has an entry.
  await page.evaluate(async (url) => {
    await (
      await caches.open('js-cache')
    ).put(
      url,
      new Response('cached-wrong-application', {
        headers: { 'Content-Type': 'application/javascript' },
      }),
    );
  }, asset);
  await page.reload();
  await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  const response = await page.goto('/s/missing/uri');
  expect(response.status()).toBe(404);
  expect(await page.locator('body').innerText()).toContain('NOT_FOUND');
});

test('an already installed native worker upgrades without clearing saved browser settings', async ({
  page,
  context,
}) => {
  await login(page);
  await context.addCookies([{ name: 'submeld-test-legacy-worker', value: '1', url: page.url() }]);
  await page.evaluate(async () => {
    localStorage.setItem('submeld-regression-setting', 'preserved');
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await context.clearCookies({ name: 'submeld-test-legacy-worker' });
  await page.goto('/submeld/');
  // The legacy worker serves its native index here and registers the updated
  // /sw.js. It must become active while this old-controlled page remains open.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('heading', { name: '订阅与测试', exact: true })).toBeVisible();
  }).toPass({ timeout: 15000 });
  expect(await page.evaluate(() => localStorage.getItem('submeld-regression-setting'))).toBe(
    'preserved',
  );
});

test('home opens upstream nodes with empty display names and editable Koipy and enhancement settings', async ({
  page,
}, info) => {
  await login(page);
  const name = 'blank-name-' + info.project.name;
  await native(page, '/api/subs', {
    name,
    displayName: '',
    source: 'local',
    content: 'vless://' + UUID + '@example.com:443?security=tls#visible-node',
    process: [],
  });
  await page.getByRole('button', { name: '查看 Sub-Store 节点', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await row.getByRole('button', { name: '查看节点' }).click();
  await expect(
    page.getByRole('checkbox', { name: '选择 visible-node', exact: true }),
  ).toBeVisible();
  await expect(row).toContainText('1');
  await page.getByRole('button', { name: '服务入口', exact: true }).click();
  await page.getByRole('button', { name: '配置 Koipy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Koipy 管理', exact: true })).toBeVisible();
  await page.getByLabel('机器人用户名', { exact: true }).fill('ExampleKoipyBot');
  await page.getByLabel('管理员 Telegram ID', { exact: true }).fill('123456789');
  await page.getByLabel('Koipy 激活码', { exact: true }).fill('test-only-koipy-license');
  await page.getByLabel('Bot Token', { exact: true }).fill('123456:browser_fixture_token');
  await page.getByLabel('miaospeed Token', { exact: true }).fill('test-only-miaospeed-token');
  await page.getByRole('button', { name: '保存 Koipy 配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已写入 Koipy 配置文件');
  await expect(page.getByLabel('Bot Token', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('Bot Token', { exact: true })).toHaveAttribute(
    'placeholder',
    '已配置，留空保留',
  );
  await expect(page.getByLabel('管理员 Telegram ID', { exact: true })).toHaveValue('123456789');
  await page.screenshot({ path: info.outputPath('koipy-settings.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '服务入口', exact: true }).click();
  await expect(
    page.getByRole('link', { name: '打开 Telegram 机器人', exact: true }),
  ).toHaveAttribute('href', 'https://t.me/ExampleKoipyBot');
  await page.getByRole('button', { name: '管理增强工具', exact: true }).click();
  await expect(page.getByRole('heading', { name: '增强工具', exact: true })).toBeVisible();
  await page.getByLabel('HTTPS 测试地址', { exact: true }).fill('https://example.com/health');
  await page.getByRole('button', { name: '保存测试地址', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存测试地址');
  await expect(page.getByRole('region', { name: '内核管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '使用默认测试地址', exact: true }).click();
  await page.getByRole('button', { name: '保存测试地址', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存测试地址');
  await page.screenshot({ path: info.outputPath('enhancement-settings.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await native(page, '/api/sub/' + name, undefined, 'DELETE');
});
test('native Sub-Store edits and renames resources without losing enhanced identity', async ({
  page,
}, info) => {
  await login(page);
  const name = 'native-' + info.project.name;
  await native(page, '/api/subs', {
    name,
    displayName: name,
    source: 'local',
    content: 'vless://' + UUID + '@example.com:443?security=tls#native',
    process: [],
  });
  const response = page.waitForResponse(
    (r) => r.url().includes('/upstream/sub-store/api/subs') && r.request().method() === 'GET',
  );
  await page.getByRole('link', { name: '打开 Sub-Store', exact: true }).click();
  await response;
  await expect(page.getByText(/^(Subscription|订阅管理)$/, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  const before = (await native(page, '/api/sub/' + name, undefined, 'GET')).data;
  await page
    .locator('.sub-item-wrapper')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .locator('button')
    .filter({ has: page.locator('svg[data-icon="pen-nib"]') })
    .click();
  const renamed = name + '-renamed';
  await page
    .getByRole('textbox', { name: 'Unique name(do not include / )', exact: true })
    .fill(renamed);
  await page.getByRole('textbox', { name: 'The display name', exact: true }).fill(renamed);
  await page.getByRole('tab', { name: 'Content', exact: true }).click();
  const content = 'vless://' + UUID + '@edited.example.com:443?security=tls#native-edited';
  await page.locator('.cm-content[contenteditable="true"]').fill(content);
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes('/api/sub/' + name),
  );
  await page.locator('.submit-btn').click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
  const after = (await native(page, '/api/sub/' + renamed, undefined, 'GET')).data;
  expect(after._submeld).toEqual(before._submeld);
  expect(after.content).toBe(content);
  await page.screenshot({ path: info.outputPath('native-substore.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await native(page, '/api/sub/' + renamed, undefined, 'DELETE');
});
test('upstream preview copies nodes, starts tests and clears selection after snapshot replacement', async ({
  page,
}, info) => {
  await login(page);
  const name = 'preview-' + info.project.name;
  const content = (label) => 'vless://' + UUID + '@example.com:443?security=tls#' + label;
  await native(page, '/api/subs', {
    name,
    source: 'local',
    content: content('first'),
    process: [],
  });
  await page.getByRole('button', { name: '上游节点预览', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: '查看节点' })
    .click();
  await page.getByRole('checkbox', { name: '选择 first', exact: true }).check();
  await page.getByRole('button', { name: '复制所选为本地节点' }).click();
  await expect(page.getByRole('status')).toContainText('已保存为 Sub-Store');
  await page.getByRole('checkbox', { name: '选择 first', exact: true }).check();
  await page.getByRole('button', { name: '测试所选节点', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看测试进度', exact: true })).toBeVisible();
  await native(page, '/api/sub/' + name, { content: content('second') }, 'PATCH');
  await page.getByRole('button', { name: '更新上游快照' }).click();
  await expect(page.getByRole('checkbox', { name: '选择 second', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '复制所选为本地节点' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('upstream-preview.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await native(
    page,
    '/api/sub/' + name,
    {
      content:
        content('second') +
        '\nss://' +
        Buffer.from('aes-256-cfb:public-test').toString('base64') +
        '@example.com:8388#unsupported',
    },
    'PATCH',
  );
  await page.getByRole('button', { name: '更新上游快照' }).click();
  await expect(page.getByRole('alert')).toContainText('第 2 项');
  await native(page, '/api/sub/' + name, undefined, 'DELETE');
});
