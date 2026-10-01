import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fixture, ref } from './upstream-fixture.mjs';
import { node, TEST_PASSWORD } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { openSettings } from '../dist/server/database.js';
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
    ['node_test_results', 'settings', 'speed_reports', 'speed_results', 'telegram_tasks'],
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
test('chains use ordinary nodes, follow renamed resources and same-name updates; deletion, duplicates and identity loss are explicit', async (t) => {
  const f = await fixture(t);
  const a = node('ss'),
    b = node('vless');
  a.name = 'entry';
  b.name = 'exit';
  b.tls.insecure = false;
  const resource = await add(f, [a, b]);
  const chain = await f.chains.create({
    name: 'route',
    enabled: true,
    entry: { resourceId: resource.id, nodeName: 'entry' },
    exit: { resourceId: resource.id, nodeName: 'exit' },
  });
  const saved = await f.subscriptions.create(
    plan([
      { kind: 'chain', id: chain.id },
      { kind: 'node', resourceId: resource.id, nodeName: 'entry' },
    ]),
  );
  const yaml = parse((await f.subscriptions.artifact(saved.id, 'mihomo')).content);
  assert.equal(yaml.proxies[0]['dialer-proxy'], yaml.proxies[1].name);
  assert.equal(
    JSON.parse((await f.subscriptions.artifact(saved.id, 'singbox')).content).outbounds[1].detour,
    'route · 前置',
  );
  assert.equal(
    JSON.parse((await f.subscriptions.artifact(saved.id, 'xray')).content).outbounds[0]
      .streamSettings.sockopt.dialerProxy,
    'route · 前置',
  );
  assert.equal((await f.subscriptions.artifact(saved.id, 'uri')).content.split('\n').length, 1);
  const list = await f.nodes.list();
  await assert.rejects(() => f.nodes.delete({ nodes: [ref(list.nodes[0])] }), {
    code: 'NODE_IN_USE',
  });
  const record = f.resources.record(resource.id).record;
  assert.equal(
    (await f.request('/upstream/sub-store/api/sub/' + record.name, undefined, 'DELETE')).status,
    409,
  );
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
  assert.equal((await f.chains.get(chain.id)).available, true);
  assert.equal(
    parse((await f.subscriptions.artifact(saved.id, 'mihomo')).content).proxies[1].server,
    'updated.example.com',
  );
  await f.client.api(
    '/api/sub/renamed',
    { content: JSON.stringify({ proxies: [toUpstream(a), toUpstream(a), toUpstream(b)] }) },
    'PATCH',
  );
  await f.resources.sync();
  assert.equal((await f.chains.get(chain.id)).available, false);
  await assert.rejects(() => f.subscriptions.artifact(saved.id, 'mihomo'), {
    code: 'CHAIN_REFERENCE_INVALID',
  });
  await f.client.api('/api/sub/renamed', { _submeld: null }, 'PATCH');
  await f.resources.sync();
  await assert.rejects(() => f.subscriptions.artifact(saved.id, 'mihomo'), {
    code: 'REFERENCE_INVALID',
  });
});
