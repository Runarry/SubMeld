import { z } from 'zod';
import type { NodeDraft } from './contracts.js';

export const hy2CertificateRequestSchema = z.strictObject({
  server: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\s/?#@]+$/),
  port: z.number().int().min(1).max(65535),
  ports: z.string().max(4096),
  serverName: z.string().max(512),
  obfs: z.enum(['', 'salamander']),
  obfsPassword: z.string().max(16384),
  pinSHA256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Hy2CertificateRequest = z.infer<typeof hy2CertificateRequestSchema>;
export const hy2CertificateSchema = z.strictObject({
  pinSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  certificatePem: z.string().min(1).max(65536),
  publicKeySha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
export type Hy2Certificate = z.infer<typeof hy2CertificateSchema>;
export type Hy2CertificateResolver = (
  request: Hy2CertificateRequest,
  signal?: AbortSignal,
) => Promise<Hy2Certificate>;

export const hy2ResolverConnectionSchema = z.strictObject({
  url: z.string().url(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

export function hy2CertificateRequest(node: NodeDraft): Hy2CertificateRequest {
  if (node.protocol !== 'hysteria2') throw new Error('Expected Hysteria2');
  return hy2CertificateRequestSchema.parse({
    server: node.server,
    port: node.port,
    ports: node.protocolOptions.ports,
    serverName: node.tls.serverName,
    obfs: node.protocolOptions.obfs,
    obfsPassword: node.protocolOptions.obfsPassword,
    pinSHA256: node.protocolOptions.pinSHA256,
  });
}
