import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { fixture } from './upstream-fixture.mjs';
import { MachineStore } from '../dist/server/machines.js';
import { AppError } from '../dist/server/errors.js';
import { machineActionSchema } from '../dist/server/shared/machines.js';

const revision = (letter) => letter.repeat(64);
const secret = 'fixture-machine-password-never-in-sqlite';
const uri = (name = 'entry', port = 443) =>
  'ss://' +
  Buffer.from('aes-128-gcm:' + secret).toString('base64') +
  '@example.com:' +
  port +
  '#' +
  name;
const exported = (id = 'entry', core = 'sing-box', port = 443) => ({
  id,
  name: id,
  core,
  kind: 'node',
  uri: uri(id, port),
  tlsSpkiSha256: 'public-certificate-digest',
});
function snapshot(letter = 'a', exports = [exported()], pendingCores = []) {
  return {
    schemaVersion: 1,
    revision: revision(letter),
    vpsctlVersion: 'fixture',
    capabilities: {
      actions: machineActionSchema.options,
      profiles: [{ id: 'ss', label: 'Shadowsocks', cores: ['sing-box', 'xray'] }],
    },
    cores: ['sing-box', 'xray'].map((core) => ({
      core,
      installed: true,
      running: true,
      enabled: true,
      pending_restart: pendingCores.includes(core),
      version: 'fixture',
    })),
    nodes: exports.map(({ id, name, core }) => ({
      id,
      name,
      core,
      profile: 'ss',
      password: secret,
      params: { port: 443, password: secret, 'private-key': secret },
      futureNative: { hiddenValues: [secret] },
    })),
    relay: { exits: [], bindings: [], forwards: [] },
    exports,
    pendingCores,
    nativeConfiguration: { password: secret, futureNative: ['must-be-preserved'] },
  };
}
async function enrolled(t, initial = snapshot()) {
  const f = await fixture(t);
  const { machine, token } = f.machines.create({ name: 'fixture machine' });
  const authorization = 'Bearer ' + token;
  const report = (state = initial) =>
    f.machines.report(
      { machineId: machine.id, agentVersion: 'fixture-agent', bootId: machine.id, snapshot: state },
      authorization,
    );
  if (initial) await report();
  return { ...f, machine, token, authorization, report };
}
async function status(response, expected) {
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}

test('an aborted agent long poll closes without an internal server error', async (t) => {
  const f = await enrolled(t);
  const controller = new AbortController();
  const pending = f.app.request('/api/agent/commands?machineId=' + f.machine.id + '&wait=25', {
    headers: { Authorization: f.authorization },
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await pending).status, 499);
});

test('machine management requires login/origin; agent token is machine scoped, revocable, and never stored in plaintext', async (t) => {
  const f = await enrolled(t);
  const other = f.machines.create({ name: 'other machine' });
  for (const path of [
    '/api/machines',
    '/api/machines/' + f.machine.id,
    '/api/machines/' + f.machine.id + '/snapshot',
  ])
    await status(await f.app.request(path, { headers: { Authorization: f.authorization } }), 401);
  await status(
    await f.app.request('/api/machines', {
      method: 'POST',
      headers: { Cookie: f.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no origin' }),
    }),
    403,
  );
  const apiReport = (id, authorization = f.authorization, extra = {}) =>
    f.app.request('/api/agent/report', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({
        machineId: id,
        agentVersion: 'fixture',
        bootId: randomUUID(),
        snapshot: snapshot(),
      }),
    });
  await status(await apiReport(other.machine.id), 401);
  await status(await apiReport(f.machine.id, ''), 401);
  await status(
    await apiReport(f.machine.id, f.authorization, { 'Content-Type': 'text/plain' }),
    415,
  );
  await status(await apiReport(f.machine.id, f.authorization, { 'Content-Encoding': 'gzip' }), 415);
  await status(await apiReport(f.machine.id), 200);
  const polling = f.machines.poll(f.machine.id, f.authorization, 25);
  const denied = assert.rejects(polling, { code: 'MACHINE_DISABLED', status: 403 });
  await f.machines.update(f.machine.id, { enabled: false });
  await denied;
  await f.machines.update(f.machine.id, { enabled: true });
  const rotated = await f.machines.rotateToken(f.machine.id);
  assert.notEqual(rotated.token, f.token);
  await status(await apiReport(f.machine.id), 401);
  await status(await apiReport(f.machine.id, 'Bearer ' + rotated.token), 200);
  const db = new Database(join(f.directory, 'submeld-v2.sqlite'), { readonly: true });
  try {
    const saved = JSON.stringify(db.prepare('SELECT * FROM machines').all());
    for (const value of [secret, f.token, rotated.token, uri()])
      assert.equal(saved.includes(value), false);
  } finally {
    db.close();
  }
});

test('complete private snapshots preserve native fields; ordinary details exclude credentials and raw URIs', async (t) => {
  const f = await enrolled(t);
  const detail = await f.machines.detail(f.machine.id);
  const text = JSON.stringify(detail);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(uri()), false);
  assert.equal(detail.snapshot.nodes[0].params.port, 443);
  assert.deepEqual(await f.machines.getPrivateSnapshot(f.machine.id), snapshot());
  const response = await status(
    await f.request('/api/machines/' + f.machine.id + '/snapshot'),
    200,
  );
  assert.deepEqual(response.snapshot.nativeConfiguration.futureNative, ['must-be-preserved']);
  assert.equal(response.snapshot.exports[0].tlsSpkiSha256, 'public-certificate-digest');
});

test('pending cores retain applied exports, unchanged reports are stable, native rename/process survive, and empty exports clear the source', async (t) => {
  const oldSing = exported('sing', 'sing-box'),
    oldXray = exported('xray', 'xray');
  const f = await enrolled(t, snapshot('a', [oldSing, oldXray]));
  const resourceId = f.machine.resourceId;
  const before = f.resources.resource(resourceId);
  await f.report(snapshot('a', [oldSing, oldXray]));
  assert.equal(f.resources.resource(resourceId).revision, before.revision);
  const original = f.resources.record(resourceId).record;
  const process = [{ type: 'Regex Filter', args: { regex: ['.'], keep: true } }];
  await f.client.api(
    '/api/sub/' + encodeURIComponent(original.name),
    {
      name: 'renamed-native-machine',
      process,
      _submeld: { ...original._submeld, topologyRevision: revision('e') },
    },
    'PATCH',
  );
  const newSing = exported('sing', 'sing-box', 8443),
    newXray = exported('xray', 'xray', 8444);
  await f.report(snapshot('b', [newSing, newXray], ['sing-box']));
  let source = f.resources.record(resourceId).record;
  assert.equal(source.name, 'renamed-native-machine');
  assert.deepEqual(source.process, process);
  assert.equal(source._submeld.topologyRevision, revision('e'));
  assert.equal(source.content, oldSing.uri + '\n' + newXray.uri);
  await f.report(snapshot('c', [newSing, newXray]));
  source = f.resources.record(resourceId).record;
  assert.equal(source.content, newSing.uri + '\n' + newXray.uri);
  const appliedRevision = f.resources.resource(resourceId).revision;
  await f.report(snapshot('d', [newSing, newXray]));
  assert.notEqual(f.resources.resource(resourceId).revision, appliedRevision);
  await f.report(snapshot('f', []));
  assert.equal(f.resources.record(resourceId).record.content, '');
  assert.equal((await f.client.records('sub')).length, 1);
  assert.equal(f.machines.list()[0].syncError, null);
});

test('unsupported exports and projection failures retain old subscriptions and retry from the saved private snapshot', async (t) => {
  const f = await enrolled(t),
    id = f.machine.resourceId;
  const previous = f.resources.record(id).record.content;
  const broken = snapshot('b', [
    exported(),
    { ...exported('bad'), uri: 'unknown-fixture://unsupported#bad' },
  ]);
  await f.report(broken);
  assert.equal(f.resources.record(id).record.content, previous);
  assert.equal((await f.machines.getPrivateSnapshot(f.machine.id)).revision, revision('b'));
  assert.equal(f.machines.list()[0].snapshotRevision, revision('a'));
  assert.ok(f.machines.list()[0].syncError);
  const api = f.client.api.bind(f.client);
  let fail = true;
  f.client.api = async (path, ...args) => {
    if (fail && path.startsWith('/api/sub/'))
      throw new AppError('SUB_STORE_FAILED', '受控测试故障。', 502);
    return api(path, ...args);
  };
  t.after(() => {
    f.client.api = api;
  });
  const next = snapshot('c', [exported('updated', 'sing-box', 444)]);
  await f.report(next);
  assert.equal((await f.machines.getPrivateSnapshot(f.machine.id)).revision, revision('c'));
  assert.equal(f.resources.record(id).record.content, previous);
  assert.ok(f.machines.list()[0].syncError);
  fail = false;
  await f.report(next);
  assert.equal(f.resources.record(id).record.content, next.exports[0].uri);
  assert.equal(f.machines.list()[0].syncError, null);
  assert.equal(f.machines.list()[0].snapshotRevision, revision('c'));
});

test('machine projection refuses UUID ownership conflicts without modifying the unrelated source', async (t) => {
  const f = await enrolled(t, null);
  await f.client.api('/api/subs', {
    name: 'unrelated',
    source: 'local',
    content: uri('unrelated'),
    process: [],
    _submeld: { id: f.machine.resourceId, role: 'report-source', version: 1 },
  });
  await f.report(snapshot());
  assert.equal(f.resources.record(f.machine.resourceId).record.content, uri('unrelated'));
  assert.ok(f.machines.list()[0].syncError);
  assert.equal((await f.machines.getPrivateSnapshot(f.machine.id)).revision, revision('a'));
});

test('durable commands resend the same request after lost delivery and restart; result receipts are idempotent and sanitized', async (t) => {
  const f = await enrolled(t),
    id = f.machine.id;
  const requestId = randomUUID(),
    operation = {
      action: 'node.edit',
      params: { id: 'entry', password: secret, port: 444 },
      expectedRevision: revision('a'),
    };
  const { task } = await f.machines.enqueue(id, operation, requestId);
  assert.equal(task.id, requestId);
  const duplicate = await f.machines.enqueue(
    id,
    { ...operation, params: { port: 444, password: secret, id: 'entry' } },
    requestId,
  );
  assert.equal(duplicate.task.id, task.id);
  await assert.rejects(f.machines.enqueue(id, { ...operation, params: { port: 445 } }, requestId), {
    code: 'MACHINE_REQUEST_CONFLICT',
  });
  const first = (await f.machines.poll(id, f.authorization, 0)).command;
  assert.equal(first.requestId, task.id);
  assert.deepEqual((await f.machines.poll(id, f.authorization, 0)).command, first);
  await assert.rejects(f.machines.cancel(id, task.id), { code: 'MACHINE_TASK_RUNNING' });
  const db = new Database(join(f.directory, 'submeld-v2.sqlite'));
  const restarted = new MachineStore(db, f.resources);
  f.beforeClose(() => {
    restarted.close();
    db.close();
  });
  assert.equal(restarted.task(task.id).status, 'unknown');
  await assert.rejects(restarted.enqueue(id, operation), { code: 'MACHINE_BUSY' });
  assert.deepEqual((await restarted.poll(id, f.authorization, 0)).command, first);
  const result = {
    schemaVersion: 1,
    requestId: task.id,
    status: 'applied',
    exitCode: 0,
    message: secret + ' ' + uri(),
    revision: revision('b'),
    snapshot: snapshot('b'),
  };
  const finished = await restarted.result({ machineId: id, result }, f.authorization);
  assert.equal(finished.task.status, 'applied');
  assert.equal(finished.task.message.includes(secret), false);
  assert.equal((await restarted.getPrivateSnapshot(id)).revision, revision('b'));
  assert.deepEqual(await restarted.result({ machineId: id, result }, f.authorization), finished);
  assert.equal((await restarted.poll(id, f.authorization, 0)).command, null);
  const stored = JSON.stringify({
    machines: db.prepare('SELECT * FROM machines').all(),
    tasks: db.prepare('SELECT * FROM machine_tasks').all(),
  });
  for (const credential of [secret, uri(), f.token])
    assert.equal(stored.includes(credential), false);
});

test('a late result cannot replace a newer heartbeat, including changes received before server restart', async (t) => {
  const f = await enrolled(t),
    id = f.machine.id;
  const { task } = await f.machines.enqueue(id, {
    action: 'core.restart',
    params: { core: 'sing-box' },
    expectedRevision: revision('a'),
  });
  await f.machines.poll(id, f.authorization, 0);
  const latest = snapshot('c', [exported('latest', 'sing-box', 445)]);
  await f.report(latest);
  const result = {
    schemaVersion: 1,
    requestId: task.id,
    status: 'applied',
    exitCode: 0,
    message: 'old result',
    revision: revision('b'),
    snapshot: snapshot('b'),
  };
  await f.machines.result({ machineId: id, result }, f.authorization);
  assert.deepEqual(await f.machines.getPrivateSnapshot(id), latest);
  assert.equal(f.resources.record(f.machine.resourceId).record.content, latest.exports[0].uri);
  assert.equal(f.machines.task(task.id).resultRevision, revision('b'));
});

test('only queued tasks can cancel; stale queued revisions are never delivered and cross-machine results fail', async (t) => {
  const f = await enrolled(t),
    id = f.machine.id;
  const operation = {
    action: 'core.restart',
    params: { core: 'sing-box' },
    expectedRevision: revision('a'),
  };
  const { task: cancelled } = await f.machines.enqueue(id, operation);
  assert.equal((await f.machines.cancel(id, cancelled.id)).task.status, 'cancelled');
  assert.equal((await f.machines.poll(id, f.authorization, 0)).command, null);
  const { task } = await f.machines.enqueue(id, operation);
  await f.report(snapshot('b'));
  assert.equal((await f.machines.poll(id, f.authorization, 0)).command, null);
  assert.equal(f.machines.task(task.id).status, 'conflict');
  await assert.rejects(f.machines.enqueue(id, operation), { code: 'REVISION_CONFLICT' });
  const next = await f.machines.enqueue(id, { ...operation, expectedRevision: revision('b') });
  const other = f.machines.create({ name: 'other' });
  await assert.rejects(
    f.machines.result(
      {
        machineId: other.machine.id,
        result: {
          schemaVersion: 1,
          requestId: next.task.id,
          status: 'failed',
          exitCode: 1,
          message: '',
          revision: revision('b'),
        },
      },
      'Bearer ' + other.token,
    ),
    { code: 'MACHINE_TASK_NOT_FOUND' },
  );
  await assert.rejects(
    f.machines.result(
      {
        machineId: id,
        result: {
          schemaVersion: 1,
          requestId: next.task.id,
          status: 'applied',
          exitCode: 0,
          message: '',
          revision: revision('b'),
        },
      },
      f.authorization,
    ),
    { code: 'MACHINE_RESULT_INVALID' },
  );
});

test('deleting a pending renamed node still protects the chain that uses its last applied name', async (t) => {
  const entry = exported('entry'),
    exit = exported('exit', 'xray', 444);
  const f = await enrolled(t, snapshot('a', [entry, exit]));
  await f.chains.create({
    name: 'machine-chain',
    entry: { resourceId: f.machine.resourceId, nodeName: entry.name },
    exit: { resourceId: f.machine.resourceId, nodeName: exit.name },
  });
  const renamed = { ...entry, name: 'renamed-entry', uri: uri('renamed-entry') };
  await f.report(snapshot('b', [renamed, exit], ['sing-box']));
  await assert.rejects(
    f.machines.enqueue(f.machine.id, {
      action: 'node.delete',
      params: { id: entry.id },
      expectedRevision: revision('b'),
    }),
    { code: 'NODE_IN_USE' },
  );
  assert.equal(f.machines.activeTask(f.machine.id), null);
});

test('forward publication changes only the URI fragment, retaining credentials and unique exported names', async (t) => {
  const original =
    'trojan://' +
    encodeURIComponent(secret) +
    '@example.com:7443?security=tls&sni=tls.example.com&type=ws&path=%2Fkeep%3Fkey%3Dvalue#target-node';
  const forwards = ['第一入口:7443', '第二入口:7443'].map((name, index) => ({
    id: 'forward-' + index + ':7443',
    name,
    core: 'sing-box',
    kind: 'forward',
    uri: original,
  }));
  const ordinary = { ...exported('ordinary'), uri: uri('untouched-native-name') };
  const initial = snapshot('a', [ordinary, ...forwards]);
  initial.nodes = initial.nodes.filter((node) => node.id === ordinary.id);
  const f = await enrolled(t, initial);
  const content = f.resources.record(f.machine.resourceId).record.content;
  assert.equal(
    content,
    [
      ordinary.uri,
      ...forwards.map(
        (item) => original.slice(0, original.indexOf('#')) + '#' + encodeURIComponent(item.name),
      ),
    ].join('\n'),
  );
  const preview = await f.resources.preview(f.machine.resourceId);
  assert.deepEqual(
    preview.original.map((node) => node.name),
    ['untouched-native-name', ...forwards.map((item) => item.name)],
  );
  for (const forward of preview.original.slice(1)) {
    assert.equal(forward.password, secret);
    assert.equal(forward.sni, 'tls.example.com');
    assert.equal(forward['ws-opts'].path, '/keep?key=value');
  }
  assert.deepEqual(await f.machines.getPrivateSnapshot(f.machine.id), initial);
});

test('forward deletion, cascading exit deletion and all-core uninstall protect applied forwarding chain members', async (t) => {
  const forwarding = {
    id: 'forward-a:7443',
    name: 'forward-entry:7443',
    core: 'sing-box',
    kind: 'forward',
    uri: uri('target-name', 7443),
  };
  const exit = exported('chain-exit', 'xray', 7444);
  const initial = snapshot('a', [forwarding, exit]);
  initial.nodes = initial.nodes.filter((node) => node.id === exit.id);
  initial.relay.exits = [{ id: 'exit-a', name: 'remote-exit', uri: uri('remote') }];
  initial.relay.forwards = [
    {
      id: 'forward-a',
      name: 'forward-entry',
      exit_id: 'exit-a',
      listen_port_start: 7443,
      listen_port_end: 7443,
    },
  ];
  const f = await enrolled(t, initial);
  await f.chains.create({
    name: 'forward-chain',
    entry: { resourceId: f.machine.resourceId, nodeName: forwarding.name },
    exit: { resourceId: f.machine.resourceId, nodeName: exit.name },
  });
  const pending = structuredClone(initial);
  pending.revision = revision('b');
  pending.pendingCores = ['sing-box'];
  pending.cores[0].pending_restart = true;
  pending.exports[0].name = 'pending-forward-name:7443';
  pending.relay.forwards[0].name = 'pending-forward-name';
  await f.report(pending);
  for (const [action, params] of [
    ['forward.delete', { id: 'forward-a' }],
    ['exit.delete', { id: 'exit-a', cascade: true, 'confirm-cascade': true }],
    ['core.uninstall', { core: 'all', purge: true, 'confirm-purge': true }],
  ])
    await assert.rejects(
      f.machines.enqueue(f.machine.id, { action, params, expectedRevision: pending.revision }),
      { code: 'NODE_IN_USE' },
    );
  assert.equal(f.machines.activeTask(f.machine.id), null);
  // An ID that only shares the prefix must not select this forward's exports.
  const unrelated = await f.machines.enqueue(f.machine.id, {
    action: 'forward.delete',
    params: { id: 'forward' },
    expectedRevision: pending.revision,
  });
  assert.equal((await f.machines.cancel(f.machine.id, unrelated.task.id)).task.status, 'cancelled');
});
