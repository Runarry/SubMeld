import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, waitFor } from './upstream-fixture.mjs';
import { node, TEST_PASSWORD } from './fixtures.mjs';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { ENGINE_VERSION } from '../dist/server/subscriptions.js';
import { toUpstream } from '../dist/server/converter/model.js';
import { openSettings } from '../dist/server/database.js';
import { parseInput } from '../dist/server/converter/engine.js';
import { renderInput } from '../dist/server/converter/render.js';
import { composeItems } from '../dist/server/publisher.js';
import { ControlledConverter } from './publication-fixtures.mjs';
import { chainFixtures } from './chain-fixtures.mjs';
async function source(f, name = 'source', drafts = [node('ss')]) {
  await f.client.api('/api/subs', {
    name,
    source: 'local',
    content: drafts.map((d) => JSON.stringify(toUpstream(d))).join('\n'),
    process: [],
  });
  await f.resources.sync();
  const row = f.sources.list(0).sources.find((s) => s.name === name);
  assert.ok(row);
  await f.sources.prepare([row.id]);
  return f.sources.get(row.id);
}
function plan(inputs) {
  return { ...newSubscription(), name: 'enhanced', inputs, formats: [...outputFormats] };
}
async function published(f, id) {
  await waitFor(() =>
    f.subscriptions
      .detail(id, ENGINE_VERSION, f.publisher.status(id))
      .artifacts.every((a) => a.readable),
  );
}

test('credentials belong to native Sub-Store, validation is atomic and identities survive restart', async (t) => {
  const f = await fixture(t, { publish: false });
  const saved = await f.nodes.create({ drafts: [node('ss'), node('vless')] });
  const records = await f.client.records('sub');
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.source === 'local' && r._submeld.kind === 'node'));
  assert.equal(JSON.stringify(f.nodes.list(0)).includes(TEST_PASSWORD), false);
  const db = new Database(join(f.directory, 'submeld-v2.sqlite'), { readonly: true });
  assert.ok(
    !db
      .prepare('PRAGMA table_info(nodes)')
      .all()
      .some((c) => /draft|password|content/.test(c.name)),
  );
  assert.ok(
    !db
      .prepare('PRAGMA table_info(sources)')
      .all()
      .some((c) => /snapshot_json|headers|url|text/.test(c.name)),
  );
  db.close();
  const broken = node('ss');
  broken.auth.password = '';
  await assert.rejects(() => f.nodes.create({ drafts: [node('ss'), broken] }), {
    code: 'NODE_INVALID',
  });
  assert.equal((await f.client.records('sub')).length, 2);
  f.close();
  const reopened = openSettings(f.directory, true, f.client);
  try {
    await reopened.resources.sync();
    assert.equal(reopened.nodes.get(saved.nodes[0].id).draft.auth.password, TEST_PASSWORD);
  } finally {
    reopened.close();
  }
});

test('native rename keeps identity and disable suppresses native output without deleting the node', async (t) => {
  const f = await fixture(t, { publish: false });
  const {
    nodes: [saved],
  } = await f.nodes.create({ drafts: [node('ss')] });
  const record = f.resources.record(saved.id).record;
  assert.equal(
    (await f.request('/upstream/sub-store/api/sub/' + record.name, { name: 'renamed' }, 'PATCH'))
      .status,
    200,
  );
  assert.equal(f.resources.record(saved.id).record.name, 'renamed');
  await f.nodes.update(saved.id, { revision: f.nodes.get(saved.id).revision, enabled: false });
  assert.equal(
    (await (await f.client.request('/download/renamed?target=JSON')).json()).status,
    'failed',
  );
  assert.equal(f.nodes.get(saved.id).draft.auth.password, TEST_PASSWORD);
  await assert.rejects(() => f.nodes.update(saved.id, { revision: 1, enabled: true }), {
    code: 'REVISION_CONFLICT',
  });
  assert.throws(() => f.nodes.load({ ids: [saved.id] }), { code: 'NODE_DISABLED' });
  const process = f.resources.record(saved.id).record.process.map((operation) => ({
    ...operation,
    disabled: true,
  }));
  await f.request('/upstream/sub-store/api/sub/renamed', { process }, 'PATCH');
  assert.equal(f.nodes.get(saved.id).enabled, true);
  const output = await (await f.client.request('/download/renamed?target=JSON')).json();
  assert.equal(output.length, 1);
});

test('native delete and bulk replacement protect chain members; lost identity stays repairable', async (t) => {
  const f = await fixture(t, { publish: false });
  const {
    nodes: [a, b],
  } = await f.nodes.create({ drafts: [node('ss'), node('ss')] });
  const chain = f.chains.create({
    name: 'two hops',
    enabled: true,
    entryNodeId: a.id,
    exitNodeId: b.id,
  });
  const record = f.resources.record(a.id).record;
  assert.equal(
    (await f.request('/upstream/sub-store/api/sub/' + record.name, undefined, 'DELETE')).status,
    422,
  );
  assert.equal((await f.request('/upstream/sub-store/api/subs', [], 'PUT')).status, 422);
  await f.client.api('/api/sub/' + record.name, { _submeld: null }, 'PATCH');
  await f.resources.sync();
  assert.throws(() => f.nodes.get(a.id), { code: 'UPSTREAM_REFERENCE_MISSING' });
  assert.equal(f.chains.get(chain.id).available, false);
  f.chains.delete(chain.id, chain.revision);
  assert.equal(f.chains.list(0).total, 0);
});

test('native sources and collections feed all eight enhanced formats in order', async (t) => {
  const f = await fixture(t);
  await source(f);
  await f.client.api('/api/collections', {
    name: 'combined',
    subscriptions: ['source'],
    process: [],
  });
  await f.resources.sync();
  const combined = f.sources.list(0).sources.find((s) => s.name === 'combined');
  assert.ok(combined);
  const local = await f.nodes.create({ drafts: [{ ...node('ss'), name: 'independent' }] });
  const issued = f.subscriptions.create(
    plan([
      { kind: 'source', id: combined.id },
      { kind: 'node', id: local.nodes[0].id },
    ]),
  );
  await published(f, issued.id);
  const uri = f.subscriptions.artifact(issued.id, 'uri', ENGINE_VERSION).content;
  assert.equal((await parseInput({ format: 'uri', text: uri })).items.length, 2);
  assert.equal(
    Buffer.from(
      f.subscriptions.artifact(issued.id, 'base64', ENGINE_VERSION).content,
      'base64',
    ).toString(),
    uri,
  );
});

test('chain output retains target dependencies, excludes URI and rejects disabled hops', async () => {
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const chains = chainFixtures(target, 0);
    const rendered = await renderInput({ target, items: chains, listenPort: 1080 });
    assert.equal(rendered.counts.output, chains.length);
    const disabled = structuredClone(chains[0]);
    disabled.available = false;
    await assert.rejects(
      () => renderInput({ target, items: [disabled] }),
      (e) => e.diagnostics.some((d) => d.code === 'CHAIN_NODE_DISABLED'),
    );
    assert.ok(
      composeItems(plan([]), chains, 'uri').every(
        (i) => i.excluded && i.diagnostics.some((d) => d.code === 'CHAIN_URI_EXCLUDED'),
      ),
    );
  }
});

test('native editing invalidates publication immediately and token reset revokes GET and HEAD', async (t) => {
  const f = await fixture(t);
  const {
    nodes: [saved],
  } = await f.nodes.create({ drafts: [node('ss')] });
  const issued = f.subscriptions.create(plan([{ kind: 'node', id: saved.id }]));
  await published(f, issued.id);
  const path = '/s/' + issued.token + '/uri?key=' + issued.key;
  for (const method of ['GET', 'HEAD'])
    assert.equal((await f.app.request(path, { method })).status, 200);
  const record = f.resources.record(saved.id).record;
  await f.request(
    '/upstream/sub-store/api/sub/' + record.name,
    { content: JSON.stringify(toUpstream({ ...node('ss'), name: 'changed' })) },
    'PATCH',
  );
  assert.ok(
    f.subscriptions
      .detail(issued.id, ENGINE_VERSION, f.publisher.status(issued.id))
      .artifacts.every((a) => !a.readable),
  );
  await published(f, issued.id);
  f.subscriptions.resetToken(issued.id, f.subscriptions.get(issued.id).revision);
  for (const method of ['GET', 'HEAD'])
    assert.equal((await f.app.request(path, { method })).status, 404);
});

test('source reorder rejects old indexed results and stores a content hash', async (t) => {
  const f = await fixture(t, { publish: false });
  const src = await source(f, 'ordered', [
    { ...node('ss'), name: 'A' },
    { ...node('ss'), name: 'B' },
  ]);
  const subject = {
    kind: 'source',
    id: src.id,
    revision: src.revision,
    snapshotHash: src.snapshotHash,
    nodeIndex: 0,
  };
  assert.equal(f.nodeTests.capture(subject).name, 'A');
  await f.client.api(
    '/api/sub/ordered',
    {
      content: [
        { ...node('ss'), name: 'B' },
        { ...node('ss'), name: 'A' },
      ]
        .map((d) => JSON.stringify(toUpstream(d)))
        .join('\n'),
    },
    'PATCH',
  );
  await f.resources.sync();
  await f.sources.prepare([src.id]);
  assert.notEqual(f.sources.get(src.id).snapshotHash, src.snapshotHash);
  assert.equal(f.nodeTests.matches(subject), false);
  assert.throws(() => f.nodeTests.capture(subject), { code: 'REVISION_CONFLICT' });
});

test('lost source identity fails publication instead of silently omitting nodes', async (t) => {
  const f = await fixture(t);
  const src = await source(f);
  const issued = f.subscriptions.create(plan([{ kind: 'source', id: src.id }]));
  await published(f, issued.id);
  await f.request('/upstream/sub-store/api/sub/source', { _submeld: null }, 'PATCH');
  await waitFor(() => f.publisher.status(issued.id) === 'idle');
  assert.throws(() => f.subscriptions.artifact(issued.id, 'uri', ENGINE_VERSION), {
    code: 'ARTIFACT_UNAVAILABLE',
  });
  assert.equal(f.subscriptions.get(issued.id).inputs[0].id, src.id);
});

test('upstream outage preserves previously published contents without serving management requests', async (t) => {
  const f = await fixture(t);
  const src = await source(f);
  const issued = f.subscriptions.create(plan([{ kind: 'source', id: src.id }]));
  await published(f, issued.id);
  const before = f.subscriptions.artifact(issued.id, 'uri', ENGINE_VERSION).content;
  const original = f.client.request;
  f.client.request = async () => {
    throw new Error('simulated transport outage');
  };
  f.publisher.schedule([issued.id]);
  await waitFor(() => f.publisher.status(issued.id) === 'idle');
  assert.equal(f.subscriptions.artifact(issued.id, 'uri', ENGINE_VERSION).content, before);
  assert.equal((await f.request('/api/nodes')).status, 500);
  f.client.request = original;
});

for (const outcome of ['success', 'failure'])
  test('late ' + outcome + ' cannot restore pre-edit publication', async (t) => {
    const converter = new ControlledConverter();
    const f = await fixture(t, { converter });
    const {
      nodes: [saved],
    } = await f.nodes.create({ drafts: [node('ss')] });
    const gate = converter.hold(outcome === 'failure' ? new Error('test-only') : undefined);
    const issued = f.subscriptions.create({
      ...plan([{ kind: 'node', id: saved.id }]),
      formats: ['uri', 'base64'],
    });
    await gate.entered;
    await f.nodes.update(saved.id, { revision: saved.revision, changes: { name: 'replacement' } });
    gate.release();
    await published(f, issued.id);
    const value = f.subscriptions.artifact(issued.id, 'uri', ENGINE_VERSION);
    assert.equal(
      (await parseInput({ format: 'uri', text: value.content })).items[0].draft.name,
      'replacement',
    );
    assert.equal(value.builtRevision, f.subscriptions.get(issued.id).revision);
  });

test('native interface and API require login and same origin; invalid share tokens fail', async (t) => {
  const f = await fixture(t, { publish: false });
  assert.equal((await f.app.request('/upstream/sub-store/api/subs')).status, 401);
  assert.equal((await f.app.request('/')).status, 302);
  assert.equal(
    (
      await f.app.request('/upstream/sub-store/api/subs', {
        method: 'POST',
        headers: {
          cookie: f.cookie,
          Origin: 'https://other.invalid',
          'content-type': 'application/json',
        },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await f.request('/upstream/sub-store/api/subs')).status, 200);
  assert.equal((await f.request('/?api=http://127.0.0.1:3000/upstream/sub-store')).status, 200);
  assert.notEqual((await f.app.request('/share/sub/missing?token=invalid')).status, 200);
});

test('native Mihomo sharing works without login and revocation is enforced upstream', async (t) => {
  const f = await fixture(t, { publish: false });
  await source(f);
  const issued = await f.request('/upstream/sub-store/api/token', {
    payload: { type: 'sub', name: 'source' },
  });
  assert.equal(issued.status, 200);
  const {
    data: { token },
  } = await issued.json();
  assert.ok(token);
  const link = '/share/sub/source?target=Mihomo&token=' + encodeURIComponent(token);
  const shared = await f.app.request(link);
  assert.equal(shared.status, 200);
  assert.match(await shared.text(), /proxies:/);
  assert.equal((await f.app.request('/upstream/sub-store' + link)).status, 200);
  // The pinned native share endpoint supports GET and rejects HEAD.
  assert.equal((await f.app.request(link, { method: 'HEAD' })).status, 405);
  const revoked = await f.request(
    '/upstream/sub-store/api/token/' + encodeURIComponent(token) + '?type=sub&name=source',
    undefined,
    'DELETE',
  );
  assert.equal(revoked.status, 200);
  assert.notEqual((await f.app.request(link)).status, 200);
  assert.notEqual((await f.app.request('/upstream/sub-store' + link)).status, 200);
});

test('legacy data is refused without modification', async (t) => {
  const f = await fixture(t, { publish: false });
  f.close();
  const path = join(f.directory, 'submeld.sqlite');
  writeFileSync(path, 'preserve-old-data');
  assert.throws(() => openSettings(f.directory, true), /旧版数据目录/);
  assert.equal(readFileSync(path, 'utf8'), 'preserve-old-data');
});
