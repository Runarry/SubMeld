import { AppError } from '../errors.js';
import {
  MAX_BYTES,
  diagnostic,
  parseRequestSchema,
  produceRequestSchema,
  type Diagnostic,
  type ParseResult,
  type ProduceResult,
} from '../shared/contracts.js';
import { fromUpstream, record, toUpstream, validateDraft } from './model.js';
import { byteLimit, preflight, splitInput } from './input.js';

// The untyped upstream is isolated here; each return value is validated before use.
const loaded: unknown = await import(new URL('../../converter/upstream.mjs', import.meta.url).href);
if (!record(loaded) || typeof loaded.parse !== 'function' || typeof loaded.produce !== 'function')
  throw new Error('Invalid converter build');
const parseUpstream = loaded.parse;
const produceUpstream = loaded.produce;

export function parseInput(input: unknown): ParseResult {
  const request = parseRequestSchema.safeParse(input);
  if (!request.success) throw new AppError('INVALID_REQUEST', '解析请求格式无效。', 400);
  const { entries, diagnostics } = splitInput(request.data.text, request.data.format);
  const items = entries.map((entry, nodeIndex) => {
    const itemDiagnostics = preflight(entry, nodeIndex);
    if (itemDiagnostics.some((d) => d.level === 'error'))
      return { nodeIndex, excluded: false, draft: null, diagnostics: itemDiagnostics };
    try {
      const raw = typeof entry === 'string' ? entry : JSON.stringify(entry);
      const parsed: unknown = parseUpstream(raw);
      if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Missing input item');
      const draft = fromUpstream(parsed[0], nodeIndex);
      itemDiagnostics.push(...validateDraft(draft, nodeIndex));
      return { nodeIndex, excluded: false, draft, diagnostics: itemDiagnostics };
    } catch {
      itemDiagnostics.push(
        diagnostic(
          nodeIndex,
          'NODE_PARSE_FAILED',
          '此项无法完整解析为已支持节点；请检查必填字段和参数组合。',
        ),
      );
      return { nodeIndex, excluded: false, draft: null, diagnostics: itemDiagnostics };
    }
  });
  return {
    items,
    diagnostics,
    counts: {
      input: entries.length,
      output: items.filter((i) => i.draft && !i.diagnostics.some((d) => d.level === 'error'))
        .length,
      filtered: 0,
    },
  };
}
export function produceInput(input: unknown): ProduceResult {
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
  const lines: string[] = [];
  let outputBytes = 0;
  for (const item of included) {
    if (!item.draft) continue;
    try {
      const output: unknown = produceUpstream([structuredClone(toUpstream(item.draft))], 'URI');
      if (typeof output !== 'string' || !output || output.includes('\n') || output.includes('\r'))
        throw new Error('Invalid URI output');
      const check: unknown = parseUpstream(output);
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
