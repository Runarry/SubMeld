/* global location, window */
import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';

// Real management APIs with an isolated Agent protocol fixture; no VPS execution.
const revision = (value) => createHash('sha256').update(value).digest('hex');
function nativeSnapshot(name) {
  const hy2 = {
    id: 'node-' + randomUUID().replaceAll('-', '').slice(0, 16),
    name: name + ' HY2',
    core: 'sing-box',
    profile: 'hysteria2',
    address: '203.0.113.21',
    port: 443,
    listen: '0.0.0.0',
    ip_strategy: 'prefer_ipv4',
    tls: {
      enabled: true,
      mode: 'managed',
      server_name: 'hy2.example.test',
      certificate_id: 'crt-0123456789abcdef',
      certificate_path: '/private/not-for-browser.pem',
      key_path: '/private/key-not-for-browser.pem',
    },
    transport: { type: 'tcp', path: '', service_name: '' },
    options: {
      obfs_type: 'gecko',
      obfs_password: 'DO-NOT-SHOW-OBFS',
      up_mbps: 100,
      down_mbps: 200,
      bbr_profile: 'conservative',
      hop_ports: '20000-20100',
    },
    credentials: { password: 'DO-NOT-SHOW-CREDENTIAL' },
    future_native_option: { preserve: true },
  };
  const ss = {
    id: 'node-' + randomUUID().replaceAll('-', '').slice(0, 16),
    name: name + ' SS',
    core: 'sing-box',
    profile: 'shadowsocks-aes-256-gcm',
    address: '203.0.113.22',
    port: 18443,
    listen: '::',
    ip_strategy: 'auto',
    tls: { enabled: false, mode: 'none', server_name: '' },
    transport: { type: 'tcp', path: '', service_name: '' },
    options: { method: 'aes-256-gcm' },
  };
  const ws = {
    id: 'node-' + randomUUID().replaceAll('-', '').slice(0, 16),
    name: name + ' WS',
    core: 'xray',
    profile: 'vless-ws-tls',
    address: 'ws.example.test',
    port: 8443,
    listen: '::',
    ip_strategy: 'auto',
    tls: { enabled: true, mode: 'imported', server_name: 'ws.example.test' },
    transport: { type: 'ws', path: '/original-websocket', service_name: '' },
    options: {},
  };
  return {
    schemaVersion: 1,
    revision: revision(name),
    vpsctlVersion: 'overview-browser-fixture',
    capabilities: {
      actions: [
        'node.add',
        'node.edit',
        'node.delete',
        'node.switch',
        'node.ip-policy',
        'core.install',
        'core.update',
        'core.start',
        'core.stop',
        'core.restart',
        'core.uninstall',
        'dns.set',
        'dns.reset',
        'exit.add',
        'exit.edit',
        'exit.delete',
        'binding.add',
        'binding.delete',
        'forward.add',
        'forward.edit',
        'forward.delete',
        'forward.refresh',
        'time.sync',
        'tunnel.apply',
        'tunnel.delete',
      ],
      profiles: [
        { id: 'hysteria2', label: 'Hysteria2', cores: ['sing-box', 'xray'] },
        {
          id: 'shadowsocks-aes-256-gcm',
          label: 'Shadowsocks AES-256-GCM',
          cores: ['sing-box', 'xray'],
        },
        { id: 'vless-ws-tls', label: 'VLESS / WebSocket / TLS', cores: ['sing-box', 'xray'] },
      ],
    },
    cores: [
      {
        core: 'sing-box',
        installed: true,
        running: true,
        enabled: true,
        pending_restart: false,
        version: '1.14.fixture',
      },
      {
        core: 'xray',
        installed: true,
        running: true,
        enabled: true,
        pending_restart: false,
        version: '26.fixture',
      },
    ],
    nodes: [hy2, ss, ws],
    relay: { exits: [], bindings: [], forwards: [] },
    pendingCores: [],
    exports: [
      {
        id: hy2.id,
        name: hy2.name,
        core: hy2.core,
        kind: 'node',
        uri: 'hysteria2://public-ui-password@203.0.113.21:443?sni=hy2.example.test&insecure=1#HY2',
      },
      {
        id: ss.id,
        name: ss.name,
        core: ss.core,
        kind: 'node',
        uri:
          'ss://' +
          Buffer.from('aes-256-gcm:public-ui-password').toString('base64') +
          '@203.0.113.22:18443#SS',
      },
      {
        id: ws.id,
        name: ws.name,
        core: ws.core,
        kind: 'node',
        uri:
          'vless://' +
          randomUUID() +
          '@ws.example.test:8443?security=tls&type=ws&path=%2Foriginal-websocket&sni=ws.example.test#WS',
      },
    ],
  };
}
async function agent(page, machine, path, body, method = 'POST') {
  const response = await page.request.fetch('/api/agent/' + path, {
    method,
    data: body,
    headers: { Authorization: 'Bearer ' + machine.token, 'Content-Type': 'application/json' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function report(page, machine) {
  return agent(page, machine, 'report', {
    machineId: machine.machine.id,
    agentVersion: 'overview-browser-fixture',
    bootId: machine.bootId,
    snapshot: machine.snapshot,
  });
}
async function machineFixture(page, name, pending = false) {
  const value = await api(page, '/api/machines', { name });
  const machine = { ...value, bootId: randomUUID(), snapshot: nativeSnapshot(name) };
  if (pending) {
    machine.snapshot.pendingCores = ['sing-box'];
    machine.snapshot.cores[0].pending_restart = true;
  }
  await report(page, machine);
  return machine;
}
async function retire(page, machine) {
  await api(page, '/api/machines/' + machine.machine.id, { enabled: false }, 'PATCH');
  const resource = (await api(page, '/api/nodes/resources')).resources.find(
    (item) => item.id === machine.machine.resourceId,
  );
  if (resource) await cleanup(page, { resource });
}
async function openMachine(page, machine, extra = '') {
  await page.goto('/submeld/#/machines?machine=' + machine.machine.id + '&tab=nodes' + extra);
  await expect(
    page.getByRole('heading', { name: machine.machine.name, exact: true }),
  ).toBeVisible();
}
async function finishTask(page, machine, status, next) {
  const command = (
    await agent(
      page,
      machine,
      'commands?machineId=' + machine.machine.id + '&wait=0',
      undefined,
      'GET',
    )
  ).command;
  expect(command?.action).toBe('node.edit');
  machine.snapshot = next;
  await agent(page, machine, 'results', {
    machineId: machine.machine.id,
    result: {
      schemaVersion: 1,
      requestId: command.requestId,
      status,
      exitCode: 0,
      message: 'DO-NOT-SHOW-AGENT-RESULT',
      revision: next.revision,
      snapshot: next,
    },
  });
  return command;
}

test('machine overview searches addresses, filters attention and navigates independent detail tabs', async ({
  page,
}, info) => {
  await login(page);
  const suffix = info.project.name + '-' + randomUUID().slice(0, 8);
  const active = await machineFixture(page, '入口总览-' + suffix);
  const pending = await machineFixture(page, '待重启总览-' + suffix, true);
  const unknown = await api(page, '/api/machines', { name: '未上报-' + suffix });
  try {
    await page.getByRole('button', { name: '机器', exact: true }).click();
    const search = page.getByRole('searchbox', { name: '搜索机器名称或连接地址', exact: true });
    await search.fill(active.machine.name);
    await expect(page.locator('.machine-row')).toHaveCount(1);
    await page.getByRole('combobox', { name: '机器状态筛选', exact: true }).selectOption('online');
    await search.fill('203.0.113.21');
    await expect(page.locator('.machine-row')).toHaveCount(2);
    await search.fill('');
    await page.getByRole('combobox', { name: '机器状态筛选', exact: true }).selectOption('pending');
    await expect(
      page.locator('.machine-row').filter({ hasText: pending.machine.name }),
    ).toContainText('待重启');
    await expect(page.locator('.machine-row').filter({ hasText: active.machine.name })).toHaveCount(
      0,
    );
    await page.getByRole('combobox', { name: '机器状态筛选', exact: true }).selectOption('offline');
    await expect(
      page.locator('.machine-row').filter({ hasText: unknown.machine.name }),
    ).toContainText('未知');
    await page.getByRole('combobox', { name: '机器状态筛选', exact: true }).selectOption('all');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('machine-overview.png'), fullPage: true });
    await page.getByRole('button', { name: '管理 ' + active.machine.name, exact: true }).click();
    await expect(page.getByRole('tab', { name: /^节点/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.machine-node-row')).toHaveCount(3);
    await expect(search).toHaveCount(0);
    await page.getByRole('tab', { name: '内核与 DNS', exact: true }).click();
    await expect(page.getByRole('heading', { name: '代理内核', exact: true })).toBeVisible();
    expect(
      new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1]).get('tab'),
    ).toBe('cores');
    await page.getByRole('tab', { name: '任务记录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '任务与结果', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /^节点/ }).click();
    await page
      .getByRole('combobox', { name: '节点协议筛选', exact: true })
      .selectOption('Hysteria2');
    await expect(page.locator('.machine-node-row')).toHaveCount(1);
    await expect(page.locator('.machine-node-row')).toContainText('203.0.113.21:443');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('machine-nodes.png'), fullPage: true });
  } finally {
    await retire(page, active);
    await retire(page, pending);
    await api(page, '/api/machines/' + unknown.machine.id, { enabled: false }, 'PATCH');
  }
});

test('node drawer restores native safe values, filters protocol fields and submits only a changed port', async ({
  page,
}, info) => {
  await login(page);
  const machine = await machineFixture(
    page,
    '抽屉-' + info.project.name + '-' + randomUUID().slice(0, 8),
  );
  const hy2 = machine.snapshot.nodes[0];
  try {
    await openMachine(page, machine, '&node=' + hy2.id + '&edit=1');
    let editor = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    await expect(editor.getByLabel('节点名称', { exact: true })).toHaveValue(hy2.name);
    await expect(editor.getByLabel('客户端连接地址', { exact: true })).toHaveValue(hy2.address);
    await expect(editor.getByLabel('监听端口', { exact: true })).toHaveValue('443');
    await expect(editor.getByLabel('服务器名称 SNI', { exact: true })).toHaveValue(
      'hy2.example.test',
    );
    await expect(editor.getByLabel('证书模式', { exact: true })).toHaveValue('managed');
    await expect(editor.getByLabel('托管证书 ID', { exact: true })).toHaveValue(
      'crt-0123456789abcdef',
    );
    await expect(editor.getByLabel('传输路径', { exact: true })).toHaveCount(0);
    await editor.locator('summary').filter({ hasText: '高级选项' }).click();
    await expect(editor.getByLabel('混淆方式', { exact: true })).toHaveValue('gecko');
    await expect(editor.getByLabel('上行带宽（Mbps）', { exact: true })).toHaveValue('100');
    await expect(editor).not.toContainText('DO-NOT-SHOW');
    await expect(editor).not.toContainText('/private/');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    const ssRow = page
      .locator('.machine-node-row')
      .filter({ hasText: machine.snapshot.nodes[1].name });
    const ssEdit = ssRow.getByRole('button', { name: '编辑机器节点', exact: true });
    await ssEdit.click();
    editor = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('节点名称', { exact: true })).toHaveValue(
      machine.snapshot.nodes[1].name,
    );
    await expect(editor.getByLabel('服务器名称 SNI', { exact: true })).toHaveCount(0);
    await expect(editor.getByLabel('混淆方式', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(ssEdit).toBeFocused();
    const wsRow = page
      .locator('.machine-node-row')
      .filter({ hasText: machine.snapshot.nodes[2].name });
    await wsRow.getByRole('button', { name: '编辑机器节点', exact: true }).click();
    editor = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    await expect(editor.getByLabel('传输路径', { exact: true })).toHaveValue('/original-websocket');
    await expect(editor.getByLabel('gRPC 服务名称', { exact: true })).toHaveCount(0);
    await editor.getByLabel('监听端口', { exact: true }).fill('9443');
    const importedSubmission = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/commands'),
    );
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    expect((await importedSubmission).postDataJSON().params).toEqual({
      id: machine.snapshot.nodes[2].id,
      port: 9443,
      'install-deps': true,
    });
    await expect(editor.getByRole('status')).toContainText('排队中');
    const importedTask = (await api(page, '/api/machines/' + machine.machine.id)).tasks[0];
    await api(
      page,
      '/api/machines/' + machine.machine.id + '/commands/' + importedTask.id + '/cancel',
      {},
    );
    await editor.getByRole('button', { name: '返回节点', exact: true }).click();
    await page
      .locator('.machine-node-row')
      .filter({ hasText: hy2.name })
      .getByRole('button', { name: '编辑机器节点', exact: true })
      .click();
    editor = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    await editor.getByLabel('监听端口', { exact: true }).fill('8443');
    await expect(editor.getByLabel('节点变更摘要', { exact: true })).toContainText('1 项修改');
    await expect(editor.getByLabel('节点变更摘要', { exact: true })).toContainText('443 → 8443');
    const save = editor.getByRole('button', { name: '保存修改', exact: true });
    await save.focus();
    await page.keyboard.press('Tab');
    await expect(
      editor.getByRole('button', { name: '关闭编辑机器节点', exact: true }),
    ).toBeFocused();
    await noOverflow(page);
    if (info.project.name === 'narrow') {
      const box = await editor.boundingBox();
      expect(box.x).toBe(0);
      expect(box.width).toBe(await page.evaluate(() => window.innerWidth));
    }
    await page.screenshot({ path: info.outputPath('machine-node-editor.png'), fullPage: true });
    const submission = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/commands'),
    );
    await save.click();
    const submitted = await submission;
    expect(submitted.status()).toBe(201);
    expect(submitted.request().postDataJSON().params).toEqual({
      id: hy2.id,
      port: 8443,
      'install-deps': true,
    });
    const next = {
      ...machine.snapshot,
      revision: revision(machine.machine.id + 'port-edit'),
      nodes: machine.snapshot.nodes.map((node) =>
        node.id === hy2.id ? { ...node, port: 8443 } : node,
      ),
    };
    await finishTask(page, machine, 'applied', next);
    await expect(editor.getByRole('status')).toContainText('已应用', { timeout: 10000 });
    await expect(editor).not.toContainText('DO-NOT-SHOW-AGENT-RESULT');
  } finally {
    await retire(page, machine);
  }
});

test('node drawer keeps dirty input through revision conflicts and leaves unknown results for review', async ({
  page,
}, info) => {
  await login(page);
  const machine = await machineFixture(
    page,
    '冲突-' + info.project.name + '-' + randomUUID().slice(0, 8),
  );
  const node = machine.snapshot.nodes[0];
  try {
    await openMachine(page, machine, '&node=' + node.id + '&edit=1');
    const editor = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    await editor.getByLabel('监听端口', { exact: true }).fill('9443');
    await editor.getByLabel('自动安装必要系统工具', { exact: true }).uncheck();
    machine.snapshot = {
      ...machine.snapshot,
      revision: revision(machine.machine.id + 'external'),
      nodes: machine.snapshot.nodes.map((item) =>
        item.id === node.id ? { ...item, name: '外部更新的名称' } : item,
      ),
    };
    await report(page, machine);
    await expect(editor.getByRole('alert')).toContainText('机器版本已变化', { timeout: 10000 });
    await expect(editor.getByLabel('监听端口', { exact: true })).toHaveValue('9443');
    await expect(editor.getByLabel('自动安装必要系统工具', { exact: true })).not.toBeChecked();
    await expect(editor.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: '采用最新版本', exact: true }).click();
    await expect(editor.getByLabel('节点名称', { exact: true })).toHaveValue('外部更新的名称');
    await expect(editor.getByLabel('监听端口', { exact: true })).toHaveValue('9443');
    const submission = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/commands'),
    );
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    const body = (await submission).postDataJSON();
    expect(body.expectedRevision).toBe(machine.snapshot.revision);
    expect(body.params).toEqual({ id: node.id, port: 9443 });
    await expect(editor.getByRole('status')).toContainText('排队中');
    await finishTask(page, machine, 'unknown', machine.snapshot);
    await expect(editor.getByRole('status')).toContainText('结果未知', { timeout: 10000 });
    await expect(editor.getByRole('status')).toContainText('不会自动重试');
    expect(
      (await api(page, '/api/machines/' + machine.machine.id)).tasks.filter(
        (task) => task.action === 'node.edit',
      ),
    ).toHaveLength(1);
    await noOverflow(page);
  } finally {
    await retire(page, machine);
  }
});

test('node drawer adopts an explicit task conflict before one manual retry and locks unknown results', async ({
  page,
}, info) => {
  await login(page);
  const machine = await machineFixture(
    page,
    '任务冲突-' + info.project.name + '-' + randomUUID().slice(0, 8),
  );
  const node = machine.snapshot.nodes[0];
  try {
    await openMachine(page, machine, '&node=' + node.id + '&edit=1');
    const editor = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    const port = editor.getByLabel('监听端口', { exact: true });
    const sni = editor.getByLabel('服务器名称 SNI', { exact: true });
    const installDeps = editor.getByLabel('自动安装必要系统工具', { exact: true });
    const save = editor.getByRole('button', { name: '保存修改', exact: true });
    const adopt = editor.getByRole('button', { name: '采用最新版本', exact: true });
    await port.fill('9443');
    await sni.fill('manual.example.test');
    await installDeps.uncheck();
    await save.click();
    await expect(editor.getByRole('status')).toContainText('排队中');
    await expect(port).toBeDisabled();
    await expect(save).toHaveCount(0);
    await expect(adopt).toHaveCount(0);
    const next = {
      ...machine.snapshot,
      revision: revision(machine.machine.id + 'task-conflict'),
      nodes: machine.snapshot.nodes.map((item) =>
        item.id === node.id ? { ...item, name: '任务冲突后的名称', port: 8443 } : item,
      ),
    };
    await finishTask(page, machine, 'conflict', next);
    await expect(editor.getByRole('status')).toContainText('本次任务未应用', { timeout: 10000 });
    await expect(port).toHaveValue('9443');
    await expect(sni).toHaveValue('manual.example.test');
    await expect(installDeps).not.toBeChecked();
    await expect(adopt).toBeEnabled();
    expect((await api(page, '/api/machines/' + machine.machine.id)).tasks).toHaveLength(1);
    await adopt.click();
    await expect(editor.getByLabel('节点名称', { exact: true })).toHaveValue('任务冲突后的名称');
    await expect(port).toHaveValue('9443');
    await expect(sni).toHaveValue('manual.example.test');
    await expect(installDeps).not.toBeChecked();
    await expect(editor.getByLabel('节点变更摘要', { exact: true })).toContainText('8443 → 9443');
    await expect(save).toBeEnabled();
    const retry = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/commands'),
    );
    await save.click();
    const body = (await retry).postDataJSON();
    expect(body.expectedRevision).toBe(next.revision);
    expect(body.params).toEqual({ id: node.id, port: 9443, sni: 'manual.example.test' });
    await expect(editor.getByRole('status')).toContainText('排队中');
    await finishTask(page, machine, 'unknown', machine.snapshot);
    await expect(editor.getByRole('status')).toContainText('不会自动重试', { timeout: 10000 });
    machine.snapshot = {
      ...machine.snapshot,
      revision: revision(machine.machine.id + 'unknown-latest'),
      nodes: machine.snapshot.nodes.map((item) =>
        item.id === node.id ? { ...item, name: '未知结果后的最新名称' } : item,
      ),
    };
    await report(page, machine);
    await expect(editor.locator('.editor-subtitle')).toContainText('未知结果后的最新名称', {
      timeout: 10000,
    });
    await expect(editor.getByLabel('监听端口', { exact: true })).toBeDisabled();
    await expect(save).toHaveCount(0);
    await expect(adopt).toHaveCount(0);
    expect((await api(page, '/api/machines/' + machine.machine.id)).tasks).toHaveLength(2);
    await noOverflow(page);
  } finally {
    await retire(page, machine);
  }
});

test('node drawer cannot retry a conflicted task when its node is missing from the latest snapshot', async ({
  page,
}, info) => {
  await login(page);
  const machine = await machineFixture(
    page,
    '节点移除-' + info.project.name + '-' + randomUUID().slice(0, 8),
  );
  const node = machine.snapshot.nodes[0];
  try {
    await openMachine(page, machine, '&node=' + node.id + '&edit=1');
    const editor = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    await editor.getByLabel('监听端口', { exact: true }).fill('9443');
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('排队中');
    await finishTask(page, machine, 'conflict', {
      ...machine.snapshot,
      revision: revision(machine.machine.id + 'node-removed'),
      nodes: machine.snapshot.nodes.filter((item) => item.id !== node.id),
      exports: machine.snapshot.exports.filter((item) => item.id !== node.id),
    });
    await expect(editor.getByRole('status')).toContainText('节点已不在最新快照中', {
      timeout: 10000,
    });
    await expect(editor.getByLabel('监听端口', { exact: true })).toHaveValue('9443');
    await expect(editor.getByLabel('监听端口', { exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: '采用最新版本', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '保存修改', exact: true })).toHaveCount(0);
    expect((await api(page, '/api/machines/' + machine.machine.id)).tasks).toHaveLength(1);
  } finally {
    await retire(page, machine);
  }
});
