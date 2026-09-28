import { request as httpRequest } from 'node:http';
import { request as httpsRequest, Agent } from 'node:https';
import { connect as tlsConnect, checkServerIdentity, type ConnectionOptions } from 'node:tls';
import { createServer, createConnection, isIP, type Socket } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AppError } from './errors.js';
import { sourceUrl, publicAddress, resolveSource, type SourceAddress } from './probe-address.js';
import { startProcess } from './kernel-process.js';
import type { RenderTarget } from './shared/contracts.js';
import type { KernelBinary } from './kernels.js';

export function probeUrl(input: string) {
  try {
    return sourceUrl(input);
  } catch {
    throw new AppError(
      'TEST_URL_INVALID',
      '测试地址必须是公网 HTTPS 地址，不能包含用户信息、片段或控制字符。',
      400,
    );
  }
}
type ProbeOptions = {
  resolve?: typeof resolveSource;
  validateAddress?: (address: string) => string;
  ca?: ConnectionOptions['ca'];
  timeoutMs?: number;
  onKernelOutput?: (output: string) => void;
};

/** HTTPS can only be created over the socket returned by the loopback CONNECT tunnel. */
export async function probeHttps(
  proxyPort: number,
  input: string,
  external: AbortSignal,
  options: ProbeOptions = {},
) {
  const signal = AbortSignal.any([external, AbortSignal.timeout(options.timeoutMs ?? 10000)]);
  try {
    const url = probeUrl(input),
      hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses: SourceAddress[] = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) === 4 ? 4 : 6 }]
      : await (options.resolve ?? resolveSource)(hostname, signal);
    if (!addresses.length) throw new Error('No address');
    for (const item of addresses) {
      if (!options.validateAddress && /^198\.(18|19)\./.test(item.address))
        throw new AppError(
          'TEST_DNS_FAKE_IP',
          '本机 DNS 为测试目标返回了 Fake-IP。请更换测试地址，或将测试域名加入本机代理的 fake-ip-filter 后重试；尚未测试节点连接。',
        );
      (options.validateAddress ?? publicAddress)(item.address);
    }
    const address = addresses[0].address;
    const destination =
      (isIP(address) === 6 ? '[' + address + ']' : address) + ':' + (url.port || '443');
    const started = performance.now();
    return await new Promise<{ latencyMs: number; httpStatus: number }>((resolve, reject) => {
      let tunnel: Socket | undefined;
      const agent = new Agent({ keepAlive: false });
      let settled = false;
      const finish = (error?: unknown, status?: number) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        connect.destroy();
        agent.destroy();
        tunnel?.destroy();
        if (error) reject(error);
        else
          resolve({
            latencyMs: Math.round((performance.now() - started) * 10) / 10,
            httpStatus: status ?? 0,
          });
      };
      const abort = () => finish(signal.reason);
      const connect = httpRequest({
        hostname: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: destination,
        headers: { Host: destination },
        agent: false,
        maxHeaderSize: 16384,
      });
      connect.once('error', (error) => finish(error));
      connect.once('response', () => finish(new Error('Tunnel rejected')));
      connect.once('connect', (response, socket, head) => {
        tunnel = socket;
        if (settled) {
          socket.destroy();
          return;
        }
        if (response.statusCode !== 200 || head.length) {
          finish(new Error('Tunnel rejected'));
          return;
        }
        const tls = tlsConnect({
          socket,
          servername: isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
          ALPNProtocols: ['http/1.1'],
          ...(options.ca ? { ca: options.ca } : {}),
        });
        tunnel = tls;
        tls.once('error', (error) => finish(error));
        // The agent never has a path which creates a direct connection.
        agent.createConnection = () => tls;
        const request = httpsRequest(
          url,
          {
            method: 'GET',
            agent,
            maxHeaderSize: 16384,
            headers: { 'User-Agent': 'SubMeld-Node-Test/1.0', Accept: '*/*', Connection: 'close' },
          },
          (response) => {
            finish(undefined, response.statusCode);
            response.destroy();
          },
        );
        request.once('error', (error) => finish(error));
        request.end();
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else connect.end();
    });
  } catch (error) {
    if (external.aborted) throw new AppError('TEST_CANCELLED', '测试已取消。');
    if (signal.aborted) throw new AppError('TEST_TIMEOUT', 'HTTPS 请求超过 10 秒，连接已关闭。');
    if (error instanceof AppError) {
      if (error.code === 'SOURCE_DNS_FAILED')
        throw new AppError(
          'TEST_DNS_FAILED',
          '本机无法解析测试目标，请检查 DNS 或更换测试地址；尚未测试节点连接。',
        );
      if (error.code.startsWith('SOURCE_'))
        throw new AppError(
          'TEST_ADDRESS_REJECTED',
          '测试目标解析到了非公网地址，请更换测试地址；尚未测试节点连接。',
        );
      throw error;
    }
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))
      throw new AppError('TEST_TLS_FAILED', '测试目标的 HTTPS 证书或 TLS 连接验证失败。');
    throw new AppError('TEST_NETWORK_FAILED', '无法通过此节点建立 HTTPS 连接。');
  }
}

export function testConfig(target: RenderTarget, full: string) {
  if (target !== 'xray') return full;
  const config = z
    .object({ inbounds: z.array(z.object({ port: z.number() })) })
    .passthrough()
    .parse(JSON.parse(full));
  return JSON.stringify({
    ...config,
    inbounds: [
      {
        tag: 'local-in',
        listen: '127.0.0.1',
        port: config.inbounds[0].port,
        protocol: 'http',
        settings: {},
      },
    ],
  });
}
export function freeProbePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
async function portReady(port: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (ready: boolean) => {
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
    socket.setTimeout(150, () => finish(false));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function runNodeProbe(
  binary: KernelBinary,
  full: string,
  port: number,
  url: string,
  dataDir: string,
  signal: AbortSignal,
  options: ProbeOptions = {},
) {
  signal.throwIfAborted();
  const root = join(dataDir, 'node-test-tmp');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'probe-'));
  let child: ReturnType<typeof startProcess> | undefined;
  try {
    const path = join(directory, binary.target === 'mihomo' ? 'config.yaml' : 'config.json');
    await writeFile(path, testConfig(binary.target, full), { mode: 0o600 });
    signal.throwIfAborted();
    child = startProcess(
      binary.path,
      binary.target === 'mihomo' ? ['-d', directory, '-f', path] : ['run', '-c', path],
      directory,
    );
    const startup = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    for (;;) {
      signal.throwIfAborted();
      if (child.exited) throw new AppError('TEST_CONFIG_FAILED', '内核拒绝配置或启动失败。');
      if (startup.aborted) throw new AppError('TEST_START_TIMEOUT', '内核启动超过 5 秒。');
      if (await portReady(port, startup)) break;
      await delay(40, undefined, { signal: startup }).catch(() => {});
    }
    const abort = () => {
      void child?.stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await probeHttps(port, url, signal, options);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    await child?.stop();
    // directory is created by mkdtemp under this application's fixed temporary root.
    await rm(directory, { recursive: true, force: true });
    options.onKernelOutput?.(child?.output ?? '');
  }
}
