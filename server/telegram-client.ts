import { Blob } from 'node:buffer';
import { Agent, ProxyAgent, fetch, FormData } from 'undici';
import type { Dispatcher, RequestInit, Response } from 'undici';
import { z } from 'zod';
import { AppError } from './errors.js';
import { MAX_BYTES } from './shared/contracts.js';

const envelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number().int().min(100).max(599),
    description: z.string(),
    parameters: z
      .object({
        retry_after: z
          .number()
          .int()
          .nonnegative()
          .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000))
          .optional(),
      })
      .optional(),
  }),
]);
const fileSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (path) =>
        !/[\\?#]/.test(path) &&
        !Array.from(path).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) &&
        path.split('/').every((part) => part && part !== '.' && part !== '..'),
    ),
  file_size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

function apiFault(code: number) {
  switch (code) {
    case 401:
      return {
        code: 'TELEGRAM_UNAUTHORIZED',
        message: 'Telegram Bot Token 无效或已失效。',
        status: 401 as const,
      };
    case 403:
      return {
        code: 'TELEGRAM_FORBIDDEN',
        message: 'Telegram 拒绝机器人访问目标聊天。',
        status: 403 as const,
      };
    case 409:
      return {
        code: 'TELEGRAM_CONFLICT',
        message: 'Telegram 轮询冲突，请检查是否有其他实例使用同一机器人。',
        status: 409 as const,
      };
    case 429:
      return {
        code: 'TELEGRAM_RATE_LIMITED',
        message: 'Telegram 请求过于频繁，请稍后重试。',
        status: 429 as const,
      };
    default:
      return {
        code: 'TELEGRAM_REJECTED',
        message: 'Telegram 未完成请求，请检查机器人和聊天设置。',
        status: 502 as const,
      };
  }
}

export class TelegramApiError extends AppError {
  constructor(
    public readonly telegramCode: number,
    public readonly retryAfterMs: number | null = null,
    public readonly notModified = false,
  ) {
    const fault = notModified
      ? {
          code: 'TELEGRAM_NOT_MODIFIED',
          message: 'Telegram 消息内容没有变化。',
          status: 502 as const,
        }
      : apiFault(telegramCode);
    super(fault.code, fault.message, fault.status);
    this.name = 'TelegramApiError';
  }
}

function protocolError() {
  return new AppError('TELEGRAM_PROTOCOL', 'Telegram 返回了无法验证的响应。', 502);
}

function fileLimitError() {
  return new AppError('TELEGRAM_FILE_LIMIT', 'Telegram 文件超过 4 MiB。', 413);
}

async function bytes(response: Response, limitError: () => AppError): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw limitError();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk: unknown = value;
        if (!(chunk instanceof Uint8Array)) throw protocolError();
        size += chunk.byteLength;
        if (size > MAX_BYTES) throw limitError();
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  return Buffer.concat(chunks, size);
}

/** A dedicated dispatcher keeps Telegram proxy settings out of all other clients. */
export class TelegramClient {
  private readonly origin: string;
  private readonly dispatcher: Dispatcher;
  private readonly stopped = new AbortController();
  private closing?: Promise<void>;

  constructor(
    private readonly token: string,
    proxyUrl?: string | null,
    options: { apiOrigin?: string } = {},
  ) {
    try {
      if (!/^[A-Za-z0-9:_-]{1,512}$/.test(token)) throw new Error();
      const origin = new URL(options.apiOrigin ?? 'https://api.telegram.org');
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        (options.apiOrigin !== undefined &&
          !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
      )
        throw new Error();
      this.origin = origin.origin;
      if (proxyUrl) {
        const proxy = new URL(proxyUrl);
        if (
          !['http:', 'https:'].includes(proxy.protocol) ||
          proxy.pathname !== '/' ||
          proxy.search ||
          proxy.hash
        )
          throw new Error();
        this.dispatcher = new ProxyAgent({ uri: proxy.href, connectTimeout: 10_000 });
      } else this.dispatcher = new Agent({ connectTimeout: 10_000 });
    } catch {
      throw new AppError('TELEGRAM_CONFIG', 'Telegram Token、代理或接口地址无效。');
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (this.stopped.signal.aborted)
      throw new AppError('TELEGRAM_CLOSED', 'Telegram 客户端已关闭。', 503);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([this.stopped.signal, timeout, ...(signal ? [signal] : [])]);
    try {
      const response = await fetch(this.origin + path, {
        ...init,
        signal: combined,
        dispatcher: this.dispatcher,
        redirect: 'manual',
      });
      return await read(response);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (
        signal?.aborted ||
        this.stopped.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      )
        throw new AppError('TELEGRAM_CANCELLED', 'Telegram 请求已取消。');
      if (timeout.aborted || (error instanceof Error && error.name === 'TimeoutError'))
        throw new AppError('TELEGRAM_TIMEOUT', 'Telegram 请求超时。', 504);
      throw new AppError('TELEGRAM_UNAVAILABLE', '无法连接 Telegram，请检查网络或代理。', 503);
    }
  }

  private async api(method: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(method))
      throw new AppError('TELEGRAM_CONFIG', 'Telegram 请求方法无效。');
    return this.request(
      '/bot' + this.token + '/' + method,
      { ...init, method: 'POST' },
      signal,
      method === 'getUpdates' ? 40_000 : 20_000,
      async (response) => {
        const payload = await bytes(response, protocolError);
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
        } catch {
          throw protocolError();
        }
        const envelope = envelopeSchema.safeParse(value);
        if (!envelope.success) throw protocolError();
        if (!envelope.data.ok)
          throw new TelegramApiError(
            envelope.data.error_code,
            envelope.data.parameters?.retry_after === undefined
              ? null
              : envelope.data.parameters.retry_after * 1000,
            envelope.data.error_code === 400 &&
              method.startsWith('editMessage') &&
              /^Bad Request: message is not modified(?::|$)/i.test(envelope.data.description),
          );
        if (!response.ok || !Object.hasOwn(envelope.data, 'result')) throw protocolError();
        return envelope.data.result;
      },
    );
  }

  async call(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let serialized: string | undefined;
    try {
      serialized = body === undefined ? undefined : JSON.stringify(body);
    } catch {
      throw new AppError('TELEGRAM_CONFIG', 'Telegram 请求内容无法发送。');
    }
    return this.api(
      method,
      { headers: { 'content-type': 'application/json' }, body: serialized },
      signal,
    );
  }

  async upload(
    method: 'sendPhoto' | 'sendDocument',
    body: Record<string, unknown>,
    file: { name: string; data: Uint8Array; contentType: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const form = new FormData();
    try {
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined)
          form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      form.set(
        method === 'sendPhoto' ? 'photo' : 'document',
        new Blob([file.data], { type: file.contentType }),
        file.name,
      );
    } catch {
      throw new AppError('TELEGRAM_CONFIG', 'Telegram 文件内容无法发送。');
    }
    return this.api(method, { body: form }, signal);
  }

  async download(fileId: string, signal?: AbortSignal): Promise<string> {
    const file = fileSchema.safeParse(await this.call('getFile', { file_id: fileId }, signal));
    if (!file.success) throw protocolError();
    if (file.data.file_size !== undefined && file.data.file_size > MAX_BYTES)
      throw fileLimitError();
    let path: string;
    try {
      path = file.data.file_path.split('/').map(encodeURIComponent).join('/');
    } catch {
      throw protocolError();
    }
    return this.request(
      '/file/bot' + this.token + '/' + path,
      {},
      signal,
      30_000,
      async (response) => {
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new AppError('TELEGRAM_REJECTED', 'Telegram 未能提供文件。', 502);
        }
        const payload = await bytes(response, fileLimitError);
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(payload);
        } catch {
          throw new AppError('TELEGRAM_FILE_ENCODING', 'Telegram 文件必须使用 UTF-8 编码。', 415);
        }
      },
    );
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stopped.abort();
      this.closing = this.dispatcher.close().catch(() => {
        throw new AppError('TELEGRAM_UNAVAILABLE', 'Telegram 连接关闭失败。', 503);
      });
    }
    return this.closing;
  }
}
