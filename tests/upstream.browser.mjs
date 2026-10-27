/* global document, window, caches */
import { test, expect } from '@playwright/test';
import { UUID } from './fixtures.mjs';
import { login, api, cleanup, navigate, noOverflow } from './browser-helpers.mjs';
async function native(page, path, body, method = 'POST') {
  const response = await page.request.fetch('/upstream/sub-store' + path, {
    method,
    data: body,
    headers: { Origin: 'http://127.0.0.1:3210', 'Content-Type': 'application/json' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('default and retired home routes open nodes without stale queries or extra history', async ({
  page,
}, info) => {
  const integrationRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/integrations')
      integrationRequests.push(request.url());
  });
  await login(page);
  const nav = page.getByRole('navigation', { name: '管理页面' });
  await expect(nav.getByRole('button', { name: '服务入口', exact: true })).toHaveCount(0);
  if (info.project.name === 'narrow') {
    await nav.getByRole('button', { name: '更多', exact: true }).click();
    await expect(page.getByLabel('更多页面').getByRole('button')).toHaveText([
      '输出方案',
      '配套文件',
    ]);
    await nav.getByRole('button', { name: '更多', exact: true }).click();
  }
  for (const hash of [
    '',
    '#/?search=retired',
    '#/home?search=retired',
    '#/missing?search=retired',
  ]) {
    await page.goto('/submeld/' + hash);
    await expect(page).toHaveURL(/#\/nodes$/);
    await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  }
  await navigate(page, '测试中心');
  await page.goto('/submeld/#/home?resource=retired&page=99');
  await expect(page).toHaveURL(/#\/nodes$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/tests$/);
  await expect(page.getByRole('heading', { name: '测试中心', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#\/nodes$/);
  await page.reload();
  await expect(page).toHaveURL(/#\/nodes$/);
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  await noOverflow(page);
  expect(integrationRequests).toEqual([]);
});

test('login and navigation preserve valid node bookmarks and legacy aliases', async ({ page }) => {
  await page.goto('/submeld/#/library?search=bookmark');
  await page.getByLabel('管理员密码', { exact: true }).fill('SubMeld-UI-Test-Only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/#\/nodes\?search=bookmark$/);
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新上游', exact: true })).toBeEnabled();
  await navigate(page, '配套文件');
  await navigate(page, '节点');
  await expect(page).toHaveURL(/#\/nodes\?search=bookmark$/);
  await page.reload();
  await expect(page).toHaveURL(/#\/nodes\?search=bookmark$/);
  for (const alias of ['sources', 'workbench']) {
    await page.goto('/submeld/#/' + alias + '?search=bookmark');
    await expect(page).toHaveURL(/#\/nodes\?search=bookmark$/);
  }
  await navigate(page, '配套文件');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理员登录', exact: true })).toBeVisible();
  await page.getByLabel('管理员密码', { exact: true }).fill('SubMeld-UI-Test-Only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/#\/support-files$/);
  await expect(page.getByRole('heading', { name: '配套脚本与模板', exact: true })).toBeVisible();
});

test('node search stays locked during a request and replays only the latest hash after stale responses or errors', async ({
  page,
}, info) => {
  await login(page);
  const resource = await api(page, '/api/nodes', {
    name: 'query-navigation-' + info.project.name,
    source: 'local',
    content: ['navigation-A', 'navigation-B']
      .map((name) => 'vless://' + UUID + '@example.com:443?security=tls#' + name)
      .join('\n'),
  });
  const hash = (search) => '#/nodes?resource=' + resource.id + '&search=' + search;
  const search = page.getByRole('textbox', { name: '搜索节点', exact: true });
  const requests = [];
  let delayed;
  try {
    await page.goto('/submeld/' + hash('navigation-A'));
    await expect(
      page.getByRole('checkbox', { name: '选择 navigation-A', exact: true }),
    ).toBeVisible();
    await expect(search).toBeEnabled();
    await page.route('**/api/nodes?*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('search');
      requests.push(query);
      if (query !== 'navigation-B') return route.continue();
      const current = delayed;
      const response = await route.fetch();
      current.started.resolve();
      await current.release.promise;
      if (current.failure)
        await route.fulfill({
          status: 502,
          json: { code: 'STALE_QUERY_FIXTURE', message: '过期查询错误' },
        });
      else await route.fulfill({ response });
    });
    for (const failure of [false, true]) {
      delayed = {
        failure,
        started: Promise.withResolvers(),
        release: Promise.withResolvers(),
      };
      const before = requests.length;
      await page.getByRole('checkbox', { name: '选择 navigation-A', exact: true }).check();
      await page.goto('/submeld/' + hash('navigation-B'));
      await delayed.started.promise;
      await expect(search).toBeDisabled();
      await expect(search).toHaveValue('navigation-B');
      await expect(page.locator('.selection-bar')).toContainText('已选 0');
      await page.goBack();
      await expect(search).toHaveValue('navigation-A');
      if (!failure) {
        await page.goto('/submeld/' + hash('navigation-intermediate'));
        await expect(search).toHaveValue('navigation-intermediate');
        await page.goto('/submeld/' + hash('navigation-A'));
        await expect(search).toHaveValue('navigation-A');
      }
      await expect(search).toBeDisabled();
      expect(requests.slice(before)).toEqual(['navigation-B']);
      delayed.release.resolve();
      await expect(search).toBeEnabled();
      await expect(page.locator('.node-row')).toHaveCount(1);
      await expect(
        page.getByRole('checkbox', { name: '选择 navigation-A', exact: true }),
      ).not.toBeChecked();
      await expect(
        page.getByRole('checkbox', { name: '选择 navigation-B', exact: true }),
      ).toHaveCount(0);
      await expect(page).toHaveURL(
        new RegExp('#/nodes\\?resource=' + resource.id + '&search=navigation-A$'),
      );
      await expect(page.getByText('过期查询错误', { exact: true })).toHaveCount(0);
      expect(requests.slice(before)).toEqual(['navigation-B', 'navigation-A']);
    }
    await noOverflow(page);
  } finally {
    delayed?.release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await cleanup(page, { resource });
  }
});

test('node creation stays exclusive and preserves the latest navigation while its response is delayed', async ({
  page,
}, info) => {
  await login(page);
  const resource = await api(page, '/api/nodes', {
    name: 'mutation-navigation-' + info.project.name,
    source: 'local',
    content: ['mutation-A', 'mutation-B']
      .map((name) => 'vless://' + UUID + '@example.com:443?security=tls#' + name)
      .join('\n'),
  });
  const hash = (search) => '#/nodes?resource=' + resource.id + '&search=' + search;
  const search = page.getByRole('textbox', { name: '搜索节点', exact: true });
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  let created,
    writes = 0;
  const reads = [];
  try {
    await page.goto('/submeld/' + hash('mutation-A'));
    await expect(
      page.getByRole('checkbox', { name: '选择 mutation-A', exact: true }),
    ).toBeVisible();
    await expect(search).toBeEnabled();
    await page.route('**/api/nodes?*', (route) => {
      reads.push(new URL(route.request().url()).searchParams.get('search'));
      return route.continue();
    });
    await page.route('**/api/nodes', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      writes++;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      created = await response.json();
      started.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '添加节点或订阅', exact: true }).click();
    const form = page.getByRole('dialog', { name: '添加节点或订阅', exact: true });
    await form.getByLabel('订阅名称', { exact: true }).fill('delayed-create-' + info.project.name);
    await form
      .getByLabel('节点文本', { exact: true })
      .fill('vless://' + UUID + '@example.com:443?security=tls#created-node');
    await form.getByRole('button', { name: '保存到 Sub-Store', exact: true }).click();
    await started.promise;
    await expect(
      form.getByRole('button', { name: '保存到 Sub-Store', exact: true }),
    ).toBeDisabled();
    await form.locator('#add-resource').dispatchEvent('submit');
    await page.goto('/submeld/' + hash('mutation-intermediate'));
    await expect(search).toHaveValue('mutation-intermediate');
    await page.goto('/submeld/' + hash('mutation-B'));
    await expect(search).toHaveValue('mutation-B');
    await expect(search).toBeDisabled();
    expect(reads).toEqual([]);
    release.resolve();
    await expect(form).toHaveCount(0);
    await expect(search).toBeEnabled();
    await expect(page.locator('.node-row')).toHaveCount(1);
    await expect(
      page.getByRole('checkbox', { name: '选择 mutation-B', exact: true }),
    ).toBeVisible();
    await expect(search).toHaveValue('mutation-B');
    await expect(page).toHaveURL(
      new RegExp('#/nodes\\?resource=' + resource.id + '&search=mutation-B$'),
    );
    expect(reads).toEqual(['mutation-B']);
    expect(writes).toBe(1);
    expect(
      (await api(page, '/api/nodes/resources')).resources.some((item) => item.id === created.id),
    ).toBe(true);
    await noOverflow(page);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    if (created) await cleanup(page, { resource: created });
    await cleanup(page, { resource });
  }
});

test('Sub-Store offline cache preserves enhanced navigation, reloads and fresh assets', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: '在 Sub-Store 中编辑', exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.goBack();
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '在 Sub-Store 中编辑', exact: true }).click();
  await page.goto('/submeld/#/nodes');
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  await page.goto('/submeld/');
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  }).toPass({ timeout: 15000 });
  expect(await page.evaluate(() => localStorage.getItem('submeld-regression-setting'))).toBe(
    'preserved',
  );
});

test('nodes, test center, support files and test settings remain directly accessible', async ({
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
  await page.getByRole('button', { name: '刷新上游', exact: true }).click();
  await page.getByRole('combobox', { name: '所属订阅', exact: true }).selectOption({ label: name });
  await expect(page.locator('.node-row')).toHaveCount(1);
  await expect(
    page.getByRole('checkbox', { name: '选择 visible-node', exact: true }),
  ).toBeVisible();
  await navigate(page, '测试中心');
  await expect(page.getByRole('heading', { name: '测试中心', exact: true })).toBeVisible();
  await page.goto('/submeld/#/koipy');
  await expect(page).toHaveURL(/#\/tests$/);
  await page.getByRole('button', { name: '测速服务', exact: true }).click();
  await page.getByRole('button', { name: '检查连接 部署配置服务', exact: true }).click();
  await expect(page.getByText('连接：可用', { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath('miaospeed-status.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await navigate(page, '配套文件');
  await expect(page.getByRole('heading', { name: '配套脚本与模板', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '配套文件管理', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/support-files$/);
  await expect(page.getByLabel('HTTPS 测试地址', { exact: true })).toHaveCount(0);
  for (const name of ['管理节点', '管理输出方案', '管理测试任务与结果'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('support-files.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto('/submeld/#/tools');
  await expect(page).toHaveURL(/#\/support-files$/);
  await expect(page.getByRole('heading', { name: '配套脚本与模板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '测试中心', exact: true }).click();
  await page.getByRole('button', { name: '三内核检查', exact: true }).click();
  await page.getByLabel('HTTPS 测试地址', { exact: true }).fill('https://example.com/health');
  await page.getByRole('button', { name: '保存测试地址', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存测试地址' })).toBeVisible();
  await expect(page.getByRole('region', { name: '内核管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '使用默认测试地址', exact: true }).click();
  await page.getByRole('button', { name: '保存测试地址', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已保存测试地址' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('node-test-settings.png'), fullPage: true });
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
  await page.getByRole('link', { name: '在 Sub-Store 中编辑', exact: true }).click();
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
test('unified selection clears after native snapshot replacement', async ({ page }, info) => {
  await login(page);
  const name = 'preview-' + info.project.name;
  const content = (label) => 'vless://' + UUID + '@example.com:443?security=tls#' + label;
  await native(page, '/api/subs', {
    name,
    source: 'local',
    content: content('first'),
    process: [],
  });
  try {
    await page.getByRole('button', { name: '刷新上游', exact: true }).click();
    await page
      .getByRole('combobox', { name: '所属订阅', exact: true })
      .selectOption({ label: name });
    await page.getByRole('checkbox', { name: '选择 first', exact: true }).check();
    await native(page, '/api/sub/' + name, { content: content('second') }, 'PATCH');
    await page.getByRole('button', { name: '刷新上游', exact: true }).click();
    await expect(
      page.getByRole('checkbox', { name: '选择 second', exact: true }),
    ).not.toBeChecked();
    await expect(page.getByRole('button', { name: '删除所选', exact: true })).toBeDisabled();
  } finally {
    await native(page, '/api/sub/' + name, undefined, 'DELETE');
  }
});
