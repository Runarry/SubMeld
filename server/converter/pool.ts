import { AppError } from '../errors.js';
import { SubStoreClient } from '../sub-store.js';
import type { ConversionRequest } from '../shared/contracts.js';
import { parseInput, produceInput } from './engine.js';
import { renderInput } from './render.js';

/** One bounded enhancement operation; conversion itself runs in Sub-Store. */
export class Converter {
  readonly ready = Promise.resolve();
  private requests = new Set<AbortController>();
  private tail = Promise.resolve();
  private closed = false;
  private listeners = new Set<() => void>();
  constructor(readonly client = new SubStoreClient()) {}
  isAvailable() {
    return !this.closed && this.requests.size === 0;
  }
  onAvailable(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async run(request: ConversionRequest, signal?: AbortSignal) {
    if (this.closed) throw new AppError('CONVERTER_CLOSED', '增强转换已停止。', 503);
    const controller = new AbortController();
    this.requests.add(controller);
    const previous = this.tail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => slot);
    const abort = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      abort.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(abort.reason);
        abort.addEventListener('abort', cancel, { once: true });
        void previous.then(() => {
          abort.removeEventListener('abort', cancel);
          resolve();
        });
      });
      abort.throwIfAborted();
      if (request.kind === 'parse') return await parseInput(request.input, this.client, abort);
      if (request.kind === 'produce') return await produceInput(request.input, this.client, abort);
      return await renderInput(request.input, this.client, abort);
    } finally {
      this.requests.delete(controller);
      release();
      if (this.isAvailable())
        queueMicrotask(() => {
          for (const listener of this.listeners) listener();
        });
    }
  }
  async close() {
    this.closed = true;
    for (const request of this.requests) request.abort();
    this.listeners.clear();
    await this.tail;
  }
}
