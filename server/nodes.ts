import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { UpstreamResources, withEnabled } from './upstream-resources.js';
import { identityKey } from './sub-store.js';
import { toUpstream } from './converter/model.js';
import { AppError } from './errors.js';
import { validateDraft } from './converter/model.js';
import {
  MAX_BYTES,
  createNodesSchema,
  draftSchema,
  nodeIdsSchema,
  nodeSummarySchema,
  updateNodeSchema,
  type NodeDraft,
  type StoredNode,
} from './shared/contracts.js';
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
export function createNodeStore(db: Database.Database, resources: UpstreamResources) {
  function get(id: string): StoredNode {
    return resources.node(id);
  }

  function current(id: string, revision: number) {
    const node = get(id);
    if (node.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '节点已在其他页面修改，请重新载入后再保存。', 409);
    return node;
  }
  return {
    get,
    summary: (id: string) => resources.nodeSummary(id),
    list(page: number) {
      const rows: unknown = db
        .prepare('SELECT id FROM nodes WHERE present=1 ORDER BY created_at, id LIMIT 25 OFFSET ?')
        .all(page * 25);
      const ids = z.array(z.object({ id: z.string() })).parse(rows);
      const total = z
        .object({ count: z.number() })
        .parse(db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE present=1').get()).count;
      return { nodes: ids.map((row) => resources.nodeSummary(row.id)), total };
    },
    async create(input: unknown) {
      limit(input);
      const parsed = createNodesSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '保存请求格式无效。', 400);
      const drafts = parsed.data.drafts.map((d, i) => validDraft(d, i));
      const ids = drafts.map(() => randomUUID());
      await resources.write(async () => {
        const existing = await resources.client.records('sub');
        const added = drafts.map((draft, i) => ({
          name: 'sm-node-' + ids[i],
          displayName: draft.name,
          source: 'local',
          content: JSON.stringify(toUpstream(draft)),
          process: [],
          [identityKey]: { id: ids[i], kind: 'node' },
        }));
        await resources.client.api('/api/subs', [...existing, ...added], 'PUT');
      });
      return { nodes: ids.map((id) => summary(get(id))) };
    },
    async update(id: string, input: unknown) {
      limit(input);
      const parsed = updateNodeSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '节点更新请求格式无效。', 400);
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
      await resources.write(
        async () => {
          const { record } = resources.record(id);
          const update = withEnabled(
            { ...record, displayName: draft.name, content: JSON.stringify(toUpstream(draft)) },
            parsed.data.enabled ?? node.enabled,
          );
          await resources.client.api(
            '/api/sub/' + encodeURIComponent(record.name),
            update,
            'PATCH',
          );
        },
        [],
        () => {
          current(id, parsed.data.revision);
        },
      );
      return get(id);
    },
    async delete(id: string, revision: number) {
      await resources.write(
        async () => {
          const { record } = resources.record(id);
          await resources.client.api(
            '/api/sub/' + encodeURIComponent(record.name),
            undefined,
            'DELETE',
          );
        },
        [id],
        () => {
          resources.record(id);
          if (resources.nodeSummary(id).revision !== revision)
            throw new AppError('REVISION_CONFLICT', '节点已修改，请重新载入。', 409);
        },
      );
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
