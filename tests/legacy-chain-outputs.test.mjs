import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixture } from './upstream-fixture.mjs';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { outputRecord } from '../dist/server/upstream-files.js';

function planRecord(config) {
  const id = randomUUID();
  return {
    name: 'legacy-plan-' + id,
    type: 'file',
    source: 'local',
    content: JSON.stringify(config),
    process: [],
    _submeld: { id, role: 'plan', version: 1 },
  };
}
function config(inputs, extra = {}) {
  return { ...newSubscription(), name: 'legacy', inputs, formats: [...outputFormats], ...extra };
}
async function local(f) {
  return f.nodes.create({
    name: 'ordinary',
    source: 'local',
    content: JSON.stringify({
      proxies: ['first', 'second'].map((name) => ({ ...toUpstream(node('ss')), name })),
    }),
  });
}
async function writePlan(f, record) {
  await f.client.api('/api/files', record);
  for (const format of JSON.parse(record.content).formats)
    await f.client.api('/api/files', outputRecord(record._submeld.id, format));
  await f.resources.sync();
  return f.subscriptions.get(record._submeld.id);
}

test('legacy inputs are filtered before validation and pagination without rewriting saved definitions', async (t) => {
  const f = await fixture(t),
    resource = await local(f);
  const first = { kind: 'node', resourceId: resource.id, nodeName: 'first' },
    second = { kind: 'node', resourceId: resource.id, nodeName: 'second' };
  const retired = { kind: 'chain', id: 'malformed-and-missing', unexpected: true };
  const mixedConfig = config([second, retired, first, retired], {
    name: 'mixed',
    prefix: 'prefix-',
    suffix: '-suffix',
    includeName: 'i',
    excludeName: 'excluded',
    listenPort: 2345,
    protocols: { uri: ['ss'], mihomo: ['ss'], singbox: ['ss'], xray: ['ss'] },
  });
  const mixed = planRecord(mixedConfig),
    pure = planRecord(config([retired, retired]));
  const ordinary = Array.from({ length: 25 }, (_, index) =>
    planRecord(config([first], { name: 'ordinary-' + index })),
  );
  const brokenChain = {
    name: 'broken-retired-chain',
    source: 'local',
    type: 'file',
    content: 'not-json',
    process: [],
    _submeld: { id: randomUUID(), role: 'chain', version: 1 },
  };
  await f.client.api('/api/files', [pure, mixed, ...ordinary, brokenChain], 'PUT');
  await f.resources.sync();
  const before = await f.client.records('file');
  const page = f.subscriptions.list();
  assert.equal(page.total, 26);
  assert.equal(page.subscriptions.length, 25);
  assert.equal(page.subscriptions[0].id, mixed._submeld.id);
  assert.deepEqual(page.subscriptions[0], {
    ...mixedConfig,
    inputs: [second, first],
    id: mixed._submeld.id,
    revision: f.subscriptions.get(mixed._submeld.id).revision,
  });
  assert.equal(f.subscriptions.list(1).subscriptions.length, 1);
  assert.equal(f.subscriptions.list(1).subscriptions[0].name, 'ordinary-24');
  for (const format of outputFormats)
    assert.deepEqual(await f.subscriptions.artifact(pure._submeld.id, format), {
      format,
      content: '',
    });
  assert.deepEqual(await f.client.records('file'), before);
  for (const inputs of [[retired], [first, retired]]) {
    await assert.rejects(() => f.subscriptions.create(config(inputs)), { code: 'INVALID_REQUEST' });
    await assert.rejects(
      () =>
        f.subscriptions.update(mixed._submeld.id, config(inputs), page.subscriptions[0].revision),
      { code: 'INVALID_REQUEST' },
    );
  }
  for (const inputs of [[], [retired, { kind: 'resource', id: 'bad' }], [first, retired, first]]) {
    await f.client.api(
      '/api/file/' + mixed.name,
      { content: JSON.stringify(config(inputs)) },
      'PATCH',
    );
    await f.resources.sync();
    assert.throws(() => f.subscriptions.get(mixed._submeld.id), { code: 'PLAN_INVALID' });
  }
});

test('official file runtime adapter keeps existing code and operators while retiring mixed and pure-chain shares', async (t) => {
  const f = await fixture(t),
    resource = await local(f);
  const ordinary = [
    { kind: 'node', resourceId: resource.id, nodeName: 'second' },
    { kind: 'node', resourceId: resource.id, nodeName: 'first' },
  ];
  const mixed = await f.subscriptions.create(
    config(ordinary, { prefix: 'prefix-', suffix: '-suffix' }),
  );
  const expected = {};
  for (const format of outputFormats)
    expected[format] = (await f.subscriptions.artifact(mixed.id, format)).content;
  const retired = { kind: 'chain', id: 'ignored-invalid-id' };
  const mixedFile = f.resources.record(mixed.id).record;
  const mixedContent = JSON.stringify(
    config([retired, ordinary[0], retired, ordinary[1]], {
      prefix: 'prefix-',
      suffix: '-suffix',
    }),
  );
  await f.client.api('/api/file/' + mixedFile.name, { content: mixedContent }, 'PATCH');
  const pureFile = planRecord(config([retired]));
  const pure = await writePlan(f, pureFile);
  const brokenChain = {
    name: 'ignored-retired-chain',
    type: 'file',
    source: 'local',
    content: 'malformed',
    process: [],
    _submeld: { id: randomUUID(), role: 'chain', version: 1 },
  };
  await f.client.api('/api/files', brokenChain);
  await f.resources.sync();
  await f.subscriptions.share(mixed.id, f.subscriptions.get(mixed.id).revision, false);
  await f.subscriptions.share(pure.id, pure.revision, false);
  const mixedUrls = (await f.subscriptions.detail(mixed.id, f.config.publicOrigin)).urls;
  const pureUrls = (await f.subscriptions.detail(pure.id, f.config.publicOrigin)).urls;
  const runtime = f.resources.files('runtime')[0];
  const source =
    readFileSync(process.env.SUBMELD_LEGACY_RUNTIME ?? 'dist/upstream/runtime.js', 'utf8') +
    '\n// saved runtime customization\n';
  t.diagnostic(
    process.env.SUBMELD_LEGACY_RUNTIME
      ? 'Using preserved pre-retirement runtime'
      : 'Using current saved runtime',
  );
  const originalProcess = [
    {
      type: 'Script Operator',
      args: {
        mode: 'script',
        content: '$content += "\\n;SubMeldRuntime.savedOperatorRan = true;\\n";',
      },
    },
  ];
  await f.client.api(
    '/api/file/' + runtime.record.name,
    { content: source, process: originalProcess },
    'PATCH',
  );
  for (const format of outputFormats) {
    const mixedResponse = await f.app.request(mixedUrls[format][0]);
    assert.equal(mixedResponse.status, 200, await mixedResponse.clone().text());
    assert.equal(await mixedResponse.text(), expected[format]);
    const pureResponse = await f.app.request(pureUrls[format][0]);
    assert.equal(pureResponse.status, 200, await pureResponse.clone().text());
    assert.equal(await pureResponse.text(), '');
    const invalid = new URL(pureUrls[format][0]);
    invalid.searchParams.set('token', 'invalid-token');
    assert.notEqual((await f.app.request(invalid.href)).status, 200);
  }
  const nativeOutput = f.subscriptions.outputs(pure.id)[0].record.name;
  const nativeResponse = await f.request('/upstream/sub-store/api/file/' + nativeOutput);
  assert.equal(nativeResponse.status, 200, await nativeResponse.clone().text());
  assert.equal(await nativeResponse.text(), '');
  await f.files.ensureLegacyChainCompatibility();
  await f.files.initialize();
  const after = (await f.client.records('file')).find((file) => file.name === runtime.record.name);
  assert.equal(after.content, source);
  assert.deepEqual(after.process.slice(0, originalProcess.length), originalProcess);
  assert.equal(after.process.length, originalProcess.length + 1);
  for (const [name, content] of [
    [mixedFile.name, mixedContent],
    [pureFile.name, pureFile.content],
    [brokenChain.name, brokenChain.content],
  ])
    assert.equal(
      (await f.client.records('file')).find((file) => file.name === name).content,
      content,
    );
  const generatedRuntime = await f.client.request('/api/file/' + runtime.record.name);
  assert.equal(generatedRuntime.status, 200);
  assert.ok((await generatedRuntime.text()).includes('SubMeldRuntime.savedOperatorRan = true'));
  for (const change of [
    { enabled: false },
    { formats: ['uri'] },
    { listenPort: 0 },
    { inputs: [] },
  ]) {
    await f.client.api(
      '/api/file/' + pureFile.name,
      {
        content: JSON.stringify({ ...JSON.parse(pureFile.content), ...change }),
      },
      'PATCH',
    );
    const response = await f.app.request(pureUrls.mihomo[0]);
    assert.equal(response.status, 422, 'retirement must preserve unrelated validation');
  }
  await f.client.api('/api/file/' + pureFile.name, { content: pureFile.content }, 'PATCH');
  await f.resources.sync();
  await f.subscriptions.share(pure.id, f.subscriptions.get(pure.id).revision, true);
  for (const urls of Object.values(pureUrls))
    assert.notEqual((await f.app.request(urls[0])).status, 200);
  const support = f.files.supportFiles().files.find((file) => file.id === runtime.id);
  assert.equal(support.matchesBuiltin, false);
  await f.files.updateSupport(runtime.id, support.revision);
  const restored = f.resources.record(runtime.id).record;
  assert.equal(restored.content, readFileSync('dist/upstream/runtime.js', 'utf8'));
  assert.equal(restored.process.length, 1);
  assert.equal(
    f.files.supportFiles().files.find((file) => file.id === runtime.id).matchesBuiltin,
    true,
  );
});

test('runtime compatibility append rechecks the revision and preserves a concurrent operator edit', async (t) => {
  const f = await fixture(t);
  await f.files.initialize();
  const runtime = f.resources.files('runtime')[0];
  await f.client.api('/api/file/' + runtime.record.name, { process: [] }, 'PATCH');
  const sync = f.resources.syncUnlocked.bind(f.resources);
  const edited = [
    { type: 'Script Operator', args: { mode: 'script', content: '$content += "\\n// edit";' } },
  ];
  let reads = 0;
  f.resources.syncUnlocked = async () => {
    if (++reads === 2)
      await f.client.api('/api/file/' + runtime.record.name, { process: edited }, 'PATCH');
    return sync();
  };
  try {
    await assert.rejects(() => f.files.ensureLegacyChainCompatibility(), {
      code: 'REVISION_CONFLICT',
    });
  } finally {
    f.resources.syncUnlocked = sync;
  }
  assert.deepEqual(
    (await f.client.records('file')).find((file) => file.name === runtime.record.name).process,
    edited,
  );
  await f.files.ensureLegacyChainCompatibility();
  const after = (await f.client.records('file')).find((file) => file.name === runtime.record.name);
  assert.deepEqual(after.process[0], edited[0]);
  assert.equal(after.process.length, 2);
});
