import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { login, api, noOverflow } from './browser-helpers.mjs';

async function openTelegram(page) {
  await page.getByRole('button', { name: '测试中心', exact: true }).click();
  await page.getByRole('button', { name: 'Telegram', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Telegram 设置', exact: true })).toBeVisible();
}
async function saveTelegram(page) {
  const request = page.waitForRequest(
    (request) =>
      request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/telegram/settings',
  );
  await page.getByRole('button', { name: '保存 Telegram 设置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Telegram 设置已保存。' })).toBeVisible();
  return (await request).postDataJSON();
}
async function resetTelegram(page, profile) {
  await api(
    page,
    '/api/telegram/settings',
    { enabled: false, token: null, proxyUrl: null, allowedUserIds: [], profile },
    'PATCH',
  );
}

test('Telegram saves an independent complete preset and handles write-only secrets', async ({
  page,
}, info) => {
  await login(page);
  const webBefore = await api(page, '/api/miaospeed/settings');
  const telegramBefore = await api(page, '/api/telegram/settings');
  await api(page, '/api/miaospeed/scripts/initialize', {});
  const originalToken = '12345:UI_Browser_Original_Only';
  const replacementToken = '12345:UI_Browser_Replacement_Only';
  const originalProxySecret = 'browser-original-proxy-secret';
  const replacementProxySecret = 'browser-replacement-proxy-secret';
  const selectedCatalog = await api(page, '/api/miaospeed/scripts', {
    name: 'telegram-selected-' + info.project.name,
    enabled: true,
    content: "function handler(){return {text:'受控脚本'};}",
  });
  const script = selectedCatalog.scripts.find(
    (script) => script.name === 'telegram-selected-' + info.project.name,
  );
  const disabled = await api(page, '/api/miaospeed/scripts', {
    name: 'telegram-disabled-' + info.project.name,
    enabled: false,
    content: "function handler(){return {text:'受控脚本'};}",
  });
  const disabledScript = disabled.scripts.find(
    (script) => script.name === 'telegram-disabled-' + info.project.name,
  );
  try {
    const webSettings = { ...webBefore, downloadSeconds: 4, nodeCore: 'mihomo' };
    await api(page, '/api/miaospeed/settings', webSettings, 'PATCH');
    await api(
      page,
      '/api/telegram/settings',
      {
        enabled: false,
        token: originalToken,
        proxyUrl: 'http://browser-user:' + originalProxySecret + '@127.0.0.1:8080',
        allowedUserIds: ['123456789'],
        profile: {
          settings: webSettings,
          metrics: ['TEST_PING_RTT'],
          scriptIds: [],
        },
      },
      'PATCH',
    );
    await openTelegram(page);
    const form = page.getByRole('form', { name: 'Telegram 设置', exact: true });
    const preset = page.getByRole('region', { name: 'Telegram 测试预设', exact: true });
    await expect(form.getByLabel('新的 Bot Token', { exact: true })).toHaveValue('');
    await expect(form.getByLabel('新的 Telegram 代理地址', { exact: true })).toHaveValue('');
    await expect(form).toContainText(/Bot Token：\s*已配置/);
    await expect(form).toContainText('127.0.0.1:8080');
    await expect(form).not.toContainText(originalProxySecret);
    await expect(
      preset.getByRole('checkbox', { name: disabledScript.name, exact: true }),
    ).toHaveCount(0);
    expect(script).toBeTruthy();
    await expect(preset.getByRole('checkbox', { name: script.name, exact: true })).toBeVisible();
    await preset.getByRole('combobox', { name: '节点执行内核', exact: true }).selectOption('xray');
    const strings = {
      'HTTPS 连通性目标': 'https://example.com/telegram-ping',
      下载目标: 'https://example.com/telegram-download',
      上传目标: 'https://example.com/telegram-upload',
      'STUN 地址': 'udp://stun.example.com:3478',
    };
    for (const [label, value] of Object.entries(strings))
      await preset.getByLabel(label, { exact: true }).fill(value);
    const numbers = {
      '下行时长（秒）': '6',
      '上行时长（秒）': '4',
      下行线程: '2',
      上行线程: '3',
      'Ping 次数': '5',
      尝试次数: '4',
      '单次请求超时（毫秒）': '6000',
      '每项任务等待上限（秒）': '180',
    };
    for (const [label, value] of Object.entries(numbers))
      await preset.getByLabel(label, { exact: true }).fill(value);
    for (const box of await preset.getByRole('checkbox').all()) await box.uncheck();
    await preset.getByRole('checkbox', { name: '平均 RTT', exact: true }).check();
    await preset.getByRole('checkbox', { name: script.name, exact: true }).check();
    await form.getByLabel('新的 Bot Token', { exact: true }).fill(replacementToken);
    await form
      .getByLabel('新的 Telegram 代理地址', { exact: true })
      .fill('http://replacement-user:' + replacementProxySecret + '@127.0.0.1:9001');
    const patch = await saveTelegram(page);
    expect(patch.token).toBe(replacementToken);
    expect(patch.proxyUrl).toContain(replacementProxySecret);
    const stored = await api(page, '/api/telegram/settings');
    expect(stored.profile).toEqual({
      settings: {
        ...webSettings,
        nodeCore: 'xray',
        pingUrl: strings['HTTPS 连通性目标'],
        downloadUrl: strings.下载目标,
        uploadUrl: strings.上传目标,
        stunAddress: strings['STUN 地址'],
        downloadSeconds: 6,
        uploadSeconds: 4,
        downloadThreads: 2,
        uploadThreads: 3,
        pingCount: 5,
        retries: 4,
        requestTimeoutMs: 6000,
        timeoutSeconds: 180,
      },
      metrics: ['TEST_PING_RTT'],
      scriptIds: [script.id],
    });
    expect(await api(page, '/api/miaospeed/settings')).toEqual(webSettings);
    expect(stored.tokenConfigured).toBe(true);
    expect(stored.proxyConfigured).toBe(true);
    expect(stored).not.toHaveProperty('token');
    expect(stored).not.toHaveProperty('proxyUrl');
    expect(JSON.stringify(stored)).not.toContain(replacementToken);
    expect(JSON.stringify(stored)).not.toContain(replacementProxySecret);
    await expect(form.getByLabel('新的 Bot Token', { exact: true })).toHaveValue('');
    await expect(form.getByLabel('新的 Telegram 代理地址', { exact: true })).toHaveValue('');

    await form.getByLabel('允许的 Telegram 用户 ID', { exact: true }).fill('123456789\n987654321');
    expect(await saveTelegram(page)).toEqual({ allowedUserIds: ['123456789', '987654321'] });
    const retained = await api(page, '/api/telegram/settings');
    expect(retained.tokenConfigured).toBe(true);
    expect(retained.proxyConfigured).toBe(true);

    await page.getByRole('button', { name: '综合测试', exact: true }).click();
    await page.getByText('测试参数', { exact: true }).click();
    await page.getByLabel('下行时长（秒）', { exact: true }).fill('7');
    await page.getByRole('button', { name: '保存为默认参数', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '默认测试参数已保存' })).toBeVisible();
    expect((await api(page, '/api/telegram/settings')).profile).toEqual(stored.profile);
    await page.getByRole('button', { name: 'Telegram', exact: true }).click();
    await expect(form.getByLabel('下行时长（秒）', { exact: true })).toHaveValue('6');
    await page.getByRole('button', { name: '检测脚本', exact: true }).click();
    await page.getByRole('button', { name: '编辑 ' + script.name, exact: true }).click();
    await page.getByRole('checkbox', { name: '启用', exact: true }).uncheck();
    await page.getByRole('button', { name: '保存脚本', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '检测脚本已保存' })).toBeVisible();
    await page.getByRole('button', { name: 'Telegram', exact: true }).click();
    await expect(form).toContainText('1 个已选脚本已停用或不可用');
    await form
      .getByLabel('允许的 Telegram 用户 ID', { exact: true })
      .fill('123456789\n987654321\n222333444');
    expect(await saveTelegram(page)).toEqual({
      allowedUserIds: ['123456789', '987654321', '222333444'],
    });
    expect((await api(page, '/api/telegram/settings')).profile).toEqual(stored.profile);
    await form.getByRole('button', { name: '移除不可用脚本', exact: true }).click();
    const removed = await saveTelegram(page);
    expect(removed.profile.scriptIds).toEqual([]);
    expect((await api(page, '/api/telegram/settings')).profile.scriptIds).toEqual([]);
    await form.getByRole('checkbox', { name: '清除已保存的 Bot Token', exact: true }).check();
    await form.getByRole('checkbox', { name: '清除已保存的代理', exact: true }).check();
    await expect(form.getByLabel('新的 Bot Token', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('新的 Telegram 代理地址', { exact: true })).toBeDisabled();
    expect(await saveTelegram(page)).toEqual({ token: null, proxyUrl: null });
    const cleared = await api(page, '/api/telegram/settings');
    expect(cleared.tokenConfigured).toBe(false);
    expect(cleared.proxyConfigured).toBe(false);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('telegram-settings.png'), fullPage: true });
  } catch (error) {
    console.error('Telegram preset browser failure:', error instanceof Error ? error.stack : error);
    throw error;
  } finally {
    await resetTelegram(page, telegramBefore.profile);
    await api(page, '/api/miaospeed/settings', webBefore, 'PATCH');
    const catalog = await api(page, '/api/miaospeed/scripts');
    for (const id of [disabledScript.id, script.id]) {
      const current = catalog.scripts.find((script) => script.id === id);
      if (current)
        await api(
          page,
          '/api/miaospeed/scripts/' + current.id,
          { revision: current.revision },
          'DELETE',
        );
    }
  }
});

test('Telegram requires a whitelist, token and test item before enabling; saved connection checks use the fixture', async ({
  page,
}) => {
  await login(page);
  const before = await api(page, '/api/telegram/settings');
  await resetTelegram(page, { ...before.profile, metrics: ['TEST_PING_RTT'], scriptIds: [] });
  const patches = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname === '/api/telegram/settings'
    )
      patches.push(request.postDataJSON());
  });
  try {
    await openTelegram(page);
    const form = page.getByRole('form', { name: 'Telegram 设置', exact: true });
    await form.getByRole('checkbox', { name: '启用 Telegram 测试', exact: true }).check();
    await page.getByRole('button', { name: '保存 Telegram 设置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('至少填写一个允许的用户 ID');
    await form.getByLabel('允许的 Telegram 用户 ID', { exact: true }).fill('0');
    await page.getByRole('button', { name: '保存 Telegram 设置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('有效的 Telegram 数字用户 ID');
    await form.getByLabel('允许的 Telegram 用户 ID', { exact: true }).fill('123456789');
    await page.getByRole('button', { name: '保存 Telegram 设置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请设置 Bot Token');
    await form.getByLabel('新的 Bot Token', { exact: true }).fill('invalid-token');
    await page.getByRole('button', { name: '保存 Telegram 设置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请核对 Bot Token 格式');
    expect(patches).toEqual([]);
    await form.getByLabel('新的 Bot Token', { exact: true }).fill('90001:UI_Test_Only_No_Network');
    const preset = page.getByRole('region', { name: 'Telegram 测试预设', exact: true });
    await preset.getByRole('checkbox', { name: '平均 RTT', exact: true }).uncheck();
    await page.getByRole('button', { name: '保存 Telegram 设置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('至少选择一个检测项或启用脚本');
    expect(patches).toEqual([]);
    await preset.getByRole('checkbox', { name: '平均 RTT', exact: true }).check();
    await saveTelegram(page);
    const connection = page.getByRole('region', { name: 'Telegram 连接状态', exact: true });
    await expect(connection).toContainText('@submeld_test_bot');
    await form.getByLabel('新的 Bot Token', { exact: true }).fill('unsaved-invalid-token');
    await page.getByRole('button', { name: '检查已保存连接', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已检查保存的 Telegram 连接设置' }),
    ).toBeVisible();
    await expect(connection).toContainText('@submeld_test_bot');
    expect(patches).toHaveLength(1);
    await noOverflow(page);
  } finally {
    await resetTelegram(page, before.profile);
  }
});

test('Telegram displays queue, errors and delivery state, cancels jobs and resends reports', async ({
  page,
}, info) => {
  await login(page);
  const before = await api(page, '/api/telegram/settings');
  await resetTelegram(page, before.profile);
  const createdAt = new Date().toISOString();
  const report = {
    id: randomUUID(),
    origin: 'telegram',
    name: 'Telegram 浏览器报告',
    state: 'completed',
    createdAt,
    finishedAt: createdAt,
    backendVersion: '4.7.6',
    settings: before.profile.settings,
    metrics: ['TEST_PING_RTT'],
    scripts: [],
    total: 0,
    completed: 0,
    current: null,
    error: null,
    results: [],
  };
  const task = (overrides) => ({
    id: randomUUID(),
    botId: '90001',
    userId: '123456789',
    chatId: '123456789',
    updateId: 1,
    messageId: 1,
    createdAt,
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    state: 'queued',
    reportId: null,
    progressMessageId: null,
    total: 0,
    completed: 0,
    error: null,
    deliveryState: 'pending',
    deliveredParts: [],
    deliveryError: null,
    deliveryAttempts: 0,
    nextDeliveryAt: null,
    ...overrides,
  });
  const queued = task({ updateId: 1 });
  const running = task({ updateId: 2, state: 'running', total: 3, completed: 1 });
  const completed = task({
    updateId: 3,
    state: 'completed',
    reportId: report.id,
    total: 2,
    completed: 2,
    deliveryState: 'failed',
    deliveredParts: ['png'],
    deliveryError: '报告回传失败，请重试。',
    deliveryAttempts: 2,
  });
  const failed = task({
    updateId: 4,
    state: 'failed',
    error: '订阅解析失败。',
    deliveryState: 'failed',
    deliveryError: '状态回传失败。',
  });
  let tasks = [queued, running, completed, failed];
  let connection = {
    state: 'connecting',
    botId: '90001',
    username: 'submeld_test_bot',
    error: null,
    checkedAt: createdAt,
    queued: 1,
    activeTaskId: running.id,
  };
  const actions = [];
  // Only Telegram UI states and task actions are routed here; management settings use real APIs.
  await page.route('**/api/telegram/status', (route) => route.fulfill({ json: connection }));
  await page.route('**/api/telegram/check', (route) => {
    connection = { ...connection, state: 'error', error: '代理连接失败。' };
    return route.fulfill({ json: connection });
  });
  await page.route('**/api/telegram/tasks?*', (route) =>
    route.fulfill({ json: { tasks, total: 26 } }),
  );
  await page.route('**/api/telegram/tasks/*/cancel', (route) => {
    expect(route.request().method()).toBe('POST');
    actions.push('cancel');
    tasks = tasks.map((item) =>
      item.id === queued.id ? { ...item, state: 'cancelled', deliveryState: 'suppressed' } : item,
    );
    connection = { ...connection, queued: 0 };
    return route.fulfill({ json: tasks.find((item) => item.id === queued.id) });
  });
  await page.route('**/api/telegram/tasks/*/resend', (route) => {
    expect(route.request().method()).toBe('POST');
    actions.push('resend');
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    tasks = tasks.map((item) =>
      item.id === id ? { ...item, deliveryState: 'pending', deliveryError: null } : item,
    );
    return route.fulfill({ json: tasks.find((item) => item.id === id) });
  });
  const reportSummary = { ...report };
  delete reportSummary.results;
  await page.route('**/api/miaospeed/reports/' + report.id, (route) =>
    route.fulfill({ json: report }),
  );
  await page.route('**/api/miaospeed/reports?*', (route) =>
    route.fulfill({ json: { reports: [reportSummary], total: 1 } }),
  );
  try {
    await openTelegram(page);
    const jobs = page.getByRole('region', { name: 'Telegram 任务', exact: true });
    const connectionPanel = page.getByRole('region', { name: 'Telegram 连接状态', exact: true });
    const queuedRow = jobs.getByRole('listitem', {
      name: 'Telegram 任务 ' + queued.id,
      exact: true,
    });
    const runningRow = jobs.getByRole('listitem', {
      name: 'Telegram 任务 ' + running.id,
      exact: true,
    });
    const completedRow = jobs.getByRole('listitem', {
      name: 'Telegram 任务 ' + completed.id,
      exact: true,
    });
    await expect(connectionPanel).toContainText('排队 1 项');
    await expect(connectionPanel).toContainText('有任务运行中');
    await expect(runningRow).toContainText('测速中');
    await expect(runningRow).toContainText('1/3 项');
    await expect(jobs).toContainText('订阅解析失败。');
    await expect(completedRow).toContainText('回传失败');
    await expect(completedRow).toContainText('已回传文件 1 项');
    await expect(completedRow).toContainText('报告回传失败，请重试。');
    await page.getByRole('button', { name: '检查已保存连接', exact: true }).click();
    await expect(connectionPanel.getByRole('alert')).toHaveText('代理连接失败。');
    await queuedRow.getByRole('button', { name: '取消任务', exact: true }).click();
    await expect(queuedRow).toContainText('已取消');
    await expect(queuedRow).toContainText('已停止回传');
    await expect(queuedRow.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);
    await completedRow.getByRole('button', { name: '重新回传报告', exact: true }).click();
    await expect(completedRow).toContainText('待回传');
    await expect(completedRow).not.toContainText('报告回传失败，请重试。');
    const failedRow = jobs.getByRole('listitem', {
      name: 'Telegram 任务 ' + failed.id,
      exact: true,
    });
    await expect(failedRow.getByRole('button', { name: '查看报告', exact: true })).toHaveCount(0);
    await failedRow.getByRole('button', { name: '重新回传任务状态', exact: true }).click();
    await expect(failedRow).not.toContainText('状态回传失败。');
    expect(actions).toEqual(['cancel', 'resend', 'resend']);
    const nextPage = page.waitForRequest('**/api/telegram/tasks?page=1');
    await jobs.getByRole('button', { name: '下一页', exact: true }).click();
    await nextPage;
    await expect(jobs).toContainText('第 2 页 · 共 26 项');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('telegram-jobs.png'), fullPage: true });
    await completedRow.getByRole('button', { name: '查看报告', exact: true }).click();
    const reportPanel = page.getByRole('region', { name: '综合测试报告', exact: true });
    await expect(reportPanel).toContainText('Telegram 浏览器报告');
    await expect(reportPanel.locator('.page-header')).toContainText('Telegram');
    await expect(page.locator('.test-history li').filter({ hasText: report.name })).toContainText(
      'Telegram',
    );
    await noOverflow(page);
  } finally {
    await resetTelegram(page, before.profile);
  }
});
