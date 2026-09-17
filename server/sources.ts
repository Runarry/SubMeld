import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Converter } from './converter/pool.js';
import {
  MAX_BYTES,
  formatSchema,
  parseResultSchema,
  type ParseResult,
} from './shared/contracts.js';
import {
  MAX_SOURCES,
  sourceInputSchema,
  sourceSchema,
  sourceSummarySchema,
  sourceUpdateSchema,
  sourceHeadersSchema,
  sourceErrorSchema,
  type Source,
  type RemoteConfig,
} from './shared/subscriptions.js';
import { sourceUrl } from './source-fetcher.js';
import type { InputChanges } from './subscriptions.js';

const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.number(),
  revision: z.number(),
  model_version: z.number(),
  kind: z.enum(['text', 'remote']),
  format: formatSchema,
  text: z.string(),
  snapshot_json: z.string().nullable(),
  url: z.string().nullable(),
  headers_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  saved_at: z.string().nullable(),
  snapshot_version: z.number().int().nonnegative(),
  last_attempt_at: z.string().nullable(),
  error_json: z.string().nullable(),
});
export async function parseSource(
  text: string,
  format: z.infer<typeof formatSchema>,
  converter: Pick<Converter, 'run'>,
  signal?: AbortSignal,
) {
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '来源正文超过 4 MiB。', 413);
  const result = parseResultSchema.parse(
    await converter.run({ kind: 'parse', input: { text, format } }, signal),
  );
  const diagnostics = [...result.diagnostics, ...result.items.flatMap((i) => i.diagnostics)];
  if (
    !result.items.length ||
    result.items.some((i) => !i.draft) ||
    diagnostics.some((d) => d.level === 'error')
  )
    throw new AppError(
      'SOURCE_INVALID',
      '来源必须完整解析且至少包含一个有效节点；已有内容未更改。',
      422,
      diagnostics,
    );
  if (Buffer.byteLength(JSON.stringify({ items: result.items })) > MAX_BYTES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '来源节点数据超过 4 MiB。', 413);
  return result;
}
export function createSourceStore(db: Database.Database, changes: InputChanges) {
  let onRefresh: ((id: string, refresh: boolean) => void) | undefined;
  let refreshStatus: (id: string) => Source['refresh'] = () => 'idle';
  function get(id: string) {
    const raw: unknown = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    if (!raw) throw new AppError('NOT_FOUND', '来源不存在。', 404);
    const row = rowSchema.parse(raw);
    const snapshot =
      row.snapshot_json === null ? null : parseResultSchema.parse(JSON.parse(row.snapshot_json));
    return sourceSchema.parse({
      id,
      name: row.name,
      enabled: row.enabled === 1,
      revision: row.revision,
      modelVersion: row.model_version,
      kind: row.kind,
      format: row.format,
      text: row.text,
      url: row.url,
      headers:
        row.headers_json === null ? null : sourceHeadersSchema.parse(JSON.parse(row.headers_json)),
      items: snapshot?.items ?? [],
      diagnostics: snapshot?.diagnostics ?? [],
      nodeCount: snapshot?.items.length ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      savedAt: row.saved_at,
      snapshotVersion: row.snapshot_version,
      lastAttemptAt: row.last_attempt_at,
      error: row.error_json === null ? null : sourceErrorSchema.parse(JSON.parse(row.error_json)),
      refresh: refreshStatus(id),
    });
  }
  function current(id: string, revision: number) {
    const source = get(id);
    if (source.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '来源已修改，请重新载入后再保存。', 409);
    return source;
  }
  function canAccept(id: string, revision: number) {
    return !!db
      .prepare("SELECT id FROM sources WHERE id=? AND revision=? AND enabled=1 AND kind='remote'")
      .get(id, revision);
  }
  return {
    get,
    listenRefresh(listener: (id: string, refresh: boolean) => void, status: typeof refreshStatus) {
      onRefresh = listener;
      refreshStatus = status;
      return () => {
        onRefresh = undefined;
        refreshStatus = () => 'idle';
      };
    },
    enabledRemoteIds() {
      return z
        .array(z.object({ id: z.string() }))
        .parse(
          db
            .prepare(
              "SELECT id FROM sources WHERE kind='remote' AND enabled=1 ORDER BY created_at,id",
            )
            .all(),
        )
        .map((row) => row.id);
    },
    isRemoteEnabled(id: string) {
      return !!db
        .prepare("SELECT id FROM sources WHERE id=? AND kind='remote' AND enabled=1")
        .get(id);
    },
    requestRefresh(id: string, revision: number) {
      const source = current(id, revision);
      if (source.kind !== 'remote' || !source.enabled)
        throw new AppError('SOURCE_NOT_REFRESHABLE', '只能刷新已启用的远端来源。', 422);
      if (!onRefresh) throw new AppError('SOURCE_REFRESH_UNAVAILABLE', '来源刷新器暂不可用。', 503);
      // Refreshing saved settings does not change revision or invalidate published content.
      onRefresh(id, true);
      return get(id);
    },
    list(page: number) {
      const rows = z
        .array(z.object({ id: z.string() }))
        .parse(
          db
            .prepare('SELECT id FROM sources ORDER BY created_at,id LIMIT 25 OFFSET ?')
            .all(page * 25),
        );
      return {
        sources: rows.map((r) => {
          const {
            id,
            name,
            enabled,
            revision,
            kind,
            format,
            nodeCount,
            savedAt,
            snapshotVersion,
            lastAttemptAt,
            error,
            refresh,
            createdAt,
            updatedAt,
          } = get(r.id);
          return sourceSummarySchema.parse({
            id,
            name,
            enabled,
            revision,
            kind,
            format,
            nodeCount,
            savedAt,
            snapshotVersion,
            lastAttemptAt,
            error,
            refresh,
            createdAt,
            updatedAt,
          });
        }),
        total: z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) n FROM sources').get())
          .n,
      };
    },
    async create(input: unknown, converter: Pick<Converter, 'run'>, signal?: AbortSignal) {
      const parsed = sourceInputSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '来源格式无效。', 400);
      const value = parsed.data;
      let snapshot: ParseResult | null = null;
      if (value.kind === 'text')
        snapshot = await parseSource(value.text, value.format, converter, signal);
      else sourceUrl(value.url);
      const id = randomUUID();
      db.transaction(() => {
        if (
          z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) n FROM sources').get()).n >=
          MAX_SOURCES
        )
          throw new AppError('OBJECT_LIMIT_EXCEEDED', '最多保存 100 个来源。', 413);
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO sources(id,name,enabled,revision,model_version,kind,format,text,snapshot_json,url,headers_json,created_at,updated_at,saved_at) VALUES (?,?,?,1,1,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          value.name,
          Number(value.enabled),
          value.kind,
          value.format,
          value.kind === 'text' ? value.text : '',
          snapshot ? JSON.stringify(snapshot) : null,
          value.kind === 'remote' ? value.url : null,
          value.kind === 'remote' ? JSON.stringify(value.headers) : null,
          now,
          now,
          snapshot ? now : null,
        );
        if (snapshot) db.prepare('UPDATE sources SET snapshot_version=1 WHERE id=?').run(id);
      })();
      if (value.kind === 'remote') onRefresh?.(id, true);
      return get(id);
    },
    async update(
      id: string,
      input: unknown,
      converter: Pick<Converter, 'run'>,
      signal?: AbortSignal,
    ) {
      const parsed = sourceUpdateSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '来源更新格式无效。', 400);
      const value = parsed.data,
        before = current(id, value.revision);
      if (
        (before.kind === 'text' && (value.url !== undefined || value.headers !== undefined)) ||
        (before.kind === 'remote' && value.text !== undefined)
      )
        throw new AppError('INVALID_REQUEST', '来源类型不能更改，请提交该类型允许的字段。', 400);
      const text = value.text ?? before.text,
        format = value.format ?? before.format;
      let snapshot: ParseResult | undefined, remote: RemoteConfig | undefined;
      let connectionChanged = false;
      if (before.kind === 'text') {
        if (text !== before.text || format !== before.format)
          snapshot = await parseSource(text, format, converter, signal);
      } else {
        if (!before.url || !before.headers) throw new Error('Invalid stored remote source');
        const headers = { ...before.headers };
        for (const key of ['userAgent', 'accept', 'authorization'] as const) {
          if (value.headers?.[key] !== undefined) headers[key] = value.headers[key] ?? '';
        }
        remote = { url: value.url ?? before.url, headers };
        sourceUrl(remote.url);
        connectionChanged =
          remote.url !== before.url ||
          format !== before.format ||
          JSON.stringify(headers) !== JSON.stringify(before.headers);
      }
      const affected = db.transaction(() => {
        current(id, value.revision);
        const now = new Date().toISOString();
        db.prepare(
          'UPDATE sources SET name=?,enabled=?,revision=revision+1,format=?,text=?,updated_at=? WHERE id=?',
        ).run(
          value.name ?? before.name,
          Number(value.enabled ?? before.enabled),
          format,
          text,
          now,
          id,
        );
        if (snapshot)
          db.prepare(
            'UPDATE sources SET snapshot_json=?,saved_at=?,snapshot_version=snapshot_version+1 WHERE id=?',
          ).run(JSON.stringify(snapshot), now, id);
        if (remote)
          db.prepare('UPDATE sources SET url=?,headers_json=? WHERE id=?').run(
            remote.url,
            JSON.stringify(remote.headers),
            id,
          );
        if (connectionChanged)
          db.prepare(
            "UPDATE sources SET text='',snapshot_json=NULL,saved_at=NULL,last_attempt_at=NULL,error_json=NULL,snapshot_version=snapshot_version+1 WHERE id=?",
          ).run(id);
        if (snapshot || connectionChanged)
          db.prepare('DELETE FROM node_test_results WHERE source_id=?').run(id);
        return changes.invalidateInput('source', id);
      })();
      changes.notify(affected);
      if (before.kind === 'remote')
        onRefresh?.(id, connectionChanged || (!before.enabled && value.enabled === true));
      return get(id);
    },
    accept(id: string, revision: number, text: string, snapshot: ParseResult, attemptedAt: string) {
      const affected = db.transaction(() => {
        if (!canAccept(id, revision)) return null;
        db.prepare(
          'UPDATE sources SET text=?,snapshot_json=?,saved_at=?,last_attempt_at=?,error_json=NULL,snapshot_version=snapshot_version+1 WHERE id=?',
        ).run(text, JSON.stringify(snapshot), new Date().toISOString(), attemptedAt, id);
        db.prepare('DELETE FROM node_test_results WHERE source_id=?').run(id);
        return changes.updateInput('source', id);
      })();
      if (affected === null) return false;
      changes.notify(affected);
      return true;
    },
    fail(
      id: string,
      revision: number,
      error: z.infer<typeof sourceErrorSchema>,
      attemptedAt: string,
    ) {
      return db.transaction(() => {
        if (!canAccept(id, revision)) return false;
        db.prepare('UPDATE sources SET last_attempt_at=?,error_json=? WHERE id=?').run(
          attemptedAt,
          JSON.stringify(sourceErrorSchema.parse(error)),
          id,
        );
        return true;
      })();
    },
    delete(id: string, revision: number) {
      const affected = db.transaction(() => {
        current(id, revision);
        const ids = changes.invalidateInput('source', id);
        db.prepare('DELETE FROM sources WHERE id=?').run(id);
        return ids;
      })();
      changes.notify(affected);
      onRefresh?.(id, false);
    },
  };
}
export type SourceStore = ReturnType<typeof createSourceStore>;
