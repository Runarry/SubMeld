import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { fixture } from './upstream-fixture.mjs';
import { RelayStore } from '../dist/server/relays.js';
import { MachineStore } from '../dist/server/machines.js';
import { AppError } from '../dist/server/errors.js';
import { machineDeletionPreviewSchema } from '../dist/server/shared/machines.js';

const revision = 'a'.repeat(64);
const secret = 'public-deletion-fixture-password';
function snapshot() {
  return {
    schemaVersion: 1,
    revision,
    vpsctlVersion: 'fixture',
    capabilities: { actions: ['node.add', 'forward.add', 'forward.delete'], profiles: [] },
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
    nodes: [
      {
        id: 'node',
        name: 'fixture node',
        core: 'sing-box',
        profile: 'ss',
        address: 'example.com',
        port: 443,
        password: secret,
      },
    ],
    exports: [
      {
        id: 'node',
        name: 'fixture node',
        core: 'sing-box',
        kind: 'node',
        uri:
          'ss://' +
          Buffer.from('aes-128-gcm:' + secret).toString('base64') +
          '@example.com:443#fixture',
      },
    ],
    relay: { exits: [], bindings: [], forwards: [] },
    pendingCores: [],
  };
}
async function enrolled(t, reported = true) {
  const f = await fixture(t);
  const created = f.machines.create({ name: 'machine to delete' });
  const authorization = 'Bearer ' + created.token;
  const report = (extra = {}) =>
    f.machines.report(
      {
        machineId: created.machine.id,
        agentVersion: 'fixture',
        bootId: created.machine.id,
        snapshot: snapshot(),
        ...extra,
      },
      authorization,
    );
  if (reported) await report();
  const db = new Database(join(f.directory, 'submeld-v2.sqlite'));
  f.beforeClose(() => db.close());
  return {
    ...f,
    ...created,
    authorization,
    report,
    db,
    preview: () => f.machines.deletionPreview(created.machine.id),
    remove: (value) =>
      f.machines.remove(created.machine.id, { revision: value.revision, agentUninstalled: true }),
  };
}
async function status(response, expected) {
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}
async function putFile(f, role, content, options = {}) {
  const id = options.id ?? randomUUID();
  const record = {
    name: options.name ?? 'fixture-' + id,
    type: 'file',
    source: 'local',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    process: [],
    _submeld: { id, role, version: 1, ...options.marker },
  };
  await f.client.api('/api/files', record);
  return record;
}
function command(f) {
  return f.machines.enqueue(f.machine.id, {
    action: 'node.add',
    expectedRevision: revision,
    params: { password: secret },
  });
}
function taskResult(f, id, status = 'applied') {
  return f.machines.result(
    {
      machineId: f.machine.id,
      result: { schemaVersion: 1, requestId: id, status, exitCode: 0, message: '', revision },
    },
    f.authorization,
  );
}
const deleteInput = (preview) => ({ revision: preview.revision, agentUninstalled: true });

test('machine deletion API validates confirmation and authentication and is idempotent for never-reported machines', async (t) => {
  const f = await enrolled(t, false),
    path = '/api/machines/' + f.machine.id;
  const { preview } = await status(await f.request(path + '/deletion-preview'), 200);
  machineDeletionPreviewSchema.parse(preview);
  assert.deepEqual(preview.counts, { nodes: 0, subscriptions: 0, tasks: 0, files: 0 });
  assert.deepEqual(preview.unfinishedTasks, []);
  const input = deleteInput(preview);
  await status(
    await f.app.request(path + '/deletion-preview', {
      headers: { Authorization: f.authorization },
    }),
    401,
  );
  await status(
    await f.app.request(path, {
      method: 'DELETE',
      headers: {
        Origin: f.config.publicOrigin,
        'Content-Type': 'application/json',
        'X-SubMeld-Request': '1',
        Authorization: f.authorization,
      },
      body: JSON.stringify(input),
    }),
    401,
  );
  await status(
    await f.app.request(path, {
      method: 'DELETE',
      headers: { Cookie: f.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    403,
  );
  for (const invalid of [
    { revision: preview.revision },
    { ...input, agentUninstalled: false },
    { ...input, revision: 'bad' },
    { ...input, extra: true },
  ])
    await status(await f.request(path, invalid, 'DELETE'), 400);
  assert.equal(f.machines.list().length, 1);
  assert.deepEqual(await status(await f.request(path, input, 'DELETE'), 200), { deleted: true });
  assert.deepEqual(await status(await f.request(path, input, 'DELETE'), 200), { deleted: true });
  await status(await f.request(path + '/deletion-preview'), 404);
  await status(await f.request('/api/machines/not-a-uuid', input, 'DELETE'), 400);
  await status(await f.request(path, { revision: 'bad', agentUninstalled: true }, 'DELETE'), 400);
});

test('normal and offline/disabled machines delete owned resources, task history and both kinds of share tokens, preserving reports and unrelated files', async (t) => {
  const f = await enrolled(t);
  const first = (await command(f)).task;
  await f.machines.cancel(f.machine.id, first.id);
  const second = (await command(f)).task;
  const source = f.resources.record(f.machine.resourceId).record;
  const privateFile = f.resources.files('machine-snapshot')[0].record;
  for (const [type, name] of [
    ['sub', source.name],
    ['file', privateFile.name],
  ])
    await f.client.api('/api/token', { payload: { type, name }, options: {} });
  assert.equal((await f.client.tokens(source.name, 'sub')).length, 1);
  assert.equal((await f.client.tokens(privateFile.name)).length, 1);
  const shares = [];
  for (const [type, record] of [
    ['sub', source],
    ['file', privateFile],
  ]) {
    const [token] = await f.client.tokens(record.name, type);
    const url =
      new URL(f.client.origin).origin +
      '/share/' +
      type +
      '/' +
      encodeURIComponent(record.name) +
      '?target=ClashMeta&token=' +
      encodeURIComponent(token.token);
    assert.equal((await fetch(url)).status, 200);
    shares.push(url);
  }
  const orphan = await putFile(f, 'machine-command', 'malformed orphan command', {
    marker: { parent: f.machine.id },
  });
  const unrelated = await putFile(f, 'machine-command', 'unrelated', {
    marker: { parent: randomUUID() },
  });
  const legacy = await putFile(f, 'chain', '{bad legacy JSON', { id: f.machine.resourceId });
  f.db
    .prepare('INSERT INTO node_test_results(key,result_json) VALUES(?,?)')
    .run('retained-history', '{"history":true}');
  f.db.prepare('UPDATE machines SET last_seen=0 WHERE id=?').run(f.machine.id);
  assert.equal(f.machines.list()[0].online, false);
  await f.machines.update(f.machine.id, { enabled: false });
  const preview = await f.preview();
  assert.deepEqual(preview.counts, { nodes: 1, subscriptions: 1, tasks: 2, files: 4 });
  assert.deepEqual(
    preview.unfinishedTasks.map((item) => item.id),
    [second.id],
  );
  assert.equal(JSON.stringify(preview).includes(secret), false);
  await f.remove(preview);
  assert.deepEqual(f.machines.list(), []);
  assert.deepEqual(f.db.prepare('SELECT * FROM machine_tasks').all(), []);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM node_test_results').get().count, 1);
  assert.deepEqual(await f.client.tokens(source.name, 'sub'), []);
  assert.deepEqual(await f.client.tokens(privateFile.name), []);
  assert.deepEqual(await f.client.records('sub'), []);
  assert.deepEqual(
    (await f.client.records('file')).map((item) => item.name).sort(),
    [unrelated.name, legacy.name].sort(),
  );
  assert.equal(
    (await f.client.records('file')).some((item) => item.name === orphan.name),
    false,
  );
  assert.throws(() => f.resources.resource(f.machine.resourceId), { status: 404 });
  // Even if a native record later reuses the old name, its old token stays revoked.
  await f.client.api('/api/subs', source);
  await f.client.api('/api/files', privateFile);
  for (const url of shares) assert.equal((await fetch(url)).status, 404);
});

test('agent reports and results queued behind a deletion cannot project deleted nodes back upstream', async (t) => {
  const f = await enrolled(t);
  const task = (await command(f)).task;
  await f.machines.poll(f.machine.id, f.authorization, 0);
  const preview = await f.preview();
  const deleted = f.remove(preview);
  const report = assert.rejects(f.report(), { code: 'MACHINE_UNAUTHENTICATED' });
  const result = assert.rejects(
    f.machines.result(
      {
        machineId: f.machine.id,
        result: {
          schemaVersion: 1,
          requestId: task.id,
          status: 'applied',
          exitCode: 0,
          message: '',
          revision,
          snapshot: snapshot(),
        },
      },
      f.authorization,
    ),
    { code: 'MACHINE_UNAUTHENTICATED' },
  );
  const poll = assert.rejects(f.machines.poll(f.machine.id, f.authorization, 0), {
    code: 'MACHINE_UNAUTHENTICATED',
  });
  await Promise.all([deleted, report, result, poll]);
  assert.deepEqual(await f.client.records('sub'), []);
  assert.deepEqual(await f.client.records('file'), []);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM machine_tasks').get().count, 0);
});

test('history cleanup uses a bounded number of full catalog reads and verifies each raw file', async (t) => {
  const f = await enrolled(t);
  for (let index = 0; index < 12; index++)
    await putFile(f, 'machine-command', '{malformed-' + index, {
      marker: { parent: f.machine.id },
    });
  const preview = await f.preview();
  const records = f.client.records.bind(f.client);
  let catalogs = 0;
  f.client.records = async (type) => {
    if (type === 'file') catalogs++;
    return records(type);
  };
  await f.remove(preview);
  assert.ok(catalogs <= 4, 'history must not trigger wholeFiles for every command');
  assert.deepEqual(await f.client.records('file'), []);
});

test('preview revision ignores heartbeat and delivery timestamps but changes for commands, token rotation and resource changes', async (t) => {
  const f = await enrolled(t);
  let preview = await f.preview();
  await f.report({ agentVersion: 'new-agent-version', bootId: randomUUID() });
  await f.machines.update(f.machine.id, { enabled: false });
  assert.equal((await f.preview()).revision, preview.revision);
  await f.machines.update(f.machine.id, { enabled: true });
  const task = (await command(f)).task;
  await assert.rejects(f.remove(preview), { code: 'REVISION_CONFLICT', status: 409 });
  assert.equal(f.machines.list()[0].enabled, true);
  preview = await f.preview();
  await f.machines.poll(f.machine.id, f.authorization, 0);
  await assert.rejects(f.remove(preview), { code: 'REVISION_CONFLICT' });
  preview = await f.preview();
  await f.machines.poll(f.machine.id, f.authorization, 0);
  f.db
    .prepare(
      'UPDATE machine_tasks SET updated_at=updated_at+100,delivery_sequence=delivery_sequence+1',
    )
    .run();
  assert.equal((await f.preview()).revision, preview.revision);
  await f.machines.rotateToken(f.machine.id);
  await assert.rejects(f.remove(preview), { code: 'REVISION_CONFLICT' });
  preview = await f.preview();
  const source = f.resources.record(f.machine.resourceId).record;
  await f.client.api(
    '/api/sub/' + encodeURIComponent(source.name),
    { displayName: 'native change' },
    'PATCH',
  );
  await assert.rejects(f.remove(preview), { code: 'REVISION_CONFLICT' });
  assert.equal(f.machines.list()[0].enabled, true);
  preview = await f.preview();
  assert.equal(preview.unfinishedTasks[0].id, task.id);
  assert.equal(preview.unfinishedTasks[0].status, 'running');
  await f.remove(preview);
});

test('finished unknown and interrupted running tasks remain visible in deletion confirmation and are cleared', async (t) => {
  const f = await enrolled(t);
  const unknown = (await command(f)).task;
  await f.machines.poll(f.machine.id, f.authorization, 0);
  await taskResult(f, unknown.id, 'unknown');
  const interrupted = (await command(f)).task;
  await f.machines.poll(f.machine.id, f.authorization, 0);
  const restarted = new MachineStore(f.db, f.resources);
  f.beforeClose(() => restarted.close());
  const preview = await restarted.deletionPreview(f.machine.id);
  assert.deepEqual(
    preview.unfinishedTasks.map((item) => item.id).sort(),
    [unknown.id, interrupted.id].sort(),
  );
  assert.ok(preview.unfinishedTasks.every((item) => item.status === 'unknown'));
  await restarted.remove(f.machine.id, deleteInput(preview));
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM machine_tasks').get().count, 0);
});

test('owned invalid JSON remains deletable, missing resources are accepted, but identity collisions never disable or delete', async (t) => {
  const f = await enrolled(t);
  await command(f);
  const snapshotFile = f.resources.files('machine-snapshot')[0].record;
  await f.client.api('/api/file/' + snapshotFile.name, { content: '{invalid' }, 'PATCH');
  const taskFile = f.resources.files('machine-command')[0].record;
  await f.client.api('/api/file/' + taskFile.name, { content: '{invalid' }, 'PATCH');
  assert.equal((await f.preview()).counts.nodes, null);
  const source = f.resources.record(f.machine.resourceId).record;
  for (const patch of [
    { _submeld: { ...source._submeld, parent: randomUUID() } },
    { _submeld: { ...source._submeld, version: 2 } },
    { _submeld: { ...source._submeld, role: 'report-source' } },
    { _submeld: { ...source._submeld, id: 'invalid-uuid' } },
  ]) {
    const before = await f.preview();
    await f.client.api('/api/sub/' + source.name, patch, 'PATCH');
    await assert.rejects(f.remove(before), { code: 'MACHINE_RESOURCE_CONFLICT', status: 409 });
    assert.equal(f.machines.list()[0].enabled, true);
    assert.equal((await f.client.records('sub')).length, 1);
    await f.client.api('/api/sub/' + source.name, { _submeld: source._submeld }, 'PATCH');
  }
  const duplicate = await putFile(f, 'machine-command', '{}', {
    id: f.machine.resourceId,
    marker: { parent: f.machine.id },
  });
  await assert.rejects(f.preview(), { code: 'MACHINE_RESOURCE_CONFLICT' });
  await f.client.api('/api/file/' + duplicate.name, undefined, 'DELETE');
  await f.client.api('/api/file/' + taskFile.name, undefined, 'DELETE');
  await f.client.api('/api/sub/' + source.name, undefined, 'DELETE');
  let preview = await f.preview();
  assert.deepEqual(preview.counts, { nodes: null, subscriptions: 0, tasks: 1, files: 1 });
  await f.client.api('/api/file/' + snapshotFile.name, undefined, 'DELETE');
  preview = await f.preview();
  assert.equal(preview.counts.nodes, null);
  await f.remove(preview);
});

test('native collections and resource or node plan references block deletion; legacy chains are ignored', async (t) => {
  const f = await enrolled(t);
  const before = await f.preview();
  const source = f.resources.record(f.machine.resourceId).record;
  await f.client.api('/api/sub/' + source.name, { name: 'renamed-machine-native' }, 'PATCH');
  const collectionId = randomUUID();
  await f.client.api('/api/collections', {
    name: 'native collection',
    displayName: 'Named collection',
    subscriptions: ['renamed-machine-native'],
    process: [],
    _submeld: { id: collectionId },
  });
  const plan = (inputs, name) => ({ name, inputs, formats: ['uri'] });
  const resourcePlan = await putFile(
    f,
    'plan',
    plan([{ kind: 'resource', id: f.machine.resourceId }], 'Direct plan'),
  );
  const nodePlan = await putFile(
    f,
    'plan',
    plan([{ kind: 'node', resourceId: f.machine.resourceId, nodeName: 'fixture' }], 'Node plan'),
  );
  await putFile(f, 'plan', plan([{ kind: 'resource', id: collectionId }], 'Indirect plan'));
  await putFile(f, 'plan', plan([{ kind: 'chain', id: randomUUID() }], 'Old hidden plan'));
  await putFile(f, 'chain', '{not JSON', { id: f.machine.resourceId });
  let preview = await f.preview();
  assert.deepEqual(
    preview.blockers.map((item) => item.name).sort(),
    ['Named collection', 'Direct plan', 'Node plan'].sort(),
  );
  await assert.rejects(f.remove(before), { code: 'REVISION_CONFLICT' });
  await assert.rejects(f.remove(preview), { code: 'MACHINE_REFERENCED' });
  assert.equal(f.machines.list()[0].enabled, true);
  await f.client.api(
    '/api/collection/' + encodeURIComponent('native collection'),
    { subscriptions: [] },
    'PATCH',
  );
  for (const file of [resourcePlan, nodePlan])
    await f.client.api('/api/file/' + file.name, undefined, 'DELETE');
  preview = await f.preview();
  assert.deepEqual(preview.blockers, []);
  await f.remove(preview);
});

test('unreadable active plans or routes produce explicit errors and leave the machine enabled', async (t) => {
  const f = await enrolled(t);
  for (const [role, code] of [
    ['plan', 'PLAN_INVALID'],
    ['relay-route', 'RELAY_INVALID'],
  ]) {
    const file = await putFile(f, role, '{bad');
    await assert.rejects(f.preview(), { code });
    assert.equal(f.machines.list()[0].enabled, true);
    await f.client.api('/api/file/' + file.name, undefined, 'DELETE');
  }
});

test('partial upstream failure disables promptly, keeps all SQL indices, rejects late agent work and retries from a fresh preview', async (t) => {
  const f = await enrolled(t, false);
  // This is the smallest v4 UUID, so cleanup removes the snapshot before either
  // random source/command UUID. The failure must leave no readable snapshot.
  f.db
    .prepare('UPDATE machines SET snapshot_file_id=? WHERE id=?')
    .run('00000000-0000-4000-8000-000000000000', f.machine.id);
  await f.report();
  const task = (await command(f)).task;
  await f.machines.cancel(f.machine.id, task.id);
  const preview = await f.preview();
  const poll = f.machines.poll(f.machine.id, f.authorization, 25);
  const rejectedPoll = assert.rejects(poll, (error) =>
    ['MACHINE_DISABLED', 'MACHINE_UNAUTHENTICATED'].includes(error.code),
  );
  const api = f.client.api.bind(f.client);
  let deletes = 0;
  f.client.api = async (path, body, method, signal) => {
    if (method === 'DELETE' && /^\/api\/(sub|file)\//.test(path) && ++deletes === 2)
      throw new AppError('SUB_STORE_FAILED', 'injected failure', 502);
    return api(path, body, method, signal);
  };
  await assert.rejects(f.remove(preview), { code: 'MACHINE_DELETE_INCOMPLETE', status: 502 });
  await rejectedPoll;
  assert.equal(f.machines.list()[0].enabled, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM machine_tasks').get().count, 1);
  assert.deepEqual(f.resources.files('machine-snapshot'), []);
  await assert.rejects(f.report(), { code: 'MACHINE_DISABLED' });
  await assert.rejects(command(f), { code: 'MACHINE_DISABLED' });
  await assert.rejects(taskResult(f, task.id), { code: 'MACHINE_DISABLED' });
  f.client.api = api;
  const next = await f.preview();
  assert.notEqual(next.revision, preview.revision);
  assert.equal(next.counts.nodes, null);
  assert.equal(next.counts.files + next.counts.subscriptions, 2);
  await f.remove(next);
  // The response can be lost after successful cleanup: the same request is safe to repeat.
  assert.deepEqual(await f.remove(next), { deleted: true });
  for (const late of [
    () => f.report(),
    () => f.machines.poll(f.machine.id, f.authorization, 0),
    () => taskResult(f, task.id),
  ])
    await assert.rejects(late(), { code: 'MACHINE_UNAUTHENTICATED', status: 401 });
  assert.deepEqual(await f.client.records('sub'), []);
  assert.deepEqual(await f.client.records('file'), []);
});

function deployment(id, machineId, overrides = {}) {
  return {
    schemaVersion: 1,
    route: {
      id,
      name: 'retained route',
      kind: 'forward',
      entryMachineId: randomUUID(),
      targetMachineId: randomUUID(),
      targetNodeId: 'node',
      listenPort: 23456,
      address: 'relay.example.test',
      network: 'both',
      family: 'dual',
      hops: [],
      status: 'pending',
      message: '',
      taskIds: [],
      ...overrides,
    },
    sourceId: randomUUID(),
    stage: 0,
    deleting: false,
    targetRevision: revision,
    targetUri: 'private',
    targetHost: 'example.com',
    targetPort: 443,
    targetProfile: 'ss',
    targetCore: 'sing-box',
    hops: [],
    ...(machineId
      ? {
          step: {
            machineId,
            requestId: randomUUID(),
            expectedRevision: revision,
            operation: { action: 'forward.add', params: {} },
          },
        }
      : {}),
  };
}

test('relay blockers include entry/target/hops, previous migration/retire slots and recorded steps, even without a relay coordinator', async (t) => {
  const f = await enrolled(t);
  const id = randomUUID(),
    machineId = f.machine.id;
  const cases = [
    { route: { entryMachineId: machineId } },
    { route: { targetMachineId: machineId } },
    { route: { hops: [{ machineId, address: 'hop.example.test', port: 2345 }] } },
    { step: true },
    { previous: { entryMachineId: machineId } },
    { previous: { targetMachineId: machineId } },
    { previous: { hops: [{ machineId, address: 'old-hop.example.test', port: 2345 }] } },
    { previousStep: true },
    { retire: true },
  ];
  for (const [index, item] of cases.entries()) {
    const value = deployment(id, item.step ? machineId : undefined, {
      ...item.route,
      status: ['pending', 'deleting', 'failed'][index % 3],
    });
    value.migration = {
      previous: deployment(id, item.previousStep ? machineId : undefined, item.previous),
      phase: 'retire',
      retireIndex: 0,
      retire: item.retire ? [{ machineId, id: randomUUID(), revision }] : [],
    };
    const file = await putFile(f, 'relay-route', value, { id });
    const preview = await f.preview();
    assert.deepEqual(preview.blockers, [{ kind: 'relay', id, name: 'retained route' }]);
    await assert.rejects(f.remove(preview), { code: 'MACHINE_REFERENCED' });
    assert.equal(f.machines.list()[0].enabled, true);
    value.route.status = 'deleted';
    await f.client.api('/api/file/' + file.name, { content: JSON.stringify(value) }, 'PATCH');
    assert.deepEqual((await f.preview()).blockers, []);
    await f.client.api('/api/file/' + file.name, undefined, 'DELETE');
  }
});

test('machine deletion serializes with concurrent relay creation in both queue orders', async (t) => {
  const f = await enrolled(t),
    routes = new RelayStore(f.machines, f.resources);
  f.beforeClose(() => routes.close());
  const target = f.machines.create({ name: 'target' });
  await f.machines.report(
    {
      machineId: target.machine.id,
      agentVersion: 'fixture',
      bootId: randomUUID(),
      snapshot: snapshot(),
    },
    'Bearer ' + target.token,
  );
  const input = {
    name: 'queued route',
    kind: 'forward',
    entryMachineId: f.machine.id,
    targetMachineId: target.machine.id,
    targetNodeId: 'node',
    address: 'entry.example.test',
    listenPort: 23456,
    network: 'both',
    family: 'dual',
    hops: [],
  };
  let preview = await f.preview();
  const created = routes.create(input);
  const removal = assert.rejects(f.remove(preview), { code: 'REVISION_CONFLICT' });
  const { route } = await created;
  await removal;
  assert.equal(f.machines.list().find((item) => item.id === f.machine.id).enabled, true);
  const record = f.resources.record(route.id).record;
  const saved = JSON.parse(record.content);
  saved.route.status = 'deleted';
  await f.client.api('/api/file/' + record.name, { content: JSON.stringify(saved) }, 'PATCH');
  preview = await f.preview();
  const deleting = f.remove(preview);
  const creating = assert.rejects(routes.create(input), { code: 'MACHINE_NOT_FOUND' });
  await deleting;
  await creating;
  assert.deepEqual(
    (await routes.list()).routes.map((item) => [item.id, item.status]),
    [[route.id, 'deleted']],
  );
});
