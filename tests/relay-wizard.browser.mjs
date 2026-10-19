/* global location */
import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function machine(page, name) {
  const created = await api(page, '/api/machines', { name });
  const node = {
    id: 'node-' + randomUUID(),
    name: name + ' SS',
    core: 'sing-box',
    profile: 'shadowsocks-aes-256-gcm',
    address: '203.0.113.20',
    port: 443,
    listen: '::',
  };
  const value = {
    ...created,
    bootId: randomUUID(),
    snapshot: {
      schemaVersion: 1,
      revision: hash(name),
      vpsctlVersion: 'ui-fixture',
      capabilities: {
        actions: [
          'exit.add',
          'exit.edit',
          'exit.delete',
          'forward.add',
          'forward.edit',
          'forward.delete',
          'binding.add',
          'binding.delete',
          'tunnel.apply',
          'tunnel.delete',
        ],
        profiles: [{ id: node.profile, label: 'Shadowsocks', cores: ['sing-box'] }],
      },
      cores: [
        {
          core: 'sing-box',
          installed: true,
          running: true,
          enabled: true,
          pending_restart: false,
          version: 'fixture',
        },
      ],
      nodes: [node],
      relay: { exits: [], bindings: [], forwards: [] },
      pendingCores: [],
      exports: [
        {
          id: node.id,
          name: node.name,
          core: 'sing-box',
          kind: 'node',
          uri:
            'ss://' +
            Buffer.from('aes-256-gcm:ui-test-only').toString('base64') +
            '@203.0.113.20:443#' +
            encodeURIComponent(node.name),
        },
      ],
    },
  };
  await agent(page, value, 'report', {
    machineId: value.machine.id,
    agentVersion: 'ui-fixture',
    bootId: value.bootId,
    snapshot: value.snapshot,
  });
  return value;
}
async function agent(page, machine, path, data) {
  const response = await page.request.fetch('/api/agent/' + path, {
    method: data ? 'POST' : 'GET',
    data,
    headers: { Authorization: 'Bearer ' + machine.token, 'Content-Type': 'application/json' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function choose(page, label, name) {
  const control = page.getByRole('combobox', { name: label, exact: true });
  await control.fill(name);
  await page.getByRole('option', { name: new RegExp(name) }).click();
}
async function settle(page, entry, routeId, expected = 'active') {
  for (let attempt = 0; attempt < 12; attempt++) {
    const route = (await api(page, '/api/relays')).routes.find((item) => item.id === routeId);
    if (route.status === expected) return route;
    expect(route.status, route.message).not.toBe('failed');
    const { command } = await agent(
      page,
      entry,
      'commands?machineId=' + entry.machine.id + '&wait=5',
    );
    if (!command) continue;
    const p = command.params,
      state = entry.snapshot;
    if (command.action === 'exit.add')
      state.relay.exits.push({
        id: 'exit-' + randomUUID(),
        name: p.name,
        core: p.core,
        uri: p.uri,
      });
    else if (command.action === 'exit.edit')
      Object.assign(
        state.relay.exits.find((item) => item.id === p.id),
        { name: p.name, uri: p.uri },
      );
    else if (command.action === 'forward.add')
      state.relay.forwards.push({
        id: 'forward-' + randomUUID(),
        name: p.name,
        exit_id: p['exit-id'],
        listen_ports: p['listen-ports'],
      });
    else if (command.action === 'forward.edit')
      Object.assign(
        state.relay.forwards.find((item) => item.id === p.id),
        { name: p.name, listen_ports: p['listen-ports'] },
      );
    else if (command.action === 'forward.delete')
      state.relay.forwards = state.relay.forwards.filter((item) => item.id !== p.id);
    else if (command.action === 'exit.delete')
      state.relay.exits = state.relay.exits.filter((item) => item.id !== p.id);
    else throw new Error('Unexpected UI fixture command ' + command.action);
    state.revision = hash(command.requestId);
    await agent(page, entry, 'results', {
      machineId: entry.machine.id,
      result: {
        schemaVersion: 1,
        requestId: command.requestId,
        status: 'applied',
        exitCode: 0,
        message: '',
        revision: state.revision,
        snapshot: state,
      },
    });
  }
  throw new Error('Route did not settle');
}
async function retire(page, item) {
  await api(page, '/api/machines/' + item.machine.id, { enabled: false }, 'PATCH');
  const resource = (await api(page, '/api/nodes/resources')).resources.find(
    (resource) => resource.id === item.machine.resourceId,
  );
  if (resource) await cleanup(page, { resource });
}

test('relay wizard creates and edits the same route with an explicit diff and real command receipts', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await login(page);
  const suffix = info.project.name + '-' + randomUUID().slice(0, 6),
    entry = await machine(page, '香港-' + suffix),
    target = await machine(page, '美国-' + suffix);
  let id;
  try {
    await page.getByRole('button', { name: '中转线路', exact: true }).click();
    await page.getByRole('button', { name: '添加线路', exact: true }).click();
    await page.getByLabel('线路名称', { exact: true }).fill('转发-' + suffix);
    await choose(page, '入口机器', entry.machine.name);
    await choose(page, '落地机器', target.machine.name);
    await expect(page.getByRole('combobox', { name: '落地节点', exact: true })).toHaveValue(
      target.snapshot.nodes[0].name,
    );
    await page.getByRole('button', { name: '选择连接方式', exact: true }).click();
    await page.getByRole('button', { name: /端口转发.*透传已有代理端口/ }).click();
    await page.getByLabel('入口端口', { exact: true }).fill('23456');
    await expect(page.getByRole('complementary', { name: '路径预览' })).toContainText(
      entry.machine.name,
    );
    await expect(page.getByRole('complementary', { name: '路径预览' })).toContainText(
      target.machine.name,
    );
    await page.getByRole('button', { name: '核对配置', exact: true }).click();
    await page.getByRole('button', { name: '创建并应用线路', exact: true }).click();
    await expect(page.getByRole('heading', { name: '转发-' + suffix, exact: true })).toBeVisible();
    id = (await api(page, '/api/relays')).routes.find(
      (route) => route.name === '转发-' + suffix,
    ).id;
    await settle(page, entry, id);
    await expect(page.getByRole('button', { name: '编辑配置', exact: true })).toBeEnabled({
      timeout: 10000,
    });
    const exitId = entry.snapshot.relay.exits[0].id,
      forwardId = entry.snapshot.relay.forwards[0].id;
    await page.getByRole('button', { name: '编辑配置', exact: true }).click();
    await expect(page.getByLabel('线路名称', { exact: true })).toHaveValue('转发-' + suffix);
    await page.getByRole('button', { name: '选择连接方式', exact: true }).click();
    await expect(page.getByLabel('入口端口', { exact: true })).toHaveValue('23456');
    await page.getByLabel('入口端口', { exact: true }).fill('23457');
    await page.getByRole('button', { name: '核对配置', exact: true }).click();
    await expect(page.locator('.change-list')).toContainText('1 项修改');
    await expect(page.locator('.change-list')).toContainText('23456 → 23457');
    const sent = page.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().endsWith('/api/relays/' + id),
    );
    const acknowledged = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().endsWith('/api/relays/' + id),
    );
    await page.getByRole('button', { name: '保存并应用修改', exact: true }).click();
    expect((await sent).postDataJSON().listenPort).toBe(23457);
    expect((await acknowledged).ok()).toBe(true);
    await settle(page, entry, id);
    expect(entry.snapshot.relay.exits.map((item) => item.id)).toEqual([exitId]);
    expect(entry.snapshot.relay.forwards.map((item) => item.id)).toEqual([forwardId]);
    const current = (await api(page, '/api/relays')).routes.filter((route) => route.id === id);
    expect(current).toHaveLength(1);
    expect(current[0].listenPort).toBe(23457);
    await expect(page.locator('.route-overview')).toContainText('已应用', { timeout: 10000 });
    await noOverflow(page);
  } finally {
    if (id) {
      let route = (await api(page, '/api/relays')).routes.find((item) => item.id === id);
      if (['pending', 'applying'].includes(route.status)) route = await settle(page, entry, id);
      if (route.status !== 'deleted') {
        await api(page, '/api/relays/' + id, { revision: route.revision }, 'DELETE');
        await settle(page, entry, id, 'deleted');
      }
    }
    await retire(page, entry);
    await retire(page, target);
  }
});

test('tunnel wizard restores a draft and previews a contextual three-machine path', async ({
  page,
}, info) => {
  await login(page);
  const suffix = info.project.name + '-' + randomUUID().slice(0, 6),
    entry = await machine(page, '香港-' + suffix),
    hop = await machine(page, '东京-' + suffix),
    target = await machine(page, '美国-' + suffix);
  try {
    await page.evaluate(
      (value) => {
        location.hash = value;
      },
      '/relays?create=1&targetMachine=' +
        target.machine.id +
        '&targetNode=' +
        target.snapshot.nodes[0].id,
    );
    await expect(page.getByRole('combobox', { name: '落地节点', exact: true })).toHaveValue(
      target.snapshot.nodes[0].name,
    );
    await page.getByLabel('线路名称', { exact: true }).fill('香港 → 东京 → 美国');
    await choose(page, '入口机器', entry.machine.name);
    await page.getByRole('button', { name: '选择连接方式', exact: true }).click();
    await page.getByRole('button', { name: '＋ 添加中间节点', exact: true }).click();
    await choose(page, '第 1 跳机器', hop.machine.name);
    await page.getByLabel('入口连接地址', { exact: true }).fill('hk.example.net');
    await noOverflow(page);
    await page.locator('.content').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath('relay-wizard.png'), fullPage: true });
    await page.getByRole('button', { name: '暂存并返回', exact: true }).click();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(page.getByLabel('入口连接地址', { exact: true })).toHaveValue('hk.example.net');
    await expect(page.getByRole('combobox', { name: '第 1 跳机器', exact: true })).toHaveValue(
      hop.machine.name,
    );
    await page.getByRole('button', { name: '核对配置', exact: true }).click();
    await expect(page.locator('.review-fields')).toContainText(
      entry.machine.name + ' → ' + hop.machine.name + ' → ' + target.machine.name,
    );
    await page.getByRole('button', { name: '暂存并返回', exact: true }).click();
    if (info.project.name === 'narrow') {
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await expect(page.getByLabel('更多页面')).toBeVisible();
      await page
        .getByLabel('更多页面')
        .getByRole('button', { name: '输出方案', exact: true })
        .click();
      await expect(page.getByRole('heading', { name: '输出方案', exact: true })).toBeVisible();
    }
  } finally {
    for (const item of [entry, hop, target]) await retire(page, item);
  }
});
