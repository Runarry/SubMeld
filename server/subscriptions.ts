import { errorSchema } from './shared/contracts.js';
import { z } from 'zod';
import { AppError, publicError } from './errors.js';
import { UpstreamFiles, draftPreviewRecord, outputRecord } from './upstream-files.js';
import { hash, marker, type UpstreamResources } from './upstream-resources.js';
import { readStoredSubscription } from './shared/legacy-chain-inputs.js';
import {
  subscriptionConfigSchema,
  outputGroup,
  MAX_SUBSCRIPTIONS,
  type OutputFormat,
  type Subscription,
  type SubscriptionConfig,
  type SubscriptionDetail,
  type SubscriptionValidation,
} from './shared/subscriptions.js';
export const ENGINE_VERSION = 'upstream-native-8';

const generationErrorSchema = z.object({ error: errorSchema });
const draftResultSchema = z.union([
  z.object({ generated: z.literal(true) }),
  generationErrorSchema,
]);

export class SubscriptionValidationError extends AppError {
  constructor(readonly validation: SubscriptionValidation) {
    super('OUTPUT_VALIDATION_FAILED', '请解决生成问题后重新创建分享地址。', 422);
  }
}

async function validateFormats(
  formats: OutputFormat[],
  generate: (format: OutputFormat) => Promise<void>,
): Promise<SubscriptionValidation> {
  return Promise.all(
    formats.map(async (format): Promise<SubscriptionValidation[number]> => {
      try {
        await generate(format);
        return { format, state: 'ok' };
      } catch (error) {
        const issue = publicError(error);
        const unverified =
          !(error instanceof AppError) ||
          error.status >= 500 ||
          ['REVISION_CONFLICT', 'UPSTREAM_LIMIT'].includes(error.code);
        return { format, state: unverified ? 'unverified' : 'failed', ...issue };
      }
    }),
  );
}

export function createSubscriptionStore(resources: UpstreamResources, files: UpstreamFiles) {
  function get(id: string): Subscription {
    const value = files.get(id, 'plan');
    try {
      return {
        ...readStoredSubscription(JSON.parse(String(value.record.content))),
        id,
        revision: value.revision,
      };
    } catch {
      throw new AppError('PLAN_INVALID', '上游输出方案无法读取，请在原生文件页面修正。', 422);
    }
  }
  const outputs = (id: string) =>
    resources.files('output').filter((f) => marker(f.record)?.parent === id);
  function outputNames(plan: Subscription) {
    const list = outputs(plan.id);
    return new Map(
      plan.formats.map((format) => {
        const matches = list.filter((f) => marker(f.record)?.format === format);
        return [format, matches.length === 1 ? matches[0]!.record.name : undefined];
      }),
    );
  }
  function outputName(name?: string) {
    if (!name) throw new AppError('OUTPUT_MISSING', '输出文件缺失或重复，请重新保存方案。', 409);
    return name;
  }
  function generationRevision(config: SubscriptionConfig, id?: string) {
    const groups = new Set<string>(config.formats.map(outputGroup));
    const dependencies = resources.files().filter(({ record }) => {
      const meta = marker(record);
      return (
        meta?.role === 'runtime' ||
        (meta?.role === 'template' && groups.has(meta.format ?? '')) ||
        (meta?.role === 'certificate-resolver' && groups.has('singbox')) ||
        (meta?.role === 'output' && meta.parent === id)
      );
    });
    return hash([resources.listResources(), dependencies]);
  }
  const generationConflict = () =>
    new AppError('REVISION_CONFLICT', '检查期间上游配置已变化，请重新检查。', 409);
  const visiblePlans = () =>
    resources
      .files('plan')
      .map((f) => get(f.id))
      .filter((plan) => plan.inputs.length > 0);
  async function detail(id: string, origin: string): Promise<SubscriptionDetail> {
    const plan = get(id),
      urls: SubscriptionDetail['urls'] = {},
      errors: string[] = [];
    for (const [format, name] of outputNames(plan)) {
      if (!name) {
        errors.push(format + ' 输出文件缺失或重复，请重新保存方案。');
        continue;
      }
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
  function current(id: string, revision?: string) {
    const plan = get(id);
    if (plan.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '输出方案已修改，请重新载入。', 409);
    return plan;
  }
  function checkSaveTarget(config: SubscriptionConfig, id?: string, revision?: string) {
    if (!id) {
      if (visiblePlans().length >= MAX_SUBSCRIPTIONS)
        throw new AppError('LIMIT_EXCEEDED', '方案数量达到上限。', 400);
      return;
    }
    current(id, revision);
    const list = outputs(id);
    if (
      config.formats.some(
        (format) => list.filter((f) => marker(f.record)?.format === format).length > 1,
      )
    )
      throw new AppError('OUTPUT_DUPLICATE', '输出文件重复，请在 Sub-Store 中修正。', 409);
  }
  async function checkDraft(config: SubscriptionConfig, format: OutputFormat) {
    const { processed } = z
      .object({ processed: z.string() })
      .parse(await resources.client.api('/api/preview/file', draftPreviewRecord(config, format)));
    const result = draftResultSchema.parse(JSON.parse(processed));
    if ('error' in result)
      throw new AppError(result.error.code, result.error.message, 422, result.error.diagnostics);
  }
  async function save(input: unknown, id?: string, revision?: string) {
    const parsed = subscriptionConfigSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('INVALID_REQUEST', '请填写有效的方案名称、输入和输出格式。', 400);
    const config = parsed.data;
    const checkedRevision = await resources.client.exclusive(async () => {
      await resources.syncUnlocked();
      checkSaveTarget(config, id, revision);
      await files.initialize({ keepDuplicates: true });
      return generationRevision(config, id);
    });
    // Native generation can call back into SubMeld to acquire and store an HY2 certificate.
    let validation = await validateFormats(config.formats, (format) => checkDraft(config, format));
    return resources.client.exclusive(async () => {
      await resources.syncUnlocked();
      checkSaveTarget(config, id, revision);
      if (generationRevision(config, id) !== checkedRevision) {
        const { code, message } = generationConflict();
        validation = config.formats.map((format) => ({
          format,
          state: 'unverified',
          code,
          message,
        }));
      }
      const savedId = await files.put('plan', config, id, revision);
      const existing = outputs(savedId);
      for (const format of config.formats) {
        if (!existing.some((f) => marker(f.record)?.format === format))
          await resources.client.api('/api/files', outputRecord(savedId, format));
      }
      for (const old of existing)
        if (!config.formats.includes(marker(old.record)?.format as OutputFormat)) {
          await resources.client.revoke(old.record.name);
          await resources.client.api(
            '/api/file/' + encodeURIComponent(old.record.name),
            undefined,
            'DELETE',
          );
        }
      await resources.syncUnlocked();
      return { ...get(savedId), validation };
    });
  }
  async function readOutput(name: string, force = false) {
    const response = await resources.client.request(
      '/api/file/' +
        encodeURIComponent(name) +
        (force ? '?noCache=true&$options=noCache%3Dtrue' : ''),
    );
    if (!response.ok) {
      const parsed = generationErrorSchema.safeParse(await response.json().catch(() => null));
      const issue = parsed.success ? parsed.data.error : undefined;
      throw new AppError(
        issue?.code ?? 'GENERATION_FAILED',
        issue?.message ?? '上游生成失败，请检查节点与配套文件。',
        !issue && response.status >= 500 ? 502 : 422,
        issue?.diagnostics,
      );
    }
    return response.text();
  }
  return {
    get,
    detail,
    outputs,
    list(page = 0) {
      const all = visiblePlans();
      return {
        subscriptions: all.slice(page * 25, page * 25 + 25),
        total: all.length,
      };
    },
    create: (input: unknown) => save(input),
    update: (id: string, input: unknown, revision: string) => save(input, id, revision),
    async delete(id: string, revision: string) {
      return resources.client.exclusive(async () => {
        await resources.syncUnlocked();
        current(id, revision);
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
      if (revoke) {
        await resources.client.exclusive(async () => {
          await resources.syncUnlocked();
          const names = [...outputNames(current(id, revision)).values()].map(outputName);
          for (const name of names) await resources.client.revoke(name);
        });
        return;
      }
      const { plan, names, checkedRevision } = await resources.client.exclusive(async () => {
        await resources.syncUnlocked();
        current(id, revision);
        await files.ensureLegacyChainCompatibilityUnlocked();
        const plan = current(id, revision);
        if (!plan.enabled)
          throw new AppError('OUTPUT_DISABLED', '请启用方案后再创建分享地址。', 422);
        return { plan, names: outputNames(plan), checkedRevision: generationRevision(plan, id) };
      });
      const validation = await validateFormats(plan.formats, async (format) => {
        const content = await readOutput(outputName(names.get(format)));
        if (!content.trim() && plan.inputs.length)
          throw new AppError('EMPTY_OUTPUT', '此格式生成内容为空，请检查输入与筛选条件。', 422);
      });
      if (validation.some((result) => result.state !== 'ok'))
        throw new SubscriptionValidationError(validation);
      await resources.client.exclusive(async () => {
        await resources.syncUnlocked();
        current(id, revision);
        if (generationRevision(plan, id) !== checkedRevision) throw generationConflict();
        for (const value of names.values()) {
          const name = outputName(value);
          if (!(await resources.client.tokens(name)).length)
            await resources.client.api('/api/token', {
              payload: { type: 'file', name },
              options: {},
            });
        }
      });
      return validation;
    },
    async artifact(id: string, format: OutputFormat, force = false) {
      const plan = get(id);
      if (!plan.enabled || !plan.formats.includes(format))
        throw new AppError('OUTPUT_DISABLED', '方案或输出格式未启用。', 422);
      if (!plan.inputs.length) return { format, content: '' };
      await files.ensureLegacyChainCompatibility();
      const content = await readOutput(outputName(outputNames(plan).get(format)), force);
      return { format, content };
    },
  };
}
export type SubscriptionStore = ReturnType<typeof createSubscriptionStore>;
