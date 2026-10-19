import { z } from 'zod';
import { revisionSchema } from './resources.js';

export const machineCoreSchema = z.enum(['sing-box', 'xray']);
export const machineParameterSchema = z.union([
  z.string().max(65536),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(65536)).max(2000),
]);
export const machineActionSchema = z.enum([
  'core.install',
  'core.update',
  'core.start',
  'core.stop',
  'core.restart',
  'core.uninstall',
  'node.add',
  'node.edit',
  'node.delete',
  'node.switch',
  'node.ip-policy',
  'dns.set',
  'dns.reset',
  'exit.add',
  'exit.edit',
  'exit.delete',
  'binding.add',
  'binding.delete',
  'forward.add',
  'forward.edit',
  'forward.delete',
  'forward.refresh',
  'time.sync',
  'tunnel.apply',
  'tunnel.delete',
]);
export type MachineAction = z.infer<typeof machineActionSchema>;
export const machineOperationSchema = z.strictObject({
  action: machineActionSchema,
  params: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), machineParameterSchema).default({}),
});
export const machineCommandSchema = machineOperationSchema.extend({
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  expectedRevision: revisionSchema,
});
export type MachineCommand = z.infer<typeof machineCommandSchema>;
export const machineExportSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(512),
    core: machineCoreSchema,
    kind: z.enum(['node', 'forward']),
    uri: z.string().min(1).max(65536),
  })
  .passthrough();
export const machineSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: revisionSchema,
    vpsctlVersion: z.string().max(128),
    capabilities: z
      .object({
        actions: z.array(z.string().max(80)).max(100),
        profiles: z
          .array(
            z
              .object({ id: z.string(), label: z.string(), cores: z.array(machineCoreSchema) })
              .passthrough(),
          )
          .max(100),
      })
      .passthrough(),
    cores: z
      .array(
        z
          .object({
            core: machineCoreSchema,
            installed: z.boolean(),
            running: z.boolean(),
            enabled: z.boolean(),
            pending_restart: z.boolean(),
            version: z.string(),
          })
          .passthrough(),
      )
      .max(2),
    nodes: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            core: machineCoreSchema,
            profile: z.string(),
          })
          .passthrough(),
      )
      .max(2000),
    relay: z
      .object({
        exits: z.array(z.record(z.string(), z.unknown())),
        bindings: z.array(z.record(z.string(), z.unknown())),
        forwards: z.array(z.record(z.string(), z.unknown())),
      })
      .passthrough(),
    exports: z.array(machineExportSchema).max(2000),
    pendingCores: z.array(machineCoreSchema).max(2),
  })
  .passthrough();
export type MachineSnapshot = z.infer<typeof machineSnapshotSchema>;
export const machineResultSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  status: z.enum(['applied', 'pending_restart', 'conflict', 'failed', 'unknown']),
  exitCode: z.number().int(),
  message: z.string().max(2048),
  revision: revisionSchema,
  snapshot: machineSnapshotSchema.optional(),
});
export type MachineResult = z.infer<typeof machineResultSchema>;
export const machineReportSchema = z.strictObject({
  machineId: z.string().uuid(),
  agentVersion: z.string().min(1).max(128),
  bootId: z.string().uuid(),
  snapshot: machineSnapshotSchema,
  tunnels: z
    .array(
      z.object({
        id: z.string().uuid(),
        revision: revisionSchema,
        running: z.boolean(),
        error: z.string().max(1024),
      }),
    )
    .max(100)
    .default([]),
});
export const machineViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  enabled: z.boolean(),
  online: z.boolean(),
  lastSeen: z.number().nullable(),
  agentVersion: z.string().nullable(),
  revision: revisionSchema.nullable(),
  snapshotRevision: revisionSchema.nullable(),
  syncError: z.string().nullable(),
  resourceId: z.string().uuid(),
});
export type MachineView = z.infer<typeof machineViewSchema>;
export const machineTaskSchema = z.object({
  id: z.string().uuid(),
  machineId: z.string().uuid(),
  action: machineActionSchema,
  status: z.enum([
    'queued',
    'running',
    'applied',
    'pending_restart',
    'conflict',
    'failed',
    'unknown',
    'cancelled',
  ]),
  createdAt: z.number(),
  updatedAt: z.number(),
  expectedRevision: revisionSchema,
  resultRevision: revisionSchema.nullable(),
  message: z.string(),
});
export type MachineTask = z.infer<typeof machineTaskSchema>;
export const machineDetailSchema = z.object({
  machine: machineViewSchema,
  snapshot: machineSnapshotSchema.nullable(),
  tasks: z.array(machineTaskSchema),
});
export type MachineDetail = z.infer<typeof machineDetailSchema>;
export const createMachineSchema = z.strictObject({ name: z.string().trim().min(1).max(128) });
export const queueMachineCommandSchema = machineOperationSchema.extend({
  expectedRevision: revisionSchema,
});

export const relayRouteSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(128),
  kind: z.enum(['forward', 'protocol', 'tunnel']),
  entryMachineId: z.string().uuid(),
  targetMachineId: z.string().uuid(),
  targetNodeId: z.string().min(1),
  entryNodeId: z.string().optional(),
  listenPort: z.number().int().min(1).max(65535),
  address: z.string().min(1).max(253),
  network: z.enum(['tcp', 'udp', 'both']).default('both'),
  family: z.enum(['dual', 'ipv4', 'ipv6']).default('dual'),
  hops: z
    .array(
      z.object({
        machineId: z.string().uuid(),
        address: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
      }),
    )
    .max(8)
    .default([]),
  revision: revisionSchema,
  status: z.enum(['pending', 'applying', 'active', 'failed', 'deleting', 'deleted', 'stale']),
  message: z.string(),
  taskIds: z.array(z.string().uuid()),
  health: z.enum(['unknown', 'online', 'offline', 'degraded']).default('unknown'),
});
export type RelayRoute = z.infer<typeof relayRouteSchema>;
