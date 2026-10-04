import { AppError } from '../errors.js';
import { SubStoreClient } from '../sub-store.js';
import type { ConversionRequest } from '../shared/contracts.js';
import { renderInput } from './render.js';
import type { Hy2CertificateResolver } from '../shared/hy2-certificates.js';

/** One bounded enhancement operation; conversion itself runs in Sub-Store. */
export class Converter {
  private requests = new Set<AbortController>();
  private tail = Promise.resolve();
  private closed = false;
  constructor(
    readonly client = new SubStoreClient(),
    readonly resolveCertificate?: Hy2CertificateResolver,
  ) {}
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
      return await renderInput(
        request.input,
        this.client,
        abort,
        undefined,
        this.resolveCertificate,
      );
    } finally {
      this.requests.delete(controller);
      release();
    }
  }
  async close() {
    this.closed = true;
    for (const request of this.requests) request.abort();
    await this.tail;
  }
}
