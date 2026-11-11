import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture } from './upstream-fixture.mjs';
import { node, TEST_PASSWORD } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { AppError } from '../dist/server/errors.js';

async function source(f, drafts = [node('ss')]) {
  return f.nodes.create({
    name: 'validation source',
    source: 'local',
    content: JSON.stringify({ proxies: drafts.map(toUpstream) }),
  });
}
const config = (resource, overrides = {}) => ({
  ...newSubscription(),
  name: 'checked output',
  inputs: [{ kind: 'resource', id: resource.id }],
  ...overrides,
});

test('save returns eight real native checks without storing previews and share rechecks before minting any tokens', async (t) => {
  const f = await fixture(t);
  const resource = await source(f);
  const created = await f.request(
    '/api/subscriptions',
    config(resource, { formats: outputFormats }),
  );
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.deepEqual(
    saved.validation,
    outputFormats.map((format) => ({ format, state: 'ok' })),
  );
  const files = await f.client.records('file');
  assert.equal(
    files.some((record) => record.name.startsWith('sm-preview-')),
    false,
  );
  assert.equal(
    JSON.parse(files.find((record) => record._submeld?.id === saved.id).content).validation,
    undefined,
  );
  assert.equal((await f.client.api('/api/tokens')).length, 0);
  assert.equal(JSON.stringify(saved.validation).includes(TEST_PASSWORD), false);
  const bad = node('vless');
  await f.client.api(
    '/api/sub/' + resource.upstreamName,
    { content: JSON.stringify({ proxies: [toUpstream(bad)] }) },
    'PATCH',
  );
  const rejected = await f.request('/api/subscriptions/' + saved.id + '/share', {
    revision: saved.revision,
  });
  assert.equal(rejected.status, 422);
  const failure = await rejected.json();
  assert.equal(failure.code, 'OUTPUT_VALIDATION_FAILED');
  assert.equal(failure.validation.find((result) => result.format === 'mihomo').state, 'ok');
  const xray = failure.validation.find((result) => result.format === 'xray');
  assert.equal(xray.state, 'failed');
  assert.deepEqual(xray.diagnostics.find((detail) => detail.level === 'error').location, {
    inputIndex: 0,
    resourceName: resource.name,
    nodeName: bad.name,
  });
  assert.equal((await f.client.api('/api/tokens')).length, 0);
  const updated = await f.request(
    '/api/subscriptions/' + saved.id,
    config(resource, { revision: saved.revision, formats: ['uri', 'mihomo', 'xray'] }),
    'PATCH',
  );
  assert.equal(updated.status, 200);
  const warning = await updated.json();
  assert.equal(warning.validation.find((result) => result.format === 'xray').state, 'failed');
  const fixed = await f.subscriptions.update(
    saved.id,
    config(resource, { formats: ['uri', 'mihomo'] }),
    warning.revision,
  );
  const shared = await f.request('/api/subscriptions/' + fixed.id + '/share', {
    revision: fixed.revision,
  });
  assert.equal(shared.status, 200);
  const ready = await shared.json();
  for (const url of Object.values(ready.urls).flat())
    assert.equal((await f.app.request(url)).status, 200);
  await f.client.api('/api/sub/' + resource.upstreamName, { content: '' }, 'PATCH');
  assert.equal(
    (await f.request('/api/subscriptions/' + fixed.id + '/revoke', { revision: fixed.revision }))
      .status,
    200,
  );
  assert.equal((await f.client.api('/api/tokens')).length, 0);
});

test('missing and ambiguous references, empty filters and broken templates remain saveable with actionable native errors', async (t) => {
  const f = await fixture(t);
  const a = node('ss');
  const resource = await source(f, [a, a]);
  const rows = await f.nodes.list(resource.id);
  assert.ok(rows.nodes.every((item) => item.referenceError.includes('名称重复')));
  const broken = await f.subscriptions.create(
    config(resource, {
      formats: ['uri'],
      inputs: [
        { kind: 'node', resourceId: resource.id, nodeName: a.name },
        { kind: 'node', resourceId: resource.id, nodeName: 'missing node' },
        { kind: 'resource', id: randomUUID() },
      ],
    }),
  );
  const problem = broken.validation[0];
  assert.equal(problem.state, 'failed');
  assert.equal(problem.code, 'NODE_REFERENCE_INVALID');
  assert.deepEqual(
    problem.diagnostics.map((detail) => detail.location.inputIndex),
    [0, 1, 2],
  );
  assert.equal(problem.diagnostics[1].location.nodeName, 'missing node');
  const empty = await f.subscriptions.create(
    config(resource, { formats: ['uri'], includeName: 'no matching node' }),
  );
  assert.equal(empty.validation[0].code, 'EMPTY_OUTPUT');
  const template = f.resources
    .files('template')
    .find((entry) => entry.record._submeld.format === 'mihomo');
  await f.client.api('/api/file/' + template.record.name, { content: '{}' }, 'PATCH');
  const invalid = await f.subscriptions.create(config(resource, { formats: ['mihomo'] }));
  assert.equal(invalid.validation[0].state, 'failed');
  assert.equal(invalid.validation[0].code, 'TEMPLATE_FIELD_LOSS');
  await f.client.api('/api/files', {
    ...template.record,
    name: 'duplicate-template',
    _submeld: { ...template.record._submeld, id: randomUUID() },
  });
  const duplicate = await f.subscriptions.create(config(resource, { formats: ['uri', 'mihomo'] }));
  assert.equal(duplicate.validation[0].state, 'ok');
  assert.equal(duplicate.validation[1].code, 'TEMPLATE_INVALID');
  const inactive = await f.subscriptions.create(
    config(resource, { enabled: false, formats: ['uri'], includeName: 'no matching node' }),
  );
  assert.equal(inactive.validation[0].code, 'EMPTY_OUTPUT');
  await assert.rejects(f.subscriptions.share(inactive.id, inactive.revision, false), {
    code: 'OUTPUT_DISABLED',
  });
  assert.equal((await f.client.api('/api/tokens')).length, 0);
});

test('checks execute saved custom runtime and share executes actual output files', async (t) => {
  const f = await fixture(t);
  const resource = await source(f);
  const saved = await f.subscriptions.create(config(resource, { formats: ['uri'] }));
  const runtime = f.resources.files('runtime')[0];
  const custom =
    String(runtime.record.content) +
    '\nSubMeldRuntime.generate = async () => { throw Object.assign(new Error("custom runtime problem"), {code:"CUSTOM_RUNTIME"}); };';
  await f.client.api('/api/file/' + runtime.record.name, { content: custom }, 'PATCH');
  const updated = await f.subscriptions.update(
    saved.id,
    config(resource, { formats: ['uri'] }),
    saved.revision,
  );
  assert.equal(updated.validation[0].code, 'CUSTOM_RUNTIME');
  assert.equal(f.resources.record(runtime.id).record.content, custom);
  await f.client.api(
    '/api/file/' + runtime.record.name,
    { content: runtime.record.content },
    'PATCH',
  );
  const output = f.subscriptions.outputs(saved.id)[0];
  await f.client.api(
    '/api/file/' + output.record.name,
    { process: [{ type: 'Script Operator', args: { mode: 'script', content: '$content = "";' } }] },
    'PATCH',
  );
  const draft = await f.subscriptions.update(
    saved.id,
    config(resource, { formats: ['uri'] }),
    updated.revision,
  );
  assert.equal(draft.validation[0].state, 'ok');
  await assert.rejects(
    f.subscriptions.share(saved.id, draft.revision, false),
    (error) => error.validation[0].code === 'EMPTY_OUTPUT',
  );
  assert.equal((await f.client.api('/api/tokens')).length, 0);
});

test('upstream changes during checks invalidate results and preserve optimistic save and share revisions', async (t) => {
  const f = await fixture(t);
  const resource = await source(f);
  const originalApi = f.client.api.bind(f.client);
  let changed = false;
  f.client.api = async (path, ...args) => {
    const result = await originalApi(path, ...args);
    if (path === '/api/preview/file' && !changed) {
      changed = true;
      await originalApi(
        '/api/sub/' + resource.upstreamName,
        { displayName: 'changed during check' },
        'PATCH',
      );
    }
    return result;
  };
  const saved = await f.subscriptions.create(config(resource, { formats: ['uri'] }));
  assert.equal(saved.validation[0].state, 'unverified');
  assert.equal(saved.validation[0].code, 'REVISION_CONFLICT');
  f.client.api = originalApi;
  const originalRequest = f.client.request.bind(f.client);
  const output = f.subscriptions.outputs(saved.id)[0].record.name;
  f.client.request = async (path, ...args) => {
    const response = await originalRequest(path, ...args);
    if (path === '/api/file/' + output) {
      await originalApi(
        '/api/sub/' + resource.upstreamName,
        { displayName: 'changed before minting' },
        'PATCH',
      );
    }
    return response;
  };
  await assert.rejects(f.subscriptions.share(saved.id, saved.revision, false), {
    code: 'REVISION_CONFLICT',
  });
  f.client.request = originalRequest;
  assert.equal((await f.client.api('/api/tokens')).length, 0);
  const record = f.resources.record(saved.id).record;
  f.client.api = async (path, ...args) => {
    const result = await originalApi(path, ...args);
    if (path === '/api/preview/file')
      await originalApi(
        '/api/file/' + record.name,
        {
          content: JSON.stringify(config(resource, { name: 'concurrent edit', formats: ['uri'] })),
        },
        'PATCH',
      );
    return result;
  };
  await assert.rejects(
    f.subscriptions.update(
      saved.id,
      config(resource, { name: 'stale edit', formats: ['uri'] }),
      saved.revision,
    ),
    { code: 'REVISION_CONFLICT' },
  );
  f.client.api = originalApi;
  assert.equal(f.subscriptions.get(saved.id).name, 'concurrent edit');
});

test('unavailable generation is reported as unverified while saving remains possible', async (t) => {
  const f = await fixture(t);
  const resource = await source(f);
  const originalApi = f.client.api.bind(f.client);
  f.client.api = (path, ...args) => {
    if (path === '/api/preview/file')
      throw new AppError('SUB_STORE_UNAVAILABLE', 'fixture connection unavailable', 503);
    return originalApi(path, ...args);
  };
  const saved = await f.subscriptions.create(config(resource));
  assert.ok(saved.validation.every((result) => result.state === 'unverified'));
  f.client.api = originalApi;
  assert.equal(f.subscriptions.get(saved.id).name, 'checked output');
  assert.equal((await f.client.api('/api/tokens')).length, 0);
});
