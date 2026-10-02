import { z } from 'zod';
import { MAX_NODES } from './contracts.js';

export const machineIdSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
export const nodeReportSchema = z.strictObject({
  name: z.string().trim().min(1).max(512),
  content: z.string().min(1),
});
export const nodeReportResultSchema = z.object({
  machineId: machineIdSchema,
  action: z.enum(['created', 'updated', 'unchanged']),
  nodeCount: z.number().int().min(1).max(MAX_NODES),
});
export type NodeReportResult = z.infer<typeof nodeReportResultSchema>;
export const nodeReportingSettingsSchema = z.object({
  enabled: z.boolean(),
  tokenConfigured: z.boolean(),
});
export type NodeReportingSettings = z.infer<typeof nodeReportingSettingsSchema>;
export const nodeReportingPatchSchema = z.strictObject({ enabled: z.boolean() });
export const nodeReportingTokenSchema = nodeReportingSettingsSchema.extend({ token: z.string() });
