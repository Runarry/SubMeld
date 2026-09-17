import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { openSettings } from '../dist/server/database.js';
import { SourceRefresher } from '../dist/server/source-refresher.js';
import { Publisher } from '../dist/server/publisher.js';
import { ENGINE_VERSION } from '../dist/server/subscriptions.js';
import { AppError } from '../dist/server/errors.js';
import { Converter } from '../dist/server/converter/pool.js';
import { createApp } from '../dist/server/app.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { parseInput, produceInput } from '../dist/server/converter/engine.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';
import { ControlledConverter, deferred } from './publication-fixtures.mjs';
import { node, items } from './fixtures.mjs';

function uri(name = 'remote original', protocol = 'vless') {
  const draft = node(protocol);
  draft.name = name;
  draft.tls.insecure = false;
  return produceInput({ items: items(draft) }).uri;
}
class ControlledFetcher {
  calls = [];
  content = uri();
  error;
  next;
  active = 0;
  maximum = 0;
  hold(error) {
    const entered = deferred(),
      release = deferred();
    this.next = { entered, release, error };
    return { entered: entered.promise, release: release.resolve };
  }
  async fetch(input, signal) {
    this.calls.push({ ...input, signal });
    this.active++;
    this.maximum = Math.max(this.maximum, this.active);
    const content = this.content,
      error = this.error,
      gate = this.next;
    this.next = undefined;
    try {
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
        if (gate.error) throw gate.error;
      }
      if (error) throw error;
      return content;
    } finally {
      this.active--;
    }
  }
}
function fakeClock() {
  let now = Date.now(),
    fn,
    intervalMs;
  return {
    now: () => now,
    setInterval(callback, ms) {
      fn = callback;
      intervalMs = ms;
      return { unref() {} };
    },
    clearInterval() {
      fn = undefined;
    },
    tick() {
      assert.equal(intervalMs, 21600000);
      now += intervalMs;
      fn?.();
    },
    get active() {
      return !!fn;
    },
  };
}
async function setup(t, converter = new ControlledConverter()) {
  const directory = mkdtempSync(join(tmpdir(), 'submeld-p4-'));
  const settings = openSettings(directory, true),
    fetcher = new ControlledFetcher(),
    time = fakeClock();
  await converter.ready;
  const publisher = new Publisher(
    settings.subscriptions,
    settings.nodes,
    settings.sources,
    converter,
  );
  const refresher = new SourceRefresher(settings.sources, converter, fetcher, time);
  t.after(async () => {
    fetcher.next?.release.resolve();
    await refresher.close();
    await publisher.close();
    await converter.close?.();
    settings.close();
    const rel = relative(tmpdir(), directory);
    assert.ok(rel.startsWith('submeld-p4-') && !isAbsolute(rel) && !rel.startsWith('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    settings,
    fetcher,
    time,
    converter,
    publisher,
    refresher,
    source: (extra = {}) =>
      settings.sources.create(
        {
          kind: 'remote',
          name: 'remote',
          format: 'auto',
          url: 'https://source.test/sub?test-only-token',
          headers: { authorization: 'Bearer fixture-only' },
          ...extra,
        },
        converter,
      ),
    read: (sub, format = 'uri') =>
      settings.subscriptions.read(sub.token, format, ENGINE_VERSION, sub.key),
    async settle() {
      await refresher.idle();
      await publisher.idle();
    },
    subscribe(source, extra = {}) {
      return settings.subscriptions.create({
        ...newSubscription(),
        name: 'remote subscription',
        inputs: [{ kind: 'source', id: source.id }],
        ...extra,
      });
    },
  };
}
test('P4 remote creation retains failed configuration, only successful snapshots can be newly referenced, and secrets stay out of lists', async (t) => {
  const f = await setup(t);
  f.fetcher.error = new AppError('SOURCE_HTTP_FAILED', '来源返回 HTTP 401。');
  const source = await f.source();
  await f.settle();
  const failed = f.settings.sources.get(source.id);
  assert.equal(failed.savedAt, null);
  assert.equal(failed.revision, 1);
  assert.equal(failed.error.code, 'SOURCE_HTTP_FAILED');
  assert.throws(() => f.subscribe(source), { code: 'SOURCE_SNAPSHOT_MISSING' });
  const list = JSON.stringify(f.settings.sources.list(0));
  for (const secret of ['source.test', 'fixture-only', 'test-only-token', 'snapshot_json'])
    assert.ok(!list.includes(secret));
  f.fetcher.error = undefined;
  f.settings.sources.requestRefresh(source.id, 1);
  await f.settle();
  const success = f.settings.sources.get(source.id);
  assert.equal(success.revision, 1, 'background updates do not conflict with config edits');
  assert.ok(success.savedAt);
  assert.equal(success.error, null);
  assert.equal(success.nodeCount, 1);
  const sub = f.subscribe(source);
  await f.settle();
  assert.match(decodeURIComponent(f.read(sub).content), /remote original/);
  await assert.rejects(
    f.settings.sources.update(source.id, { revision: 1, text: 'not allowed' }, f.converter),
    { status: 400 },
  );
  await assert.rejects(
    f.settings.sources.update(source.id, { revision: 1, kind: 'text' }, f.converter),
    { status: 400 },
  );
});
test('P4 manual and timed refresh failures preserve successful snapshots and publication timestamps', async (t) => {
  const f = await setup(t),
    source = await f.source();
  await f.settle();
  const sub = f.subscribe(source);
  await f.settle();
  const before = f.settings.sources.get(source.id),
    artifact = f.read(sub);
  f.refresher.start();
  await f.settle();
  const stable = f.settings.sources.get(source.id),
    output = f.read(sub);
  for (const failure of [
    new AppError('SOURCE_HTTP_FAILED', '来源返回 HTTP 403。'),
    new AppError('SOURCE_HTTP_FAILED', '来源返回 HTTP 503。'),
    new AppError('SOURCE_TLS_FAILED', '来源 HTTPS 验证失败。'),
    '',
    '<html>error</html>',
    uri() + '\ntrojan://broken',
  ]) {
    f.fetcher.error = failure instanceof Error ? failure : undefined;
    if (typeof failure === 'string') f.fetcher.content = failure;
    f.settings.sources.requestRefresh(source.id, 1);
    await f.settle();
    const failed = f.settings.sources.get(source.id);
    assert.equal(failed.savedAt, stable.savedAt);
    assert.deepEqual(failed.items, stable.items);
    assert.ok(failed.error);
    assert.equal(f.read(sub).content, output.content);
    assert.equal(f.read(sub).generatedAt, output.generatedAt);
  }
  f.time.tick();
  await f.settle();
  assert.equal(f.read(sub).content, artifact.content);
  assert.ok(before.savedAt);
});
test('P4 accepted snapshots advance subscription revision while old formats stay readable until independent replacements succeed', async (t) => {
  const f = await setup(t),
    source = await f.source();
  await f.settle();
  const sub = f.subscribe(source, { formats: ['uri', 'base64', 'mihomo', 'xray'] });
  await f.settle();
  const old = Object.fromEntries(
    ['uri', 'base64', 'mihomo', 'xray'].map((format) => [format, f.read(sub, format)]),
  );
  const gate = f.converter.hold();
  const foreground = f.converter.run({ kind: 'parse', input: { format: 'uri', text: uri() } });
  await gate.entered;
  const text = uri('new HY2', 'hysteria2');
  assert.equal(
    f.settings.sources.accept(
      source.id,
      1,
      text,
      parseInput({ format: 'uri', text }),
      new Date().toISOString(),
    ),
    true,
  );
  assert.equal(f.settings.subscriptions.get(sub.id).revision, 2);
  for (const format of Object.keys(old))
    assert.equal(f.read(sub, format).content, old[format].content);
  gate.release();
  await foreground;
  await f.settle();
  assert.match(decodeURIComponent(f.read(sub).content), /new HY2/);
  assert.equal(
    Buffer.from(f.read(sub, 'base64').content, 'base64').toString('utf8'),
    f.read(sub).content,
  );
  assert.notEqual(f.read(sub, 'mihomo').content, old.mihomo.content);
  assert.equal(f.read(sub, 'xray').content, old.xray.content);
  assert.equal(f.read(sub, 'xray').generatedAt, old.xray.generatedAt);
  assert.ok(f.read(sub, 'xray').error);
  const currentSub = f.settings.subscriptions.get(sub.id);
  f.settings.subscriptions.update(sub.id, { revision: currentSub.revision, prefix: 'manual-' });
  assert.throws(() => f.read(sub, 'xray'), { status: 503 });
  await f.settle();
  assert.throws(() => f.read(sub, 'xray'), { status: 503 });
});
for (const outcome of ['success', 'error']) {
  test(
    'P4 delayed fetch ' +
      outcome +
      ' cannot restore snapshots after URL, credentials, format, disable or delete changes',
    async (t) => {
      const f = await setup(t);
      for (const mutation of ['url', 'headers', 'format', 'disable', 'delete']) {
        f.fetcher.error = undefined;
        f.fetcher.content = uri('old source');
        const source = await f.source({ name: mutation });
        await f.settle();
        const sub = f.subscribe(source);
        await f.settle();
        const gate = f.fetcher.hold(
          outcome === 'error' ? new AppError('OLD_ERROR', 'old failure') : undefined,
        );
        f.settings.sources.requestRefresh(source.id, 1);
        await gate.entered;
        f.fetcher.error = new AppError('NEW_ERROR', 'new attempt failed');
        if (mutation === 'delete') f.settings.sources.delete(source.id, 1);
        else
          await f.settings.sources.update(
            source.id,
            {
              revision: 1,
              ...(mutation === 'url'
                ? { url: 'https://source.test/changed' }
                : mutation === 'headers'
                  ? { headers: { authorization: 'Bearer updated-only-fixture' } }
                  : mutation === 'format'
                    ? { format: 'yaml' }
                    : { enabled: false }),
            },
            f.converter,
          );
        assert.equal(f.fetcher.calls.at(-1).signal.aborted, true);
        assert.throws(() => f.read(sub), { status: 503 });
        gate.release();
        await f.settle();
        assert.throws(() => f.read(sub), { status: 503 });
        if (mutation !== 'delete') {
          const after = f.settings.sources.get(source.id);
          assert.notEqual(after.error?.code, 'OLD_ERROR');
          if (mutation !== 'disable') {
            assert.equal(after.savedAt, null);
            assert.equal(after.items.length, 0);
          }
        } else assert.equal(f.settings.subscriptions.get(sub.id).inputs.length, 0);
      }
    },
  );
}
for (const outcome of ['success', 'error']) {
  test(
    'P4 delayed generated ' + outcome + ' cannot publish after source configuration invalidation',
    async (t) => {
      const f = await setup(t),
        source = await f.source();
      await f.settle();
      const sub = f.subscribe(source);
      await f.settle();
      const gate = f.converter.hold(
        outcome === 'error' ? new AppError('OLD_GENERATION', 'old generation') : undefined,
      );
      f.publisher.schedule([sub.id]);
      await gate.entered;
      f.fetcher.error = new AppError('SOURCE_HTTP_FAILED', '新来源失败。');
      await f.settings.sources.update(
        source.id,
        { revision: 1, url: 'https://source.test/new' },
        f.converter,
      );
      assert.throws(() => f.read(sub), { status: 503 });
      gate.release();
      await f.settle();
      assert.throws(() => f.read(sub), { status: 503 });
      assert.ok(
        !JSON.stringify(f.settings.subscriptions.detail(sub.id, ENGINE_VERSION, 'idle')).includes(
          'OLD_GENERATION',
        ),
      );
    },
  );
}
test('P4 six-hour scheduler and repeated requests coalesce, remain sequential, and wait for the sole Worker without refetching', async (t) => {
  const f = await setup(t);
  const gate = f.fetcher.hold(),
    a = await f.source();
  await gate.entered;
  const b = await f.source({ name: 'second' }),
    disabled = await f.source({ enabled: false });
  for (let i = 0; i < 100; i++) f.settings.sources.requestRefresh(a.id, 1);
  assert.equal(f.fetcher.calls.length, 1);
  assert.equal(f.settings.sources.get(b.id).refresh, 'queued');
  assert.throws(() => f.settings.sources.requestRefresh(disabled.id, 1), {
    code: 'SOURCE_NOT_REFRESHABLE',
  });
  gate.release();
  await f.settle();
  assert.equal(f.fetcher.calls.length, 2);
  assert.equal(f.fetcher.maximum, 1);
  f.refresher.start();
  await f.settle();
  assert.equal(f.fetcher.calls.length, 4);
  f.refresher.start();
  await f.settle();
  assert.equal(f.fetcher.calls.length, 4);
  f.time.tick();
  await f.settle();
  assert.equal(f.fetcher.calls.length, 6);
  const workerGate = f.converter.hold();
  const foreground = f.converter.run({ kind: 'parse', input: { format: 'uri', text: uri() } });
  await workerGate.entered;
  const fetched = deferred();
  const original = f.fetcher.fetch.bind(f.fetcher);
  f.fetcher.fetch = async (...args) => {
    const value = await original(...args);
    fetched.resolve();
    return value;
  };
  f.settings.sources.requestRefresh(a.id, 1);
  await fetched.promise;
  assert.equal(f.settings.sources.get(a.id).refresh, 'running');
  workerGate.release();
  await foreground;
  await f.settle();
  assert.equal(f.fetcher.calls.length, 7);
  await f.refresher.close();
  assert.equal(f.time.active, false);
});
test('P4 real HTTP refresh requires same-origin login and revision; subscription GET/HEAD and generate never fetch', async (t) => {
  const f = await setup(t, new Converter()),
    logs = [];
  t.mock.method(console, 'warn', (value) => logs.push(value));
  const auth = new Auth(await hashPassword('P4-http-fixture-only'));
  const config = { publicOrigin: 'http://127.0.0.1', development: true, dataDir: f.directory };
  const app = createApp({
    config,
    auth,
    converter: f.converter,
    nodes: f.settings.nodes,
    chains: f.settings.chains,
    sources: f.settings.sources,
    subscriptions: f.settings.subscriptions,
    publisher: f.publisher,
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
    auth.close();
  });
  const origin = (config.publicOrigin = 'http://127.0.0.1:' + server.address().port);
  let cookie = '';
  const call = (path, method = 'GET', body, headers = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(body
          ? { Origin: origin, 'Content-Type': 'application/json', 'X-SubMeld-Request': '1' }
          : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await call('/api/sources/none/refresh', 'POST', { revision: 1 })).status, 401);
  const login = await call('/api/auth/login', 'POST', { password: 'P4-http-fixture-only' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const source = await (
    await call('/api/sources', 'POST', {
      kind: 'remote',
      name: 'HTTP remote',
      format: 'auto',
      url: 'https://source.test/sub?secret-test',
      headers: { authorization: 'Bearer test-only' },
    })
  ).json();
  await f.settle();
  const path = '/api/sources/' + source.id + '/refresh';
  assert.equal(
    (await call(path, 'POST', { revision: 1 }, { Origin: 'https://other.test' })).status,
    403,
  );
  assert.equal(
    (await call(path, 'POST', { revision: 1 }, { 'X-SubMeld-Request': '' })).status,
    403,
  );
  assert.equal((await call(path, 'POST', { revision: 999 })).status, 409);
  assert.equal((await call(path, 'POST', { revision: 1 })).status, 202);
  await f.settle();
  const sub = f.subscribe(source);
  await f.settle();
  const count = f.fetcher.calls.length;
  for (const method of ['GET', 'HEAD']) {
    const result = await call('/s/' + sub.token + '/uri?key=' + sub.key, method);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('cache-control'), /private, no-store/);
    if (method === 'HEAD') assert.equal(await result.text(), '');
  }
  assert.equal(
    (await call('/api/subscriptions/' + sub.id + '/generate', 'POST', { revision: 1 })).status,
    202,
  );
  await f.settle();
  assert.equal(f.fetcher.calls.length, count);
  assert.equal(
    (
      await call('/api/sources/' + source.id, 'PATCH', {
        revision: 1,
        headers: { authorization: null },
      })
    ).status,
    200,
  );
  assert.equal(f.settings.sources.get(source.id).headers.authorization, '');
  await f.settle();
  assert.ok(!JSON.stringify(logs).includes('secret-test'));
  assert.ok(!JSON.stringify(logs).includes('Bearer test-only'));
});
test('P4 schema 3 migration preserves source IDs, references, password, snapshots and token authorization across restart and backup restore', async (t) => {
  const f = await setup(t);
  await f.refresher.close();
  await f.publisher.close();
  f.settings.close();
  const db = new Database(join(f.directory, 'submeld.sqlite'));
  // Rebuild the changed tables in their P3 shape before exercising the upgrade.
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE subscription_inputs; DROP TABLE chains;
    CREATE TABLE subscription_inputs (
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position>=0),
      node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
      PRIMARY KEY(subscription_id,position), CHECK((node_id IS NULL)!=(source_id IS NULL)));
    CREATE INDEX subscription_node ON subscription_inputs(node_id);
    CREATE INDEX subscription_source ON subscription_inputs(source_id);`);
  db.exec(
    'DROP TABLE sources; CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,model_version INTEGER NOT NULL,format TEXT NOT NULL,text TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,saved_at TEXT NOT NULL); PRAGMA user_version=3;',
  );
  const id = randomUUID(),
    subId = randomUUID(),
    token = 'p4-migration-test-only-token'.padEnd(43, 'x'),
    text = uri(),
    now = new Date().toISOString();
  db.prepare('INSERT INTO sources VALUES (?,?,1,7,1,?,?,?,?,?,?)').run(
    id,
    'old text',
    'uri',
    text,
    JSON.stringify(parseInput({ format: 'uri', text })),
    now,
    now,
    now,
  );
  const hash = await hashPassword('p4-migration-password-fixture');
  db.prepare('INSERT INTO settings VALUES (?,?)').run('admin_password_hash', hash);
  db.prepare(
    'INSERT INTO subscriptions(id,name,enabled,revision,config_json,token_hash,created_at,updated_at) VALUES (?,?,1,1,?,?,?,?)',
  ).run(
    subId,
    'old subscription',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(newSubscription()).filter(
          ([key]) => !['name', 'enabled', 'inputs'].includes(key),
        ),
      ),
    ),
    createHash('sha256').update(token).digest('hex'),
    now,
    now,
  );
  db.prepare('INSERT INTO subscription_inputs VALUES (?,0,NULL,?)').run(subId, id);
  db.close();
  const backup = resolve(f.directory, 'stopped-backup');
  const upgrade = openSettings(f.directory, true);
  assert.equal(upgrade.getPasswordHash(), hash);
  assert.equal(upgrade.sources.get(id).kind, 'text');
  assert.equal(upgrade.sources.get(id).revision, 7);
  assert.equal(upgrade.sources.get(id).text, text);
  assert.deepEqual(upgrade.subscriptions.get(subId).inputs, [{ kind: 'source', id }]);
  const publisher = new Publisher(
    upgrade.subscriptions,
    upgrade.nodes,
    upgrade.sources,
    f.converter,
  );
  publisher.start();
  await publisher.idle();
  assert.equal(upgrade.subscriptions.read(token, 'uri', ENGINE_VERSION).content, text);
  await publisher.close();
  upgrade.close();
  // Copy only the stopped database; this fixture has no outstanding WAL after close.
  cpSync(join(f.directory, 'submeld.sqlite'), backup);
  const restarted = openSettings(f.directory, true);
  assert.equal(restarted.subscriptions.read(token, 'uri', ENGINE_VERSION).content, text);
  restarted.close();
  const check = new Database(join(f.directory, 'submeld.sqlite'));
  assert.equal(check.pragma('user_version', { simple: true }), 6);
  assert.deepEqual(check.pragma('foreign_key_check'), []);
  check.close();
  cpSync(backup, join(f.directory, 'submeld.sqlite'));
  const restored = openSettings(f.directory, true);
  assert.equal(restored.subscriptions.read(token, 'uri', ENGINE_VERSION).content, text);
  const reset = restored.subscriptions.resetToken(subId, 1);
  assert.throws(() => restored.subscriptions.read(token, 'uri', ENGINE_VERSION), { status: 404 });
  assert.throws(() => restored.subscriptions.read(reset.token, 'uri', ENGINE_VERSION), {
    status: 404,
  });
  assert.equal(
    restored.subscriptions.read(reset.token, 'uri', ENGINE_VERSION, reset.key).content,
    text,
  );
  restored.close();
});
