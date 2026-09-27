import { z } from 'zod';
import { AppError } from './errors.js';
import { MAX_BYTES } from './shared/contracts.js';

export const upstreamRecordSchema = z.object({ name: z.string().min(1) }).catchall(z.unknown());
export type UpstreamRecord = z.infer<typeof upstreamRecordSchema>;
export const upstreamIdentitySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['node', 'source']),
});
export const identityKey = '_submeld';

/** Only this client knows the upstream HTTP envelope. No upstream errors reach the browser. */
export class SubStoreClient {
  readonly origin: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(url = process.env.SUB_STORE_URL ?? 'http://127.0.0.1:3001') {
    const parsed = new URL(url);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('SUB_STORE_URL 必须是上游服务的 HTTP(S) 地址。');
    this.origin = url.replace(/\/$/, '');
  }
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation);
    this.tail = task.catch(() => {});
    return task;
  }
  async request(path: string, init: RequestInit = {}, limit = MAX_BYTES * 8): Promise<Response> {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    try {
      const response = await fetch(this.origin + path, { ...init, signal, redirect: 'manual' });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new AppError('UPSTREAM_LIMIT', '上游响应超过允许大小。', 413);
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(
        [204, 205, 304].includes(response.status) || init.method === 'HEAD'
          ? null
          : Buffer.concat(chunks),
        { status: response.status, headers },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SUB_STORE_UNAVAILABLE', '无法连接 Sub-Store，请检查上游服务。', 503);
    }
  }
  async api(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(path, {
      method,
      signal,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = z
      .object({ status: z.string(), data: z.unknown().optional() })
      .safeParse(await response.json().catch(() => null));
    if (!response.ok || !envelope.success || envelope.data.status !== 'success')
      throw new AppError(
        'SUB_STORE_FAILED',
        'Sub-Store 未完成请求，请在上游界面检查设置。',
        response.status === 404 ? 404 : 502,
      );
    return envelope.data.data;
  }
  async records(type: 'sub' | 'collection') {
    return z
      .array(upstreamRecordSchema)
      .parse(await this.api(type === 'sub' ? '/api/subs' : '/api/collections'));
  }
  async convert(
    data: string,
    client: string,
    internal = false,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = z
      .object({ par_res: z.unknown() })
      .parse(
        await this.api(
          '/api/proxy/parse',
          { data, client, ...(internal ? { type: 'internal' } : {}) },
          'POST',
          signal,
        ),
      );
    return result.par_res;
  }
}
