import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InputChanges } from './subscriptions.js';
import { AppError } from './errors.js';
import { validateDraft } from './converter/model.js';
import {
  MAX_BYTES,
  createNodesSchema,
  draftSchema,
  nodeIdsSchema,
  nodeSummarySchema,
  storedNodeSchema,
  updateNodeSchema,
  type NodeDraft,
  type StoredNode,
} from './shared/contracts.js';
const rowSchema = z.strictObject({
  id: z.string(),
  enabled: z.union([z.literal(0), z.literal(1)]),
  revision: z.number().int().positive(),
  model_version: z.literal(1),
  draft_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
function limit(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数据超过 4 MiB。', 413);
}
function validDraft(value: unknown, index = 0): NodeDraft {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', '节点数据结构无效。', 400);
  const diagnostics = validateDraft(parsed.data, index);
  if (diagnostics.some((d) => d.level === 'error'))
    throw new AppError('NODE_INVALID', '请修正节点字段后保存。', 422, diagnostics);
  return parsed.data;
}
function summary(node: StoredNode) {
  return nodeSummarySchema.parse({
    id: node.id,
    name: node.name,
    protocol: node.protocol,
    enabled: node.enabled,
    revision: node.revision,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  });
}
export function createNodeStore(db: Database.Database, publications: InputChanges) {
  function get(id: string): StoredNode {
    const raw: unknown = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (raw === undefined) throw new AppError('NOT_FOUND', '节点不存在。', 404);
    const row = rowSchema.parse(raw);
    const value: unknown = JSON.parse(row.draft_json);
    const draft = validDraft(value);
    return storedNodeSchema.parse({
      id: row.id,
      enabled: row.enabled === 1,
      revision: row.revision,
      modelVersion: row.model_version,
      draft,
      name: draft.name,
      protocol: draft.protocol,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  function current(id: string, revision: number) {
    const node = get(id);
    if (node.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '节点已在其他页面修改，请重新载入后再保存。', 409);
    return node;
  }
  return {
    get,
    list(page: number) {
      const rows: unknown = db
        .prepare('SELECT id FROM nodes ORDER BY created_at, id LIMIT 25 OFFSET ?')
        .all(page * 25);
      const ids = z.array(z.object({ id: z.string() })).parse(rows);
      const total = z
        .object({ count: z.number() })
        .parse(db.prepare('SELECT COUNT(*) AS count FROM nodes').get()).count;
      return { nodes: ids.map((row) => summary(get(row.id))), total };
    },
    create(input: unknown) {
      limit(input);
      const parsed = createNodesSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '保存请求格式无效。', 400);
      const drafts = parsed.data.drafts.map((d, i) => validDraft(d, i));
      return db.transaction(() => {
        const now = new Date().toISOString();
        const insert = db.prepare('INSERT INTO nodes VALUES (?,1,1,1,?,?,?)');
        return {
          nodes: drafts.map((draft) => {
            const id = randomUUID();
            insert.run(id, JSON.stringify(draft), now, now);
            return summary(get(id));
          }),
        };
      })();
    },
    update(id: string, input: unknown) {
      limit(input);
      const parsed = updateNodeSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '节点更新请求格式无效。', 400);
      const result = db.transaction(() => {
        const node = current(id, parsed.data.revision);
        const changes = parsed.data.changes ?? {};
        const clearSecrets = (values: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, value === null ? '' : value]),
          );
        const draft = validDraft({
          ...node.draft,
          ...changes,
          tls: { ...node.draft.tls, ...changes.tls },
          transport: { ...node.draft.transport, ...changes.transport },
          auth: { ...node.draft.auth, ...clearSecrets(changes.auth ?? {}) },
          protocolOptions: {
            ...node.draft.protocolOptions,
            ...clearSecrets(changes.protocolOptions ?? {}),
          },
        });
        limit(draft);
        db.prepare(
          'UPDATE nodes SET draft_json=?, enabled=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?',
        ).run(
          JSON.stringify(draft),
          Number(parsed.data.enabled ?? node.enabled),
          new Date().toISOString(),
          id,
          node.revision,
        );
        return { node: get(id), affected: publications.invalidateInput('node', id) };
      })();
      publications.notify(result.affected);
      return result.node;
    },
    delete(id: string, revision: number) {
      const affected = db.transaction(() => {
        current(id, revision);
        const ids = publications.invalidateInput('node', id);
        db.prepare('DELETE FROM nodes WHERE id=? AND revision=?').run(id, revision);
        return ids;
      })();
      publications.notify(affected);
    },
    load(input: unknown) {
      const parsed = nodeIdsSchema.safeParse(input);
      if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length)
        throw new AppError('INVALID_REQUEST', '请选择不重复的节点。', 400);
      return db.transaction(() => {
        const items = parsed.data.ids.map((id, nodeIndex) => {
          const node = get(id);
          if (!node.enabled)
            throw new AppError('NODE_DISABLED', '所选节点已禁用，请先启用并重新选择。', 422);
          return {
            nodeIndex,
            draft: node.draft,
            excluded: false,
            diagnostics: validateDraft(node.draft, nodeIndex),
          };
        });
        limit({ items });
        return { items };
      })();
    },
  };
}
export type NodeStore = ReturnType<typeof createNodeStore>;
