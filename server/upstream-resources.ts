import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  SubStoreClient,
  identityKey,
  upstreamIdentitySchema,
  type UpstreamRecord,
} from './sub-store.js';
import type { InputChanges } from './subscriptions.js';
import { parseInput } from './converter/engine.js';
import {
  nodeSummarySchema,
  storedNodeSchema,
  type NodeDraft,
  type ParseResult,
} from './shared/contracts.js';
import { sourceSchema } from './shared/subscriptions.js';

export const stateOperation = '_submeldEnabled';
export function enabled(record: UpstreamRecord) {
  return (
    !Array.isArray(record.process) ||
    !record.process.some(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        stateOperation in p &&
        !('disabled' in p && p.disabled),
    )
  );
}
export function withEnabled(record: UpstreamRecord, value: boolean): UpstreamRecord {
  const process = (Array.isArray(record.process) ? record.process : []).filter(
    (p) => !(typeof p === 'object' && p !== null && stateOperation in p),
  );
  if (!value)
    process.push({ type: 'Regex Filter', args: { regex: [], keep: true }, [stateOperation]: true });
  return { ...record, process };
}
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
const metadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  upstream_name: z.string(),
  upstream_type: z.enum(['sub', 'collection']),
  enabled: z.number(),
  revision: z.number(),
  fingerprint: z.string(),
  present: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Credentials and parsed snapshots live only in memory; SQLite contains references and hashes. */
export class UpstreamResources {
  private records = new Map<string, { type: 'sub' | 'collection'; record: UpstreamRecord }>();
  private drafts = new Map<string, NodeDraft>();
  private snapshots = new Map<string, ParseResult>();
  constructor(
    readonly db: Database.Database,
    readonly client: SubStoreClient,
    private changes: InputChanges,
  ) {}

  sync() {
    return this.client.exclusive(() => this.syncUnlocked());
  }
  private async syncUnlocked(alreadyInvalidated = false) {
    const catalog = (
      await Promise.all(
        (['sub', 'collection'] as const).map(async (type) =>
          (await this.client.records(type)).map((record) => ({ type, record })),
        ),
      )
    ).flat();
    const next = new Map<string, { type: 'sub' | 'collection'; record: UpstreamRecord }>();
    const draftUpdates = new Map<string, NodeDraft>();
    for (const entry of catalog) {
      let identity = upstreamIdentitySchema.safeParse(entry.record[identityKey]);
      if (!identity.success) {
        const marker = { id: randomUUID(), kind: 'source' as const };
        await this.client.api(
          `/api/${entry.type}/${encodeURIComponent(entry.record.name)}`,
          { [identityKey]: marker },
          'PATCH',
        );
        entry.record = { ...entry.record, [identityKey]: marker };
        identity = upstreamIdentitySchema.safeParse(marker);
      }
      if (!identity.success) throw new Error('Invalid generated identity');
      const { id, kind } = identity.data;
      if (next.has(id))
        throw new AppError(
          'UPSTREAM_ID_DUPLICATE',
          '上游资源标记重复，请删除重复标记后重新绑定。',
          409,
        );
      next.set(id, entry);
      if (kind === 'node') {
        if (hash(this.records.get(id)?.record) === hash(entry.record) && this.drafts.has(id)) {
          const draft = this.drafts.get(id);
          if (draft) draftUpdates.set(id, draft);
        } else if (
          entry.type === 'sub' &&
          entry.record.source === 'local' &&
          typeof entry.record.content === 'string'
        ) {
          try {
            let text = entry.record.content;
            const json = text.trim().startsWith('{');
            if (json) {
              const value: unknown = JSON.parse(text);
              if (value && typeof value === 'object' && 'type' in value)
                text = JSON.stringify({ proxies: [value] });
            }
            const parsed = await parseInput({ text, format: json ? 'yaml' : 'auto' }, this.client);
            const item = parsed.items[0];
            if (
              parsed.items.length === 1 &&
              item?.draft &&
              !item.diagnostics.some((d) => d.level === 'error')
            )
              draftUpdates.set(id, item.draft);
          } catch (error) {
            if (error instanceof AppError && error.status >= 500) throw error;
            // Keep the reference repairable through the native editor; node() explains the invalid content.
          }
        }
      }
    }
    const affected = new Set<string>();
    this.db.transaction(() => {
      for (const [id, entry] of next) {
        const { kind } = upstreamIdentitySchema.parse(entry.record[identityKey]);
        const table = kind === 'node' ? 'nodes' : 'sources';
        const raw: unknown = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
        const old = raw ? metadataSchema.parse(raw) : null;
        const fingerprint = hash(entry.record);
        const draft = draftUpdates.get(id);
        const name =
          draft?.name ??
          (typeof entry.record.displayName === 'string'
            ? entry.record.displayName
            : entry.record.name);
        const now = new Date().toISOString();
        if (!old) {
          this.db
            .prepare(
              `INSERT INTO ${table}(id,name,upstream_name,upstream_type,enabled,revision,fingerprint,present,created_at,updated_at) VALUES (?,?,?,?,?,1,?,1,?,?)`,
            )
            .run(
              id,
              name,
              entry.record.name,
              entry.type,
              Number(enabled(entry.record)),
              fingerprint,
              now,
              now,
            );
        } else if (old.fingerprint !== fingerprint || !old.present) {
          this.db
            .prepare(
              `UPDATE ${table} SET name=?,upstream_name=?,upstream_type=?,enabled=?,revision=revision+1,fingerprint=?,present=1,updated_at=? WHERE id=?`,
            )
            .run(
              name,
              entry.record.name,
              entry.type,
              Number(enabled(entry.record)),
              fingerprint,
              now,
              id,
            );
          if (!alreadyInvalidated)
            for (const sub of this.changes.invalidateInput(kind, id)) affected.add(sub);
          if (kind === 'source') {
            this.snapshots.delete(id);
            this.db
              .prepare("UPDATE sources SET snapshot_hash='',saved_at=NULL,node_count=0 WHERE id=?")
              .run(id);
          }
        }
        if (draft)
          this.db.prepare('UPDATE nodes SET protocol=? WHERE id=?').run(draft.protocol, id);
      }
      for (const table of ['nodes', 'sources'] as const) {
        const existing = z
          .array(z.object({ id: z.string() }))
          .parse(this.db.prepare(`SELECT id FROM ${table} WHERE present=1`).all());
        for (const { id } of existing)
          if (!next.has(id)) {
            this.db
              .prepare(`UPDATE ${table} SET present=0,enabled=0,revision=revision+1 WHERE id=?`)
              .run(id);
            this.snapshots.delete(id);
            if (!alreadyInvalidated)
              for (const sub of this.changes.invalidateInput(
                table === 'nodes' ? 'node' : 'source',
                id,
              ))
                affected.add(sub);
          }
      }
    })();
    this.records = next;
    this.drafts = draftUpdates;
    this.changes.notify([...affected]);
  }
  record(id: string) {
    const item = this.records.get(id);
    if (!item)
      throw new AppError(
        'UPSTREAM_REFERENCE_MISSING',
        '上游资源或身份标记已删除，请重新绑定。',
        404,
      );
    return item;
  }
  nodeSummary(id: string) {
    const row = metadataSchema
      .extend({ protocol: z.string() })
      .parse(this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id));
    return nodeSummarySchema.parse({
      id,
      name: row.name,
      protocol: row.protocol,
      enabled: !!row.enabled && !!row.present,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  node(id: string) {
    this.record(id);
    const draft = this.drafts.get(id);
    if (!draft)
      throw new AppError(
        'UPSTREAM_NODE_INVALID',
        '此上游本地订阅必须完整包含一个受支持节点，请在 Sub-Store 修正。',
        422,
      );
    return storedNodeSchema.parse({
      ...this.nodeSummary(id),
      draft: structuredClone(draft),
      modelVersion: 1,
    });
  }
  source(id: string) {
    this.record(id);
    const row = metadataSchema
      .extend({
        snapshot_hash: z.string(),
        saved_at: z.string().nullable(),
        node_count: z.number(),
        last_attempt_at: z.string().nullable(),
        error_json: z.string().nullable(),
      })
      .parse(this.db.prepare('SELECT * FROM sources WHERE id=?').get(id));
    const snapshot = this.snapshots.get(id);
    return sourceSchema.parse({
      id,
      name: row.name,
      enabled: !!row.enabled && !!row.present,
      revision: row.revision,
      kind: 'upstream',
      format: 'auto',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodeCount: row.node_count,
      savedAt: row.saved_at,
      snapshotHash: row.snapshot_hash,
      lastAttemptAt: row.last_attempt_at,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      refresh: 'idle',
      modelVersion: 1,
      items: snapshot?.items ?? [],
      diagnostics: snapshot?.diagnostics ?? [],
      upstreamName: row.upstream_name,
      upstreamType: row.upstream_type,
    });
  }
  async refresh(id: string, force = false) {
    const before = this.source(id);
    const { type, record } = this.record(id);
    const path = type === 'sub' ? '/download/' : '/download/collection/';
    try {
      const response = await this.client.request(
        path + encodeURIComponent(record.name) + '?target=JSON' + (force ? '&noCache=true' : ''),
      );
      if (!response.ok) throw new AppError('UPSTREAM_SOURCE_FAILED', '上游订阅暂不可用。', 502);
      const values = z
        .array(z.record(z.string(), z.unknown()))
        .max(2000)
        .parse(await response.json());
      const parsed = await parseInput(
        { text: JSON.stringify({ proxies: values }), format: 'yaml' },
        this.client,
      );
      if (
        !values.length ||
        parsed.items.length !== values.length ||
        parsed.items.some((i) => !i.draft || i.diagnostics.some((d) => d.level === 'error'))
      )
        throw new AppError(
          'SOURCE_INVALID',
          '此上游订阅包含增强功能无法完整处理的节点，请在 Sub-Store 检查。',
          422,
          [...parsed.diagnostics, ...parsed.items.flatMap((item) => item.diagnostics)],
        );
      await this.client.exclusive(async () => {
        await this.syncUnlocked();
        if (this.source(id).revision !== before.revision)
          throw new AppError('REVISION_CONFLICT', '上游来源已修改，请重新载入。', 409);
        const fingerprint = hash(values),
          now = new Date().toISOString();
        const affected = this.db.transaction(() => {
          this.db
            .prepare(
              'UPDATE sources SET snapshot_hash=?,saved_at=?,node_count=?,last_attempt_at=?,error_json=NULL WHERE id=?',
            )
            .run(fingerprint, now, values.length, now, id);
          if (fingerprint !== before.snapshotHash) {
            this.db.prepare('DELETE FROM node_test_results WHERE source_id=?').run(id);
            return this.changes.updateInput('source', id);
          }
          return [];
        })();
        this.snapshots.set(id, parsed);
        this.changes.notify(affected);
      });
      return this.source(id);
    } catch (error) {
      this.db
        .prepare('UPDATE sources SET last_attempt_at=?,error_json=? WHERE id=? AND revision=?')
        .run(
          new Date().toISOString(),
          JSON.stringify({
            code: 'UPSTREAM_SOURCE_FAILED',
            message: '无法获取完整的上游节点，请检查 Sub-Store。',
          }),
          id,
          before.revision,
        );
      throw error instanceof AppError
        ? error
        : new AppError('UPSTREAM_SOURCE_FAILED', '无法获取完整的上游节点，请检查 Sub-Store。', 502);
    }
  }
  assertRemovable(ids: string[]) {
    for (const id of ids)
      if (
        this.db.prepare('SELECT id FROM chains WHERE entry_node_id=? OR exit_node_id=?').get(id, id)
      )
        throw new AppError('NODE_IN_USE', '节点正被链式代理引用，请先替换引用或删除链。', 422);
  }
  guardMutation(path: string, method: string, body: unknown) {
    const removed: string[] = [];
    for (const [id, { type, record }] of this.records) {
      if (type !== 'sub') continue;
      if (path === '/api/sub/' + encodeURIComponent(record.name)) {
        if (method === 'DELETE') removed.push(id);
        if (
          method === 'PATCH' &&
          typeof body === 'object' &&
          body !== null &&
          identityKey in body
        ) {
          const marker = upstreamIdentitySchema.safeParse(Reflect.get(body, identityKey));
          if (
            !marker.success ||
            marker.data.id !== id ||
            marker.data.kind !== upstreamIdentitySchema.parse(record[identityKey]).kind
          )
            removed.push(id);
        }
      }
      if (path === '/api/subs' && method === 'PUT' && Array.isArray(body)) {
        if (
          !body.some((value) => {
            if (!value || typeof value !== 'object') return false;
            const marker = upstreamIdentitySchema.safeParse(Reflect.get(value, identityKey));
            return (
              marker.success &&
              marker.data.id === id &&
              marker.data.kind === upstreamIdentitySchema.parse(record[identityKey]).kind
            );
          })
        )
          removed.push(id);
      }
    }
    this.assertRemovable(removed);
  }
  async write<T>(
    operation: () => Promise<T>,
    removed: string[] = [],
    validate: () => void = () => {},
  ) {
    return this.client.exclusive(async () => {
      await this.syncUnlocked();
      this.assertRemovable(removed);
      validate();
      // Invalidate before crossing the service boundary; a crash cannot republish pre-edit data.
      const affected = this.db.transaction(() => {
        const ids = z
          .array(z.object({ id: z.string() }))
          .parse(this.db.prepare('SELECT id FROM subscriptions').all())
          .map((v) => v.id);
        this.db.exec('UPDATE subscriptions SET revision=revision+1; DELETE FROM artifacts;');
        return ids;
      })();
      try {
        return await operation();
      } finally {
        await this.syncUnlocked(true);
        this.changes.notify(affected);
      }
    });
  }
}
