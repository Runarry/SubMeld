import { errorSchema } from './shared/contracts.js';
import { z } from 'zod';
import { AppError } from './errors.js';
import { UpstreamFiles, outputRecord } from './upstream-files.js';
import { marker, type UpstreamResources } from './upstream-resources.js';
import {
  subscriptionConfigSchema,
  MAX_SUBSCRIPTIONS,
  type OutputFormat,
  type Subscription,
  type SubscriptionDetail,
} from './shared/subscriptions.js';
export const ENGINE_VERSION = 'upstream-native-5';
export function createSubscriptionStore(resources: UpstreamResources, files: UpstreamFiles) {
  function get(id: string): Subscription {
    const value = files.get(id, 'plan');
    try {
      return {
        ...subscriptionConfigSchema.parse(JSON.parse(String(value.record.content))),
        id,
        revision: value.revision,
      };
    } catch {
      throw new AppError('PLAN_INVALID', '上游输出方案无法读取，请在原生文件页面修正。', 422);
    }
  }
  const outputs = (id: string) =>
    resources.files('output').filter((f) => marker(f.record)?.parent === id);
  async function detail(id: string, origin: string): Promise<SubscriptionDetail> {
    const plan = get(id),
      urls: SubscriptionDetail['urls'] = {},
      errors: string[] = [];
    for (const format of plan.formats) {
      const list = outputs(id).filter((f) => marker(f.record)?.format === format);
      if (list.length !== 1) {
        errors.push(format + ' 输出文件缺失或重复，请重新保存方案。');
        continue;
      }
      const name = list[0]!.record.name;
      urls[format] = (await resources.client.tokens(name)).map(
        (token) =>
          origin +
          '/share/file/' +
          encodeURIComponent(name) +
          '?token=' +
          encodeURIComponent(token.token),
      );
    }
    return { ...plan, urls, errors };
  }
  async function save(input: unknown, id?: string, revision?: string) {
    const parsed = subscriptionConfigSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('INVALID_REQUEST', '请填写有效的方案名称、输入和输出格式。', 400);
    return resources.client.exclusive(async () => {
      await resources.syncUnlocked();
      if (!id && resources.files('plan').length >= MAX_SUBSCRIPTIONS)
        throw new AppError('LIMIT_EXCEEDED', '方案数量达到上限。', 400);
      for (const ref of parsed.data.inputs) {
        if (ref.kind === 'chain') files.get(ref.id, 'chain');
        else resources.resource(ref.kind === 'node' ? ref.resourceId : ref.id);
      }
      await files.initialize();
      id = await files.put('plan', parsed.data, id, revision);
      for (const format of parsed.data.formats) {
        const existing = outputs(id).filter((f) => marker(f.record)?.format === format);
        if (existing.length > 1)
          throw new AppError('OUTPUT_DUPLICATE', '输出文件重复，请在 Sub-Store 中修正。', 409);
        if (!existing.length) await resources.client.api('/api/files', outputRecord(id, format));
      }
      for (const old of outputs(id))
        if (!parsed.data.formats.includes(marker(old.record)?.format as OutputFormat)) {
          await resources.client.revoke(old.record.name);
          await resources.client.api(
            '/api/file/' + encodeURIComponent(old.record.name),
            undefined,
            'DELETE',
          );
        }
      await resources.syncUnlocked();
      return get(id);
    });
  }
  async function current(id: string, revision: string) {
    const plan = get(id);
    if (plan.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '输出方案已修改，请重新载入。', 409);
    return plan;
  }
  return {
    get,
    detail,
    outputs,
    list(page = 0) {
      const all = resources.files('plan');
      return {
        subscriptions: all.slice(page * 25, page * 25 + 25).map((f) => get(f.id)),
        total: all.length,
      };
    },
    create: (input: unknown) => save(input),
    update: (id: string, input: unknown, revision: string) => save(input, id, revision),
    async delete(id: string, revision: string) {
      return resources.client.exclusive(async () => {
        await resources.syncUnlocked();
        await current(id, revision);
        for (const output of outputs(id)) {
          await resources.client.revoke(output.record.name);
          await resources.client.api(
            '/api/file/' + encodeURIComponent(output.record.name),
            undefined,
            'DELETE',
          );
        }
        await files.remove(id, 'plan', revision);
        await resources.syncUnlocked();
      });
    },
    async share(id: string, revision: string, revoke: boolean) {
      return resources.client.exclusive(async () => {
        await resources.syncUnlocked();
        const plan = await current(id, revision);
        for (const format of plan.formats) {
          const list = outputs(id).filter((f) => marker(f.record)?.format === format);
          if (list.length !== 1)
            throw new AppError('OUTPUT_MISSING', '输出文件缺失或重复，请重新保存方案。', 409);
          const name = list[0]!.record.name;
          if (revoke) await resources.client.revoke(name);
          else if (!(await resources.client.tokens(name)).length)
            await resources.client.api('/api/token', {
              payload: { type: 'file', name },
              options: {},
            });
        }
      });
    },
    async artifact(id: string, format: OutputFormat, force = false) {
      const plan = get(id);
      if (!plan.enabled || !plan.formats.includes(format))
        throw new AppError('OUTPUT_DISABLED', '方案或输出格式未启用。', 422);
      const list = outputs(id).filter((f) => marker(f.record)?.format === format);
      if (list.length !== 1)
        throw new AppError('OUTPUT_MISSING', '输出文件缺失或重复，请重新保存方案。', 409);
      const response = await resources.client.request(
        '/api/file/' +
          encodeURIComponent(list[0]!.record.name) +
          (force ? '?noCache=true&$options=noCache%3Dtrue' : ''),
      );
      const content = await response.text();
      if (!response.ok) {
        const error = z.object({ error: errorSchema }).safeParse(
          await Promise.resolve()
            .then(() => JSON.parse(content))
            .catch(() => null),
        );
        throw new AppError(
          error.success ? error.data.error.code : 'GENERATION_FAILED',
          error.success ? error.data.error.message : '上游生成失败，请检查节点与配套文件。',
          422,
          error.success ? error.data.error.diagnostics : undefined,
        );
      }
      return { format, content };
    },
  };
}
export type SubscriptionStore = ReturnType<typeof createSubscriptionStore>;
