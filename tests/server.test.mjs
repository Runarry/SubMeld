import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSettings } from '../dist/server/database.js';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, test, mock } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../dist/server/app.js';
import { Auth, hashPassword, SESSION_MS } from '../dist/server/auth.js';
import { Converter } from '../dist/server/converter/pool.js';
import { Publisher } from '../dist/server/publisher.js';
import { node, items, UUID, TEST_PASSWORD } from './fixtures.mjs';
let server, origin, auth, converter, cookie, hash, settings, directory;
const logs = [];
const password = 'test-only-admin-password';
const config = { publicOrigin: 'http://127.0.0.1', dataDir: 'unused', development: true };
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'submeld-http-'));
  settings = openSettings(directory, true);
  hash = await hashPassword(password);
  auth = new Auth(hash);
  converter = new Converter();
  await converter.ready;
  mock.method(console, 'warn', (value) => logs.push(value));
  const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
  server = serve({
    fetch: createApp({
      koipy: settings.koipy,
      webRoot,
      resources: settings.resources,
      config,
      auth,
      converter,
      nodes: settings.nodes,
      chains: settings.chains,
      sources: settings.sources,
      subscriptions: settings.subscriptions,
      publisher: new Publisher(settings.subscriptions, settings.nodes, settings.sources, converter),
    }).fetch,
    hostname: '127.0.0.1',
    port: 0,
  });
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  config.publicOrigin = origin;
});
after(async () => {
  if (server) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await converter?.close();
  auth?.close();
  settings?.close();
  assert.ok(
    resolve(directory).startsWith(resolve(tmpdir())) && directory.includes('submeld-http-'),
  );
  rmSync(directory, { recursive: true, force: true });
  mock.restoreAll();
});
function post(path, body, headers = {}) {
  return fetch(origin + path, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json; charset=utf-8',
      'X-SubMeld-Request': '1',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
test('built homepage and its JavaScript/CSS are served with same-origin CSP', async () => {
  const response = await fetch(origin + '/submeld/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-|https:/);
  const html = await response.text();
  assert.match(html, /<title>SubMeld · 订融<\/title>/);
  const assets = [...html.matchAll(/(?:src|href)="(\/submeld\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.some((a) => a.endsWith('.js')));
  assert.ok(assets.some((a) => a.endsWith('.css')));
  for (const asset of assets) {
    const r = await fetch(origin + asset);
    assert.equal(r.status, 200);
    assert.doesNotMatch(await r.text(), /<!doctype html>/i);
  }
});
test('health GET/HEAD is public; unknown API and subscription paths remain JSON 404', async () => {
  const r = await fetch(origin + '/healthz');
  assert.deepEqual(await r.json(), { status: 'ok' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const h = await fetch(origin + '/healthz', { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(await h.text(), '');
  for (const path of [
    '/api',
    '/api/v1/missing',
    '/s',
    '/s/test-token/uri',
    '/submeld/assets/missing.js',
    '/server/app.ts',
    '/data/submeld.sqlite',
  ]) {
    for (const method of ['GET', 'POST', 'HEAD']) {
      const r = await fetch(origin + path, { method });
      assert.equal(r.status, 404, path);
      assert.match(r.headers.get('content-type'), /json/);
      if (method === 'HEAD') assert.equal(await r.text(), '');
      else assert.equal((await r.json()).code, 'NOT_FOUND');
    }
  }
});
test('all conversion calls require login and no-store responses', async () => {
  for (const path of ['/api/convert/parse', '/api/convert/produce']) {
    const r = await post(path, {});
    assert.equal(r.status, 401);
    assert.match(r.headers.get('cache-control'), /no-store/);
  }
  assert.equal((await fetch(origin + '/api/auth/me')).status, 401);
});
test('login and every management write reject missing or cross-origin headers', async () => {
  for (const path of [
    '/api/auth/login',
    '/api/auth/logout',
    '/api/convert/parse',
    '/api/convert/produce',
  ]) {
    for (const headers of [
      { Origin: 'null' },
      { Origin: 'https://attacker.example' },
      { Origin: origin + '.attacker.example' },
      { 'Content-Type': 'text/plain' },
      { 'X-SubMeld-Request': '0' },
    ]) {
      assert.equal((await post(path, { password }, headers)).status, 403);
    }
    const r = await fetch(origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SubMeld-Request': '1' },
      body: '{}',
    });
    assert.equal(r.status, 403);
  }
});
test('login creates an HttpOnly Strict cookie and production adds Secure and __Host', async () => {
  assert.equal((await post('/api/auth/login', { password: 'wrong' })).status, 401);
  const r = await post('/api/auth/login', { password });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Max-Age=86400/);
  assert.doesNotMatch(set, /Domain=/);
  cookie = set.split(';')[0];
  assert.deepEqual(await r.json(), { authenticated: true });
  const me = await fetch(origin + '/api/auth/me', { headers: { Cookie: cookie } });
  assert.deepEqual(await me.json(), { authenticated: true });
  const production = createApp({
    resources: settings.resources,
    config: { ...config, development: false, publicOrigin: 'https://submeld.example' },
    auth: new Auth(hash),
    converter,
    nodes: settings.nodes,
    chains: settings.chains,
    sources: settings.sources,
    subscriptions: settings.subscriptions,
    publisher: new Publisher(settings.subscriptions, settings.nodes, settings.sources, converter),
  });
  const pr = await production.request('https://submeld.example/api/auth/login', {
    method: 'POST',
    headers: {
      Origin: 'https://submeld.example',
      'Content-Type': 'application/json',
      'X-SubMeld-Request': '1',
    },
    body: JSON.stringify({ password }),
  });
  assert.match(pr.headers.get('set-cookie'), /^__Host-submeld-session=/);
  assert.match(pr.headers.get('set-cookie'), /; Secure/);
});
test('HTTP parse/edit/produce works and unknown fields cannot bypass validation', async () => {
  const r = await post('/api/convert/parse', {
    format: 'uri',
    text: 'vless://' + UUID + '@example.com:443?security=tls#Original',
  });
  assert.equal(r.status, 200);
  const parsed = await r.json();
  parsed.items[0].draft.name = 'Edited';
  parsed.items[0].draft.tls.serverName = 'edited.example.com';
  const generated = await post('/api/convert/produce', { items: parsed.items });
  assert.equal(generated.status, 200);
  const output = await generated.json();
  assert.equal(new URL(output.uri).searchParams.get('sni'), 'edited.example.com');
  assert.match(output.uri, /#Edited$/);
  assert.equal(Buffer.from(output.base64, 'base64').toString(), output.uri);
  parsed.items[0].draft.extra = 'unsupported';
  assert.equal((await post('/api/convert/produce', { items: parsed.items })).status, 400);
  const broken = items(node('trojan'));
  broken[0].draft.auth.password = '';
  const failure = await post('/api/convert/produce', { items: broken });
  assert.equal(failure.status, 422);
  assert.doesNotMatch(
    await failure.text(),
    new RegExp(TEST_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});
test('streamed limits, malformed JSON and compressed requests fail safely', async () => {
  assert.equal(
    (await post('/api/convert/parse', { format: 'uri', text: 'x'.repeat(4 * 1024 * 1024 + 1) }))
      .status,
    413,
  );
  const malformed = await fetch(origin + '/api/convert/parse', {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-SubMeld-Request': '1',
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await post('/api/convert/parse', {}, { 'Content-Encoding': 'gzip' })).status, 415);
});
test('logout revokes the current cookie; fixed expiry and restart invalidate sessions', async () => {
  assert.equal((await post('/api/auth/logout', {})).status, 200);
  assert.equal((await fetch(origin + '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  let clock = 1000;
  const sessionAuth = new Auth(hash, () => clock);
  const token = await sessionAuth.login(password);
  assert.equal(sessionAuth.valid(token), true);
  clock += SESSION_MS - 1;
  assert.equal(sessionAuth.valid(token), true);
  clock++;
  assert.equal(sessionAuth.valid(token), false);
  const next = await sessionAuth.login(password);
  assert.equal(new Auth(hash).valid(next), false);
  sessionAuth.close();
  assert.equal(sessionAuth.valid(next), false);
});
test('login verification is bounded and logs never contain test secrets or raw input', async () => {
  const limited = new Auth(hash);
  const first = limited.login(password);
  await assert.rejects(limited.login(password), { status: 429 });
  await first;
  for (let i = 0; i < 9; i++) await assert.rejects(limited.login('wrong'), { status: 401 });
  await assert.rejects(limited.login(password), { status: 429 });
  const log = logs.join('\n');
  assert.ok(!log.includes(password));
  assert.ok(!log.includes(TEST_PASSWORD));
  assert.ok(!log.includes('vless://'));
  assert.ok(!log.includes(cookie));
  assert.ok(!log.includes('Authorization'));
  for (const entry of logs)
    assert.deepEqual(Object.keys(JSON.parse(entry)).sort(), ['code', 'route', 'status']);
});

test('published source archive is downloadable and excludes data, caches and secrets', async () => {
  const response = await fetch(origin + '/source.tar.gz');
  assert.equal(response.status, 200);
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength > 1000);
  const { execFileSync } = await import('node:child_process');
  const entries = execFileSync('tar', ['-tzf', 'dist/submeld-source.tar.gz'], {
    encoding: 'utf8',
  }).split(/\r?\n/);
  assert.ok(entries.includes('server/app.ts'));
  assert.ok(entries.includes('.env.example'));
  assert.ok(
    entries.every((p) => !/(^|\/)(data|node_modules|\.cache|\.git|\.pnpm-store)(\/|$)/.test(p)),
  );
  assert.ok(!entries.includes('.env'));
});
test('actual chunked request bytes are bounded without relying on Content-Length', async () => {
  const { Readable } = await import('node:stream');
  const login = await post('/api/auth/login', { password });
  const currentCookie = login.headers.get('set-cookie').split(';')[0];
  const chunks = Array(27).fill(Buffer.alloc(1024 * 1024, 32));
  const response = await fetch(origin + '/api/convert/parse', {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-SubMeld-Request': '1',
      Cookie: currentCookie,
    },
    body: Readable.from(chunks),
    duplex: 'half',
  });
  assert.equal(response.status, 413);
});
