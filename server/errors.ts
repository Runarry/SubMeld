import type { Diagnostic } from './shared/contracts.js';
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 403 | 413 | 415 | 422 | 429 | 503 = 422,
    public diagnostics?: Diagnostic[],
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
    };
  return { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求。' };
}
