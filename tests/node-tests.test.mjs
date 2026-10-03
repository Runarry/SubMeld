import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, ref, subject, waitFor } from './upstream-fixture.mjs';
import { NodeTester } from '../dist/server/node-tests.js';
import { AppError } from '../dist/server/errors.js';
import { coreTargets, DEFAULT_PROBE_URL } from '../dist/server/shared/node-tests.js';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { deferred } from './publication-fixtures.mjs';
import { newSubscription } from '../dist/server/shared/subscriptions.js';
async function setup(t, probe = async () => ({ latencyMs: 12, httpStatus: 204 })) {
  let releases = 0,
    version = '1',
    active = 0,
    maximum = 0;
  const kernels = {
    versions: () => new Map(coreTargets.map((c) => [c, version])),
    snapshot: () => ({
      binaries: new Map(
        coreTargets.map((target) => [target, { target, version, path: 'orchestration-fixture' }]),
      ),
      release: async () => {
        releases++;
      },
    }),
  };
  const f = await fixture(t, {
    makeTester: (store, converter, dir) =>
      new NodeTester(store.nodeTests, kernels, converter, dir, async (...args) => {
        active++;
        maximum = Math.max(maximum, active);
        try {
          return await probe(...args);
        } finally {
          active--;
        }
      }),
  });
  const a = node('ss'),
    b = node('ss');
  a.name = 'entry';
  b.name = 'exit';
  b.port = 444;
  const resource = await f.nodes.create({
    name: 'test-nodes',
    source: 'local',
    content: JSON.stringify({ proxies: [a, b].map(toUpstream) }),
  });
  const list = await f.nodes.list();
  return {
    ...f,
    a,
    b,
    resource,
    rows: list.nodes,
    kernels,
    releases: () => releases,
    maximum: () => maximum,
    version: (v) => {
      version = v;
    },
  };
}
async function finished(f) {
  await waitFor(() => f.tester.current().batch?.state !== 'running');
  return f.tester.current().batch;
}
test('real conversion plus controlled probe preserves target DNS classification', async (t) => {
  const f = await setup(t, async () => {
    throw new AppError('TEST_DNS_FAKE_IP', '测试目标 Fake-IP');
  });
  f.tester.start({ subjects: [subject(f.rows[0])] });
  const batch = await finished(f);
  assert.equal(batch.results.length, 3);
  assert.ok(batch.results.every((r) => r.status === 'target_error'));
  assert.equal(f.releases(), 1);
  assert.equal(f.nodeTests.results([subject(f.rows[0])], f.kernels.versions()).results.length, 3);
});

test('HY2 certificate errors stay specific without folding pin warnings into the failure', async (t) => {
  const f = await setup(t);
  const resource = await f.nodes.create({
    name: 'pinned-hy2',
    source: 'local',
    content: 'hysteria2://public-test-only@example.com:443?insecure=1&pinSHA256=' + 'ab'.repeat(32),
  });
  const row = (await f.nodes.list(resource.id)).nodes[0];
  f.tester.start({ subjects: [subject(row)] });
  const results = (await finished(f)).results;
  const singbox = results.find((result) => result.core === 'singbox');
  assert.equal(singbox.status, 'config_error');
  assert.match(singbox.message, /证书解析/);
  assert.doesNotMatch(singbox.message, /原节点跳过证书链验证/);
  assert.equal(results.find((result) => result.core === 'mihomo').status, 'passed');
  assert.equal(results.find((result) => result.core === 'xray').status, 'passed');
});
test('excluded raw nodes and complete chains test sequentially without changing upstream plans', async (t) => {
  const f = await setup(t);
  const chain = await f.chains.create({
    name: 'chain',
    enabled: true,
    entry: { resourceId: f.resource.id, nodeName: 'entry' },
    exit: { resourceId: f.resource.id, nodeName: 'exit' },
  });
  const plan = await f.subscriptions.create({
    ...newSubscription(),
    name: 'unchanged',
    inputs: [{ kind: 'chain', id: chain.id }],
  });
  const chainSubject = {
    kind: 'chain',
    id: chain.id,
    revision: chain.revision,
    entry: ref(chain.entryNode),
    exit: ref(chain.exitNode),
  };
  f.tester.start({ subjects: [chainSubject] });
  assert.equal(
    (await finished(f)).results.every((r) => r.status === 'passed'),
    true,
  );
  const record = f.resources.record(f.resource.id).record;
  await f.client.api(
    '/api/sub/' + record.name,
    { process: [{ type: 'Regex Filter', args: { regex: [], keep: true } }] },
    'PATCH',
  );
  await f.resources.sync();
  const excluded = (await f.nodes.list()).nodes[0];
  assert.equal(excluded.available, false);
  assert.equal(excluded.testable, true);
  f.tester.start({ subjects: [subject(excluded)] });
  assert.equal(
    (await finished(f)).results.every((r) => r.status === 'passed'),
    true,
  );
  assert.equal(f.maximum(), 1);
  assert.equal(f.subscriptions.get(plan.id).revision, plan.revision);
});
test('a late result cannot be saved against reordered subscription positions', async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await setup(t, async () => {
    entered.resolve();
    await release.promise;
    return { latencyMs: 1, httpStatus: 204 };
  });
  f.tester.start({ subjects: [subject(f.rows[0])] });
  await entered.promise;
  const record = f.resources.record(f.resource.id).record;
  await f.client.api(
    '/api/sub/' + record.name,
    { content: JSON.stringify({ proxies: [f.b, f.a].map(toUpstream) }) },
    'PATCH',
  );
  release.resolve();
  const batch = await finished(f);
  assert.ok(batch.results.every((r) => r.status === 'stale'));
  assert.equal(f.nodeTests.results([subject(f.rows[0])], f.kernels.versions()).results.length, 0);
  const fresh = (await f.nodes.list()).nodes;
  assert.equal(fresh[0].name, 'exit');
  assert.equal(f.nodeTests.results([subject(fresh[0])], f.kernels.versions()).results.length, 0);
});
test('chain member credentials changing during a test make the result stale', async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await setup(t, async () => {
    entered.resolve();
    await release.promise;
    return { latencyMs: 1, httpStatus: 204 };
  });
  const chain = await f.chains.create({
    name: 'chain',
    enabled: true,
    entry: { resourceId: f.resource.id, nodeName: 'entry' },
    exit: { resourceId: f.resource.id, nodeName: 'exit' },
  });
  f.tester.start({
    subjects: [
      {
        kind: 'chain',
        id: chain.id,
        revision: chain.revision,
        entry: ref(chain.entryNode),
        exit: ref(chain.exitNode),
      },
    ],
  });
  await entered.promise;
  f.b.auth.password = 'public-test-changed';
  await f.client.api(
    '/api/sub/' + f.resources.record(f.resource.id).record.name,
    { content: JSON.stringify({ proxies: [f.a, f.b].map(toUpstream) }) },
    'PATCH',
  );
  release.resolve();
  assert.ok((await finished(f)).results.every((r) => r.status === 'stale'));
});
test('batch cancellation releases the kernel lease and prevents concurrent batches', async (t) => {
  const entered = deferred();
  const f = await setup(t, async (...args) => {
    entered.resolve();
    await delay(10000, undefined, { signal: args[5] });
    return { latencyMs: 1, httpStatus: 204 };
  });
  const batch = f.tester.start({ subjects: f.rows.map(subject) });
  await entered.promise;
  assert.throws(() => f.tester.start({ subjects: [subject(f.rows[0])] }), { code: 'TEST_BUSY' });
  f.tester.cancel(batch.id);
  const done = await finished(f);
  assert.equal(done.state, 'cancelled');
  assert.equal(done.completed, 1);
  assert.equal(f.releases(), 1);
});
test('saved results become stale when target URL or kernel version changes', async (t) => {
  const f = await setup(t);
  const subjects = [subject(f.rows[0])];
  f.tester.start({ subjects });
  await finished(f);
  assert.ok(f.nodeTests.results(subjects, f.kernels.versions()).results.every((r) => !r.stale));
  f.nodeTests.updateSettings({ url: 'https://example.com/health' });
  assert.ok(f.nodeTests.results(subjects, f.kernels.versions()).results.every((r) => r.stale));
  f.nodeTests.updateSettings({ url: DEFAULT_PROBE_URL });
  f.version('2');
  assert.ok(f.nodeTests.results(subjects, f.kernels.versions()).results.every((r) => r.stale));
});
test('HTTP test selection rejects missing snapshots and private target settings', async (t) => {
  const f = await setup(t);
  assert.equal(
    (
      await f.request('/api/node-tests', {
        subjects: [{ kind: 'node', resourceId: f.resource.id }],
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/api/node-tests/settings', { url: 'https://127.0.0.1/' }, 'PATCH')).status,
    400,
  );
  const response = await f.request('/api/node-tests', { subjects: [subject(f.rows[0])] });
  assert.equal(response.status, 202);
  await finished(f);
  assert.equal(
    (await f.request('/api/node-tests/results/query', { subjects: [subject(f.rows[0])] })).status,
    200,
  );
});
