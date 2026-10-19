import { z } from 'zod';
import { AppError } from '../errors.js';
import { upstreamIdentitySchema } from '../sub-store.js';
import {
  inputRefSchema,
  outputFormatSchema,
  subscriptionConfigSchema,
  type SubscriptionConfig,
} from './subscriptions.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Stored chain references are retired on read; the source document is never changed. */
export function withoutLegacyChainInputs(value: unknown) {
  if (!record(value) || !Array.isArray(value.inputs)) return value;
  return {
    ...value,
    inputs: value.inputs.filter((input) => !record(input) || input.kind !== 'chain'),
  };
}

const emptyLegacyPlanSchema = subscriptionConfigSchema.extend({
  inputs: z.array(inputRefSchema).length(0),
});

export function readStoredSubscription(value: unknown): SubscriptionConfig {
  const filtered = withoutLegacyChainInputs(value);
  const legacyOnly =
    record(value) &&
    Array.isArray(value.inputs) &&
    value.inputs.length > 0 &&
    record(filtered) &&
    Array.isArray(filtered.inputs) &&
    filtered.inputs.length === 0;
  return (legacyOnly ? emptyLegacyPlanSchema : subscriptionConfigSchema).parse(filtered);
}

type Native = { read: (key: string) => unknown };
type Runtime = {
  generate: (
    native: Native,
    planId: string,
    requested: string,
    noCache?: boolean,
  ) => Promise<unknown>;
};
const records = z.array(z.object({ name: z.string() }).catchall(z.unknown()));

/** Appended to saved runtimes by a file Script Operator, without replacing their code. */
export function installLegacyChainAdapter(runtime: Runtime) {
  const generate = runtime.generate;
  runtime.generate = async (native, planId, requested, noCache = false) => {
    const readFiles = () => {
      const files = native.read('files') ?? [];
      if (!Array.isArray(files)) return files;
      return files
        .filter(
          (file: unknown) =>
            !record(file) || !record(file._submeld) || file._submeld.role !== 'chain',
        )
        .map((file: unknown) => {
          const clone: unknown = JSON.parse(JSON.stringify(file));
          if (!record(clone) || !record(clone._submeld) || clone._submeld.role !== 'plan')
            return clone;
          try {
            clone.content = JSON.stringify(
              withoutLegacyChainInputs(JSON.parse(String(clone.content))),
            );
          } catch {
            // Keep malformed documents intact so the original runtime reports their error.
          }
          return clone;
        });
    };
    const originalFiles = records.parse(native.read('files') ?? []);
    const plans = originalFiles.filter((file) => {
      const meta = upstreamIdentitySchema.safeParse(file._submeld);
      return (
        meta.success &&
        meta.data.id === planId &&
        meta.data.role === 'plan' &&
        meta.data.version === 1
      );
    });
    if (plans.length === 1) {
      const plan = readStoredSubscription(JSON.parse(String(plans[0]!.content)));
      if (!plan.inputs.length) {
        records.parse(native.read('subs') ?? []);
        records.parse(native.read('collections') ?? []);
        const format = outputFormatSchema.parse(requested);
        if (!plan.enabled || !plan.formats.includes(format))
          throw new AppError('OUTPUT_DISABLED', '方案或输出格式已停用。', 422);
        return { content: '', diagnostics: [] };
      }
    }
    return generate(
      { ...native, read: (key) => (key === 'files' ? readFiles() : native.read(key)) },
      planId,
      requested,
      noCache,
    );
  };
}
