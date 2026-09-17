import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { parse } from 'yaml';
import { openSettings } from '../dist/server/database.js';
import { Publisher, composeItems } from '../dist/server/publisher.js';
import { ENGINE_VERSION } from '../dist/server/subscriptions.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { renderInput } from '../dist/server/converter/render.js';
import { Converter } from '../dist/server/converter/pool.js';
import { createApp } from '../dist/server/app.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { AppError } from '../dist/server/errors.js';
import { MAX_NODES } from '../dist/server/shared/contracts.js';
import { node, items, TEST_PASSWORD } from './fixtures.mjs';
import { chainItem, chainFixtures } from './chain-fixtures.mjs';
import { ControlledConverter } from './publication-fixtures.mjs';

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'submeld-chain-'));
  const settings = openSettings(dir, true),
    converter = new ControlledConverter();
  const publisher = new Publisher(
    settings.subscriptions,
    settings.nodes,
    settings.sources,
    converter,
  );
  t.after(async () => {
    await publisher.close();
    settings.close();
    const rel = relative(tmpdir(), dir);
    assert.ok(rel.startsWith('submeld-chain-') && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(dir, { recursive: true, force: true });
  });
  const [entry, exit] = settings.nodes.create({
    drafts: [node('ss'), { ...node('ss'), name: 'exit' }],
  }).nodes;
  const chain = settings.chains.create({
    name: 'Saved chain',
    entryNodeId: entry.id,
    exitNodeId: exit.id,
  });
  return { dir, settings, converter, publisher, entry, exit, chain, store: settings.subscriptions };
}
function subConfig(inputs, extra = {}) {
  return {
    ...newSubscription(),
    name: 'chain plan',
    formats: [...outputFormats],
    inputs,
    ...extra,
  };
}
const artifact = (f, id, format = 'mihomo') => f.store.artifact(id, format, ENGINE_VERSION);
const inputChain = (f) => ({ kind: 'chain', id: f.chain.id });

for (const target of ['mihomo', 'singbox', 'xray']) {
  test(
    target + ' renders ordered independent chains with correct direction and hidden helpers',
    () => {
      const input = [
        chainItem(),
        ...items({ ...node('ss'), name: 'two hop' }).map((i) => ({ ...i, nodeIndex: 1 })),
        ...chainFixtures(target, 2),
      ];
      const before = structuredClone(input);
      const result = renderInput({ target, items: input });
      assert.deepEqual(input, before);
      assert.deepEqual(renderInput({ target, items: input }), result);
      assert.equal(result.counts.output, input.length);
      const full = target === 'mihomo' ? parse(result.full) : JSON.parse(result.full);
      const fragment = target === 'mihomo' ? parse(result.nodes) : JSON.parse(result.nodes);
      const outputs = fragment.proxies ?? fragment.outbounds;
      const name = (n) => n.name ?? n.tag;
      assert.equal(new Set(outputs.map(name)).size, outputs.length);
      assert.equal(name(outputs[0]), 'two hop');
      assert.equal(name(outputs[1]), 'two hop · 前置');
      assert.equal(name(outputs[2]), 'two hop (2)');
      if (target === 'mihomo') {
        assert.equal(outputs[0]['dialer-proxy'], name(outputs[1]));
        assert.ok(!full['proxy-groups'][0].proxies.includes(name(outputs[1])));
        assert.equal(full['proxy-groups'][0].proxies[0], name(outputs[0]));
        assert.deepEqual(full.proxies, outputs);
        for (let i = 0; i < outputs.length; i++)
          if (['hysteria2', 'tuic'].includes(outputs[i].type) && outputs[i]['dialer-proxy'])
            assert.equal(outputs.find((n) => name(n) === outputs[i]['dialer-proxy']).udp, true);
      } else if (target === 'singbox') {
        assert.equal(outputs[0].detour, name(outputs[1]));
        assert.equal(full.outbounds[0].default, name(outputs[0]));
        assert.ok(!full.outbounds[0].outbounds.includes(name(outputs[1])));
        assert.deepEqual(full.outbounds.slice(1), outputs);
      } else {
        assert.equal(outputs[0].streamSettings.sockopt.dialerProxy, name(outputs[1]));
        assert.equal(full.routing.rules[0].outboundTag, name(outputs[0]));
        assert.deepEqual(full.outbounds, outputs);
      }
    },
  );
}

test('chain validation rejects disabled members, unsupported hops and expanded limits without partial output', () => {
  const disabled = { ...chainItem(), available: false };
  assert.throws(
    () => renderInput({ target: 'mihomo', items: [disabled] }),
    (e) => e.diagnostics.some((d) => d.code === 'CHAIN_NODE_DISABLED'),
  );
  const unsupported = chainItem('hysteria2', 'ss');
  assert.throws(
    () => renderInput({ target: 'xray', items: [unsupported] }),
    (e) => e.diagnostics.some((d) => d.code === 'TARGET_UNSUPPORTED' && d.field === 'entry'),
  );
  unsupported.excluded = true;
  assert.equal(
    renderInput({ target: 'xray', items: [unsupported, { ...items(node('ss'))[0], nodeIndex: 1 }] })
      .counts.output,
    1,
  );
  const tooMany = Array.from({ length: MAX_NODES / 2 + 1 }, (_, i) => chainItem('ss', 'ss', i));
  assert.throws(() => renderInput({ target: 'mihomo', items: tooMany }), { status: 413 });
  const duplicate = [chainItem(), chainItem()];
  assert.throws(() => renderInput({ target: 'mihomo', items: duplicate }), { status: 400 });
  const invalid = chainItem();
  invalid.exit.port = 0;
  assert.throws(
    () => renderInput({ target: 'mihomo', items: [invalid] }),
    (e) => e.diagnostics.some((d) => d.field === 'exit.port'),
  );
});

test('chain filters operate on chain name and both protocols, never split the two hops', () => {
  const chain = chainItem('ss', 'vless');
  const config = subConfig([], { includeName: 'two', prefix: 'pre-', suffix: '-post' });
  let result = composeItems(config, [chain], 'mihomo');
  assert.equal(result[0].name, 'pre-two hop-post');
  assert.equal(result[0].entry.name, 'entry');
  config.protocols.mihomo = ['ss'];
  result = composeItems(config, [chain], 'mihomo');
  assert.equal(result[0].excluded, true);
  assert.equal(result[0].name, 'two hop');
  assert.equal(composeItems(config, [chain], 'uri')[0].diagnostics[0].code, 'CHAIN_URI_EXCLUDED');
});

test('chains store references, reject invalid edits and protect referenced nodes without exposing secrets', async (t) => {
  const f = await setup(t),
    { chains, nodes } = f.settings;
  assert.ok(!JSON.stringify(chains.list(0)).includes(TEST_PASSWORD));
  assert.ok(!('draft' in chains.get(f.chain.id).entry));
  assert.throws(
    () => chains.create({ name: 'same', entryNodeId: f.entry.id, exitNodeId: f.entry.id }),
    { code: 'CHAIN_SAME_NODE' },
  );
  assert.throws(
    () => chains.create({ name: 'missing', entryNodeId: f.entry.id, exitNodeId: randomUUID() }),
    { code: 'INVALID_INPUT_REFERENCE' },
  );
  const swapped = chains.update(f.chain.id, {
    revision: 1,
    entryNodeId: f.exit.id,
    exitNodeId: f.entry.id,
  });
  assert.equal(swapped.entry.id, f.exit.id);
  assert.throws(() => chains.update(f.chain.id, { revision: 1, name: 'stale' }), { status: 409 });
  assert.throws(
    () => nodes.delete(f.entry.id, 1),
    (e) => e.code === 'NODE_IN_USE' && e.message.includes('Saved chain'),
  );
  assert.equal(nodes.get(f.entry.id).revision, 1);
  const subscription = f.store.create(subConfig([inputChain(f)]));
  await f.publisher.idle();
  chains.delete(f.chain.id, 2);
  assert.deepEqual(f.store.get(subscription.id).inputs, []);
  assert.throws(() => artifact(f, subscription.id), { status: 503 });
  nodes.delete(f.entry.id, 1);
  assert.equal(nodes.get(f.exit.id).id, f.exit.id);
});

test('publication explicitly filters URI chains, blocks disabled hops per target and invalidates indirect dependencies once', async (t) => {
  const f = await setup(t);
  const other = f.settings.chains.create({
    name: 'other',
    entryNodeId: f.exit.id,
    exitNodeId: f.entry.id,
  });
  const sub = f.store.create(
    subConfig([inputChain(f), { kind: 'node', id: f.entry.id }, { kind: 'chain', id: other.id }]),
  );
  await f.publisher.idle();
  const uri = artifact(f, sub.id, 'uri'),
    base64 = artifact(f, sub.id, 'base64');
  assert.deepEqual(uri.counts, { input: 3, output: 1, filtered: 2 });
  assert.equal(uri.diagnostics.filter((d) => d.code === 'CHAIN_URI_EXCLUDED').length, 2);
  assert.equal(Buffer.from(base64.content, 'base64').toString('utf8'), uri.content);
  assert.equal(artifact(f, sub.id).counts.output, 3);
  const revision = f.store.get(sub.id).revision;
  f.settings.nodes.update(f.exit.id, {
    revision: 1,
    changes: { name: 'changed exit', auth: { password: 'changed-test-secret' } },
  });
  assert.equal(f.store.get(sub.id).revision, revision + 1);
  assert.throws(() => artifact(f, sub.id), { status: 503 });
  await f.publisher.idle();
  assert.match(artifact(f, sub.id).content, /changed-test-secret/);
  f.settings.nodes.update(f.exit.id, { revision: 2, enabled: false });
  await f.publisher.idle();
  assert.equal(f.settings.chains.get(f.chain.id).available, false);
  assert.throws(() => artifact(f, sub.id), { status: 503 });
  assert.equal(artifact(f, sub.id, 'uri').counts.output, 1);
  assert.ok(
    f.store
      .detail(sub.id, ENGINE_VERSION, 'idle')
      .artifacts.find((a) => a.format === 'mihomo')
      .error.diagnostics.some((d) => d.code === 'CHAIN_NODE_DISABLED'),
  );
  f.settings.chains.update(f.chain.id, { revision: 1, enabled: false });
  f.settings.chains.update(other.id, { revision: 1, enabled: false });
  await f.publisher.idle();
  assert.equal(artifact(f, sub.id).counts.output, 1);
  const only = f.store.create(subConfig([inputChain(f)]));
  f.settings.chains.update(f.chain.id, { revision: 2, enabled: true });
  f.settings.nodes.update(f.exit.id, { revision: 3, enabled: true });
  await f.publisher.idle();
  assert.equal(artifact(f, only.id).counts.output, 1);
  const failure = f.store
    .detail(only.id, ENGINE_VERSION, 'idle')
    .artifacts.find((a) => a.format === 'uri').error;
  assert.equal(failure.code, 'EMPTY_OUTPUT');
  assert.equal(failure.diagnostics[0].code, 'CHAIN_URI_EXCLUDED');
});

for (const staleError of [false, true])
  test('old chain generation cannot commit ' + (staleError ? 'errors' : 'success'), async (t) => {
    const f = await setup(t);
    const sub = f.store.create(subConfig([inputChain(f)], { formats: ['mihomo'] }));
    await f.publisher.idle();
    const gate = f.converter.hold(staleError ? new AppError('STALE_FAILURE', 'stale') : undefined);
    f.publisher.schedule([sub.id]);
    await gate.entered;
    f.settings.nodes.update(f.entry.id, {
      revision: 1,
      changes: { auth: { password: 'new-entry-secret' } },
    });
    assert.throws(() => artifact(f, sub.id), { status: 503 });
    gate.release();
    await f.publisher.idle();
    assert.match(artifact(f, sub.id).content, /new-entry-secret/);
    assert.equal(artifact(f, sub.id).builtRevision, f.store.get(sub.id).revision);
    assert.equal(artifact(f, sub.id).error, null);
  });

test('schema 5 migrates references, snapshots and both token digests once; new chains survive restart', async (t) => {
  const f = await setup(t);
  f.settings.chains.delete(f.chain.id, 1);
  const source = await f.settings.sources.create(
    {
      name: 'source',
      text:
        'ss://' + Buffer.from('aes-128-gcm:fixture').toString('base64') + '@example.com:443#test',
      format: 'uri',
    },
    f.converter,
  );
  const sub = f.store.create(
    subConfig(
      [
        { kind: 'source', id: source.id },
        { kind: 'node', id: f.entry.id },
      ],
      { formats: ['uri'] },
    ),
  );
  await f.publisher.idle();
  const before = f.store.get(sub.id),
    body = artifact(f, sub.id, 'uri').content;
  const snapshot = f.settings.sources.get(source.id);
  f.settings.setPasswordHash('$argon2id$schema-fixture');
  await f.publisher.close();
  f.settings.close();
  const database = new Database(join(f.dir, 'submeld.sqlite'));
  database.exec(`CREATE TABLE old_inputs (
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position>=0),
    node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
    PRIMARY KEY(subscription_id,position), CHECK((node_id IS NULL)!=(source_id IS NULL)));
    INSERT INTO old_inputs SELECT subscription_id,position,node_id,source_id FROM subscription_inputs;
    DROP TABLE subscription_inputs;
    ALTER TABLE old_inputs RENAME TO subscription_inputs;
    CREATE INDEX subscription_node ON subscription_inputs(node_id);
    CREATE INDEX subscription_source ON subscription_inputs(source_id);
    DROP TABLE chains; PRAGMA user_version=5;`);
  database.close();
  let reopened = openSettings(f.dir, true);
  try {
    assert.deepEqual(reopened.subscriptions.get(sub.id), before);
    assert.deepEqual(reopened.sources.get(source.id), snapshot);
    assert.equal(reopened.getPasswordHash(), '$argon2id$schema-fixture');
    assert.equal(
      reopened.subscriptions.read(sub.token, 'uri', ENGINE_VERSION, sub.key).content,
      body,
    );
    const chain = reopened.chains.create({
      name: 'after upgrade',
      entryNodeId: f.entry.id,
      exitNodeId: f.exit.id,
    });
    reopened.close();
    reopened = openSettings(f.dir, true);
    assert.deepEqual(reopened.chains.get(chain.id), chain);
    assert.equal(
      reopened.subscriptions.read(sub.token, 'uri', ENGINE_VERSION, sub.key).content,
      body,
    );
  } finally {
    reopened.close();
  }
  const check = new Database(join(f.dir, 'submeld.sqlite'));
  assert.equal(check.pragma('user_version', { simple: true }), 7);
  assert.deepEqual(check.pragma('foreign_key_check'), []);
  check.close();
});

test('real Worker accepts chain render items and preserves ordinary URI requests', async () => {
  const converter = new Converter();
  try {
    await converter.ready;
    assert.equal(
      (await converter.run({ kind: 'render', input: { items: [chainItem()], target: 'mihomo' } }))
        .counts.output,
      1,
    );
    assert.equal(
      (await converter.run({ kind: 'produce', input: { items: items(node('ss')) } })).counts.output,
      1,
    );
  } finally {
    await converter.close();
  }
});

test('chain HTTP CRUD is authenticated, same-origin, revision checked and credential free', async (t) => {
  const f = await setup(t),
    auth = new Auth(await hashPassword('chain-http-test-password'));
  const config = { publicOrigin: 'http://127.0.0.1', dataDir: f.dir, development: true };
  const app = createApp({
    config,
    auth,
    converter: f.converter,
    ...f.settings,
    publisher: f.publisher,
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  config.publicOrigin = origin;
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    auth.close();
  });
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-SubMeld-Request': '1' };
  assert.equal((await fetch(origin + '/api/chains')).status, 401);
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: 'chain-http-test-password' }),
  });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, method, body, extra = {}) =>
    fetch(origin + path, {
      method,
      headers: { ...headers, ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const payload = { name: 'http-chain', entryNodeId: f.entry.id, exitNodeId: f.exit.id };
  assert.equal(
    (await request('/api/chains', 'POST', payload, { Origin: 'https://outside.invalid' })).status,
    403,
  );
  const response = await request('/api/chains', 'POST', payload);
  assert.equal(response.status, 201);
  const chain = await response.json();
  const list = await (await request('/api/chains', 'GET')).text();
  assert.ok(!list.includes(TEST_PASSWORD));
  assert.ok(!list.includes('"auth"'));
  assert.equal(
    (await request('/api/chains/' + chain.id, 'PATCH', { revision: 1, name: 'updated' })).status,
    200,
  );
  assert.equal(
    (await request('/api/chains/' + chain.id, 'PATCH', { revision: 1, name: 'stale' })).status,
    409,
  );
  assert.equal((await request('/api/chains/' + chain.id, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await request('/api/chains/' + chain.id, 'DELETE', { revision: 2 })).status, 200);
  assert.equal((await request('/api/chains/' + chain.id, 'GET')).status, 404);
});

test('maximum-length chain names retain the visible name and keep dependency names renderable', () => {
  const chain = chainItem();
  chain.name = '长'.repeat(512);
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const result = renderInput({ target, items: [chain] });
    const fragment = target === 'mihomo' ? parse(result.nodes) : JSON.parse(result.nodes);
    const outputs = fragment.proxies ?? fragment.outbounds;
    assert.equal(outputs[0].name ?? outputs[0].tag, chain.name);
    assert.ok((outputs[1].name ?? outputs[1].tag).length <= 512);
  }
});
