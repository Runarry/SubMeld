import type { Diagnostic } from './shared/contracts.js';
import type { DeleteNodesResult } from './shared/resources.js';
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 503 | 504 = 422,
    public diagnostics?: Diagnostic[],
    public nodeMutation?: DeleteNodesResult,
  ) {
    super(message);
  }
}
export function publicError(error: unknown) {
  if (error instanceof AppError)
    return {
      code: error.code,
      message: error.message,
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      ...(error.nodeMutation ? { nodeMutation: error.nodeMutation } : {}),
    };
  return { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求。' };
}
