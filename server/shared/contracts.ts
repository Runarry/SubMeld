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
    protocolOptions: z.strictObject({
      flow: z.enum(['', 'xtls-rprx-vision']),
      packetEncoding: z.literal('xudp').default('xudp'),
    }),
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
    protocolOptions: z.strictObject({
      obfs: z.enum(['', 'salamander']),
      obfsPassword: authText,
      ports: z.string().max(4096).default(''),
      hopInterval: z.number().int().positive().nullable().default(null),
      pinSHA256: z.string().max(64).default(''),
    }),
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
export const produceRequestSchema = z.strictObject({ items: z.array(itemSchema).max(MAX_NODES) });
const counts = z.strictObject({ input: z.number(), output: z.number(), filtered: z.number() });
export const produceResultSchema = z.strictObject({
  uri: z.string(),
  base64: z.string().nullable(),
  diagnostics: z.array(diagnosticSchema),
  counts,
});
export type ProduceResult = z.infer<typeof produceResultSchema>;
export type ConversionRequest = { kind: 'render'; input: z.infer<typeof renderRequestSchema> };
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
      return {
        ...common,
        protocol,
        auth: { uuid: '' },
        protocolOptions: { flow: '', packetEncoding: 'xudp' },
      };
    case 'trojan':
      return { ...common, protocol, auth: { password: '' }, protocolOptions: {} };
    case 'hysteria2':
      return {
        ...common,
        protocol,
        auth: { password: '' },
        protocolOptions: {
          obfs: '',
          obfsPassword: '',
          ports: '',
          hopInterval: null,
          pinSHA256: '',
        },
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
export type RenderItem = WorkbenchItem;
export const renderRequestSchema = z.strictObject({
  items: z.array(itemSchema).max(MAX_NODES),
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
