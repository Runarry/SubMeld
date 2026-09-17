import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:https';
import { connect } from 'node:tls';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { SourceFetcher, sourceUrl, publicAddress } from '../dist/server/source-fetcher.js';
import { MAX_BYTES } from '../dist/server/shared/contracts.js';
import { testCertificate, testKey } from './source-tls-fixture.mjs';

async function fixture(t, handler) {
  const sockets = new Set(),
    requests = [],
    connections = [];
  const server = createServer({ key: testKey, cert: testCertificate }, (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  function fetcher(options = {}) {
    return new SourceFetcher({
      timeoutMs: 2000,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      connect: (params) => {
        connections.push(params);
        const socket = connect({
          ...params,
          host: '127.0.0.1',
          port: server.address().port,
          ca: testCertificate,
          ...(options.trusted === false ? { ca: [] } : {}),
        });
        if (options.peer !== null)
          Object.defineProperty(socket, 'remoteAddress', {
            get: () => options.peer ?? params.host,
          });
        return socket;
      },
      ...options,
    });
  }
  return { server, sockets, requests, connections, fetcher };
}
const input = (url = 'https://source.test/sub?secret=test-only') => ({
  url,
  headers: {
    userAgent: 'P4-test',
    accept: 'text/plain',
    authorization: 'Bearer test-only-not-a-real-token',
  },
});
test('P4 destination parsing rejects non-public IPs, wrappers and malformed URLs before connecting', () => {
  for (const value of [
    '127.0.0.1',
    '0.0.0.0',
    '0.1.2.3',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
  ])
    assert.throws(() => publicAddress(value), { code: 'SOURCE_ADDRESS_REJECTED' }, value);
  for (const url of [
    'http://source.test',
    'file:///etc/passwd',
    'https://user:password@source.test',
    'https://source.test/#fragment',
    'https://source.test\n/path',
    'https://source.test\\@127.0.0.1',
    'https://127.1/',
    'https://0x7f000001/',
    'https://[::ffff:127.0.0.1]/',
    'https://bad_host/',
  ])
    assert.throws(() => sourceUrl(url), url);
  assert.equal(publicAddress('::ffff:8.8.8.8'), '8.8.8.8');
  assert.equal(sourceUrl('https://source.test:8443/a?q=1').port, '8443');
  assert.equal(publicAddress('2606:4700:4700::1111'), '2606:4700:4700::1111');
});
test('P4 all DNS answers are checked and rejected headers never reach transport', async () => {
  let connections = 0;
  for (const answers of [
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '::1', family: 6 },
    ],
    [{ address: '127.0.0.1', family: 6 }],
  ]) {
    const fetcher = new SourceFetcher({
      resolve: async () => answers,
      connect: () => {
        connections++;
        throw new Error();
      },
    });
    await assert.rejects(fetcher.fetch(input()), { code: 'SOURCE_ADDRESS_REJECTED' });
  }
  const fetcher = new SourceFetcher({
    connect: () => {
      connections++;
      throw new Error();
    },
  });
  for (const headers of [
    { ...input().headers, host: 'internal' },
    { ...input().headers, cookie: 'private' },
    { ...input().headers, authorization: 'Bearer test\r\nHost: internal' },
  ])
    await assert.rejects(fetcher.fetch({ ...input(), headers }), { code: 'SOURCE_CONFIG_INVALID' });
  assert.equal(connections, 0);
});
test('P4 real TLS binds the checked address, original SNI and identity before sending allowed headers', async (t) => {
  const f = await fixture(t, (_req, res) => res.end('sample'));
  assert.equal(
    await f.fetcher().fetch(input('https://source.test:8443/sub?token=fixture')),
    'sample',
  );
  assert.equal(f.connections[0].host, '8.8.8.8');
  assert.equal(f.connections[0].port, 8443);
  assert.equal(f.connections[0].servername, 'source.test');
  assert.equal(f.connections[0].rejectUnauthorized, true);
  assert.equal(f.requests[0].headers.authorization, input().headers.authorization);
  assert.equal(f.requests[0].headers.host, 'source.test:8443');
  assert.equal(f.requests[0].url, '/sub?token=fixture');
  assert.equal(f.requests[0].headers.cookie, undefined);
  await f.fetcher().fetch(input());
  assert.equal(f.connections.length, 2, 'each fetch opens its own checked TLS connection');
  await assert.rejects(f.fetcher({ peer: null }).fetch(input()), {
    code: 'SOURCE_ADDRESS_REJECTED',
  });
  await assert.rejects(f.fetcher({ peer: '1.1.1.1' }).fetch(input()), {
    code: 'SOURCE_ADDRESS_REJECTED',
  });
  assert.equal(f.requests.length, 2, 'no HTTP credentials sent before peer validation');
  await f
    .fetcher()
    .fetch({ ...input(), headers: { userAgent: '', accept: '', authorization: '' } });
  for (const header of ['user-agent', 'accept', 'authorization'])
    assert.equal(
      f.requests.at(-1).headers[header],
      undefined,
      'explicitly cleared headers are omitted',
    );
});
test('P4 real TLS rejects untrusted or mismatched certificates and handles IP certificate identity', async (t) => {
  const f = await fixture(t, (_req, res) => res.end('sample'));
  await assert.rejects(f.fetcher({ trusted: false }).fetch(input()), { code: 'SOURCE_TLS_FAILED' });
  await assert.rejects(f.fetcher().fetch(input('https://wrong.test')), {
    code: 'SOURCE_TLS_FAILED',
  });
  assert.equal(f.requests.length, 0);
  assert.equal(await f.fetcher().fetch(input('https://8.8.8.8')), 'sample');
  assert.equal(f.connections.at(-1).servername, '');
});
test('P4 redirects, HTTP failures, HTML, empty and invalid UTF-8 bodies are rejected without following URLs', async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'https://source.test/followed' });
      res.end();
    } else if (req.url === '/auth') {
      res.writeHead(401);
      res.end('secret error page');
    } else if (req.url === '/html') {
      res.setHeader('Content-Type', 'text/html');
      res.end('error page');
    } else if (req.url === '/sniff') res.end('  <html>error</html>');
    else if (req.url === '/utf8') res.end(Buffer.from([0xff]));
    else res.end('');
  });
  for (const [path, code] of [
    ['/redirect', 'SOURCE_REDIRECT_REJECTED'],
    ['/auth', 'SOURCE_HTTP_FAILED'],
    ['/html', 'SOURCE_HTML_REJECTED'],
    ['/sniff', 'SOURCE_HTML_REJECTED'],
    ['/utf8', 'SOURCE_ENCODING_INVALID'],
    ['/empty', 'SOURCE_EMPTY'],
  ]) {
    await assert.rejects(f.fetcher().fetch(input('https://source.test' + path)), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
  assert.equal(f.requests.length, 6);
  assert.ok(!f.requests.some((r) => r.url === '/followed'));
});
test('P4 identity, gzip, deflate and br enforce actual received and expanded byte limits', async (t) => {
  const body = '中文订阅正文';
  const f = await fixture(t, (req, res) => {
    const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
    const encoding = req.url.slice(1);
    if (encoding in encoders) {
      res.setHeader('Content-Encoding', encoding);
      res.end(encoders[encoding](body));
    } else if (encoding === 'bomb') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync('x'.repeat(MAX_BYTES + 1)));
    } else if (encoding === 'large') {
      res.write(Buffer.alloc(MAX_BYTES));
      res.end('x');
    } else if (encoding === 'declared') {
      res.setHeader('Content-Length', MAX_BYTES + 1);
      res.end('x');
    } else if (encoding === 'broken') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync(body).subarray(0, 8));
    } else if (encoding === 'unsupported') {
      res.setHeader('Content-Encoding', 'gzip, br');
      res.end('x');
    } else res.end(body);
  });
  for (const encoding of ['identity', 'gzip', 'deflate', 'br'])
    assert.equal(await f.fetcher().fetch(input('https://source.test/' + encoding)), body);
  for (const path of ['bomb', 'large', 'declared'])
    await assert.rejects(f.fetcher().fetch(input('https://source.test/' + path)), {
      code: 'SOURCE_TOO_LARGE',
    });
  await assert.rejects(f.fetcher().fetch(input('https://source.test/broken')), {
    code: 'SOURCE_NETWORK_FAILED',
  });
  await assert.rejects(f.fetcher().fetch(input('https://source.test/unsupported')), {
    code: 'SOURCE_ENCODING_UNSUPPORTED',
  });
});
test('P4 total deadline cancels DNS and live response streams; explicit cancellation also closes the connection', async (t) => {
  let ended;
  const f = await fixture(t, (_req, res) => {
    res.write('waiting');
    res.on('close', () => ended?.());
  });
  let dnsCancelled = false;
  const dns = f.fetcher({
    timeoutMs: 30,
    resolve: (_host, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            dnsCancelled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(dns.fetch(input()), { code: 'SOURCE_TIMEOUT' });
  assert.equal(dnsCancelled, true);
  const closed = new Promise((resolve) => {
    ended = resolve;
  });
  await assert.rejects(f.fetcher({ timeoutMs: 80 }).fetch(input()), { code: 'SOURCE_TIMEOUT' });
  await closed;
  const abort = new AbortController(),
    started = new Promise((resolve) => f.server.once('request', resolve));
  const cancelled = f.fetcher().fetch(input(), abort.signal);
  const rejected = assert.rejects(cancelled, { code: 'SOURCE_CANCELLED' });
  await started;
  const closedAgain = new Promise((resolve) => {
    ended = resolve;
  });
  abort.abort();
  await rejected;
  await closedAgain;
});

test(
  'P4 a TLS handshake that never completes is cancelled within the total deadline',
  { timeout: 2000 },
  async (t) => {
    const sockets = new Set();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    const fetcher = new SourceFetcher({
      timeoutMs: 40,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      connect: (options) => connect({ ...options, host: '127.0.0.1', port: server.address().port }),
    });
    await assert.rejects(fetcher.fetch(input()), { code: 'SOURCE_TIMEOUT' });
  },
);
