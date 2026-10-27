import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fixture, ref } from './upstream-fixture.mjs';
import { node, TEST_PASSWORD, UUID } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { openSettings } from '../dist/server/database.js';
import { UpstreamResources } from '../dist/server/upstream-resources.js';
export async function add(f, drafts = [node('ss')], name = 'imported') {
  return f.nodes.create({
    name,
    source: 'local',
    content: JSON.stringify({ proxies: drafts.map(toUpstream) }),
  });
}
function plan(inputs, formats = [...outputFormats]) {
  return { ...newSubscription(), name: 'native-output', inputs, formats };
}

test('local deletion only ignores candidate ports for valid HY2 hopping ranges', async (t) => {
  async function deletion(ports, changed = {}, succeeds = false, type = 'hysteria2') {
    const kept = {
      ...toUpstream(node('hysteria2')),
      type,
      name: 'keep',
      port: 20120,
      ...(ports === undefined ? {} : { ports }),
    };
    const record = {
      name: 'candidate-ports',
      source: 'local',
      content: JSON.stringify({ proxies: [toUpstream(node('ss')), kept], extra: 'preserved' }),
      process: [],
      _submeld: { id: UUID },
    };
    const before = structuredClone(record);
    let writes = 0;
    const resources = new UpstreamResources({
      exclusive: (work) => work(),
      records: async (kind) => (kind === 'sub' ? [structuredClone(record)] : []),
      preview: async (_kind, current) => {
        const proxies = JSON.parse(current.content).proxies;
        const checking = proxies.length === 1;
        const original = proxies.map((raw, index) => ({
          ...raw,
          id: index,
          _subName: current.name,
          ...(raw.name === 'keep'
            ? { port: checking ? 20122 : 20121, ...(checking ? changed : {}) }
            : {}),
        }));
        return { original, processed: structuredClone(original) };
      },
      api: async (_path, patch) => {
        writes++;
        Object.assign(record, patch);
      },
    });
    await resources.sync();
    const list = await resources.list(UUID);
    assert.deepEqual(list.errors, []);
    const removing = resources.deleteNodes({ nodes: [ref(list.nodes[0])] });
    if (succeeds) {
      const result = await removing;
      assert.equal(result.deleted, 1);
      assert.equal(result.excluded, 0);
      assert.equal(result.resources[0].state, 'verified');
      assert.equal(writes, 1);
      assert.deepEqual(JSON.parse(record.content), { proxies: [kept], extra: 'preserved' });
    } else {
      await assert.rejects(removing, { code: 'NODE_DELETE_UNSAFE' });
      assert.equal(writes, 0);
      assert.deepEqual(record, before);
    }
  }
  for (const ports of ['20120-20200', '20120,20200-20300', '20120'])
    await t.test('valid ports: ' + ports, () => deletion(ports, {}, true));
  for (const changed of [
    { server: 'changed.example.com' },
    { password: 'changed-test-password' },
    { sni: 'changed.example.com' },
    { fingerprint: 'cd'.repeat(32) },
    { ports: '20120-20300' },
    { obfs: '' },
    { 'obfs-password': 'changed-test-obfs' },
    { 'hop-interval': 20 },
    { nativeOption: 'changed' },
  ])
    await t.test('changed ' + Object.keys(changed)[0], () => deletion('20120-20200', changed));
  for (const ports of [undefined, '', ' ', 'invalid', '20200-20120', '20120-65536', 20120])
    await t.test('ordinary port with invalid or absent ports: ' + String(ports), () =>
      deletion(ports),
    );
  await t.test('ordinary port for another protocol', () =>
    deletion('20120-20200', {}, false, 'ss'),
  );
});

test('real upstream local deletion preserves HY2 range and mport URI lines and native operations', async (t) => {
  const f = await fixture(t);
  const removed =
    'ss://' + Buffer.from('aes-128-gcm:test-only').toString('base64') + '@example.com:443#remove';
  const lines = [
    '# preserved heading',
    removed,
    '',
    'hysteria2://test-only@example.com:20120-20200?sni=example.com&pinSHA256=' +
      'ab'.repeat(32) +
      '#range',
    '# preserved between nodes',
    'hy2://test-only@example.com:30120?mport=30120-30200&sni=example.com&obfs=salamander&obfs-password=test-only-obfs#mport',
    '',
  ];
  const resource = await f.nodes.create({
    name: 'HY2 retained content',
    source: 'local',
    content: lines.join('\r\n'),
  });
  await f.client.api(
    '/api/sub/' + resource.upstreamName,
    { process: [{ type: 'Flag Operator', args: { mode: 'remove' } }] },
    'PATCH',
  );
  const before = (await f.client.records('sub'))[0];
  await f.resources.sync();
  const list = await f.nodes.list(resource.id);
  assert.deepEqual(list.errors, []);
  assert.equal(list.total, 3);
  await f.nodes.delete({ nodes: [ref(list.nodes.find((entry) => entry.name === 'remove'))] });
  assert.deepEqual((await f.client.records('sub'))[0], {
    ...before,
    content: lines.filter((line) => line !== removed).join('\r\n'),
  });
});

test('HY2 hopping selections survive upstream random ports and native artifacts retain the certificate pin', async (t) => {
  const f = await fixture(t),
    pin = 'ab'.repeat(32);
  const content =
    'hysteria2://test-only@example.com:20120-20200?sni=example.com&insecure=1&pinSHA256=' +
    pin +
    '#HY2';
  const resource = await f.nodes.create({ name: 'HY2', source: 'local', content });
  const list = await f.nodes.list(resource.id);
  assert.equal(list.nodes[0].testable, true, list.nodes[0].testReason);
  const reference = ref(list.nodes[0]);
  for (let i = 0; i < 3; i++) {
    await f.miaospeedInput.refresh([{ kind: 'node', ...reference }]);
    const captured = f.miaospeedInput.capture({ kind: 'node', ...reference });
    const payload = JSON.parse(await f.miaospeedInput.payload(captured.raw, 'HY2-test'));
    assert.equal(payload.ports, '20120-20200');
    assert.equal(payload.fingerprint, pin);
  }
  const saved = await f.subscriptions.create(
    plan([{ kind: 'resource', id: resource.id }], ['uri', 'base64', 'mihomo', 'mihomo-proxies']),
  );
  for (const format of ['uri', 'base64', 'mihomo', 'mihomo-proxies']) {
    const output = (await f.subscriptions.artifact(saved.id, format)).content;
    if (format === 'uri' || format === 'base64') {
      const url = new URL(format === 'base64' ? Buffer.from(output, 'base64').toString() : output);
      assert.equal(url.searchParams.get('mport'), '20120-20200');
      assert.equal(url.searchParams.get('pinSHA256'), pin);
    } else {
      const proxy = parse(output).proxies[0];
      assert.equal(proxy.ports, '20120-20200');
      assert.equal(proxy.fingerprint, pin);
    }
  }
  await f.client.api(
    '/api/sub/' + resource.upstreamName,
    { content: content.replace('20120-20200', '30120-30200') },
    'PATCH',
  );
  await f.miaospeedInput.refresh([{ kind: 'node', ...reference }]);
  assert.throws(() => f.miaospeedInput.capture({ kind: 'node', ...reference }), {
    code: 'REVISION_CONFLICT',
  });
});
test('unified local deletion preserves other fields and operations; SQLite has no proxy configuration', async (t) => {
  const f = await fixture(t);
  const a = node('ss'),
    b = node('vless');
  a.name = 'first';
  b.name = 'second';
  const resource = await add(f, [a, b]);
  const record = f.resources.record(resource.id).record;
  const process = [{ type: 'Flag Operator', args: { mode: 'remove' } }];
  await f.client.api('/api/sub/' + record.name, { process }, 'PATCH');
  await f.resources.sync();
  const list = await f.nodes.list();
  assert.equal(list.total, 2);
  assert.equal(JSON.stringify(list).includes(TEST_PASSWORD), false);
  assert.equal(list.nodes[0].deletion, 'content');
  await f.nodes.delete({ nodes: [ref(list.nodes[0])] });
  const after = (await f.client.records('sub'))[0];
  assert.deepEqual(after.process, process);
  const saved = JSON.parse(after.content).proxies;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'second');
  assert.equal(saved[0].uuid, b.auth.uuid);
  const db = new Database(join(f.directory, 'submeld-v2.sqlite'), { readonly: true });
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
  db.close();
  f.close();
  const reopened = openSettings(f.directory, true, f.client);
  try {
    await reopened.resources.sync();
    assert.equal((await reopened.nodes.list()).total, 1);
  } finally {
    reopened.close();
  }
});
test('unsupported test protocols remain visible; stale snapshots cannot delete reordered nodes', async (t) => {
  const f = await fixture(t);
  await f.client.api('/api/subs', {
    name: 'native',
    displayName: '',
    source: 'local',
    content: JSON.stringify({
      proxies: [
        { type: 'socks5', name: 'visible', server: 'example.com', port: 1080 },
        toUpstream(node('ss')),
      ],
    }),
    process: [],
  });
  await f.resources.sync();
  const list = await f.nodes.list();
  assert.equal(list.total, 2);
  assert.equal(list.resources[0].name, 'native');
  assert.equal(list.nodes.find((n) => n.name === 'visible').testable, false);
  const record = (await f.client.records('sub'))[0],
    content = JSON.parse(record.content);
  content.proxies.reverse();
  await f.client.api('/api/sub/native', { content: JSON.stringify(content) }, 'PATCH');
  await assert.rejects(() => f.nodes.delete({ nodes: [ref(list.nodes[0])] }), {
    code: 'REVISION_CONFLICT',
  });
  assert.equal(JSON.parse((await f.client.records('sub'))[0].content).proxies.length, 2);
});
test('official upstream independently generates all eight formats, native shares revoke, template edits persist', async (t) => {
  const f = await fixture(t);
  const resource = await add(f);
  const saved = await f.subscriptions.create(plan([{ kind: 'resource', id: resource.id }]));
  assert.equal(f.resources.files('plan').length, 1);
  assert.equal(f.resources.files('output').length, 8);
  const generated = {};
  for (const format of outputFormats)
    generated[format] = (await f.subscriptions.artifact(saved.id, format)).content;
  assert.ok(generated.uri.startsWith('ss://'));
  assert.equal(Buffer.from(generated.base64, 'base64').toString(), generated.uri);
  assert.equal(parse(generated.mihomo).proxies.length, 1);
  assert.equal(JSON.parse(generated.singbox).outbounds.length, 2);
  assert.equal(JSON.parse(generated.xray).outbounds.length, 1);
  await f.subscriptions.share(saved.id, saved.revision, false);
  const urls = (await f.subscriptions.detail(saved.id, f.config.publicOrigin)).urls;
  for (const format of outputFormats) {
    const response = await f.app.request(urls[format][0]);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), generated[format]);
  }
  const template = f.resources.files('template').find((r) => r.record._submeld.format === 'mihomo');
  const changed = JSON.parse(template.record.content);
  changed['log-level'] = 'info';
  await f.client.api(
    '/api/file/' + template.record.name,
    { content: JSON.stringify(changed) },
    'PATCH',
  );
  await f.resources.sync();
  assert.equal(
    parse((await f.subscriptions.artifact(saved.id, 'mihomo')).content)['log-level'],
    'info',
  );
  await f.subscriptions.update(
    saved.id,
    plan([{ kind: 'resource', id: resource.id }]),
    saved.revision,
  );
  assert.equal(
    JSON.parse(
      (await f.client.records('file')).find((r) => r.name === template.record.name).content,
    )['log-level'],
    'info',
  );
  await f.subscriptions.share(saved.id, f.subscriptions.get(saved.id).revision, true);
  for (const url of Object.values(urls).flat())
    assert.notEqual((await f.app.request(url)).status, 200);
  assert.equal((await f.app.request('/s/old/uri?key=old')).status, 404);
  f.close();
  const output = (await f.client.records('file')).find(
    (r) => r._submeld?.role === 'output' && r._submeld.format === 'xray',
  );
  assert.equal((await f.client.request('/api/file/' + output.name)).status, 200);
});
test('selected ordinary nodes follow resource renames and same-name updates; duplicates and identity loss are explicit', async (t) => {
  const f = await fixture(t);
  const a = node('ss'),
    b = node('vless');
  a.name = 'entry';
  b.name = 'exit';
  b.tls.insecure = false;
  const resource = await add(f, [a, b]);
  const saved = await f.subscriptions.create(
    plan([{ kind: 'node', resourceId: resource.id, nodeName: 'entry' }]),
  );
  const yaml = parse((await f.subscriptions.artifact(saved.id, 'mihomo')).content);
  assert.equal(yaml.proxies.length, 1);
  assert.equal(yaml.proxies[0]['dialer-proxy'], undefined);
  assert.equal((await f.subscriptions.artifact(saved.id, 'uri')).content.split('\n').length, 1);
  const record = f.resources.record(resource.id).record;
  await f.client.api(
    '/api/sub/' + record.name,
    {
      name: 'renamed',
      content: JSON.stringify({
        proxies: [toUpstream(b), { ...toUpstream(a), server: 'updated.example.com' }],
      }),
    },
    'PATCH',
  );
  await f.resources.sync();
  assert.equal(
    parse((await f.subscriptions.artifact(saved.id, 'mihomo')).content).proxies[0].server,
    'updated.example.com',
  );
  await f.client.api(
    '/api/sub/renamed',
    { content: JSON.stringify({ proxies: [toUpstream(a), toUpstream(a), toUpstream(b)] }) },
    'PATCH',
  );
  await f.resources.sync();
  await assert.rejects(() => f.subscriptions.artifact(saved.id, 'mihomo'), {
    code: 'NODE_REFERENCE_INVALID',
  });
  await f.client.api('/api/sub/renamed', { _submeld: null }, 'PATCH');
  await f.resources.sync();
  await assert.rejects(() => f.subscriptions.artifact(saved.id, 'mihomo'), {
    code: 'REFERENCE_INVALID',
  });
});
