import { Resolver } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { isIP } from 'node:net';
import { connect, checkServerIdentity, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Address4, Address6 } from 'ip-address';
import { AppError } from './errors.js';
import { MAX_BYTES } from './shared/contracts.js';
import { remoteConfigSchema, type RemoteConfig } from './shared/subscriptions.js';

export type SourceAddress = { address: string; family: 4 | 6 };
type Resolve = (hostname: string, signal: AbortSignal) => Promise<SourceAddress[]>;
type Connect = (options: ConnectionOptions) => TLSSocket;

function addressValue(value: string) {
  if (isIP(value) === 4) return new Address4(value);
  if (isIP(value) === 6 && !value.includes('%')) return new Address6(value);
  throw new AppError('SOURCE_ADDRESS_REJECTED', '来源地址不是有效的公网 IP。');
}
function normalizedAddress(value: string) {
  const address = addressValue(value);
  return address instanceof Address6 && address.isMapped4()
    ? address.to4().correctForm()
    : address.correctForm();
}
export function publicAddress(value: string) {
  const address = addressValue(value);
  if (!address.isGlobal()) throw new AppError('SOURCE_ADDRESS_REJECTED', '来源只能访问公网地址。');
  return normalizedAddress(value);
}
export function sourceUrl(input: string) {
  let url: URL;
  try {
    if (
      [...input].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === '\\',
      )
    )
      throw new Error();
    url = new URL(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hostname)
      throw new Error();
    if (isIP(hostname)) publicAddress(hostname);
    else if (
      hostname.length > 253 ||
      !hostname
        .replace(/\.$/, '')
        .split('.')
        .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
    )
      throw new Error();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'SOURCE_URL_INVALID',
      '来源需要有效的 HTTPS 地址，不能包含用户信息、片段或控制字符。',
      400,
    );
  }
  return url;
}
export const resolveSource: Resolve = async (hostname, signal) => {
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses: SourceAddress[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        for (const address of result.value)
          addresses.push({ address, family: index === 0 ? 4 : 6 });
      } else {
        const error: unknown = result.reason;
        if (!(
          error instanceof Error &&
          'code' in error &&
          ['ENODATA', 'ENOTFOUND'].includes(String(error.code))
        ))
          throw new AppError('SOURCE_DNS_FAILED', '来源 DNS 解析失败。');
      }
    }
    if (!addresses.length) throw new AppError('SOURCE_DNS_FAILED', '来源没有可用的 DNS 地址。');
    return addresses;
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
};

function byteLimit() {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > MAX_BYTES
          ? new AppError('SOURCE_TOO_LARGE', '来源接收或解压正文超过 4 MiB。', 413)
          : null,
        chunk,
      );
    },
  });
}
function fetchError(error: unknown) {
  if (error instanceof AppError) return error;
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))
    return new AppError('SOURCE_TLS_FAILED', '来源 HTTPS 证书或安全连接验证失败。');
  return new AppError('SOURCE_NETWORK_FAILED', '来源连接或正文读取失败。');
}

/** Only this entry point performs source HTTP requests. Dependencies are for controlled tests. */
export class SourceFetcher {
  private resolve: Resolve;
  private connect: Connect;
  private timeoutMs: number;
  constructor(options: { resolve?: Resolve; connect?: Connect; timeoutMs?: number } = {}) {
    this.resolve = options.resolve ?? resolveSource;
    this.connect = options.connect ?? connect;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }
  async fetch(input: RemoteConfig, externalSignal?: AbortSignal): Promise<string> {
    const checked = remoteConfigSchema.safeParse(input);
    if (!checked.success)
      throw new AppError('SOURCE_CONFIG_INVALID', '来源地址或请求头无效。', 400);
    const url = sourceUrl(checked.data.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const abort = new AbortController();
    const cancel = () => abort.abort(new AppError('SOURCE_CANCELLED', '来源刷新已取消。'));
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    const timer = setTimeout(
      () => abort.abort(new AppError('SOURCE_TIMEOUT', '来源请求超过 15 秒，已取消。')),
      this.timeoutMs,
    );
    timer.unref();
    const signal = abort.signal;
    let agent: Agent | undefined, pendingSocket: TLSSocket | undefined;
    // A pending custom Agent connection must receive an error so its callback also completes.
    const destroy = () =>
      pendingSocket?.destroy(new AppError('SOURCE_CANCELLED', '来源连接已取消。'));
    signal.addEventListener('abort', destroy, { once: true });
    try {
      signal.throwIfAborted();
      const family = isIP(hostname);
      const addresses =
        family === 4 || family === 6
          ? [{ address: hostname, family }]
          : await this.resolve(hostname, signal);
      signal.throwIfAborted();
      if (!addresses.length) throw new AppError('SOURCE_DNS_FAILED', '来源没有可用的 DNS 地址。');
      // Validate every answer, including addresses that are not selected for this connection.
      for (const address of addresses) {
        if (isIP(address.address) !== address.family)
          throw new AppError('SOURCE_ADDRESS_REJECTED', '来源 DNS 地址无效。');
        publicAddress(address.address);
      }
      const selected = addresses[0];
      if (!selected) throw new AppError('SOURCE_DNS_FAILED', '来源没有可用的 DNS 地址。');
      const expected = normalizedAddress(selected.address);
      agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
      agent.createConnection = (_options, callback) => {
        const socket = this.connect({
          host: selected.address,
          port: Number(url.port || 443),
          servername: family ? '' : hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
          ALPNProtocols: ['http/1.1'],
        });
        pendingSocket = socket;
        let delivered = false;
        const finish = (error: Error | null) => {
          if (delivered) return;
          delivered = true;
          callback?.(error, socket);
          if (error) socket.destroy();
        };
        socket.once('error', (error) => finish(fetchError(error)));
        // Do not hand a socket to HTTP (and send Authorization) until identity and peer checks pass.
        socket.once('secureConnect', () => {
          try {
            signal.throwIfAborted();
            if (
              !socket.authorized ||
              !socket.remoteAddress ||
              publicAddress(socket.remoteAddress) !== expected
            )
              throw new AppError('SOURCE_ADDRESS_REJECTED', '来源实际连接地址与已校验地址不一致。');
            finish(null);
          } catch (error) {
            finish(fetchError(error));
          }
        });
        return undefined;
      };
      const headers: Record<string, string> = { 'Accept-Encoding': 'gzip, deflate, br' };
      if (checked.data.headers.userAgent) headers['User-Agent'] = checked.data.headers.userAgent;
      if (checked.data.headers.accept) headers.Accept = checked.data.headers.accept;
      if (checked.data.headers.authorization)
        headers.Authorization = checked.data.headers.authorization;
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers,
            agent,
            signal,
            maxHeaderSize: 16384,
          },
          resolve,
        );
        req.once('error', reject);
        req.end();
      });
      try {
        if (response.statusCode !== 200) {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400)
            throw new AppError(
              'SOURCE_REDIRECT_REJECTED',
              '来源返回重定向；请使用最终 HTTPS 地址。',
            );
          throw new AppError(
            'SOURCE_HTTP_FAILED',
            '来源返回 HTTP ' + (response.statusCode ?? '错误') + '，未接受新内容。',
          );
        }
        if (/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] ?? ''))
          throw new AppError('SOURCE_HTML_REJECTED', '来源返回 HTML 页面，未接受新内容。');
        if (Number(response.headers['content-length']) > MAX_BYTES)
          throw new AppError('SOURCE_TOO_LARGE', '来源正文超过 4 MiB。', 413);
        const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'deflate'
              ? createInflate()
              : encoding === 'br'
                ? createBrotliDecompress()
                : encoding === 'identity'
                  ? null
                  : undefined;
        if (decoder === undefined)
          throw new AppError('SOURCE_ENCODING_UNSUPPORTED', '来源使用了不支持的正文压缩方式。');
        const chunks: Buffer[] = [];
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        });
        const stages = decoder
          ? [response, byteLimit(), decoder, byteLimit(), sink]
          : [response, byteLimit(), sink];
        await pipeline(stages, { signal });
        signal.throwIfAborted();
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          throw new AppError('SOURCE_ENCODING_INVALID', '来源正文必须是有效的 UTF-8 文本。');
        }
        if (!text.trim()) throw new AppError('SOURCE_EMPTY', '来源正文为空，未接受新内容。');
        if (/^\s*</.test(text))
          throw new AppError('SOURCE_HTML_REJECTED', '来源返回网页或标记内容，未接受新内容。');
        return text;
      } finally {
        response.destroy();
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw fetchError(error);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
      signal.removeEventListener('abort', destroy);
      pendingSocket?.destroy();
      agent?.destroy();
    }
  }
}
