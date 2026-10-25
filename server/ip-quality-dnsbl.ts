import { Resolver } from 'node:dns/promises';
import { Address6 } from 'ip-address';
import type { IpQualityDnsbl } from './shared/ip-quality.js';

/** Fixed subset of xykt/IPQuality ref/dnsbl.list; references in docs/ip-quality-attribution.md. */
export const ipQualityDnsblLists = [
  { id: 'spamcop', name: 'SpamCop', zone: 'bl.spamcop.net', family: 4 },
  { id: 'psbl', name: 'PSBL', zone: 'psbl.surriel.com', family: 4 },
  { id: 'dronebl', name: 'DroneBL', zone: 'dnsbl.dronebl.org', family: 4 },
  { id: 'sem-black', name: 'SEM-BLACK', zone: 'bl.spameatingmonkey.net', family: 4 },
  {
    id: 'sem-backscatter',
    name: 'SEM-BACKSCATTER',
    zone: 'backscatter.spameatingmonkey.net',
    family: 4,
  },
  { id: 'sem-ipv6', name: 'SEM-IPV6BL', zone: 'bl.ipv6.spameatingmonkey.net', family: 6 },
] as const;
type List = (typeof ipQualityDnsblLists)[number];
export type IpQualityDnsLookup = (hostname: string, signal: AbortSignal) => Promise<string[]>;

/** Limits actual operations across simultaneous queries; aborted waiters never start work. */
export class IpQualitySlots {
  private active = 0;
  private waiting: (() => void)[] = [];
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', abort);
        this.active++;
        resolve();
      };
      const abort = () => {
        this.waiting = this.waiting.filter((item) => item !== start);
        reject(signal.reason);
      };
      if (this.active < 4) start();
      else {
        this.waiting.push(start);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await action();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
export function reverseDnsblAddress(ip: string): string {
  return ip.includes(':')
    ? new Address6(ip).canonicalForm().replaceAll(':', '').split('').reverse().join('.')
    : ip.split('.').reverse().join('.');
}
const lookup: IpQualityDnsLookup = async (hostname, signal) => {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await resolver.resolve4(hostname);
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
};
type Answer = { kind: 'records'; answers: string[] } | { kind: 'absent'; answers: [] };
const droneCodes: Record<string, string> = {
  '127.0.0.2': '样例记录',
  '127.0.0.3': 'IRC 机器人',
  '127.0.0.5': 'Bottler',
  '127.0.0.6': '垃圾邮件机器人',
  '127.0.0.7': 'DDoS 机器人',
  '127.0.0.8': 'SOCKS 代理',
  '127.0.0.9': 'HTTP 代理',
  '127.0.0.10': '代理链',
  '127.0.0.11': '网页代理',
  '127.0.0.12': '开放 DNS 解析器',
  '127.0.0.13': '暴力破解',
  '127.0.0.14': 'Wingate 代理',
  '127.0.0.15': '受感染路由器／网关',
  '127.0.0.16': '蠕虫',
  '127.0.0.17': '僵尸网络',
  '127.0.0.18': 'DNS／MX 主机',
  '127.0.0.19': '高风险节点',
  '127.0.0.255': '未分类记录',
};
export function classifyDnsbl(
  id: string,
  answers: string[],
): Pick<IpQualityDnsbl, 'status' | 'message'> {
  const labels = answers.map((answer) =>
    id === 'dronebl' ? droneCodes[answer] : answer === '127.0.0.2' ? '名单命中' : undefined,
  );
  if (answers.length && labels.every((label) => label !== undefined))
    return { status: 'listed', message: [...new Set(labels)].join('、') };
  return { status: 'unknown', message: '返回码无法完整解释，未计入黑名单命中。' };
}
export class IpQualityDnsbls {
  private slots = new IpQualitySlots();
  private health = new Map<string, { expires: number; ok: boolean }>();
  constructor(
    private resolve: IpQualityDnsLookup = lookup,
    private now: () => number = Date.now,
    private timeoutMs = 3000,
  ) {}
  private async answer(hostname: string, signal: AbortSignal): Promise<Answer> {
    return this.slots.run(signal, async () => {
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new DOMException('DNS timeout', 'TimeoutError')),
        this.timeoutMs,
      );
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        const answers = await this.resolve(hostname, combined);
        combined.throwIfAborted();
        return { kind: 'records', answers: [...new Set(answers)] };
      } catch (error) {
        combined.throwIfAborted();
        if (error instanceof Error && 'code' in error && error.code === 'ENOTFOUND')
          return { kind: 'absent', answers: [] };
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
  }
  private async healthy(list: List, signal: AbortSignal): Promise<boolean> {
    const cached = this.health.get(list.id);
    if (cached && cached.expires > this.now()) return cached.ok;
    const testIp = (n: number) => (list.family === 4 ? '127.0.0.' + n : '::ffff:127.0.0.' + n);
    const [positive, negative] = await Promise.all([
      this.answer(reverseDnsblAddress(testIp(2)) + '.' + list.zone, signal),
      this.answer(reverseDnsblAddress(testIp(1)) + '.' + list.zone, signal),
    ]);
    // DroneBL's public test address currently answers 127.0.0.1; it is not a target listing code.
    const expected = list.id === 'dronebl' ? ['127.0.0.1', '127.0.0.2'] : ['127.0.0.2'];
    const ok =
      positive.kind === 'records' &&
      positive.answers.length > 0 &&
      positive.answers.every((answer) => expected.includes(answer)) &&
      negative.kind === 'absent';
    signal.throwIfAborted();
    this.health.set(list.id, { expires: this.now() + 600000, ok });
    return ok;
  }
  async query(list: List, ip: string, family: 4 | 6, signal: AbortSignal): Promise<IpQualityDnsbl> {
    const base = {
      ...list,
      checkedAt: new Date(this.now()).toISOString(),
      cached: false,
      answers: [] as string[],
    };
    if (list.family !== family)
      return { ...base, status: 'unsupported', message: '此名单仅支持 IPv' + list.family + '。' };
    try {
      signal.throwIfAborted();
      if (!(await this.healthy(list, signal)))
        return {
          ...base,
          status: 'unavailable',
          message: '名单正反测试记录未通过，无法判断是否命中。',
        };
      const answer = await this.answer(reverseDnsblAddress(ip) + '.' + list.zone, signal);
      signal.throwIfAborted();
      if (answer.kind === 'absent')
        return { ...base, status: 'not_listed', message: '本次查询未命中该名单。' };
      return { ...base, answers: answer.answers, ...classifyDnsbl(list.id, answer.answers) };
    } catch (error) {
      const timeout =
        signal.aborted ||
        (error instanceof Error &&
          (error.name === 'TimeoutError' || ('code' in error && error.code === 'ETIMEOUT')));
      return {
        ...base,
        status: timeout ? 'timeout' : 'unavailable',
        message: timeout ? 'DNS 查询超时或已中止。' : 'DNS 查询失败或被拒绝，无法判断是否命中。',
      };
    }
  }
}
