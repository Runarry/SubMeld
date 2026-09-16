import { parentPort } from 'node:worker_threads';
import { z } from 'zod';
import {
  parseRequestSchema,
  produceRequestSchema,
  renderRequestSchema,
} from '../shared/contracts.js';
import { AppError, publicError } from '../errors.js';
import { renderInput } from './render.js';
import { parseInput, produceInput } from './engine.js';
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.number().int(), kind: z.literal('parse'), input: parseRequestSchema }),
  z.object({ id: z.number().int(), kind: z.literal('produce'), input: produceRequestSchema }),
  z.object({ id: z.number().int(), kind: z.literal('render'), input: renderRequestSchema }),
]);
if (!parentPort) throw new Error('Converter must run in a Worker');
const port = parentPort;
port.on('message', (input: unknown) => {
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) {
    port.postMessage({ type: 'invalid' });
    return;
  }
  const message = parsed.data;
  try {
    const result =
      message.kind === 'parse'
        ? parseInput(message.input)
        : message.kind === 'render'
          ? renderInput(message.input)
          : produceInput(message.input);
    port.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      status: error instanceof AppError ? error.status : 422,
      error:
        error instanceof AppError
          ? publicError(error)
          : { code: 'CONVERSION_FAILED', message: '节点转换失败，请检查输入格式与参数。' },
    });
  }
});
port.postMessage({ type: 'ready' });
