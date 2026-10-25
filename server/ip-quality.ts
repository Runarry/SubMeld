import { AppError } from './errors.js';
import {
  IpQualityDnsbls,
  IpQualitySlots,
  ipQualityDnsblLists,
  type IpQualityDnsLookup,
} from './ip-quality-dnsbl.js';
import {
  field,
  IpQualityFailure,
  IP_QUALITY_UA,
  IPREGISTRY_DEFAULT_KEY,
  parseIpQualityData,
  providerUrl,
} from './ip-quality-providers.js';
import {
  IP_QUALITY_VERSION,
  ipQualityAddress,
  ipQualityProviders,
  ipQualityQuerySchema,
  type IpQualityDnsbl,
  type IpQualityProvider,
  type IpQualityReport,
  type IpQualitySource,
} from './shared/ip-quality.js';

type Options = {
  fetch?: typeof globalThis.fetch;
  resolve?: IpQualityDnsLookup;
  now?: () => number;
  sourceTimeoutMs?: number;
  queryTimeoutMs?: number;
  dnsTimeoutMs?: number;
};
type Cached = { value: IpQualitySource | IpQualityDnsbl; expires: number };
const CACHE_MS = 600000;

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new IpQualityFailure('invalid', '来源响应过大。');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class IpQualityService {
  private fetch: typeof globalThis.fetch;
  private now: () => number;
  private httpSlots = new IpQualitySlots();
  private dns: IpQualityDnsbls;
  private cache = new Map<string, Map<string, Cached>>();
  private cooldown = new Map<string, number>();
  private registryKey: { value: string; expires: number } | undefined;
  constructor(private options: Options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.dns = new IpQualityDnsbls(options.resolve, this.now, options.dnsTimeoutMs);
  }
  private cached(ip: string, key: string, refresh: boolean): Cached['value'] | undefined {
    if (refresh) return undefined;
    const bucket = this.cache.get(ip);
    const item = bucket?.get(IP_QUALITY_VERSION + ':' + key);
    if (!item || item.expires <= this.now()) {
      bucket?.delete(IP_QUALITY_VERSION + ':' + key);
      if (bucket?.size === 0) this.cache.delete(ip);
      return undefined;
    }
    this.cache.delete(ip);
    this.cache.set(ip, bucket!);
    return structuredClone({ ...item.value, cached: true });
  }
  private save(ip: string, key: string, value: Cached['value']) {
    if (!['success', 'listed', 'not_listed'].includes(value.status)) return;
    const bucket = this.cache.get(ip) ?? new Map<string, Cached>();
    const cacheKey = IP_QUALITY_VERSION + ':' + key;
    const previous = bucket.get(cacheKey);
    if (previous && previous.value.checkedAt > value.checkedAt) return;
    bucket.set(cacheKey, { value: structuredClone(value), expires: this.now() + CACHE_MS });
    this.cache.delete(ip);
    this.cache.set(ip, bucket);
    while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
  }
  private async request(
    url: string,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<string> {
    const origin = new URL(url).origin;
    const until = this.cooldown.get(origin);
    if (until && until > this.now())
      throw new IpQualityFailure(
        'rate_limited',
        '来源限流，请在提示时间后重试。',
        429,
        new Date(until).toISOString(),
      );
    const response = await this.fetch(url, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': IP_QUALITY_UA, Accept: 'application/json', ...headers },
    });
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        const raw = response.headers.get('retry-after');
        const delay =
          raw && /^\d+$/.test(raw.trim())
            ? Number(raw) * 1000
            : raw
              ? Date.parse(raw) - this.now()
              : NaN;
        const retry =
          this.now() +
          (Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 86400000 * 365) : 60000);
        this.cooldown.set(origin, retry);
        throw new IpQualityFailure(
          'rate_limited',
          '来源限流，请在提示时间后重试。',
          429,
          new Date(retry).toISOString(),
        );
      }
      throw new IpQualityFailure(
        'unavailable',
        '来源返回 HTTP ' + response.status + '，未取得有效数据。',
        response.status,
      );
    }
    return readText(response, signal);
  }
  private async getRegistryKey(signal: AbortSignal): Promise<string> {
    if (this.registryKey && this.registryKey.expires > this.now()) return this.registryKey.value;
    let value = IPREGISTRY_DEFAULT_KEY;
    try {
      const html = await this.request('https://ipregistry.co', signal, { Accept: 'text/html' });
      value = html.match(/apiKey="([a-zA-Z0-9]+)"/)?.[1] ?? value;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof IpQualityFailure && error.status === 'rate_limited') throw error;
      // The pinned script uses its embedded key when the homepage has no readable key.
    }
    signal.throwIfAborted();
    this.registryKey = { value, expires: this.now() + 3600000 };
    return value;
  }
  private async source(
    id: IpQualityProvider,
    ip: string,
    signal: AbortSignal,
  ): Promise<IpQualitySource> {
    const base = {
      id,
      name: ipQualityProviders.find((item) => item.id === id)!.name,
      checkedAt: new Date(this.now()).toISOString(),
      cached: false,
    };
    if (id === 'dbip')
      return {
        ...base,
        status: 'unsupported',
        message: '网页 Key 仅允许查询请求来源，不支持指定 IP。',
      };
    try {
      return await this.httpSlots.run(signal, async () => {
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(new DOMException('Source timeout', 'TimeoutError')),
          this.options.sourceTimeoutMs ?? 10000,
        );
        const combined = AbortSignal.any([signal, timeout.signal]);
        try {
          let url: string;
          const headers: Record<string, string> = {};
          if (id === 'ipregistry') {
            const key = await this.getRegistryKey(combined);
            url =
              'https://api.ipregistry.co/' +
              encodeURIComponent(ip) +
              '?hostname=true&key=' +
              encodeURIComponent(key);
            headers.Origin = 'https://ipregistry.co';
            headers.Referer = 'https://ipregistry.co/';
          } else url = providerUrl(id, ip);
          const body = await this.request(url, combined, headers);
          let value: unknown;
          try {
            value = JSON.parse(body);
          } catch {
            throw new IpQualityFailure('invalid', '来源未返回有效 JSON，可能受到访问限制。');
          }
          if (id === 'ipregistry') {
            const code = field(value, 'code') ?? field(value, 'error.code');
            if (typeof code === 'string' && /KEY|AUTH|FORBIDDEN|RESTRICTED/.test(code))
              throw new IpQualityFailure('unavailable', '来源认证失效，未取得有效数据。', 401);
          }
          const data = parseIpQualityData(id, value, ip);
          combined.throwIfAborted();
          return { ...base, status: 'success', message: '已取得资料；缺失字段显示为未知。', data };
        } catch (error) {
          if (
            id === 'ipregistry' &&
            error instanceof IpQualityFailure &&
            [401, 403].includes(error.httpStatus ?? 0)
          )
            this.registryKey = undefined;
          if (combined.aborted) throw new IpQualityFailure('timeout', '来源查询超时或已中止。');
          throw error;
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      const failure = signal.aborted
        ? new IpQualityFailure('timeout', '整次查询已达到时限。')
        : error instanceof IpQualityFailure
          ? error
          : new IpQualityFailure('unavailable', '无法连接来源，未取得有效数据。');
      return {
        ...base,
        status: failure.status,
        message: failure.message,
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      };
    }
  }
  async query(
    input: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<IpQualityReport> {
    const parsed = ipQualityQuerySchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'IP_QUALITY_INPUT_INVALID',
        '请输入单个有效的公网 IPv4 或 IPv6，不包含端口、网段或网址。',
        400,
      );
    signal.throwIfAborted();
    const { ip, family } = ipQualityAddress(parsed.data.ip)!;
    const startedAt = new Date(this.now()).toISOString();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('Query timeout', 'TimeoutError')),
      this.options.queryTimeoutMs ?? 35000,
    );
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      const [sources, dnsbl] = await Promise.all([
        Promise.all(
          ipQualityProviders.map(async ({ id }) => {
            const cached = this.cached(ip, 'source:' + id, parsed.data.refresh);
            if (cached && 'name' in cached && !('zone' in cached)) return cached;
            const result = await this.source(id, ip, combined);
            if (!combined.aborted) this.save(ip, 'source:' + id, result);
            return result;
          }),
        ),
        Promise.all(
          ipQualityDnsblLists.map(async (list) => {
            const cached = this.cached(ip, 'dnsbl:' + list.id, parsed.data.refresh);
            if (cached && 'zone' in cached) return cached;
            const result = await this.dns.query(list, ip, family, combined);
            if (!combined.aborted) this.save(ip, 'dnsbl:' + list.id, result);
            return result;
          }),
        ),
      ]);
      signal.throwIfAborted();
      const applicable = [...sources, ...dnsbl].filter((item) => item.status !== 'unsupported');
      const completed = applicable.filter((item) =>
        ['success', 'listed', 'not_listed'].includes(item.status),
      ).length;
      return {
        ip,
        family,
        version: IP_QUALITY_VERSION,
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        status: completed === applicable.length ? 'complete' : completed ? 'partial' : 'failed',
        sources,
        dnsbl,
        blacklist: {
          queried: dnsbl.filter((item) => item.status !== 'unsupported').length,
          valid: dnsbl.filter((item) => ['listed', 'not_listed'].includes(item.status)).length,
          listed: dnsbl.filter((item) => item.status === 'listed').length,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
