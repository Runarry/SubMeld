import { z } from 'zod';

export const backendIdSchema = z.union([z.literal('environment'), z.string().uuid()]);
export const backendUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['ws:', 'wss:'].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !/[\s\\]/.test(value)
      );
    } catch {
      return false;
    }
  }, '请输入不含认证信息、查询或片段的 ws:// 或 wss:// 地址。');
export const backendInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: backendUrlSchema,
  token: z.string().trim().max(4096).optional(),
});
export const backendSnapshotSchema = z.strictObject({
  id: backendIdSchema,
  name: z.string(),
  url: z.string(),
  kind: z.enum(['environment', 'remote']),
});
export type BackendSnapshot = z.infer<typeof backendSnapshotSchema>;
export const backendViewSchema = backendSnapshotSchema.extend({
  tokenConfigured: z.boolean(),
  readOnly: z.boolean(),
});
export type BackendView = z.infer<typeof backendViewSchema>;
export const backendListSchema = z.strictObject({
  backends: z.array(backendViewSchema),
  defaultBackendId: backendIdSchema.nullable(),
});
export const backendDefaultSchema = z.strictObject({ backendId: backendIdSchema.nullable() });
export const backendCheckSchema = z.strictObject({ backendId: backendIdSchema.optional() });
