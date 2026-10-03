import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer, createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomInt, X509Certificate } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { renderInput } from '../dist/server/converter/render.js';
import { chainItem } from './chain-fixtures.mjs';
import { testCertificate, testKey } from './source-tls-fixture.mjs';

// All traffic and identities below belong to this disposable loopback fixture.
async function udpPort() {
  const socket = createSocket('udp4');
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
}
async function closeUdp(socket) {
  try {
    await new Promise((resolve) => socket.close(resolve));
  } catch (error) {
    if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error;
  }
}
export async function dualPort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const udp = createSocket('udp4'),
      tcp = createTcpServer();
    // Windows can reserve contiguous ranges differently for TCP and UDP.
    // Random candidates avoid repeatedly sampling one reserved ephemeral range.
    const value = randomInt(20000, 49000);
    try {
      udp.bind(value, '127.0.0.1');
      await once(udp, 'listening');
      tcp.listen(value, '127.0.0.1');
      await once(tcp, 'listening');
      return value;
    } catch (error) {
      if (!['EACCES', 'EADDRINUSE'].includes(error.code)) throw error;
    } finally {
      if (tcp.listening) await new Promise((resolve) => tcp.close(resolve));
      await closeUdp(udp);
    }
  }
  throw new Error('No loopback TCP/UDP port available');
}
export async function start(binary, target, config, path) {
  await mkdir(path, { recursive: true });
  const file = join(path, target === 'mihomo' ? 'config.yaml' : 'config.json');
  await writeFile(
    file,
    target === 'mihomo'
      ? stringify(config)
      : JSON.stringify(target === 'singbox' ? { ...config, log: { level: 'debug' } } : config),
  );
  const args = target === 'mihomo' ? ['-d', path, '-f', file] : ['run', '-c', file];
  const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '',
    failure;
  const append = (data) => {
    output = (output + String(data)).slice(-65536);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => {
    failure = error;
  });
  const done = new Promise((resolve) => child.once('close', resolve));
  return {
    get log() {
      return output;
    },
    async ready(probePort, socks = false) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (failure || child.exitCode !== null)
          throw new Error('Loopback core failed: ' + (failure?.message ?? output));
        // sing-box 1.14.1 can accept SOCKS before its first Windows interface
        // update finishes, which closes fresh QUIC sessions as "network changed".
        // Wait for the actual initialization messages before testing traffic.
        if (
          target === 'singbox' &&
          (!output.includes('sing-box started') ||
            (process.platform === 'win32' &&
              output.includes('updated default interface') &&
              !output.includes('updated network environment')))
        ) {
          await delay(40);
          continue;
        }
        if (probePort) {
          const accepted = await new Promise((resolve) => {
            const socket = createConnection({ host: '127.0.0.1', port: probePort });
            const finish = (value) => {
              socket.destroy();
              resolve(value);
            };
            socket.setTimeout(500, () => finish(false));
            socket.once('connect', () => {
              if (socks) socket.write(Buffer.from([5, 1, 0]));
              else finish(true);
            });
            socket.once('data', (data) => finish(data[0] === 5 && data[1] === 0));
            socket.once('error', () => finish(false));
          });
          if (accepted) return;
        } else if (output.includes('sing-box started')) return;
        await delay(40);
      }
      throw new Error('Loopback core did not become ready: ' + output);
    },
    async stop() {
      if (child.exitCode === null && !failure) child.kill();
      await done;
    },
  };
}
export function socksRequest(proxyPort, destinationPort) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: proxyPort });
    let buffer = Buffer.alloc(0),
      stage = 0,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(4000, () => finish(new Error('SOCKS request timed out')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (stage === 0 && buffer.length >= 2) {
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish(new Error('SOCKS greeting rejected'));
        buffer = buffer.subarray(2);
        stage = 1;
        socket.write(
          Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, destinationPort >> 8, destinationPort & 255]),
        );
      }
      if (stage === 1 && buffer.length >= 5) {
        if (buffer[1] !== 0) return finish(new Error('SOCKS connection rejected'));
        const size = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : 7 + buffer[4];
        if (buffer.length < size) return;
        buffer = buffer.subarray(size);
        stage = 2;
        socket.write('GET /chain HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      }
    });
    socket.once('end', () => {
      if (stage !== 2) return finish(new Error('SOCKS connection ended before response'));
      const value = buffer.toString('utf8');
      if (!/^HTTP\/1\.1 200/.test(value) || !value.includes('SubMeld-loopback-chain'))
        return finish(new Error('Unexpected loopback response'));
      finish(null, value);
    });
    socket.once('close', () => {
      if (!settled) finish(new Error('SOCKS connection closed'));
    });
  });
}
function serverConfig(inbound) {
  return {
    log: { level: 'info' },
    inbounds: [inbound],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
  };
}
export async function checkChainConnections(binaries, results, render = renderInput) {
  for (const target of ['mihomo', 'singbox', 'xray']) {
    for (const exitProtocol of target === 'xray'
      ? ['ss', 'hysteria2']
      : ['ss', 'hysteria2', 'tuic']) {
      const caseDir = join(results, 'chain-' + target + '-' + exitProtocol);
      let hits = 0,
        entryCore,
        exitCore,
        client;
      const destination = createServer((_request, response) => {
        hits++;
        response.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
        response.end('SubMeld-loopback-chain');
      });
      destination.listen(0, '127.0.0.1');
      await once(destination, 'listening');
      try {
        const entryPort = await dualPort(),
          exitPort = exitProtocol === 'ss' ? await dualPort() : await udpPort(),
          clientPort = await dualPort();
        const chain = chainItem('ss', exitProtocol);
        for (const [draft, value, password] of [
          [chain.entry, entryPort, 'entry-test-only'],
          [chain.exit, exitPort, 'exit-test-only'],
        ]) {
          draft.server = '127.0.0.1';
          draft.port = value;
          draft.auth.password = password;
        }
        if (exitProtocol !== 'ss') chain.exit.tls.serverName = 'source.test';
        if (exitProtocol === 'hysteria2') {
          chain.exit.protocolOptions.obfs = '';
          chain.exit.protocolOptions.obfsPassword = '';
          chain.exit.tls.insecure = true;
          if (target !== 'xray') {
            chain.exit.protocolOptions.ports = exitPort + '-' + exitPort;
            chain.exit.port = await udpPort();
          }
          if (target !== 'singbox')
            chain.exit.protocolOptions.pinSHA256 = new X509Certificate(
              testCertificate,
            ).fingerprint256
              .replaceAll(':', '')
              .toLowerCase();
        }
        if (exitProtocol === 'tuic') {
          chain.exit.tls.alpn = ['h3'];
          chain.exit.tls.insecure = true;
          chain.exit.protocolOptions.reduceRtt = false;
        }
        const common = { listen: '127.0.0.1', listen_port: exitPort };
        const tls = {
          enabled: true,
          alpn: ['h3'],
          certificate: testCertificate.trim().split(/\r?\n/),
          key: testKey.trim().split(/\r?\n/),
        };
        const outboundServer =
          exitProtocol === 'ss'
            ? {
                ...common,
                type: 'shadowsocks',
                method: 'aes-128-gcm',
                password: chain.exit.auth.password,
              }
            : {
                ...common,
                type: exitProtocol,
                users: [
                  {
                    name: 'fixture',
                    password: chain.exit.auth.password,
                    ...(exitProtocol === 'tuic' ? { uuid: chain.exit.auth.uuid } : {}),
                  },
                ],
                tls,
              };
        exitCore = await start(
          binaries.singbox,
          'singbox',
          serverConfig(outboundServer),
          join(caseDir, 'exit'),
        );
        await exitCore.ready(exitProtocol === 'ss' ? exitPort : undefined);
        entryCore = await start(
          binaries.singbox,
          'singbox',
          serverConfig({
            type: 'shadowsocks',
            listen: '127.0.0.1',
            listen_port: entryPort,
            method: 'aes-128-gcm',
            password: chain.entry.auth.password,
          }),
          join(caseDir, 'entry'),
        );
        await entryCore.ready(entryPort);
        const result = await render({ target, items: [chain], listenPort: clientPort });
        const config = target === 'mihomo' ? parse(result.full) : JSON.parse(result.full);
        if (target === 'mihomo') config['log-level'] = 'debug';
        if (target === 'singbox') config.log = { level: 'debug' };
        client = await start(binaries[target], target, config, join(caseDir, 'client'));
        await client.ready(clientPort, true);
        await socksRequest(clientPort, destination.address().port);
        assert.equal(hits, 1, 'Request reaches the destination once');
        assert.ok(
          entryCore.log.includes('127.0.0.1:' + exitPort),
          'The first hop connects to the exit',
        );
        assert.ok(
          exitCore.log.includes('127.0.0.1:' + destination.address().port),
          'The exit connects to the destination',
        );
        await client.stop();
        client = undefined;
        if (target !== 'singbox' && exitProtocol === 'hysteria2') {
          const wrongPin = structuredClone(chain);
          wrongPin.exit.protocolOptions.pinSHA256 = 'ab'.repeat(32);
          const rejected = await render({ target, items: [wrongPin], listenPort: clientPort });
          client = await start(
            binaries[target],
            target,
            parse(rejected.full),
            join(caseDir, 'wrong-pin'),
          );
          await client.ready(clientPort, true);
          await assert.rejects(socksRequest(clientPort, destination.address().port));
          assert.equal(hits, 1, 'Wrong HY2 certificate pin must fail even with insecure enabled');
          await client.stop();
          client = undefined;
        }
        await entryCore.stop();
        entryCore = undefined;
        // A fresh client avoids retaining a QUIC session or pooled connection after removal.
        client = await start(binaries[target], target, config, join(caseDir, 'client'));
        await client.ready(clientPort, true);
        await assert.rejects(socksRequest(clientPort, destination.address().port));
        assert.equal(hits, 1, 'No direct or single-hop fallback when the entry is stopped');
        console.log(
          'PASS ' + target + ' chain SS -> ' + exitProtocol + ': connection and no bypass',
        );
      } catch (error) {
        throw new Error(
          target +
            ' SS -> ' +
            exitProtocol +
            ': ' +
            error.message +
            '\nclient: ' +
            (client?.log ?? '') +
            '\nentry: ' +
            (entryCore?.log ?? '') +
            '\nexit: ' +
            (exitCore?.log ?? ''),
          { cause: error },
        );
      } finally {
        await client?.stop();
        await entryCore?.stop();
        await exitCore?.stop();
        destination.closeAllConnections();
        await new Promise((resolve) => destination.close(resolve));
      }
    }
  }
}
