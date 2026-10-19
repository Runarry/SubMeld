import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, subject } from './upstream-fixture.mjs';
import { RelayStore, relayEndpoint } from '../dist/server/relays.js';
import { createApp } from '../dist/server/app.js';

const digest = (text) => createHash('sha256').update(text).digest('hex');
function snapshot(seed, nodes = []) {
  return {
    schemaVersion: 1,
    revision: digest(seed),
    vpsctlVersion: 'test',
    capabilities: {
      profiles: [{ id: 'shadowsocks-aes-256-gcm', label: 'SS', cores: ['sing-box'] }],
      actions: [
        'exit.add',
        'exit.edit',
        'exit.delete',
        'forward.add',
        'forward.edit',
        'forward.delete',
        'binding.add',
        'binding.delete',
        'node.delete',
        'tunnel.apply',
        'tunnel.delete',
      ],
    },
    cores: [
      {
        core: 'sing-box',
        installed: true,
        running: true,
        enabled: true,
        pending_restart: false,
        version: 'test',
      },
    ],
    nodes,
    relay: { exits: [], bindings: [], forwards: [] },
    pendingCores: [],
    exports: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      core: node.core,
      kind: 'node',
      uri:
        'ss://' +
        Buffer.from('aes-256-gcm:public-test-password').toString('base64') +
        '@' +
        node.address +
        ':' +
        node.port +
        '#' +
        node.name,
    })),
  };
}
async function createMachine(f, name, value) {
  const created = f.machines.create({ name });
  const machine = { ...created, snapshot: value, bootId: randomUUID() };
  await report(f, machine);
  return machine;
}
async function report(f, m) {
  return f.machines.report(
    {
      machineId: m.machine.id,
      agentVersion: 'fixture',
      bootId: m.bootId,
      snapshot: m.snapshot,
      tunnels: [],
    },
    'Bearer ' + m.token,
  );
}
async function complete(f, m, action, mutate) {
  const { command } = await f.machines.poll(m.machine.id, 'Bearer ' + m.token, 0);
  assert.equal(command.action, action);
  const value = structuredClone(m.snapshot);
  if (mutate) {
    mutate(value, command.params);
    value.revision = digest(command.requestId);
  }
  await f.machines.result(
    {
      machineId: m.machine.id,
      result: {
        schemaVersion: 1,
        requestId: command.requestId,
        status: 'applied',
        exitCode: 0,
        message: '',
        revision: value.revision,
        snapshot: value,
      },
    },
    'Bearer ' + m.token,
  );
  m.snapshot = value;
  return command;
}
async function setup(t) {
  const f = await fixture(t),
    routes = new RelayStore(f.machines, f.resources);
  t.after(() => routes.close());
  const entry = await createMachine(f, 'entry', snapshot('entry'));
  const target = await createMachine(
    f,
    'target',
    snapshot('target', [
      {
        id: 'node-target',
        core: 'sing-box',
        profile: 'shadowsocks-aes-256-gcm',
        name: 'target',
        address: 'example.com',
        port: 443,
      },
    ]),
  );
  return {
    ...f,
    routes,
    entry,
    target,
    input: {
      name: 'test route',
      kind: 'forward',
      entryMachineId: entry.machine.id,
      targetMachineId: target.machine.id,
      targetNodeId: 'node-target',
      listenPort: 23456,
      address: 'entry.example.com',
      network: 'both',
      family: 'dual',
      hops: [],
    },
  };
}

async function deployForward(f) {
  const { route } = await f.routes.create(f.input);
  await f.routes.tick();
  await complete(f, f.entry, 'exit.add', (s, p) =>
    s.relay.exits.push({ id: 'exit-route', name: p.name, core: p.core }),
  );
  await f.routes.tick();
  await complete(f, f.entry, 'forward.add', (s, p) =>
    s.relay.forwards.push({ id: 'forward-route', name: p.name, exit_id: p['exit-id'] }),
  );
  await f.routes.tick();
  assert.equal((await f.routes.list()).routes[0].status, 'active');
  return route;
}

async function currentRoute(f, id) {
  return (await f.routes.list()).routes.find((route) => !id || route.id === id);
}
function savedRoute(f, id) {
  return JSON.parse(f.resources.record(id).record.content);
}
async function failCommand(f, machine, status = 'failed') {
  const { command } = await f.machines.poll(machine.machine.id, 'Bearer ' + machine.token, 0);
  assert.ok(command);
  await f.machines.result(
    {
      machineId: machine.machine.id,
      result: {
        schemaVersion: 1,
        requestId: command.requestId,
        status,
        exitCode: 1,
        message: '',
        revision: machine.snapshot.revision,
        snapshot: machine.snapshot,
      },
    },
    'Bearer ' + machine.token,
  );
  return command;
}

test('relay endpoint preserves identity and TLS fields while replacing the public endpoint', () => {
  const uri =
    'hysteria2://test-password@original.example:443?sni=identity.example&pinSHA256=' +
    'a'.repeat(64) +
    '&mport=443%2C8000-9000&obfs=salamander&obfs-password=test-obfs#node';
  const result = new URL(relayEndpoint(uri, '2001:db8::1', 23456, 'relay'));
  assert.equal(result.hostname, '[2001:db8::1]');
  assert.equal(result.port, '23456');
  assert.equal(result.password || result.username, 'test-password');
  assert.equal(result.searchParams.get('sni'), 'identity.example');
  assert.equal(result.searchParams.get('pinSHA256'), 'a'.repeat(64));
  assert.equal(result.searchParams.get('obfs-password'), 'test-obfs');
  assert.equal(result.searchParams.has('mport'), false);
});

test('forward deployment confirms each step, protects targets and deletes only owned resources', async (t) => {
  const f = await setup(t);
  const { route } = await f.routes.create(f.input);
  await assert.rejects(
    f.machines.enqueue(f.target.machine.id, {
      action: 'node.delete',
      params: { id: 'node-target' },
      expectedRevision: f.target.snapshot.revision,
    }),
    { code: 'RELAY_REFERENCED' },
  );
  await f.routes.tick();
  assert.equal((await f.routes.list()).routes[0].status, 'applying');
  await f.routes.tick();
  assert.equal((await f.routes.list()).routes[0].taskIds.length, 1);
  await complete(f, f.entry, 'exit.add', (s, p) =>
    s.relay.exits.push({ id: 'exit-route', name: p.name, core: p.core }),
  );
  await f.routes.tick();
  await complete(f, f.entry, 'forward.add', (s, p) =>
    s.relay.forwards.push({ id: 'forward-route', name: p.name, exit_id: p['exit-id'] }),
  );
  await f.routes.tick();
  let current = (await f.routes.list()).routes[0];
  assert.equal(current.status, 'active');
  assert.equal(current.health, 'online');
  f.target.snapshot.cores[0].running = false;
  await report(f, f.target);
  assert.equal((await f.routes.list()).routes[0].health, 'degraded');
  f.target.snapshot.cores[0].running = true;
  await report(f, f.target);
  await assert.rejects(
    f.machines.enqueue(f.entry.machine.id, {
      action: 'forward.delete',
      params: { id: 'forward-route' },
      expectedRevision: f.entry.snapshot.revision,
    }),
    { code: 'RELAY_REFERENCED' },
  );
  await f.routes.remove(route.id, current.revision);
  await f.routes.tick();
  await complete(f, f.entry, 'forward.delete', (s) => {
    s.relay.forwards = [];
  });
  await f.routes.tick();
  await complete(f, f.entry, 'exit.delete', (s) => {
    s.relay.exits = [];
  });
  await f.routes.tick();
  current = (await f.routes.list()).routes[0];
  assert.equal(current.status, 'deleted');
  assert.equal(f.entry.snapshot.nodes.length, 0);
});

test('a changed target invalidates the route without silently applying an obsolete endpoint', async (t) => {
  const f = await setup(t);
  await f.routes.create(f.input);
  f.target.snapshot.revision = digest('changed target');
  f.target.snapshot.nodes[0].port = 8443;
  await report(f, f.target);
  await f.routes.tick();
  assert.equal((await f.routes.list()).routes[0].status, 'failed');
  assert.equal(f.machines.activeTask(f.entry.machine.id), null);
});

test('locally renamed route resources are reused and deleted by ID while namesakes survive', async (t) => {
  const f = await setup(t);
  const route = await deployForward(f);
  f.entry.snapshot.relay.exits[0].name = 'locally-renamed-exit';
  f.entry.snapshot.relay.forwards[0].name = 'locally-renamed-forward';
  f.entry.snapshot.revision = digest('local resource rename');
  await report(f, f.entry);
  let current = (await f.routes.list()).routes[0];
  await f.routes.apply(route.id, current.revision);
  await f.routes.tick();
  await complete(f, f.entry, 'exit.edit', (s, p) => {
    assert.equal(p.id, 'exit-route');
    s.relay.exits.find((exit) => exit.id === p.id).name = p.name;
  });
  await f.routes.tick();
  await complete(f, f.entry, 'forward.edit', (s, p) => {
    assert.equal(p.id, 'forward-route');
    assert.equal(p['exit-id'], 'exit-route');
    s.relay.forwards.find((forward) => forward.id === p.id).name = p.name;
  });
  await f.routes.tick();
  assert.equal(f.entry.snapshot.relay.exits.length, 1);
  assert.equal(f.entry.snapshot.relay.forwards.length, 1);

  f.entry.snapshot.relay.exits[0].name = 'renamed-again-exit';
  f.entry.snapshot.relay.forwards[0].name = 'renamed-again-forward';
  const unrelatedExit = { id: 'unrelated-exit', name: 'sm-route-' + route.id, core: 'sing-box' };
  const unrelatedForward = {
    id: 'unrelated-forward',
    name: 'sm-route-' + route.id,
    exit_id: unrelatedExit.id,
  };
  f.entry.snapshot.relay.exits.push(unrelatedExit);
  f.entry.snapshot.relay.forwards.push(unrelatedForward);
  f.entry.snapshot.revision = digest('local names reused');
  await report(f, f.entry);
  current = (await f.routes.list()).routes[0];
  await f.routes.remove(route.id, current.revision);
  await f.routes.tick();
  await complete(f, f.entry, 'forward.delete', (s, p) => {
    assert.equal(p.id, 'forward-route');
    s.relay.forwards = s.relay.forwards.filter((forward) => forward.id !== p.id);
  });
  await f.routes.tick();
  await complete(f, f.entry, 'exit.delete', (s, p) => {
    assert.equal(p.id, 'exit-route');
    s.relay.exits = s.relay.exits.filter((exit) => exit.id !== p.id);
  });
  await f.routes.tick();
  assert.equal((await f.routes.list()).routes[0].status, 'deleted');
  assert.deepEqual(f.entry.snapshot.relay.exits, [unrelatedExit]);
  assert.deepEqual(f.entry.snapshot.relay.forwards, [unrelatedForward]);
});

test('deleting a route never adopts namesakes after its recorded native IDs disappear', async (t) => {
  const f = await setup(t);
  const route = await deployForward(f);
  f.entry.snapshot.relay.exits[0].id = 'unrelated-exit';
  f.entry.snapshot.relay.forwards[0].id = 'unrelated-forward';
  f.entry.snapshot.relay.forwards[0].exit_id = 'unrelated-exit';
  f.entry.snapshot.revision = digest('owned resources replaced locally');
  await report(f, f.entry);
  const current = (await f.routes.list()).routes[0];
  await f.routes.remove(route.id, current.revision);
  await f.routes.tick();
  assert.equal(f.machines.activeTask(f.entry.machine.id), null);
  assert.equal((await f.routes.list()).routes[0].status, 'deleted');
  assert.equal(f.entry.snapshot.relay.exits[0].id, 'unrelated-exit');
  assert.equal(f.entry.snapshot.relay.forwards[0].id, 'unrelated-forward');
});

test('a changed tunnel target invalidates its published test result and rejects late results', async (t) => {
  const f = await setup(t);
  const { route } = await f.routes.create({
    ...f.input,
    kind: 'tunnel',
    hops: [{ machineId: f.target.machine.id, address: 'target.example.com', port: 23457 }],
  });
  await f.routes.tick();
  await complete(f, f.target, 'tunnel.apply');
  await f.routes.tick();
  await complete(f, f.entry, 'tunnel.apply');
  await f.routes.tick();
  assert.equal((await f.routes.list()).routes[0].status, 'active');
  const { sourceId } = JSON.parse(f.resources.record(route.id).record.content);
  const original = f.resources.record(sourceId).record;
  const process = [{ type: 'Regex Filter', args: { regex: ['.'], keep: true } }];
  await f.client.api(
    '/api/sub/' + encodeURIComponent(original.name),
    { name: 'renamed-tunnel-source', process },
    'PATCH',
  );
  await f.resources.sync();
  await f.resources.prepare([sourceId]);
  const oldSubject = subject(f.resources.cached(sourceId).rows[0].view);
  const result = {
    subject: oldSubject,
    name: route.name,
    core: 'mihomo',
    coreVersion: 'fixture',
    url: f.nodeTests.settings().url,
    testedAt: new Date().toISOString(),
    status: 'passed',
    latencyMs: 12,
    httpStatus: 204,
    message: '',
    stale: false,
  };
  const versions = new Map([['mihomo', 'fixture']]);
  assert.equal(f.nodeTests.save(result), true);
  assert.equal(f.nodeTests.fresh(result, versions).stale, false);

  f.target.snapshot.nodes[0].port = 8443;
  f.target.snapshot.exports[0].uri = f.target.snapshot.exports[0].uri.replace(':443#', ':8443#');
  f.target.snapshot.revision = digest('changed tunnel target');
  await report(f, f.target);
  await f.routes.tick();
  assert.equal((await f.routes.list()).routes[0].status, 'stale');
  await f.nodeTests.refresh([oldSubject]);
  assert.equal(f.nodeTests.matches(oldSubject), false);
  assert.equal(f.nodeTests.results([oldSubject], versions).results[0].stale, true);
  assert.equal(f.nodeTests.save({ ...result, latencyMs: 99 }), false);
  const source = f.resources.record(sourceId).record;
  assert.equal(source.name, 'renamed-tunnel-source');
  assert.equal(source.content, original.content);
  assert.deepEqual(source.process, process);
});

test('a terminal unknown receipt can be reconciled without leaving a route permanently busy', async (t) => {
  const f = await setup(t);
  await f.routes.create(f.input);
  await f.routes.tick();
  const { command } = await f.machines.poll(f.entry.machine.id, 'Bearer ' + f.entry.token, 0);
  f.entry.snapshot.relay.exits.push({
    id: 'exit-unknown',
    name: command.params.name,
    core: 'sing-box',
  });
  f.entry.snapshot.revision = digest('unknown after mutation');
  await f.machines.result(
    {
      machineId: f.entry.machine.id,
      result: {
        schemaVersion: 1,
        requestId: command.requestId,
        status: 'unknown',
        exitCode: 30,
        message: '',
        revision: f.entry.snapshot.revision,
        snapshot: f.entry.snapshot,
      },
    },
    'Bearer ' + f.entry.token,
  );
  await f.routes.tick();
  const current = (await f.routes.list()).routes[0];
  assert.equal(current.status, 'failed');
  await f.routes.apply(current.id, current.revision);
  await f.routes.tick();
  const retry = await f.machines.poll(f.entry.machine.id, 'Bearer ' + f.entry.token, 0);
  assert.equal(retry.command.action, 'exit.edit');
  assert.equal(retry.command.params.id, 'exit-unknown');
});

test('a tunnel endpoint referenced by a client chain cannot be removed', async (t) => {
  const f = await setup(t);
  const { route } = await f.routes.create({
    ...f.input,
    kind: 'tunnel',
    hops: [{ machineId: f.target.machine.id, address: 'target.example.com', port: 23457 }],
  });
  await f.resources.sync();
  const definition = f.resources.record(route.id);
  const saved = JSON.parse(definition.record.content);
  await f.client.api('/api/subs', {
    name: 'test-tunnel-source',
    displayName: 'tunnel',
    source: 'local',
    content: relayEndpoint(f.target.snapshot.exports[0].uri, 'entry.example.com', 23456, 'tunnel'),
    process: [],
    _submeld: { id: saved.sourceId, role: 'relay-source', version: 1 },
  });
  await f.resources.sync();
  await f.chains.create({
    name: 'uses-tunnel',
    entry: { resourceId: saved.sourceId, nodeName: 'tunnel' },
    exit: { resourceId: f.target.machine.resourceId, nodeName: 'target' },
  });
  await assert.rejects(f.routes.remove(route.id, route.revision), { code: 'NODE_IN_USE' });
  assert.equal(f.machines.activeTask(f.entry.machine.id), null);
  assert.equal((await f.routes.list()).routes[0].status, 'pending');
});

test('PATCH edits a forward in place with CAS, stable IDs, native renames and old/new target protection', async (t) => {
  const f = await setup(t);
  const route = await deployForward(f),
    before = savedRoute(f, route.id);
  const replacement = await createMachine(
    f,
    'replacement',
    snapshot('replacement', [
      {
        id: 'node-replacement',
        name: 'replacement',
        core: 'sing-box',
        profile: 'shadowsocks-aes-256-gcm',
        address: 'replacement.example.com',
        port: 8443,
      },
    ]),
  );
  f.entry.snapshot.relay.exits[0].name = 'user exit';
  f.entry.snapshot.relay.forwards[0].name = 'user forward';
  f.entry.snapshot.revision = digest('user native names');
  await report(f, f.entry);
  const current = await currentRoute(f);
  const value = {
    ...f.input,
    name: 'edited route',
    targetMachineId: replacement.machine.id,
    targetNodeId: 'node-replacement',
    listenPort: 24456,
    address: 'new-entry.example.com',
    network: 'tcp',
    family: 'ipv4',
  };
  await assert.rejects(f.routes.update(route.id, { ...value, revision: route.revision }), {
    code: 'REVISION_CONFLICT',
  });
  const app = createApp({ ...f, relays: f.routes });
  const request = (body) =>
    app.request('/api/relays/' + route.id, {
      method: 'PATCH',
      headers: {
        Cookie: f.cookie,
        Origin: f.config.publicOrigin,
        'X-SubMeld-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await request({
        ...value,
        revision: current.revision,
        outputResourceId: f.entry.machine.resourceId,
      })
    ).status,
    400,
  );
  const response = await request({ ...value, revision: current.revision });
  assert.equal(response.status, 200);
  const updated = (await response.json()).route;
  assert.equal(updated.id, route.id);
  assert.equal(updated.status, 'pending');
  assert.equal(savedRoute(f, route.id).sourceId, before.sourceId);
  assert.equal(f.resources.files('relay-route').length, 1);
  assert.equal((await currentRoute(f)).outputResourceId, f.entry.machine.resourceId);
  for (const machine of [f.target, replacement])
    await assert.rejects(
      f.machines.enqueue(machine.machine.id, {
        action: 'node.delete',
        params: { id: machine.snapshot.nodes[0].id },
        expectedRevision: machine.snapshot.revision,
      }),
      { code: 'RELAY_REFERENCED' },
    );
  await f.routes.tick();
  await complete(f, f.entry, 'exit.edit', (s, p) => {
    assert.equal(p.id, 'exit-route');
    assert.equal(p.name, 'user exit');
    assert.equal(p.uri, replacement.snapshot.exports[0].uri);
    Object.assign(s.relay.exits[0], { name: p.name, uri: p.uri, core: p.core });
  });
  await f.routes.tick();
  await complete(f, f.entry, 'forward.edit', (s, p) => {
    assert.equal(p.id, 'forward-route');
    assert.equal(p.name, 'user forward');
    assert.equal(p['listen-ports'], '24456');
    assert.equal(p.address, value.address);
    assert.equal(p.network, 'tcp');
    assert.equal(p.family, 'ipv4');
    Object.assign(s.relay.forwards[0], {
      listen_port_start: 24456,
      listen_port_end: 24456,
      name: p.name,
    });
  });
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'active');
  assert.equal(savedRoute(f, route.id).migration, undefined);
  assert.equal(f.entry.snapshot.relay.exits.length, 1);
  assert.equal(f.entry.snapshot.relay.forwards.length, 1);
  assert.equal(savedRoute(f, route.id).sourceId, before.sourceId);
  const oldTarget = await f.machines.enqueue(f.target.machine.id, {
    action: 'node.delete',
    params: { id: 'node-target' },
    expectedRevision: f.target.snapshot.revision,
  });
  await f.machines.cancel(f.target.machine.id, oldTarget.task.id);
});

test('busy edits fail and a failed update resumes its confirmed step after restarting the route store', async (t) => {
  const f = await setup(t);
  const { route } = await f.routes.create(f.input);
  await assert.rejects(
    f.routes.update(route.id, { ...f.input, name: 'too early', revision: route.revision }),
    { code: 'MACHINE_BUSY' },
  );
  await f.routes.tick();
  await complete(f, f.entry, 'exit.add', (s, p) =>
    s.relay.exits.push({ id: 'exit-route', name: p.name, core: p.core }),
  );
  await f.routes.tick();
  await complete(f, f.entry, 'forward.add', (s, p) =>
    s.relay.forwards.push({ id: 'forward-route', name: p.name, exit_id: p['exit-id'] }),
  );
  await f.routes.tick();
  await f.routes.update(route.id, {
    ...f.input,
    listenPort: 24456,
    revision: (await currentRoute(f)).revision,
  });
  await f.routes.tick();
  await complete(f, f.entry, 'exit.edit', (s, p) => {
    s.relay.exits[0].uri = p.uri;
  });
  await f.routes.tick();
  const failed = await failCommand(f, f.entry);
  assert.equal(failed.action, 'forward.edit');
  await f.routes.tick();
  const stopped = await currentRoute(f);
  assert.equal(stopped.status, 'failed');
  assert.equal(savedRoute(f, route.id).stage, 1);
  await f.routes.close();
  f.routes = new RelayStore(f.machines, f.resources);
  f.beforeClose(() => f.routes.close());
  await f.routes.apply(route.id, stopped.revision);
  await f.routes.tick();
  const retried = await complete(f, f.entry, 'forward.edit', (s, p) => {
    assert.equal(p.id, 'forward-route');
    s.relay.forwards[0].listen_port_start = 24456;
  });
  assert.notEqual(retried.requestId, failed.requestId);
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'active');
  assert.equal(f.resources.files('relay-route').length, 1);
  assert.equal(f.entry.snapshot.relay.forwards.length, 1);
});

test('type and entry migration removes the old binding and resumes failed cleanup before creating the replacement', async (t) => {
  const f = await setup(t);
  f.entry.snapshot = snapshot('protocol entry', [
    {
      id: 'entry-node',
      name: 'entry-node',
      core: 'sing-box',
      profile: 'shadowsocks-aes-256-gcm',
      address: 'protocol.example.com',
      port: 3443,
    },
  ]);
  await report(f, f.entry);
  const { route } = await f.routes.create({
    ...f.input,
    kind: 'protocol',
    entryNodeId: 'entry-node',
  });
  await f.routes.tick();
  await complete(f, f.entry, 'exit.add', (s, p) =>
    s.relay.exits.push({ id: 'old-exit', name: p.name, core: p.core }),
  );
  await f.routes.tick();
  await complete(f, f.entry, 'binding.add', (s, p) =>
    s.relay.bindings.push({ id: 'old-binding', node_id: p['node-id'], exit_id: p['exit-id'] }),
  );
  await f.routes.tick();
  const newEntry = await createMachine(f, 'new entry', snapshot('new entry'));
  const sourceId = savedRoute(f, route.id).sourceId;
  await f.routes.update(route.id, {
    ...f.input,
    entryMachineId: newEntry.machine.id,
    revision: (await currentRoute(f)).revision,
  });
  await assert.rejects(
    f.machines.enqueue(f.entry.machine.id, {
      action: 'node.delete',
      params: { id: 'entry-node' },
      expectedRevision: f.entry.snapshot.revision,
    }),
    { code: 'RELAY_REFERENCED' },
  );
  await f.routes.tick();
  await complete(f, f.entry, 'binding.delete', (s, p) => {
    assert.equal(p.id, 'old-binding');
    s.relay.bindings = [];
  });
  await f.routes.tick();
  assert.equal((await failCommand(f, f.entry)).action, 'exit.delete');
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'failed');
  assert.equal(f.machines.activeTask(newEntry.machine.id), null);
  await f.routes.apply(route.id, (await currentRoute(f)).revision);
  await f.routes.tick();
  await complete(f, f.entry, 'exit.delete', (s, p) => {
    assert.equal(p.id, 'old-exit');
    s.relay.exits = [];
  });
  await f.routes.tick();
  await complete(f, newEntry, 'exit.add', (s, p) =>
    s.relay.exits.push({ id: 'new-exit', name: p.name, core: p.core }),
  );
  await f.routes.tick();
  await complete(f, newEntry, 'forward.add', (s, p) =>
    s.relay.forwards.push({ id: 'new-forward', name: p.name, exit_id: p['exit-id'] }),
  );
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'active');
  assert.deepEqual(f.entry.snapshot.relay, { exits: [], bindings: [], forwards: [] });
  assert.equal(savedRoute(f, route.id).sourceId, sourceId);
  assert.equal(f.resources.files('relay-route').length, 1);
});

test('forward edits cannot remove client-chain names when changing ports or moving the entry', async (t) => {
  const f = await setup(t),
    route = await deployForward(f);
  const name = 'native forward:23456';
  f.entry.snapshot.relay.forwards[0].name = 'native forward';
  f.entry.snapshot.exports = [
    {
      id: 'forward-route:23456',
      name,
      core: 'sing-box',
      kind: 'forward',
      uri: relayEndpoint(
        f.target.snapshot.exports[0].uri,
        f.input.address,
        f.input.listenPort,
        name,
      ),
    },
  ];
  f.entry.snapshot.revision = digest('published forward');
  await report(f, f.entry);
  await f.chains.create({
    name: 'forward consumer',
    entry: { resourceId: f.entry.machine.resourceId, nodeName: name },
    exit: { resourceId: f.target.machine.resourceId, nodeName: 'target' },
  });
  const revision = (await currentRoute(f)).revision;
  await assert.rejects(f.routes.update(route.id, { ...f.input, listenPort: 24456, revision }), {
    code: 'NODE_IN_USE',
  });
  const newEntry = await createMachine(f, 'new entry', snapshot('unbound machine'));
  await assert.rejects(
    f.routes.update(route.id, { ...f.input, entryMachineId: newEntry.machine.id, revision }),
    { code: 'NODE_IN_USE' },
  );
  assert.equal((await currentRoute(f)).status, 'active');
  assert.equal(f.machines.activeTask(f.entry.machine.id), null);
});

test('tunnel updates retain the source, published name and rules while retiring removed hops after entry cutover', async (t) => {
  const f = await setup(t);
  const middle = await createMachine(f, 'middle', snapshot('middle'));
  const input = {
    ...f.input,
    kind: 'tunnel',
    hops: [
      { machineId: middle.machine.id, address: 'middle.example.com', port: 23457 },
      { machineId: f.target.machine.id, address: 'target.example.com', port: 23458 },
    ],
  };
  const { route } = await f.routes.create(input);
  await f.routes.tick();
  await complete(f, middle, 'tunnel.apply');
  await f.routes.tick();
  await complete(f, f.target, 'tunnel.apply');
  await f.routes.tick();
  await complete(f, f.entry, 'tunnel.apply');
  await f.routes.tick();
  const before = savedRoute(f, route.id),
    source = f.resources.record(before.sourceId).record;
  const process = [{ type: 'Regex Filter', args: { regex: ['.'], keep: true } }];
  await f.client.api(
    '/api/sub/' + encodeURIComponent(source.name),
    { name: 'user-renamed-route', displayName: 'user display', process },
    'PATCH',
  );
  await f.resources.sync();
  const chain = await f.chains.create({
    name: 'stable tunnel consumer',
    entry: { resourceId: before.sourceId, nodeName: route.name },
    exit: { resourceId: f.target.machine.resourceId, nodeName: 'target' },
  });
  await f.routes.update(route.id, {
    ...input,
    name: 'new route label',
    listenPort: 25456,
    hops: [input.hops[1]],
    revision: (await currentRoute(f)).revision,
  });
  assert.equal(savedRoute(f, route.id).hops[0].id, before.hops[1].id);
  assert.equal((await currentRoute(f)).outputResourceId, before.sourceId);
  await f.routes.tick();
  const retained = await complete(f, f.target, 'tunnel.apply');
  assert.equal(retained.params.id, before.hops[1].id);
  await f.routes.tick();
  const entry = await complete(f, f.entry, 'tunnel.apply');
  assert.equal(entry.params.id, route.id);
  assert.equal(JSON.parse(entry.params.config).listenPort, 25456);
  await f.routes.tick();
  const published = f.resources.record(before.sourceId).record;
  assert.match(published.content, /:25456#/);
  assert.equal(published.name, 'user-renamed-route');
  assert.equal(published.displayName, 'user display');
  assert.deepEqual(published.process, process);
  assert.equal((await f.chains.get(chain.id)).available, true);
  const removed = await failCommand(f, middle);
  assert.equal(removed.action, 'tunnel.delete');
  assert.equal(removed.params.id, before.hops[0].id);
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'failed');
  assert.match((await currentRoute(f)).message, /新入口已应用/);
  await assert.rejects(
    f.machines.enqueue(middle.machine.id, {
      action: 'tunnel.delete',
      params: { id: before.hops[0].id },
      expectedRevision: middle.snapshot.revision,
    }),
    { code: 'RELAY_REFERENCED' },
  );
  await f.routes.apply(route.id, (await currentRoute(f)).revision);
  await f.routes.tick();
  await complete(f, middle, 'tunnel.delete');
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'active');
  assert.equal(savedRoute(f, route.id).migration, undefined);
  assert.equal(savedRoute(f, route.id).sourceId, before.sourceId);
  assert.equal((await f.chains.get(chain.id)).available, true);
  assert.equal(
    f.resources
      .listResources()
      .filter((item) => f.resources.record(item.id).record._submeld?.role === 'relay-source')
      .length,
    1,
  );
});

test('an unobserved unknown update is held until the exact native identity can be reconciled', async (t) => {
  const f = await setup(t),
    route = await deployForward(f);
  const newEntry = await createMachine(f, 'replacement entry', snapshot('replacement entry'));
  await f.routes.update(route.id, {
    ...f.input,
    entryMachineId: newEntry.machine.id,
    revision: (await currentRoute(f)).revision,
  });
  await f.routes.tick();
  await complete(f, f.entry, 'forward.delete', (s) => {
    s.relay.forwards = [];
  });
  await f.routes.tick();
  await complete(f, f.entry, 'exit.delete', (s) => {
    s.relay.exits = [];
  });
  await f.routes.tick();
  const unknown = await failCommand(f, newEntry, 'unknown');
  assert.equal(unknown.action, 'exit.add');
  await f.routes.tick();
  const held = await currentRoute(f);
  assert.equal(held.status, 'failed');
  // Even another empty heartbeat is not proof that the original operation
  // cannot still have created an unobserved resource; do not issue another add.
  await report(f, newEntry);
  await assert.rejects(f.routes.apply(route.id, held.revision), { code: 'RELAY_RESULT_UNKNOWN' });
  assert.equal(f.machines.activeTask(newEntry.machine.id), null);
  assert.equal(savedRoute(f, route.id).step.requestId, unknown.requestId);
  newEntry.snapshot.relay.exits.push({
    id: 'reconciled-exit',
    name: unknown.params.name,
    core: unknown.params.core,
  });
  newEntry.snapshot.revision = digest('identity confirmed by fresh snapshot');
  await report(f, newEntry);
  await f.routes.apply(route.id, (await currentRoute(f)).revision);
  await f.routes.tick();
  await complete(f, newEntry, 'exit.edit', (s, p) => {
    assert.equal(p.id, 'reconciled-exit');
    s.relay.exits[0].uri = p.uri;
  });
  await f.routes.tick();
  await complete(f, newEntry, 'forward.add', (s, p) =>
    s.relay.forwards.push({ id: 'reconciled-forward', name: p.name, exit_id: p['exit-id'] }),
  );
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'active');
  assert.equal(newEntry.snapshot.relay.exits.length, 1);
});

test('same-machine protocol migration accepts only its own confirmed revisions without stranding old bindings', async (t) => {
  const f = await setup(t);
  const targetNode = f.target.snapshot.nodes[0];
  f.target.snapshot = snapshot('same-machine nodes', [
    targetNode,
    ...['old-entry', 'new-entry'].map((id, index) => ({
      ...targetNode,
      id,
      name: id,
      port: 8443 + index,
    })),
  ]);
  await report(f, f.target);
  const input = {
    ...f.input,
    kind: 'protocol',
    entryMachineId: f.target.machine.id,
    entryNodeId: 'old-entry',
  };
  const { route } = await f.routes.create(input);
  await f.routes.tick();
  await complete(f, f.target, 'exit.add', (s, p) =>
    s.relay.exits.push({ id: 'same-old-exit', name: p.name, core: p.core }),
  );
  await f.routes.tick();
  await complete(f, f.target, 'binding.add', (s, p) =>
    s.relay.bindings.push({ id: 'same-old-binding', node_id: p['node-id'], exit_id: p['exit-id'] }),
  );
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'active');
  await f.routes.update(route.id, {
    ...input,
    entryNodeId: 'new-entry',
    revision: (await currentRoute(f)).revision,
  });
  await f.routes.tick();
  await complete(f, f.target, 'binding.delete', (s, p) => {
    assert.equal(p.id, 'same-old-binding');
    s.relay.bindings = [];
  });
  await f.routes.tick();
  await complete(f, f.target, 'exit.delete', (s, p) => {
    assert.equal(p.id, 'same-old-exit');
    s.relay.exits = [];
  });
  await f.routes.tick();
  await complete(f, f.target, 'exit.add', (s, p) =>
    s.relay.exits.push({ id: 'same-new-exit', name: p.name, core: p.core }),
  );
  await f.routes.tick();
  await complete(f, f.target, 'binding.add', (s, p) => {
    assert.equal(p['node-id'], 'new-entry');
    s.relay.bindings.push({ id: 'same-new-binding', node_id: p['node-id'], exit_id: p['exit-id'] });
  });
  await f.routes.tick();
  assert.equal((await currentRoute(f)).status, 'active');
  assert.deepEqual(
    f.target.snapshot.relay.bindings.map((item) => item.id),
    ['same-new-binding'],
  );
  assert.deepEqual(
    f.target.snapshot.relay.exits.map((item) => item.id),
    ['same-new-exit'],
  );
  assert.equal(savedRoute(f, route.id).migration, undefined);
});
