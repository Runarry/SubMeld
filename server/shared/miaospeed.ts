import { z } from 'zod';
import { testSubjectSchema, DEFAULT_PROBE_URL, coreLabels } from './node-tests.js';
import { renderTargetSchema, MAX_BYTES, MAX_NODES } from './contracts.js';

export const metricDefinitions = [
  ['TEST_PING_RTT', '平均 RTT', 'ms'],
  ['TEST_PING_CONN', '平均 HTTP 时延', 'ms'],
  ['TEST_PING_MAX_RTT', '最大 RTT', 'ms'],
  ['TEST_PING_MAX_CONN', '最大 HTTP 时延', 'ms'],
  ['TEST_PING_SD_RTT', 'RTT 抖动', 'ms'],
  ['TEST_PING_SD_CONN', 'HTTP 抖动', 'ms'],
  ['TEST_PING_PACKET_LOSS', '丢包率', '%'],
  ['TEST_PING_TOTAL_RTT', 'RTT 采样', 'ms'],
  ['TEST_PING_TOTAL_CONN', 'HTTP 采样', 'ms'],
  ['TEST_HTTP_CODE', 'HTTP 状态', ''],
  ['SPEED_AVERAGE', '平均下行', 'B/s'],
  ['SPEED_MAX', '峰值下行', 'B/s'],
  ['SPEED_PER_SECOND', '逐秒下行', 'B/s'],
  ['USPEED_AVERAGE', '平均上行', 'B/s'],
  ['USPEED_MAX', '峰值上行', 'B/s'],
  ['USPEED_PER_SECOND', '逐秒上行', 'B/s'],
  ['UDP_TYPE', 'UDP / NAT', ''],
  ['GEOIP_INBOUND', '入口拓扑', ''],
  ['GEOIP_OUTBOUND', '出口拓扑', ''],
  ['TEST_HIJACK_DETECTION', '测速劫持检测', ''],
] as const;
export const metricIds = metricDefinitions.map(([id]) => id);
export const metricIdSchema = z.enum(metricIds);
export const speedSettingsSchema = z.strictObject({
  pingUrl: z.url().max(2048).default(DEFAULT_PROBE_URL),
  downloadUrl: z.string().min(1).max(2048).default('DYNAMIC:INTL'),
  uploadUrl: z.url().max(2048).default('https://speed.cloudflare.com/__up'),
  stunAddress: z.string().min(1).max(300).default('udp://stunserver2025.stunprotocol.org:3478'),
  downloadSeconds: z.number().int().min(1).max(30).default(3),
  // 4.7.6 uses duration / 2 seconds per upload request; one second always times out.
  uploadSeconds: z.number().int().min(2).max(30).default(3),
  downloadThreads: z.number().int().min(1).max(32).default(1),
  uploadThreads: z.number().int().min(1).max(32).default(1),
  pingCount: z.number().int().min(1).max(16).default(1),
  retries: z.number().int().min(1).max(10).default(3),
  requestTimeoutMs: z.number().int().min(10).max(10000).default(5000),
  timeoutSeconds: z.number().int().min(10).max(10000).default(120),
  nodeCore: z.enum(['native', ...renderTargetSchema.options]).default('native'),
  chainCore: renderTargetSchema.default('mihomo'),
});
export type SpeedSettings = z.infer<typeof speedSettingsSchema>;
export const speedCoreLabels = { native: 'miaospeed 内置 Mihomo', ...coreLabels };
export const temporarySubjectSchema = z.strictObject({
  kind: z.literal('temporary'),
  previewId: z.string().uuid(),
  nodeIndex: z
    .number()
    .int()
    .min(0)
    .max(MAX_NODES - 1),
});
export const speedSubjectSchema = z.union([testSubjectSchema, temporarySubjectSchema]);
export type SpeedSubject = z.infer<typeof speedSubjectSchema>;
export function executionCore(settings: SpeedSettings, subject: SpeedSubject) {
  return subject.kind === 'chain' ? settings.chainCore : settings.nodeCore;
}
export const speedRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).default('综合测试'),
    subjects: z.array(speedSubjectSchema).min(1).max(MAX_NODES),
    metrics: z
      .array(metricIdSchema)
      .max(metricIds.length)
      .refine((v) => new Set(v).size === v.length),
    scripts: z
      .array(
        z.strictObject({ id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
      )
      .max(200),
    settings: speedSettingsSchema,
  })
  .refine((v) => v.metrics.length + v.scripts.length > 0, '至少选择一个测试项。');
export const previewInputSchema = z.strictObject({
  kind: z.enum(['text', 'url', 'file']),
  name: z.string().max(120).default('临时节点'),
  content: z.string().max(MAX_BYTES).default(''),
  url: z.string().max(4096).default(''),
});
export const speedPreviewSchema = z.strictObject({
  id: z.string().uuid(),
  expiresAt: z.string(),
  nodes: z.array(
    z.strictObject({
      index: z.number().int(),
      name: z.string(),
      protocol: z.string(),
      error: z.string().nullable(),
    }),
  ),
});
export type SpeedPreview = z.infer<typeof speedPreviewSchema>;
export const scriptConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(''),
  enabled: z.boolean().default(true),
  content: z
    .string()
    .min(1)
    .max(512 * 1024),
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
  source: z.string().max(2048).default('自定义'),
  builtinId: z.string().max(100).optional(),
});
export const testScriptSchema = scriptConfigSchema.extend({
  id: z.string().uuid(),
  revision: z.string(),
  modified: z.boolean(),
});
export type TestScript = z.infer<typeof testScriptSchema>;
export const scriptsSchema = z.strictObject({ scripts: z.array(testScriptSchema) });
export const geoSchema = z.strictObject({
  ip: z.string(),
  country: z.string(),
  countryCode: z.string(),
  asn: z.number(),
  organization: z.string(),
  isp: z.string(),
});
export const measurementSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  status: z.enum(['measured', 'unknown', 'failed', 'unsupported', 'target_error']),
  value: z.union([z.string(), z.number()]).nullable(),
  samples: z.array(z.number()).default([]),
  geo: z.array(geoSchema).default([]),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  message: z.string().default(''),
});
export type Measurement = z.infer<typeof measurementSchema>;
export const speedRowSchema = z.strictObject({
  index: z.number().int(),
  subject: speedSubjectSchema,
  name: z.string(),
  protocol: z.string(),
  state: z.enum([
    'pending',
    'running',
    'completed',
    'partial',
    'failed',
    'unsupported',
    'cancelled',
    'stale',
  ]),
  stale: z.boolean(),
  message: z.string(),
  testedAt: z.string().nullable(),
  coreVersion: z.string().nullable(),
  measurements: z.array(measurementSchema),
});
export type SpeedRow = z.infer<typeof speedRowSchema>;
export const speedReportSchema = z.strictObject({
  id: z.string().uuid(),
  origin: z.enum(['web', 'telegram']).default('web'),
  name: z.string(),
  state: z.enum(['running', 'completed', 'cancelled', 'failed', 'interrupted']),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  backendVersion: z.string().nullable(),
  settings: speedSettingsSchema,
  metrics: z.array(metricIdSchema),
  scripts: z.array(
    z.strictObject({ id: z.string(), name: z.string(), revision: z.string(), source: z.string() }),
  ),
  total: z.number().int(),
  completed: z.number().int(),
  current: z.string().nullable(),
  error: z.string().nullable(),
  results: z.array(speedRowSchema),
});
export type SpeedReport = z.infer<typeof speedReportSchema>;
export const reportSummarySchema = speedReportSchema.omit({ results: true });
export const reportListSchema = z.strictObject({
  reports: z.array(reportSummarySchema),
  total: z.number().int(),
});
export const speedStatusSchema = z.strictObject({
  configured: z.boolean(),
  connected: z.boolean(),
  version: z.string().nullable(),
  apiVersion: z.literal(3),
  uploadEnabled: z.boolean(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
  active: z.string().nullable(),
});
export function measurementText(value: Measurement) {
  if (value.value === null) return value.message || '未知';
  if (typeof value.value === 'number') {
    if (value.unit === 'B/s') return (value.value / 1048576).toFixed(2) + ' MiB/s';
    return String(Math.round(value.value * 100) / 100) + (value.unit ? ' ' + value.unit : '');
  }
  return value.value;
}
