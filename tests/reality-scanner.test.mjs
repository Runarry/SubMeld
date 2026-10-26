import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { RealityScanner } from '../dist/server/reality-scanner.js';
import { RealityScannerStore } from '../dist/server/reality-scanner-store.js';
import { parseScannerFields, parseScannerLine } from '../dist/server/reality-scanner-output.js';
import {
  normalizeScanTargets,
  scanParametersSchema,
  scanActive,
} from '../dist/server/shared/reality-scanner.js';
import {
  fetchScannerPage,
  extractScannerDomains,
  scannerSourceUrl,
} from '../dist/server/reality-scanner-source.js';
import { startProcess } from '../dist/server/kernel-process.js';
import { scannerTlsFixture } from './reality-scanner-fixture.mjs';
import { testCertificate } from './source-tls-fixture.mjs';
import { createApp } from '../dist/server/app.js';
import { openSettings } from '../dist/server/database.js';
import { Auth, hashPassword } from '../dist/server/auth.js';

async function until(predicate, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail('Timed out waiting for scanner evidence');
}
async function runtime(t, options = {}, corruptGeo = false) {
  const directory = mkdtempSync(join(tmpdir(), 'submeld-reality-'));
  const db = new Database(join(directory, 'test.sqlite'));
  db.pragma('foreign_keys=ON');
  if (corruptGeo) {
    mkdirSync(join(directory, 'reality-scanner'));
    writeFileSync(join(directory, 'reality-scanner/Country.mmdb'), 'invalid');
  }
  const store = new RealityScannerStore(db);
  const scanner = new RealityScanner(store, directory, options);
  await scanner.initialize();
  t.after(async () => {
    await scanner.close();
    db.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir())) && directory.includes('submeld-reality-'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(scanner.status().available, true, scanner.status().message);
  return { scanner, store, directory, db };
}
async function finished(scanner, store, id) {
  await until(() => !scanner.status().active);
  return store.get(id);
}
const parameters = (port, extra = {}) =>
  scanParametersSchema.parse({ port, timeoutSeconds: 1, ...extra });

test('finite inputs merge overlapping CIDRs, validate every line, and enforce the unique target limit', () => {
  const value = normalizeScanTargets(
    'EXAMPLE.COM\nexample.com.\n192.0.2.3/30\n192.0.2.2\n192.0.2.0/31',
  );
  assert.deepEqual(value.targets, [
    '192.0.2.0',
    '192.0.2.1',
    '192.0.2.2',
    '192.0.2.3',
    'example.com',
  ]);
  assert.equal(value.invalidCount, 0);
  assert.equal(normalizeScanTargets('10.1.0.0/16\n10.1.2.0/24').count, 65536);
  assert.equal(normalizeScanTargets('10.1.0.0/16\nexample.com').invalidCount, 1);
  assert.equal(normalizeScanTargets('0.0.0.0/0').targets.length, 0);
  assert.equal(normalizeScanTargets('2001:db8::/32', true).invalidCount, 1);
  assert.equal(normalizeScanTargets('2001:db8::/126').invalidCount, 1);
  assert.deepEqual(normalizeScanTargets('2001:db8::/126', true).targets, [
    '2001:db8::',
    '2001:db8::1',
    '2001:db8::2',
    '2001:db8::3',
  ]);
  assert.deepEqual(normalizeScanTargets('::ffff:192.0.2.1\n192.0.2.1', true).targets, [
    '192.0.2.1',
  ]);
  assert.equal(
    normalizeScanTargets(
      'https://example.com\nexample.com:443\n10.1.1.1/33\n::1%lo\n*.test\n-not-a-flag',
    ).invalidCount,
    6,
  );
  assert.equal(normalizeScanTargets('a'.repeat(4 * 1024 * 1024 + 1)).invalidCount, 1);
  assert.equal(normalizeScanTargets('').invalidCount, 1);
});

test('fixed upstream slog parser preserves quoted certificate text and does not invent failure identity', () => {
  const fields = parseScannerFields(
    'time=now level=INFO msg="Connected to target" cert-issuer="A, \\"quoted\\" \\x07\\u4e2d\\U0001f30d"',
  );
  assert.equal(fields['cert-issuer'], 'A, "quoted" \x07中🌍');
  assert.throws(() => parseScannerFields('level=INFO msg="broken'));
  assert.equal(
    parseScannerLine('time=now level=INFO msg="Scanning completed" time=now elapsed=1s', 443, 0)
      .kind,
    'completed',
  );
  const connected = parseScannerLine(
    'time=now level=INFO msg="Connected to target" feasible=true ip=127.0.0.1 origin=localhost tls="TLS 1.3" alpn=h2 curve=X25519 cert-length="1200(certs count: 1)" cert-signature=SHA256-RSA cert-publickey=RSA cert-domain=*.scanner.test cert-issuer="Test Issuer" geo=N/A',
    443,
    0,
  );
  assert.equal(connected.result.state, 'matched');
  assert.equal(connected.result.countryCode, '');
  assert.equal(connected.result.certDomain, '*.scanner.test');
  const failure = parseScannerLine(
    'level=DEBUG msg="Cannot dial" target="[::1]:443"',
    443,
    1,
  ).result;
  assert.equal(failure.ip, '::1');
  assert.equal(failure.origin, '');
  assert.match(failure.message, /上游未返回/);
});

test('web extraction stays on one page, normalizes domains, and rejects unsafe source URLs', async (t) => {
  assert.deepEqual(
    extractScannerDomains(
      '<a href="https://A.example/path">A</a> http://a.example/ https://b.example:8443/path https://127.0.0.1/a /relative https://user:pass@secret.example/',
    ),
    ['a.example', 'b.example'],
  );
  assert.throws(() => scannerSourceUrl('file:///etc/passwd'));
  assert.throws(() => scannerSourceUrl('https://user:pass@example.com'));
  await assert.rejects(fetchScannerPage('http://127.0.0.1/', AbortSignal.timeout(1000)), /公网/);
  const { scanner } = await runtime(t, {
    fetchPage: async () => '<a href="https://fixture.example/path">a</a>',
  });
  assert.deepEqual((await scanner.preview({ kind: 'url', url: 'https://page.example' })).targets, [
    'fixture.example',
  ]);
  assert.equal(
    (await scanner.preview({ kind: 'text', text: 'good.example\nbad://input' })).invalidCount,
    1,
  );
});

test('official binary produces real TLS candidates, finite single targets, SNI, and IPv6 results', async (t) => {
  const handles = [],
    calls = [];
  const { scanner, store, directory } = await runtime(t, {
    launch(...args) {
      calls.push(args[1]);
      const child = startProcess(...args);
      handles.push(child);
      return child;
    },
  });
  const tls = await scannerTlsFixture();
  t.after(() => tls.close());
  let scan = scanner.start({
    targets: ['127.0.0.1', 'localhost'],
    parameters: parameters(tls.port),
  });
  scan = await finished(scanner, store, scan.id);
  assert.equal(scan.state, 'completed', scan.message);
  assert.equal(scan.completed, 2);
  assert.equal(scan.matched, 2);
  assert.ok(tls.names.includes('localhost'));
  const rows = store.results(scan.id, {}, 0).results;
  assert.equal(rows[0].certDomain, '*.scanner.test');
  assert.equal(rows[0].certIssuer, 'SubMeld Test Issuer');
  assert.equal(rows[0].tls, 'TLS 1.3');
  assert.equal(rows[0].alpn, 'h2');
  assert.match(rows[0].certLength, /certs count: 1/);
  assert.equal(scan.geoip, 'unavailable');
  assert.ok(
    calls.every(
      (args) => args.includes('-in') && !args.includes('-addr') && !args.includes('-url'),
    ),
  );
  const v6 = await scannerTlsFixture({ host: '::1' });
  t.after(() => v6.close());
  scan = scanner.start({ targets: ['::1'], parameters: parameters(v6.port, { enableIpv6: true }) });
  scan = await finished(scanner, store, scan.id);
  assert.equal(scan.state, 'completed');
  assert.equal(scan.matched, 1);
  assert.equal(store.results(scan.id, {}, 0).results[0].ip, '::1');
  assert.ok(handles.every((child) => child.exited));
  assert.deepEqual(readdirSync(join(directory, 'reality-scanner')), []);
});

test('official scanner distinguishes TLS versions, ALPN, absent issuer, refused connections, and handshake timeout', async (t) => {
  const { scanner, store } = await runtime(t, {}, true);
  assert.equal(scanner.status().geoip, 'unavailable');
  for (const options of [
    { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' },
    { ALPNProtocols: ['http/1.1'] },
    { cert: testCertificate },
  ]) {
    const tls = await scannerTlsFixture(options);
    try {
      const scan = scanner.start({ targets: ['127.0.0.1'], parameters: parameters(tls.port) });
      const result = await finished(scanner, store, scan.id);
      assert.equal(result.state, 'completed', result.message);
      assert.equal(result.unmatched, 1);
      assert.equal(result.matched, 0);
    } finally {
      await tls.close();
    }
  }
  const closed = await scannerTlsFixture();
  await closed.close();
  let scan = scanner.start({ targets: ['127.0.0.1'], parameters: parameters(closed.port) });
  assert.equal((await finished(scanner, store, scan.id)).failed, 1);
  const slow = await scannerTlsFixture({
    SNICallback() {
      /* Deliberately hold the real TLS handshake. */
    },
  });
  try {
    scan = scanner.start({ targets: ['localhost'], parameters: parameters(slow.port) });
    const result = await finished(scanner, store, scan.id);
    assert.equal(result.state, 'completed');
    assert.equal(result.failed, 1);
    assert.match(store.results(scan.id, {}, 0).results[0].message, /TLS 握手失败/);
  } finally {
    await slow.close();
  }
});

test('cancellation preserves partial real results, rejects concurrent tasks, and releases processes and input files', async (t) => {
  const { scanner, store, directory } = await runtime(t);
  const tls = await scannerTlsFixture({ SNICallback() {} });
  t.after(() => tls.close());
  const request = {
    targets: ['127.0.0.1', 'localhost'],
    parameters: parameters(tls.port, { timeoutSeconds: 30 }),
  };
  const scan = scanner.start(request);
  assert.throws(() => scanner.start(request), { code: 'SCAN_BUSY' });
  assert.throws(() => scanner.remove(scan.id), { code: 'SCAN_BUSY' });
  await until(() => store.get(scan.id).completed === 1);
  scanner.cancel(scan.id);
  const result = await finished(scanner, store, scan.id);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.matched, 1);
  assert.equal(result.completed, 1);
  await until(() => tls.sockets.size === 0);
  assert.deepEqual(readdirSync(join(directory, 'reality-scanner')), []);
  const preparing = scanner.start(request);
  scanner.cancel(preparing.id);
  assert.equal((await finished(scanner, store, preparing.id)).state, 'cancelled');
});

test('errors, incomplete output and abnormal exits cannot report success; later scans remain available', async (t) => {
  let output = 'level=ERROR msg="Error opening file"\n';
  let exitCode = 0;
  const { scanner, store } = await runtime(t, {
    launch(_binary, _args, cwd, input, onOutput) {
      return startProcess(
        process.execPath,
        [
          '-e',
          'process.stdout.write(' + JSON.stringify(output) + '); process.exitCode=' + exitCode,
        ],
        cwd,
        input,
        onOutput,
      );
    },
  });
  const request = { targets: ['127.0.0.1'], parameters: parameters(443) };
  let scan = scanner.start(request);
  assert.equal((await finished(scanner, store, scan.id)).state, 'failed');
  output = 'level=INFO msg="Started all scanning threads"\nlevel=INFO msg="Scanning completed"\n';
  scan = scanner.start(request);
  assert.equal((await finished(scanner, store, scan.id)).state, 'failed');
  output =
    'level=INFO msg="Started all scanning threads"\nlevel=DEBUG msg="Cannot dial" target=127.0.0.1:443\nlevel=INFO msg="Scanning completed"\n';
  exitCode = 2;
  scan = scanner.start(request);
  const abnormal = await finished(scanner, store, scan.id);
  assert.equal(abnormal.state, 'failed');
  assert.equal(abnormal.completed, 1);
});

test('cancellation discards an unfinished output line without turning an intentional stop into failure', async (t) => {
  const output = 'level=INFO msg="Started all scanning threads"\nlevel=INFO msg="Connected to tar';
  const { scanner, store } = await runtime(t, {
    launch(_binary, _args, cwd, input, onOutput) {
      return startProcess(
        process.execPath,
        ['-e', 'process.stdout.write(' + JSON.stringify(output) + '); setInterval(() => {}, 1000)'],
        cwd,
        input,
        onOutput,
      );
    },
  });
  const scan = scanner.start({ targets: ['127.0.0.1'], parameters: parameters(443) });
  await until(() => store.get(scan.id).state === 'running');
  scanner.cancel(scan.id);
  const stopped = await finished(scanner, store, scan.id);
  assert.equal(stopped.state, 'cancelled');
  assert.equal(stopped.completed, 0);
  assert.equal(store.results(scan.id, {}, 0).total, 0);
});

test('service close and reopening interrupt unfinished scans, retain snapshots, and support filtered exports and deletion', async (t) => {
  const { scanner, store, db } = await runtime(t);
  const tls = await scannerTlsFixture({ SNICallback() {} });
  t.after(() => tls.close());
  const scan = scanner.start({
    targets: ['127.0.0.1', 'localhost'],
    parameters: parameters(tls.port, { timeoutSeconds: 30 }),
  });
  await until(() => store.get(scan.id).completed === 1);
  await scanner.close();
  assert.equal(store.get(scan.id).state, 'interrupted');
  assert.equal(scanner.status().active, null);
  const snapshot = store.results(scan.id, {}, 0).results[0];
  store.save({ ...store.get(scan.id), state: 'running', finishedAt: null });
  const reopened = new RealityScannerStore(db);
  assert.equal(reopened.get(scan.id).state, 'interrupted');
  assert.deepEqual(reopened.results(scan.id, {}, 0).results[0], snapshot);
  assert.equal(reopened.results(scan.id, { state: 'matched', search: 'SCANNER.TEST' }, 0).total, 1);
  assert.equal(reopened.results(scan.id, { state: 'failed' }, 0).total, 0);
  assert.match(scanner.export(scan.id, {}, 'csv'), /SubMeld Test Issuer/);
  assert.equal(scanner.export(scan.id, {}, 'ips'), '127.0.0.1\n');
  const hostile = {
    ...snapshot,
    position: 1,
    origin: 'domain.example',
    certIssuer: '@SUM(1,2)\n"quoted"',
  };
  reopened.append({ ...reopened.get(scan.id), completed: 2, matched: 2 }, hostile);
  assert.match(scanner.export(scan.id, {}, 'csv'), /"'@SUM\(1,2\)\n""quoted"""/);
  assert.equal(scanner.export(scan.id, {}, 'domains'), 'domain.example\n');
  for (let n = 0; n < 26; n++) reopened.save({ ...reopened.get(scan.id), id: randomUUID() });
  assert.equal(reopened.list(0).scans.length, 25);
  assert.equal(reopened.list(1).scans.length, 2);
  scanner.remove(scan.id);
  assert.throws(() => reopened.get(scan.id), { code: 'SCAN_NOT_FOUND' });
  assert.equal(
    db.prepare('SELECT count(*) n FROM reality_scan_results WHERE scan_id=?').get(scan.id).n,
    0,
  );
});

test('scanner routes enforce login, origin and request validation and return filtered downloads', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'submeld-reality-api-'));
  const settings = openSettings(directory, true);
  const auth = new Auth(await hashPassword('scanner-test-password'));
  const scanner = new RealityScanner(settings.realityScans, directory);
  await scanner.initialize();
  const tls = await scannerTlsFixture();
  t.after(async () => {
    await tls.close();
    await scanner.close();
    auth.close();
    settings.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir())) &&
        directory.includes('submeld-reality-api-'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  const config = { publicOrigin: 'https://scanner.test', development: true, dataDir: directory };
  const app = createApp({
    config,
    auth,
    realityScanner: scanner,
    resources: settings.resources,
    nodes: settings.nodes,
    subscriptions: settings.subscriptions,
  });
  const base = '/api/reality-scanner';
  assert.equal((await app.request(base + '/status')).status, 401);
  const headers = {
    Origin: config.publicOrigin,
    'X-SubMeld-Request': '1',
    'Content-Type': 'application/json',
  };
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: 'scanner-test-password' }),
  });
  assert.equal(login.status, 200);
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (
      await app.request(base + '/scans', {
        method: 'POST',
        headers: { Cookie: headers.Cookie },
        body: '{}',
      })
    ).status,
    403,
  );
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') =>
    app.request(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await request('/scans', { targets: ['0.0.0.0/0'], parameters: {} })).status, 400);
  const created = await request('/scans', {
    targets: ['127.0.0.1'],
    parameters: parameters(tls.port),
  });
  assert.equal(created.status, 201);
  const scan = await created.json();
  await finished(scanner, settings.realityScans, scan.id);
  assert.equal(
    (await (await request('/scans/' + scan.id + '/results?state=matched')).json()).total,
    1,
  );
  const csv = await request('/scans/' + scan.id + '/export?format=csv&state=matched');
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.match(csv.headers.get('cache-control'), /no-store/);
  assert.match(await csv.text(), /CERT_DOMAIN/);
  assert.equal((await request('/scans/not-a-uuid')).status, 400);
  assert.equal((await request('/scans/' + randomUUID())).status, 404);
  assert.equal((await request('/scans/' + scan.id, {}, 'DELETE')).status, 200);
  assert.equal(
    scanActive((await request('/status').then((r) => r.json())).active?.state ?? 'completed'),
    false,
  );
});
