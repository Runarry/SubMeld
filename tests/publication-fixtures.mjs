import { AppError } from '../dist/server/errors.js';
import { parseInput, produceInput } from '../dist/server/converter/engine.js';
import { renderInput } from '../dist/server/converter/render.js';
export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export class ControlledConverter {
  ready = Promise.resolve();
  listeners = new Set();
  busy = false;
  calls = [];
  next;
  transform;
  isAvailable() {
    return !this.busy;
  }
  onAvailable(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  hold(error) {
    const entered = deferred(),
      released = deferred();
    this.next = { entered, released, error };
    return { entered: entered.promise, release: () => released.resolve() };
  }
  async run(request, signal) {
    if (this.busy) throw new AppError('CONVERTER_BUSY', '繁忙', 503);
    this.busy = true;
    this.calls.push(structuredClone(request));
    const gate = this.next;
    this.next = undefined;
    try {
      if (gate) {
        gate.entered.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => {
            cleanup();
            reject(new AppError('REQUEST_CANCELLED', '已取消'));
          };
          const cleanup = () => signal?.removeEventListener('abort', abort);
          signal?.addEventListener('abort', abort, { once: true });
          gate.released.promise.then(() => {
            cleanup();
            resolve();
          });
          if (signal?.aborted) abort();
        });
        if (gate.error) throw gate.error;
      }
      if (this.transform) {
        const value = this.transform(request);
        if (value !== undefined) return value;
      }
      return request.kind === 'parse'
        ? parseInput(request.input)
        : request.kind === 'produce'
          ? produceInput(request.input)
          : renderInput(request.input);
    } finally {
      this.busy = false;
      queueMicrotask(() => {
        for (const fn of this.listeners) fn();
      });
    }
  }
}
