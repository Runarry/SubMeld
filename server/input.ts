import { AppError } from './errors.js';
import { MAX_DEPTH } from './shared/contracts.js';
export function guardStructure(value: unknown) {
  const stack: [unknown, number][] = [[value, 0]];
  let visited = 0;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    const [item, depth] = entry;
    if (depth > MAX_DEPTH || ++visited > 200000)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '输入结构超过限制。', 413);
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
    }
  }
}
export async function readJson(request: Request, limit: number): Promise<unknown> {
  if (
    request.headers.get('content-encoding') &&
    request.headers.get('content-encoding') !== 'identity'
  )
    throw new AppError('ENCODING_UNSUPPORTED', '请发送未压缩的 JSON 请求。', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('INVALID_JSON', '需要 JSON 请求正文。', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, 10000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new AppError('REQUEST_TIMEOUT', '读取请求超时。', 400);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new AppError('INPUT_LIMIT_EXCEEDED', '请求正文超过限制。', 413);
      chunks.push(value);
    }
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new AppError('INVALID_JSON', 'JSON 格式或文本编码无效。', 400);
    }
    guardStructure(result);
    return result;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
