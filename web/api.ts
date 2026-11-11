import { errorSchema, type Diagnostic } from '../server/shared/contracts';
import { deleteNodesResultSchema, type DeleteNodesResult } from '../server/shared/resources';
import {
  subscriptionValidationSchema,
  type SubscriptionValidation,
} from '../server/shared/subscriptions';
export class ApiError extends Error {
  constructor(
    message: string,
    public diagnostics: Diagnostic[] = [],
    public status = 0,
    public code = '',
    public nodeMutation?: DeleteNodesResult,
    public subscriptionValidation?: SubscriptionValidation,
  ) {
    super(message);
  }
}
export async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    headers:
      body === undefined ? {} : { 'Content-Type': 'application/json', 'X-SubMeld-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = errorSchema.safeParse(value);
    const mutation = deleteNodesResultSchema.safeParse(
      value && typeof value === 'object' && 'nodeMutation' in value
        ? value.nodeMutation
        : undefined,
    );
    const validation = subscriptionValidationSchema.safeParse(
      value && typeof value === 'object' && 'validation' in value ? value.validation : undefined,
    );
    throw new ApiError(
      error.success ? error.data.message : '服务响应无效。',
      error.success ? error.data.diagnostics : [],
      response.status,
      error.success ? error.data.code : '',
      mutation.success ? mutation.data : undefined,
      validation.success ? validation.data : undefined,
    );
  }
  return value;
}
