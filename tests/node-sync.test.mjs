import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ref } from './upstream-fixture.mjs';
import { UpstreamResources } from '../dist/server/upstream-resources.js';
import { AppError } from '../dist/server/errors.js';
import { UUID } from './fixtures.mjs';

const raw = (name, port = 443) => ({
  name,
  type: 'ss',
  server: 'example.com',
  port,
  cipher: 'aes-128-gcm',
  password: 'public-sync-fixture',
});
const content = (name = 'remove') =>
  JSON.stringify({ proxies: [raw(name), raw('keep', 444)], note: 'preserved' });
const create = (f, name = 'local') => f.nodes.create({ name, source: 'local', content: content() });
const saved = async (f, resource) =>
  (await f.client.records('sub')).find((record) => record._submeld?.id === resource.id);
const unavailable = () => new AppError('SUB_STORE_UNAVAILABLE', '受控上游读取失败。', 503);

test('local-only merged sources delete stored content and the last node, including duplicate names', async (t) => {
  const f = await fixture(t);
  const uri = (port) =>
    'ss://' +
    Buffer.from('aes-128-gcm:public-sync-fixture').toString('base64') +
    '@example.com:' +
    port +
    '#duplicate';
  for (const [format, value] of [
    ['URI', [uri(443), uri(444)].join('\r\n')],
    [
      'JSON',
      JSON.stringify({ proxies: [raw('duplicate'), raw('duplicate', 444)], note: 'preserved' }),
    ],
    [
      'YAML',
      '# preserved\nproxies:\n  - ' +
        JSON.stringify(raw('duplicate')) +
        '\n  - ' +
        JSON.stringify(raw('duplicate', 444)) +
        '\nrules: [MATCH,DIRECT]\n',
    ],
  ]) {
    const resource = await f.nodes.create({ name: format, source: 'local', content: value });
    await f.client.api(
      '/api/sub/' + resource.upstreamName,
      { mergeSources: 'localFirst', url: ' \n ' },
      'PATCH',
    );
    let list = await f.nodes.list(resource.id);
    assert.equal(list.complete, true);
    assert.ok(Number.isFinite(Date.parse(list.readAt)));
    assert.ok(list.nodes.every((node) => node.deletion === 'content'));
    const result = await f.nodes.delete({ nodes: [ref(list.nodes[0])] });
    assert.equal(result.deleted, 1);
    assert.equal(result.excluded, 0);
    assert.equal(result.resources[0].state, 'verified');
    let record = await saved(f, resource);
    const preview = await f.client.preview('sub', record);
    assert.deepEqual(
      preview.original.map((node) => node.port),
      [444],
    );
    assert.equal(record.mergeSources, 'localFirst');
    if (format === 'JSON') assert.equal(JSON.parse(record.content).note, 'preserved');
    if (format === 'YAML') assert.ok(record.content.startsWith('# preserved'));
    list = await f.nodes.list(resource.id);
    await f.nodes.delete({ nodes: [ref(list.nodes[0])] });
    record = await saved(f, resource);
    assert.ok(record, 'empty subscription container remains');
    assert.equal((await f.client.preview('sub', record)).original.length, 0);
  }
});

test('acknowledged writes that did not change upstream return a failed resource, never deleted', async (t) => {
  const f = await fixture(t),
    resource = await create(f);
  const list = await f.nodes.list(resource.id);
  const before = await saved(f, resource);
  const api = f.client.api.bind(f.client);
  t.mock.method(f.client, 'api', (path, body, method, signal) =>
    path === '/api/sub/' + resource.upstreamName && method === 'PATCH'
      ? Promise.resolve(before)
      : api(path, body, method, signal),
  );
  const response = await f.request('/api/nodes/delete', { nodes: [ref(list.nodes[0])] });
  assert.equal(response.status, 502);
  const result = (await response.json()).nodeMutation;
  assert.equal(result.deleted, 0);
  assert.equal(result.resources[0].state, 'failed');
  assert.deepEqual(await saved(f, resource), before);
});

test('lost write acknowledgement is reconciled by readback without issuing the patch twice', async (t) => {
  const f = await fixture(t),
    resource = await create(f);
  const list = await f.nodes.list(resource.id),
    api = f.client.api.bind(f.client);
  let writes = 0;
  t.mock.method(f.client, 'api', async (path, body, method, signal) => {
    const result = await api(path, body, method, signal);
    if (path === '/api/sub/' + resource.upstreamName && method === 'PATCH') {
      writes++;
      throw unavailable();
    }
    return result;
  });
  const result = await f.nodes.delete({ nodes: [ref(list.nodes[0])] });
  assert.equal(writes, 1);
  assert.equal(result.resources[0].state, 'verified');
  assert.equal(result.deleted, 1);
  assert.equal((await saved(f, resource)).content.includes('remove'), false);
});

test('a write with unavailable readback is unknown and invalidates the old snapshot', async (t) => {
  const f = await fixture(t),
    resource = await create(f);
  const list = await f.nodes.list(resource.id);
  const api = f.client.api.bind(f.client),
    records = f.client.records.bind(f.client);
  let written = false;
  const mutation = t.mock.method(f.client, 'api', async (path, body, method, signal) => {
    const result = await api(path, body, method, signal);
    if (path === '/api/sub/' + resource.upstreamName && method === 'PATCH') written = true;
    return result;
  });
  const reading = t.mock.method(f.client, 'records', (type) => {
    if (written) throw unavailable();
    return records(type);
  });
  await assert.rejects(f.nodes.delete({ nodes: [ref(list.nodes[0])] }), (error) => {
    assert.equal(error.nodeMutation.deleted, 0);
    assert.equal(error.nodeMutation.resources[0].state, 'unknown');
    assert.equal(JSON.stringify(error.nodeMutation).includes('public-sync-fixture'), false);
    return true;
  });
  assert.throws(() => f.resources.cached(resource.id), { code: 'REVISION_CONFLICT' });
  mutation.mock.restore();
  reading.mock.restore();
  assert.deepEqual(
    (await f.nodes.list(resource.id)).nodes.map((node) => node.name),
    ['keep'],
  );
});

test('batch failures report verified, failed and unattempted resources and keep unrelated content', async (t) => {
  const f = await fixture(t);
  const resources = [];
  for (const name of ['first', 'second', 'third']) resources.push(await create(f, name));
  const refs = [];
  for (const resource of resources) refs.push(ref((await f.nodes.list(resource.id)).nodes[0]));
  const api = f.client.api.bind(f.client),
    writes = [];
  t.mock.method(f.client, 'api', async (path, body, method, signal) => {
    if (method === 'PATCH') {
      writes.push(path);
      if (path.endsWith(resources[1].upstreamName)) throw unavailable();
    }
    return api(path, body, method, signal);
  });
  const response = await f.request('/api/nodes/delete', { nodes: refs });
  assert.equal(response.status, 502);
  const result = (await response.json()).nodeMutation;
  assert.equal(result.deleted, 1);
  assert.deepEqual(
    result.resources.map((resource) => resource.state),
    ['verified', 'failed', 'notAttempted'],
  );
  assert.equal(writes.length, 2);
  assert.equal((await saved(f, resources[0])).content.includes('remove'), false);
  assert.equal((await saved(f, resources[1])).content, content());
  assert.equal((await saved(f, resources[2])).content, content());
});

test('an external edit during deletion preflight is detected immediately before patching', async (t) => {
  const f = await fixture(t),
    resource = await create(f);
  const list = await f.nodes.list(resource.id),
    preview = f.client.preview.bind(f.client);
  let edited = false;
  t.mock.method(f.client, 'preview', async (type, record, force) => {
    const result = await preview(type, record, force);
    if (!edited && record.name === resource.upstreamName && !record.content.includes('remove')) {
      edited = true;
      await f.client.api(
        '/api/sub/' + resource.upstreamName,
        { displayName: 'external-edit' },
        'PATCH',
      );
    }
    return result;
  });
  await assert.rejects(f.nodes.delete({ nodes: [ref(list.nodes[0])] }), (error) => {
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.equal(error.nodeMutation.resources[0].state, 'failed');
    return true;
  });
  const after = await saved(f, resource);
  assert.equal(after.displayName, 'external-edit');
  assert.equal(after.content, content());
});

test('script exclusion is verified separately from content deletion', async (t) => {
  const f = await fixture(t),
    resource = await create(f);
  const before = await saved(f, resource);
  await f.client.api(
    '/api/sub/' + resource.upstreamName,
    {
      process: [
        {
          type: 'Script Operator',
          args: {
            mode: 'script',
            content:
              'function operator(proxies) { return [...proxies,' +
              JSON.stringify(raw('generated')) +
              ']; }',
          },
        },
      ],
    },
    'PATCH',
  );
  const list = await f.nodes.list(resource.id);
  const generated = list.nodes.find((node) => node.name === 'generated');
  assert.equal(generated.deletion, 'filter');
  const result = await f.nodes.delete({ nodes: [ref(generated)] });
  assert.equal(result.deleted, 0);
  assert.equal(result.excluded, 1);
  const after = await saved(f, resource);
  assert.equal(after.content, before.content);
  assert.deepEqual(
    (await f.client.preview('sub', after)).processed.map((node) => node.name),
    ['remove', 'keep'],
  );
});

test('late previews cannot replace newer snapshots and failed previews invalidate only their own generation', async () => {
  const gate = Promise.withResolvers();
  const record = { name: 'native', source: 'remote', _submeld: { id: UUID } };
  let calls = 0,
    fail = false;
  const resources = new UpstreamResources({
    exclusive: (work) => work(),
    records: async (type) => (type === 'sub' ? [record] : []),
    preview: async () => {
      if (fail) throw unavailable();
      const call = ++calls;
      if (call === 1) await gate.promise;
      const original = [{ ...raw(call === 1 ? 'older' : 'newer'), id: 0 }];
      return { original, processed: structuredClone(original) };
    },
  });
  await resources.sync();
  const old = resources.preview(UUID);
  const rejected = assert.rejects(old, { code: 'REVISION_CONFLICT' });
  await resources.preview(UUID);
  gate.resolve();
  await rejected;
  assert.equal(resources.cached(UUID).rows[0].view.name, 'newer');
  fail = true;
  await assert.rejects(resources.preview(UUID), { code: 'SUB_STORE_UNAVAILABLE' });
  assert.throws(() => resources.cached(UUID), { code: 'REVISION_CONFLICT' });
});

test('native child edits invalidate collection previews and node detail/list read current records', async (t) => {
  const f = await fixture(t),
    resource = await create(f);
  const list = await f.nodes.list(resource.id);
  await f.client.api('/api/collections', {
    name: 'combined',
    subscriptions: [resource.upstreamName],
    process: [],
  });
  await f.resources.sync();
  const collection = f.resources.listResources().find((item) => item.type === 'collection');
  await f.resources.preview(collection.id);
  await f.client.api('/api/sub/' + resource.upstreamName, { content: content('changed') }, 'PATCH');
  await assert.rejects(f.nodes.get(ref(list.nodes[0])), { code: 'REVISION_CONFLICT' });
  assert.throws(() => f.resources.cached(collection.id), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.nodes.list(resource.id)).nodes[0].name, 'changed');
  const preview = f.client.preview.bind(f.client);
  t.mock.method(f.client, 'preview', (type, record, force) => {
    if (record.name === resource.upstreamName) throw unavailable();
    return preview(type, record, force);
  });
  const partial = await f.nodes.list(resource.id);
  assert.equal(partial.complete, false);
  assert.equal(partial.total, 0);
  assert.equal(partial.errors.length, 1);
});
