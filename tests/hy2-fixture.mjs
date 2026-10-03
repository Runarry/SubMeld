import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { fixture } from './upstream-fixture.mjs';
import { node } from './fixtures.mjs';
import { start, dualPort } from './chain-connections.mjs';
import { testCertificate, testKey } from './source-tls-fixture.mjs';
import { KernelManager } from '../dist/server/kernels.js';
import { Hy2Certificates } from '../dist/server/hy2-certificates.js';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';

export const fixturePin = new X509Certificate(testCertificate).fingerprint256
  .replaceAll(':', '')
  .toLowerCase();

export async function hy2Fixture(t) {
  let kernels;
  const f = await fixture(t, {
    makeCertificates(store, directory) {
      kernels = new KernelManager(directory);
      return new Hy2Certificates(
        store.resources,
        store.certificateResolverToken(),
        directory,
        kernels,
      );
    },
  });
  await kernels.initialize();
  const lease = kernels.snapshot();
  const binaries = Object.fromEntries(
    [...lease.binaries].map(([target, binary]) => [target, binary.path]),
  );
  for (const target of ['mihomo', 'singbox', 'xray'])
    assert.ok(binaries[target], target + ' must be installed');
  const server = serve({ fetch: f.app.fetch, hostname: '0.0.0.0', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const resolverUrl = `http://${process.env.MIAOSPEED_BRIDGE_HOST ?? 'host.docker.internal'}:${server.address().port}/api/internal/hy2-certificates/resolve`;
  f.files.configureCertificateResolver({ url: resolverUrl, token: f.certificateResolverToken() });
  await f.client.exclusive(() => f.files.initialize());
  f.beforeClose(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.certificates.close();
    await lease.release();
    await kernels.close();
  });
  let sequence = 0;
  async function proxy(protocol = 'hysteria2', options = {}) {
    const draft = node(protocol);
    draft.server = options.host ?? '127.0.0.1';
    draft.port = await dualPort();
    draft.name = 'HY2 fixture ' + ++sequence;
    draft.auth.password = protocol + '-public-test-only';
    let inbound;
    if (protocol === 'hysteria2') {
      draft.tls.serverName = 'source.test';
      draft.protocolOptions.pinSHA256 = new X509Certificate(
        options.certificate ?? testCertificate,
      ).fingerprint256
        .replaceAll(':', '')
        .toLowerCase();
      draft.protocolOptions.obfs = options.obfs ? 'salamander' : '';
      draft.protocolOptions.obfsPassword = options.obfs ? 'obfs-public-test-only' : '';
      inbound = {
        type: protocol,
        listen: draft.server,
        listen_port: draft.port,
        users: [{ name: 'fixture', password: draft.auth.password }],
        tls: {
          enabled: true,
          alpn: ['h3'],
          certificate: (options.certificate ?? testCertificate).trim().split(/\r?\n/),
          key: (options.key ?? testKey).trim().split(/\r?\n/),
        },
        ...(options.obfs
          ? { obfs: { type: 'salamander', password: draft.protocolOptions.obfsPassword } }
          : {}),
      };
    } else {
      inbound = {
        type: 'shadowsocks',
        listen: '127.0.0.1',
        listen_port: draft.port,
        method: draft.protocolOptions.method,
        password: draft.auth.password,
      };
    }
    const config = {
      log: { level: 'info' },
      inbounds: [inbound],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { final: 'direct' },
    };
    let process = await start(
      binaries.singbox,
      'singbox',
      config,
      join(f.directory, 'server-' + sequence),
    );
    await process.ready(protocol === 'ss' ? draft.port : undefined);
    f.beforeClose(() => process.stop());
    return {
      draft,
      get log() {
        return process.log;
      },
      stop: () => process.stop(),
      async replaceCertificate(certificate, key = testKey) {
        await process.stop();
        config.inbounds[0].tls.certificate = certificate.trim().split(/\r?\n/);
        config.inbounds[0].tls.key = key.trim().split(/\r?\n/);
        process = await start(
          binaries.singbox,
          'singbox',
          config,
          join(f.directory, 'server-' + ++sequence),
        );
        await process.ready();
      },
    };
  }
  async function plan(value, formats = ['mihomo', 'singbox', 'xray'], listenPort = 1080) {
    const chain = value.kind === 'chain';
    const drafts = chain
      ? [
          { ...value.entry, name: 'entry' },
          { ...value.exit, name: 'exit' },
        ]
      : [value];
    const resource = await f.nodes.create({
      name: 'HY2 controlled ' + ++sequence,
      source: 'local',
      content: JSON.stringify({ proxies: drafts.map(toUpstream) }),
    });
    let input = { kind: 'resource', id: resource.id };
    if (chain) {
      const saved = await f.chains.create({
        name: value.name,
        enabled: true,
        entry: { resourceId: resource.id, nodeName: 'entry' },
        exit: { resourceId: resource.id, nodeName: 'exit' },
      });
      input = { kind: 'chain', id: saved.id };
    }
    return f.subscriptions.create({
      ...newSubscription(),
      name: 'HY2 plan ' + sequence,
      inputs: [input],
      formats,
      listenPort,
    });
  }
  async function hopping(draft) {
    const backend = createSocket('udp4');
    backend.bind(0, '127.0.0.1');
    await once(backend, 'listening');
    const relays = [],
      ports = [];
    const destination = draft.port;
    let latest,
      closed = false;
    for (let i = 0; i < 2; i++) {
      const relay = createSocket('udp4');
      relay.bind(await dualPort(), '127.0.0.1');
      await once(relay, 'listening');
      ports.push(relay.address().port);
      relays.push(relay);
      relay.on('message', (data, remote) => {
        if (closed) return;
        latest = { relay, remote };
        backend.send(data, destination, draft.server);
      });
    }
    backend.on('message', (data) => {
      if (!closed && latest) latest.relay.send(data, latest.remote.port, latest.remote.address);
    });
    f.beforeClose(async () => {
      closed = true;
      for (const socket of [...relays, backend])
        await new Promise((resolve) => socket.close(resolve));
    });
    draft.port = await dualPort(); // Not listening: a core must actually use the declared mport list.
    draft.protocolOptions.ports = ports[0] + ',' + ports[1] + '-' + ports[1];
    draft.protocolOptions.hopInterval = 5;
  }
  const counts = { tcp: 0, udp: 0 };
  const http = createServer((_req, res) => {
    counts.tcp++;
    res.writeHead(200);
    res.end('SubMeld-loopback-chain');
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const udp = createSocket('udp4');
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  udp.on('message', (data, remote) => {
    counts.udp++;
    udp.send(data, remote.port, remote.address);
  });
  f.beforeClose(async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await new Promise((resolve) => udp.close(resolve));
  });
  return {
    ...f,
    binaries,
    kernels,
    proxy,
    plan,
    hopping,
    counts,
    httpPort: http.address().port,
    udpPort: udp.address().port,
  };
}

export function socksUdpRequest(port, destinationPort) {
  return new Promise((resolve, reject) => {
    const control = createConnection({ host: '127.0.0.1', port });
    const socket = createSocket('udp4');
    let buffer = Buffer.alloc(0),
      stage = 0,
      finished = false;
    const timer = setTimeout(() => finish(new Error('SOCKS UDP timeout')), 5000);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      control.destroy();
      socket.close();
      if (error) reject(error);
      else resolve();
    }
    socket.bind(0, '127.0.0.1');
    socket.on('error', finish);
    control.on('error', finish);
    control.on('connect', () => control.write(Buffer.from([5, 1, 0])));
    control.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        if (buffer[0] !== 5 || buffer[1] !== 0)
          return finish(new Error('SOCKS negotiation failed'));
        buffer = buffer.subarray(2);
        stage = 1;
        control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
      if (stage === 1 && buffer.length >= 5) {
        const size = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : 7 + buffer[4];
        if (buffer.length < size) return;
        if (buffer[1] !== 0) return finish(new Error('SOCKS UDP association failed'));
        const relayPort = buffer.readUInt16BE(size - 2);
        stage = 2;
        const packet = Buffer.from([
          0,
          0,
          0,
          1,
          127,
          0,
          0,
          1,
          destinationPort >> 8,
          destinationPort & 255,
        ]);
        socket.send(
          Buffer.concat([packet, Buffer.from('hy2-controlled-udp')]),
          relayPort,
          '127.0.0.1',
        );
      }
    });
    socket.on('message', (packet) => {
      const offset = packet[3] === 1 ? 10 : packet[3] === 4 ? 22 : 7 + packet[4];
      if (packet[2] !== 0 || packet.subarray(offset).toString() !== 'hy2-controlled-udp')
        return finish(new Error('Invalid UDP echo'));
      finish();
    });
  });
}
