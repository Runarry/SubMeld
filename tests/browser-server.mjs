import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../dist/server/app.js';
import { openSettings } from '../dist/server/database.js';
import { hashPassword, Auth } from '../dist/server/auth.js';
import { Converter } from '../dist/server/converter/pool.js';
mkdirSync('.cache', { recursive: true });
const directory = mkdtempSync(resolve('.cache/browser-'));
const settings = openSettings(directory, true);
const hash = await hashPassword('SubMeld-UI-Test-Only-2026');
settings.setPasswordHash(hash);
// Each browser login advances an injected test clock; production rate limiting is unchanged.
let clock = Date.now();
const auth = new Auth(settings.getPasswordHash(), () => clock);
const converter = new Converter();
await converter.ready;
const app = createApp({
  config: { publicOrigin: 'http://127.0.0.1:3210', dataDir: directory, development: true },
  webRoot: fileURLToPath(new URL('../dist/web/', import.meta.url)),
  auth,
  converter,
  nodes: settings.nodes,
});
const server = serve({
  fetch: (request) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/auth/login')
      clock += 300001;
    return app.fetch(request);
  },
  hostname: '127.0.0.1',
  port: 3210,
});
let closed = false;
async function close() {
  if (closed) return;
  closed = true;
  server.close();
  server.closeAllConnections();
  await converter.close();
  auth.close();
  settings.close();
  if (!directory.startsWith(resolve('.cache') + (process.platform === 'win32' ? '\\' : '/')))
    throw new Error('Unexpected test directory');
  rmSync(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
