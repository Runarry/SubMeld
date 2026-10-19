import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runNodeProbe } from '../dist/server/node-probe.js';
import { node, items } from './fixtures.mjs';
import { dualPort, start } from './kernel-fixture.mjs';
import { testCertificate, testKey } from './source-tls-fixture.mjs';

export async function checkNodeTestConnections(
  binaries,
  results,
  versions,
  render,
  targets = ['mihomo', 'singbox', 'xray'],
) {
  for (const target of targets) {
    const directory = join(results, 'node-test-' + target),
      sockets = new Set();
    let hits = 0,
      hangEntered,
      proxyCore;
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
    const proxy = node('ss');
    proxy.name = 'controlled node';
    proxy.server = '127.0.0.1';
    proxy.port = await dualPort();
    proxy.auth.password = 'node-test-proxy';
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
    async function request(
      item,
      { signal = new AbortController().signal, path = '/probe', timeoutMs = 4000 } = {},
    ) {
      const port = await dualPort();
      const full = (await render({ target, items: [item], listenPort: port })).full;
      let kernelOutput = '';
      try {
        return await runNodeProbe(
          { target, version: versions[target].version, path: binaries[target] },
          full,
          port,
          'https://source.test:' + destination.address().port + path,
          directory,
          signal,
          {
            ...options,
            timeoutMs,
            onKernelOutput: (output) => {
              kernelOutput = output;
            },
          },
        );
      } catch (error) {
        // This fixture contains public test credentials only; production probes never log output.
        error.fixtureRequestPath = path;
        error.fixtureKernelOutput = kernelOutput;
        error.fixtureProxyOutput = proxyCore?.log ?? '';
        error.fixtureConfiguration = full;
        throw error;
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
      proxyCore = await start(
        binaries.singbox,
        'singbox',
        serverConfig(proxy),
        join(directory, 'proxy'),
      );
      await proxyCore.ready(proxy.port);
      const ordinary = items(proxy)[0];
      assert.equal((await request(ordinary)).httpStatus, 204);
      const successfulHits = hits;
      const wrong = structuredClone(ordinary);
      wrong.draft.auth.password = 'wrong-password';
      await assert.rejects(request(wrong, { timeoutMs: 700 }));
      assert.equal(hits, successfulHits, 'wrong credentials cannot fall back to direct');
      await assert.rejects(request(ordinary, { path: '/hang', timeoutMs: 120 }), {
        code: 'TEST_TIMEOUT',
      });
      const abort = new AbortController();
      const received = new Promise((resolve) => {
        hangEntered = resolve;
      });
      const running = request(ordinary, { path: '/hang', signal: abort.signal });
      await Promise.race([received, running]);
      abort.abort();
      await assert.rejects(running, { code: 'TEST_CANCELLED' });
      const beforeStop = hits;
      await proxyCore.stop();
      await assert.rejects(request(ordinary, { timeoutMs: 700 }));
      assert.equal(hits, beforeStop, 'stopped proxy cannot fall back to direct');
      console.log(
        'PASS ' +
          target +
          ' actual HTTPS node tests: success, wrong credentials, stopped proxy, timeout, cancellation and cleanup',
      );
    } finally {
      await proxyCore?.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => destination.close(resolve));
    }
  }
}
