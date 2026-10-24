import { Address4, Address6 } from 'ip-address';
import { z } from 'zod';

export const websiteRoutingProbeSchema = z.enum(['cf-trace', 'netease', 'bytedance']);
export type WebsiteRoutingProbe = z.infer<typeof websiteRoutingProbeSchema>;
export const websiteRoutingSiteSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(253),
  url: z.url().refine((value) => new URL(value).protocol === 'https:'),
  probe: websiteRoutingProbeSchema,
});
export type WebsiteRoutingSite = z.infer<typeof websiteRoutingSiteSchema>;
export const websiteRoutingSitesSchema = z.object({ sites: websiteRoutingSiteSchema.array() });

type Preset = Omit<WebsiteRoutingSite, 'id'> & { key: string };
export const websiteRoutingPresets: readonly Preset[] = [
  ...[
    ['cloudflare', 'Cloudflare', 'www.cloudflare.com'],
    ['chatgpt', 'ChatGPT', 'chatgpt.com'],
    ['claude', 'Claude', 'claude.ai'],
    ['x', 'X', 'x.com'],
    ['discord', 'Discord 网关', 'gateway.discord.gg'],
    ['gitlab', 'GitLab', 'gitlab.com'],
    ['npm', 'npm', 'registry.npmjs.org'],
    ['cloudflare-cn', 'Cloudflare 中国', 'www.cloudflare-cn.com'],
    ['qualcomm-cn', '高通中国', 'www.qualcomm.cn'],
  ].map(([key, name, domain]) => ({
    key,
    name,
    url: 'https://' + domain + '/cdn-cgi/trace',
    probe: 'cf-trace' as const,
  })),
  {
    key: 'netease',
    name: '网易 CDN',
    url: 'https://necaptcha.nosdn.127.net/ab7f4275c1744aa28e0a8f3a1c58c532.png',
    probe: 'netease',
  },
  {
    key: 'bytedance',
    name: '字节跳动',
    url: 'https://perfops.byte-test.com/500b-bench.jpg',
    probe: 'bytedance',
  },
];

export function websiteRoutingOrigin(input: string): string {
  const value = input.trim();
  if (
    !value ||
    /[\s\\]/u.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('请输入有效的网站域名或 HTTP(S) 地址。');
  const url = new URL(value.includes('://') ? value : 'https://' + value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('网站地址仅支持 HTTP(S)，不能包含用户名或密码。');
  url.protocol = 'https:';
  url.hostname = url.hostname.replace(/\.$/, '');
  if (!url.hostname) throw new Error('请输入有效的网站域名。');
  return url.origin;
}

export const websiteRoutingAddSchema = z.union([
  z.strictObject({ presetId: z.string().min(1).max(80) }),
  z.strictObject({
    domain: z.string().trim().min(1).max(2048),
    name: z.string().trim().min(1).max(80).optional(),
  }),
]);

export type WebsiteRoutingState =
  'idle' | 'queued' | 'running' | 'success' | 'unavailable' | 'invalid' | 'timeout' | 'cancelled';
export type WebsiteRoutingResult = {
  state: WebsiteRoutingState;
  ip?: string;
  family?: 4 | 6;
  countryCode?: string;
  elapsedMs?: number;
  checkedAt?: string;
  message?: string;
};

export function websiteRoutingIp(input: string): { ip: string; family: 4 | 6 } | null {
  const value = input.trim();
  if (!z.union([z.ipv4(), z.ipv6()]).safeParse(value).success) return null;
  let address = value.includes(':') ? new Address6(value) : new Address4(value);
  if (address instanceof Address6 && address.isMapped4()) address = address.to4();
  if (!address.isGlobal()) return null;
  return { ip: address.correctForm(), family: address instanceof Address4 ? 4 : 6 };
}

export function parseWebsiteRoutingResponse(
  probe: WebsiteRoutingProbe,
  text: string,
  headers: Record<string, string | null> = {},
): Pick<WebsiteRoutingResult, 'ip' | 'family' | 'countryCode'> | null {
  if (probe !== 'cf-trace') {
    const candidates =
      probe === 'netease'
        ? [headers['cdn-user-ip']]
        : [headers['x-request-ip'], headers['x-response-cinfo']];
    for (const value of candidates) {
      const ip = value ? websiteRoutingIp(value) : null;
      if (ip) return ip;
    }
    return null;
  }
  const fields = new Map(
    text.split(/\r?\n/).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
  const ip = websiteRoutingIp(fields.get('ip') ?? '');
  if (!ip) return null;
  const countryCode = fields.get('loc')?.toUpperCase();
  return {
    ...ip,
    ...(countryCode && /^[A-Z]{2}$/.test(countryCode) && countryCode !== 'XX'
      ? { countryCode }
      : {}),
  };
}
