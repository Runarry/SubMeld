import { AppError } from '../errors.js';
import { preflight } from './input.js';
import { fromUpstream, record, validateDraft } from './model.js';
export function checkedDraft(value: unknown, index = 0) {
  if (!record(value)) throw new AppError('TARGET_UNSUPPORTED', '节点结构无法完整转换。', 422);
  const metadata = new Set([
    'id',
    '_subName',
    '_subDisplayName',
    '_collectionName',
    '_collectionDisplayName',
    '_submeld',
    '_resolved',
    '_IPv4',
    '_IPv6',
    '_IP',
    '_IP4P',
    '_domain',
    '_resolved_ips',
  ]);
  const raw = Object.fromEntries(
    Object.entries(value).filter(([key, field]) => field !== undefined && !metadata.has(key)),
  );
  // Native URI parsing keeps these inactive defaults on otherwise ordinary VLESS nodes.
  if (raw._h2 === false) delete raw._h2;
  if (raw.type === 'vless' && raw.encryption === 'none') delete raw.encryption;
  const diagnostics = preflight(raw, index);
  if (
    value['underlying-proxy'] ||
    value.udp === false ||
    diagnostics.some((d) => d.level === 'error' || d.code === 'EXTRA_FIELDS_NOT_IMPORTED')
  )
    throw new AppError(
      'TARGET_UNSUPPORTED',
      '节点「' +
        String(value.name ?? index + 1) +
        '」的连接字段无法由 SubMeld 测试或增强输出完整表达，请使用原生输出或明确筛选。',
      422,
      diagnostics,
    );
  try {
    const draft = fromUpstream(value, index);
    const invalid = validateDraft(draft, index);
    if (invalid.some((d) => d.level === 'error')) throw new Error('Invalid node');
    return draft;
  } catch {
    throw new AppError(
      'TARGET_UNSUPPORTED',
      '节点「' + String(value.name ?? index + 1) + '」的协议或参数超出现有增强范围。',
      422,
    );
  }
}
