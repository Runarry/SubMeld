import { randomBytes, randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { AppError } from './errors.js';
import { startProcess } from './kernel-process.js';
import { portReady } from './node-probe.js';
import type { KernelBinary } from './kernels.js';
import type { RenderTarget, RenderItem } from './shared/contracts.js';
import { renderResultSchema } from './shared/contracts.js';
import type { Converter } from './converter/pool.js';

// A SOCKS bridge needs both TCP and UDP on its advertised interfaces. Windows
// may allow a loopback TCP reservation while excluding the same UDP port.
export async function freeBridgePort(bind = '0.0.0.0') {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tcp = createServer(),
      udp = createSocket('udp4');
    let udpBound = false;
    try {
      tcp.listen(randomInt(20000, 49000), bind);
      await once(tcp, 'listening');
      const address = tcp.address();
      if (!address || typeof address === 'string') throw new Error('No bridge address');
      udp.bind(address.port, bind);
      await once(udp, 'listening');
      udpBound = true;
      return address.port;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        !['EACCES', 'EADDRINUSE'].includes(String(error.code))
      )
        throw error;
    } finally {
      if (udpBound) await new Promise<void>((resolve) => udp.close(() => resolve()));
      if (tcp.listening) await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  }
  throw new AppError('TEST_START_FAILED', '没有可用的 TCP/UDP 链入口端口。', 503);
}

export function bridgeConfig(
  target: RenderTarget,
  full: string,
  port: number,
  username: string,
  password: string,
  bind = '0.0.0.0',
) {
  const value = z
    .record(z.string(), z.unknown())
    .parse(target === 'mihomo' ? parse(full) : JSON.parse(full));
  if (target === 'mihomo')
    return stringify({
      ...value,
      'mixed-port': 0,
      'socks-port': port,
      'allow-lan': true,
      'bind-address': bind,
      authentication: [username + ':' + password],
      'skip-auth-prefixes': [],
    });
  const inbound =
    target === 'singbox'
      ? {
          type: 'socks',
          tag: 'local-in',
          listen: bind,
          listen_port: port,
          users: [{ username, password }],
        }
      : {
          tag: 'local-in',
          listen: bind,
          port,
          protocol: 'socks',
          settings: {
            auth: 'password',
            accounts: [{ user: username, pass: password }],
            udp: true,
            ip: bind,
          },
        };
  return JSON.stringify({ ...value, inbounds: [inbound] });
}
export async function startBridge(
  binary: KernelBinary,
  item: RenderItem,
  converter: Converter,
  dataDir: string,
  host: string,
  signal: AbortSignal,
  bind = '0.0.0.0',
) {
  const port = await freeBridgePort(bind);
  const rendered = renderResultSchema.parse(
    await converter.run(
      { kind: 'render', input: { target: binary.target, listenPort: port, items: [item] } },
      signal,
    ),
  );
  return launchBridge(binary, rendered.full, port, dataDir, host, signal, bind);
}
export async function launchBridge(
  binary: KernelBinary,
  full: string,
  port: number,
  dataDir: string,
  host: string,
  signal: AbortSignal,
  bind = '0.0.0.0',
) {
  const username = 'submeld',
    password = randomBytes(24).toString('hex');
  const root = join(dataDir, 'node-test-tmp');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'miaospeed-'));
  let child: ReturnType<typeof startProcess> | undefined, closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener('abort', abort);
      await child?.stop();
      // Only this mkdtemp-created directory is removed; persistent data is never targeted.
      await rm(directory, { recursive: true, force: true });
    })());
  const abort = () => {
    void close();
  };
  try {
    const configPath = join(directory, binary.target === 'mihomo' ? 'config.yaml' : 'config.json');
    await writeFile(configPath, bridgeConfig(binary.target, full, port, username, password, bind), {
      mode: 0o600,
    });
    signal.throwIfAborted();
    child = startProcess(
      binary.path,
      binary.target === 'mihomo' ? ['-d', directory, '-f', configPath] : ['run', '-c', configPath],
      directory,
    );
    const startup = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    while (!(await portReady(port, startup, bind === '0.0.0.0' ? '127.0.0.1' : bind))) {
      signal.throwIfAborted();
      if (child.exited)
        throw new AppError('TARGET_UNSUPPORTED', '所选内核拒绝了链或 SOCKS 配置。', 422);
      if (startup.aborted) throw new AppError('TEST_START_TIMEOUT', '链测试内核启动超时。', 504);
      await delay(40);
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      await close();
      signal.throwIfAborted();
    }
    return {
      get diagnostics() {
        return child?.output ?? '';
      },
      payload: JSON.stringify({
        name: 'chain-bridge',
        type: 'socks5',
        server: host,
        port,
        username,
        password,
        udp: true,
      }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
