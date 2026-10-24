import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { WebsiteRoutingStore } from '../dist/server/website-routing.js';
import {
  parseWebsiteRoutingResponse,
  websiteRoutingIp,
  websiteRoutingOrigin,
  websiteRoutingPresets,
} from '../dist/server/shared/website-routing.js';
import { openSettings } from '../dist/server/database.js';
import { createApp } from '../dist/server/app.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { SubStoreClient } from '../dist/server/sub-store.js';

function store(t) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  t.after(() => db.close());
  return { db, sites: new WebsiteRoutingStore(db) };
}

test('website list seeds once and preserves an explicitly empty shared list', (t) => {
  const { db, sites } = store(t);
  const initial = sites.list();
  assert.equal(initial.length, 11);
  assert.equal(new Set(initial.map((site) => site.id)).size, 11);
  const otherSession = new WebsiteRoutingStore(db);
  assert.deepEqual(otherSession.list(), initial);
  for (const site of initial) otherSession.remove(site.id);
  assert.deepEqual(sites.list(), []);
  assert.deepEqual(new WebsiteRoutingStore(db).list(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 1);
  sites.add({ presetId: 'netease' });
  assert.equal(otherSession.list().length, 1);
  assert.equal(otherSession.list()[0].probe, 'netease');
});

test('website additions normalize origins and merge with changes from other sessions', (t) => {
  const { db, sites } = store(t);
  const other = new WebsiteRoutingStore(db);
  const initial = sites.list();
  const custom = sites.add({ domain: 'http://EXAMPLE.test./path?private=query#fragment' });
  assert.equal(custom.url, 'https://example.test/cdn-cgi/trace');
  assert.equal(custom.name, 'example.test');
  assert.equal(custom.probe, 'cf-trace');
  other.add({ domain: 'second.test', name: '另一个网站' });
  sites.remove(initial[0].id);
  assert.ok(other.list().some((site) => site.id === custom.id));
  assert.ok(sites.list().some((site) => site.name === '另一个网站'));
  assert.equal(sites.list().length, 12);
  assert.throws(() => other.add({ domain: 'https://example.test:443/other' }), {
    code: 'WEBSITE_ALREADY_EXISTS',
  });
  assert.throws(() => other.add({ presetId: 'chatgpt' }), { code: 'WEBSITE_ALREADY_EXISTS' });
  assert.throws(() => other.add({ presetId: 'missing' }), { code: 'WEBSITE_PRESET_NOT_FOUND' });
  sites.remove(initial[0].id);
  assert.equal(sites.list().length, 12);
});

test('website domains reject credentials and non-web schemes; known origins retain their adapter', (t) => {
  const { sites } = store(t);
  for (const domain of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com',
    'https://user:secret@example.com',
    'bad domain',
    'https://exam\nple.com',
    'https://example.com\\other',
  ])
    assert.throws(() => sites.add({ domain }), { code: 'WEBSITE_DOMAIN_INVALID' });
  assert.equal(websiteRoutingOrigin('https://EXAMPLE.com:8443/path'), 'https://example.com:8443');
  const netease = sites.list().find((site) => site.probe === 'netease');
  sites.remove(netease.id);
  const added = sites.add({ domain: new URL(netease.url).origin });
  assert.equal(added.url, netease.url);
  assert.equal(added.probe, 'netease');
  assert.equal(websiteRoutingPresets.length, 11);
});

test('exit parsing normalizes IPv4/IPv6 and rejects private, fake, malformed or reserved addresses', () => {
  assert.deepEqual(websiteRoutingIp(' 8.8.8.8 '), { ip: '8.8.8.8', family: 4 });
  assert.deepEqual(websiteRoutingIp('2606:4700:4700:0000:0000:0000:0000:1111'), {
    ip: '2606:4700:4700::1111',
    family: 6,
  });
  assert.deepEqual(websiteRoutingIp('::ffff:8.8.8.8'), { ip: '8.8.8.8', family: 4 });
  for (const ip of [
    '192.168.1.1',
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '198.19.255.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:192.168.1.1',
    '2001:db8::1',
    'not-ip',
    '999.2.3.4',
    '8.8.8.8:443',
    '8.8.8.8,1.1.1.1',
    '8.8.8.8/32',
  ])
    assert.equal(websiteRoutingIp(ip), null, ip);
  assert.deepEqual(
    parseWebsiteRoutingResponse('cf-trace', 'h=example.com\nip=8.8.8.8\nloc=us\ncolo=SJC\n'),
    { ip: '8.8.8.8', family: 4, countryCode: 'US' },
  );
  assert.deepEqual(parseWebsiteRoutingResponse('cf-trace', 'ip=1.1.1.1\r\nloc=XX'), {
    ip: '1.1.1.1',
    family: 4,
  });
  assert.equal(parseWebsiteRoutingResponse('cf-trace', '<html>1.1.1.1</html>'), null);
  assert.equal(parseWebsiteRoutingResponse('cf-trace', 'ip=198.18.0.1\nloc=CN'), null);
  assert.deepEqual(parseWebsiteRoutingResponse('netease', '', { 'cdn-user-ip': '8.8.4.4' }), {
    ip: '8.8.4.4',
    family: 4,
  });
  assert.deepEqual(
    parseWebsiteRoutingResponse('bytedance', '', { 'x-response-cinfo': '9.9.9.9' }),
    { ip: '9.9.9.9', family: 4 },
  );
  assert.equal(parseWebsiteRoutingResponse('netease', ''), null);
});

test('website settings persist across restart and APIs require login and same-origin writes without probing', async (t) => {
  mkdirSync('.cache', { recursive: true });
  const directory = mkdtempSync(resolve('.cache/website-routing-'));
  let settings = openSettings(directory, true, new SubStoreClient('http://127.0.0.1:1'));
  const password = 'Website-routing-test-only';
  const auth = new Auth(await hashPassword(password));
  t.after(() => {
    auth.close();
    settings.close();
    assert.ok(
      directory.startsWith(resolve('.cache') + '/') ||
        directory.startsWith(resolve('.cache') + '\\'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Website settings must not send probes');
  });
  const app = createApp({
    ...settings,
    auth,
    config: { publicOrigin: 'http://127.0.0.1:3000', development: true },
  });
  const headers = {
    Origin: 'http://127.0.0.1:3000',
    'Content-Type': 'application/json',
    'X-SubMeld-Request': '1',
  };
  const path = '/api/website-routing/sites';
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await app.request(
      path + (method === 'DELETE' ? '/00000000-0000-4000-8000-000000000000' : ''),
      {
        method,
        headers,
        ...(method === 'GET' ? {} : { body: '{}' }),
      },
    );
    assert.equal(response.status, 401);
  }
  headers.Cookie = 'submeld-session=' + (await auth.login(password));
  for (const method of ['POST', 'DELETE']) {
    for (const changes of [
      { Origin: 'https://other.example' },
      { Origin: '' },
      { 'X-SubMeld-Request': '' },
      { 'Content-Type': 'text/plain' },
    ]) {
      const response = await app.request(
        path + (method === 'DELETE' ? '/00000000-0000-4000-8000-000000000000' : ''),
        {
          method,
          headers: { ...headers, ...changes },
          body: '{}',
        },
      );
      assert.equal(response.status, 403);
    }
  }
  const list = await app.request(path, { headers });
  assert.match(list.headers.get('cache-control'), /no-store/);
  assert.equal((await list.json()).sites.length, 11);
  const create = await app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ domain: 'api.example.test' }),
  });
  assert.equal(create.status, 201);
  const { site } = await create.json();
  const secondHeaders = { ...headers, Cookie: 'submeld-session=' + (await auth.login(password)) };
  assert.ok(
    (await (await app.request(path, { headers: secondHeaders })).json()).sites.some(
      (item) => item.id === site.id,
    ),
  );
  assert.equal(
    (
      await app.request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain: 'https://api.example.test/path' }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await app.request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain: 'https://user:secret@example.com' }),
      })
    ).status,
    400,
  );
  const saved = settings.websiteRouting.list();
  settings.close();
  settings = openSettings(directory, true, new SubStoreClient('http://127.0.0.1:1'));
  assert.deepEqual(settings.websiteRouting.list(), saved);
  assert.equal(fetch.mock.callCount(), 0);
});
