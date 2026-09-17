import { z } from 'zod';
import { nodeSummarySchema } from './contracts.js';

export const MAX_CHAINS = 100;
export const chainConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(512),
  enabled: z.boolean().default(true),
  entryNodeId: z.string().uuid(),
  exitNodeId: z.string().uuid(),
});
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export const chainUpdateSchema = chainConfigSchema
  .partial()
  .extend({
    enabled: z.boolean().optional(),
    revision: z.number().int().positive(),
  })
  .refine((value) => Object.keys(value).length > 1);
export const chainSchema = chainConfigSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  entry: nodeSummarySchema,
  exit: nodeSummarySchema,
  available: z.boolean(),
});
export type Chain = z.infer<typeof chainSchema>;
export const chainListSchema = z.strictObject({
  chains: z.array(chainSchema),
  total: z.number().int().nonnegative(),
});
