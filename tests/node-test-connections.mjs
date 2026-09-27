import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { renderInput } from '../dist/server/converter/render.js';
import { freeProbePort, runNodeProbe } from '../dist/server/node-probe.js';
import { node, items } from './fixtures.mjs';
import { dualPort, start } from './chain-connections.mjs';
import { testCertificate, testKey } from './source-tls-fixture.mjs';

export async function checkNodeTestConnections(binaries, results, versions) {
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const directory = join(results, 'node-test-' + target),
      sockets = new Set();
    let hits = 0,
      hangEntered,
      entryCore,
      exitCore;
    const destination = createServer({ cert: testCertificate, key: testKey }, (req, res) => {
      hits++;
      if (req.url === '/hang') {
        hangEntered?.();
        return;
      }
      res.writeHead(204);
      res.end();
    });
    destination.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    destination.on('tlsClientError', () => {});
    destination.listen(0, '127.0.0.1');
    await once(destination, 'listening');
    const options = {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      validateAddress: (address) => address,
      ca: testCertificate,
      timeoutMs: 4000,
    };
    const entry = node('ss'),
      exit = node('ss');
    entry.name = 'entry';
    exit.name = 'exit';
    entry.server = exit.server = '127.0.0.1';
    entry.port = await dualPort();
    exit.port = await dualPort();
    entry.auth.password = 'node-test-entry';
    exit.auth.password = 'node-test-exit';
    const serverConfig = (draft) => ({
      log: { level: 'info' },
      inbounds: [
        {
          type: 'shadowsocks',
          listen: '127.0.0.1',
          listen_port: draft.port,
          method: draft.protocolOptions.method,
          password: draft.auth.password,
        },
      ],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { final: 'direct' },
    });
    const chain = {
      kind: 'chain',
      nodeIndex: 0,
      name: 'complete chain',
      entry,
      exit,
      excluded: false,
      diagnostics: [],
      available: true,
    };
    async function request(
      item,
      { signal = new AbortController().signal, path = '/probe', timeoutMs = 4000 } = {},
    ) {
      const port = await freeProbePort();
      const full = (await renderInput({ target, items: [item], listenPort: port })).full;
      try {
        return await runNodeProbe(
          { target, version: versions[target].version, path: binaries[target] },
          full,
          port,
          'https://source.test:' + destination.address().port + path,
          directory,
          signal,
          { ...options, timeoutMs },
        );
      } finally {
        const listener = createTcpServer();
        listener.listen(port, '127.0.0.1');
        await once(listener, 'listening');
        await new Promise((resolve) => listener.close(resolve));
        assert.deepEqual(
          await readdir(join(directory, 'node-test-tmp')),
          [],
          'temporary credential configuration must be removed',
        );
      }
    }
    try {
      entryCore = await start(
        binaries.singbox,
        'singbox',
        serverConfig(entry),
        join(directory, 'entry'),
      );
      exitCore = await start(
        binaries.singbox,
        'singbox',
        serverConfig(exit),
        join(directory, 'exit'),
      );
      await entryCore.ready(entry.port);
      await exitCore.ready(exit.port);
      const ordinary = items(entry)[0];
      assert.equal((await request(ordinary)).httpStatus, 204);
      assert.equal((await request(chain)).httpStatus, 204);
      const successfulHits = hits;
      const wrong = structuredClone(ordinary);
      wrong.draft.auth.password = 'wrong-password';
      await assert.rejects(request(wrong, { timeoutMs: 700 }));
      assert.equal(hits, successfulHits, 'wrong credentials cannot fall back to direct');
      await entryCore.stop();
      await assert.rejects(request(chain, { timeoutMs: 700 }));
      assert.equal(hits, successfulHits, 'broken entry cannot bypass the first hop');
      entryCore = await start(
        binaries.singbox,
        'singbox',
        serverConfig(entry),
        join(directory, 'entry'),
      );
      await entryCore.ready(entry.port);
      await exitCore.stop();
      await assert.rejects(request(chain, { timeoutMs: 700 }));
      assert.equal(hits, successfulHits, 'broken exit cannot fall back to the entry or direct');
      await assert.rejects(request(ordinary, { path: '/hang', timeoutMs: 120 }), {
        code: 'TEST_TIMEOUT',
      });
      const abort = new AbortController();
      const received = new Promise((resolve) => {
        hangEntered = resolve;
      });
      const running = request(ordinary, { path: '/hang', signal: abort.signal });
      await received;
      abort.abort();
      await assert.rejects(running, { code: 'TEST_CANCELLED' });
      console.log(
        'PASS ' +
          target +
          ' actual HTTPS node tests: single, chain, wrong credentials, both broken hops, timeout and cancellation',
      );
    } finally {
      await entryCore?.stop();
      await exitCore?.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => destination.close(resolve));
    }
  }
}
