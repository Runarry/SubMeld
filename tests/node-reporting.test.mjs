import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { stringify } from 'yaml';
import { fixture, subject } from './upstream-fixture.mjs';
import { node, TEST_PASSWORD } from './fixtures.mjs';
import { deferred } from './publication-fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { byteLimit, decodeBase64 } from '../dist/server/converter/input.js';
import { inlineNodeEntries } from '../dist/server/inline-node-input.js';
import { openSettings } from '../dist/server/database.js';
import { AppError } from '../dist/server/errors.js';
import { MAX_BYTES, MAX_NODES } from '../dist/server/shared/contracts.js';
import { DEFAULT_PROBE_URL } from '../dist/server/shared/node-tests.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';

const settingsPath = '/api/integrations/node-reporting';
const rawNode = (name = 'entry', port = 443) => ({ ...toUpstream(node('ss')), name, port });
const payload = (nodes = [rawNode()], name = 'reporting-machine') => ({
  name,
  content: JSON.stringify({ proxies: nodes }),
});
const uri =
  'ss://' +
  Buffer.from('aes-128-gcm:' + TEST_PASSWORD).toString('base64') +
  '@example.com:443#entry';

test('shared report input preserves textual YAML fields and extracts only inline nodes', () => {
  const content =
    'proxy-providers:\n  external:\n    url: https://example.invalid/private\nproxies:\n' +
    '  - {type: trojan, name: yaml, server: example.com, port: 443, password: 00123}\n' +
    '  - {type: vless, name: reality, server: example.com, port: 443, reality-opts: {short-id: 0088}}\n';
  const entries = inlineNodeEntries(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].password, '00123');
  assert.equal(entries[1]['reality-opts']['short-id'], '0088');
  assert.deepEqual(inlineNodeEntries(Buffer.from(uri).toString('base64url')), [uri]);
});

test('shared report input rejects invalid Base64 and UTF-8 and caps source and decoded bytes', () => {
  for (const value of ['!', 'a', 'AB==', 'YWJj='])
    assert.throws(() => decodeBase64(value), { code: 'INVALID_BASE64' });
  assert.throws(() => inlineNodeEntries(Buffer.from([0xff]).toString('base64')), {
    code: 'INVALID_ENCODING',
  });
  const boundary = 'x'.repeat(MAX_BYTES);
  assert.doesNotThrow(() => byteLimit(boundary));
  assert.equal(decodeBase64(Buffer.from(boundary).toString('base64')), boundary);
  for (const text of [boundary + 'x', '中'.repeat(Math.ceil(MAX_BYTES / 3))]) {
    assert.throws(() => inlineNodeEntries(text), { code: 'INPUT_LIMIT_EXCEEDED', status: 413 });
    assert.throws(() => decodeBase64(Buffer.from(text).toString('base64')), {
      code: 'INPUT_LIMIT_EXCEEDED',
      status: 413,
    });
  }
});

async function enabledFixture(t) {
  const f = await fixture(t);
  const response = await f.request(settingsPath + '/token', {});
  assert.equal(response.status, 200);
  f.token = (await response.json()).token;
  assert.equal((await f.request(settingsPath, { enabled: true }, 'PATCH')).status, 200);
  return f;
}
function report(f, id, body = payload(), headers = {}) {
  return f.app.request('/api/node-reports/' + id, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + f.token,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function expectStatus(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

test('report settings require session/origin, store only token hashes, and enforce enable/rotation', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request(settingsPath)).json(), {
    enabled: false,
    tokenConfigured: false,
  });
  assert.equal((await f.request(settingsPath, { enabled: true }, 'PATCH')).status, 400);
  const rotated = await expectStatus(await f.request(settingsPath + '/token', {}), 200);
  f.token = rotated.token;
  assert.equal(Buffer.from(f.token, 'base64url').length, 32);
  const id = randomUUID();
  await expectStatus(await report(f, id), 403);
  await expectStatus(await f.request(settingsPath, { enabled: true }, 'PATCH'), 200);
  for (const Authorization of ['', 'Bearer wrong', 'Basic ' + f.token])
    await expectStatus(await report(f, id, payload(), { Authorization }), 401);
  await expectStatus(await report(f, id, payload(), { Authorization: '', Cookie: f.cookie }), 401);
  await expectStatus(await report(f, id, payload(), { 'Content-Type': 'text/plain' }), 415);
  await expectStatus(await report(f, id, payload(), { 'Content-Encoding': 'gzip' }), 415);
  for (const path of [settingsPath, '/api/nodes', '/upstream/sub-store/api/subs']) {
    const response = await f.app.request(path, { headers: { Authorization: 'Bearer ' + f.token } });
    assert.equal(response.status, 401);
  }
  for (const path of [settingsPath, settingsPath + '/token'])
    for (const origin of ['', 'https://unrelated.example']) {
      const response = await f.app.request(path, {
        method: path.endsWith('/token') ? 'POST' : 'PATCH',
        headers: { Cookie: f.cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403);
    }
  const response = await report(f, id);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  await expectStatus(response, 201);
  const old = f.token;
  f.token = (await expectStatus(await f.request(settingsPath + '/token', {}), 200)).token;
  assert.notEqual(f.token, old);
  await expectStatus(await report(f, id, payload(), { Authorization: 'Bearer ' + old }), 401);
  assert.equal((await expectStatus(await report(f, id), 200)).action, 'unchanged');
  await expectStatus(await f.request(settingsPath, { enabled: false }, 'PATCH'), 200);
  await expectStatus(await report(f, id), 403);
  assert.equal((await f.nodes.list()).total, 1);
  const view = await (await f.request(settingsPath)).json();
  assert.deepEqual(Object.keys(view).sort(), ['enabled', 'tokenConfigured']);
  const db = new Database(join(f.directory, 'submeld-v2.sqlite'), { readonly: true });
  try {
    const stored = JSON.stringify(db.prepare('SELECT * FROM settings').all());
    for (const secret of [old, f.token, TEST_PASSWORD])
      assert.equal(stored.includes(secret), false);
    assert.match(
      JSON.parse(
        db.prepare('SELECT value FROM settings WHERE key=?').get('nodeReporting.settings').value,
      ).tokenHash,
      /^[a-f0-9]{64}$/,
    );
  } finally {
    db.close();
  }
});

test('reports replace one machine snapshot, retry without revision changes, and generate current output', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID(),
    other = randomUUID();
  const initial = payload([rawNode('entry'), rawNode('exit', 444)]);
  assert.deepEqual(await expectStatus(await report(f, id, initial), 201), {
    machineId: id,
    action: 'created',
    nodeCount: 2,
  });
  const first = f.resources.resource(id);
  const list = await f.nodes.list(id);
  assert.equal(list.total, 2);
  const originalSubject = subject(list.nodes[0]);
  const snapshot = f.resources.cached(id);
  assert.equal(
    (await expectStatus(await report(f, id.toUpperCase(), initial), 200)).action,
    'unchanged',
  );
  assert.equal(f.resources.resource(id).revision, first.revision);
  assert.equal(f.resources.cached(id), snapshot);
  assert.equal(f.nodeTests.matches(originalSubject), true);
  await expectStatus(await report(f, other, payload([rawNode('other')])), 201);
  const plan = await f.subscriptions.create({
    ...newSubscription(),
    name: 'reported-output',
    inputs: [{ kind: 'resource', id }],
    formats: ['mihomo'],
  });
  const changed = payload([rawNode('replacement', 8443)], 'renamed-machine');
  assert.equal((await expectStatus(await report(f, id, changed), 200)).action, 'updated');
  assert.equal(f.resources.resource(id).upstreamName, first.upstreamName);
  assert.equal(f.nodeTests.matches(originalSubject), false);
  assert.equal((await f.nodes.list()).total, 2);
  assert.equal((await f.nodes.list(id)).nodes[0].name, 'replacement');
  assert.equal((await f.client.records('sub')).length, 2);
  const { parse } = await import('yaml');
  const generated = parse((await f.subscriptions.artifact(plan.id, 'mihomo')).content);
  assert.equal(generated.proxies.length, 1);
  assert.equal(generated.proxies[0].port, 8443);
});

test('URI, Base64 and native JSON/YAML retain raw content including protocols beyond NodeDraft', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  const native = {
    type: 'socks5',
    name: 'native-socks',
    server: 'example.com',
    port: 1080,
    username: 'fixture',
    password: TEST_PASSWORD,
  };
  const contents = [
    uri,
    uri + '\n' + uri.replace('#entry', '#second'),
    Buffer.from(uri).toString('base64'),
    JSON.stringify({ proxies: [native] }),
    stringify({ proxies: [native] }),
  ];
  for (const [index, content] of contents.entries()) {
    await expectStatus(await report(f, id, { name: 'formats', content }), index ? 200 : 201);
    assert.equal(f.resources.record(id).record.content, content);
    const list = await f.nodes.list(id);
    assert.equal(list.errors.length, 0);
    assert.ok(list.total >= 1);
    if (index === 3 || index === 4) assert.equal(list.nodes[0].testable, false);
  }
});

test('invalid, partially parsed, empty and oversized reports preserve the previous resource', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  await expectStatus(await report(f, id), 201);
  const before = structuredClone(f.resources.record(id).record);
  const bareArray = JSON.stringify([rawNode()]);
  const unsupported = await f.client.preview(
    'sub',
    { name: 'bare-array-check', source: 'local', content: bareArray, process: [] },
    true,
  );
  // The pinned local-subscription parser does not support an unwrapped JSON array.
  assert.equal(unsupported.original.length, 0);
  const cases = [
    ['', 400],
    ['   ', 400],
    ['[]', 400],
    ['{"proxies":[]}', 400],
    [bareArray, 422],
    [uri + '\nunsupported-protocol://bad', 422],
    [JSON.stringify({ proxies: [rawNode(), null] }), 422],
    [JSON.stringify({ proxies: [rawNode(), { type: 'unknown-protocol', name: 'bad' }] }), 422],
    ['proxies: [', 422],
    ['<html>private page</html>', 400],
    ['a: &a [*a]\nproxies: *a', 413],
    ['proxies: ' + '['.repeat(35) + ']'.repeat(35), 413],
    ['proxies: []\nproxies: []', 422],
    ['x'.repeat(MAX_BYTES + 1), 413],
    ['中'.repeat(Math.ceil(MAX_BYTES / 3)), 413],
    [Array.from({ length: MAX_NODES + 1 }, () => uri).join('\n'), 413],
  ];
  for (const [content, status] of cases) {
    await expectStatus(await report(f, id, { name: 'bad', content }), status);
    assert.deepEqual((await f.client.records('sub'))[0], before);
  }
  await expectStatus(await report(f, 'not-a-uuid'), 400);
  await expectStatus(await report(f, id, { ...payload(), name: 'x'.repeat(513) }), 400);
  await expectStatus(await report(f, id, { ...payload(), process: [] }), 400);
  const request = t.mock.method(f.client, 'request', async () => {
    throw new AppError('SUB_STORE_UNAVAILABLE', '隔离上游故障注入。', 503);
  });
  await expectStatus(await report(f, id, payload([rawNode('not-written')])), 503);
  request.mock.restore();
  assert.deepEqual((await f.client.records('sub'))[0], before);
});

test('native renames and operations persist; unrelated UUIDs, names and remote sources conflict', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  await expectStatus(await report(f, id), 201);
  const process = [{ type: 'Flag Operator', args: { mode: 'remove' } }];
  await f.client.api(
    '/api/sub/sm-report-' + id,
    { name: 'native-renamed', process, tag: ['custom'] },
    'PATCH',
  );
  await expectStatus(await report(f, id, payload([rawNode('updated')])), 200);
  const after = f.resources.record(id).record;
  assert.equal(after.name, 'native-renamed');
  assert.deepEqual(after.process, process);
  assert.deepEqual(after.tag, ['custom']);
  assert.deepEqual(after._submeld, { id, role: 'report-source', version: 1 });
  const ordinary = await f.nodes.create({ ...payload(), source: 'local' });
  await expectStatus(await report(f, ordinary.id), 409);
  const conflict = randomUUID();
  await f.client.api('/api/subs', {
    name: 'sm-report-' + conflict,
    source: 'local',
    content: uri,
    process: [],
  });
  await expectStatus(await report(f, conflict), 409);
  const fileId = randomUUID();
  await f.client.api('/api/files', {
    name: 'unrelated-file',
    content: '{}',
    _submeld: { id: fileId, role: 'template', version: 1 },
  });
  await expectStatus(await report(f, fileId), 409);
  await f.client.api(
    '/api/sub/native-renamed',
    { source: 'remote', url: 'https://example.invalid/subscription' },
    'PATCH',
  );
  await expectStatus(await report(f, id), 409);
  await f.client.api(
    '/api/sub/native-renamed',
    { source: 'local', mergeSources: 'remoteFirst' },
    'PATCH',
  );
  await expectStatus(await report(f, id), 409);
  assert.equal((await f.client.records('sub')).length, 3);
});

test('concurrent same-ID reports and a lost write response remain safe to retry', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  const payloads = Array.from({ length: 6 }, (_, i) => payload([rawNode('machine-' + i)]));
  const responses = await Promise.all(payloads.map((value) => report(f, id, value)));
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 5);
  assert.equal((await f.client.records('sub')).length, 1);
  assert.ok(payloads.some((value) => value.content === f.resources.record(id).record.content));
  const lostId = randomUUID();
  const api = f.client.api.bind(f.client);
  const fault = t.mock.method(f.client, 'api', async (...args) => {
    const value = await api(...args);
    if (args[0] === '/api/subs' && args[1]?.name === 'sm-report-' + lostId)
      throw new AppError('SUB_STORE_UNAVAILABLE', '写入响应丢失。', 503);
    return value;
  });
  await expectStatus(await report(f, lostId), 503);
  fault.mock.restore();
  assert.equal((await expectStatus(await report(f, lostId), 200)).action, 'unchanged');
  assert.equal((await f.client.records('sub')).length, 2);
});

test('token changes during parsing are checked again before a report can write', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  const entered = deferred(),
    release = deferred();
  const convert = f.client.convert.bind(f.client);
  const pendingParse = t.mock.method(f.client, 'convert', async (...args) => {
    entered.resolve();
    await release.promise;
    return convert(...args);
  });
  const pending = report(f, id);
  await entered.promise;
  f.nodeReporting.rotateToken();
  release.resolve();
  await expectStatus(await pending, 401);
  pendingParse.mock.restore();
  assert.equal((await f.client.records('sub')).length, 0);
});

test('restarting preserves the reporting identity and token without a second node database', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  await expectStatus(await report(f, id), 201);
  f.close();
  const reopened = openSettings(f.directory, true, f.client);
  try {
    assert.deepEqual(reopened.nodeReporting.view(), { enabled: true, tokenConfigured: true });
    const result = await reopened.nodeReporting.report(
      id,
      payload([rawNode('after-restart')]),
      'Bearer ' + f.token,
    );
    assert.equal(result.action, 'updated');
    assert.equal((await reopened.nodes.list()).total, 1);
    assert.equal((await f.client.records('sub')).length, 1);
  } finally {
    reopened.close();
  }
  const db = new Database(join(f.directory, 'submeld-v2.sqlite'), { readonly: true });
  try {
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
        .sort(),
      [
        'machine_tasks',
        'machines',
        'node_test_results',
        'reality_scan_results',
        'reality_scans',
        'settings',
        'speed_reports',
        'speed_results',
        'telegram_tasks',
      ],
    );
  } finally {
    db.close();
  }
});

test('legacy chain files do not block reports or bypass stale test-result protection', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  await expectStatus(await report(f, id, payload([rawNode('entry'), rawNode('exit', 444)])), 201);
  const legacy = {
    name: 'legacy-reported-chain',
    source: 'local',
    type: 'file',
    process: [],
    content: JSON.stringify({
      name: 'legacy chain',
      enabled: true,
      entry: { resourceId: id, nodeName: 'entry' },
      exit: { resourceId: id, nodeName: 'exit' },
    }),
    _submeld: { id, role: 'chain', version: 1 },
  };
  await f.client.api('/api/files', legacy);
  await f.resources.sync();
  const before = subject((await f.nodes.list(id)).nodes[0]);
  const result = {
    subject: before,
    name: 'entry',
    core: 'mihomo',
    coreVersion: 'test',
    url: DEFAULT_PROBE_URL,
    testedAt: new Date().toISOString(),
    status: 'passed',
    latencyMs: 5,
    httpStatus: 204,
    message: '',
    stale: false,
  };
  assert.equal(f.nodeTests.save(result), true);
  await expectStatus(
    await report(f, id, payload([rawNode('entry', 8443), rawNode('exit', 444)])),
    200,
  );
  await f.resources.preview(id);
  assert.equal(f.resources.resolve({ resourceId: id, nodeName: 'entry' }).processed.port, 8443);
  assert.equal(f.miaospeedInput.matches(before), false);
  assert.equal(f.nodeTests.fresh(result, new Map([['mihomo', 'test']])).stale, true);
  const current = subject((await f.nodes.list(id)).nodes[0]);
  const currentResult = { ...result, subject: current, latencyMs: 9 };
  assert.equal(f.nodeTests.save(currentResult), true);
  assert.equal(f.nodeTests.save(result), false);
  assert.equal(
    f.nodeTests.results([current], new Map([['mihomo', 'test']])).results[0].latencyMs,
    9,
  );
  await expectStatus(await report(f, id, payload([rawNode('exit', 444)])), 200);
  const remaining = await f.nodes.list(id);
  assert.deepEqual(
    remaining.nodes.map((node) => node.name),
    ['exit'],
  );
  assert.equal(f.resources.record(id).record._submeld.id, id);
  assert.equal(
    (await f.client.records('file')).find((file) => file.name === legacy.name).content,
    legacy.content,
  );
});

test('legacy chain files are ignored before identity checks and remain untouched during node and native resource writes', async (t) => {
  const f = await enabledFixture(t),
    id = randomUUID();
  await expectStatus(await report(f, id, payload([rawNode('entry'), rawNode('exit', 444)])), 201);
  const files = [
    {
      name: 'legacy-valid',
      content: JSON.stringify({
        name: 'legacy',
        enabled: true,
        entry: { resourceId: id, nodeName: 'entry' },
        exit: { resourceId: id, nodeName: 'exit' },
      }),
      _submeld: { id, role: 'chain', version: 1 },
    },
    {
      name: 'legacy-duplicate',
      content: '{broken JSON',
      _submeld: { id, role: 'chain', version: 1 },
    },
    {
      name: 'legacy-invalid-marker',
      content: 'not JSON',
      _submeld: { id: 'invalid UUID', role: 'chain', version: 'unsupported' },
    },
  ].map((file) => ({ ...file, type: 'file', source: 'local', process: [] }));
  for (const file of files) await f.client.api('/api/files', file);
  await f.resources.sync();
  assert.equal(f.resources.record(id).type, 'sub');
  assert.equal(f.resources.files().length, 0);
  assert.equal((await f.nodes.list(id)).total, 2);
  const { resourceId, revision, snapshotHash, nodeIndex } = (await f.nodes.list(id)).nodes[0];
  assert.equal(
    (await f.nodes.delete({ nodes: [{ resourceId, revision, snapshotHash, nodeIndex }] })).deleted,
    1,
  );
  assert.deepEqual(
    (await f.nodes.list(id)).nodes.map((node) => node.name),
    ['exit'],
  );
  const source = f.resources.record(id).record;
  await assert.rejects(
    f.resources.write(async () => {
      await f.client.api(
        '/api/sub/' + encodeURIComponent(source.name),
        { displayName: 'updated before controlled failure' },
        'PATCH',
      );
      throw new AppError('CONTROLLED_WRITE_FAILURE', 'controlled failure', 502);
    }),
    { code: 'CONTROLLED_WRITE_FAILURE' },
  );
  assert.equal(f.resources.resource(id).name, 'updated before controlled failure');
  const response = await f.resources.write(() =>
    f.client.request('/api/sub/' + encodeURIComponent(source.name), { method: 'DELETE' }),
  );
  assert.equal(response.ok, true);
  assert.equal(f.resources.listResources().length, 0);
  const stored = await f.client.records('file');
  for (const file of files) {
    const found = stored.find((item) => item.name === file.name);
    assert.equal(found.content, file.content);
    assert.deepEqual(found._submeld, file._submeld);
  }
  // Only the retired role is ignored; active file identities still conflict.
  await expectStatus(await report(f, id, payload()), 201);
  await f.client.api('/api/files', {
    name: 'active-duplicate',
    source: 'local',
    type: 'file',
    content: '{}',
    process: [],
    _submeld: { id, role: 'template', version: 1 },
  });
  await assert.rejects(f.resources.sync(), { code: 'UPSTREAM_ID_DUPLICATE' });
  await f.client.api('/api/file/active-duplicate', undefined, 'DELETE');
  await f.resources.sync();
  assert.equal(f.resources.record(id).type, 'sub');
});
