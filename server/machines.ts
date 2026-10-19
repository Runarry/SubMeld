import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { guardStructure } from './input.js';
import { machineRelayReferences } from './relays.js';
import { identityKey, upstreamRecordSchema, type UpstreamRecord } from './sub-store.js';
import { hash, marker, type Entry, type UpstreamResources } from './upstream-resources.js';
import {
  createMachineSchema,
  deleteMachineSchema,
  machineCommandSchema,
  machineExportSchema,
  machineReportSchema,
  machineResultSchema,
  machineSnapshotSchema,
  machineTaskSchema,
  queueMachineCommandSchema,
  type MachineCommand,
  type MachineDeletionPreview,
  type MachineDetail,
  type MachineSnapshot,
  type MachineTask,
  type MachineView,
} from './shared/machines.js';
import { revisionSchema } from './shared/resources.js';
import { readStoredSubscription } from './shared/legacy-chain-inputs.js';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const rowSchema = z.object({
  id: uuid,
  name: z.string(),
  enabled: z.number(),
  token_hash: revisionSchema,
  resource_id: uuid,
  snapshot_file_id: uuid,
  last_seen: z.number().nullable(),
  agent_version: z.string().nullable(),
  boot_id: z.string().nullable(),
  revision: revisionSchema.nullable(),
  snapshot_revision: revisionSchema.nullable(),
  snapshot_hash: revisionSchema.nullable(),
  snapshot_sequence: z.number().int(),
  sync_error: z.string().nullable(),
});
type MachineRow = z.infer<typeof rowSchema>;
const taskRowSchema = z.object({
  id: uuid,
  machine_id: uuid,
  action: machineTaskSchema.shape.action,
  status: machineTaskSchema.shape.status,
  created_at: z.number(),
  updated_at: z.number(),
  expected_revision: revisionSchema,
  result_revision: revisionSchema.nullable(),
  message: z.string(),
  file_id: uuid,
  delivery_sequence: z.number().int().nullable(),
  finished: z.number(),
});
type TaskRow = z.infer<typeof taskRowSchema>;
type OwnedResource = Entry & {
  id: string;
  role: 'machine-source' | 'machine-snapshot' | 'machine-command';
  revision: string;
};
const appliedSchema = z.object({
  revision: revisionSchema.nullable(),
  exports: z.array(machineExportSchema).max(2000),
});
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  snapshot: machineSnapshotSchema,
  applied: z.object({ 'sing-box': appliedSchema, xray: appliedSchema }),
  tunnels: machineReportSchema.shape.tunnels,
});
type Envelope = z.infer<typeof envelopeSchema>;
const resultInputSchema = z.strictObject({ machineId: uuid, result: machineResultSchema });
const patchSchema = createMachineSchema.partial().extend({ enabled: z.boolean().optional() });
const digest = (token: string) => createHash('sha256').update(token).digest();
const MAX_SNAPSHOT = 8 * 1024 * 1024;
const cores = ['sing-box', 'xray'] as const;
const messages: Record<z.infer<typeof machineResultSchema>['status'], string> = {
  applied: '机器已应用操作。',
  pending_restart: '配置已保存，等待对应内核重启后生效。',
  conflict: '机器配置版本已变化，操作未执行。',
  failed: '机器执行失败，请在机器上检查详情。',
  unknown: '机器无法确认操作结果，请核对当前配置。',
};

// Display fields are deliberately enumerated: unknown native fields remain in the
// private upstream file and must never become an accidental credential response.
const displayKeys = new Set([
  'id',
  'name',
  'core',
  'profile',
  'type',
  'kind',
  'tag',
  'label',
  'host',
  'server',
  'address',
  'port',
  'listen',
  'listen_port',
  'listen-port',
  'server_port',
  'server-port',
  'network',
  'transport',
  'security',
  'enabled',
  'running',
  'installed',
  'pending_restart',
  'version',
  'node',
  'node_id',
  'node-id',
  'exit',
  'exit_id',
  'exit-id',
  'target',
  'target_id',
  'target-id',
  'target_host',
  'target_port',
  'sni',
  'domain',
  'protocol',
  'method',
  'flow',
  'path',
  'service',
  'service_name',
  'family',
  'ip-policy',
  'ip_policy',
  'mode',
  'status',
  'strategy',
  'level',
  'local_port',
  'remote_port',
  'destination',
  'destination_port',
  'destination_host',
  'public-key',
  'public_key',
  'publicKey',
  'short-id',
  'short_id',
  'fingerprint',
  'alpn',
  'server_name',
  'ip_strategy',
  'reality_guard',
  'obfs_type',
  'up_mbps',
  'down_mbps',
  'congestion_control',
  'bbr_profile',
  'hop_ports',
  'listen_ports',
  'certificate_id',
]);
const displayContainers = new Set([
  'params',
  'parameters',
  'tls',
  'transport',
  'options',
  'settings',
  'dns',
  'routing',
  'target',
  'listen',
  'outbound',
  'destination',
]);
function display(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(display);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (
          key !== 'certificate_id' &&
          /pass|secret|token|credential|private|uri|url|certificate|cert|keyfile/i.test(key)
        )
          return [];
        if (item && typeof item === 'object')
          return displayKeys.has(key) || displayContainers.has(key) ? [[key, display(item)]] : [];
        return displayKeys.has(key) ? [[key, display(item)]] : [];
      }),
    );
  return typeof value === 'string' && /:\/\/|BEGIN .*PRIVATE KEY/.test(value) ? '[已隐藏]' : value;
}
function publicSnapshot(snapshot: MachineSnapshot): MachineSnapshot {
  return machineSnapshotSchema.parse({
    schemaVersion: 1,
    revision: snapshot.revision,
    vpsctlVersion: snapshot.vpsctlVersion,
    capabilities: {
      actions: snapshot.capabilities.actions,
      profiles: snapshot.capabilities.profiles.map(({ id, label, cores: supported }) => ({
        id,
        label,
        cores: supported,
      })),
    },
    cores: snapshot.cores.map((core) => display(core)),
    nodes: snapshot.nodes.map((node) => display(node)),
    relay: {
      exits: snapshot.relay.exits.map(display),
      bindings: snapshot.relay.bindings.map(display),
      forwards: snapshot.relay.forwards.map(display),
    },
    exports: snapshot.exports.map(({ id, name, core, kind }) => ({
      id,
      name,
      core,
      kind,
      uri: '[已隐藏]',
    })),
    pendingCores: snapshot.pendingCores,
  });
}
function checkedSnapshot(input: unknown) {
  guardStructure(input);
  const snapshot = machineSnapshotSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '机器完整快照超过 8 MiB。', 413);
  if (
    new Set(snapshot.cores.map((core) => core.core)).size !== snapshot.cores.length ||
    new Set(snapshot.nodes.map((node) => node.id)).size !== snapshot.nodes.length ||
    new Set(snapshot.exports.map((node) => node.id)).size !== snapshot.exports.length
  )
    throw new AppError('MACHINE_SNAPSHOT_INVALID', '机器快照包含重复的内核或节点身份。', 422);
  return snapshot;
}

/** Configuration and command parameters live only in private Sub-Store files. */
export class MachineStore {
  onChange?: (machineId: string) => void | Promise<void>;
  // Relay operations acquire their queue before the shared Sub-Store lock.
  coordinateDeletion?: <T>(operation: () => Promise<T>) => Promise<T>;
  beforeEnqueue?: (
    machineId: string,
    input: z.infer<typeof queueMachineCommandSchema>,
    requestId?: string,
  ) => Promise<void>;
  private waiters = new Map<string, Set<() => void>>();
  private closed = false;
  constructor(
    private readonly db: Database.Database,
    readonly resources: UpstreamResources,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL,
        token_hash TEXT NOT NULL, resource_id TEXT NOT NULL UNIQUE, snapshot_file_id TEXT NOT NULL UNIQUE,
        last_seen INTEGER, agent_version TEXT, boot_id TEXT, revision TEXT,
        snapshot_revision TEXT, snapshot_hash TEXT, snapshot_sequence INTEGER NOT NULL DEFAULT 0, sync_error TEXT
      );
      CREATE TABLE IF NOT EXISTS machine_tasks (
        id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id), action TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        expected_revision TEXT NOT NULL, result_revision TEXT, message TEXT NOT NULL,
        file_id TEXT NOT NULL UNIQUE, delivery_sequence INTEGER, finished INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS machine_active_task ON machine_tasks(machine_id) WHERE finished=0;
    `);
    db.prepare(
      "UPDATE machine_tasks SET status='unknown', message=?, updated_at=? WHERE status='running' AND finished=0",
    ).run('服务已重启，等待机器确认原任务结果；重连沿用同一请求编号。', Date.now());
  }
  private row(id: string): MachineRow {
    const value: unknown = this.db.prepare('SELECT * FROM machines WHERE id=?').get(uuid.parse(id));
    if (!value) throw new AppError('MACHINE_NOT_FOUND', '机器不存在。', 404);
    return rowSchema.parse(value);
  }
  private taskRow(id: string): TaskRow {
    const value: unknown = this.db
      .prepare('SELECT * FROM machine_tasks WHERE id=?')
      .get(uuid.parse(id));
    if (!value) throw new AppError('MACHINE_TASK_NOT_FOUND', '机器任务不存在。', 404);
    return taskRowSchema.parse(value);
  }
  private view(row: MachineRow): MachineView {
    return {
      id: row.id,
      name: row.name,
      enabled: !!row.enabled,
      online: !!row.enabled && row.last_seen !== null && Date.now() - row.last_seen < 90_000,
      lastSeen: row.last_seen,
      agentVersion: row.agent_version,
      revision: row.revision,
      snapshotRevision: row.snapshot_revision,
      syncError: row.sync_error,
      resourceId: row.resource_id,
    };
  }
  private taskView(row: TaskRow): MachineTask {
    return {
      id: row.id,
      machineId: row.machine_id,
      action: row.action,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expectedRevision: row.expected_revision,
      resultRevision: row.result_revision,
      message: row.message,
    };
  }
  list(): MachineView[] {
    return z
      .array(rowSchema)
      .parse(this.db.prepare('SELECT * FROM machines ORDER BY rowid').all())
      .map((row) => this.view(row));
  }
  async overview(): Promise<MachineView[]> {
    const rows = z
      .array(rowSchema)
      .parse(this.db.prepare('SELECT * FROM machines ORDER BY rowid').all());
    if (!rows.length) return [];
    return this.resources.client.exclusive(async () => {
      try {
        await this.resources.syncUnlocked();
      } catch {
        return rows.map((row) => ({
          ...this.view(row),
          syncError: '机器摘要暂不可用，请检查 Sub-Store 连接。',
        }));
      }
      return rows.map((row) => {
        const machine = this.view(row);
        try {
          const snapshot = this.envelope(row)?.snapshot;
          if (!snapshot) return machine;
          const visible = publicSnapshot(snapshot);
          return {
            ...machine,
            summary: {
              addresses: [
                ...new Set(
                  visible.nodes.flatMap((node) =>
                    typeof node.address === 'string' && node.address !== '[已隐藏]'
                      ? [node.address]
                      : [],
                  ),
                ),
              ],
              nodeCount: visible.nodes.length,
              cores: visible.cores,
              pendingCores: visible.pendingCores,
            },
          };
        } catch {
          return { ...machine, syncError: '机器摘要无法读取，请检查当前快照。' };
        }
      });
    });
  }
  task(id: string): MachineTask {
    return this.taskView(this.taskRow(id));
  }
  activeTask(id: string): MachineTask | null {
    this.row(id);
    const value: unknown = this.db
      .prepare('SELECT * FROM machine_tasks WHERE machine_id=? AND finished=0')
      .get(uuid.parse(id));
    return value ? this.taskView(taskRowSchema.parse(value)) : null;
  }
  async detail(id: string): Promise<MachineDetail> {
    const row = this.row(id);
    let snapshot: MachineSnapshot | null = null;
    try {
      snapshot = await this.getPrivateSnapshot(row.id);
    } catch {
      this.db
        .prepare('UPDATE machines SET sync_error=? WHERE id=?')
        .run('无法读取 Sub-Store 中的机器快照。', row.id);
    }
    return {
      machine: this.view(this.row(id)),
      snapshot: snapshot ? publicSnapshot(snapshot) : null,
      tasks: z
        .array(taskRowSchema)
        .parse(
          this.db
            .prepare(
              'SELECT * FROM machine_tasks WHERE machine_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100',
            )
            .all(row.id),
        )
        .map((task) => this.taskView(task)),
    };
  }
  create(input: unknown) {
    const { name } = createMachineSchema.parse(input),
      id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO machines(id,name,enabled,token_hash,resource_id,snapshot_file_id) VALUES(?,?,1,?,?,?)',
      )
      .run(id, name, digest(token).toString('hex'), randomUUID(), randomUUID());
    this.changed(id);
    return { machine: this.view(this.row(id)), token };
  }
  async update(id: string, input: unknown) {
    const patch = patchSchema.parse(input);
    return this.resources.client.exclusive(async () => {
      const row = this.row(id);
      this.db
        .prepare('UPDATE machines SET name=?,enabled=? WHERE id=?')
        .run(
          patch.name ?? row.name,
          patch.enabled === undefined ? row.enabled : Number(patch.enabled),
          row.id,
        );
      this.changed(row.id);
      return { machine: this.view(this.row(row.id)) };
    });
  }
  async rotateToken(id: string) {
    return this.resources.client.exclusive(async () => {
      const row = this.row(id),
        token = randomBytes(32).toString('base64url');
      this.db
        .prepare('UPDATE machines SET token_hash=? WHERE id=?')
        .run(digest(token).toString('hex'), row.id);
      this.changed(row.id);
      return { machine: this.view(this.row(row.id)), token };
    });
  }
  private deletionLock<T>(operation: () => Promise<T>) {
    const locked = () => this.resources.client.exclusive(operation);
    return this.coordinateDeletion ? this.coordinateDeletion(locked) : locked();
  }
  private async rawCatalog(): Promise<Entry[]> {
    return (
      await Promise.all(
        (['sub', 'collection', 'file'] as const).map(async (type) =>
          (await this.resources.client.records(type)).map((record) => ({ type, record })),
        ),
      )
    ).flat();
  }
  private deletionTasks(id: string) {
    return z
      .array(taskRowSchema)
      .parse(this.db.prepare('SELECT * FROM machine_tasks WHERE machine_id=? ORDER BY id').all(id));
  }
  private ownedResources(row: MachineRow, tasks: TaskRow[], catalog: Entry[]): OwnedResource[] {
    const expected = new Map<string, OwnedResource['role']>([
      [row.resource_id, 'machine-source'],
      [row.snapshot_file_id, 'machine-snapshot'],
      ...tasks.map((task) => [task.file_id, 'machine-command'] as const),
    ]);
    const names = new Map(
      [...expected].map(([id, role]) => [
        role === 'machine-source' ? 'sub/sm-machine-' + row.id : 'file/sm-' + role + '-' + id,
        id,
      ]),
    );
    const owned: OwnedResource[] = [];
    const conflict = () => {
      throw new AppError(
        'MACHINE_RESOURCE_CONFLICT',
        '机器资源的 UUID、用途、所属机器或类型已变化，未删除；请先修正 Sub-Store 中的冲突。',
        409,
      );
    };
    for (const entry of catalog) {
      const value = entry.record[identityKey];
      const raw =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      // The retired chain boundary applies before identity checks or body parsing.
      if (entry.type === 'file' && raw.role === 'chain') continue;
      const id = typeof raw.id === 'string' ? raw.id : '';
      const parentOwned =
        raw.parent === row.id &&
        ['machine-source', 'machine-snapshot', 'machine-command'].includes(String(raw.role));
      if (parentOwned && raw.role === 'machine-command') {
        if (
          !uuid.safeParse(id).success ||
          (expected.has(id) && expected.get(id) !== 'machine-command')
        )
          conflict();
        expected.set(id, 'machine-command');
      }
      const named = names.get(entry.type + '/' + entry.record.name);
      if (!parentOwned && !expected.has(id) && !named) continue;
      const role = expected.get(id);
      const meta = marker(entry.record);
      if (
        !role ||
        !meta ||
        (named && named !== id) ||
        meta.id !== id ||
        meta.role !== role ||
        meta.parent !== row.id ||
        meta.version !== 1 ||
        entry.type !== (role === 'machine-source' ? 'sub' : 'file') ||
        entry.record.source !== 'local' ||
        (entry.type === 'file' && entry.record.type !== 'file') ||
        ['localFirst', 'remoteFirst'].includes(String(entry.record.mergeSources)) ||
        owned.some((item) => item.id === id)
      )
        conflict();
      owned.push({ ...entry, id, role: role!, revision: hash(entry.record) });
    }
    return owned.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async deletionInventory(row: MachineRow) {
    const tasks = this.deletionTasks(row.id);
    // Validate raw identities first: sync assigns UUIDs to unmarked native resources.
    this.ownedResources(row, tasks, await this.rawCatalog());
    await this.resources.syncUnlocked();
    const catalog = [
      ...this.resources.listResources().map(({ id }) => this.resources.record(id)),
      ...this.resources.files().map(({ id }) => this.resources.record(id)),
    ];
    const owned = this.ownedResources(row, tasks, catalog);
    const source = owned.find((item) => item.role === 'machine-source');
    const blockers: Array<MachineDeletionPreview['blockers'][number] & { revision: string }> =
      machineRelayReferences(this.resources, row.id);
    for (const resource of this.resources.listResources()) {
      const entry = this.resources.record(resource.id);
      if (
        entry.type === 'collection' &&
        source &&
        Array.isArray(entry.record.subscriptions) &&
        entry.record.subscriptions.includes(source.record.name)
      )
        blockers.push({
          kind: 'collection',
          id: resource.id,
          name: resource.name,
          revision: resource.revision,
        });
    }
    for (const { id, record } of this.resources.files('plan')) {
      if (marker(record)?.version !== 1)
        throw new AppError('FILE_INVALID', '上游文件用途或格式版本不兼容。', 409);
      let plan;
      try {
        plan = readStoredSubscription(JSON.parse(String(record.content)));
      } catch {
        throw new AppError('PLAN_INVALID', '上游输出方案无法读取，请在原生文件页面修正。', 422);
      }
      if (
        plan.inputs.some(
          (input) => (input.kind === 'node' ? input.resourceId : input.id) === row.resource_id,
        )
      )
        blockers.push({ kind: 'plan', id, name: plan.name, revision: hash(record) });
    }
    blockers.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const snapshot = owned.find((item) => item.role === 'machine-snapshot');
    let nodes: number | null = row.revision ? null : 0;
    if (snapshot) {
      try {
        nodes = envelopeSchema.parse(JSON.parse(String(snapshot.record.content))).snapshot.nodes
          .length;
      } catch {
        nodes = null;
      }
    }
    const revision = hash({
      machine: {
        id: row.id,
        name: row.name,
        resourceId: row.resource_id,
        snapshotFileId: row.snapshot_file_id,
        tokenHash: row.token_hash,
      },
      resources: owned.map(({ id, type, role, revision }) => ({ id, type, role, revision })),
      tasks: tasks.map((task) => ({
        id: task.id,
        status: task.status,
        finished: task.finished,
        fileId: task.file_id,
        action: task.action,
        expectedRevision: task.expected_revision,
        resultRevision: task.result_revision,
      })),
      blockers,
    });
    const preview: MachineDeletionPreview = {
      machine: { id: row.id, name: row.name },
      revision,
      counts: {
        nodes,
        subscriptions: Number(!!source),
        tasks: tasks.length,
        files: owned.filter((item) => item.type === 'file').length,
      },
      unfinishedTasks: tasks
        .filter((task) => !task.finished || task.status === 'unknown')
        .map((task) => this.taskView(task)),
      blockers: blockers.map(({ kind, id, name }) => ({ kind, id, name })),
    };
    return { preview, owned, tasks };
  }
  deletionPreview(id: string): Promise<MachineDeletionPreview> {
    return this.deletionLock(async () => (await this.deletionInventory(this.row(id))).preview);
  }
  private async deletionResource(row: MachineRow, tasks: TaskRow[], item: OwnedResource) {
    let record: UpstreamRecord;
    try {
      record = upstreamRecordSchema.parse(
        await this.resources.client.api(
          '/api/' +
            (item.type === 'file' ? 'wholeFile' : 'sub') +
            '/' +
            encodeURIComponent(item.record.name),
        ),
      );
    } catch (error) {
      // The pinned upstream also returns 500 for some missing single-record GETs.
      // Only a fresh catalog can distinguish absence, a rename and a read failure.
      if (!(error instanceof AppError) || error.code !== 'SUB_STORE_FAILED') throw error;
      return this.ownedResources(row, tasks, await this.rawCatalog()).find(
        (entry) => entry.id === item.id,
      );
    }
    if (record.name !== item.record.name)
      throw new AppError('REVISION_CONFLICT', '删除期间机器资源名称已变化。', 409);
    const checked = this.ownedResources(row, tasks, [{ type: item.type, record }]).find(
      (entry) => entry.id === item.id,
    );
    if (!checked)
      throw new AppError('MACHINE_RESOURCE_CONFLICT', '待删除资源名称已被其他身份占用。', 409);
    return checked;
  }
  async remove(id: string, input: unknown) {
    const machineId = uuid.parse(id),
      { revision } = deleteMachineSchema.parse(input);
    return this.deletionLock(async () => {
      const value: unknown = this.db.prepare('SELECT * FROM machines WHERE id=?').get(machineId);
      if (!value) return { deleted: true as const };
      const row = rowSchema.parse(value);
      const { preview, owned, tasks } = await this.deletionInventory(row);
      if (preview.revision !== revision)
        throw new AppError(
          'REVISION_CONFLICT',
          '机器删除范围或引用已变化，请重新预览并确认。',
          409,
        );
      if (preview.blockers.length)
        throw new AppError(
          'MACHINE_REFERENCED',
          '机器仍被中转线路、组合或输出方案引用，请先解除引用。',
          409,
        );
      this.db.prepare('UPDATE machines SET enabled=0 WHERE id=?').run(row.id);
      this.wake(row.id);
      try {
        for (const item of owned) {
          const current = () => this.deletionResource(row, tasks, item);
          const checked = await current();
          if (!checked) continue;
          if (checked.revision !== item.revision)
            throw new AppError('REVISION_CONFLICT', '删除期间机器资源已变化。', 409);
          await this.resources.client.revoke(checked.record.name, checked.type);
          const beforeDelete = await current();
          if (!beforeDelete) continue;
          if (beforeDelete.revision !== item.revision)
            throw new AppError('REVISION_CONFLICT', '删除期间机器资源已变化。', 409);
          await this.resources.client.api(
            '/api/' + beforeDelete.type + '/' + encodeURIComponent(beforeDelete.record.name),
            undefined,
            'DELETE',
          );
        }
        if (this.ownedResources(row, tasks, await this.rawCatalog()).length)
          throw new AppError('REVISION_CONFLICT', '删除期间出现新的机器资源。', 409);
        await this.resources.syncUnlocked();
        this.db.transaction(() => {
          this.db.prepare('DELETE FROM machine_tasks WHERE machine_id=?').run(row.id);
          this.db.prepare('DELETE FROM machines WHERE id=?').run(row.id);
        })();
        this.wake(row.id);
        return { deleted: true as const };
      } catch {
        await this.resources.syncUnlocked().catch(() => {});
        throw new AppError(
          'MACHINE_DELETE_INCOMPLETE',
          '机器已停用，但删除未完成，部分上游资源可能已清理。任务记录仍保留；请重新读取删除预览，确认 Agent 已卸载后重试。',
          502,
        );
      }
    });
  }
  authorize(id: string, authorization?: string) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1];
    const value: unknown = this.db.prepare('SELECT * FROM machines WHERE id=?').get(uuid.parse(id));
    const row = value ? rowSchema.parse(value) : null;
    if (!token || !row || !timingSafeEqual(digest(token), Buffer.from(row.token_hash, 'hex')))
      throw new AppError('MACHINE_UNAUTHENTICATED', '机器 Token 缺失、无效或不属于此机器。', 401);
    if (!row.enabled) throw new AppError('MACHINE_DISABLED', '此机器接入已停用。', 403);
    if (this.closed) throw new AppError('MACHINE_UNAVAILABLE', '机器管理正在停止。', 503);
    return row;
  }
  private entry(id: string): Entry | undefined {
    try {
      return this.resources.record(id);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return undefined;
      throw error;
    }
  }
  private file(id: string, role: string, parent: string): UpstreamRecord | undefined {
    const entry = this.entry(id);
    if (!entry) return undefined;
    const meta = marker(entry.record);
    if (
      entry.type !== 'file' ||
      meta?.role !== role ||
      meta.version !== 1 ||
      meta.parent !== parent ||
      entry.record.source !== 'local' ||
      entry.record.type !== 'file' ||
      (Array.isArray(entry.record.process) && entry.record.process.length) ||
      ['localFirst', 'remoteFirst'].includes(String(entry.record.mergeSources))
    )
      throw new AppError('MACHINE_FILE_CONFLICT', '机器私有文件的 UUID、用途或格式已被修改。', 409);
    return entry.record;
  }
  private async putFile(id: string, role: string, parent: string, data: unknown) {
    const existing = this.file(id, role, parent),
      content = JSON.stringify(data),
      name = 'sm-' + role + '-' + id;
    if (existing?.content === content) return;
    if (existing)
      await this.resources.client.api(
        '/api/file/' + encodeURIComponent(existing.name),
        { content },
        'PATCH',
      );
    else {
      if ((await this.resources.client.records('file')).some((record) => record.name === name))
        throw new AppError('MACHINE_FILE_CONFLICT', '机器私有文件的内部名称已被占用。', 409);
      await this.resources.client.api('/api/files', {
        name,
        displayName: name,
        type: 'file',
        source: 'local',
        content,
        url: '',
        process: [],
        [identityKey]: { id, role, version: 1, parent },
      });
    }
    await this.resources.syncUnlocked();
  }
  private envelope(row: MachineRow): Envelope | null {
    const file = this.file(row.snapshot_file_id, 'machine-snapshot', row.id);
    if (!file) {
      if (row.revision)
        throw new AppError('MACHINE_SNAPSHOT_MISSING', '已上报的机器快照文件不存在。', 409);
      return null;
    }
    try {
      return envelopeSchema.parse(JSON.parse(String(file.content)));
    } catch {
      throw new AppError('MACHINE_SNAPSHOT_INVALID', '机器快照文件格式无效。', 409);
    }
  }
  async getPrivateSnapshot(id: string): Promise<MachineSnapshot | null> {
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      return this.envelope(this.row(id))?.snapshot ?? null;
    });
  }
  async getTunnelReports(id: string) {
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      return this.envelope(this.row(id))?.tunnels ?? [];
    });
  }
  private async project(row: MachineRow, envelope: Envelope) {
    const client = this.resources.client;
    const exports = cores.flatMap((core) => envelope.applied[core].exports);
    if (exports.length > 2000)
      throw new AppError('MACHINE_EXPORT_LIMIT', '已生效的机器节点总数超过 2,000。', 413);
    const published = exports.map((item) => {
      if (item.kind !== 'forward') return item;
      const fragment = item.uri.indexOf('#');
      return {
        ...item,
        uri:
          (fragment < 0 ? item.uri : item.uri.slice(0, fragment)) +
          '#' +
          encodeURIComponent(item.name),
      };
    });
    const content = published.map((item) => item.uri).join('\n');
    const old = this.entry(row.resource_id),
      meta = old && marker(old.record);
    const changedContent = old?.record.content !== content;
    for (const [index, item] of (changedContent ? published : []).entries()) {
      const parsed = await client.convert(item.uri, 'JSON', true);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 1 ||
        !parsed[0] ||
        typeof parsed[0] !== 'object'
      )
        throw new AppError(
          'MACHINE_EXPORT_INVALID',
          '第 ' + (index + 1) + ' 个已生效节点不能被 Sub-Store 完整解析。',
          422,
        );
    }
    const name = 'sm-machine-' + row.id;
    if (exports.length && changedContent) {
      const preview = await client.preview(
        'sub',
        { name, source: 'local', content, process: [] },
        true,
      );
      if (preview.original.length !== exports.length)
        throw new AppError(
          'MACHINE_EXPORT_INVALID',
          '机器节点完整解析数量不一致，保留原订阅。',
          422,
        );
    }
    if (
      old &&
      (old.type !== 'sub' ||
        meta?.role !== 'machine-source' ||
        meta.version !== 1 ||
        meta.parent !== row.id ||
        old.record.source !== 'local' ||
        ['localFirst', 'remoteFirst'].includes(String(old.record.mergeSources)))
    )
      throw new AppError(
        'MACHINE_RESOURCE_CONFLICT',
        '机器订阅的 UUID、用途或来源已被其他资源占用。',
        409,
      );
    if (
      !old &&
      this.resources
        .listResources()
        .some((resource) => resource.type === 'sub' && resource.upstreamName === name)
    )
      throw new AppError('MACHINE_RESOURCE_CONFLICT', '机器订阅内部名称已被占用。', 409);
    const deploymentRevision = hash({
      applied: envelope.applied,
      tunnels: envelope.tunnels.map(({ id, revision, running }) => ({ id, revision, running })),
    });
    const identity = {
      ...meta,
      id: row.resource_id,
      role: 'machine-source',
      version: 1,
      parent: row.id,
      deploymentRevision,
    };
    if (old) {
      if (
        old.record.content !== content ||
        old.record.displayName !== row.name ||
        hash(old.record[identityKey]) !== hash(identity)
      )
        await client.api(
          '/api/sub/' + encodeURIComponent(old.record.name),
          { content, displayName: row.name, [identityKey]: identity },
          'PATCH',
        );
    } else
      await client.api('/api/subs', {
        name,
        displayName: row.name,
        source: 'local',
        content,
        url: '',
        process: [],
        [identityKey]: identity,
      });
    await this.resources.syncUnlocked();
    this.db
      .prepare('UPDATE machines SET snapshot_revision=?,sync_error=NULL WHERE id=?')
      .run(envelope.snapshot.revision, row.id);
  }
  private async saveSnapshot(
    row: MachineRow,
    snapshot: MachineSnapshot,
    tunnels: Envelope['tunnels'],
  ) {
    const previous = this.envelope(row);
    const applied = {
      'sing-box': { revision: null, exports: [] },
      xray: { revision: null, exports: [] },
    } as Envelope['applied'];
    for (const core of cores)
      applied[core] = snapshot.pendingCores.includes(core)
        ? (previous?.applied[core] ?? applied[core])
        : {
            revision: snapshot.revision,
            exports: snapshot.exports.filter((item) => item.core === core),
          };
    const envelope: Envelope = { schemaVersion: 1, snapshot, applied, tunnels };
    await this.putFile(row.snapshot_file_id, 'machine-snapshot', row.id, envelope);
    const snapshotHash = hash(snapshot);
    this.db
      .prepare(
        'UPDATE machines SET revision=?,snapshot_hash=?,snapshot_sequence=snapshot_sequence+? WHERE id=?',
      )
      .run(snapshot.revision, snapshotHash, Number(row.snapshot_hash !== snapshotHash), row.id);
    try {
      await this.project(this.row(row.id), envelope);
    } catch (error) {
      this.db
        .prepare('UPDATE machines SET sync_error=? WHERE id=?')
        .run(
          error instanceof AppError
            ? error.message
            : '机器快照已保存，但节点同步失败；下次上报会重试。',
          row.id,
        );
    }
  }
  async report(input: unknown, authorization?: string, signal?: AbortSignal) {
    const parsed = machineReportSchema.parse(input),
      id = uuid.parse(parsed.machineId);
    this.authorize(id, authorization);
    const snapshot = checkedSnapshot(parsed.snapshot);
    return this.resources.client.exclusive(async () => {
      signal?.throwIfAborted();
      this.authorize(id, authorization);
      await this.resources.syncUnlocked();
      const row = this.authorize(id, authorization);
      await this.saveSnapshot(row, snapshot, parsed.tunnels);
      this.db
        .prepare('UPDATE machines SET last_seen=?,agent_version=?,boot_id=? WHERE id=?')
        .run(Date.now(), parsed.agentVersion, parsed.bootId, id);
      this.changed(id);
      return { machine: this.view(this.row(id)) };
    });
  }
  async enqueue(id: string, input: unknown, suppliedRequestId?: string) {
    const value = queueMachineCommandSchema.parse(input);
    const requestId = suppliedRequestId ? uuid.parse(suppliedRequestId) : randomUUID();
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '机器操作参数超过 1 MiB。', 413);
    await this.beforeEnqueue?.(uuid.parse(id), value, suppliedRequestId);
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      const row = this.row(id);
      const existing: unknown = this.db
        .prepare('SELECT * FROM machine_tasks WHERE id=?')
        .get(requestId);
      if (existing) {
        const task = taskRowSchema.parse(existing),
          file = this.file(task.file_id, 'machine-command', row.id);
        if (
          task.machine_id !== row.id ||
          !file ||
          !this.sameCommand(file.content, { ...value, schemaVersion: 1, requestId })
        )
          throw new AppError('MACHINE_REQUEST_CONFLICT', '此请求编号已用于其他机器操作。', 409);
        return { task: this.taskView(task) };
      }
      if (!row.enabled)
        throw new AppError('MACHINE_DISABLED', '此机器已停用，请启用后再操作。', 403);
      const snapshot = this.envelope(row)?.snapshot;
      if (row.revision !== value.expectedRevision || snapshot?.revision !== value.expectedRevision)
        throw new AppError('REVISION_CONFLICT', '机器配置已变化或尚未上报，请刷新后重试。', 409);
      if (this.activeTask(row.id))
        throw new AppError('MACHINE_BUSY', '此机器仍有未完成操作。', 409);
      if (!snapshot.capabilities.actions.includes(value.action))
        throw new AppError(
          'MACHINE_ACTION_UNSUPPORTED',
          '此机器尚不支持该操作，请更新 Agent。',
          422,
        );
      const fileId = requestId,
        command: MachineCommand = { ...value, schemaVersion: 1, requestId };
      const orphan = this.file(fileId, 'machine-command', row.id);
      if (orphan && !this.sameCommand(orphan.content, command))
        throw new AppError(
          'MACHINE_REQUEST_CONFLICT',
          '此请求编号的待提交命令与本次操作不同。',
          409,
        );
      await this.putFile(fileId, 'machine-command', row.id, command);
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO machine_tasks(id,machine_id,action,status,created_at,updated_at,expected_revision,message,file_id) VALUES(?,?,?,'queued',?,?,?,'等待机器接收。',?)",
        )
        .run(requestId, row.id, value.action, now, now, value.expectedRevision, fileId);
      this.changed(row.id);
      return { task: this.task(requestId) };
    });
  }
  private sameCommand(content: unknown, expected: MachineCommand) {
    try {
      const command = machineCommandSchema.parse(JSON.parse(String(content)));
      const canonical = (value: MachineCommand) => ({
        schemaVersion: value.schemaVersion,
        requestId: value.requestId,
        action: value.action,
        expectedRevision: value.expectedRevision,
        params: Object.fromEntries(
          Object.entries(value.params).sort(([a], [b]) => a.localeCompare(b)),
        ),
      });
      return hash(canonical(command)) === hash(canonical(expected));
    } catch {
      return false;
    }
  }
  async cancel(id: string, taskId: string) {
    return this.resources.client.exclusive(async () => {
      const row = this.row(id),
        task = this.taskRow(taskId);
      if (task.machine_id !== row.id)
        throw new AppError('MACHINE_TASK_NOT_FOUND', '此任务不属于该机器。', 404);
      if (task.status === 'cancelled') return { task: this.taskView(task) };
      if (task.status !== 'queued')
        throw new AppError(
          'MACHINE_TASK_RUNNING',
          '机器已可能开始执行；不能将运行中操作标记为已取消。',
          409,
        );
      this.db
        .prepare(
          "UPDATE machine_tasks SET status='cancelled',finished=1,message=?,updated_at=? WHERE id=?",
        )
        .run('已取消尚未投递的操作。', Date.now(), task.id);
      this.changed(row.id);
      return { task: this.task(task.id) };
    });
  }
  private async delivery(id: string, authorization?: string): Promise<MachineCommand | null> {
    return this.resources.client.exclusive(async () => {
      const row = this.authorize(id, authorization),
        active = this.activeTask(row.id);
      if (!active) return null;
      const task = this.taskRow(active.id);
      await this.resources.syncUnlocked();
      const file = this.file(task.file_id, 'machine-command', row.id);
      if (!file)
        throw new AppError('MACHINE_COMMAND_MISSING', '待执行命令文件不存在，未投递。', 409);
      let command: MachineCommand;
      try {
        command = machineCommandSchema.parse(JSON.parse(String(file.content)));
      } catch {
        throw new AppError('MACHINE_COMMAND_INVALID', '待执行命令文件格式无效，未投递。', 409);
      }
      if (
        command.requestId !== task.id ||
        command.action !== task.action ||
        command.expectedRevision !== task.expected_revision
      )
        throw new AppError('MACHINE_COMMAND_INVALID', '待执行命令身份或版本不一致，未投递。', 409);
      const latest = this.authorize(id, authorization);
      if (task.delivery_sequence === null && latest.revision !== task.expected_revision) {
        this.db
          .prepare(
            "UPDATE machine_tasks SET status='conflict',finished=1,message=?,updated_at=? WHERE id=?",
          )
          .run('排队期间机器版本已变化，操作未投递。', Date.now(), task.id);
        this.changed(row.id);
        return null;
      }
      this.db
        .prepare(
          "UPDATE machine_tasks SET status='running',updated_at=?,delivery_sequence=COALESCE(delivery_sequence,?),message=? WHERE id=?",
        )
        .run(
          Date.now(),
          latest.snapshot_sequence,
          '已投递，等待机器确认；重试沿用同一请求编号。',
          task.id,
        );
      this.changed(row.id);
      return command;
    });
  }
  async poll(id: string, authorization?: string, waitSeconds = 25, signal?: AbortSignal) {
    const machineId = uuid.parse(id),
      duration = z.number().int().min(0).max(25).parse(waitSeconds),
      end = Date.now() + duration * 1000;
    for (;;) {
      signal?.throwIfAborted();
      this.authorize(machineId, authorization);
      const command = await this.delivery(machineId, authorization);
      this.authorize(machineId, authorization);
      if (command || Date.now() >= end) return { command };
      await new Promise<void>((resolve, reject) => {
        const listeners = this.waiters.get(machineId) ?? new Set<() => void>();
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          listeners.delete(finish);
          if (!listeners.size) this.waiters.delete(machineId);
          resolve();
        };
        const abort = () => {
          finish();
          reject(signal?.reason);
        };
        const timer = setTimeout(finish, Math.min(1000, Math.max(0, end - Date.now())));
        listeners.add(finish);
        this.waiters.set(machineId, listeners);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  async result(input: unknown, authorization?: string, signal?: AbortSignal) {
    const { machineId, result } = resultInputSchema.parse(input);
    this.authorize(machineId, authorization);
    const snapshot = result.snapshot ? checkedSnapshot(result.snapshot) : undefined;
    if (snapshot && snapshot.revision !== result.revision)
      throw new AppError('MACHINE_RESULT_INVALID', '执行结果与附带快照版本不一致。', 422);
    return this.resources.client.exclusive(async () => {
      signal?.throwIfAborted();
      let row = this.authorize(machineId, authorization);
      const task = this.taskRow(result.requestId);
      if (task.machine_id !== row.id)
        throw new AppError('MACHINE_TASK_NOT_FOUND', '此任务不属于该机器。', 404);
      if (task.finished) return { task: this.taskView(task) };
      if (task.delivery_sequence === null)
        throw new AppError('MACHINE_RESULT_INVALID', '任务尚未投递，不能接受执行结果。', 409);
      if (snapshot) {
        await this.resources.syncUnlocked();
        row = this.authorize(machineId, authorization);
        if (
          row.snapshot_sequence === task.delivery_sequence &&
          row.revision === task.expected_revision
        )
          await this.saveSnapshot(row, snapshot, this.envelope(row)?.tunnels ?? []);
      }
      this.db
        .prepare(
          'UPDATE machine_tasks SET status=?,finished=1,result_revision=?,message=?,updated_at=? WHERE id=?',
        )
        .run(
          result.status,
          result.revision,
          messages[result.status] + '（退出码 ' + result.exitCode + '）',
          Date.now(),
          task.id,
        );
      this.db.prepare('UPDATE machines SET last_seen=? WHERE id=?').run(Date.now(), row.id);
      this.changed(row.id);
      return { task: this.task(task.id) };
    });
  }
  private wake(id: string) {
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
  }
  private changed(id: string) {
    this.wake(id);
    if (this.onChange)
      void Promise.resolve()
        .then(() => this.onChange?.(id))
        .catch(() => {});
  }
  close() {
    this.closed = true;
    for (const id of this.waiters.keys()) this.changed(id);
  }
}
