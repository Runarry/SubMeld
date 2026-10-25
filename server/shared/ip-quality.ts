import { z } from 'zod';
import { websiteRoutingIp } from './website-routing.js';

export const IP_QUALITY_VERSION = 'xykt-2026-09-16-submeld-1';
export const ipQualityAddress = websiteRoutingIp;
export const ipQualityQuerySchema = z.strictObject({
  ip: z
    .string()
    .trim()
    .max(64)
    .refine((value) => ipQualityAddress(value) !== null, {
      message: '请输入单个有效的公网 IPv4 或 IPv6，不包含端口、网段或网址。',
    }),
  refresh: z.boolean().default(false),
});
export const ipQualityProviders = [
  { id: 'maxmind', name: 'MaxMind' },
  { id: 'ipinfo', name: 'IPinfo' },
  { id: 'scamalytics', name: 'Scamalytics' },
  { id: 'ipregistry', name: 'IPregistry' },
  { id: 'ipapi', name: 'ipapi.is' },
  { id: 'abuseipdb', name: 'AbuseIPDB' },
  { id: 'ip2location', name: 'IP2Location' },
  { id: 'ipdata', name: 'IPdata' },
  { id: 'ipqs', name: 'IPQS' },
  { id: 'dbip', name: 'DB-IP' },
] as const;
export type IpQualityProvider = (typeof ipQualityProviders)[number]['id'];
export const ipQualityFactorLabels = {
  proxy: '代理',
  vpn: 'VPN',
  tor: 'Tor',
  hosting: '机房',
  abuser: '滥用',
  bot: '爬虫／机器人',
  mobile: '移动网络',
  satellite: '卫星网络',
} as const;
export const ipQualityInfoLabels = {
  country: '国家／地区',
  countryCode: '地区代码',
  registeredCountryCode: '注册地区代码',
  region: '省／州',
  city: '城市',
  asn: 'ASN',
  organization: '组织／运营商',
  timezone: '时区',
  network: '所属网段',
} as const;
const infoSchema = z.object({
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
  registeredCountryCode: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  asn: z.string().nullable(),
  organization: z.string().nullable(),
  timezone: z.string().nullable(),
  network: z.string().nullable(),
});
export const ipQualityDataSchema = z.object({
  info: infoSchema,
  networkType: z.string().nullable(),
  companyType: z.string().nullable(),
  scores: z.array(
    z.object({
      label: z.string(),
      value: z.number().min(0).max(100),
      unit: z.enum(['points', 'percent']),
      scope: z.enum(['ip', 'network']),
      level: z.string().nullable(),
    }),
  ),
  factors: z.object({
    proxy: z.boolean().nullable(),
    vpn: z.boolean().nullable(),
    tor: z.boolean().nullable(),
    hosting: z.boolean().nullable(),
    abuser: z.boolean().nullable(),
    bot: z.boolean().nullable(),
    mobile: z.boolean().nullable(),
    satellite: z.boolean().nullable(),
  }),
  totalReports: z.number().int().nonnegative().nullable(),
  lastReportedAt: z.string().nullable(),
});
export type IpQualityData = z.infer<typeof ipQualityDataSchema>;
export const ipQualitySourceSchema = z.object({
  id: z.enum(ipQualityProviders.map((item) => item.id)),
  name: z.string(),
  status: z.enum(['success', 'unavailable', 'invalid', 'timeout', 'rate_limited', 'unsupported']),
  checkedAt: z.string(),
  cached: z.boolean(),
  message: z.string(),
  retryAt: z.string().optional(),
  data: ipQualityDataSchema.optional(),
});
export type IpQualitySource = z.infer<typeof ipQualitySourceSchema>;
export const ipQualityDnsblSchema = z.object({
  id: z.string(),
  name: z.string(),
  zone: z.string(),
  family: z.union([z.literal(4), z.literal(6)]),
  status: z.enum(['listed', 'not_listed', 'unavailable', 'unknown', 'timeout', 'unsupported']),
  checkedAt: z.string(),
  cached: z.boolean(),
  answers: z.string().array(),
  message: z.string(),
});
export type IpQualityDnsbl = z.infer<typeof ipQualityDnsblSchema>;
export const ipQualityReportSchema = z.object({
  ip: z.string(),
  family: z.union([z.literal(4), z.literal(6)]),
  version: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(['complete', 'partial', 'failed']),
  sources: ipQualitySourceSchema.array(),
  dnsbl: ipQualityDnsblSchema.array(),
  blacklist: z.object({
    queried: z.number().int(),
    valid: z.number().int(),
    listed: z.number().int(),
  }),
});
export type IpQualityReport = z.infer<typeof ipQualityReportSchema>;
