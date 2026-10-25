/**
 * Adapted from xykt/IPQuality (xykt), AGPL-3.0.
 * https://github.com/xykt/IPQuality/blob/87397e2c3196ec796f5477c83343c2354df601ea/ip.sh
 * Script v2026-09-16. See docs/ip-quality-attribution.md and the root LICENSE.
 * Only fixed IP lookup mappings are ported; no remote script is executed.
 */
import {
  ipQualityAddress,
  type IpQualityData,
  type IpQualityProvider,
} from './shared/ip-quality.js';

// Public demo fallback embedded in the pinned upstream script; server-only.
export const IPREGISTRY_DEFAULT_KEY = 'sb69ksjcajfs4c';
export const IP_QUALITY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

export function field(value: unknown, path: string): unknown {
  for (const part of path.split('.')) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, part)
    )
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function text(value: unknown): string | null {
  return typeof value === 'string' &&
    value.trim() &&
    !['null', 'N/A', 'undefined'].includes(value.trim())
    ? value.trim().slice(0, 512)
    : null;
}
function number(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function anyFlag(values: unknown[]): boolean | null {
  return values.some((v) => v === true) ? true : values.every((v) => v === false) ? false : null;
}
function asn(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : text(value);
  return raw && /^(?:AS)?\d+$/i.test(raw) ? 'AS' + raw.replace(/^AS/i, '') : null;
}
function country(value: unknown): string | null {
  const raw = text(value)?.toUpperCase();
  return raw && /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : null;
}
const typeNames: Record<string, string> = {
  business: '商业',
  hosting: '机房',
  isp: 'ISP',
  education: '教育',
  government: '政府',
  banking: '银行',
  COM: '商业',
  DCH: '机房',
  EDU: '教育',
  GOV: '政府',
  ORG: '组织',
  MIL: '军事',
  LIB: '图书馆',
  CDN: 'CDN',
  ISP: '固定 ISP',
  MOB: '移动 ISP',
  SES: '搜索引擎',
  RSV: '保留地址',
};
function networkType(value: unknown): string | null {
  const raw = text(value);
  return raw ? (typeNames[raw] ?? raw) : null;
}
export class IpQualityFailure extends Error {
  constructor(
    public status: 'unavailable' | 'invalid' | 'timeout' | 'rate_limited',
    message: string,
    public httpStatus?: number,
    public retryAt?: string,
  ) {
    super(message);
  }
}
export function providerUrl(id: IpQualityProvider, ip: string): string {
  const encoded = encodeURIComponent(ip);
  if (id === 'ipinfo') return 'https://ipinfo.io/widget/demo/' + encoded;
  if (id === 'maxmind') return 'https://ipinfo.check.place/' + encoded + '?lang=cn';
  const databases: Partial<Record<IpQualityProvider, string>> = {
    scamalytics: 'scamalytics',
    ipapi: 'ipapi',
    abuseipdb: 'abuseipdb',
    ip2location: 'ip2location',
    ipdata: 'ipdata',
    ipqs: 'ipqualityscore',
  };
  const database = databases[id];
  if (!database) throw new Error('Provider needs its own lookup adapter');
  return 'https://ipinfo.check.place/' + encoded + '?db=' + database;
}
export function parseIpQualityData(
  id: IpQualityProvider,
  value: unknown,
  ip: string,
): IpQualityData {
  const get = (path: string) => field(value, path);
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    get('success') === false ||
    get('error') ||
    get('errorCode') ||
    get('error_code') ||
    get('errors') ||
    get('data.error')
  )
    throw new IpQualityFailure('invalid', '来源返回错误或无效的数据。');
  for (const path of ['ip', 'ipAddress', 'ip_address', 'data.ip', 'data.ipAddress']) {
    const echoed = get(path);
    if (
      echoed !== undefined &&
      echoed !== null &&
      (typeof echoed !== 'string' || ipQualityAddress(echoed)?.ip !== ip)
    )
      throw new IpQualityFailure('invalid', '来源返回的 IP 与查询地址不一致。');
  }
  const data: IpQualityData = {
    info: {
      country: null,
      countryCode: null,
      registeredCountryCode: null,
      region: null,
      city: null,
      asn: null,
      organization: null,
      timezone: null,
      network: null,
    },
    networkType: null,
    companyType: null,
    scores: [],
    factors: {
      proxy: null,
      vpn: null,
      tor: null,
      hosting: null,
      abuser: null,
      bot: null,
      mobile: null,
      satellite: null,
    },
    totalReports: null,
    lastReportedAt: null,
  };
  function info(paths: Partial<Record<keyof IpQualityData['info'], string>>) {
    for (const key of Object.keys(paths) as (keyof IpQualityData['info'])[]) {
      const raw = get(paths[key]!);
      data.info[key] = key === 'asn' ? asn(raw) : key.endsWith('Code') ? country(raw) : text(raw);
    }
  }
  function flags(paths: Partial<Record<keyof IpQualityData['factors'], string | string[]>>) {
    for (const key of Object.keys(paths) as (keyof IpQualityData['factors'])[]) {
      const path = paths[key]!;
      data.factors[key] = Array.isArray(path) ? anyFlag(path.map(get)) : boolean(get(path));
    }
  }
  function types(network: string, company?: string) {
    data.networkType = networkType(get(network));
    data.companyType = company ? networkType(get(company)) : null;
  }
  function score(path: string, label: string, thresholds: number[], levels: string[]) {
    const n = number(get(path));
    if (n !== null && n >= 0 && n <= 100)
      data.scores.push({
        label,
        value: n,
        unit: 'points',
        scope: 'ip',
        level: levels[thresholds.findIndex((threshold) => n < threshold)] ?? levels.at(-1) ?? null,
      });
  }
  switch (id) {
    case 'maxmind':
      info({
        country: 'Country.Name',
        countryCode: 'Country.IsoCode',
        registeredCountryCode: 'Country.RegisteredCountry.IsoCode',
        city: 'City.Name',
        asn: 'ASN.AutonomousSystemNumber',
        organization: 'ASN.AutonomousSystemOrganization',
        timezone: 'City.Location.TimeZone',
      });
      data.info.country ??= text(get('City.Country.Name'));
      data.info.countryCode ??= country(get('City.Country.IsoCode'));
      break;
    case 'ipinfo':
      info({
        countryCode: 'data.country',
        registeredCountryCode: 'data.abuse.country',
        city: 'data.city',
        region: 'data.region',
        asn: 'data.asn.asn',
        organization: 'data.asn.name',
        timezone: 'data.timezone',
        network: 'data.asn.route',
      });
      types('data.asn.type', 'data.company.type');
      flags({
        proxy: 'data.privacy.proxy',
        vpn: 'data.privacy.vpn',
        tor: 'data.privacy.tor',
        hosting: 'data.privacy.hosting',
      });
      break;
    case 'scamalytics':
      info({ countryCode: 'external_datasources.maxmind_geolite2.ip_country_code' });
      flags({
        proxy: 'external_datasources.firehol.is_proxy',
        tor: 'external_datasources.x4bnet.is_tor',
        vpn: 'scamalytics.scamalytics_proxy.is_vpn',
        hosting: 'scamalytics.scamalytics_proxy.is_datacenter',
        abuser: 'scamalytics.is_blacklisted_external',
        bot: [
          'external_datasources.x4bnet.is_blacklisted_spambot',
          'external_datasources.x4bnet.is_bot_operamini',
          'external_datasources.x4bnet.is_bot_semrush',
        ],
      });
      score(
        'scamalytics.scamalytics_score',
        '欺诈风险评分',
        [20, 60, 90],
        ['低', '中', '高', '极高'],
      );
      break;
    case 'ipregistry':
      info({
        country: 'location.country.name',
        countryCode: 'location.country.code',
        region: 'location.region.name',
        city: 'location.city',
        asn: 'connection.asn',
        organization: 'connection.organization',
        timezone: 'time_zone.id',
        network: 'connection.route',
      });
      types('connection.type', 'company.type');
      flags({
        proxy: 'security.is_proxy',
        vpn: 'security.is_vpn',
        tor: ['security.is_tor', 'security.is_tor_exit'],
        hosting: 'security.is_cloud_provider',
        abuser: 'security.is_abuser',
      });
      break;
    case 'ipapi': {
      info({
        country: 'location.country',
        countryCode: 'location.country_code',
        city: 'location.city',
        region: 'location.state',
        asn: 'asn.asn',
        organization: 'company.name',
        network: 'company.network',
        timezone: 'location.timezone',
      });
      types('asn.type', 'company.type');
      flags({
        proxy: 'is_proxy',
        vpn: 'is_vpn',
        tor: 'is_tor',
        hosting: 'is_datacenter',
        abuser: 'is_abuser',
        bot: 'is_crawler',
        mobile: 'is_mobile',
        satellite: 'is_satellite',
      });
      for (const [path, label] of [
        ['company.abuser_score', '所属网段滥用地址比例'],
        ['asn.abuser_score', 'ASN 网段滥用地址比例'],
      ]) {
        const match = text(get(path!))?.match(/^(\d+(?:\.\d+)?)\s*\(([^)]+)\)$/);
        if (match && Number(match[1]) <= 1)
          data.scores.push({
            label: label!,
            value: Number(match[1]) * 100,
            unit: 'percent',
            scope: 'network',
            level: match[2]!,
          });
      }
      break;
    }
    case 'abuseipdb': {
      info({
        countryCode: 'data.countryCode',
        country: 'data.countryName',
        organization: 'data.isp',
      });
      types('data.usageType');
      flags({ tor: 'data.isTor' });
      score('data.abuseConfidenceScore', '滥用置信度', [25, 75], ['低', '高', '极高']);
      const reports = number(get('data.totalReports'));
      data.totalReports =
        reports !== null && Number.isSafeInteger(reports) && reports >= 0 ? reports : null;
      const date = text(get('data.lastReportedAt'));
      data.lastReportedAt =
        date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
      break;
    }
    case 'ip2location':
      info({
        country: 'country_name',
        countryCode: 'country_code',
        city: 'city_name',
        region: 'region_name',
        asn: 'asn',
        organization: 'as',
      });
      types('usage_type', 'as_info.as_usage_type');
      flags({
        proxy: ['is_proxy', 'proxy.is_public_proxy', 'proxy.is_web_proxy'],
        vpn: 'proxy.is_vpn',
        tor: 'proxy.is_tor',
        hosting: 'proxy.is_data_center',
        abuser: 'proxy.is_spammer',
        bot: ['proxy.is_web_crawler', 'proxy.is_scanner', 'proxy.is_botnet'],
      });
      score('fraud_score', '欺诈风险评分', [33, 66], ['低', '中', '高']);
      break;
    case 'ipdata':
      info({
        country: 'country_name',
        countryCode: 'country_code',
        city: 'city',
        region: 'region',
        asn: 'asn.asn',
        organization: 'asn.name',
      });
      flags({
        proxy: 'threat.is_proxy',
        tor: 'threat.is_tor',
        hosting: 'threat.is_datacenter',
        abuser: ['threat.is_threat', 'threat.is_known_abuser', 'threat.is_known_attacker'],
      });
      break;
    case 'ipqs':
      info({
        countryCode: 'country_code',
        city: 'city',
        region: 'region',
        asn: 'ASN',
        organization: 'ISP',
        timezone: 'timezone',
      });
      flags({
        proxy: 'proxy',
        vpn: 'vpn',
        tor: 'tor',
        abuser: 'recent_abuse',
        bot: 'bot_status',
        mobile: 'mobile',
      });
      score('fraud_score', '欺诈风险评分', [75, 85, 90], ['低', '可疑', '有风险', '高风险']);
      break;
  }
  if (
    !Object.values(data.info).some((v) => v !== null) &&
    !Object.values(data.factors).some((v) => v !== null) &&
    !data.networkType &&
    !data.companyType &&
    !data.scores.length &&
    data.totalReports === null &&
    !data.lastReportedAt
  )
    throw new IpQualityFailure('invalid', '来源未提供可验证的资料或风险字段。');
  return data;
}
