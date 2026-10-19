import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, subject } from './upstream-fixture.mjs';
import { RelayStore, relayEndpoint } from '../dist/server/relays.js';

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
