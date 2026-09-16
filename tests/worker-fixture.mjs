import { parentPort } from 'node:worker_threads';
import { parseInput, produceInput } from '../dist/server/converter/engine.js';
parentPort.on('message', (message) => {
  if (message.input.text === 'BLOCK') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  try {
    parentPort.postMessage({
      id: message.id,
      ok: true,
      result: message.kind === 'parse' ? parseInput(message.input) : produceInput(message.input),
    });
  } catch {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      status: 422,
      error: { code: 'CONVERSION_FAILED', message: '测试转换失败。' },
    });
  }
});
parentPort.postMessage({ type: 'ready' });
