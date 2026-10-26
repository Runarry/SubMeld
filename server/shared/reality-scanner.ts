import { Address4, Address6 } from 'ip-address';
import { z } from 'zod';

export const SCANNER_VERSION = '0.2.3';
export const SCAN_MAX_TARGETS = 65536;
export const SCAN_MAX_BYTES = 4 * 1024 * 1024;
export const scanParametersSchema = z.strictObject({
  port: z.number().int().min(1).max(65535).default(443),
  concurrency: z.number().int().min(1).max(32).default(2),
  timeoutSeconds: z.number().int().min(1).max(60).default(10),
  enableIpv6: z.boolean().default(false),
});
export type ScanParameters = z.infer<typeof scanParametersSchema>;
export const scanPreviewInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().max(SCAN_MAX_BYTES),
    enableIpv6: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal('url'),
    url: z.string().min(1).max(4096),
    enableIpv6: z.boolean().default(false),
  }),
]);
export const scanPreviewSchema = z.object({
  targets: z.array(z.string().max(253)).max(SCAN_MAX_TARGETS),
  count: z.number().int().nonnegative(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  invalidCount: z.number().int().nonnegative(),
});
export type ScanPreview = z.infer<typeof scanPreviewSchema>;
export const scanStartSchema = z.strictObject({
  targets: z.array(z.string().min(1).max(253)).min(1).max(SCAN_MAX_TARGETS),
  parameters: scanParametersSchema,
});
export const scanStateSchema = z.enum([
  'preparing',
  'running',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
]);
export const scanResultStateSchema = z.enum(['matched', 'unmatched', 'failed']);
export const scanResultSchema = z.object({
  position: z.number().int().nonnegative(),
  state: scanResultStateSchema,
  ip: z.string(),
  origin: z.string(),
  port: z.number().int(),
  tls: z.string(),
  alpn: z.string(),
  curve: z.string(),
  certLength: z.string(),
  certSignature: z.string(),
  certPublicKey: z.string(),
  certDomain: z.string(),
  certIssuer: z.string(),
  countryCode: z.string(),
  message: z.string(),
});
export type ScanResult = z.infer<typeof scanResultSchema>;
export const scanSummarySchema = z.object({
  id: z.string().uuid(),
  version: z.string(),
  state: scanStateSchema,
  parameters: scanParametersSchema,
  total: z.number().int().min(1).max(SCAN_MAX_TARGETS),
  completed: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string(),
  geoip: z.enum(['unknown', 'available', 'unavailable']),
});
export type ScanSummary = z.infer<typeof scanSummarySchema>;
export const scanListSchema = z.object({
  scans: z.array(scanSummarySchema),
  total: z.number().int(),
});
export const scanResultsSchema = z.object({
  results: z.array(scanResultSchema),
  total: z.number().int(),
});
export const scannerStatusSchema = z.object({
  version: z.string(),
  available: z.boolean(),
  message: z.string(),
  geoip: z.enum(['unknown', 'available', 'unavailable']),
  active: scanSummarySchema.nullable(),
});
export const scanStateLabels: Record<ScanSummary['state'], string> = {
  preparing: '准备中',
  running: '扫描中',
  cancelling: '停止中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  interrupted: '已中断',
};
export const scanResultLabels: Record<ScanResult['state'], string> = {
  matched: '候选',
  unmatched: '不符合',
  failed: '失败',
};
export function scanActive(state: ScanSummary['state']) {
  return ['preparing', 'running', 'cancelling'].includes(state);
}
export function scanDomain(value: string): string | null {
  if (!value || /[\s/:\\@?#%*[\]]/u.test(value)) return null;
  try {
    const host = new URL('https://' + value).hostname.replace(/\.$/, '').toLowerCase();
    if (host.length > 253 || /^[\d.]+$/.test(host)) return null;
    return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      ? host
      : null;
  } catch {
    return null;
  }
}

/** Merge address intervals before expansion, so overlaps cannot evade the finite limit. */
export function normalizeScanTargets(text: string, enableIpv6 = false): ScanPreview {
  const errors: ScanPreview['errors'] = [];
  let invalidCount = 0;
  const fail = (line: number, message: string) => {
    invalidCount++;
    if (errors.length < 50) errors.push({ line, message });
  };
  if (new TextEncoder().encode(text).byteLength > SCAN_MAX_BYTES) {
    fail(0, '输入超过 4 MiB。');
    return { targets: [], count: 0, errors, invalidCount };
  }
  const domains = new Set<string>();
  const ranges: { family: 4 | 6; start: bigint; end: bigint }[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const [host, prefix, extra] = value.split('/');
    const family = z.ipv4().safeParse(host).success
      ? 4
      : z.ipv6().safeParse(host).success
        ? 6
        : null;
    if (family) {
      const bits = family === 4 ? 32 : 128;
      if (
        extra !== undefined ||
        (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > bits))
      ) {
        fail(index + 1, 'CIDR 前缀无效。');
        continue;
      }
      if (family === 6 && !enableIpv6) {
        fail(index + 1, '此行包含 IPv6，请开启“允许 IPv6”。');
        continue;
      }
      const address = family === 4 ? new Address4(value) : new Address6(value);
      let start = address.startAddress().bigInt(),
        end = address.endAddress().bigInt();
      let normalizedFamily: 4 | 6 = family;
      if (address instanceof Address6 && address.isMapped4() && address.subnetMask >= 96) {
        start &= 0xffffffffn;
        end &= 0xffffffffn;
        normalizedFamily = 4;
      }
      ranges.push({ family: normalizedFamily, start, end });
    } else {
      const domain = scanDomain(value);
      if (domain) domains.add(domain);
      else fail(index + 1, '请输入 IP、CIDR 或域名，每行一项；不要包含 URL、端口或通配符。');
    }
  }
  ranges.sort(
    (a, b) => a.family - b.family || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0),
  );
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && last.family === range.family && range.start <= last.end + 1n)
      last.end = last.end > range.end ? last.end : range.end;
    else merged.push({ ...range });
  }
  const count = merged.reduce((n, range) => n + range.end - range.start + 1n, BigInt(domains.size));
  if (count > BigInt(SCAN_MAX_TARGETS)) {
    fail(0, '展开并去重后超过 65,536 个目标，请缩小网段或拆分列表。');
    return {
      targets: [],
      count: Number(
        count > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : count,
      ),
      errors,
      invalidCount,
    };
  }
  const targets: string[] = [];
  for (const range of merged)
    for (let ip = range.start; ip <= range.end; ip++)
      targets.push(
        (range.family === 4 ? Address4.fromBigInt(ip) : Address6.fromBigInt(ip)).correctForm(),
      );
  targets.push(...domains);
  if (!targets.length && !invalidCount) fail(0, '请至少输入一个目标。');
  return { targets, count: targets.length, errors, invalidCount };
}

export function scanEndpoint(row: Pick<ScanResult, 'ip' | 'port'>) {
  return row.ip ? (row.ip.includes(':') ? '[' + row.ip + ']' : row.ip) + ':' + row.port : '';
}
