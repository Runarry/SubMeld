import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Address4, Address6 } from 'ip-address';
import { AppError } from './errors.js';

export type SourceAddress = { address: string; family: 4 | 6 };
type Resolve = (hostname: string, signal: AbortSignal) => Promise<SourceAddress[]>;

function addressValue(value: string) {
  if (isIP(value) === 4) return new Address4(value);
  if (isIP(value) === 6 && !value.includes('%')) return new Address6(value);
  throw new AppError('SOURCE_ADDRESS_REJECTED', '来源地址不是有效的公网 IP。');
}
function normalizedAddress(value: string) {
  const address = addressValue(value);
  return address instanceof Address6 && address.isMapped4()
    ? address.to4().correctForm()
    : address.correctForm();
}
export function publicAddress(value: string) {
  const address = addressValue(value);
  if (!address.isGlobal()) throw new AppError('SOURCE_ADDRESS_REJECTED', '来源只能访问公网地址。');
  return normalizedAddress(value);
}
export function sourceUrl(input: string) {
  let url: URL;
  try {
    if (
      [...input].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === '\\',
      )
    )
      throw new Error();
    url = new URL(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hostname)
      throw new Error();
    if (isIP(hostname)) publicAddress(hostname);
    else if (
      hostname.length > 253 ||
      !hostname
        .replace(/\.$/, '')
        .split('.')
        .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
    )
      throw new Error();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'SOURCE_URL_INVALID',
      '来源需要有效的 HTTPS 地址，不能包含用户信息、片段或控制字符。',
      400,
    );
  }
  return url;
}
export const resolveSource: Resolve = async (hostname, signal) => {
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses: SourceAddress[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        for (const address of result.value)
          addresses.push({ address, family: index === 0 ? 4 : 6 });
      } else {
        const error: unknown = result.reason;
        if (!(
          error instanceof Error &&
          'code' in error &&
          ['ENODATA', 'ENOTFOUND'].includes(String(error.code))
        ))
          throw new AppError('SOURCE_DNS_FAILED', '来源 DNS 解析失败。');
      }
    }
    if (!addresses.length) throw new AppError('SOURCE_DNS_FAILED', '来源没有可用的 DNS 地址。');
    return addresses;
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
};
