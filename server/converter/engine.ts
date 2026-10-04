import { AppError } from '../errors.js';
import {
  MAX_BYTES,
  diagnostic,
  produceRequestSchema,
  type Diagnostic,
  type ProduceResult,
} from '../shared/contracts.js';
import { fromUpstream, toUpstream, validateDraft } from './model.js';
import { byteLimit } from './input.js';

import { SubStoreClient } from '../sub-store.js';
import { record } from './model.js';
import type { NodeDraft } from '../shared/contracts.js';
import { hysteriaUri } from './hysteria2.js';

// The pinned upstream decodes TUIC passwords twice. Adapt only the API input,
// never the stored/public URI; remove when a verified upstream release fixes it.
function parserInput(raw: string) {
  if (!raw.startsWith('tuic://')) return hysteriaUri(raw);
  const url = new URL(raw);
  url.password = encodeURIComponent(url.password);
  return url.href;
}
function completeUri(raw: unknown, node: NodeDraft): string {
  if (typeof raw !== 'string' || !raw) throw new Error('Empty upstream output');
  if (node.protocol === 'ss') {
    const url = new URL(raw);
    url.searchParams.delete('udp');
    return url.href;
  }
  if (node.protocol === 'trojan') {
    const separator = raw.lastIndexOf('@');
    if (separator < 0) throw new Error('Invalid upstream URI');
    return 'trojan://' + encodeURIComponent(node.auth.password) + raw.slice(separator);
  }
  if (node.protocol === 'vmess') {
    const value: unknown = JSON.parse(Buffer.from(raw.slice(8), 'base64').toString('utf8'));
    if (!record(value)) throw new Error('Invalid VMess output');
    value.allowInsecure = node.tls.insecure ? 1 : 0;
    return 'vmess://' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  }
  if (node.protocol === 'tuic' && node.tls.alpn.length) {
    const url = new URL(raw);
    url.searchParams.set('alpn', node.tls.alpn.join(','));
    return url.href;
  }
  return raw;
}

export async function produceUpstream(
  proxies: unknown[],
  target: string,
  type?: string,
  client: Pick<SubStoreClient, 'convert'> = new SubStoreClient(),
  signal?: AbortSignal,
): Promise<unknown> {
  return client.convert(
    proxies.map((p) => JSON.stringify(p)).join('\n'),
    target,
    type === 'internal',
    signal,
  );
}

export function prepareItems(input: unknown) {
  byteLimit(JSON.stringify(input));
  const request = produceRequestSchema.safeParse(input);
  if (!request.success) throw new AppError('INVALID_REQUEST', '节点数据结构无效。', 400);
  const { items } = request.data;
  const indices = new Set(items.map((item) => item.nodeIndex));
  if (indices.size !== items.length)
    throw new AppError('INVALID_REQUEST', '节点序号不能重复。', 400);
  const diagnostics: Diagnostic[] = [];
  const included = items.filter((item) => !item.excluded);
  if (!included.length) throw new AppError('EMPTY_OUTPUT', '至少保留一个有效节点。');
  for (const item of included) {
    if (!item.draft)
      diagnostics.push(
        diagnostic(item.nodeIndex, 'NODE_REQUIRED', '此项尚未解析成功，请修正或明确排除。'),
      );
    else diagnostics.push(...validateDraft(item.draft, item.nodeIndex));
  }
  if (diagnostics.some((d) => d.level === 'error'))
    throw new AppError('CONVERSION_FAILED', '请修正或明确排除错误节点。', 422, diagnostics);
  return { items, included, diagnostics };
}
export async function produceInput(
  input: unknown,
  client: Pick<SubStoreClient, 'convert'> = new SubStoreClient(),
  signal?: AbortSignal,
): Promise<ProduceResult> {
  const { items, included, diagnostics } = prepareItems(input);
  const lines: string[] = [];
  let outputBytes = 0;
  for (const item of included) {
    if (!item.draft) continue;
    try {
      const output = completeUri(
        await produceUpstream(
          [structuredClone(toUpstream(item.draft))],
          'URI',
          undefined,
          client,
          signal,
        ),
        item.draft,
      );
      if (typeof output !== 'string' || !output || output.includes('\n') || output.includes('\r'))
        throw new Error('Invalid URI output');
      const check = await client.convert(parserInput(output), 'JSON', true, signal);
      if (!Array.isArray(check) || check.length !== 1) throw new Error('Missing output item');
      const roundTrip = fromUpstream(check[0], item.nodeIndex);
      // Check the promised connection fields, not arbitrary upstream metadata.
      const node = item.draft;
      if (
        roundTrip.protocol !== node.protocol ||
        roundTrip.server !== node.server ||
        roundTrip.port !== node.port ||
        roundTrip.name !== node.name ||
        JSON.stringify(roundTrip.auth) !== JSON.stringify(node.auth) ||
        JSON.stringify(roundTrip.protocolOptions) !== JSON.stringify(node.protocolOptions) ||
        roundTrip.tls.mode !== node.tls.mode ||
        roundTrip.tls.insecure !== node.tls.insecure ||
        (node.tls.serverName && roundTrip.tls.serverName !== node.tls.serverName) ||
        (node.tls.alpn.length &&
          JSON.stringify(roundTrip.tls.alpn) !== JSON.stringify(node.tls.alpn)) ||
        roundTrip.tls.publicKey !== node.tls.publicKey ||
        roundTrip.tls.shortId !== node.tls.shortId ||
        roundTrip.tls.fingerprint !== node.tls.fingerprint ||
        roundTrip.transport.type !== node.transport.type ||
        (node.transport.type === 'ws' &&
          (roundTrip.transport.path !== node.transport.path ||
            (node.transport.host && roundTrip.transport.host !== node.transport.host))) ||
        (node.transport.type === 'grpc' &&
          roundTrip.transport.serviceName !== node.transport.serviceName)
      )
        throw new Error('Connection field changed');
      outputBytes += Buffer.byteLength(output) + (lines.length ? 1 : 0);
      if (outputBytes > MAX_BYTES)
        throw new AppError('OUTPUT_LIMIT_EXCEEDED', 'URI 输出超过 4 MiB。');
      lines.push(output);
    } catch (error) {
      if (error instanceof AppError) throw error;
      diagnostics.push(
        diagnostic(
          item.nodeIndex,
          'EXPORT_FIELD_LOSS',
          '此项无法完整输出已编辑的连接字段；请修正参数或明确排除。',
        ),
      );
    }
  }
  if (diagnostics.some((d) => d.level === 'error') || lines.length !== included.length)
    throw new AppError(
      'CONVERSION_FAILED',
      '部分节点无法完整生成，本批次未导出。',
      422,
      diagnostics,
    );
  const uri = lines.join('\n');
  const encoded = Buffer.from(uri, 'utf8').toString('base64');
  const base64 = encoded.length <= MAX_BYTES ? encoded : null;
  if (base64 === null)
    diagnostics.push(
      diagnostic(-1, 'BASE64_OUTPUT_LIMIT', 'Base64 输出超过 4 MiB；URI 结果仍可使用。'),
    );
  return {
    uri,
    base64,
    diagnostics,
    counts: { input: items.length, output: lines.length, filtered: items.length - included.length },
  };
}
