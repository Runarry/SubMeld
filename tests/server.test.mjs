import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../dist/server/app.js';

let server;
let origin;

before(async () => {
  const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
  server = serve({ fetch: createApp(webRoot).fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
});

test('built homepage and its JavaScript/CSS are served by the same application', async () => {
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /<title>SubMeld · 订融<\/title>/);
  assert.match(html, /id="app"/);

  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(
    assets.some((asset) => asset.endsWith('.js')),
    'compiled JavaScript is linked',
  );
  assert.ok(
    assets.some((asset) => asset.endsWith('.css')),
    'compiled CSS is linked',
  );

  for (const asset of assets) {
    const resource = await fetch(`${origin}${asset}`);
    assert.equal(resource.status, 200, asset);
    assert.match(
      resource.headers.get('content-type'),
      asset.endsWith('.css') ? /^text\/css/ : /^(?:text|application)\/javascript/,
    );
    assert.doesNotMatch(await resource.text(), /<!doctype html>/i);
  }
});

test('health endpoint reports liveness without caching; HEAD has no body', async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });

  const head = await fetch(`${origin}/healthz`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('unknown API, subscription, assets and source paths never fall back to HTML', async () => {
  const paths = [
    '/api',
    '/api/v1/missing',
    '/s',
    '/s/test-token/uri',
    '/assets/missing.js',
    '/missing',
    '/package.json',
    '/server/app.ts',
  ];
  for (const path of paths) {
    for (const method of ['GET', 'POST', 'HEAD']) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      if (method === 'HEAD') {
        assert.equal(await response.text(), '');
      } else {
        assert.deepEqual(await response.json(), {
          code: 'NOT_FOUND',
          message: '请求的资源不存在。',
        });
      }
    }
  }
});
