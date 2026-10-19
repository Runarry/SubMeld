import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dualPort, start } from './kernel-fixture.mjs';
import { node } from './fixtures.mjs';
import { speedSettingsSchema } from '../dist/server/shared/miaospeed.js';

// Disposable real proxy/HTTP/STUN services. No personal subscriptions or public credentials.
export async function controlledNetwork(binary, directory) {
  const counts = { http: 0, download: 0, upload: 0, stun: 0, scripts: 0 };
  // Native HTTP ping uses LF-only headers; accept them in this controlled fixture.
  const server = createServer({ insecureHTTPParser: true }, async (req, res) => {
    counts.http++;
    if (req.url === '/hang') return;
    if (req.url === '/down') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(16384, 65);
      while (!res.destroyed) {
        res.write(chunk);
        counts.download += chunk.length;
        await delay(10);
      }
    } else if (req.url === '/up') {
      req.on('data', (data) => {
        counts.upload += data.length;
      });
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    } else if (req.url === '/script') {
      counts.scripts++;
      res.end('controlled-fixture');
    } else if (req.url === '/ip') {
      res.end('203.0.113.9');
    } else {
      await delay(30);
      res.writeHead(204);
      res.end();
    }
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const port = server.address().port;
  const stunPort = await dualPort(),
    otherPort = await dualPort();
  const udp = [];
  const attribute = (type, host, port, xor = false) => {
    const b = Buffer.alloc(12);
    b.writeUInt16BE(type);
    b.writeUInt16BE(8, 2);
    b[5] = 1;
    b.writeUInt16BE(port ^ (xor ? 0x2112 : 0), 6);
    const bytes = host.split('.').map(Number),
      cookie = [0x21, 0x12, 0xa4, 0x42];
    for (let i = 0; i < 4; i++) b[8 + i] = bytes[i] ^ (xor ? cookie[i] : 0);
    return b;
  };
  for (const [host, value] of [
    ['127.0.0.1', stunPort],
    ['127.0.0.2', stunPort],
    ['127.0.0.2', otherPort],
  ]) {
    const socket = createSocket('udp4');
    socket.bind(value, host);
    await once(socket, 'listening');
    udp.push(socket);
    socket.on('message', (request, remote) => {
      if (request.length < 20 || request.readUInt32BE(4) !== 0x2112a442) return;
      counts.stun++;
      const attrs = Buffer.concat([
        attribute(0x20, '198.51.100.10', 40000, true),
        attribute(0x802c, '127.0.0.2', otherPort),
        attribute(0x802b, host, value),
      ]);
      const header = Buffer.from(request.subarray(0, 20));
      header.writeUInt16BE(0x0101);
      header.writeUInt16BE(attrs.length, 2);
      let changed = false;
      for (let n = 20; n + 4 <= request.length;) {
        const length = request.readUInt16BE(n + 2);
        if (request.readUInt16BE(n) === 3) changed = true;
        n += 4 + Math.ceil(length / 4) * 4;
      }
      (changed ? udp[2] : socket).send(Buffer.concat([header, attrs]), remote.port, remote.address);
    });
  }
  const draft = node('ss');
  draft.name = 'controlled node';
  draft.server = '127.0.0.1';
  draft.port = await dualPort();
  draft.auth.password = 'proxy-public-test-only';
  draft.protocolOptions.method = 'aes-128-gcm';
  const proxy = await start(
    binary,
    'singbox',
    {
      log: { level: 'info' },
      inbounds: [
        {
          type: 'shadowsocks',
          listen: '0.0.0.0',
          listen_port: draft.port,
          method: 'aes-128-gcm',
          password: draft.auth.password,
        },
      ],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { final: 'direct' },
    },
    join(directory, 'proxy'),
  );
  await proxy.ready(draft.port);
  const proxies = [proxy];
  const settings = speedSettingsSchema.parse({
    pingUrl: `http://127.0.0.1:${port}/ping`,
    downloadUrl: `http://127.0.0.1:${port}/down`,
    uploadUrl: `http://127.0.0.1:${port}/up`,
    stunAddress: `udp://127.0.0.1:${stunPort}`,
    downloadSeconds: 1,
    uploadSeconds: 3,
    pingCount: 3,
    retries: 1,
    requestTimeoutMs: 1000,
  });
  const raw = {
    name: 'controlled <>中\u2028',
    type: 'ss',
    server: 'host.docker.internal',
    port: draft.port,
    cipher: 'aes-128-gcm',
    password: draft.auth.password,
    udp: true,
  };
  const script = {
    ID: 'controlled',
    Type: 'media',
    TimeoutMillis: 5000,
    Content: `function handler(){ var r=fetch('http://127.0.0.1:${port}/script', {timeout:2000}); return {text:r.body,background:'12,34,56'}; }`,
  };
  const geoScript = {
    ID: 'controlled-geo',
    Type: 'ip',
    TimeoutMillis: 5000,
    Content: `function ip_resolve(){return [fetch('http://127.0.0.1:${port}/ip').body];} function handler(ip){return {ip:ip,country:'Fixture',country_code:'ZZ',asn:64512,asn_organization:'Controlled'};}`,
  };
  return {
    counts,
    settings,
    raw,
    draft,
    script,
    geoScript,
    proxies,
    port,
    stunPort,
    assertProxyTraffic() {
      assert.ok(proxy.log.includes('127.0.0.1:' + port), 'Proxy reached HTTP target');
      assert.ok(proxy.log.includes('127.0.0.1:' + stunPort), 'Proxy reached STUN target');
    },
    async close() {
      for (const proxy of proxies) await proxy.stop();
      for (const socket of udp) await new Promise((resolve) => socket.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
