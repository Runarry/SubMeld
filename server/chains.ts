import { AppError } from './errors.js';
import { chainConfigSchema, MAX_CHAINS, type Chain } from './shared/chains.js';
import { UpstreamFiles } from './upstream-files.js';
import { hash, type UpstreamResources } from './upstream-resources.js';
export function createChainStore(resources: UpstreamResources, files: UpstreamFiles) {
  function definition(id: string) {
    const value = files.get(id, 'chain');
    try {
      return {
        ...chainConfigSchema.parse(JSON.parse(String(value.record.content))),
        id,
        revision: value.revision,
      };
    } catch {
      throw new AppError('CHAIN_INVALID', '上游链定义无法读取，请在原生文件页面修正。', 422);
    }
  }
  function inspect(id: string): Chain {
    const chain = definition(id);
    try {
      const entryNode = resources.resolve(chain.entry).view,
        exitNode = resources.resolve(chain.exit).view;
      return {
        ...chain,
        entryNode,
        exitNode,
        available: chain.enabled && entryNode.available && exitNode.available,
        error: null,
      };
    } catch (error) {
      return {
        ...chain,
        entryNode: null,
        exitNode: null,
        available: false,
        error: error instanceof AppError ? error.message : '链成员不可用。',
      };
    }
  }
  async function get(id: string) {
    const chain = definition(id);
    try {
      await resources.prepare([chain.entry.resourceId, chain.exit.resourceId]);
    } catch {
      return {
        ...chain,
        entryNode: null,
        exitNode: null,
        available: false,
        error: '无法读取链成员，请检查上游订阅。',
      };
    }
    return inspect(id);
  }
  async function save(input: unknown, id?: string, revision?: string) {
    const parsed = chainConfigSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('INVALID_REQUEST', '链定义无效，请选择两个不同的节点。', 400);
    const value = parsed.data;
    if (JSON.stringify(value.entry) === JSON.stringify(value.exit))
      throw new AppError('INVALID_REQUEST', '前置和出口必须是不同节点。', 400);
    return resources.client.exclusive(async () => {
      await resources.syncUnlocked();
      if (!id && resources.files('chain').length >= MAX_CHAINS)
        throw new AppError('LIMIT_EXCEEDED', '链数量达到上限。', 400);
      await resources.prepare([value.entry.resourceId, value.exit.resourceId]);
      const entry = resources.resolve(value.entry),
        exit = resources.resolve(value.exit);
      if (hash(entry.processed) === hash(exit.processed))
        throw new AppError('INVALID_REQUEST', '前置和出口不能指向同一节点。', 400);
      const saved = await files.put('chain', value, id, revision);
      return get(saved);
    });
  }
  return {
    definition,
    inspect,
    get,
    async list(page = 0) {
      const all = resources.files('chain');
      return {
        chains: await Promise.all(all.slice(page * 25, page * 25 + 25).map((f) => get(f.id))),
        total: all.length,
      };
    },
    create: (input: unknown) => save(input),
    update: (id: string, input: unknown, revision: string) => save(input, id, revision),
    async delete(id: string, revision: string) {
      return resources.client.exclusive(async () => {
        await resources.syncUnlocked();
        await files.remove(id, 'chain', revision);
        await resources.syncUnlocked();
      });
    },
  };
}
export type ChainStore = ReturnType<typeof createChainStore>;
