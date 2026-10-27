import { z } from 'zod';
import { MAX_BYTES, MAX_NODES } from './contracts.js';
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const resourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  upstreamName: z.string(),
  type: z.enum(['sub', 'collection']),
  revision: revisionSchema,
});
export type Resource = z.infer<typeof resourceSchema>;
export const nodeSelectorSchema = z.strictObject({
  resourceId: z.string().uuid(),
  nodeName: z.string().min(1).max(512),
});
export type NodeSelector = z.infer<typeof nodeSelectorSchema>;
export const nodeRefSchema = z.strictObject({
  resourceId: z.string().uuid(),
  revision: revisionSchema,
  snapshotHash: revisionSchema,
  nodeIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type NodeRef = z.infer<typeof nodeRefSchema>;
export const nodeViewSchema = nodeRefSchema.extend({
  name: z.string(),
  protocol: z.string(),
  resourceName: z.string(),
  available: z.boolean(),
  testable: z.boolean(),
  testReason: z.string(),
  deletion: z.enum(['content', 'filter', 'unavailable']),
});
export type NodeView = z.infer<typeof nodeViewSchema>;
export const nodeListSchema = z.object({
  nodes: z.array(nodeViewSchema),
  resources: z.array(resourceSchema),
  errors: z.array(z.object({ resourceId: z.string(), message: z.string() })),
  total: z.number().int().nonnegative(),
  readAt: z.iso.datetime(),
  complete: z.boolean(),
});
export const nodeDetailsSchema = nodeViewSchema.extend({
  original: z.record(z.string(), z.unknown()).nullable(),
  processed: z.record(z.string(), z.unknown()).nullable(),
});
export const addResourceSchema = z.strictObject({
  name: z.string().trim().min(1).max(512),
  source: z.enum(['local', 'remote']),
  content: z.string().max(MAX_BYTES).default(''),
  url: z.string().max(16384).default(''),
});
export const deleteNodesSchema = z.strictObject({
  nodes: z.array(nodeRefSchema).min(1).max(MAX_NODES),
});
export const deleteNodesResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  resources: z.array(
    z.object({
      resourceId: z.string().uuid(),
      name: z.string(),
      state: z.enum(['verified', 'failed', 'unknown', 'notAttempted']),
      deleted: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
      message: z.string(),
    }),
  ),
});
export type DeleteNodesResult = z.infer<typeof deleteNodesResultSchema>;
