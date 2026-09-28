import { z } from 'zod';
import { MAX_NODES } from './contracts.js';
import { nodeSelectorSchema, revisionSchema } from './resources.js';
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
  return format === 'base64' || format === 'uri'
    ? 'uri'
    : format.startsWith('mihomo')
      ? 'mihomo'
      : format.startsWith('singbox')
        ? 'singbox'
        : 'xray';
}
export const inputRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('resource'), id: z.string().uuid() }),
  z.strictObject({ kind: z.literal('chain'), id: z.string().uuid() }),
  nodeSelectorSchema.extend({ kind: z.literal('node') }),
]);
export type InputRef = z.infer<typeof inputRefSchema>;
export function inputKey(input: InputRef) {
  return input.kind === 'node'
    ? 'node:' + input.resourceId + ':' + input.nodeName
    : input.kind + ':' + input.id;
}
export const subscriptionConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(512),
  enabled: z.boolean().default(true),
  inputs: z
    .array(inputRefSchema)
    .min(1)
    .max(MAX_NODES)
    .refine((v) => new Set(v.map(inputKey)).size === v.length),
  formats: z
    .array(outputFormatSchema)
    .min(1)
    .max(8)
    .refine((v) => new Set(v).size === v.length),
  includeName: z.string().max(512).default(''),
  excludeName: z.string().max(512).default(''),
  prefix: z.string().max(512).default(''),
  suffix: z.string().max(512).default(''),
  listenPort: z.number().int().min(1).max(65535).default(1080),
  protocols: z
    .object({
      uri: z.array(z.string()),
      mihomo: z.array(z.string()),
      singbox: z.array(z.string()),
      xray: z.array(z.string()),
    })
    .default({ uri: [], mihomo: [], singbox: [], xray: [] }),
});
export type SubscriptionConfig = z.infer<typeof subscriptionConfigSchema>;
export function newSubscription(): SubscriptionConfig {
  return {
    name: '',
    enabled: true,
    inputs: [],
    formats: ['uri', 'mihomo'],
    includeName: '',
    excludeName: '',
    prefix: '',
    suffix: '',
    listenPort: 1080,
    protocols: { uri: [], mihomo: [], singbox: [], xray: [] },
  };
}
export const subscriptionSchema = subscriptionConfigSchema.extend({
  id: z.string().uuid(),
  revision: revisionSchema,
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export const subscriptionDetailSchema = subscriptionSchema.extend({
  urls: z.partialRecord(outputFormatSchema, z.array(z.string())),
  errors: z.array(z.string()),
});
export type SubscriptionDetail = z.infer<typeof subscriptionDetailSchema>;
export const subscriptionListSchema = z.object({
  subscriptions: z.array(subscriptionSchema),
  total: z.number(),
});
export const artifactSchema = z.object({ format: outputFormatSchema, content: z.string() });
export type Artifact = z.infer<typeof artifactSchema>;
