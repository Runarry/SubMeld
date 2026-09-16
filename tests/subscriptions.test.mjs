import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { openSettings } from '../dist/server/database.js';
import { createApp } from '../dist/server/app.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { AppError } from '../dist/server/errors.js';
import { Publisher } from '../dist/server/publisher.js';
import { ENGINE_VERSION } from '../dist/server/subscriptions.js';
import { Converter } from '../dist/server/converter/pool.js';
import { parseInput, produceInput } from '../dist/server/converter/engine.js';
import { renderInput } from '../dist/server/converter/render.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { node, items, TEST_PASSWORD } from './fixtures.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class ControlledConverter {
  ready = Promise.resolve();
  listeners = new Set();
  busy = false;
  calls = [];
  next;
  transform;
  isAvailable() {
    return !this.busy;
  }
  onAvailable(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  hold(error) {
    const entered = deferred(),
      released = deferred();
    this.next = { entered, released, error };
    return { entered: entered.promise, release: () => released.resolve() };
  }
  async run(request, signal) {
    if (this.busy) throw new AppError('CONVERTER_BUSY', '繁忙', 503);
    this.busy = true;
    this.calls.push(structuredClone(request));
    const gate = this.next;
    this.next = undefined;
    try {
      if (gate) {
        gate.entered.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => {
            cleanup();
            reject(new AppError('REQUEST_CANCELLED', '已取消'));
          };
          const cleanup = () => signal?.removeEventListener('abort', abort);
          signal?.addEventListener('abort', abort, { once: true });
          gate.released.promise.then(() => {
            cleanup();
            resolve();
          });
          if (signal?.aborted) abort();
        });
        if (gate.error) throw gate.error;
      }
      if (this.transform) {
        const value = this.transform(request);
        if (value !== undefined) return value;
      }
      return request.kind === 'parse'
        ? parseInput(request.input)
        : request.kind === 'produce'
          ? produceInput(request.input)
          : renderInput(request.input);
    } finally {
      this.busy = false;
      queueMicrotask(() => {
        for (const fn of this.listeners) fn();
      });
    }
  }
}
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'submeld-p3-'));
  return {
    dir,
    remove() {
      const rel = relative(tmpdir(), dir);
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('submeld-p3-'));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function setup(t, converter = new ControlledConverter()) {
  const temp = temporary();
  const settings = openSettings(temp.dir, true);
  await converter.ready;
  const publisher = new Publisher(
    settings.subscriptions,
    settings.nodes,
    settings.sources,
    converter,
  );
  t.after(async () => {
    await publisher.close();
    await converter.close?.();
    settings.close();
    temp.remove();
  });
  return { settings, store: settings.subscriptions, publisher, converter, temp };
}
function config(inputs, extra = {}) {
  return { ...newSubscription(), name: 'P3 test', inputs, ...extra };
}
function controlledNode(name = 'keep local', protocol = 'vless') {
  const n = node(protocol);
  n.name = name;
  n.tls.insecure = false;
  return n;
}
function uri(...drafts) {
  return produceInput({ items: items(...drafts) }).uri;
}
async function source(f, drafts = [controlledNode('keep remote')]) {
  return f.settings.sources.create(
    { name: 'Text', format: 'uri', text: uri(...drafts) },
    f.converter,
  );
}
function local(f, draft = controlledNode()) {
  return f.settings.nodes.create({ drafts: [draft] }).nodes[0];
}
const read = (f, id, format = 'uri') => f.store.artifact(id, format, ENGINE_VERSION);
const missing = (fn) => assert.throws(fn, { status: 503 });

test('P3 sources accept only complete text, preserve failed edits and create independent copies', async (t) => {
  const f = await setup(t),
    s = await source(f);
  const copy = local(f, s.items[0].draft);
  assert.ok(!JSON.stringify(f.settings.sources.list(0)).includes(TEST_PASSWORD));
  assert.ok(!('text' in f.settings.sources.list(0).sources[0]));
  const subscription = f.store.create(config([{ kind: 'source', id: s.id }]));
  await f.publisher.idle();
  const before = read(f, subscription.id);
  for (const text of [
    s.text + '\ntrojan://broken',
    'https://example.com/sub',
    '<html>error</html>',
    '',
  ]) {
    await assert.rejects(f.settings.sources.update(s.id, { revision: 1, text }, f.converter), {
      status: 422,
    });
    assert.equal(f.settings.sources.get(s.id).revision, 1);
    assert.equal(read(f, subscription.id).content, before.content);
  }
  const updated = await f.settings.sources.update(
    s.id,
    { revision: 1, text: uri(controlledNode('changed remote')) },
    f.converter,
  );
  missing(() => read(f, subscription.id));
  await f.publisher.idle();
  assert.match(decodeURIComponent(read(f, subscription.id).content), /changed remote/);
  assert.equal(f.settings.nodes.get(copy.id).draft.name, 'keep remote');
  await assert.rejects(
    f.settings.sources.update(s.id, { revision: 1, name: 'stale' }, f.converter),
    { status: 409 },
  );
  const disabled = await f.settings.sources.update(
    s.id,
    { revision: updated.revision, enabled: false },
    f.converter,
  );
  await f.publisher.idle();
  await f.settings.sources.update(
    s.id,
    { revision: disabled.revision, name: 'still disabled' },
    f.converter,
  );
  assert.equal(f.settings.sources.get(s.id).enabled, false);
});

test('P3 delayed source parses cannot overwrite changed or deleted sources', async (t) => {
  const f = await setup(t),
    s = await source(f);
  const gate = f.converter.hold();
  const save = f.settings.sources.update(
    s.id,
    { revision: 1, text: uri(controlledNode('late')) },
    f.converter,
  );
  const rejected = assert.rejects(save, { status: 409 });
  await gate.entered;
  await f.settings.sources.update(s.id, { revision: 1, name: 'newer' }, f.converter);
  gate.release();
  await rejected;
  assert.equal(f.settings.sources.get(s.id).items[0].draft.name, 'keep remote');
  const second = f.converter.hold();
  const late = f.settings.sources.update(
    s.id,
    { revision: 2, text: uri(controlledNode('late again')) },
    f.converter,
  );
  const deleted = assert.rejects(late, { status: 404 });
  await second.entered;
  f.settings.sources.delete(s.id, 2);
  second.release();
  await deleted;
  assert.equal(f.settings.sources.list(0).total, 0);
});

test('P3 mixed ordered inputs, case-sensitive names and target protocol filters publish all eight formats', async (t) => {
  const f = await setup(t);
  const s = await source(f, [
    controlledNode('keep first'),
    controlledNode('keep hy2', 'hysteria2'),
    controlledNode('keep omit', 'ss'),
    controlledNode('Keep capital', 'ss'),
  ]);
  const n = local(f);
  const settings = config(
    [
      { kind: 'source', id: s.id },
      { kind: 'node', id: n.id },
    ],
    {
      formats: [...outputFormats],
      includeName: 'keep',
      excludeName: 'omit',
      prefix: 'pre-',
      suffix: '-end',
    },
  );
  settings.protocols.xray = ['ss', 'vmess', 'vless', 'trojan'];
  const sub = f.store.create(settings);
  await f.publisher.idle();
  for (const format of outputFormats) assert.equal(read(f, sub.id, format).readable, true, format);
  const content = read(f, sub.id).content;
  assert.deepEqual(
    content.split('\n').map((line) => decodeURIComponent(new URL(line).hash.slice(1))),
    ['pre-keep first-end', 'pre-keep hy2-end', 'pre-keep local-end'],
  );
  assert.equal(Buffer.from(read(f, sub.id, 'base64').content, 'base64').toString('utf8'), content);
  assert.equal(JSON.parse(read(f, sub.id, 'xray-outbounds').content).outbounds.length, 2);
  assert.deepEqual(read(f, sub.id, 'xray').counts, { input: 5, output: 2, filtered: 3 });
  assert.equal(f.settings.sources.get(s.id).items[0].draft.name, 'keep first');
  assert.equal(f.settings.nodes.get(n.id).draft.name, 'keep local');
  f.settings.nodes.update(n.id, { revision: 1, enabled: false });
  missing(() => read(f, sub.id));
  await f.publisher.idle();
  assert.equal(read(f, sub.id).counts.output, 2);
  f.settings.sources.delete(s.id, 1);
  await f.publisher.idle();
  missing(() => read(f, sub.id));
  assert.equal(f.store.get(sub.id).inputs.length, 1);
});

for (const outcome of ['success', 'error']) {
  for (const mutation of [
    'edit node',
    'disable node',
    'delete node',
    'disable subscription',
    'delete subscription',
  ]) {
    test('P3 late ' + outcome + ' cannot resurrect content after ' + mutation, async (t) => {
      const f = await setup(t),
        n = local(f);
      const sub = f.store.create(config([{ kind: 'node', id: n.id }]));
      await f.publisher.idle();
      const gate = f.converter.hold(
        outcome === 'error' ? new AppError('OLD_ERROR', 'old failure') : undefined,
      );
      f.publisher.schedule([sub.id]);
      await gate.entered;
      if (mutation === 'edit node')
        f.settings.nodes.update(n.id, { revision: 1, changes: { name: 'new version' } });
      if (mutation === 'disable node')
        f.settings.nodes.update(n.id, { revision: 1, enabled: false });
      if (mutation === 'delete node') f.settings.nodes.delete(n.id, 1);
      if (mutation === 'disable subscription')
        f.store.update(sub.id, { revision: 1, enabled: false });
      if (mutation === 'delete subscription') f.store.delete(sub.id, 1);
      assert.throws(() => read(f, sub.id));
      gate.release();
      await f.publisher.idle();
      if (mutation === 'edit node') {
        assert.match(decodeURIComponent(read(f, sub.id).content), /new version/);
        assert.equal(read(f, sub.id).error, null);
      } else assert.throws(() => read(f, sub.id));
      if (mutation !== 'delete subscription')
        assert.ok(
          !JSON.stringify(f.store.detail(sub.id, ENGINE_VERSION, 'idle')).includes('OLD_ERROR'),
        );
    });
  }
}

test('P3 paired publication and independent target failure preserve valid results but never revive invalidated ones', async (t) => {
  const f = await setup(t),
    n = local(f),
    sub = f.store.create(
      config([{ kind: 'node', id: n.id }], { formats: ['uri', 'base64', 'mihomo', 'singbox'] }),
    );
  await f.publisher.idle();
  const before = Object.fromEntries(
    ['uri', 'base64', 'mihomo'].map((format) => [format, read(f, sub.id, format)]),
  );
  f.converter.transform = (request) => {
    if (request.kind === 'produce')
      return { ...produceInput(request.input), uri: 'must-not-publish', base64: null };
    if (request.kind === 'render' && request.input.target === 'mihomo')
      throw new AppError('TARGET_FAILURE', 'controlled target failure');
  };
  f.publisher.schedule([sub.id]);
  await f.publisher.idle();
  for (const format of ['uri', 'base64', 'mihomo']) {
    assert.equal(read(f, sub.id, format).content, before[format].content);
    assert.equal(read(f, sub.id, format).generatedAt, before[format].generatedAt);
    assert.ok(read(f, sub.id, format).error);
  }
  assert.equal(read(f, sub.id, 'singbox').error, null);
  f.store.update(sub.id, { revision: 1, prefix: 'changed-' });
  await f.publisher.idle();
  for (const format of ['uri', 'base64', 'mihomo']) missing(() => read(f, sub.id, format));
  assert.equal(read(f, sub.id, 'singbox').counts.output, 1);
  // URI alone remains usable when Base64 exceeds its own cap.
  f.converter.transform = (request) =>
    request.kind === 'produce' ? { ...produceInput(request.input), base64: null } : undefined;
  f.store.update(sub.id, { revision: 2, formats: ['uri'] });
  await f.publisher.idle();
  assert.match(decodeURIComponent(read(f, sub.id).content), /changed-/);
});

test('P3 the bounded queue coalesces IDs and wakes after foreground work releases the Worker', async (t) => {
  const f = await setup(t),
    n = local(f),
    gate = f.converter.hold();
  const parse = f.converter.run({
    kind: 'parse',
    input: { format: 'uri', text: uri(controlledNode()) },
  });
  await gate.entered;
  const sub = f.store.create(config([{ kind: 'node', id: n.id }]));
  for (let i = 0; i < 1000; i++) f.publisher.schedule([sub.id]);
  assert.equal(f.publisher.status(sub.id), 'queued');
  assert.equal(f.converter.calls.filter((c) => c.kind === 'produce').length, 0);
  gate.release();
  await parse;
  await f.publisher.idle();
  assert.equal(f.converter.calls.filter((c) => c.kind === 'produce').length, 1);
  assert.equal(read(f, sub.id).counts.output, 1);
});

test('P3 aggregate count and byte limits apply before filtering, and object limits are enforced', async (t) => {
  const f = await setup(t);
  const s = await source(
    f,
    Array.from({ length: 2000 }, () => controlledNode('many', 'ss')),
  );
  const n = local(f),
    sub = f.store.create(
      config(
        [
          { kind: 'source', id: s.id },
          { kind: 'node', id: n.id },
        ],
        { includeName: 'no match' },
      ),
    );
  await f.publisher.idle();
  missing(() => read(f, sub.id));
  assert.equal(
    f.store.detail(sub.id, ENGINE_VERSION, 'idle').artifacts[0].error.code,
    'INPUT_LIMIT_EXCEEDED',
  );
  const large = controlledNode('large', 'ss');
  large.auth.password = 'p'.repeat(15000);
  f.converter.transform = (req) =>
    req.kind === 'parse'
      ? {
          items: items(...Array.from({ length: 140 }, () => large)),
          diagnostics: [],
          counts: { input: 140, output: 140, filtered: 0 },
        }
      : undefined;
  const a = await f.settings.sources.create(
    { name: 'large a', format: 'uri', text: 'fixture' },
    f.converter,
  );
  const b = await f.settings.sources.create(
    { name: 'large b', format: 'uri', text: 'fixture' },
    f.converter,
  );
  const big = f.store.create(
    config([
      { kind: 'source', id: a.id },
      { kind: 'source', id: b.id },
    ]),
  );
  await f.publisher.idle();
  assert.equal(
    f.store.detail(big.id, ENGINE_VERSION, 'idle').artifacts[0].error.code,
    'INPUT_LIMIT_EXCEEDED',
  );
  f.converter.transform = undefined;
  for (let i = 2; i < 100; i++) f.store.create(config([], { enabled: false }));
  assert.throws(() => f.store.create(config([])), { code: 'OBJECT_LIMIT_EXCEEDED' });
  for (let i = 3; i < 100; i++) await source(f, [controlledNode('small', 'ss')]);
  await assert.rejects(source(f), { code: 'OBJECT_LIMIT_EXCEEDED' });
});

test('P3 schema 2 migration, restart, engine changes and stopped restore preserve nodes and token digests', async (t) => {
  const temp = temporary(),
    backup = temporary();
  let settings, publisher;
  const converter = new ControlledConverter();
  t.after(async () => {
    await publisher?.close();
    settings?.close();
    temp.remove();
    backup.remove();
  });
  const old = new Database(join(temp.dir, 'submeld.sqlite'));
  old.exec(
    'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE nodes(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,model_version INTEGER NOT NULL,draft_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); PRAGMA user_version=2;',
  );
  const nodeId = randomUUID(),
    hash = await hashPassword('p3-only-test-password'),
    now = new Date().toISOString();
  old.prepare('INSERT INTO settings VALUES (?,?)').run('admin_password_hash', hash);
  old
    .prepare('INSERT INTO nodes VALUES (?,1,7,1,?,?,?)')
    .run(nodeId, JSON.stringify(controlledNode()), now, now);
  old.close();
  settings = openSettings(temp.dir, true);
  assert.equal(settings.getPasswordHash(), hash);
  assert.equal(settings.nodes.get(nodeId).revision, 7);
  publisher = new Publisher(settings.subscriptions, settings.nodes, settings.sources, converter);
  const sub = settings.subscriptions.create(config([{ kind: 'node', id: nodeId }]));
  await publisher.idle();
  const original = settings.subscriptions.read(sub.token, 'uri', ENGINE_VERSION).content;
  await publisher.close();
  settings.close();
  publisher = undefined;
  settings = undefined;
  const db = new Database(join(temp.dir, 'submeld.sqlite'));
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  assert.equal(
    db.prepare('SELECT token_hash FROM subscriptions').get().token_hash,
    createHash('sha256').update(sub.token).digest('hex'),
  );
  assert.throws(
    () =>
      db.prepare('INSERT INTO subscription_inputs VALUES (?,99,?,NULL)').run(sub.id, randomUUID()),
    /FOREIGN KEY/,
  );
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM subscriptions').all()).includes(sub.token));
  db.close();
  cpSync(temp.dir, backup.dir, { recursive: true });
  settings = openSettings(temp.dir, true);
  assert.equal(settings.subscriptions.read(sub.token, 'uri', ENGINE_VERSION).content, original);
  publisher = new Publisher(
    settings.subscriptions,
    settings.nodes,
    settings.sources,
    converter,
    'p3-test-new-engine',
  );
  missing(() => settings.subscriptions.read(sub.token, 'uri', publisher.engineVersion));
  publisher.start();
  await publisher.idle();
  assert.equal(
    settings.subscriptions.read(sub.token, 'uri', publisher.engineVersion).content,
    original,
  );
  const beforeCalls = converter.calls.length;
  const reset = settings.subscriptions.resetToken(sub.id, 1);
  assert.throws(() => settings.subscriptions.read(sub.token, 'uri', publisher.engineVersion), {
    status: 404,
  });
  assert.equal(
    settings.subscriptions.read(reset.token, 'uri', publisher.engineVersion).content,
    original,
  );
  assert.equal(converter.calls.length, beforeCalls);
  const restored = openSettings(backup.dir, true);
  assert.equal(restored.subscriptions.read(sub.token, 'uri', ENGINE_VERSION).content, original);
  const resetAfterRestore = restored.subscriptions.resetToken(sub.id, 1);
  assert.throws(() => restored.subscriptions.read(sub.token, 'uri', ENGINE_VERSION), {
    status: 404,
  });
  assert.equal(
    restored.subscriptions.read(resetAfterRestore.token, 'uri', ENGINE_VERSION).content,
    original,
  );
  restored.close();
});

test('P3 real HTTP management, private GET/HEAD, token reset, no-store and log redaction', async (t) => {
  const f = await setup(t, new Converter());
  const logs = [];
  t.mock.method(console, 'warn', (value) => logs.push(value));
  const auth = new Auth(await hashPassword('p3-http-only-password'));
  const configValue = { publicOrigin: 'http://127.0.0.1', dataDir: f.temp.dir, development: true };
  const app = createApp({
    config: configValue,
    auth,
    converter: f.converter,
    nodes: f.settings.nodes,
    sources: f.settings.sources,
    subscriptions: f.store,
    publisher: f.publisher,
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
    auth.close();
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  configValue.publicOrigin = origin;
  let cookie = '';
  const call = (path, method = 'GET', body, extra = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined
          ? { Origin: origin, 'Content-Type': 'application/json', 'X-SubMeld-Request': '1' }
          : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  for (const path of [
    '/api/sources',
    '/api/subscriptions',
    '/api/sources/no-id',
    '/api/subscriptions/no-id/artifacts/uri',
  ])
    assert.equal((await call(path)).status, 401);
  const login = await call('/api/auth/login', 'POST', { password: 'p3-http-only-password' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  for (const path of [
    '/api/sources',
    '/api/subscriptions',
    '/api/subscriptions/no-id/generate',
    '/api/subscriptions/no-id/reset-token',
  ]) {
    assert.equal((await call(path, 'POST', {}, { Origin: 'https://wrong.example' })).status, 403);
    assert.equal((await call(path, 'POST', {}, { 'X-SubMeld-Request': '' })).status, 403);
  }
  const sourceResponse = await call('/api/sources', 'POST', {
    name: 'HTTP text',
    format: 'uri',
    text: uri(controlledNode()),
  });
  assert.equal(sourceResponse.status, 201);
  const s = await sourceResponse.json();
  const created = await call('/api/subscriptions', 'POST', config([{ kind: 'source', id: s.id }]));
  assert.equal(created.status, 201);
  const value = await created.json(),
    id = value.subscription.id;
  await f.publisher.idle();
  const detail = await (await call('/api/subscriptions/' + id)).json();
  assert.ok(!('urls' in detail));
  assert.ok(!JSON.stringify(detail).includes(value.urls.uri));
  const uriResponse = await fetch(value.urls.uri),
    text = await uriResponse.text();
  assert.equal(uriResponse.status, 200);
  assert.match(uriResponse.headers.get('cache-control'), /private, no-store/);
  assert.equal(
    Buffer.from(await (await fetch(value.urls.base64)).text(), 'base64').toString('utf8'),
    text,
  );
  const beforeRun = f.converter.run;
  let readCalls = 0;
  f.converter.run = function (...args) {
    readCalls++;
    return beforeRun.apply(this, args);
  };
  for (const method of ['GET', 'HEAD']) {
    const result = await fetch(value.urls.uri, {
      method,
      headers: { Origin: 'https://client.example' },
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), method === 'HEAD' ? '' : text);
    assert.equal(result.headers.get('content-length'), String(Buffer.byteLength(text)));
  }
  assert.equal(readCalls, 0);
  const reset = await (
    await call('/api/subscriptions/' + id + '/reset-token', 'POST', { revision: detail.revision })
  ).json();
  assert.equal((await fetch(value.urls.uri)).status, 404);
  assert.equal(await (await fetch(reset.urls.uri)).text(), text);
  assert.equal(readCalls, 0);
  assert.equal(
    (await call('/api/subscriptions/' + id, 'PATCH', { revision: detail.revision, prefix: 'old' }))
      .status,
    409,
  );
  const updated = await call('/api/subscriptions/' + id, 'PATCH', {
    revision: reset.subscription.revision,
    includeName: 'nothing matches',
  });
  assert.equal(updated.status, 200);
  await f.publisher.idle();
  for (const method of ['GET', 'HEAD']) {
    const result = await fetch(reset.urls.uri, { method });
    assert.equal(result.status, 503);
    assert.match(result.headers.get('cache-control'), /no-store/);
    if (method === 'HEAD') assert.equal(await result.text(), '');
    for (const path of ['/s/invalid/uri', '/s/invalid/missing', '/s', '/s/missing']) {
      const missing = await fetch(origin + path, { method });
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get('content-type'), /json/);
      assert.match(missing.headers.get('cache-control'), /no-store/);
    }
  }
  assert.equal(
    (
      await call('/api/subscriptions/' + id + '/generate', 'POST', {
        revision: reset.subscription.revision + 1,
      })
    ).status,
    202,
  );
  await f.publisher.idle();
  const stopped = await call('/api/subscriptions/' + id, 'PATCH', {
    revision: reset.subscription.revision + 1,
    enabled: false,
  });
  assert.equal(stopped.status, 200);
  assert.equal((await fetch(reset.urls.uri)).status, 404);
  const token = new URL(value.urls.uri).pathname.split('/')[2],
    newToken = new URL(reset.urls.uri).pathname.split('/')[2];
  assert.ok(!logs.join('\n').includes(token));
  assert.ok(!logs.join('\n').includes(newToken));
  assert.ok(!logs.join('\n').includes(TEST_PASSWORD));
});
