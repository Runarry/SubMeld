import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { login, api, noOverflow } from './browser-helpers.mjs';
import { newSubscription } from '../dist/server/shared/subscriptions.js';

// Agent protocol fixtures only: these tests never execute commands on a VPS.
function snapshot(name) {
  const id = 'node-' + randomUUID().replaceAll('-', '').slice(0, 16);
  return {
    schemaVersion: 1,
    revision: createHash('sha256').update(name).digest('hex'),
    vpsctlVersion: 'deletion-browser-fixture',
    capabilities: { actions: ['core.restart'], profiles: [] },
    cores: [
      {
        core: 'sing-box',
        installed: true,
        running: true,
        enabled: true,
        pending_restart: false,
        version: '1.14.fixture',
      },
    ],
    nodes: [{ id, name, core: 'sing-box', profile: 'ss', address: '203.0.113.20', port: 443 }],
    relay: { exits: [], bindings: [], forwards: [] },
    exports: [
      {
        id,
        name,
        core: 'sing-box',
        kind: 'node',
        uri:
          'ss://' +
          Buffer.from('aes-256-gcm:public-ui-test-password').toString('base64') +
          '@203.0.113.20:443#' +
          encodeURIComponent(name),
      },
    ],
    pendingCores: [],
  };
}

const machinePath = (machine) => '/api/machines/' + machine.machine.id;
const dialogFor = (page) => page.getByRole('dialog', { name: '删除机器', exact: true });
const confirmation = (dialog) =>
  dialog.getByLabel('我已卸载此机器的 Agent，或确认尚未安装', { exact: true });
const deleteButton = (dialog) => dialog.getByRole('button', { name: '确认删除机器', exact: true });

async function assertCounts(dialog, counts) {
  const labels = {
    nodes: '上报节点',
    subscriptions: '机器订阅',
    tasks: '任务记录',
    files: '私有文件',
  };
  for (const [key, label] of Object.entries(labels))
    await expect(
      dialog.locator('dl[aria-label="删除范围"] > div').filter({ hasText: label }).locator('dd'),
    ).toHaveText(counts[key] === null ? '未知' : String(counts[key]));
}

async function agentRequest(page, machine, path, body, method = 'POST') {
  return page.request.fetch('/api/agent/' + path, {
    method,
    data: body,
    headers: { Authorization: 'Bearer ' + machine.token, 'Content-Type': 'application/json' },
  });
}
async function makeMachine(page, name, reported = false) {
  const machine = { ...(await api(page, '/api/machines', { name })), snapshot: snapshot(name) };
  if (reported) {
    const response = await agentRequest(page, machine, 'report', {
      machineId: machine.machine.id,
      bootId: randomUUID(),
      agentVersion: 'deletion-browser-fixture',
      snapshot: machine.snapshot,
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  return machine;
}
async function preview(page, machine) {
  return (await api(page, machinePath(machine) + '/deletion-preview')).preview;
}
async function retire(page, machine) {
  const response = await page.request.get(machinePath(machine) + '/deletion-preview');
  if (response.status() === 404) return;
  expect(response.ok(), await response.text()).toBe(true);
  const { preview: current } = await response.json();
  await api(
    page,
    machinePath(machine),
    { revision: current.revision, agentUninstalled: true },
    'DELETE',
  );
}
async function openDeletion(page, machine) {
  await page.goto('/submeld/#/machines?machine=' + machine.machine.id + '&tab=settings');
  await expect(
    page.getByRole('heading', { name: machine.machine.name, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '删除机器', exact: true }).click();
  const dialog = dialogFor(page);
  await expect(dialog).toBeVisible();
  return dialog;
}
async function assertDeleted(page, machine) {
  await expect(dialogFor(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '机器', exact: true })).toBeVisible();
  expect((await page.request.get(machinePath(machine))).status()).toBe(404);
  expect(
    (await api(page, '/api/machines')).machines.some((item) => item.id === machine.machine.id),
  ).toBe(false);
  expect(
    (await api(page, '/api/nodes/resources')).resources.some(
      (item) => item.id === machine.machine.resourceId,
    ),
  ).toBe(false);
  const oldToken = await agentRequest(
    page,
    machine,
    'commands?machineId=' + machine.machine.id + '&wait=0',
    undefined,
    'GET',
  );
  expect(oldToken.status()).toBe(401);
}
async function explicitDelete(page, machine, dialog) {
  const acknowledged = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === machinePath(machine),
  );
  await deleteButton(dialog).click();
  const response = await acknowledged;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({
    agentUninstalled: true,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await assertDeleted(page, machine);
}

test('never-reported machine cancellation preserves state and deletion requires uninstall acknowledgement', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(
    page,
    '未安装删除-' + info.project.name + '-' + randomUUID().slice(0, 8),
  );
  const deletes = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === machinePath(machine))
      deletes.push(request);
  });
  try {
    const before = await api(page, machinePath(machine));
    let dialog = await openDeletion(page, machine);
    await expect(dialog).toContainText(machine.machine.name);
    await assertCounts(dialog, { nodes: 0, subscriptions: 0, tasks: 0, files: 0 });
    const command = dialog.getByLabel('Agent 卸载命令', { exact: true });
    await expect(command).toHaveAttribute('readonly', '');
    await expect(command).toHaveValue(/pipefail/);
    await expect(command).toHaveValue(/curl.*--fail/);
    await expect(command).toHaveValue(/\/agent\/install\.sh.*--uninstall/s);
    expect(await command.inputValue()).not.toContain(machine.token);
    await expect(dialog).not.toContainText(machine.token);
    await expect(dialog).toContainText(/root/);
    await expect(dialog).toContainText(/vpsctl/);
    await expect(dialog).toContainText(/隧道/);
    await expect(dialog.getByRole('button', { name: '复制卸载命令', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '复制卸载命令', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText(/卸载命令已复制|请复制已选中的卸载命令/);
    await expect(deleteButton(dialog)).toBeDisabled();
    await confirmation(dialog).check();
    await expect(deleteButton(dialog)).toBeEnabled();
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath('machine-delete-unreported.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(deletes).toHaveLength(0);
    expect(await api(page, machinePath(machine))).toEqual(before);
    const token = await agentRequest(
      page,
      machine,
      'commands?machineId=' + machine.machine.id + '&wait=0',
      undefined,
      'GET',
    );
    expect(token.ok(), await token.text()).toBe(true);
    dialog = await openDeletion(page, machine);
    await expect(confirmation(dialog)).not.toBeChecked();
    await expect(deleteButton(dialog)).toBeDisabled();
    await confirmation(dialog).check();
    await explicitDelete(page, machine, dialog);
    expect(deletes).toHaveLength(1);
  } finally {
    await retire(page, machine);
  }
});

test('reported machine lists real references and running tasks then deletes only after references are removed', async ({
  page,
}, info) => {
  await login(page);
  const suffix = info.project.name + '-' + randomUUID().slice(0, 8);
  const machine = await makeMachine(page, '上报删除-' + suffix, true);
  const collectionName = 'delete-collection-' + suffix;
  let collectionCreated = false;
  let plan;
  try {
    const source = (await api(page, '/api/nodes/resources')).resources.find(
      (item) => item.id === machine.machine.resourceId,
    );
    await api(page, '/upstream/sub-store/api/collections', {
      name: collectionName,
      subscriptions: [source.upstreamName],
      process: [],
    });
    collectionCreated = true;
    plan = await api(page, '/api/subscriptions', {
      ...newSubscription(),
      name: '引用删除-' + suffix,
      inputs: [{ kind: 'resource', id: source.id }],
    });
    const { task } = await api(page, machinePath(machine) + '/commands', {
      action: 'core.restart',
      params: { core: 'sing-box' },
      expectedRevision: machine.snapshot.revision,
    });
    const polled = await agentRequest(
      page,
      machine,
      'commands?machineId=' + machine.machine.id + '&wait=0',
      undefined,
      'GET',
    );
    expect(polled.ok(), await polled.text()).toBe(true);
    expect((await polled.json()).command.requestId).toBe(task.id);
    const current = await preview(page, machine);
    expect(current.counts).toMatchObject({ nodes: 1, subscriptions: 1, tasks: 1 });
    expect(current.counts.files).toBeGreaterThanOrEqual(2);
    expect(current.unfinishedTasks).toEqual([
      expect.objectContaining({ id: task.id, status: 'running' }),
    ]);
    let dialog = await openDeletion(page, machine);
    await assertCounts(dialog, current.counts);
    await expect(
      dialog.getByRole('link', { name: '处理组合订阅 ' + collectionName, exact: true }),
    ).toHaveAttribute('href', /^\/\?api=.*upstream%2Fsub-store/);
    await expect(
      dialog.getByRole('link', { name: '处理输出方案 ' + plan.name, exact: true }),
    ).toHaveAttribute('href', /^#\/subscriptions$/);
    await expect(dialog.getByLabel('Agent 卸载命令', { exact: true })).toHaveCount(0);
    await expect(confirmation(dialog)).toHaveCount(0);
    await expect(deleteButton(dialog)).toBeDisabled();
    await expect(dialog).toContainText(/执行中|运行中/);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('machine-delete-blocked.png'), fullPage: true });
    const beforeCancel = await api(page, machinePath(machine));
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await api(page, machinePath(machine))).toEqual(beforeCancel);
    dialog = await openDeletion(page, machine);
    const detail = await api(page, '/api/subscriptions/' + plan.id);
    await api(page, '/api/subscriptions/' + plan.id, { revision: detail.revision }, 'DELETE');
    plan = undefined;
    await api(page, '/upstream/sub-store/api/collection/' + collectionName, undefined, 'DELETE');
    collectionCreated = false;
    await dialog.getByRole('button', { name: '刷新删除预览', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: /卸载 Agent/ })).toBeVisible();
    await expect(deleteButton(dialog)).toBeDisabled();
    expect((await api(page, machinePath(machine))).tasks).toEqual([
      expect.objectContaining({ id: task.id, status: 'running' }),
    ]);
    await confirmation(dialog).check();
    await explicitDelete(page, machine, dialog);
  } finally {
    if (plan) {
      const detail = await api(page, '/api/subscriptions/' + plan.id);
      await api(page, '/api/subscriptions/' + plan.id, { revision: detail.revision }, 'DELETE');
    }
    if (collectionCreated)
      await api(page, '/upstream/sub-store/api/collection/' + collectionName, undefined, 'DELETE');
    await retire(page, machine);
  }
});

test('version conflict and incomplete failure retain acknowledgement and require an explicit retry', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(
    page,
    '冲突删除-' + info.project.name + '-' + randomUUID().slice(0, 8),
    true,
  );
  const endpoint = '**' + machinePath(machine);
  const deletes = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === machinePath(machine))
      deletes.push(request);
  });
  try {
    const dialog = await openDeletion(page, machine);
    await confirmation(dialog).check();
    const renamed = machine.machine.name + '-已更新';
    await api(page, machinePath(machine), { name: renamed }, 'PATCH');
    const conflict = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname === machinePath(machine),
    );
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === machinePath(machine) + '/deletion-preview',
    );
    await deleteButton(dialog).click();
    expect((await conflict).status()).toBe(409);
    expect((await refreshed).ok()).toBe(true);
    await expect(dialog).toContainText(renamed);
    await expect(confirmation(dialog)).toBeChecked();
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(deletes).toHaveLength(1);
    await page.route(endpoint, async (route) => {
      if (route.request().method() === 'DELETE')
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      else await route.continue();
    });
    const retryPreview = page.waitForResponse(
      (response) => new URL(response.url()).pathname === machinePath(machine) + '/deletion-preview',
    );
    await deleteButton(dialog).click();
    expect((await retryPreview).ok()).toBe(true);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(confirmation(dialog)).toBeChecked();
    expect(deletes).toHaveLength(2);
    expect((await api(page, machinePath(machine))).machine.enabled).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('machine-delete-retry.png'), fullPage: true });
    await page.unroute(endpoint);
    await explicitDelete(page, machine, dialog);
    expect(deletes).toHaveLength(3);
  } finally {
    await page.unroute(endpoint);
    await retire(page, machine);
  }
});

test('preview failures can retry and a lost successful delete response resolves through the missing-machine preview', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(
    page,
    '断线删除-' + info.project.name + '-' + randomUUID().slice(0, 8),
  );
  const endpoint = '**' + machinePath(machine);
  const previewEndpoint = endpoint + '/deletion-preview';
  let failPreview = 'unavailable';
  await page.route(previewEndpoint, async (route) => {
    if (failPreview)
      await route.fulfill({
        status: failPreview === 'catalog-missing' ? 404 : 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: failPreview === 'catalog-missing' ? 'SUB_STORE_FAILED' : 'TEST_UNAVAILABLE',
          message:
            failPreview === 'catalog-missing'
              ? '上游目录不存在，请检查连接后重试。'
              : '删除预览暂不可用，请重试。',
          diagnostics: [],
        }),
      });
    else await route.continue();
  });
  try {
    const dialog = await openDeletion(page, machine);
    await expect(dialog.getByRole('alert')).toContainText('删除预览暂不可用');
    await expect(deleteButton(dialog)).toBeDisabled();
    await expect(confirmation(dialog)).toHaveCount(0);
    failPreview = 'catalog-missing';
    await dialog.getByRole('button', { name: '刷新删除预览', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('上游目录不存在');
    await expect(dialog).toBeVisible();
    await expect(deleteButton(dialog)).toBeDisabled();
    expect((await api(page, machinePath(machine))).machine.enabled).toBe(true);
    failPreview = '';
    await dialog.getByRole('button', { name: '刷新删除预览', exact: true }).click();
    await expect(confirmation(dialog)).toBeVisible();
    await confirmation(dialog).check();
    let accepted = false;
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      accepted = true;
      await route.abort('connectionreset');
    });
    const reconciled = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === machinePath(machine) + '/deletion-preview' &&
        response.status() === 404,
    );
    await deleteButton(dialog).click();
    await reconciled;
    expect(accepted).toBe(true);
    await assertDeleted(page, machine);
  } finally {
    await page.unroute(endpoint);
    await page.unroute(previewEndpoint);
    await retire(page, machine);
  }
});
