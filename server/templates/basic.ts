import type { RenderTarget } from '../shared/contracts.js';
export const SELECTOR = 'SUBMELD';
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
