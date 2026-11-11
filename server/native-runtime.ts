import { z } from 'zod';
import { AppError } from './errors.js';
import { outputFormatSchema, outputGroup } from './shared/subscriptions.js';
import { readStoredSubscription } from './shared/legacy-chain-inputs.js';
import { upstreamIdentitySchema, type UpstreamRecord } from './sub-store.js';
import { checkedDraft } from './converter/normalized.js';
import { renderInput } from './converter/render.js';
import { produceInput } from './converter/engine.js';
import { fillTemplate } from './templates/basic.js';
import {
  diagnostic,
  type Diagnostic,
  type RenderItem,
  type NodeDraft,
} from './shared/contracts.js';
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
type InputLocation = NonNullable<Diagnostic['location']>;
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
  const plan = readStoredSubscription(JSON.parse(String(byId(files, planId, 'plan').content)));
  const format = outputFormatSchema.parse(requested),
    group = outputGroup(format);
  if (!plan.enabled || !plan.formats.includes(format))
    throw new AppError('OUTPUT_DISABLED', '方案或输出格式已停用。', 422);
  if (!plan.inputs.length) return { content: '', diagnostics: [] };
  const sources = [...subs, ...collections];
  const cache = new Map<UpstreamRecord, Promise<Record<string, unknown>[]>>();
  async function loadNodes(record: UpstreamRecord) {
    const type = subs.includes(record) ? 'subscription' : 'collection';
    try {
      return nodesSchema.parse(
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
        '无法读取节点，请检查上游来源与处理规则。',
        422,
      );
    }
  }
  const items: RenderItem[] = [];
  const origins: InputLocation[] = [];
  const inputDiagnostics: Diagnostic[] = [];
  let firstInputError: AppError | undefined;
  function inputError(error: unknown, location: InputLocation) {
    if (!(error instanceof AppError)) throw error;
    firstInputError ??= error;
    const details = error.diagnostics?.length
      ? error.diagnostics
      : [diagnostic(-1, error.code, error.message)];
    inputDiagnostics.push(
      ...details.map((detail) => ({
        ...detail,
        nodeIndex: -1,
        location,
      })),
    );
  }
  function locate(error: unknown): never {
    if (!(error instanceof AppError) || !error.diagnostics?.length) throw error;
    const details = error.diagnostics.map((detail) => {
      const location = origins[detail.nodeIndex];
      return location ? { ...detail, location } : detail;
    });
    throw new AppError(error.code, error.message, error.status, details);
  }
  const excluded = (name: string, types: string[]) =>
    (!!plan.includeName && !name.includes(plan.includeName)) ||
    (!!plan.excludeName && name.includes(plan.excludeName)) ||
    (plan.protocols[group].length > 0 && types.some((t) => !plan.protocols[group].includes(t)));
  const draft = (raw: unknown, index: number): NodeDraft => {
    try {
      return checkedDraft(raw, index);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('TARGET_UNSUPPORTED', '协议或参数无法完整转换。', 422);
    }
  };
  for (const [index, ref] of plan.inputs.entries()) {
    const origin: InputLocation = { inputIndex: index };
    if (ref.kind === 'node') origin.nodeName = ref.nodeName;
    let list: Record<string, unknown>[];
    try {
      const source = byId(sources, ref.kind === 'node' ? ref.resourceId : ref.id);
      origin.resourceName = String(source.displayName || source.name);
      let nodes = cache.get(source);
      if (!nodes) {
        nodes = loadNodes(source);
        cache.set(source, nodes);
      }
      list = await nodes;
      if (ref.kind === 'node') {
        list = list.filter((raw) => raw.name === ref.nodeName);
        if (list.length !== 1)
          throw new AppError('NODE_REFERENCE_INVALID', '节点不存在或名称重复，请重新选择。', 422);
      }
    } catch (error) {
      inputError(error, origin);
      continue;
    }
    for (const raw of list) {
      const skip = excluded(String(raw.name), [String(raw.type)]);
      if (skip) continue;
      const location = { ...origin, nodeName: String(raw.name ?? '未命名节点') };
      try {
        const node = draft(raw, items.length);
        node.name = plan.prefix + node.name + plan.suffix;
        items.push({ nodeIndex: items.length, draft: node, excluded: false, diagnostics: [] });
        origins.push(location);
      } catch (error) {
        inputError(error, location);
      }
    }
  }
  if (firstInputError)
    throw new AppError(
      firstInputError.code,
      firstInputError.message,
      firstInputError.status,
      inputDiagnostics,
    );
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
    const result = await produceInput({ items }, client).catch(locate);
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
    ).catch(locate);
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
  return { content, diagnostics: [] };
}
