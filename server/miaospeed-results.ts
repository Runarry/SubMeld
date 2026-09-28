import { z } from 'zod';
import { isIP } from 'node:net';
import { metricDefinitions, type Measurement, type TestScript } from './shared/miaospeed.js';
import type { BackendSlot } from './miaospeed-client.js';
const number = z.number().finite().nonnegative();
const numeric = z.object({ Value: number });
const samples = z.object({ Values: z.array(number).max(10000) });
const series = z.object({ Speeds: z.array(number).max(10000), Average: number, Max: number });
const geoInfo = z.object({
  ip: z.string(),
  country: z.string().default(''),
  country_code: z.string().default(''),
  asn: z.number().default(0),
  organization: z.string().default(''),
  asn_organization: z.string().default(''),
  isp: z.string().default(''),
});
const geo = z.object({
  IPv4Stack: z.array(geoInfo).nullable().optional(),
  IPv6Stack: z.array(geoInfo).nullable().optional(),
  MainStack: geoInfo.nullable().optional(),
});
function color(raw: string | undefined) {
  if (!raw) return null;
  if (/^#[\da-f]{6}$/i.test(raw)) return raw;
  const parts = raw.split(',').map((v) => Number(v.trim()));
  return parts.length === 3 && parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    ? '#' + parts.map((v) => v.toString(16).padStart(2, '0')).join('')
    : null;
}
export function measurements(
  slot: BackendSlot,
  selected: string[],
  scripts: Pick<TestScript, 'id' | 'name'>[],
): Measurement[] {
  const values = new Map<string, unknown>();
  for (const item of slot.Matrices ?? []) {
    try {
      const value: unknown = JSON.parse(item.Payload);
      if (item.Type === 'TEST_SCRIPT') {
        const key = z.object({ Key: z.string() }).parse(value).Key;
        values.set('script:' + key, value);
      } else values.set(item.Type, value);
    } catch {
      /* Missing/malformed values remain unknown, never zero-success. */
    }
  }
  return [
    ...selected.map((id) => {
      const def = metricDefinitions.find((v) => v[0] === id)!;
      return { id, label: def[1], unit: def[2] };
    }),
    ...scripts.map((s) => ({ id: 'script:' + s.id, label: s.name, unit: '' })),
  ].map(({ id, label, unit }) => {
    const result: Measurement = {
      id,
      label,
      unit,
      status: 'unknown',
      value: null,
      samples: [],
      geo: [],
      color: null,
      message: '后端未返回有效结果。',
    };
    try {
      const raw = values.get(id);
      if (id.startsWith('script:')) {
        const data = z
          .object({ Text: z.string().max(8192), Background: z.string().optional() })
          .parse(raw);
        result.value = data.Text;
        result.color = color(data.Background);
        result.status =
          /未知|失败|超时|错误|不可用|unknown|error|timeout|failed|n\/a/i.test(data.Text) ||
          !data.Text.trim()
            ? 'unknown'
            : 'measured';
      } else if (id.startsWith('GEOIP_')) {
        const data = geo.parse(raw);
        result.geo = [
          ...(data.IPv4Stack ?? []),
          ...(data.IPv6Stack ?? []),
          ...(data.MainStack ? [data.MainStack] : []),
        ]
          .filter((v, i, a) => isIP(v.ip) && a.findIndex((x) => x.ip === v.ip) === i)
          .map((v) => ({
            ip: v.ip,
            country: v.country,
            countryCode: v.country_code,
            asn: v.asn,
            organization: v.asn_organization || v.organization,
            isp: v.isp,
          }));
        if (!result.geo.length) return result;
        result.value = result.geo
          .map((v) => [v.ip, v.country, v.asn ? 'AS' + v.asn : ''].filter(Boolean).join(' · '))
          .join('; ');
        result.status = 'measured';
      } else if (id === 'TEST_HIJACK_DETECTION') {
        const data = z.object({ SpeedIP: z.string(), RealIP: z.string() }).parse(raw);
        if (!isIP(data.SpeedIP) || !isIP(data.RealIP)) return result;
        result.value = data.SpeedIP === data.RealIP ? '出口一致' : '出口不同，疑似劫持';
        result.color = data.SpeedIP === data.RealIP ? '#e4f3e9' : '#fff0cf';
        result.message = '测速出口 ' + data.SpeedIP + '；实际出口 ' + data.RealIP;
        result.status = 'measured';
      } else if (id === 'UDP_TYPE') {
        result.value = z.object({ Value: z.string().min(1) }).parse(raw).Value;
        result.status = /unknown|error|blocked|未知|失败/i.test(result.value)
          ? 'unknown'
          : 'measured';
      } else if (id.endsWith('_PER_SECOND')) {
        const data = series.parse(raw);
        if (!data.Speeds.length || !data.Speeds.some((v) => v > 0)) return result;
        result.samples = data.Speeds;
        result.value = data.Average;
        result.status = 'measured';
      } else if (id === 'TEST_HTTP_CODE' || id.includes('_TOTAL_') || id === 'TEST_PING_MAX_CONN') {
        const data = samples.parse(
          id === 'TEST_PING_MAX_CONN' ? values.get('TEST_PING_TOTAL_CONN') : raw,
        );
        result.samples = data.Values;
        if (
          id === 'TEST_HTTP_CODE' &&
          data.Values.some((v) => !Number.isInteger(v) || v > 599 || (v > 0 && v < 100))
        )
          return result;
        const positive = data.Values.filter((v) => v > 0);
        if (!positive.length) return result;
        result.value = id === 'TEST_PING_MAX_CONN' ? Math.max(...positive) : data.Values.join(', ');
        result.status = 'measured';
        if (id === 'TEST_HTTP_CODE')
          result.color = data.Values.some((v) => v >= 400)
            ? '#fbe0da'
            : data.Values.some((v) => v >= 300)
              ? '#fff0cf'
              : '#e4f3e9';
      } else {
        const value = numeric.parse(raw).Value;
        if (id === 'TEST_PING_PACKET_LOSS' && value > 100) return result;
        if (id.includes('_SD_')) {
          const observations = samples.safeParse(
            values.get(id.endsWith('_RTT') ? 'TEST_PING_TOTAL_RTT' : 'TEST_PING_TOTAL_CONN'),
          );
          if (!observations.success || !observations.data.Values.some((v) => v > 0)) return result;
        }
        if (!value && !id.includes('_SD_') && id !== 'TEST_PING_PACKET_LOSS') return result;
        result.value = value;
        result.status = 'measured';
        if (id === 'TEST_PING_PACKET_LOSS' && value > 0)
          result.color = value === 100 ? '#fbe0da' : '#fff0cf';
      }
      if (result.status === 'measured' && id !== 'TEST_HIJACK_DETECTION') result.message = '';
    } catch {
      /* Keep the unknown measurement in its requested position. */
    }
    return result;
  });
}
