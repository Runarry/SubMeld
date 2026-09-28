import { z } from 'zod';
import { nodeSelectorSchema, nodeViewSchema, revisionSchema } from './resources.js';
export const MAX_CHAINS = 100;
export const chainConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(512),
  enabled: z.boolean().default(true),
  entry: nodeSelectorSchema,
  exit: nodeSelectorSchema,
});
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export const chainSchema = chainConfigSchema.extend({
  id: z.string().uuid(),
  revision: revisionSchema,
  available: z.boolean(),
  error: z.string().nullable(),
  entryNode: nodeViewSchema.nullable(),
  exitNode: nodeViewSchema.nullable(),
});
export type Chain = z.infer<typeof chainSchema>;
export const chainListSchema = z.object({ chains: z.array(chainSchema), total: z.number() });
