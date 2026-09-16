import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Converter } from './converter/pool.js';
import { MAX_BYTES, parseResultSchema, type ParseResult } from './shared/contracts.js';
import {
  MAX_SOURCES,
  sourceInputSchema,
  sourceSchema,
  sourceSummarySchema,
  sourceUpdateSchema,
} from './shared/subscriptions.js';
import type { InputChanges } from './subscriptions.js';

const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.number(),
  revision: z.number(),
  model_version: z.number(),
  format: z.string(),
  text: z.string(),
  snapshot_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  saved_at: z.string(),
});
export function createSourceStore(db: Database.Database, changes: InputChanges) {
  function get(id: string) {
    const raw: unknown = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    if (!raw) throw new AppError('NOT_FOUND', '文本来源不存在。', 404);
    const row = rowSchema.parse(raw);
    const snapshot = parseResultSchema.parse(JSON.parse(row.snapshot_json));
    return sourceSchema.parse({
      id,
      name: row.name,
      enabled: row.enabled === 1,
      revision: row.revision,
      modelVersion: row.model_version,
      format: row.format,
      text: row.text,
      items: snapshot.items,
      diagnostics: snapshot.diagnostics,
      nodeCount: snapshot.items.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      savedAt: row.saved_at,
    });
  }
  function current(id: string, revision: number) {
    const source = get(id);
    if (source.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '来源已修改，请重新载入后再保存。', 409);
    return source;
  }
  async function parse(
    text: string,
    format: z.infer<typeof sourceInputSchema>['format'],
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
  return {
    get,
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
          const s = get(r.id);
          return sourceSummarySchema.parse({
            id: s.id,
            name: s.name,
            enabled: s.enabled,
            revision: s.revision,
            format: s.format,
            nodeCount: s.nodeCount,
            savedAt: s.savedAt,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          });
        }),
        total: z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) n FROM sources').get())
          .n,
      };
    },
    async create(input: unknown, converter: Pick<Converter, 'run'>, signal?: AbortSignal) {
      const parsed = sourceInputSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '文本来源格式无效。', 400);
      const snapshot = await parse(parsed.data.text, parsed.data.format, converter, signal);
      const id = randomUUID();
      db.transaction(() => {
        if (
          z.object({ n: z.number() }).parse(db.prepare('SELECT COUNT(*) n FROM sources').get()).n >=
          MAX_SOURCES
        )
          throw new AppError('OBJECT_LIMIT_EXCEEDED', '最多保存 100 个文本来源。', 413);
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO sources(id,name,enabled,revision,model_version,format,text,snapshot_json,created_at,updated_at,saved_at) VALUES (?,?,?,1,1,?,?,?,?,?,?)',
        ).run(
          id,
          parsed.data.name,
          Number(parsed.data.enabled),
          parsed.data.format,
          parsed.data.text,
          JSON.stringify(snapshot),
          now,
          now,
          now,
        );
      })();
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
      const before = current(id, parsed.data.revision);
      const text = parsed.data.text ?? before.text,
        format = parsed.data.format ?? before.format;
      let snapshot: ParseResult | undefined;
      if (text !== before.text || format !== before.format)
        snapshot = await parse(text, format, converter, signal);
      const affected = db.transaction(() => {
        current(id, parsed.data.revision);
        const now = new Date().toISOString();
        db.prepare(
          'UPDATE sources SET name=?,enabled=?,revision=revision+1,format=?,text=?,updated_at=? WHERE id=?',
        ).run(
          parsed.data.name ?? before.name,
          Number(parsed.data.enabled ?? before.enabled),
          format,
          text,
          now,
          id,
        );
        if (snapshot)
          db.prepare('UPDATE sources SET snapshot_json=?,saved_at=? WHERE id=?').run(
            JSON.stringify(snapshot),
            now,
            id,
          );
        return changes.invalidateInput('source', id);
      })();
      changes.notify(affected);
      return get(id);
    },
    delete(id: string, revision: number) {
      const affected = db.transaction(() => {
        current(id, revision);
        const ids = changes.invalidateInput('source', id);
        db.prepare('DELETE FROM sources WHERE id=?').run(id);
        return ids;
      })();
      changes.notify(affected);
    },
  };
}
export type SourceStore = ReturnType<typeof createSourceStore>;
