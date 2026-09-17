import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { openSettings } from '../dist/server/database.js';
import { createApp } from '../dist/server/app.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { Converter } from '../dist/server/converter/pool.js';
import { Publisher } from '../dist/server/publisher.js';
import { node, TEST_PASSWORD } from './fixtures.mjs';
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'submeld-p2-'));
  return {
    dir,
    cleanup() {
      assert.ok(resolve(dir).startsWith(resolve(tmpdir())) && dir.includes('submeld-p2-'));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('P1 migration, atomic validation, secrets, revisions, disabled loads, restart and stopped restore', async () => {
  const source = temporary(),
    backup = temporary();
  let app;
  try {
    const old = new Database(join(source.dir, 'submeld.sqlite'));
    old.exec(
      'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;',
    );
    const hash = await hashPassword('p2-test-only-password');
    old.prepare('INSERT INTO settings VALUES (?,?)').run('admin_password_hash', hash);
    old.close();
    app = openSettings(source.dir, true);
    assert.equal(app.getPasswordHash(), hash);
    const a = node('hysteria2'),
      b = node('vless');
    const invalid = node('ss');
    invalid.auth.password = '';
    assert.throws(() => app.nodes.create({ drafts: [a, invalid] }), { status: 422 });
    assert.equal(app.nodes.list(0).total, 0);
    const created = app.nodes.create({ drafts: [a, b] }).nodes;
    assert.equal(created.length, 2);
    const [first, second] = created;
    assert.ok(!JSON.stringify(app.nodes.list(0)).includes(TEST_PASSWORD));
    assert.ok(!('draft' in first));
    let edited = app.nodes.update(first.id, { revision: 1, changes: { name: '持久修改' } });
    assert.equal(edited.draft.auth.password, TEST_PASSWORD);
    assert.throws(() => app.nodes.update(first.id, { revision: 1, changes: { name: '旧页面' } }), {
      status: 409,
    });
    assert.throws(() => app.nodes.delete(first.id, 1), { status: 409 });
    assert.throws(
      () => app.nodes.update(first.id, { revision: 2, changes: { auth: { password: null } } }),
      { status: 422 },
    );
    assert.equal(app.nodes.get(first.id).revision, 2);
    edited = app.nodes.update(first.id, {
      revision: 2,
      changes: { protocolOptions: { obfs: '', obfsPassword: null } },
    });
    assert.equal(edited.draft.protocolOptions.obfsPassword, '');
    assert.equal(edited.draft.auth.password, TEST_PASSWORD);
    assert.throws(
      () => app.nodes.update(first.id, { revision: 3, changes: { auth: { uuid: 'unexpected' } } }),
      { status: 400 },
    );
    assert.throws(() => app.nodes.update(first.id, { revision: 3, changes: { protocol: 'ss' } }), {
      status: 400,
    });
    const loaded = app.nodes.load({ ids: [second.id, first.id] });
    assert.equal(loaded.items[0].draft.protocol, 'vless');
    loaded.items[1].draft.auth.password = 'only-this-copy';
    assert.equal(app.nodes.get(first.id).draft.auth.password, TEST_PASSWORD);
    app.nodes.update(first.id, { revision: 3, enabled: false });
    assert.throws(() => app.nodes.load({ ids: [second.id, first.id] }), { code: 'NODE_DISABLED' });
    assert.throws(() => app.nodes.load({ ids: [second.id, second.id] }), { status: 400 });
    app.close();
    app = undefined;
    cpSync(source.dir, backup.dir, { recursive: true });
    const restored = openSettings(backup.dir, true);
    assert.equal(restored.getPasswordHash(), hash);
    assert.equal(restored.nodes.get(first.id).draft.name, '持久修改');
    assert.equal(restored.nodes.get(first.id).enabled, false);
    assert.equal(restored.nodes.get(first.id).revision, 4);
    restored.close();
    app = openSettings(source.dir, true);
    assert.equal(app.nodes.list(0).total, 2);
    app.nodes.delete(first.id, 4);
    assert.throws(() => app.nodes.get(first.id), { status: 404 });
  } finally {
    app?.close();
    source.cleanup();
    backup.cleanup();
  }
});
test('stored model version or malformed payload is never accepted as a valid draft', () => {
  const temp = temporary();
  let app;
  try {
    app = openSettings(temp.dir, true);
    const [{ id }] = app.nodes.create({ drafts: [node('ss')] }).nodes;
    app.close();
    app = undefined;
    const db = new Database(join(temp.dir, 'submeld.sqlite'));
    db.prepare('UPDATE nodes SET model_version=99 WHERE id=?').run(id);
    db.close();
    app = openSettings(temp.dir, true);
    assert.throws(() => app.nodes.get(id));
    app.close();
    app = undefined;
    const db2 = new Database(join(temp.dir, 'submeld.sqlite'));
    db2.prepare("UPDATE nodes SET model_version=1,draft_json='{}' WHERE id=?").run(id);
    db2.close();
    app = openSettings(temp.dir, true);
    assert.throws(() => app.nodes.get(id));
  } finally {
    app?.close();
    temp.cleanup();
  }
});
test('real HTTP node CRUD and render enforce auth, revision, same origin and secret-free lists', async () => {
  const temp = temporary();
  let db, auth, converter, server;
  try {
    db = openSettings(temp.dir, true);
    auth = new Auth(await hashPassword('p2-http-test-password'));
    converter = new Converter();
    await converter.ready;
    const config = { publicOrigin: 'http://127.0.0.1', development: true, dataDir: temp.dir };
    server = serve({
      fetch: createApp({
        config,
        auth,
        converter,
        nodes: db.nodes,
        chains: db.chains,
        sources: db.sources,
        subscriptions: db.subscriptions,
        publisher: new Publisher(db.subscriptions, db.nodes, db.sources, converter),
      }).fetch,
      hostname: '127.0.0.1',
      port: 0,
    });
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    config.publicOrigin = origin;
    let cookie = '';
    const call = (path, method = 'GET', body, extra = {}) =>
      fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-SubMeld-Request': '1',
          Cookie: cookie,
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const [path, method, body] of [
      ['/api/nodes', 'GET'],
      ['/api/nodes/test', 'GET'],
      ['/api/nodes', 'POST', {}],
      ['/api/nodes/load', 'POST', {}],
      ['/api/nodes/test', 'PATCH', {}],
      ['/api/nodes/test', 'DELETE', {}],
      ['/api/convert/render', 'POST', {}],
    ])
      assert.equal((await call(path, method, body)).status, 401);
    const login = await call('/api/auth/login', 'POST', { password: 'p2-http-test-password' });
    cookie = login.headers.get('set-cookie').split(';')[0];
    const create = await call('/api/nodes', 'POST', { drafts: [node('trojan')] });
    assert.equal(create.status, 201);
    const [{ id }] = (await create.json()).nodes;
    for (const method of ['POST', 'PATCH', 'DELETE'])
      assert.equal(
        (
          await call(
            method === 'POST' ? '/api/nodes' : '/api/nodes/' + id,
            method,
            {},
            { Origin: 'https://cross.example' },
          )
        ).status,
        403,
      );
    const list = await call('/api/nodes');
    assert.match(list.headers.get('cache-control'), /no-store/);
    assert.ok(!(await list.text()).includes(TEST_PASSWORD));
    const read = await call('/api/nodes/' + id);
    assert.equal((await read.json()).draft.auth.password, TEST_PASSWORD);
    assert.equal(
      (await call('/api/nodes/' + id, 'PATCH', { revision: 1, changes: { name: 'HTTP updated' } }))
        .status,
      200,
    );
    assert.equal(
      (await call('/api/nodes/' + id, 'PATCH', { revision: 1, changes: { name: 'stale' } })).status,
      409,
    );
    const loaded = await (await call('/api/nodes/load', 'POST', { ids: [id] })).json();
    assert.equal(loaded.items[0].draft.name, 'HTTP updated');
    const rendered = await call('/api/convert/render', 'POST', {
      items: loaded.items,
      target: 'mihomo',
    });
    assert.equal(rendered.status, 200);
    assert.match((await rendered.json()).full, /mixed-port: 1080/);
    assert.equal(
      (await call('/api/convert/render', 'POST', { items: loaded.items, target: 'xray' })).status,
      422,
    );
    assert.equal((await call('/api/nodes/' + id, 'DELETE', { revision: 1 })).status, 409);
    assert.equal((await call('/api/nodes/' + id, 'DELETE', { revision: 2 })).status, 200);
    assert.equal((await call('/api/nodes/' + id)).status, 404);
    await call('/api/auth/logout', 'POST', {});
    assert.equal((await call('/api/nodes')).status, 401);
  } finally {
    if (server) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    await converter?.close();
    auth?.close();
    db?.close();
    temp.cleanup();
  }
});
