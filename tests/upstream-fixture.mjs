import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { SubStoreClient } from '../dist/server/sub-store.js';
import { openSettings } from '../dist/server/database.js';
import { Converter } from '../dist/server/converter/pool.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { createApp } from '../dist/server/app.js';
import { setTimeout as delay } from 'node:timers/promises';
export async function resetUpstream() {
  if (!process.env.SUBMELD_TEST_CONTAINER?.startsWith('submeld-test-'))
    throw new Error('Only an isolated official container may be reset');
  const client = new SubStoreClient();
  for (const token of await client.api('/api/tokens'))
    await client.api(
      '/api/token/' +
        encodeURIComponent(token.token) +
        '?type=' +
        token.type +
        '&name=' +
        encodeURIComponent(token.name),
      undefined,
      'DELETE',
    );
  await client.api('/api/collections', [], 'PUT');
  await client.api('/api/subs', [], 'PUT');
  await client.api('/api/files', [], 'PUT');
  return client;
}
export async function fixture(t, options = {}) {
  const client = await resetUpstream();
  mkdirSync('.cache', { recursive: true });
  const directory = mkdtempSync(resolve('.cache/upstream-test-'));
  const store = openSettings(directory, true, client);
  await store.resources.sync();
  const converter = options.converter ?? new Converter(client);
  const tester = options.makeTester?.(store, converter, directory);
  const auth = new Auth(await hashPassword('test-only-SubMeld-password'));
  const config = {
    publicOrigin: 'http://127.0.0.1:3000',
    dataDir: directory,
    development: true,
    subStoreUrl: client.origin,
    telegramBot: '',
  };
  const app = createApp({ ...store, tester, auth, config, webRoot: resolve('dist/web') });
  t.after(async () => {
    await tester?.close();
    await converter.close?.();
    auth.close();
    store.close();
    assert.ok(
      directory.startsWith(resolve('.cache') + '/') ||
        directory.startsWith(resolve('.cache') + '\\'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  const headers = {
    Origin: config.publicOrigin,
    'Content-Type': 'application/json',
    'X-SubMeld-Request': '1',
  };
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: 'test-only-SubMeld-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') =>
    app.request(path, {
      method,
      headers: { ...headers, Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...store, client, converter, tester, auth, app, request, cookie, directory, config };
}
export async function waitFor(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for observable state');
}
export function ref(node) {
  return {
    resourceId: node.resourceId,
    revision: node.revision,
    snapshotHash: node.snapshotHash,
    nodeIndex: node.nodeIndex,
  };
}
export function subject(node) {
  return { kind: 'node', ...ref(node) };
}
