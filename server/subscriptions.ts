import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { diagnosticSchema, MAX_BYTES, MAX_NODES, type WorkbenchItem } from './shared/contracts.js';
import {
  artifactErrorSchema,
  artifactSchema,
  artifactStatusSchema,
  countsSchema,
  MAX_SUBSCRIPTIONS,
  outputFormatSchema,
  subscriptionConfigSchema,
  subscriptionSchema,
  subscriptionSummarySchema,
  subscriptionUpdateSchema,
  type OutputFormat,
  type SubscriptionConfig,
} from './shared/subscriptions.js';
import type { NodeStore } from './nodes.js';
import type { SourceStore } from './sources.js';

// Bump when conversion, composition or template semantics change.
export const ENGINE_VERSION = 'p4-1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.number(),
  revision: z.number(),
  config_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
const refRowSchema = z.object({ node_id: z.string().nullable(), source_id: z.string().nullable() });
const artifactRowSchema = z.object({
  format: outputFormatSchema,
  body: z.string().nullable(),
  generated_at: z.string().nullable(),
  built_revision: z.number().nullable(),
  engine_version: z.string().nullable(),
  counts_json: z.string().nullable(),
  diagnostics_json: z.string().nullable(),
  error_json: z.string().nullable(),
});
export type InputChanges = {
  invalidateInput(kind: 'node' | 'source', id: string): string[];
  updateInput(kind: 'node' | 'source', id: string): string[];
  notify(ids: string[]): void;
};
export type ArtifactWrite = {
  format: OutputFormat;
  content: string;
  counts: z.infer<typeof countsSchema>;
  diagnostics: z.infer<typeof diagnosticSchema>[];
};
export function createSubscriptionStore(db: Database.Database) {
  let listener: (ids: string[]) => void = () => {};
  function notify(ids: string[]) {
    listener(ids);
  }
  function get(id: string) {
    const raw: unknown = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
    if (!raw) throw new AppError('NOT_FOUND', '订阅方案不存在。', 404);
    const row = rowSchema.parse(raw);
    const refs = z
      .array(refRowSchema)
      .parse(
        db
          .prepare(
            'SELECT node_id,source_id FROM subscription_inputs WHERE subscription_id=? ORDER BY position',
          )
          .all(id),
      );
    const config: unknown = JSON.parse(row.config_json);
    const parsed = subscriptionConfigSchema
      .omit({ inputs: true, name: true, enabled: true })
      .parse(config);
    return subscriptionSchema.parse({
      ...parsed,
      id,
      name: row.name,
      enabled: row.enabled === 1,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      inputs: refs.map((r) =>
        r.node_id ? { kind: 'node', id: r.node_id } : { kind: 'source', id: r.source_id },
      ),
    });
  }
  function current(id: string, revision: number) {
    const sub = get(id);
    if (sub.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '方案已修改，请重新载入后再保存。', 409);
    return sub;
  }
  function isEnabled(id: string) {
    return !!db.prepare('SELECT id FROM subscriptions WHERE id=? AND enabled=1').get(id);
  }
  function invalidate(ids: string[], clearArtifacts = true) {
    for (const id of ids) {
      db.prepare('UPDATE subscriptions SET revision=revision+1,updated_at=? WHERE id=?').run(
        new Date().toISOString(),
        id,
      );
      if (clearArtifacts) db.prepare('DELETE FROM artifacts WHERE subscription_id=?').run(id);
    }
  }
  function invalidateInput(kind: 'node' | 'source', id: string, clearArtifacts = true) {
    const rows = z
      .array(z.object({ subscription_id: z.string() }))
      .parse(
        db
          .prepare(
            `SELECT DISTINCT subscription_id FROM subscription_inputs WHERE ${kind === 'node' ? 'node_id' : 'source_id'}=?`,
          )
          .all(id),
      );
    const ids = rows.map((r) => r.subscription_id);
    invalidate(ids, clearArtifacts);
    return ids;
  }
  function saveConfig(id: string, config: SubscriptionConfig) {
    const { inputs, name, enabled, ...settings } = config;
    for (const input of inputs) {
      if (
        !db
          .prepare(`SELECT id FROM ${input.kind === 'node' ? 'nodes' : 'sources'} WHERE id=?`)
          .get(input.id)
      )
        throw new AppError(
          'INVALID_INPUT_REFERENCE',
          '所选来源或节点已删除，请刷新后重新选择。',
          422,
        );
      if (
        input.kind === 'source' &&
        db
          .prepare("SELECT id FROM sources WHERE id=? AND kind='remote' AND snapshot_json IS NULL")
          .get(input.id) &&
        !db
          .prepare('SELECT 1 FROM subscription_inputs WHERE subscription_id=? AND source_id=?')
          .get(id, input.id)
      )
        throw new AppError(
          'SOURCE_SNAPSHOT_MISSING',
          '远端来源尚无成功快照，请先刷新成功后再加入方案。',
        );
    }
    db.prepare(
      'UPDATE subscriptions SET name=?,enabled=?,config_json=?,updated_at=? WHERE id=?',
    ).run(name, Number(enabled), JSON.stringify(settings), new Date().toISOString(), id);
    db.prepare('DELETE FROM subscription_inputs WHERE subscription_id=?').run(id);
    const insert = db.prepare(
      'INSERT INTO subscription_inputs(subscription_id,position,node_id,source_id) VALUES (?,?,?,?)',
    );
    inputs.forEach((input, position) =>
      insert.run(
        id,
        position,
        input.kind === 'node' ? input.id : null,
        input.kind === 'source' ? input.id : null,
      ),
    );
  }
  function checkedConfig(input: unknown) {
    const parsed = subscriptionConfigSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '方案设置格式无效。', 400);
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_BYTES)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '方案设置超过 4 MiB。', 413);
    return parsed.data;
  }
  function status(id: string, format: OutputFormat, engine: string) {
    const raw: unknown = db
      .prepare('SELECT * FROM artifacts WHERE subscription_id=? AND format=?')
      .get(id, format);
    if (!raw)
      return artifactStatusSchema.parse({
        format,
        readable: false,
        generatedAt: null,
        builtRevision: null,
        engineVersion: null,
        counts: null,
        diagnostics: [],
        error: null,
      });
    const row = artifactRowSchema.parse(raw);
    return artifactStatusSchema.parse({
      format,
      readable: row.body !== null && row.engine_version === engine,
      generatedAt: row.generated_at,
      builtRevision: row.built_revision,
      engineVersion: row.engine_version,
      counts: row.counts_json ? countsSchema.parse(JSON.parse(row.counts_json)) : null,
      diagnostics: row.diagnostics_json
        ? z.array(diagnosticSchema).parse(JSON.parse(row.diagnostics_json))
        : [],
      error: row.error_json ? artifactErrorSchema.parse(JSON.parse(row.error_json)) : null,
    });
  }
  function artifact(id: string, format: OutputFormat, engine: string) {
    const sub = get(id);
    if (!sub.enabled || !sub.formats.includes(format))
      throw new AppError('NOT_FOUND', '请求的资源不存在。', 404);
    const info = status(id, format, engine);
    if (!info.readable)
      throw new AppError('ARTIFACT_UNAVAILABLE', '此格式尚无可用结果，请稍后重试。', 503);
    const row = z
      .object({ body: z.string() })
      .parse(
        db
          .prepare('SELECT body FROM artifacts WHERE subscription_id=? AND format=?')
          .get(id, format),
      );
    return artifactSchema.parse({ ...info, content: row.body });
  }
  function canCommit(id: string, revision: number) {
    return !!db
      .prepare('SELECT id FROM subscriptions WHERE id=? AND revision=? AND enabled=1')
      .get(id, revision);
  }
  return {
    get,
    current,
    isEnabled,
    notify,
    invalidateInput,
    updateInput: (kind: 'node' | 'source', id: string) => invalidateInput(kind, id, false),
    listen(callback: (ids: string[]) => void) {
      listener = callback;
      return () => {
        listener = () => {};
      };
    },
    list(page: number) {
      const rows = z
        .array(z.object({ id: z.string() }))
        .parse(
          db
            .prepare('SELECT id FROM subscriptions ORDER BY created_at,id LIMIT 25 OFFSET ?')
            .all(page * 25),
        );
      return {
        subscriptions: rows.map((r) => {
          const { id, name, enabled, revision, createdAt, updatedAt, formats } = get(r.id);
          return subscriptionSummarySchema.parse({
            id,
            name,
            enabled,
            revision,
            createdAt,
            updatedAt,
            formats,
          });
        }),
        total: z
          .object({ n: z.number() })
          .parse(db.prepare('SELECT COUNT(*) n FROM subscriptions').get()).n,
      };
    },
    create(input: unknown) {
      const config = checkedConfig(input),
        token = randomBytes(32).toString('base64url'),
        id = randomUUID();
      db.transaction(() => {
        const { n } = z
          .object({ n: z.number() })
          .parse(db.prepare('SELECT COUNT(*) n FROM subscriptions').get());
        if (n >= MAX_SUBSCRIPTIONS)
          throw new AppError('OBJECT_LIMIT_EXCEEDED', '最多保存 100 个订阅方案。', 413);
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO subscriptions(id,name,enabled,revision,config_json,token_hash,created_at,updated_at) VALUES (?,?,1,1,?,?,?,?)',
        ).run(id, config.name, '{}', digest(token), now, now);
        saveConfig(id, config);
      })();
      notify([id]);
      return { id, token };
    },
    update(id: string, input: unknown) {
      const parsed = subscriptionUpdateSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '方案更新格式无效。', 400);
      db.transaction(() => {
        const old = current(id, parsed.data.revision);
        const config = subscriptionConfigSchema.strip().parse({ ...old, ...parsed.data });
        saveConfig(id, checkedConfig(config));
        invalidate([id]);
      })();
      notify([id]);
      return get(id);
    },
    delete(id: string, revision: number) {
      db.transaction(() => {
        current(id, revision);
        db.prepare('DELETE FROM subscriptions WHERE id=?').run(id);
      })();
      notify([id]);
    },
    resetToken(id: string, revision: number) {
      const token = randomBytes(32).toString('base64url');
      db.transaction(() => {
        current(id, revision);
        db.prepare(
          'UPDATE subscriptions SET token_hash=?,revision=revision+1,updated_at=? WHERE id=?',
        ).run(digest(token), new Date().toISOString(), id);
      })();
      return { id, token };
    },
    detail(id: string, engine: string, generation: 'idle' | 'queued' | 'running') {
      const sub = get(id);
      const inputLabels = sub.inputs.map((input) => {
        const raw: unknown =
          input.kind === 'node'
            ? db
                .prepare(
                  "SELECT json_extract(draft_json,'$.name') name,enabled FROM nodes WHERE id=?",
                )
                .get(input.id)
            : db.prepare('SELECT name,enabled FROM sources WHERE id=?').get(input.id);
        const row = z.object({ name: z.string(), enabled: z.number() }).parse(raw);
        return { ...input, name: row.name, enabled: row.enabled === 1 };
      });
      return {
        ...sub,
        generation,
        inputLabels,
        artifacts: sub.formats.map((f) => {
          const info = status(id, f, engine);
          return { ...info, readable: sub.enabled && info.readable };
        }),
      };
    },
    artifact,
    read(token: string, rawFormat: string, engine: string) {
      const format = outputFormatSchema.safeParse(rawFormat);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !format.success)
        throw new AppError('NOT_FOUND', '请求的资源不存在。', 404);
      return db.transaction(() => {
        const row: unknown = db
          .prepare('SELECT id FROM subscriptions WHERE token_hash=? AND enabled=1')
          .get(digest(token));
        if (!row) throw new AppError('NOT_FOUND', '请求的资源不存在。', 404);
        return artifact(z.object({ id: z.string() }).parse(row).id, format.data, engine);
      })();
    },
    snapshot(id: string, nodes: NodeStore, sources: SourceStore) {
      return db.transaction(() => {
        const sub = get(id);
        if (!sub.enabled) return null;
        const items: WorkbenchItem[] = [];
        let bytes = 12;
        const append = (item: WorkbenchItem) => {
          const next = {
            ...item,
            nodeIndex: items.length,
            diagnostics: item.diagnostics.map((d) => ({
              ...d,
              nodeIndex: d.nodeIndex < 0 ? -1 : items.length,
            })),
          };
          bytes += Buffer.byteLength(JSON.stringify(next)) + 1;
          if (items.length >= MAX_NODES || bytes > MAX_BYTES)
            throw new AppError('INPUT_LIMIT_EXCEEDED', '组合输入超过 2,000 节点或 4 MiB。', 413);
          items.push(next);
        };
        for (const input of sub.inputs) {
          if (input.kind === 'node') {
            const node = nodes.get(input.id);
            if (node.enabled)
              append({ draft: node.draft, nodeIndex: 0, excluded: false, diagnostics: [] });
          } else {
            const source = sources.get(input.id);
            if (source.enabled && source.savedAt === null)
              throw new AppError(
                'SOURCE_SNAPSHOT_MISSING',
                '方案包含尚无成功快照的来源，未生成不完整订阅。',
              );
            if (source.enabled)
              source.items.forEach((item, index) =>
                append({
                  ...item,
                  diagnostics: [...(index === 0 ? source.diagnostics : []), ...item.diagnostics],
                }),
              );
          }
        }
        return { subscription: sub, items };
      })();
    },
    commit(id: string, revision: number, engine: string, writes: ArtifactWrite[]) {
      return db.transaction(() => {
        if (!canCommit(id, revision)) return false;
        const now = new Date().toISOString();
        for (const w of writes) {
          if (Buffer.byteLength(w.content) > MAX_BYTES)
            throw new AppError('OUTPUT_LIMIT_EXCEEDED', '输出超过 4 MiB。');
          db.prepare(
            `INSERT INTO artifacts(subscription_id,format,body,built_revision,engine_version,generated_at,counts_json,diagnostics_json,error_json) VALUES (?,?,?,?,?,?,?,?,NULL)
            ON CONFLICT(subscription_id,format) DO UPDATE SET body=excluded.body,built_revision=excluded.built_revision,engine_version=excluded.engine_version,generated_at=excluded.generated_at,counts_json=excluded.counts_json,diagnostics_json=excluded.diagnostics_json,error_json=NULL`,
          ).run(
            id,
            w.format,
            w.content,
            revision,
            engine,
            now,
            JSON.stringify(w.counts),
            JSON.stringify(w.diagnostics),
          );
        }
        return true;
      })();
    },
    fail(
      id: string,
      revision: number,
      formats: OutputFormat[],
      error: z.infer<typeof artifactErrorSchema>,
    ) {
      return db.transaction(() => {
        if (!canCommit(id, revision)) return false;
        const encoded = JSON.stringify(artifactErrorSchema.parse(error));
        for (const format of formats)
          db.prepare(
            'INSERT INTO artifacts(subscription_id,format,error_json) VALUES (?,?,?) ON CONFLICT(subscription_id,format) DO UPDATE SET error_json=excluded.error_json',
          ).run(id, format, encoded);
        return true;
      })();
    },
    needsBuild(engine: string) {
      const rows = z
        .array(z.object({ id: z.string() }))
        .parse(db.prepare('SELECT id FROM subscriptions WHERE enabled=1').all());
      return rows
        .map((r) => r.id)
        .filter((id) => get(id).formats.some((f) => !status(id, f, engine).readable));
    },
  };
}
export type SubscriptionStore = ReturnType<typeof createSubscriptionStore>;
