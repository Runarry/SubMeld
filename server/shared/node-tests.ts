import { z } from 'zod';
import { MAX_NODES, renderTargetSchema } from './contracts.js';

export const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204';
export const coreTargets = ['mihomo', 'singbox', 'xray'] as const;
export const coreLabels = { mihomo: 'Mihomo', singbox: 'sing-box', xray: 'Xray' };
const identity = { id: z.string().uuid(), revision: z.number().int().positive() };
export const testSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('node'), ...identity }),
  z.strictObject({
    kind: z.literal('source'),
    ...identity,
    snapshotHash: z.string(),
    nodeIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_NODES - 1),
  }),
  z.strictObject({
    kind: z.literal('chain'),
    ...identity,
    entryRevision: identity.revision,
    exitRevision: identity.revision,
  }),
]);
export type TestSubject = z.infer<typeof testSubjectSchema>;
export function subjectKey(subject: TestSubject) {
  return (
    subject.kind + ':' + subject.id + (subject.kind === 'source' ? ':' + subject.nodeIndex : '')
  );
}
export function sameSubject(a: TestSubject, b: TestSubject) {
  return (
    subjectKey(a) === subjectKey(b) &&
    a.revision === b.revision &&
    (a.kind !== 'source' || (b.kind === 'source' && a.snapshotHash === b.snapshotHash)) &&
    (a.kind !== 'chain' ||
      (b.kind === 'chain' &&
        a.entryRevision === b.entryRevision &&
        a.exitRevision === b.exitRevision))
  );
}
export const testSelectionSchema = z.strictObject({
  subjects: z
    .array(testSubjectSchema)
    .min(1)
    .max(MAX_NODES)
    .refine((values) => new Set(values.map(subjectKey)).size === values.length),
});
export const testSettingsSchema = z.strictObject({ url: z.string().min(1).max(2048) });
export const testStatuses = {
  passed: '通过',
  unsupported: '不支持',
  timeout: '超时',
  config_error: '配置错误',
  network_error: '连接失败',
  tls_error: 'TLS 错误',
  http_error: 'HTTP 状态异常',
  core_unavailable: '内核不可用',
  cancelled: '已取消',
  stale: '内容已变化',
} as const;
export const testResultSchema = z.strictObject({
  subject: testSubjectSchema,
  name: z.string(),
  core: renderTargetSchema,
  coreVersion: z.string().nullable(),
  url: z.string(),
  testedAt: z.string(),
  status: z.enum([
    'passed',
    'unsupported',
    'timeout',
    'config_error',
    'network_error',
    'tls_error',
    'http_error',
    'core_unavailable',
    'cancelled',
    'stale',
  ]),
  latencyMs: z.number().nonnegative().nullable(),
  httpStatus: z.number().int().nullable(),
  message: z.string(),
  stale: z.boolean(),
});
export type TestResult = z.infer<typeof testResultSchema>;
export const testResultsSchema = z.strictObject({ results: z.array(testResultSchema) });
export const testBatchSchema = z.strictObject({
  id: z.string().uuid(),
  state: z.enum(['running', 'completed', 'cancelled', 'failed']),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  total: z.number().int(),
  completed: z.number().int(),
  current: z.strictObject({ name: z.string(), core: renderTargetSchema }).nullable(),
  results: z.array(testResultSchema),
  page: z.number().int(),
});
export type TestBatch = z.infer<typeof testBatchSchema>;
export const currentTestSchema = z.strictObject({ batch: testBatchSchema.nullable() });
export const kernelStatusSchema = z.strictObject({
  target: renderTargetSchema,
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  checkedAt: z.string().nullable(),
  state: z.enum(['idle', 'checking', 'updating']),
  error: z.string().nullable(),
});
export type KernelStatus = z.infer<typeof kernelStatusSchema>;
export const kernelsSchema = z.strictObject({ kernels: z.array(kernelStatusSchema) });
