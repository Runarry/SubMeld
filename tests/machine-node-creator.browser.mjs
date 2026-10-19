/* global window */
import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { login, api, navigate, noOverflow } from './browser-helpers.mjs';

// Real isolated API/Agent protocol fixtures. These do not execute vpsctl or create a VPS node.
const revision = (value) => createHash('sha256').update(value).digest('hex');
const profiles = [
  ['vless-reality-vision', 'VLESS REALITY Vision'],
  ['hysteria2', 'Hysteria2'],
  ['vless-ws-tls', 'VLESS WS TLS'],
  ['vless-grpc-tls', 'VLESS gRPC TLS'],
  ['vless-xhttp-tls', 'VLESS XHTTP TLS'],
].map(([id, label]) => ({ id, label, cores: ['sing-box', 'xray'] }));

function snapshot(name) {
  const nodes = [443, 8443].map((port) => ({
    id: 'node-' + randomUUID().replaceAll('-', '').slice(0, 16),
    name: name + '-' + port,
    core: 'sing-box',
    profile: 'ss',
    listen: '::',
    address: '203.0.113.20',
    port,
  }));
  return {
    schemaVersion: 1,
    revision: revision(name),
    vpsctlVersion: 'browser-node-creator-fixture',
    capabilities: {
      actions: ['node.add', 'node.edit', 'core.install', 'core.update'],
      profiles,
    },
    cores: ['sing-box', 'xray'].map((core) => ({
      core,
      installed: true,
      running: true,
      enabled: true,
      pending_restart: false,
      version: core === 'sing-box' ? '1.14.1' : '26.9.1',
    })),
    nodes,
    exports: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      core: node.core,
      kind: 'node',
      uri:
        'ss://' +
        Buffer.from('aes-256-gcm:public-node-creator-fixture').toString('base64') +
        '@203.0.113.20:' +
        node.port +
        '#' +
        encodeURIComponent(node.name),
    })),
    relay: { exits: [], bindings: [], forwards: [] },
    pendingCores: [],
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
    agentVersion: 'browser-node-creator-fixture',
    bootId: machine.bootId,
    snapshot: machine.snapshot,
  });
}

async function makeMachine(page, info, customize = () => {}) {
  const name = '添加节点-' + info.project.name + '-' + randomUUID().slice(0, 8);
  const machine = {
    ...(await api(page, '/api/machines', { name })),
    bootId: randomUUID(),
    snapshot: snapshot(name),
  };
  customize(machine.snapshot);
  await report(page, machine);
  return machine;
}

async function openCreator(page, machine) {
  await navigate(page, '机器');
  await page.getByRole('button', { name: '管理 ' + machine.machine.name, exact: true }).click();
  await page
    .getByRole('region', { name: '机器详情', exact: true })
    .getByRole('button', { name: '添加机器节点', exact: true })
    .click();
  const form = page.getByRole('dialog', { name: '添加机器节点', exact: true });
  await expect(form).toBeVisible();
  return form;
}

async function retire(page, machine) {
  await api(page, '/api/machines/' + machine.machine.id, { enabled: false }, 'PATCH');
  const resource = (await api(page, '/api/nodes/resources')).resources.find(
    (item) => item.id === machine.machine.resourceId,
  );
  if (resource)
    await api(page, '/upstream/sub-store/api/sub/' + resource.upstreamName, undefined, 'DELETE');
}

async function tasks(page, machine) {
  return (await api(page, '/api/machines/' + machine.machine.id)).tasks;
}

async function pollCommand(page, machine) {
  let command;
  await expect
    .poll(
      async () => {
        command = (
          await agent(
            page,
            machine,
            'commands?machineId=' + machine.machine.id + '&wait=0',
            undefined,
            'GET',
          )
        ).command;
        return !!command;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  return command;
}

async function result(page, machine, command, status, next = machine.snapshot) {
  machine.snapshot = next;
  await agent(page, machine, 'results', {
    machineId: machine.machine.id,
    result: {
      schemaVersion: 1,
      requestId: command.requestId,
      status,
      message: 'Public Agent protocol fixture; no VPS execution',
      exitCode: 0,
      revision: next.revision,
      snapshot: next,
    },
  });
}

function submission(page, machine) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/machines/' + machine.machine.id + '/commands'),
  );
}

async function create(page, form, machine) {
  const response = submission(page, machine);
  await form.getByRole('button', { name: '创建节点', exact: true }).click();
  const queued = await response;
  expect(queued.status()).toBe(201);
  return queued.request().postDataJSON();
}

async function section(form, label) {
  const details = form.locator('details').filter({ hasText: label });
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  return details;
}

async function chooseProtocol(form, id) {
  await section(form, '更多协议');
  await form.getByLabel('更多协议', { exact: true }).selectOption(id);
}

async function drawerLayout(page, form, info, name) {
  await noOverflow(page);
  const dimensions = await form.evaluate((element) => {
    const dialog = element.getBoundingClientRect();
    const body = element.querySelector('.drawer-body');
    const footer = element.querySelector('.drawer-footer').getBoundingClientRect();
    const summary = element.querySelector('[aria-label="创建节点摘要"]').getBoundingClientRect();
    body.scrollTop = body.scrollHeight;
    const footerAfter = element.querySelector('.drawer-footer').getBoundingClientRect();
    const summaryAfter = element
      .querySelector('[aria-label="创建节点摘要"]')
      .getBoundingClientRect();
    return {
      width: dialog.width,
      height: dialog.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      footerBottom: footer.bottom,
      footerTop: footer.top,
      footerTopAfterScroll: footerAfter.top,
      summaryTop: summary.top,
      summaryTopAfterScroll: summaryAfter.top,
      summaryBottom: summary.bottom,
      overflow: element.scrollWidth > element.clientWidth,
    };
  });
  expect(dimensions.height).toBe(dimensions.viewportHeight);
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewportWidth);
  if (info.project.name === 'narrow') expect(dimensions.width).toBe(dimensions.viewportWidth);
  expect(dimensions.footerBottom).toBeLessThanOrEqual(dimensions.viewportHeight);
  expect(dimensions.footerTopAfterScroll).toBe(dimensions.footerTop);
  expect(dimensions.summaryTop).toBeGreaterThanOrEqual(dimensions.footerTop);
  expect(dimensions.summaryBottom).toBeLessThanOrEqual(dimensions.footerBottom);
  expect(dimensions.summaryTopAfterScroll).toBe(dimensions.summaryTop);
  expect(dimensions.overflow).toBe(false);
  await form.locator('.drawer-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  const path = info.outputPath(name + '.png');
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('node creator defaults reflect snapshot ports and address, and queued results cannot submit twice', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(page, info);
  try {
    const form = await openCreator(page, machine);
    await expect(form.getByLabel('内核', { exact: true })).toHaveValue('xray');
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue(
      'vless-reality-vision-9443',
    );
    await expect(form.getByLabel('监听端口', { exact: true })).toHaveValue('9443');
    await expect(form.getByLabel('客户端连接地址', { exact: true })).toHaveValue('203.0.113.20');
    await expect(form.getByLabel('SNI', { exact: true })).toHaveValue('www.amd.com');
    await expect(form.getByLabel('自动安装必要系统工具', { exact: true })).toBeChecked();
    await expect(form).toContainText(/生成|随机/);
    await expect(form.getByLabel(/密码|UUID|私钥|password/i)).toHaveCount(0);
    await drawerLayout(page, form, info, 'default-vision');
    const sent = await create(page, form, machine);
    const expected = {
      profile: 'vless-reality-vision',
      core: 'xray',
      name: 'vless-reality-vision-9443',
      port: 9443,
      listen: '::',
      address: '203.0.113.20',
      sni: 'www.amd.com',
      'reality-anti-relay': 'on',
      'ip-strategy': 'auto',
      'install-deps': true,
    };
    expect(sent).toEqual({
      action: 'node.add',
      expectedRevision: machine.snapshot.revision,
      params: expected,
    });
    await expect(form.getByRole('status')).toContainText('排队');
    await expect(form.getByRole('status')).toBeInViewport();
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toHaveCount(0);
    const command = await pollCommand(page, machine);
    expect(command.params).toEqual(expected);
    expect(command.expectedRevision).toBe(machine.snapshot.revision);
    await expect(form.getByRole('status')).toContainText(/执行|运行/, { timeout: 10000 });
    await result(page, machine, command, 'unknown');
    await expect(form.getByRole('status')).toContainText('未知', { timeout: 10000 });
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toHaveCount(0);
    expect(await tasks(page, machine)).toHaveLength(1);
  } finally {
    await retire(page, machine);
  }
});

test('template changes preserve common and protocol drafts while hiding inapplicable certificate and transport params', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(page, info);
  try {
    const form = await openCreator(page, machine);
    await form.getByLabel('节点名称', { exact: true }).fill('协议切换草稿');
    await form.getByLabel('监听端口', { exact: true }).fill('12345');
    await form.getByLabel('客户端连接地址', { exact: true }).fill('node.example.com');
    await form.getByRole('button', { name: 'Hysteria2', exact: true }).click();
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('协议切换草稿');
    await expect(form.getByLabel('监听端口', { exact: true })).toHaveValue('12345');
    await expect(form.getByLabel('客户端连接地址', { exact: true })).toHaveValue(
      'node.example.com',
    );
    await section(form, '性能设置');
    await form.getByLabel('上行带宽（Mbps）', { exact: true }).fill('88');
    await chooseProtocol(form, 'vless-ws-tls');
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('协议切换草稿');
    await expect(form.getByLabel('监听端口', { exact: true })).toHaveValue('12345');
    await expect(form.getByLabel('客户端连接地址', { exact: true })).toHaveValue(
      'node.example.com',
    );
    const certMode = form.getByLabel('证书模式', { exact: true });
    await certMode.selectOption('imported');
    await expect(form.getByLabel('托管证书 ID', { exact: true })).toHaveCount(0);
    await expect(form.getByLabel('机器上的证书文件路径', { exact: true })).toHaveAttribute(
      'required',
      '',
    );
    expect(
      await form
        .getByLabel('机器上的证书文件路径', { exact: true })
        .evaluate((input) => input.checkValidity()),
    ).toBe(false);
    await form
      .getByLabel('机器上的证书文件路径', { exact: true })
      .fill('/etc/public-fixture/fullchain.pem');
    await form
      .getByLabel('机器上的私钥文件路径', { exact: true })
      .fill('/etc/public-fixture/privkey.pem');
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toBeEnabled();
    await certMode.selectOption('managed');
    await expect(form.getByLabel('机器上的证书文件路径', { exact: true })).toHaveCount(0);
    await expect(form.getByLabel('机器上的私钥文件路径', { exact: true })).toHaveCount(0);
    await expect(form.getByLabel('托管证书 ID', { exact: true })).toHaveAttribute('required', '');
    expect(
      await form
        .getByLabel('托管证书 ID', { exact: true })
        .evaluate((input) => input.checkValidity()),
    ).toBe(false);
    await form.getByLabel('托管证书 ID', { exact: true }).fill('crt-0123456789abcdef');
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toBeEnabled();
    await certMode.selectOption('self-signed');
    await expect(form.getByLabel('托管证书 ID', { exact: true })).toHaveCount(0);
    await section(form, '传输设置');
    await expect(form.getByLabel('传输路径', { exact: true })).toHaveCount(0);
    await form.getByLabel('传输路径来源', { exact: true }).selectOption('manual');
    await form.getByLabel('传输路径', { exact: true }).fill('/remembered-path');
    await chooseProtocol(form, 'vless-grpc-tls');
    await section(form, '传输设置');
    await expect(form.getByLabel('gRPC 服务名称来源', { exact: true })).toHaveValue('auto');
    await expect(form.getByLabel('gRPC 服务名称', { exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: '通用推荐', exact: true }).click();
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('协议切换草稿');
    await expect(form.getByLabel('监听端口', { exact: true })).toHaveValue('12345');
    await expect(form.getByLabel('客户端连接地址', { exact: true })).toHaveValue(
      'node.example.com',
    );
    await form.getByRole('button', { name: 'Hysteria2', exact: true }).click();
    await section(form, '性能设置');
    await expect(form.getByLabel('上行带宽（Mbps）', { exact: true })).toHaveValue('88');
    await chooseProtocol(form, 'vless-ws-tls');
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('协议切换草稿');
    await expect(form.getByLabel('监听端口', { exact: true })).toHaveValue('12345');
    await expect(form.getByLabel('客户端连接地址', { exact: true })).toHaveValue(
      'node.example.com',
    );
    await section(form, '传输设置');
    await expect(form.getByLabel('传输路径', { exact: true })).toHaveValue('/remembered-path');
    await form.getByLabel('传输路径来源', { exact: true }).selectOption('auto');
    const sent = await create(page, form, machine);
    const command = await pollCommand(page, machine);
    expect(command.params).toEqual(sent.params);
    expect(command.params).toEqual({
      profile: 'vless-ws-tls',
      core: 'sing-box',
      name: '协议切换草稿',
      port: 12345,
      address: 'node.example.com',
      sni: 'www.amd.com',
      'cert-mode': 'self-signed',
      listen: '::',
      'ip-strategy': 'auto',
      'install-deps': true,
    });
    await noOverflow(page);
  } finally {
    await retire(page, machine);
  }
});

test('old-core HY2 explains gated options and submits only supported defaults with automatic address detection', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(page, info, (state) => {
    state.cores.find((core) => core.core === 'sing-box').version = '1.10.7';
    state.nodes[1].address = '203.0.113.21';
    state.exports[1].uri = state.exports[1].uri.replace('203.0.113.20', '203.0.113.21');
  });
  try {
    const form = await openCreator(page, machine);
    await form.getByRole('button', { name: 'Hysteria2', exact: true }).click();
    await expect(form.getByLabel('内核', { exact: true })).toHaveValue('sing-box');
    await expect(form.getByLabel('连接地址来源', { exact: true })).toHaveValue('auto');
    await expect(form.getByLabel('客户端连接地址', { exact: true })).toHaveCount(0);
    await expect(form).toContainText('不代表已确认公网可达');
    await section(form, '性能设置');
    await expect(
      form.getByLabel('混淆方式', { exact: true }).locator('option[value=gecko]'),
    ).toHaveAttribute('disabled', '');
    await expect(
      form.getByLabel('BBR 档位', { exact: true }).locator('option[value=aggressive]'),
    ).toHaveAttribute('disabled', '');
    await expect(form).toContainText(/Gecko.*1\.14\.0/);
    await section(form, '网络设置');
    await expect(
      form.getByLabel('UDP 端口跳跃', { exact: true }).locator('option[value=on]'),
    ).toHaveAttribute('disabled', '');
    await expect(form).toContainText(/端口跳跃.*1\.11\.0/);
    await expect(form.getByLabel('跳跃端口', { exact: true })).toHaveCount(0);
    await drawerLayout(page, form, info, 'hy2-gated-options');
    await create(page, form, machine);
    const command = await pollCommand(page, machine);
    expect(command.params).toEqual({
      profile: 'hysteria2',
      core: 'sing-box',
      name: 'hysteria2-9443',
      port: 9443,
      sni: 'www.amd.com',
      'cert-mode': 'self-signed',
      'up-mbps': 10000,
      'down-mbps': 10000,
      obfs: 'none',
      'bbr-profile': 'default',
      'hop-ports': 'off',
      listen: '::',
      'ip-strategy': 'auto',
      'install-deps': true,
    });
  } finally {
    await retire(page, machine);
  }
});

test('core installation can cancel or queue without losing the draft and requires explicit creation after revision adoption', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(page, info, (state) => {
    state.capabilities.profiles = [
      { id: 'vless-reality-vision', label: 'VLESS REALITY Vision', cores: ['xray'] },
    ];
    Object.assign(
      state.cores.find((core) => core.core === 'xray'),
      {
        installed: false,
        running: false,
        enabled: false,
        version: '',
      },
    );
  });
  try {
    const form = await openCreator(page, machine);
    await form.getByLabel('节点名称', { exact: true }).fill('安装后手动创建');
    await form.getByLabel('监听端口', { exact: true }).fill('14443');
    await expect(form).toContainText('尚未安装');
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: /安装.*内核|安装.*xray/ }).click();
    const install = page.getByRole('dialog', { name: '安装内核', exact: true });
    await expect(install.getByLabel('内核 *', { exact: true })).toHaveValue('xray');
    await expect(install.getByLabel('发布通道', { exact: true })).toHaveValue('stable');
    await install.getByRole('button', { name: '返回添加节点', exact: true }).click();
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('安装后手动创建');
    await expect(form.getByLabel('监听端口', { exact: true })).toHaveValue('14443');
    expect(await tasks(page, machine)).toHaveLength(0);
    await form.getByRole('button', { name: /安装.*内核|安装.*xray/ }).click();
    const response = submission(page, machine);
    await install.getByRole('button', { name: '提交任务', exact: true }).click();
    expect((await response).status()).toBe(201);
    await expect(install).toHaveCount(0);
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('安装后手动创建');
    await expect(form).toContainText(/排队|接收/);
    const command = await pollCommand(page, machine);
    expect(command.action).toBe('core.install');
    expect(command.params).toEqual({
      core: 'xray',
      'release-channel': 'stable',
      'install-deps': true,
    });
    const next = {
      ...machine.snapshot,
      revision: revision(machine.machine.id + '-core-installed'),
      cores: machine.snapshot.cores.map((core) =>
        core.core === 'xray'
          ? {
              ...core,
              installed: true,
              running: true,
              enabled: true,
              version: '26.9.1',
            }
          : core,
      ),
    };
    await result(page, machine, command, 'applied', next);
    await expect(form.getByRole('button', { name: '采用最新版本', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toBeDisabled();
    expect((await tasks(page, machine)).map((task) => task.action)).toEqual(['core.install']);
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('安装后手动创建');
    await form.getByRole('button', { name: '采用最新版本', exact: true }).click();
    await create(page, form, machine);
    const added = await pollCommand(page, machine);
    expect(added.action).toBe('node.add');
    expect(added.expectedRevision).toBe(next.revision);
    expect(added.params).toMatchObject({ name: '安装后手动创建', port: 14443, core: 'xray' });
    expect((await tasks(page, machine)).map((task) => task.action)).toEqual([
      'node.add',
      'core.install',
    ]);
    await noOverflow(page);
  } finally {
    await retire(page, machine);
  }
});

test('node creator preserves a conflicted draft and blocks retry after an ambiguous accepted request', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(page, info);
  const commandPath = '**/api/machines/' + machine.machine.id + '/commands';
  try {
    const form = await openCreator(page, machine);
    await form.getByLabel('节点名称', { exact: true }).fill('保留冲突草稿');
    await form.getByLabel('自动安装必要系统工具', { exact: true }).uncheck();
    await page.route(
      commandPath,
      async (route) => {
        machine.snapshot = {
          ...machine.snapshot,
          revision: revision(machine.machine.id + '-changed'),
        };
        await report(page, machine);
        await route.continue();
      },
      { times: 1 },
    );
    const response = submission(page, machine);
    await form.getByRole('button', { name: '创建节点', exact: true }).click();
    expect((await response).status()).toBe(409);
    await expect(
      form
        .getByRole('alert')
        .filter({ hasText: /版本|冲突/ })
        .first(),
    ).toBeVisible();
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('保留冲突草稿');
    await expect(form.getByLabel('自动安装必要系统工具', { exact: true })).not.toBeChecked();
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toBeDisabled();
    expect(await tasks(page, machine)).toHaveLength(0);
    await form.getByRole('button', { name: '采用最新版本', exact: true }).click();
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('保留冲突草稿');

    // Accept through the real backend, then lose the HTTP success response at the browser edge.
    // A retry could create a second node, so the UI must keep the draft and require task review.
    let accepted;
    await page.route(
      commandPath,
      async (route) => {
        accepted = await route.fetch();
        expect(accepted.status()).toBe(201);
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'PUBLIC_FIXTURE_RESPONSE_LOST',
            message: '任务响应暂时无法确认。',
          }),
        });
      },
      { times: 1 },
    );
    const ambiguous = submission(page, machine);
    await form.getByRole('button', { name: '创建节点', exact: true }).click();
    expect((await ambiguous).status()).toBe(502);
    await expect(form).toContainText(/无法确认|未知|核对/);
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toBeDisabled();
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('保留冲突草稿');
    const queued = await tasks(page, machine);
    expect(queued).toHaveLength(1);
    expect(queued[0].expectedRevision).toBe(machine.snapshot.revision);
    await form.getByRole('button', { name: '查看任务记录', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole('button', { name: '返回添加节点', exact: true }).click();
    await expect(form.getByRole('status', { name: '未确认提交结果', exact: true })).toBeVisible();
    await expect(form.getByLabel('节点名称', { exact: true })).toHaveValue('保留冲突草稿');
    await expect(form.getByLabel('自动安装必要系统工具', { exact: true })).not.toBeChecked();
    await expect(form.getByRole('button', { name: '创建节点', exact: true })).toBeDisabled();
    expect(await tasks(page, machine)).toHaveLength(1);
    const command = await pollCommand(page, machine);
    expect(command.params.name).toBe('保留冲突草稿');
    expect(command.params).not.toHaveProperty('install-deps');
    expect(command.expectedRevision).toBe(machine.snapshot.revision);
  } finally {
    await page.unroute(commandPath);
    await retire(page, machine);
  }
});
