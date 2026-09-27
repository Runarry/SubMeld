import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { SubStoreClient } from '../dist/server/sub-store.js';
import { openSettings } from '../dist/server/database.js';
import { Converter } from '../dist/server/converter/pool.js';
import { Publisher } from '../dist/server/publisher.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { createApp } from '../dist/server/app.js';
import { setTimeout as delay } from 'node:timers/promises';
export async function resetUpstream() {
  if (!process.env.SUBMELD_TEST_CONTAINER?.startsWith('submeld-test-'))
    throw new Error('Run with scripts/with-upstream.mjs; a private upstream must never be reset');
  const client = new SubStoreClient();
  await client.api('/api/collections', [], 'PUT');
  await client.api('/api/subs', [], 'PUT');
  return client;
}
export async function fixture(t, { publish = true, converter: custom } = {}) {
  const client = await resetUpstream();
  mkdirSync('.cache', { recursive: true });
  const directory = mkdtempSync(resolve('.cache/upstream-test-'));
  const store = openSettings(directory, true, client);
  await store.resources.sync();
  const converter = custom ?? new Converter(client);
  const publisher = new Publisher(store.subscriptions, store.nodes, store.sources, converter);
  const auth = new Auth(await hashPassword('test-only-SubMeld-password'));
  const config = {
    publicOrigin: 'http://127.0.0.1:3000',
    dataDir: directory,
    development: true,
    subStoreUrl: client.origin,
    telegramBot: '',
  };
  const app = createApp({
    ...store,
    auth,
    config,
    converter,
    publisher,
    webRoot: resolve('dist/web'),
  });
  t.after(async () => {
    await publisher.close();
    await converter.close?.();
    auth.close();
    store.close();
    assert.ok(
      directory.startsWith(resolve('.cache') + '/') ||
        directory.startsWith(resolve('.cache') + '\\'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  if (publish) publisher.start();
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: {
      Origin: config.publicOrigin,
      'Content-Type': 'application/json',
      'X-SubMeld-Request': '1',
    },
    body: JSON.stringify({ password: 'test-only-SubMeld-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') =>
    app.request(path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: config.publicOrigin,
        'Content-Type': 'application/json',
        'X-SubMeld-Request': '1',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...store, client, converter, publisher, auth, app, request, cookie, directory, config };
}
export async function waitFor(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for observable state');
}
