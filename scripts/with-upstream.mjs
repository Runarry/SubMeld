import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const mode = process.argv[2];
if (!['test', 'cores', 'browser', 'all'].includes(mode))
  throw new Error('Expected test, cores, browser or all');
const lock = JSON.parse(readFileSync('upstreams.lock.json', 'utf8'));
const name = 'submeld-test-' + randomUUID();
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 120000 }).trim();
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const reservedPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let started = false;
try {
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    'submeld.purpose=isolated-test',
    '-p',
    '127.0.0.1:' + reservedPort + ':3000',
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '-e',
    'SUB_STORE_BACKEND_API_HOST=0.0.0.0',
    '-e',
    'SUB_STORE_BACKEND_API_PORT=3000',
    '-e',
    'SUB_STORE_BACKEND_MERGE=true',
    '-e',
    'SUB_STORE_FRONTEND_BACKEND_PATH=/gateway',
    lock.subStore.image,
  ]);
  started = true;
  const port = docker(['port', name, '3000/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) throw new Error('Missing isolated upstream port');
  const url = 'http://127.0.0.1:' + port + '/gateway';
  let ready = false;
  for (let n = 0; n < 120; n++) {
    try {
      const response = await fetch(url + '/api/utils/env', { signal: AbortSignal.timeout(1000) });
      const value = await response.json();
      if (value.data?.version !== lock.subStore.backendVersion)
        throw new Error('Pinned backend version mismatch');
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  if (!ready) throw new Error('Pinned Sub-Store did not become ready; checks were not skipped');
  console.info('Testing against isolated Sub-Store ' + lock.subStore.backendVersion);
  const env = { ...process.env, SUB_STORE_URL: url, SUBMELD_TEST_CONTAINER: name };
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Check failed: ' + args.join(' '))),
      );
    });
  if (mode === 'test' || mode === 'all')
    await run([
      '--test',
      '--test-concurrency=1',
      ...(mode === 'test' && process.argv.length > 3
        ? process.argv.slice(3)
        : ['tests/*.test.mjs']),
    ]);
  if (mode === 'cores' || mode === 'all') await run(['scripts/check-cores.mjs']);
  if (mode === 'browser')
    await run(['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(3)]);
} finally {
  if (started) docker(['stop', name]);
}
