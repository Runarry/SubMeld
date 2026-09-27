import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { NodeStore } from './nodes.js';
import type { InputChanges } from './subscriptions.js';
import { nodeSummarySchema } from './shared/contracts.js';
import {
  chainConfigSchema,
  chainSchema,
  chainUpdateSchema,
  MAX_CHAINS,
  type ChainConfig,
} from './shared/chains.js';

const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.number(),
  revision: z.number(),
  entry_node_id: z.string(),
  exit_node_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export function readChain(db: Database.Database, nodes: NodeStore, id: string) {
  const raw: unknown = db.prepare('SELECT * FROM chains WHERE id=?').get(id);
  if (!raw) throw new AppError('NOT_FOUND', '链式代理不存在。', 404);
  const row = rowSchema.parse(raw);
  const entry = nodeSummarySchema.strip().parse(nodes.summary(row.entry_node_id));
  const exit = nodeSummarySchema.strip().parse(nodes.summary(row.exit_node_id));
  return chainSchema.parse({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    revision: row.revision,
    entryNodeId: row.entry_node_id,
    exitNodeId: row.exit_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entry,
    exit,
    available: entry.enabled && exit.enabled,
  });
}
export function createChainStore(
  db: Database.Database,
  nodes: NodeStore,
  publications: InputChanges,
) {
  const get = (id: string) => readChain(db, nodes, id);
  function current(id: string, revision: number) {
    const chain = get(id);
    if (chain.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '链式代理已修改，请重新载入后再保存。', 409);
    return chain;
  }
  function references(config: ChainConfig) {
    if (config.entryNodeId === config.exitNodeId)
      throw new AppError('CHAIN_SAME_NODE', '前置代理和出口代理必须是不同的本地节点。', 422);
    for (const id of [config.entryNodeId, config.exitNodeId])
      if (!db.prepare('SELECT id FROM nodes WHERE id=?').get(id))
        throw new AppError('INVALID_INPUT_REFERENCE', '所选本地节点已删除，请重新选择。', 422);
  }
  return {
    get,
    list(page: number) {
      const rows = z
        .array(z.object({ id: z.string() }))
        .parse(
          db
            .prepare('SELECT id FROM chains ORDER BY created_at,id LIMIT 25 OFFSET ?')
            .all(page * 25),
        );
      const { n } = z
        .object({ n: z.number() })
        .parse(db.prepare('SELECT COUNT(*) n FROM chains').get());
      return { chains: rows.map(({ id }) => get(id)), total: n };
    },
    create(input: unknown) {
      const parsed = chainConfigSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '链式代理设置格式无效。', 400);
      return db.transaction(() => {
        references(parsed.data);
        const { n } = z
          .object({ n: z.number() })
          .parse(db.prepare('SELECT COUNT(*) n FROM chains').get());
        if (n >= MAX_CHAINS)
          throw new AppError('OBJECT_LIMIT_EXCEEDED', '最多保存 100 条链式代理。', 413);
        const id = randomUUID(),
          now = new Date().toISOString();
        const config = parsed.data;
        db.prepare('INSERT INTO chains VALUES (?,?,?,1,?,?,?,?)').run(
          id,
          config.name,
          Number(config.enabled),
          config.entryNodeId,
          config.exitNodeId,
          now,
          now,
        );
        return get(id);
      })();
    },
    update(id: string, input: unknown) {
      const parsed = chainUpdateSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '链式代理更新格式无效。', 400);
      const result = db.transaction(() => {
        const old = current(id, parsed.data.revision);
        const config = chainConfigSchema.strip().parse({ ...old, ...parsed.data });
        references(config);
        db.prepare(
          'UPDATE chains SET name=?,enabled=?,entry_node_id=?,exit_node_id=?,revision=revision+1,updated_at=? WHERE id=?',
        ).run(
          config.name,
          Number(config.enabled),
          config.entryNodeId,
          config.exitNodeId,
          new Date().toISOString(),
          id,
        );
        return { chain: get(id), affected: publications.invalidateInput('chain', id) };
      })();
      publications.notify(result.affected);
      return result.chain;
    },
    delete(id: string, revision: number) {
      const affected = db.transaction(() => {
        current(id, revision);
        const ids = publications.invalidateInput('chain', id);
        db.prepare('DELETE FROM chains WHERE id=?').run(id);
        return ids;
      })();
      publications.notify(affected);
    },
  };
}
export type ChainStore = ReturnType<typeof createChainStore>;
