import { resetUpstream } from './upstream-fixture.mjs';
await resetUpstream();
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelManager } from '../dist/server/kernels.js';
import { NodeTester } from '../dist/server/node-tests.js';
import { MiaospeedTester } from '../dist/server/miaospeed.js';
import { TelegramService } from '../dist/server/telegram.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../dist/server/app.js';
import { loadConfig } from '../dist/server/config.js';
import { openSettings } from '../dist/server/database.js';
import { hashPassword, Auth } from '../dist/server/auth.js';
import { Converter } from '../dist/server/converter/pool.js';
import { RelayStore } from '../dist/server/relays.js';

mkdirSync('.cache', { recursive: true });
const directory = mkdtempSync(resolve('.cache/browser-'));
const settings = openSettings(directory, true);
const hash = await hashPassword('SubMeld-UI-Test-Only-2026');
settings.setPasswordHash(hash);
// Each browser login advances an injected test clock; production rate limiting is unchanged.
let clock = Date.now();
const auth = new Auth(settings.getPasswordHash(), () => clock);
const converter = new Converter();

// Browser coverage controls request timing and GitHub metadata; real traffic is covered by test:cores.
const coreLocks = JSON.parse(readFileSync('tests/kernels.lock.json', 'utf8'));
const kernels = new KernelManager(directory, {
  async transfer(url) {
    const lock = Object.values(coreLocks).find(
      (lock) => url === 'https://api.github.com/repos/' + lock.repo + '/releases/latest',
    );
    if (!lock) throw new Error('Unexpected browser fixture download');
    const asset = lock.platforms[process.platform + '-' + process.arch];
    return Buffer.from(
      JSON.stringify({
        tag_name: lock.tag,
        draft: false,
        prerelease: false,
        assets: [{ name: asset.asset, digest: 'sha256:' + asset.sha256 }],
      }),
    );
  },
});
await kernels.initialize();
const tester = new NodeTester(
  settings.nodeTests,
  kernels,
  converter,
  directory,
  async (_binary, _config, _port, _url, _directory, signal) => {
    await delay(700, undefined, { signal });
    return { latencyMs: 24.5, httpStatus: 204 };
  },
  settings.testActivity,
);
const miaospeed = new MiaospeedTester(
  settings.miaospeedStore,
  settings.miaospeedScripts,
  settings.miaospeedInput,
  kernels,
  converter,
  settings.testActivity,
  {
    dataDir: directory,
    miaospeedUrl: process.env.MIAOSPEED_URL,
    miaospeedToken: process.env.MIAOSPEED_TOKEN,
    miaospeedBridgeHost: 'host.docker.internal',
  },
);
// Browser tests exercise real settings APIs while Telegram stays completely local.
const telegram = new TelegramService(settings.telegramStore, miaospeed, {
  client: () => ({
    async call(method, _body, signal) {
      if (method === 'getMe') return { id: 90001, is_bot: true, username: 'submeld_test_bot' };
      if (method === 'getWebhookInfo') return { url: '' };
      if (method === 'getUpdates') {
        await delay(30000, undefined, { signal });
        return [];
      }
      throw new Error('Browser fixture must not send Telegram messages');
    },
    async close() {},
  }),
});
telegram.start();
const relays = new RelayStore(settings.machines, settings.resources);
relays.start();
const app = createApp({
  machines: settings.machines,
  relays,
  miaospeed,
  telegram,
  resources: settings.resources,
  tester,
  config: {
    publicOrigin: 'http://127.0.0.1:3210',
    dataDir: directory,
    development: true,
    subStoreUrl: process.env.SUB_STORE_URL,
    miaospeedUrl: process.env.MIAOSPEED_URL,
    miaospeedToken: process.env.MIAOSPEED_TOKEN,
    miaospeedBridgeHost: 'host.docker.internal',
  },
  webRoot: fileURLToPath(new URL('../dist/web/', import.meta.url)),
  auth,

  nodes: settings.nodes,
  nodeReporting: settings.nodeReporting,

  subscriptions: settings.subscriptions,
});
const server = serve({
  fetch: async (request) => {
    if (
      new URL(request.url).pathname === '/sw.js' &&
      request.headers.get('cookie')?.includes('submeld-test-legacy-worker=1')
    ) {
      // Install the real pinned worker to reproduce browsers that predate the fix.
      const upstream = await fetch(new URL('/sw.js', process.env.SUB_STORE_URL));
      return new Response(await upstream.text(), {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' },
      });
    }
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/auth/login')
      clock += 300001;
    return app.fetch(request);
  },
  hostname: '127.0.0.1',
  port: 3210,
});
const httpConfig = loadConfig(false, {
  ...process.env,
  PUBLIC_ORIGIN: 'http://submeld-http.test:3211',
  PORT: '3211',
  ALLOW_HTTP: 'true',
  DATA_DIR: directory,
});
const httpApp = createApp({
  machines: settings.machines,
  relays,
  nodeReporting: settings.nodeReporting,
  miaospeed,
  telegram,
  resources: settings.resources,
  tester,
  config: httpConfig,
  webRoot: fileURLToPath(new URL('../dist/web/', import.meta.url)),
  auth,
  nodes: settings.nodes,
  subscriptions: settings.subscriptions,
});
const httpServer = serve({
  fetch: (request) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/auth/login')
      clock += 300001;
    return httpApp.fetch(request);
  },
  hostname: '127.0.0.1',
  port: httpConfig.port,
});
let closed = false;
async function close() {
  if (closed) return;
  closed = true;
  for (const listener of [server, httpServer]) {
    listener.close();
    listener.closeAllConnections();
  }
  await telegram.close();
  await relays.close();
  await tester.close();
  await miaospeed.close();
  await kernels.close();

  await converter.close();
  auth.close();
  settings.close();
  if (!directory.startsWith(resolve('.cache') + (process.platform === 'win32' ? '\\' : '/')))
    throw new Error('Unexpected test directory');
  rmSync(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
