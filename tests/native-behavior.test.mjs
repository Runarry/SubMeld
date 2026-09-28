import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fixture, ref, waitFor } from './upstream-fixture.mjs';
import { node, UUID } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
async function local(f, name = 'local') {
  const a = node('ss'),
    b = node('ss');
  a.name = 'entry';
  b.name = 'exit';
  b.port = 444;
  return f.nodes.create({
    name,
    source: 'local',
    content: JSON.stringify({ proxies: [a, b].map(toUpstream) }),
  });
}
async function plan(f, resource) {
  return f.subscriptions.create({
    ...newSubscription(),
    name: 'native',
    inputs: [{ kind: 'resource', id: resource.id }],
    formats: ['mihomo', 'xray'],
  });
}
test('remote deletion appends an exact escaped filter, follows native refresh and never rewrites source content', async (t) => {
  const f = await fixture(t);
  const a = node('ss'),
    b = node('ss');
  a.name = 'US.A+(1)';
  b.name = 'USxA1';
  b.port = 444;
  let text = JSON.stringify({ proxies: [a, b].map(toUpstream) }),
    hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(text);
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const resource = await f.nodes.create({
    name: 'remote',
    source: 'remote',
    url: 'http://host.docker.internal:' + server.address().port + '/subscription',
  });
  const record = f.resources.record(resource.id).record,
    process = [{ type: 'Flag Operator', args: { mode: 'remove' } }];
  await f.client.api('/api/sub/' + record.name, { process }, 'PATCH');
  await f.resources.sync();
  let list = await f.nodes.list(resource.id, '', 0, true);
  assert.equal(list.errors.length, 0, JSON.stringify(list.errors));
  assert.equal(list.total, 2);
  assert.ok(hits > 0);
  await f.nodes.delete({ nodes: [ref(list.nodes.find((n) => n.name === a.name))] });
  const after = (await f.client.records('sub'))[0];
  assert.equal(after.url, record.url);
  assert.equal(after.content, '');
  assert.deepEqual(after.process[0], process[0]);
  list = await f.nodes.list(resource.id, '', 0, true);
  assert.equal(list.nodes.find((n) => n.name === a.name).available, false);
  assert.equal(list.nodes.find((n) => n.name === b.name).available, true);
  a.server = 'updated.example.com';
  text = JSON.stringify({ proxies: [b, a].map(toUpstream) });
  list = await f.nodes.list(resource.id, '', 0, true);
  assert.equal(list.nodes.find((n) => n.name === a.name).available, false);
  a.name = 'renamed';
  text = JSON.stringify({ proxies: [a, b].map(toUpstream) });
  list = await f.nodes.list(resource.id, '', 0, true);
  assert.ok(list.nodes.every((n) => n.available));
  b.name = a.name;
  text = JSON.stringify({ proxies: [a, b].map(toUpstream) });
  list = await f.nodes.list(resource.id, '', 0, true);
  assert.ok(list.nodes.every((n) => n.deletion === 'unavailable'));
  await assert.rejects(() => f.nodes.delete({ nodes: [ref(list.nodes[0])] }), {
    code: 'NODE_DELETE_UNSAFE',
  });
});
test('collection exclusions affect only the collection, and renamed collection members protect their original nodes', async (t) => {
  const f = await fixture(t),
    resource = await local(f);
  await f.client.api('/api/collections', {
    name: 'combined',
    subscriptions: [resource.upstreamName],
    process: [
      {
        type: 'Script Operator',
        args: {
          mode: 'script',
          content:
            'function operator(proxies) { return proxies.map(p => ({...p,name:"group-"+p.name})); }',
        },
      },
    ],
  });
  await f.resources.sync();
  const collection = f.resources.listResources().find((r) => r.type === 'collection');
  assert.equal((await f.nodes.list()).total, 2);
  const grouped = await f.nodes.list(collection.id);
  assert.equal(grouped.total, 2);
  const chain = await f.chains.create({
    name: 'protected',
    enabled: true,
    entry: { resourceId: collection.id, nodeName: 'group-entry' },
    exit: { resourceId: collection.id, nodeName: 'group-exit' },
  });
  const original = await f.nodes.list(resource.id);
  await assert.rejects(() => f.nodes.delete({ nodes: [ref(original.nodes[0])] }), {
    code: 'NODE_IN_USE',
  });
  await f.chains.delete(chain.id, chain.revision);
  await f.nodes.delete({ nodes: [ref(grouped.nodes[0])] });
  assert.equal((await f.nodes.list(resource.id)).nodes.filter((n) => n.available).length, 2);
  assert.equal((await f.nodes.list(collection.id)).nodes.filter((n) => n.available).length, 1);
});
test('script-derived nodes are filtered without rewriting the original local text', async (t) => {
  const f = await fixture(t),
    resource = await local(f),
    record = f.resources.record(resource.id).record;
  const extra = { ...toUpstream(node('ss')), name: 'derived', port: 555 };
  await f.client.api(
    '/api/sub/' + record.name,
    {
      process: [
        {
          type: 'Script Operator',
          args: {
            mode: 'script',
            content:
              'function operator(proxies) { return [...proxies,' + JSON.stringify(extra) + ']; }',
          },
        },
      ],
    },
    'PATCH',
  );
  await f.resources.sync();
  const list = await f.nodes.list();
  const derived = list.nodes.find((n) => n.name === 'derived');
  assert.equal(derived.deletion, 'filter');
  await f.nodes.delete({ nodes: [ref(derived)] });
  assert.equal((await f.client.records('sub'))[0].content, record.content);
  assert.equal(
    (await f.nodes.list()).nodes.some((n) => n.name === 'derived'),
    false,
  );
});
test('native definition edits use optimistic versions and malformed templates cannot silently lose nodes', async (t) => {
  const f = await fixture(t),
    resource = await local(f),
    saved = await plan(f, resource);
  const file = f.resources.files('plan')[0].record;
  await f.client.api(
    '/api/file/' + file.name,
    {
      content: JSON.stringify({
        ...newSubscription(),
        name: 'external',
        inputs: [{ kind: 'resource', id: resource.id }],
        formats: ['mihomo'],
      }),
    },
    'PATCH',
  );
  await f.resources.sync();
  await assert.rejects(
    () =>
      f.subscriptions.update(
        saved.id,
        { ...newSubscription(), name: 'stale', inputs: [{ kind: 'resource', id: resource.id }] },
        saved.revision,
      ),
    { code: 'REVISION_CONFLICT' },
  );
  const template = f.resources
    .files('template')
    .find((r) => r.record._submeld.format === 'mihomo').record;
  await f.client.api('/api/file/' + template.name, { content: '{}' }, 'PATCH');
  await f.resources.sync();
  await assert.rejects(() => f.subscriptions.artifact(saved.id, 'mihomo'), {
    code: 'TEMPLATE_FIELD_LOSS',
  });
});
test('upstream outage returns an error; restart preserves native definitions, shares and outputs', async (t) => {
  const f = await fixture(t),
    resource = await local(f),
    saved = await plan(f, resource);
  await f.subscriptions.share(saved.id, saved.revision, false);
  const url = (await f.subscriptions.detail(saved.id, f.config.publicOrigin)).urls.mihomo[0];
  const before = (await f.subscriptions.artifact(saved.id, 'mihomo')).content;
  const container = process.env.SUBMELD_TEST_CONTAINER;
  assert.ok(container?.startsWith('submeld-test-'));
  const docker = (args) =>
    execFileSync('docker', args, { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  docker(['pause', container]);
  const originalRequest = f.client.request.bind(f.client);
  f.client.request = (path, init = {}, limit) =>
    originalRequest(path, { ...init, signal: AbortSignal.timeout(500) }, limit);
  try {
    assert.equal(
      (await f.request('/api/subscriptions/' + saved.id + '/artifacts/mihomo')).status,
      503,
    );
  } finally {
    docker(['unpause', container]);
    f.client.request = originalRequest;
  }
  docker(['restart', container]);
  await waitFor(async () => {
    try {
      await f.resources.sync();
      return true;
    } catch {
      return false;
    }
  }, 20000);
  assert.equal((await f.subscriptions.artifact(saved.id, 'mihomo')).content, before);
  assert.equal((await f.app.request(url)).status, 200);
});

test('local deletions retain JSON configuration, YAML comments and untouched URI lines', async (t) => {
  const f = await fixture(t);
  const a = node('ss'),
    b = node('ss');
  a.name = 'remove';
  b.name = 'keep';
  const cases = [
    JSON.stringify({ note: 'preserved', proxies: [a, b].map(toUpstream), rules: ['MATCH,KEEP'] }),
    '# retained comment\nproxies:\n  - ' +
      JSON.stringify(toUpstream(a)) +
      '\n  - ' +
      JSON.stringify(toUpstream(b)) +
      '\nrules: [MATCH,KEEP]\n',
    '# retained comment\n' +
      [a, b]
        .map(
          (n) =>
            'ss://' +
            Buffer.from('aes-128-gcm:public-fixture').toString('base64') +
            '@example.com:443#' +
            n.name,
        )
        .join('\n'),
  ];
  for (const content of cases) {
    const resource = await f.nodes.create({ name: 'preserve', source: 'local', content });
    const before = (await f.nodes.list(resource.id)).nodes;
    await f.nodes.delete({ nodes: [ref(before.find((n) => n.name === 'remove'))] });
    const saved = (await f.client.records('sub')).find(
      (r) => r.name === resource.upstreamName,
    ).content;
    assert.ok(!saved.includes('"remove"'));
    assert.ok(saved.includes('keep'));
    if (content.startsWith('#')) assert.ok(saved.startsWith('# retained comment'));
    if (content.includes('rules')) assert.ok(saved.includes('MATCH'));
    assert.equal((await f.nodes.list(resource.id)).total, 1);
  }
});
test('support files update only explicitly and reject an external concurrent edit', async (t) => {
  const f = await fixture(t),
    resource = await local(f);
  await plan(f, resource);
  const file = f.files.supportFiles().files.find((f) => f.role === 'template');
  const record = f.resources.record(file.id).record;
  await f.client.api(
    '/api/file/' + record.name,
    {
      content: '{}',
      source: 'remote',
      url: 'http://example.invalid/template',
      process: [
        { type: 'Script Operator', args: { mode: 'script', content: '$content = "invalid";' } },
      ],
    },
    'PATCH',
  );
  await assert.rejects(() => f.files.updateSupport(file.id, file.revision), {
    code: 'REVISION_CONFLICT',
  });
  const current = f.files.supportFiles().files.find((f) => f.id === file.id);
  assert.equal(current.matchesBuiltin, false);
  await f.files.updateSupport(file.id, current.revision);
  assert.equal(f.files.supportFiles().files.find((f) => f.id === file.id).matchesBuiltin, true);
  const restored = f.resources.record(file.id).record;
  assert.equal(restored.source, 'local');
  assert.deepEqual(restored.process, []);
});
test('upstream-only connection fields stay visible and explicitly block enhanced export', async (t) => {
  const f = await fixture(t);
  const value = {
    ...toUpstream(node('ss')),
    plugin: 'v2ray-plugin',
    'plugin-opts': { mode: 'websocket', host: 'example.com' },
  };
  const resource = await f.nodes.create({
    name: 'plugin',
    source: 'local',
    content: JSON.stringify({ proxies: [value] }),
  });
  const list = await f.nodes.list();
  assert.equal(list.total, 1);
  assert.equal(list.nodes[0].testable, false);
  const saved = await plan(f, resource);
  await assert.rejects(() => f.subscriptions.artifact(saved.id, 'mihomo'), {
    code: 'TARGET_UNSUPPORTED',
  });
});

test('native VLESS URI defaults remain testable and exportable without accepting active unsupported features', async (t) => {
  const f = await fixture(t);
  const content = `vless://${UUID}@example.com:443?security=tls&encryption=none&type=tcp&fp=chrome#native-VLESS`;
  const resource = await f.nodes.create({ name: 'native-uri', source: 'local', content });
  const list = await f.nodes.list();
  assert.equal(list.nodes[0].testable, true, list.nodes[0].testReason);
  const original = f.resources.current(ref(list.nodes[0])).original;
  assert.equal(original._h2, false);
  assert.equal(original.encryption, 'none');
  assert.equal(f.resources.record(resource.id).record.content, content);
  const saved = await f.subscriptions.create({
    ...newSubscription(),
    name: 'native VLESS output',
    inputs: [{ kind: 'resource', id: resource.id }],
    formats: outputFormats,
  });
  for (const format of outputFormats) {
    const artifact = await f.subscriptions.artifact(saved.id, format);
    const text =
      format === 'base64' ? Buffer.from(artifact.content, 'base64').toString() : artifact.content;
    assert.ok(text.includes('native-VLESS'), format + ' must retain the node');
    assert.ok(text.includes(UUID), format + ' must retain credentials');
  }
  for (const extra of [{ _h2: true }, { encryption: 'unsupported-encryption' }]) {
    await f.client.api(
      '/api/sub/' + resource.upstreamName,
      {
        content: JSON.stringify({ proxies: [{ ...original, ...extra }] }),
      },
      'PATCH',
    );
    await f.resources.sync();
    assert.equal((await f.nodes.list()).nodes[0].testable, false);
    await assert.rejects(() => f.subscriptions.artifact(saved.id, 'mihomo'), {
      code: 'TARGET_UNSUPPORTED',
    });
  }
});

test('broken chain files can be repaired through the native gateway; lost identities do not bind replacement resources', async (t) => {
  const f = await fixture(t),
    resource = await local(f);
  const config = {
    name: 'repairable',
    enabled: true,
    entry: { resourceId: resource.id, nodeName: 'entry' },
    exit: { resourceId: resource.id, nodeName: 'exit' },
  };
  const chain = await f.chains.create(config),
    file = f.resources.record(chain.id).record;
  await f.client.api('/api/file/' + file.name, { content: 'invalid-json' }, 'PATCH');
  assert.equal(
    (
      await f.request(
        '/upstream/sub-store/api/file/' + file.name,
        { content: JSON.stringify(config) },
        'PATCH',
      )
    ).status,
    200,
  );
  assert.equal((await f.chains.get(chain.id)).available, true);
  await f.client.api('/api/sub/' + resource.upstreamName, { _submeld: null }, 'PATCH');
  await f.resources.sync();
  const list = await f.nodes.list();
  assert.notEqual(list.nodes[0].resourceId, resource.id);
  await f.nodes.delete({ nodes: [ref(list.nodes[0])] });
  assert.equal((await f.chains.get(chain.id)).available, false);
});
