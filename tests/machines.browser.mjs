import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';

// These are Agent protocol fixtures for browser interaction, not VPS execution evidence.
const revision = (value) => createHash('sha256').update(value).digest('hex');
function snapshot(name, suffix = 'initial') {
  const id = 'node-' + randomUUID().replaceAll('-', '').slice(0, 16);
  return {
    schemaVersion: 1,
    revision: revision(name + suffix),
    vpsctlVersion: 'browser-fixture',
    capabilities: {
      actions: [
        'core.install',
        'core.update',
        'core.start',
        'core.stop',
        'core.restart',
        'core.uninstall',
        'node.add',
        'node.edit',
        'node.delete',
        'node.switch',
        'node.ip-policy',
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
        { id: 'ss', label: 'Shadowsocks', cores: ['sing-box', 'xray'] },
        { id: 'sing-only', label: '仅 sing-box', cores: ['sing-box'] },
      ],
    },
    cores: [
      {
        core: 'sing-box',
        installed: true,
        running: true,
        enabled: true,
        pending_restart: false,
        version: '1.browser',
      },
      {
        core: 'xray',
        installed: true,
        running: false,
        enabled: false,
        pending_restart: false,
        version: '26.browser',
      },
    ],
    nodes: [
      {
        id,
        name: name + '节点',
        core: 'sing-box',
        profile: 'ss',
        listen: '0.0.0.0',
        address: '203.0.113.20',
        port: 443,
        credentials: { password: 'DO-NOT-SHOW-BROWSER-SECRET' },
      },
    ],
    relay: { exits: [], bindings: [], forwards: [] },
    exports: [
      {
        id,
        name: name + '节点',
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
    agentVersion: 'browser-fixture',
    bootId: machine.bootId,
    snapshot: machine.snapshot,
  });
}
async function makeMachine(page, name) {
  const value = await api(page, '/api/machines', { name });
  const machine = { ...value, bootId: randomUUID(), snapshot: snapshot(name) };
  await report(page, machine);
  return machine;
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
async function result(page, machine, command, status, message, next = machine.snapshot) {
  machine.snapshot = next;
  await agent(page, machine, 'results', {
    machineId: machine.machine.id,
    result: {
      schemaVersion: 1,
      requestId: command.requestId,
      status,
      message,
      exitCode: status === 'failed' ? 1 : 0,
      revision: next.revision,
      snapshot: next,
    },
  });
}
async function retire(page, machine) {
  await api(page, '/api/machines/' + machine.machine.id, { enabled: false }, 'PATCH');
  const resource = (await api(page, '/api/nodes/resources')).resources.find(
    (item) => item.id === machine.machine.resourceId,
  );
  if (resource) await cleanup(page, { resource });
}

test('machines show one-time installation credentials and operate through typed action forms', async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole('button', { name: '机器', exact: true }).click();
  await page.getByRole('button', { name: '添加机器', exact: true }).click();
  const name = '网页机器-' + info.project.name + '-' + randomUUID().slice(0, 8);
  await page.getByLabel('机器名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建并获取安装命令', exact: true }).click();
  const credentials = page.getByRole('dialog', { name: '机器安装凭据', exact: true });
  const token = await credentials.getByLabel('机器 Token', { exact: true }).inputValue();
  const machine = {
    machine: (await api(page, '/api/machines')).machines.find((item) => item.name === name),
    token,
    bootId: randomUUID(),
    snapshot: snapshot(name),
  };
  try {
    await expect(credentials.getByLabel('Agent 安装命令', { exact: true })).toHaveValue(
      /curl .*\/agent\/install\.sh.*--server 'http:\/\/127\.0\.0\.1:3210'.*--machine-id '[a-f0-9-]+'.*--token '[A-Za-z0-9_-]+'.*--allow-http/,
    );
    await noOverflow(page);
    await credentials.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByLabel('机器 Token', { exact: true })).toHaveCount(0);
    await report(page, machine);
    await page.getByRole('button', { name: '刷新机器', exact: true }).click();
    const detail = page.getByRole('region', { name: '机器详情', exact: true });
    await expect(detail).toContainText('browser-fixture');
    await expect(detail).not.toContainText('DO-NOT-SHOW-BROWSER-SECRET');
    await detail.getByRole('button', { name: '添加机器节点', exact: true }).click();
    const form = page.getByRole('dialog', { name: '添加机器节点', exact: true });
    await expect(form.getByLabel('自动安装所需依赖', { exact: true })).toBeChecked();
    await form.getByLabel('协议配置 *', { exact: true }).selectOption('sing-only');
    await expect(
      form.getByLabel('内核 *', { exact: true }).locator('option[value=xray]'),
    ).toHaveCount(0);
    await form.getByLabel('名称', { exact: true }).fill('由网页创建');
    await form.getByLabel('监听端口', { exact: true }).fill('8443');
    await form.getByLabel('客户端连接地址', { exact: true }).fill('203.0.113.50');
    await form.getByRole('button', { name: '高级选项', exact: true }).click();
    await form.getByLabel('证书模式', { exact: true }).selectOption('managed');
    await form.getByLabel('托管证书 ID', { exact: true }).fill('crt-browser-public');
    await form.getByRole('button', { name: '提交任务', exact: true }).click();
    await expect(form).toHaveCount(0);
    const command = await pollCommand(page, machine);
    expect(command.action).toBe('node.add');
    expect(command.params).toEqual({
      profile: 'sing-only',
      core: 'sing-box',
      name: '由网页创建',
      port: 8443,
      address: '203.0.113.50',
      'cert-mode': 'managed',
      'cert-id': 'crt-browser-public',
      'install-deps': true,
    });
    const next = {
      ...machine.snapshot,
      revision: revision(name + 'pending'),
      pendingCores: ['sing-box'],
      cores: machine.snapshot.cores.map((core) => ({
        ...core,
        pending_restart: core.core === 'sing-box',
      })),
    };
    await result(
      page,
      machine,
      command,
      'pending_restart',
      '浏览器夹具：配置已保存，等待重启',
      next,
    );
    await page.getByRole('button', { name: '刷新机器', exact: true }).click();
    await expect(detail).toContainText('待重启内核：sing-box');
    await expect(detail.locator('.task-row').first()).toContainText('添加机器节点 · 待重启');
    await expect(detail).toContainText('配置已保存，等待对应内核重启后生效。（退出码 0）');
    await expect(detail).not.toContainText('浏览器夹具：配置已保存，等待重启');
    await detail.getByRole('button', { name: '禁用机器', exact: true }).click();
    await expect(detail.getByRole('button', { name: '添加机器节点', exact: true })).toBeDisabled();
    await detail.getByRole('button', { name: '启用机器', exact: true }).click();
    await detail.getByRole('button', { name: '轮换机器 Token', exact: true }).click();
    await expect(credentials.getByLabel('机器 Token', { exact: true })).not.toHaveValue(token);
    await credentials.getByRole('button', { name: '关闭', exact: true }).click();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('machines.png'), fullPage: true });
  } finally {
    await retire(page, machine);
  }
});

test('machine refresh preserves edit inputs and requires resolving a changed snapshot', async ({
  page,
}, info) => {
  await login(page);
  const machine = await makeMachine(
    page,
    '版本机器-' + info.project.name + '-' + randomUUID().slice(0, 8),
  );
  try {
    await page.getByRole('button', { name: '机器', exact: true }).click();
    await page.getByRole('button', { name: '管理 ' + machine.machine.name, exact: true }).click();
    await page
      .getByRole('region', { name: '机器详情', exact: true })
      .getByRole('button', { name: '编辑机器节点', exact: true })
      .first()
      .click();
    const form = page.getByRole('dialog', { name: '编辑机器节点', exact: true });
    const installDeps = form.getByLabel('自动安装所需依赖', { exact: true });
    await expect(installDeps).toBeChecked();
    await installDeps.uncheck();
    await form.getByLabel('名称', { exact: true }).fill('保留正在编辑的名称');
    machine.snapshot = {
      ...machine.snapshot,
      revision: revision(machine.machine.id + 'external-change'),
    };
    await report(page, machine);
    await expect(form.getByRole('alert')).toContainText('机器版本已变化', { timeout: 10000 });
    await expect(form.getByLabel('名称', { exact: true })).toHaveValue('保留正在编辑的名称');
    await expect(installDeps).not.toBeChecked();
    await expect(form.getByRole('button', { name: '提交任务', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: '采用最新版本', exact: true }).click();
    const submission = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/commands'),
    );
    await form.getByRole('button', { name: '提交任务', exact: true }).click();
    expect((await submission).postDataJSON().params).not.toHaveProperty('install-deps');
    const tasks = (await api(page, '/api/machines/' + machine.machine.id)).tasks;
    expect(tasks[0].expectedRevision).toBe(machine.snapshot.revision);
    await page.getByRole('button', { name: '取消排队', exact: true }).click();
    await expect(page.locator('.task-row').first()).toContainText('已取消');
    await noOverflow(page);
  } finally {
    await retire(page, machine);
  }
});

test('relay forms select real machine nodes and show failed deployment, retry and scoped removal', async ({
  page,
}, info) => {
  await login(page);
  const suffix = info.project.name + '-' + randomUUID().slice(0, 8);
  const entry = await makeMachine(page, '入口-' + suffix);
  const target = await makeMachine(page, '目标-' + suffix);
  let route;
  try {
    await page.getByRole('button', { name: '中转线路', exact: true }).click();
    await page.getByRole('button', { name: '添加线路', exact: true }).click();
    const form = page.getByRole('dialog', { name: '添加中转线路', exact: true });
    await expect(form.getByLabel('线路类型', { exact: true })).toHaveValue('tunnel');
    await form.getByLabel('线路名称', { exact: true }).fill('隧道-' + suffix);
    await form.getByLabel('入口机器', { exact: true }).selectOption(entry.machine.id);
    await form.getByLabel('目标机器', { exact: true }).selectOption(target.machine.id);
    await form.getByLabel('目标节点', { exact: true }).selectOption(target.snapshot.nodes[0].id);
    await expect(form.getByLabel('经过机器', { exact: true })).toHaveValue(target.machine.id);
    await expect(
      form
        .getByLabel('经过机器', { exact: true })
        .locator('option[value="' + entry.machine.id + '"]'),
    ).toHaveCount(0);
    await form.getByLabel('入口连接地址', { exact: true }).fill('203.0.113.10');
    await form.getByLabel('这一跳的可达地址', { exact: true }).fill('203.0.113.20');
    await noOverflow(page);
    await form.getByRole('button', { name: '创建并应用线路', exact: true }).click();
    await expect(form).toHaveCount(0);
    route = (await api(page, '/api/relays')).routes.find((item) => item.name === '隧道-' + suffix);
    expect(route.hops).toEqual([
      { machineId: target.machine.id, address: '203.0.113.20', port: 24443 },
    ]);
    const command = await pollCommand(page, target);
    expect(command.action).toBe('tunnel.apply');
    await result(page, target, command, 'failed', '浏览器夹具：隧道端口被占用');
    const row = page.locator('.relay-route').filter({ hasText: '隧道-' + suffix });
    await expect(row).toContainText('机器执行失败，请在机器上检查详情。（退出码 1）', {
      timeout: 15000,
    });
    await expect(row).not.toContainText('浏览器夹具：隧道端口被占用');
    await row.getByRole('button', { name: '重试应用', exact: true }).click();
    await expect(row).toContainText(/等待编排|应用中/);
    await row.getByRole('button', { name: '删除线路', exact: true }).click();
    await page
      .getByRole('dialog', { name: '删除中转线路', exact: true })
      .getByRole('button', { name: '确认删除线路', exact: true })
      .click();
    await expect(row).toContainText('已删除', { timeout: 15000 });
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('relays.png'), fullPage: true });
  } finally {
    if (route) {
      const current = (await api(page, '/api/relays')).routes.find((item) => item.id === route.id);
      if (current && current.status !== 'deleted' && current.status !== 'deleting')
        await api(page, '/api/relays/' + route.id, { revision: current.revision }, 'DELETE');
    }
    await retire(page, entry);
    await retire(page, target);
  }
});
