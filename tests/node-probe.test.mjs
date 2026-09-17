import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { probeHttps, probeUrl, testConfig } from '../dist/server/node-probe.js';
import { renderInput } from '../dist/server/converter/render.js';
import { testCertificate, testKey } from './source-tls-fixture.mjs';
import { node, items } from './fixtures.mjs';

async function fixture(
  t,
  handler = (_req, res) => {
    res.writeHead(204);
    res.end();
  },
) {
  const sockets = new Set(),
    requests = [],
    tunnels = [];
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const destination = createHttpsServer({ cert: testCertificate, key: testKey }, (req, res) => {
    requests.push({ host: req.headers.host, path: req.url, sni: req.socket.servername });
    handler(req, res);
  });
  destination.on('connection', track);
  destination.on('tlsClientError', () => {});
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const proxy = createHttpServer();
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url);
    // This fixture always forwards to its own loopback TLS server, never to the requested IP.
    const upstream = track(
      createConnection({ host: '127.0.0.1', port: destination.address().port }),
    );
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => destination.close(resolve)),
    ]);
  });
  return {
    requests,
    tunnels,
    sockets,
    port: proxy.address().port,
    options: {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      ca: testCertificate,
      timeoutMs: 2000,
    },
  };
}
test('HTTPS uses a CONNECT tunnel with pinned IP, original Host/SNI and verified TLS', async (t) => {
  const f = await fixture(t);
  const result = await probeHttps(
    f.port,
    'https://source.test/probe',
    new AbortController().signal,
    f.options,
  );
  assert.equal(result.httpStatus, 204);
  assert.ok(result.latencyMs >= 0);
  assert.deepEqual(f.tunnels, ['8.8.8.8:443']);
  assert.deepEqual(f.requests, [{ host: 'source.test', path: '/probe', sni: 'source.test' }]);
  await probeHttps(f.port, 'https://8.8.8.8/probe', new AbortController().signal, f.options);
  assert.equal(f.requests.at(-1).host, '8.8.8.8');
  assert.equal(f.requests.at(-1).sni, false);
});
test('HTTPS rejects certificates and every private DNS answer before connecting; redirects are not followed', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(302, { Location: 'https://127.0.0.1/secret' });
    res.end();
  });
  const signal = new AbortController().signal;
  await assert.rejects(probeHttps(f.port, 'https://wrong.test', signal, f.options), {
    code: 'TEST_TLS_FAILED',
  });
  await assert.rejects(
    probeHttps(f.port, 'https://source.test', signal, { ...f.options, ca: [] }),
    { code: 'TEST_TLS_FAILED' },
  );
  const count = f.tunnels.length;
  await assert.rejects(
    probeHttps(f.port, 'https://source.test', signal, {
      ...f.options,
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '::ffff:127.0.0.1', family: 6 },
      ],
    }),
    { code: 'TEST_ADDRESS_REJECTED' },
  );
  assert.equal(f.tunnels.length, count);
  assert.equal(
    (await probeHttps(f.port, 'https://source.test/redirect', signal, f.options)).httpStatus,
    302,
  );
  assert.equal(f.requests.length, 1);
  for (const value of [
    'http://example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://user:pass@example.com',
    'https://example.com/#fragment',
  ])
    assert.throws(() => probeUrl(value), { code: 'TEST_URL_INVALID' });
});
test('request deadlines and explicit cancellation destroy the HTTPS tunnel', async (t) => {
  let entered;
  const f = await fixture(t, () => entered?.());
  await assert.rejects(
    probeHttps(f.port, 'https://source.test', new AbortController().signal, {
      ...f.options,
      timeoutMs: 80,
    }),
    { code: 'TEST_TIMEOUT' },
  );
  const abort = new AbortController();
  const requestReceived = new Promise((resolve) => {
    entered = resolve;
  });
  const request = probeHttps(f.port, 'https://source.test', abort.signal, f.options);
  await requestReceived;
  abort.abort();
  await assert.rejects(request, { code: 'TEST_CANCELLED' });
});
test('Xray test-only HTTP inbound preserves the exported SOCKS template and all outbound data', () => {
  const draft = node('ss');
  const rendered = renderInput({ target: 'xray', listenPort: 19090, items: items(draft) });
  const original = JSON.parse(rendered.full),
    test = JSON.parse(testConfig('xray', rendered.full));
  assert.equal(original.inbounds[0].protocol, 'socks');
  assert.equal(test.inbounds[0].protocol, 'http');
  assert.equal(test.inbounds[0].port, 19090);
  assert.deepEqual(test.outbounds, original.outbounds);
  assert.deepEqual(test.routing, original.routing);
});
