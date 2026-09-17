import { z } from 'zod';
import { diagnosticSchema, formatSchema, itemSchema, MAX_NODES, protocols } from './contracts.js';

export const MAX_SOURCES = 100;
export const MAX_SUBSCRIPTIONS = 100;
export const outputFormats = [
  'uri',
  'base64',
  'mihomo',
  'mihomo-proxies',
  'singbox',
  'singbox-outbounds',
  'xray',
  'xray-outbounds',
] as const;
export const outputFormatSchema = z.enum(outputFormats);
export type OutputFormat = z.infer<typeof outputFormatSchema>;
export const targetGroups = ['uri', 'mihomo', 'singbox', 'xray'] as const;
export type TargetGroup = (typeof targetGroups)[number];
export const outputLabels: Record<OutputFormat, string> = {
  uri: 'URI',
  base64: 'Base64',
  mihomo: 'Mihomo 完整配置',
  'mihomo-proxies': 'Mihomo 节点片段',
  singbox: 'sing-box 完整配置',
  'singbox-outbounds': 'sing-box 节点片段',
  xray: 'Xray 完整配置',
  'xray-outbounds': 'Xray 节点片段',
};
export function outputGroup(format: OutputFormat): TargetGroup {
  if (format === 'base64' || format === 'uri') return 'uri';
  if (format === 'mihomo' || format === 'mihomo-proxies') return 'mihomo';
  if (format === 'singbox' || format === 'singbox-outbounds') return 'singbox';
  return 'xray';
}
const revision = z.number().int().positive();
const identity = {
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(512),
  enabled: z.boolean(),
  revision,
  createdAt: z.string(),
  updatedAt: z.string(),
};
const sourceConfig = {
  name: identity.name,
  enabled: z.boolean().default(true),
  format: formatSchema,
};
const headerValue = z
  .string()
  .max(8192)
  .regex(/^[\x20-\x7e\x80-\xff]*$/);
export const sourceHeadersSchema = z.strictObject({
  userAgent: headerValue.default('SubMeld/1.0.0'),
  accept: headerValue.default('*/*'),
  authorization: headerValue.default(''),
});
export const remoteConfigSchema = z.strictObject({
  url: z.string().min(1).max(8192),
  headers: sourceHeadersSchema.default({
    userAgent: 'SubMeld/1.0.0',
    accept: '*/*',
    authorization: '',
  }),
});
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export const sourceInputSchema = z.union([
  z.strictObject({ ...sourceConfig, kind: z.literal('text').default('text'), text: z.string() }),
  z.strictObject({ ...sourceConfig, kind: z.literal('remote'), ...remoteConfigSchema.shape }),
]);
export const sourceUpdateSchema = z
  .strictObject({
    name: identity.name.optional(),
    enabled: z.boolean().optional(),
    format: formatSchema.optional(),
    text: z.string().optional(),
    url: remoteConfigSchema.shape.url.optional(),
    headers: z
      .strictObject({
        userAgent: headerValue.nullable().optional(),
        accept: headerValue.nullable().optional(),
        authorization: headerValue.nullable().optional(),
      })
      .optional(),
    revision,
  })
  .refine((v) => Object.keys(v).length > 1);
export const sourceErrorSchema = z.strictObject({ code: z.string(), message: z.string() });
export const refreshStatusSchema = z.enum(['idle', 'queued', 'running']);
export const sourceSummarySchema = z.strictObject({
  ...identity,
  kind: z.enum(['text', 'remote']),
  format: formatSchema,
  nodeCount: z.number().int().nonnegative(),
  savedAt: z.string().nullable(),
  snapshotVersion: z.number().int().nonnegative(),
  lastAttemptAt: z.string().nullable(),
  error: sourceErrorSchema.nullable(),
  refresh: refreshStatusSchema,
});
export const sourceSchema = sourceSummarySchema.extend({
  modelVersion: z.literal(1),
  text: z.string(),
  url: z.string().nullable(),
  headers: sourceHeadersSchema.nullable(),
  items: z.array(itemSchema).max(MAX_NODES),
  diagnostics: z.array(diagnosticSchema),
});
export type Source = z.infer<typeof sourceSchema>;
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export const sourceListSchema = z.strictObject({
  sources: z.array(sourceSummarySchema),
  total: z.number().int().nonnegative(),
});
export const inputRefSchema = z.strictObject({
  kind: z.enum(['node', 'source', 'chain']),
  id: z.string().uuid(),
});
export type InputRef = z.infer<typeof inputRefSchema>;
const protocolSelection = z
  .array(z.enum(protocols))
  .max(protocols.length)
  .refine((v) => new Set(v).size === v.length);
export const subscriptionConfigSchema = z.strictObject({
  name: identity.name,
  enabled: z.boolean().default(true),
  inputs: z
    .array(inputRefSchema)
    .max(MAX_NODES)
    .refine((v) => new Set(v.map((i) => i.kind + i.id)).size === v.length),
  formats: z
    .array(outputFormatSchema)
    .min(1)
    .max(outputFormats.length)
    .refine((v) => new Set(v).size === v.length),
  includeName: z.string().max(512),
  excludeName: z.string().max(512),
  prefix: z.string().max(512),
  suffix: z.string().max(512),
  listenPort: z.number().int().min(1).max(65535),
  protocols: z.strictObject({
    uri: protocolSelection,
    mihomo: protocolSelection,
    singbox: protocolSelection,
    xray: protocolSelection,
  }),
});
export type SubscriptionConfig = z.infer<typeof subscriptionConfigSchema>;
export function newSubscription(): SubscriptionConfig {
  return {
    name: '',
    enabled: true,
    inputs: [],
    formats: ['uri', 'base64'],
    includeName: '',
    excludeName: '',
    prefix: '',
    suffix: '',
    listenPort: 1080,
    protocols: {
      uri: [...protocols],
      mihomo: [...protocols],
      singbox: [...protocols],
      xray: [...protocols],
    },
  };
}
export const subscriptionUpdateSchema = subscriptionConfigSchema
  .partial()
  .extend({ revision, enabled: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 1);
export const subscriptionSchema = subscriptionConfigSchema.extend(identity);
export type Subscription = z.infer<typeof subscriptionSchema>;
export const subscriptionSummarySchema = z.strictObject({
  ...identity,
  formats: z.array(outputFormatSchema),
});
export const subscriptionListSchema = z.strictObject({
  subscriptions: z.array(subscriptionSummarySchema),
  total: z.number().int().nonnegative(),
});
export type SubscriptionSummary = z.infer<typeof subscriptionSummarySchema>;
export const countsSchema = z.strictObject({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative(),
});
export const artifactErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  diagnostics: z.array(diagnosticSchema).optional(),
});
export const artifactStatusSchema = z.strictObject({
  format: outputFormatSchema,
  readable: z.boolean(),
  generatedAt: z.string().nullable(),
  builtRevision: revision.nullable(),
  engineVersion: z.string().nullable(),
  counts: countsSchema.nullable(),
  diagnostics: z.array(diagnosticSchema),
  error: artifactErrorSchema.nullable(),
});
export const artifactSchema = artifactStatusSchema.extend({ content: z.string() });
export type Artifact = z.infer<typeof artifactSchema>;
export const subscriptionDetailSchema = subscriptionSchema.extend({
  generation: z.enum(['idle', 'queued', 'running']),
  inputLabels: z.array(inputRefSchema.extend({ name: z.string(), enabled: z.boolean() })),
  artifacts: z.array(artifactStatusSchema),
});
export type SubscriptionDetail = z.infer<typeof subscriptionDetailSchema>;
export const issuedSubscriptionSchema = z.strictObject({
  subscription: subscriptionDetailSchema,
  urls: z.partialRecord(outputFormatSchema, z.string()),
});
