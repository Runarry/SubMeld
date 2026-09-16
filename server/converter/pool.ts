import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { AppError } from '../errors.js';
import {
  errorSchema,
  parseResultSchema,
  produceResultSchema,
  renderResultSchema,
  type RenderResult,
  type WorkerRequest,
  type ParseResult,
  type ProduceResult,
} from '../shared/contracts.js';
const replySchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.number(),
    ok: z.literal(false),
    status: z.union([z.literal(400), z.literal(413), z.literal(422)]),
    error: errorSchema,
  }),
]);
type Result = ParseResult | ProduceResult | RenderResult;
export class Converter {
  private worker: Worker | undefined;
  private running:
    | {
        id: number;
        kind: WorkerRequest['kind'];
        resolve: (value: Result) => void;
        reject: (error: Error) => void;
        cleanup: () => void;
      }
    | undefined;
  private counter = 0;
  private available = false;
  private closed = false;
  private idleListeners = new Set<() => void>();
  isAvailable() {
    return this.available && !!this.worker && !this.running && !this.closed;
  }
  onAvailable(listener: () => void) {
    this.idleListeners.add(listener);
    return () => {
      this.idleListeners.delete(listener);
    };
  }
  private notifyAvailable() {
    queueMicrotask(() => {
      if (this.isAvailable()) for (const listener of this.idleListeners) listener();
    });
  }
  ready: Promise<void>;
  constructor(
    private workerUrl = new URL(
      import.meta.url.endsWith('.ts') ? '../../dist/server/converter/worker.js' : './worker.js',
      import.meta.url,
    ),
    private timeoutMs = 5000,
  ) {
    this.ready = this.spawn();
  }
  private spawn(): Promise<void> {
    this.available = false;
    const worker = new Worker(this.workerUrl, {
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    // Upstream stdout/stderr never reach application logs.
    worker.stdout.resume();
    worker.stderr.resume();
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let started = false;
      const stopStartup = (message: string) => {
        clearTimeout(startup);
        if (this.worker === worker) {
          this.worker = undefined;
          this.available = false;
        }
        reject(new Error(message));
        void worker.terminate();
      };
      const startup = setTimeout(() => stopStartup('Converter startup timeout'), 10000);
      worker.on('message', (message: unknown) => {
        if (this.worker !== worker || this.closed) return;
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'ready'
        ) {
          clearTimeout(startup);
          started = true;
          this.available = true;
          resolve();
          this.notifyAvailable();
          return;
        }
        const response = replySchema.safeParse(message);
        const current = this.running;
        if (!response.success || !current || response.data.id !== current.id) {
          if (!started) {
            stopStartup('Invalid converter startup response');
            return;
          }
          void this.recover(worker);
          return;
        }
        this.running = undefined;
        current.cleanup();
        if (response.data.ok) {
          const result = (
            current.kind === 'parse'
              ? parseResultSchema
              : current.kind === 'render'
                ? renderResultSchema
                : produceResultSchema
          ).safeParse(response.data.result);
          if (result.success) current.resolve(result.data);
          else {
            current.reject(new AppError('CONVERTER_RESPONSE_INVALID', '转换结果无效。'));
            void this.recover(worker);
          }
        } else
          current.reject(
            new AppError(
              response.data.error.code,
              response.data.error.message,
              response.data.status,
              response.data.error.diagnostics,
            ),
          );
        this.notifyAvailable();
      });
      worker.on('error', () => {
        if (!started) stopStartup('Converter failed to start');
        else void this.recover(worker);
      });
      worker.on('exit', () => {
        clearTimeout(startup);
        if (!started) stopStartup('Converter exited');
        else if (this.worker === worker && !this.closed) void this.recover(worker);
      });
    });
  }
  private async recover(worker: Worker) {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.available = false;
    const current = this.running;
    this.running = undefined;
    current?.cleanup();
    current?.reject(new AppError('CONVERTER_UNAVAILABLE', '转换进程已重建，请重试。', 503));
    this.ready = (async () => {
      await worker.terminate();
      if (!this.closed) await this.spawn();
    })();
    void this.ready.catch(() => {});
  }
  run(request: WorkerRequest, signal?: AbortSignal): Promise<Result> {
    const worker = this.worker;
    if (!worker || !this.available || this.running || this.closed)
      return Promise.reject(new AppError('CONVERTER_BUSY', '转换器繁忙，请稍后重试。', 503));
    if (signal?.aborted) return Promise.reject(new AppError('REQUEST_CANCELLED', '转换已取消。'));
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const stop = (code: string, message: string) => {
        if (this.running?.id !== id) return;
        const current = this.running;
        this.running = undefined;
        current.cleanup();
        reject(new AppError(code, message));
        void this.recover(worker);
      };
      const abort = () => stop('REQUEST_CANCELLED', '转换已取消。');
      const timer = setTimeout(
        () => stop('WORKER_TIMEOUT', '转换超过 5 秒，转换进程已终止并重建。'),
        this.timeoutMs,
      );
      this.running = {
        id,
        kind: request.kind,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ id, ...request });
    });
  }
  async close() {
    this.closed = true;
    this.available = false;
    this.running?.cleanup();
    this.running?.reject(new AppError('CONVERTER_UNAVAILABLE', '应用正在停止。', 503));
    this.running = undefined;
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}
