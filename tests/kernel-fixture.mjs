import { createServer as createTcpServer, createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';

// Disposable loopback listeners and kernel clients shared by ordinary-node fixtures.
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
        socket.write('GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      }
    });
    socket.once('end', () => {
      if (stage !== 2) return finish(new Error('SOCKS connection ended before response'));
      const value = buffer.toString('utf8');
      if (!/^HTTP\/1\.1 200/.test(value) || !value.includes('SubMeld-loopback-node'))
        return finish(new Error('Unexpected loopback response'));
      finish(null, value);
    });
    socket.once('close', () => {
      if (!settled) finish(new Error('SOCKS connection closed'));
    });
  });
}
