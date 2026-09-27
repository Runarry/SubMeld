import { resetUpstream } from './upstream-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openSettings } from '../dist/server/database.js';
import { NodeTester } from '../dist/server/node-tests.js';
import { AppError } from '../dist/server/errors.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { createApp } from '../dist/server/app.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';
import { coreTargets, DEFAULT_PROBE_URL } from '../dist/server/shared/node-tests.js';
import { node } from './fixtures.mjs';
import { ControlledConverter, deferred } from './publication-fixtures.mjs';
async function fixture(probe = async () => ({ latencyMs: 12, httpStatus: 204 })) {
  await resetUpstream();
  const directory = mkdtempSync(join(tmpdir(), 'submeld-node-tests-'));
  const settings = openSettings(directory, true),
    converter = new ControlledConverter();
  let version = '1',
    releases = 0,
    active = 0,
    maximum = 0;
  const kernels = {
    versions: () => new Map(coreTargets.map((core) => [core, version])),
    snapshot() {
      return {
        binaries: new Map(
          coreTargets.map((target) => [target, { target, version, path: 'fixture-only' }]),
        ),
        release: async () => {
          releases++;
        },
      };
    },
    status: () => ({
      kernels: coreTargets.map((target) => ({
        target,
        currentVersion: version,
        latestVersion: version,
        state: 'idle',
        checkedAt: null,
        error: null,
      })),
    }),
    async check() {
      return this.status();
    },
    update() {
      return this.status();
    },
  };
  const tester = new NodeTester(
    settings.nodeTests,
    kernels,
    converter,
    directory,
    async (...args) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await probe(...args);
      } finally {
        active--;
      }
    },
  );
  const drafts = [node('ss'), node('ss')];
  drafts[0].name = 'entry';
  drafts[1].name = 'exit';
  const [entry, exit] = (await settings.nodes.create({ drafts })).nodes;
  const subject = (value) => ({ kind: 'node', id: value.id, revision: value.revision });
  return {
    directory,
    settings,
    converter,
    tester,
    kernels,
    entry,
    exit,
    subject,
    setVersion(value) {
      version = value;
    },
    get releases() {
      return releases;
    },
    get maximum() {
      return maximum;
    },
    async close() {
      await tester.close();
      settings.close();
      assert.ok(
        resolve(directory).startsWith(
          resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'),
        ),
      );
      assert.ok(directory.includes('submeld-node-tests-'));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function finished(tester) {
  const deadline = Date.now() + 5000;
  while (tester.current().batch?.state === 'running') {
    if (Date.now() > deadline) throw new Error('Test batch did not finish');
    await delay(5);
  }
  // Completion includes lease cleanup before a new batch can start.
  await delay(0);
  return tester.current().batch;
}
const resultFor = (subject, core = 'mihomo') => ({
  subject,
  name: 'saved',
  core,
  coreVersion: '1',
  url: DEFAULT_PROBE_URL,
  testedAt: new Date().toISOString(),
  status: 'passed',
  latencyMs: 42,
  httpStatus: 204,
  message: 'passed',
  stale: false,
});

test('target DNS failures remain distinct from node connection failures in saved results', async () => {
  const f = await fixture(async () => {
    throw new AppError('TEST_DNS_FAKE_IP', '测试目标 Fake-IP');
  });
  try {
    f.tester.start({ subjects: [f.subject(f.entry)] });
    const batch = await finished(f.tester);
    assert.ok(batch.results.every((result) => result.status === 'target_error'));
    assert.equal(batch.results.length, 3);
  } finally {
    await f.close();
  }
});
test('tests disabled nodes and complete chains sequentially without changing publication revisions', async () => {
  const f = await fixture();
  try {
    const entry = await f.settings.nodes.update(f.entry.id, { revision: 1, enabled: false });
    const chain = f.settings.chains.create({
      name: 'disabled chain',
      enabled: false,
      entryNodeId: entry.id,
      exitNodeId: f.exit.id,
    });
    const sub = f.settings.subscriptions.create({
      ...newSubscription(),
      name: 'unchanged',
      inputs: [{ kind: 'node', id: entry.id }],
    });
    const before = f.settings.subscriptions.get(sub.id);
    f.tester.start({
      subjects: [
        f.subject(entry),
        {
          kind: 'chain',
          id: chain.id,
          revision: chain.revision,
          entryRevision: entry.revision,
          exitRevision: f.exit.revision,
        },
      ],
    });
    const batch = await finished(f.tester);
    assert.equal(batch.state, 'completed');
    assert.equal(batch.completed, 6);
    assert.ok(batch.results.every((result) => result.status === 'passed'));
    assert.equal(f.maximum, 1);
    assert.equal(f.releases, 1);
    assert.deepEqual(f.settings.subscriptions.get(sub.id), before);
    assert.equal(f.settings.nodes.get(entry.id).enabled, false);
    const renders = f.converter.calls.filter((call) => call.kind === 'render');
    assert.ok(
      renders
        .slice(3)
        .every((call) => call.input.items[0].kind === 'chain' && call.input.items[0].available),
    );
    const results = f.settings.nodeTests.results([f.subject(entry)], f.kernels.versions()).results;
    assert.equal(results.length, 3);
    f.settings.close();
    const reopened = openSettings(f.directory, true);
    assert.equal(
      reopened.nodeTests.results([f.subject(entry)], f.kernels.versions()).results.length,
      3,
    );
    reopened.close();
  } finally {
    await f.close();
  }
});
test('late node and chain results cannot commit after a member changes; new references mark old results stale', async () => {
  const entered = deferred(),
    released = deferred();
  const f = await fixture(async () => {
    entered.resolve();
    await released.promise;
    return { latencyMs: 1, httpStatus: 204 };
  });
  try {
    const chain = f.settings.chains.create({
      name: 'chain',
      entryNodeId: f.entry.id,
      exitNodeId: f.exit.id,
    });
    const ref = {
      kind: 'chain',
      id: chain.id,
      revision: chain.revision,
      entryRevision: f.entry.revision,
      exitRevision: f.exit.revision,
    };
    f.settings.nodeTests.save(resultFor(f.subject(f.entry)));
    f.tester.start({ subjects: [ref, f.subject(f.entry)] });
    await entered.promise;
    const updated = await f.settings.nodes.update(f.entry.id, {
      revision: 1,
      changes: { name: 'changed' },
    });
    released.resolve();
    const batch = await finished(f.tester);
    assert.ok(batch.results.every((result) => result.status === 'stale'));
    assert.equal(f.settings.nodeTests.results([ref], f.kernels.versions()).results.length, 0);
    assert.equal(
      f.settings.nodeTests.results([f.subject(updated)], f.kernels.versions()).results[0].stale,
      true,
    );
  } finally {
    released.resolve();
    await f.close();
  }
});
test('one batch pins its versions while updates and settings changes flag saved results for retesting', async () => {
  const entered = deferred(),
    released = deferred(),
    versions = [];
  const f = await fixture(async (binary) => {
    versions.push(binary.version);
    entered.resolve();
    await released.promise;
    return { latencyMs: 1, httpStatus: 204 };
  });
  try {
    const subject = f.subject(f.entry);
    f.tester.start({ subjects: [subject] });
    await entered.promise;
    assert.throws(
      () => f.tester.start({ subjects: [subject] }),
      (e) => e.code === 'TEST_BUSY',
    );
    f.setVersion('2');
    f.settings.nodeTests.updateSettings({ url: 'https://example.com/probe' });
    released.resolve();
    await finished(f.tester);
    assert.deepEqual(versions, ['1', '1', '1']);
    assert.ok(
      f.settings.nodeTests
        .results([subject], f.kernels.versions())
        .results.every((result) => result.stale),
    );
    f.tester.start({ subjects: [subject] });
    await finished(f.tester);
    assert.deepEqual(versions.slice(3), ['2', '2', '2']);
    assert.ok(
      f.settings.nodeTests
        .results([subject], f.kernels.versions())
        .results.every((result) => !result.stale),
    );
  } finally {
    released.resolve();
    await f.close();
  }
});
test('cancel and shutdown abort active requests, release kernels, and preserve prior complete results', async () => {
  for (const shutdown of [false, true]) {
    const entered = deferred();
    const f = await fixture(async (_binary, _config, _port, _url, _dir, signal) => {
      entered.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    try {
      const subject = f.subject(f.entry);
      f.settings.nodeTests.save(resultFor(subject));
      const job = f.tester.start({ subjects: [subject] });
      await entered.promise;
      if (shutdown) await f.tester.close();
      else f.tester.cancel(job.id);
      const batch = await finished(f.tester);
      assert.equal(batch.state, 'cancelled');
      assert.equal(f.releases, 1);
      const saved = f.settings.nodeTests.results([subject], f.kernels.versions()).results;
      assert.equal(saved.length, 1);
      assert.equal(saved[0].latencyMs, 42);
    } finally {
      await f.close();
    }
  }
});
test('unsupported output and abnormal HTTP are distinct; Converter waiting is cancellable', async () => {
  const f = await fixture(async () => ({ latencyMs: 8, httpStatus: 302 }));
  try {
    const [hy2] = (await f.settings.nodes.create({ drafts: [node('hysteria2')] })).nodes;
    f.tester.start({ subjects: [f.subject(hy2)] });
    const batch = await finished(f.tester);
    assert.deepEqual(
      batch.results.map((result) => result.status),
      ['http_error', 'http_error', 'unsupported'],
    );
    f.converter.busy = true;
    f.tester.start({ subjects: [f.subject(hy2)] });
    await delay(5);
    await f.tester.close();
    assert.equal(f.converter.listeners.size, 0);
    assert.equal(f.tester.current().batch.state, 'cancelled');
  } finally {
    await f.close();
  }
});
test('test and kernel endpoints enforce login, Origin, structured references and saved settings', async () => {
  const f = await fixture();
  const auth = new Auth(await hashPassword('test-admin-password-2026'));
  try {
    const origin = 'http://127.0.0.1:3333';
    const app = createApp({
      config: { publicOrigin: origin, dataDir: f.directory, development: true },
      auth,
      converter: f.converter,
      nodes: f.settings.nodes,
      sources: f.settings.sources,
      chains: f.settings.chains,
      subscriptions: f.settings.subscriptions,
      publisher: {},
      resources: f.settings.resources,
      tester: f.tester,
    });
    let cookie = '';
    const call = (path, body, method = body === undefined ? 'GET' : 'POST', overrides = {}) =>
      app.request(origin + path, {
        method,
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-SubMeld-Request': '1',
          Cookie: cookie,
          ...overrides,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const path of ['/api/node-tests/current', '/api/node-tests/settings', '/api/kernels'])
      assert.equal((await call(path)).status, 401);
    const login = await call('/api/auth/login', { password: 'test-admin-password-2026' });
    cookie = login.headers.get('set-cookie').split(';')[0];
    for (const path of [
      '/api/node-tests',
      '/api/node-tests/results/query',
      '/api/kernels/check',
      '/api/kernels/xray/update',
      '/api/node-tests/missing/cancel',
    ])
      assert.equal((await call(path, {}, 'POST', { Origin: 'https://wrong.example' })).status, 403);
    assert.equal(
      (await call('/api/node-tests/settings', { url: 'https://127.0.0.1/' }, 'PATCH')).status,
      400,
    );
    const previousUrl = f.settings.nodeTests.settings().url;
    assert.equal(
      (
        await call(
          '/api/node-tests/settings',
          { url: 'https://example.com/' + '测'.repeat(500) },
          'PATCH',
        )
      ).status,
      400,
    );
    assert.equal(f.settings.nodeTests.settings().url, previousUrl);
    assert.equal(
      (await call('/api/node-tests', { subjects: [f.subject(f.entry)], command: 'ignored' }))
        .status,
      400,
    );
    assert.equal(
      (await call('/api/node-tests', { subjects: [f.subject(f.entry), f.subject(f.entry)] }))
        .status,
      400,
    );
    assert.equal(
      (await call('/api/kernels/xray/update', { url: 'https://untrusted.example/executable' }))
        .status,
      400,
    );
    const response = await call('/api/node-tests', { subjects: [f.subject(f.entry)] });
    assert.equal(response.status, 202);
    const batch = await response.json();
    await finished(f.tester);
    const result = await (await call('/api/node-tests/' + batch.id)).json();
    assert.equal(result.completed, 3);
    assert.ok(
      !JSON.stringify(result).includes(f.settings.nodes.get(f.entry.id).draft.auth.password),
    );
    assert.equal(
      (await call('/api/node-tests/results/query', { subjects: [f.subject(f.entry)] })).status,
      200,
    );
    assert.equal((await call('/api/kernels/check', {})).status, 200);
    assert.equal((await call('/api/kernels/xray/update', {})).status, 202);
    assert.throws(
      () => f.settings.nodeTests.updateSettings({ url: 'http://example.com' }),
      AppError,
    );
  } finally {
    auth.close();
    await f.close();
  }
});
