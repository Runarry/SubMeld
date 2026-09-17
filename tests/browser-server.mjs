import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelManager } from '../dist/server/kernels.js';
import { NodeTester } from '../dist/server/node-tests.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../dist/server/app.js';
import { openSettings } from '../dist/server/database.js';
import { hashPassword, Auth } from '../dist/server/auth.js';
import { Converter } from '../dist/server/converter/pool.js';
import { Publisher } from '../dist/server/publisher.js';
import { SourceRefresher } from '../dist/server/source-refresher.js';
import { AppError } from '../dist/server/errors.js';
import { UUID } from './fixtures.mjs';
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
const publisher = new Publisher(
  settings.subscriptions,
  settings.nodes,
  settings.sources,
  converter,
);
publisher.start();
// A deterministic upstream substitute belongs only to this isolated browser harness.
const attempts = new Map();
const refresher = new SourceRefresher(settings.sources, converter, {
  async fetch({ url }) {
    const source = new URL(url);
    if (source.hostname !== 'source.test')
      throw new AppError('SOURCE_DNS_FAILED', '测试来源无法解析。');
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    if (source.pathname === '/failure' || source.searchParams.get('fail') === String(attempt))
      throw new AppError('SOURCE_HTTP_FAILED', '来源返回 HTTP 503，未接受新内容。');
    const name = (source.searchParams.get('name') ?? 'remote') + '-' + attempt;
    return 'vless://' + UUID + '@example.com:443?security=tls&type=tcp#' + encodeURIComponent(name);
  },
});
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
);
const app = createApp({
  tester,
  config: { publicOrigin: 'http://127.0.0.1:3210', dataDir: directory, development: true },
  webRoot: fileURLToPath(new URL('../dist/web/', import.meta.url)),
  auth,
  converter,
  nodes: settings.nodes,
  chains: settings.chains,
  sources: settings.sources,
  subscriptions: settings.subscriptions,
  publisher,
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
  await tester.close();
  await kernels.close();
  await refresher.close();
  await publisher.close();
  await converter.close();
  auth.close();
  settings.close();
  if (!directory.startsWith(resolve('.cache') + (process.platform === 'win32' ? '\\' : '/')))
    throw new Error('Unexpected test directory');
  rmSync(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
