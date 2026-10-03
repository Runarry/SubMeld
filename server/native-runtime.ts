import { z } from 'zod';
import { AppError } from './errors.js';
import {
  subscriptionConfigSchema,
  outputFormatSchema,
  outputGroup,
} from './shared/subscriptions.js';
import { chainConfigSchema } from './shared/chains.js';
import { upstreamIdentitySchema, type UpstreamRecord } from './sub-store.js';
import { checkedDraft } from './converter/normalized.js';
import { renderInput } from './converter/render.js';
import { produceInput } from './converter/engine.js';
import { fillTemplate } from './templates/basic.js';
import { diagnostic, isChain, type RenderItem, type NodeDraft } from './shared/contracts.js';
import { remoteCertificateResolver } from './converter/hy2-resolver-client.js';
import type { Hy2CertificateResolver } from './shared/hy2-certificates.js';
type Native = {
  read: (key: string) => unknown;
  ProxyUtils: {
    parse: (text: string) => unknown;
    produce: (
      nodes: unknown,
      target: string,
      type: string,
      options: Record<string, unknown>,
    ) => unknown;
  };
  artifact: (options: Record<string, unknown>) => Promise<unknown>;
};
const records = z.array(z.object({ name: z.string() }).catchall(z.unknown()));
const nodesSchema = z.array(z.record(z.string(), z.unknown()));
export async function generate(native: Native, planId: string, requested: string, noCache = false) {
  const subs = records.parse(native.read('subs') ?? []);
  const collections = records.parse(native.read('collections') ?? []);
  const files = records.parse(native.read('files') ?? []);
  const sourceFiles = (value: typeof files) =>
    value.filter((f) => {
      const meta = upstreamIdentitySchema.safeParse(f._submeld);
      return !meta.success || meta.data.role !== 'certificate-cache';
    });
  const before = JSON.stringify([subs, collections, sourceFiles(files)]);
  const marker = (record: UpstreamRecord) => upstreamIdentitySchema.safeParse(record._submeld);
  const byId = (all: UpstreamRecord[], id: string, role?: string) => {
    const matches = all.filter((r) => {
      const m = marker(r);
      return (
        m.success && m.data.id === id && (!role || (m.data.role === role && m.data.version === 1))
      );
    });
    if (matches.length !== 1)
      throw new AppError('REFERENCE_INVALID', '上游引用缺失或 UUID 重复，请重新选择。', 422);
    return matches[0]!;
  };
  const plan = subscriptionConfigSchema.parse(
    JSON.parse(String(byId(files, planId, 'plan').content)),
  );
  const format = outputFormatSchema.parse(requested),
    group = outputGroup(format);
  if (!plan.enabled || !plan.formats.includes(format))
    throw new AppError('OUTPUT_DISABLED', '方案或输出格式已停用。', 422);
  const cache = new Map<string, Record<string, unknown>[]>();
  const readNodes = async (id: string) => {
    const cached = cache.get(id);
    if (cached) return cached;
    const record = byId([...subs, ...collections], id);
    const type = subs.includes(record) ? 'subscription' : 'collection';
    let raw: Record<string, unknown>[];
    try {
      raw = nodesSchema.parse(
        await native.artifact({
          type,
          name: record.name,
          platform: 'JSON',
          produceType: 'internal',
          produceOpts: { 'include-unsupported-proxy': true },
          noCache,
        }),
      );
    } catch {
      throw new AppError(
        'RESOURCE_GENERATION_FAILED',
        '无法读取订阅「' +
          String(record.displayName || record.name) +
          '」，请检查上游来源与处理规则。',
        422,
      );
    }
    cache.set(id, raw);
    return raw;
  };
  const select = async (ref: { resourceId: string; nodeName: string }) => {
    const list = (await readNodes(ref.resourceId)).filter((n) => n.name === ref.nodeName);
    if (list.length !== 1)
      throw new AppError(
        'CHAIN_REFERENCE_INVALID',
        '节点「' + ref.nodeName + '」不存在或名称重复，请重新选择。',
        422,
      );
    return list[0]!;
  };
  const items: RenderItem[] = [];
  const warnings = [];
  const excluded = (name: string, types: string[]) =>
    (!!plan.includeName && !name.includes(plan.includeName)) ||
    (!!plan.excludeName && name.includes(plan.excludeName)) ||
    (plan.protocols[group].length > 0 && types.some((t) => !plan.protocols[group].includes(t)));
  const draft = (raw: unknown, index: number): NodeDraft => {
    try {
      return checkedDraft(raw, index);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'TARGET_UNSUPPORTED',
        '存在当前增强输出无法完整表达的节点，请明确筛选或使用原生订阅输出。',
        422,
        [
          diagnostic(
            index,
            'TARGET_UNSUPPORTED',
            '节点「' +
              String((raw as Record<string, unknown>)?.name ?? index + 1) +
              '」的协议或参数无法完整转换。',
          ),
        ],
      );
    }
  };
  for (const ref of plan.inputs) {
    if (ref.kind === 'chain') {
      const chain = chainConfigSchema.parse(
        JSON.parse(String(byId(files, ref.id, 'chain').content)),
      );
      if (!chain.enabled) continue;
      if (group === 'uri') {
        warnings.push(
          diagnostic(
            items.length,
            'CHAIN_URI_EXCLUDED',
            'URI／Base64 不包含链「' + chain.name + '」。',
            undefined,
            'warning',
          ),
        );
        continue;
      }
      const entry = await select(chain.entry),
        exit = await select(chain.exit);
      if (JSON.stringify(chain.entry) === JSON.stringify(chain.exit))
        throw new AppError('CHAIN_INVALID', '链的前置和出口必须不同。', 422);
      if (entry['underlying-proxy'] || exit['underlying-proxy'])
        throw new AppError('CHAIN_INVALID', '链成员已包含前置代理，请选择普通节点。', 422);
      const skip = excluded(chain.name, [String(entry.type), String(exit.type)]);
      if (skip) continue;
      items.push({
        kind: 'chain',
        nodeIndex: items.length,
        name: plan.prefix + chain.name + plan.suffix,
        entry: draft(entry, items.length),
        exit: draft(exit, items.length),
        available: true,
        excluded: false,
        diagnostics: [],
      });
    } else {
      const list = ref.kind === 'node' ? [await select(ref)] : await readNodes(ref.id);
      for (const raw of list) {
        const skip = excluded(String(raw.name), [String(raw.type)]);
        if (skip) continue;
        const node = draft(raw, items.length);
        node.name = plan.prefix + node.name + plan.suffix;
        items.push({ nodeIndex: items.length, draft: node, excluded: false, diagnostics: [] });
      }
    }
  }
  const client = {
    async convert(data: string, target: string, internal = false): Promise<unknown> {
      return native.ProxyUtils.produce(
        native.ProxyUtils.parse(data),
        target,
        internal ? 'internal' : 'text',
        { 'include-unsupported-proxy': true },
      );
    },
  };
  const resolveCertificate: Hy2CertificateResolver = async (request, signal) => {
    const connections = files.filter((file) => {
      const m = marker(file);
      return m.success && m.data.role === 'certificate-resolver' && m.data.version === 1;
    });
    if (connections.length !== 1)
      throw new AppError(
        'HY2_RESOLVER_UNAVAILABLE',
        'HY2 证书解析连接文件缺失或重复，请更新配套文件。',
        422,
      );
    let resolve;
    try {
      resolve = remoteCertificateResolver(JSON.parse(String(connections[0]!.content)));
    } catch {
      throw new AppError(
        'HY2_RESOLVER_UNAVAILABLE',
        'HY2 证书解析连接文件无效，请更新配套文件。',
        422,
      );
    }
    return resolve(request, signal);
  };
  let content: string;
  if (group === 'uri') {
    const result = await produceInput({ items: items.filter((item) => !isChain(item)) }, client);
    const output = format === 'base64' ? result.base64 : result.uri;
    if (output === null)
      throw new AppError('OUTPUT_LIMIT_EXCEEDED', 'Base64 输出超过允许大小。', 422);
    content = output;
  } else {
    const templates = files.filter((f) => {
      const m = marker(f);
      return (
        m.success && m.data.role === 'template' && m.data.format === group && m.data.version === 1
      );
    });
    if (templates.length !== 1)
      throw new AppError('TEMPLATE_INVALID', '输出模板缺失或重复，请检查 Sub-Store 文件。', 422);
    let template: unknown;
    try {
      template = JSON.parse(
        String(await native.artifact({ type: 'file', name: templates[0]!.name, noCache })),
      );
    } catch {
      throw new AppError('TEMPLATE_INVALID', '模板必须是有效的 JSON 内容。', 422);
    }
    const result = await renderInput(
      { items, target: group, listenPort: plan.listenPort },
      client,
      undefined,
      (target, nodes, names, port) => fillTemplate(template, target, nodes, names, port),
      resolveCertificate,
    );
    content = format === group ? result.full : result.nodes;
  }
  if (
    before !==
    JSON.stringify([
      native.read('subs') ?? [],
      native.read('collections') ?? [],
      sourceFiles(records.parse(native.read('files') ?? [])),
    ])
  )
    throw new AppError('REVISION_CONFLICT', '生成期间上游配置已变化，请重试。', 409);
  return { content, diagnostics: warnings };
}
