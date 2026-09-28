import type { RenderTarget } from '../shared/contracts.js';
import { AppError } from '../errors.js';
export const SELECTOR = 'SUBMELD';
export function defaultTemplates(): Record<RenderTarget, unknown> {
  const mihomo = basicConfig('mihomo', [], [], 1080);
  const singbox = basicConfig('singbox', [], [], 1080);
  const xray = basicConfig('xray', [], [], 1080);
  return {
    mihomo: {
      ...mihomo,
      'mixed-port': '$port',
      proxies: '$nodes',
      'proxy-groups': [{ name: SELECTOR, type: 'select', proxies: '$names' }],
    },
    singbox: {
      ...singbox,
      inbounds: [{ type: 'mixed', tag: 'local-in', listen: '127.0.0.1', listen_port: '$port' }],
      outbounds: '$outbounds',
    },
    xray: {
      ...xray,
      inbounds: [
        {
          tag: 'local-in',
          listen: '127.0.0.1',
          port: '$port',
          protocol: 'socks',
          settings: { auth: 'noauth', udp: true },
        },
      ],
      outbounds: '$nodes',
      routing: {
        domainStrategy: 'AsIs',
        rules: [{ type: 'field', inboundTag: ['local-in'], outboundTag: '$first' }],
      },
    },
  };
}
export function fillTemplate(
  template: unknown,
  target: RenderTarget,
  nodes: Record<string, unknown>[],
  names: string[],
  port: number,
): unknown {
  const values: Record<string, unknown> = {
    $port: port,
    $nodes: nodes,
    $names: names,
    $first: names[0],
    $outbounds:
      target === 'singbox'
        ? [{ type: 'selector', tag: SELECTOR, outbounds: names, default: names[0] }, ...nodes]
        : nodes,
  };
  const fill = (value: unknown): unknown =>
    typeof value === 'string' && Object.hasOwn(values, value)
      ? values[value]
      : Array.isArray(value)
        ? value.map(fill)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
          : value;
  const result = fill(template);
  const expected = target === 'singbox' ? values.$outbounds : nodes;
  const key = target === 'mihomo' ? 'proxies' : 'outbounds';
  if (
    !result ||
    typeof result !== 'object' ||
    !(key in result) ||
    JSON.stringify((result as Record<string, unknown>)[key]) !== JSON.stringify(expected)
  )
    throw new AppError(
      'TEMPLATE_FIELD_LOSS',
      '模板未保留完整的节点列表，请保留对应的 $nodes 或 $outbounds 占位符。',
      422,
    );
  return result;
}
export function basicConfig(
  target: RenderTarget,
  nodes: Record<string, unknown>[],
  names: string[],
  port: number,
) {
  if (target === 'mihomo')
    return {
      'mixed-port': port,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      mode: 'rule',
      'log-level': 'warning',
      dns: { enable: false },
      proxies: nodes,
      'proxy-groups': [{ name: SELECTOR, type: 'select', proxies: names }],
      rules: ['MATCH,' + SELECTOR],
    };
  if (target === 'singbox')
    return {
      log: { level: 'warn' },
      dns: { servers: [{ type: 'local', tag: 'system' }] },
      inbounds: [{ type: 'mixed', tag: 'local-in', listen: '127.0.0.1', listen_port: port }],
      outbounds: [
        { type: 'selector', tag: SELECTOR, outbounds: names, default: names[0] },
        ...nodes,
      ],
      route: { final: SELECTOR, default_domain_resolver: 'system' },
    };
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'local-in',
        listen: '127.0.0.1',
        port,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
      },
    ],
    outbounds: nodes,
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', inboundTag: ['local-in'], outboundTag: names[0] }],
    },
  };
}
