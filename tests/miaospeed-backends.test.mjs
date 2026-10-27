import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MiaospeedBackends } from '../dist/server/miaospeed-backends.js';
import { MiaospeedTester } from '../dist/server/miaospeed.js';
import { MiaospeedClient } from '../dist/server/miaospeed-client.js';
import { speedSettingsSchema } from '../dist/server/shared/miaospeed.js';
import { KernelManager } from '../dist/server/kernels.js';
import { createApp } from '../dist/server/app.js';
import { reportCsv } from '../dist/server/shared/report-export.js';
import { fixture, waitFor } from './upstream-fixture.mjs';
import { controlledNetwork } from './miaospeed-fixture.mjs';

test('backend settings preserve secrets, immutable captures, explicit defaults and environment compatibility', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const store = new MiaospeedBackends(db);
  assert.equal(store.list().defaultBackendId, null);
  store.configure('ws://miaospeed:8765/miaospeed', 'environment-secret');
  assert.equal(store.list().defaultBackendId, 'environment');
  assert.throws(() => store.put({ name: 'Invalid', url: 'wss://u:p@host/path', token: 'secret' }));
  assert.throws(() => store.put({ name: 'Invalid', url: 'https://host/path', token: 'secret' }));
  assert.throws(() =>
    store.put({ name: 'Invalid', url: 'ws://host/path?token=secret', token: 'secret' }),
  );
  assert.throws(() => store.put({ name: 'Missing token', url: 'ws://192.168.1.2:8765/miaospeed' }));
  assert.throws(() => store.remove('environment'));
  assert.throws(() => store.put({ name: 'Read only', url: 'ws://other' }, 'environment'));
  const list = store.put({
    name: 'Tokyo',
    url: 'wss://speed.example.com/miaospeed',
    token: 'remote-secret',
  });
  const id = list.backends.find((b) => b.kind === 'remote').id;
  assert.equal(list.defaultBackendId, 'environment');
  store.setDefault(id);
  const captured = store.capture();
  store.put({ name: 'Renamed', url: 'ws://192.168.1.2:8765/miaospeed', token: '' }, id);
  assert.equal(store.capture(id).token, 'remote-secret');
  assert.equal(captured.backend.name, 'Tokyo');
  assert.equal(captured.backend.url, 'wss://speed.example.com/miaospeed');
  store.put(
    { name: 'Rotated', url: 'wss://speed.example.com/miaospeed', token: 'rotated-secret' },
    id,
  );
  assert.equal(captured.token, 'remote-secret');
  assert.equal(store.capture(id).token, 'rotated-secret');
  assert.ok(!JSON.stringify(store.list()).includes('secret'));
  const reopened = new MiaospeedBackends(db);
  assert.equal(reopened.list().defaultBackendId, id);
  assert.equal(reopened.capture(id).token, 'rotated-secret');
  store.remove(id);
  assert.equal(store.list().defaultBackendId, null);
  assert.throws(() => store.capture(id), { code: 'MIAOSPEED_BACKEND_MISSING' });
  assert.throws(() => store.capture(), { code: 'MIAOSPEED_UNCONFIGURED' });
  assert.equal(captured.token, 'remote-secret');
  const first = store.put({
    name: 'First remote',
    url: 'ws://10.0.0.2:8765/miaospeed',
    token: 'new-secret',
  });
  assert.equal(first.defaultBackendId, first.backends.find((b) => b.kind === 'remote').id);
});

const docker = (args, env = process.env) =>
  execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, env }).trim();
test('a remote WebSocket handshake timeout is a backend error, never a successful measurement', async (t) => {
  const server = createServer();
  const upgraded = Promise.withResolvers();
  let peer;
  server.on('upgrade', (_request, socket) => {
    peer = socket;
    upgraded.resolve();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new MiaospeedClient(
    'ws://127.0.0.1:' + server.address().port + '/miaospeed',
    'public-timeout-fixture',
  );
  const pending = client.run(
    speedSettingsSchema.parse({}),
    [],
    [],
    [],
    new AbortController().signal,
    undefined,
    true,
  );
  const rejected = assert.rejects(pending, { code: 'MIAOSPEED_TIMEOUT' });
  await upgraded.promise;
  t.mock.timers.tick(10000);
  await rejected;
  client.clearCredentials();
  assert.equal(client.configured(), false);
});

test('compose modes select one, two or three services with pinned images and no central token requirement', async () => {
  const lock = JSON.parse(await readFile('upstreams.lock.json', 'utf8'));
  const env = {
    ...process.env,
    PUBLIC_ORIGIN: 'https://submeld.example',
    MIAOSPEED_TOKEN: '',
    MIAOSPEED_BIND: '127.0.0.1',
    MIAOSPEED_PORT: '8765',
  };
  const config = (file, token = '') =>
    JSON.parse(
      docker(['compose', '--env-file', '.env.example', '-f', file, 'config', '--format', 'json'], {
        ...env,
        MIAOSPEED_TOKEN: token,
      }),
    );
  const central = config('compose.central.yaml');
  assert.deepEqual(Object.keys(central.services).sort(), ['sub-store', 'submeld']);
  assert.equal(central.services.submeld.environment.MIAOSPEED_TOKEN, '');
  assert.deepEqual(Object.keys(central.services.submeld.depends_on), ['sub-store']);
  const remote = config('compose.miaospeed.yaml', 'compose-public-test-only');
  assert.deepEqual(Object.keys(remote.services), ['miaospeed']);
  assert.equal(remote.services.miaospeed.image, lock.miaospeed.image);
  assert.ok(remote.services.miaospeed.command.includes('-upload'));
  assert.equal(remote.services.miaospeed.ports[0].host_ip, '127.0.0.1');
  assert.throws(() => config('compose.miaospeed.yaml'));
  assert.deepEqual(
    Object.keys(config('compose.yaml', 'compose-public-test-only').services).sort(),
    ['miaospeed', 'sub-store', 'submeld'],
  );
});

test(
  'two official backends route real native tests, pin credentials, reject incompatible cores and preserve cancellation',
  { timeout: 150000 },
  async (t) => {
    const f = await fixture(t);
    const kernels = new KernelManager(f.directory);
    await kernels.initialize();
    const lease = kernels.snapshot();
    const net = await controlledNetwork(
      lease.binaries.get('singbox').path,
      join(f.directory, 'remote-network'),
    );
    const runBackend = MiaospeedClient.prototype.run;
    const executedUrls = [];
    t.mock.method(MiaospeedClient.prototype, 'run', function (...args) {
      if (args[1].length) executedUrls.push(this.url);
      if (args[0].pingUrl === 'https://fixture.example/ping')
        args[0] = { ...args[0], pingUrl: net.settings.pingUrl };
      return runBackend.apply(this, args);
    });
    const name = 'submeld-test-remote-' + randomUUID();
    const token = 'remote-public-test-' + randomUUID();
    const lock = JSON.parse(await readFile('upstreams.lock.json', 'utf8'));
    let speed,
      started = false;
    f.beforeClose(async () => {
      await speed?.close();
      if (started) docker(['stop', name]);
      await net.close();
      await lease.release();
      await kernels.close();
    });
    docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--label',
      'submeld.purpose=isolated-test',
      '-p',
      '127.0.0.1::8765',
      '--add-host',
      'host.docker.internal:host-gateway',
      lock.miaospeed.image,
      'server',
      '-bind',
      '0.0.0.0:8765',
      '-path',
      'miaospeed',
      '-token',
      token,
      '-upload',
    ]);
    started = true;
    const port = docker(['port', name, '8765/tcp']).match(/127\.0\.0\.1:(\d+)/)[1];
    const url = 'ws://127.0.0.1:' + port + '/miaospeed';
    // Sub-Store still renders the actual payload; a remote native task cannot launch a local core.
    let gate;
    speed = new MiaospeedTester(
      f.miaospeedStore,
      f.miaospeedScripts,
      f.miaospeedInput,
      { snapshot: () => ({ binaries: new Map(), release: async () => {} }) },
      { run: () => assert.fail('Remote native testing must not start a local bridge') },
      f.testActivity,
      f.config,
      async () => {
        if (gate) await gate.promise;
      },
    );
    const registry = f.miaospeedStore.backends;
    const remote = registry
      .put({ name: 'Isolated remote', url, token })
      .backends.find((b) => b.kind === 'remote');
    await waitFor(async () => (await speed.check(remote.id)).connected);
    assert.equal(speed.status(remote.id).version, '4.7.6');
    assert.equal((await speed.check('environment')).connected, true);
    await assert.rejects(
      new MiaospeedClient(url, f.config.miaospeedToken).run(
        speedSettingsSchema.parse({}),
        [],
        [],
        [],
        AbortSignal.timeout(10000),
        undefined,
        true,
      ),
      { code: 'MIAOSPEED_REJECTED' },
    );
    assert.throws(() => speed.captureBackend(remote.id, 'xray'), {
      code: 'MIAOSPEED_CORE_UNSUPPORTED',
    });
    const app = createApp({ ...f, miaospeed: speed });
    const headers = {
      Origin: f.config.publicOrigin,
      'Content-Type': 'application/json',
      'X-SubMeld-Request': '1',
      Cookie: f.cookie,
    };
    assert.equal((await app.request('/api/miaospeed/backends')).status, 401);
    assert.equal(
      (
        await app.request('/api/miaospeed/backends', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.example' },
          body: JSON.stringify({ name: 'bad', url, token }),
        })
      ).status,
      403,
    );
    const listed = await (await app.request('/api/miaospeed/backends', { headers })).text();
    assert.ok(!listed.includes(token));
    const catalog = await f.miaospeedScripts.put({
      name: 'Remote controlled script',
      content: net.script.Content,
    });
    const script = catalog.scripts.find((item) => item.name === 'Remote controlled script');
    const input = async (server, count = 1) => {
      const preview = await f.miaospeedInput.preview({
        kind: 'text',
        content: JSON.stringify({
          proxies: Array.from({ length: count }, (_, i) => ({
            ...net.raw,
            name: 'Remote ' + i,
            server,
          })),
        }),
      });
      return {
        settings: { ...net.settings, pingUrl: 'https://fixture.example/ping' },
        scripts: [{ id: script.id, revision: script.revision }],
        metrics: ['TEST_HTTP_CODE', 'SPEED_AVERAGE', 'USPEED_AVERAGE', 'UDP_TYPE'],
        subjects: preview.nodes.map((n) => ({
          kind: 'temporary',
          previewId: preview.id,
          nodeIndex: n.index,
        })),
      };
    };
    const completed = async (id) => {
      await waitFor(
        () => f.miaospeedStore.get(id).state !== 'running' && !f.testActivity.current(),
        45000,
      );
      return f.miaospeedStore.get(id);
    };
    // The same controlled node also works through the original deployment service.
    const local = await speed.start({
      ...(await input(f.config.miaospeedBridgeHost)),
      backendId: 'environment',
    });
    assert.equal(
      (await completed(local.id)).results[0].measurements.find((m) => m.id === 'SPEED_AVERAGE')
        .status,
      'measured',
    );
    gate = Promise.withResolvers();
    const beforeRemote = { ...net.counts };
    registry.setDefault(remote.id);
    const request = await input('host.docker.internal');
    const report = await speed.start(request);
    registry.put(
      { name: 'Changed', url: 'ws://unused.invalid/miaospeed', token: 'wrong-after-submission' },
      remote.id,
    );
    registry.remove(remote.id);
    gate.resolve();
    gate = undefined;
    const result = await completed(report.id);
    assert.equal(result.backend.name, 'Isolated remote');
    assert.equal(result.backend.url, url);
    assert.equal(result.backendVersion, '4.7.6');
    assert.equal(executedUrls.at(-1), url);
    for (const metric of result.results[0].measurements)
      assert.equal(
        metric.status,
        'measured',
        JSON.stringify({ row: result.results[0], counts: net.counts }),
      );
    assert.ok(
      net.counts.download > beforeRemote.download + 100000 &&
        net.counts.upload > beforeRemote.upload + 100000 &&
        net.counts.stun >= beforeRemote.stun + 4 &&
        net.counts.scripts > beforeRemote.scripts,
    );
    assert.ok(!JSON.stringify(result).includes(token));
    assert.ok(!reportCsv(result).includes(token));
    assert.ok(reportCsv(result).includes('Isolated remote') && reportCsv(result).includes(url));
    assert.equal(registry.list().defaultBackendId, null);
    const next = registry
      .put({ name: 'Cancel remote', url, token })
      .backends.find((b) => b.kind === 'remote');
    const cancelInput = await input('host.docker.internal', 2);
    const before = net.counts.download;
    const cancelling = await speed.start({
      ...cancelInput,
      backendId: next.id,
      metrics: ['SPEED_AVERAGE'],
      settings: { ...net.settings, pingUrl: 'https://fixture.example/ping', downloadSeconds: 5 },
    });
    await waitFor(() => net.counts.download > before + 10000);
    speed.cancel(cancelling.id);
    assert.equal(f.testActivity.current(), 'miaospeed');
    const cancelled = await completed(cancelling.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.results[1].state, 'cancelled');
    docker(['stop', name]);
    started = false;
    assert.equal((await speed.check(next.id)).connected, false);
    const failed = await speed.start({
      ...(await input('host.docker.internal', 2)),
      backendId: next.id,
    });
    const stopped = await completed(failed.id);
    assert.equal(stopped.state, 'failed');
    assert.equal(stopped.results[1].state, 'cancelled');
    assert.equal(stopped.backend.id, next.id);
  },
);
