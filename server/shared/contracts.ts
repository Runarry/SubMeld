import { z } from 'zod';

export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_NODES = 2000;
export const MAX_DEPTH = 32;
export const protocols = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic'] as const;
export type Protocol = (typeof protocols)[number];
const text = z.string().max(16384);
const authText = z.string().max(16384);
const tls = z.strictObject({
  mode: z.enum(['none', 'tls', 'reality']),
  serverName: text,
  insecure: z.boolean(),
  alpn: z.array(z.string().max(255)).max(16),
  fingerprint: z.string().max(64),
  publicKey: z.string().max(128),
  shortId: z.string().max(16),
});
const transport = z.strictObject({
  type: z.enum(['tcp', 'ws', 'grpc']),
  path: text,
  host: text,
  serviceName: text,
});
const base = {
  name: z.string().max(512),
  server: z.string().max(255),
  port: z.number().int().min(0).max(65535),
  tls,
  transport,
};
export const draftSchema = z.discriminatedUnion('protocol', [
  z.strictObject({
    ...base,
    protocol: z.literal('ss'),
    auth: z.strictObject({ password: authText }),
    protocolOptions: z.strictObject({
      method: z.enum(['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']),
    }),
  }),
  z.strictObject({
    ...base,
    protocol: z.literal('vmess'),
    auth: z.strictObject({ uuid: authText }),
    protocolOptions: z.strictObject({
      security: z.enum(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero']),
      alterId: z.literal(0),
    }),
  }),
  z.strictObject({
    ...base,
    protocol: z.literal('vless'),
    auth: z.strictObject({ uuid: authText }),
    protocolOptions: z.strictObject({ flow: z.enum(['', 'xtls-rprx-vision']) }),
  }),
  z.strictObject({
    ...base,
    protocol: z.literal('trojan'),
    auth: z.strictObject({ password: authText }),
    protocolOptions: z.strictObject({}),
  }),
  z.strictObject({
    ...base,
    protocol: z.literal('hysteria2'),
    auth: z.strictObject({ password: authText }),
    protocolOptions: z.strictObject({ obfs: z.enum(['', 'salamander']), obfsPassword: authText }),
  }),
  z.strictObject({
    ...base,
    protocol: z.literal('tuic'),
    auth: z.strictObject({ uuid: authText, password: authText }),
    protocolOptions: z.strictObject({
      version: z.literal(5),
      congestionControl: z.enum(['cubic', 'bbr', 'new_reno']),
      udpRelayMode: z.enum(['native', 'quic']),
      reduceRtt: z.boolean(),
    }),
  }),
]);
export type NodeDraft = z.infer<typeof draftSchema>;
export const diagnosticSchema = z.strictObject({
  level: z.enum(['warning', 'error']),
  code: z.string(),
  nodeIndex: z.number().int(),
  field: z.string().optional(),
  message: z.string(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export const itemSchema = z.strictObject({
  nodeIndex: z
    .number()
    .int()
    .min(0)
    .max(MAX_NODES - 1),
  excluded: z.boolean(),
  draft: draftSchema.nullable(),
  diagnostics: z.array(diagnosticSchema).max(64),
});
export type WorkbenchItem = z.infer<typeof itemSchema>;
export const formatSchema = z.enum(['auto', 'uri', 'base64', 'yaml']);
export const parseRequestSchema = z.strictObject({ format: formatSchema, text: z.string() });
export const produceRequestSchema = z.strictObject({ items: z.array(itemSchema).max(MAX_NODES) });
const counts = z.strictObject({ input: z.number(), output: z.number(), filtered: z.number() });
export const parseResultSchema = z.strictObject({
  items: z.array(itemSchema),
  diagnostics: z.array(diagnosticSchema),
  counts,
});
export const produceResultSchema = z.strictObject({
  uri: z.string(),
  base64: z.string().nullable(),
  diagnostics: z.array(diagnosticSchema),
  counts,
});
export type ParseResult = z.infer<typeof parseResultSchema>;
export type ProduceResult = z.infer<typeof produceResultSchema>;
export type WorkerRequest =
  | { kind: 'parse'; input: z.infer<typeof parseRequestSchema> }
  | { kind: 'produce'; input: z.infer<typeof produceRequestSchema> }
  | { kind: 'render'; input: z.infer<typeof renderRequestSchema> };
export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  diagnostics: z.array(diagnosticSchema).optional(),
});
export function diagnostic(
  nodeIndex: number,
  code: string,
  message: string,
  field?: string,
  level: 'warning' | 'error' = 'error',
): Diagnostic {
  return { nodeIndex, code, message, ...(field ? { field } : {}), level };
}
export function blankDraft(protocol: Protocol): NodeDraft {
  const common = {
    name: '',
    server: '',
    port: protocol === 'ss' ? 8388 : 443,
    tls: {
      mode: (['trojan', 'hysteria2', 'tuic'].includes(protocol) ? 'tls' : 'none') as 'tls' | 'none',
      serverName: '',
      insecure: false,
      alpn: [] as string[],
      fingerprint: '',
      publicKey: '',
      shortId: '',
    },
    transport: { type: 'tcp' as const, path: '/', host: '', serviceName: '' },
  };
  switch (protocol) {
    case 'ss':
      return {
        ...common,
        protocol,
        auth: { password: '' },
        protocolOptions: { method: 'aes-128-gcm' },
      };
    case 'vmess':
      return {
        ...common,
        protocol,
        auth: { uuid: '' },
        protocolOptions: { security: 'auto', alterId: 0 },
      };
    case 'vless':
      return { ...common, protocol, auth: { uuid: '' }, protocolOptions: { flow: '' } };
    case 'trojan':
      return { ...common, protocol, auth: { password: '' }, protocolOptions: {} };
    case 'hysteria2':
      return {
        ...common,
        protocol,
        auth: { password: '' },
        protocolOptions: { obfs: '', obfsPassword: '' },
      };
    case 'tuic':
      return {
        ...common,
        protocol,
        auth: { uuid: '', password: '' },
        protocolOptions: {
          version: 5,
          congestionControl: 'cubic',
          udpRelayMode: 'native',
          reduceRtt: false,
        },
      };
  }
}

export const renderTargetSchema = z.enum(['mihomo', 'singbox', 'xray']);
export type RenderTarget = z.infer<typeof renderTargetSchema>;
export const chainItemSchema = z.strictObject({
  kind: z.literal('chain'),
  nodeIndex: itemSchema.shape.nodeIndex,
  excluded: z.boolean(),
  diagnostics: itemSchema.shape.diagnostics,
  name: z.string().min(1).max(512),
  entry: draftSchema,
  exit: draftSchema,
  available: z.boolean().default(true),
});
export type ChainItem = z.infer<typeof chainItemSchema>;
export const renderItemSchema = z.union([itemSchema, chainItemSchema]);
export type RenderItem = z.infer<typeof renderItemSchema>;
export function isChain(item: RenderItem): item is ChainItem {
  return 'kind' in item && item.kind === 'chain';
}
export const renderRequestSchema = z.strictObject({
  items: z.array(renderItemSchema).max(MAX_NODES),
  target: renderTargetSchema,
  listenPort: z.number().int().min(1).max(65535).default(1080),
});
export const renderResultSchema = z.strictObject({
  target: renderTargetSchema,
  full: z.string(),
  nodes: z.string(),
  diagnostics: z.array(diagnosticSchema),
  counts,
});
export type RenderResult = z.infer<typeof renderResultSchema>;
const revisionSchema = z.number().int().positive();
export const nodeSummarySchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string(),
  protocol: z.enum(protocols),
  enabled: z.boolean(),
  revision: revisionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NodeSummary = z.infer<typeof nodeSummarySchema>;
export const storedNodeSchema = nodeSummarySchema.extend({
  modelVersion: z.literal(1),
  draft: draftSchema,
});
export type StoredNode = z.infer<typeof storedNodeSchema>;
export const nodeListSchema = z.strictObject({
  nodes: z.array(nodeSummarySchema),
  total: z.number().int().nonnegative(),
});
export const createNodesSchema = z.strictObject({
  drafts: z.array(draftSchema).min(1).max(MAX_NODES),
});
export const nodeIdsSchema = z.strictObject({
  ids: z.array(z.string().uuid()).min(1).max(MAX_NODES),
});
export const revisionRequestSchema = z.strictObject({ revision: revisionSchema });
// Secrets have three states: omitted, replacement string, or explicit clear (null).
export const nodeChangesSchema = z.strictObject({
  name: base.name.optional(),
  server: base.server.optional(),
  port: base.port.optional(),
  tls: tls.partial().optional(),
  transport: transport.partial().optional(),
  auth: z
    .strictObject({
      uuid: authText.nullable().optional(),
      password: authText.nullable().optional(),
    })
    .optional(),
  protocolOptions: z
    .strictObject({
      method: z.enum(['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']).optional(),
      security: z.enum(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero']).optional(),
      alterId: z.literal(0).optional(),
      flow: z.enum(['', 'xtls-rprx-vision']).optional(),
      obfs: z.enum(['', 'salamander']).optional(),
      obfsPassword: authText.nullable().optional(),
      version: z.literal(5).optional(),
      congestionControl: z.enum(['cubic', 'bbr', 'new_reno']).optional(),
      udpRelayMode: z.enum(['native', 'quic']).optional(),
      reduceRtt: z.boolean().optional(),
    })
    .optional(),
});
export const updateNodeSchema = z
  .strictObject({
    revision: revisionSchema,
    enabled: z.boolean().optional(),
    changes: nodeChangesSchema.optional(),
  })
  .refine((v) => v.enabled !== undefined || v.changes !== undefined);
export const loadedNodesSchema = z.strictObject({ items: z.array(itemSchema).max(MAX_NODES) });
