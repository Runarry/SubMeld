import type { NodeDraft } from '../shared/contracts.js';
export function xrayOutbound(node: NodeDraft): Record<string, unknown> {
  let settings: Record<string, unknown>;
  const address = node.server,
    port = node.port;
  switch (node.protocol) {
    case 'hysteria2':
      settings = { version: 2, address, port };
      break;
    case 'ss':
      settings = {
        servers: [
          { address, port, method: node.protocolOptions.method, password: node.auth.password },
        ],
      };
      break;
    case 'trojan':
      settings = { servers: [{ address, port, password: node.auth.password }] };
      break;
    case 'vmess':
      settings = {
        vnext: [
          {
            address,
            port,
            users: [{ id: node.auth.uuid, alterId: 0, security: node.protocolOptions.security }],
          },
        ],
      };
      break;
    case 'vless':
      settings = {
        vnext: [
          {
            address,
            port,
            users: [
              {
                id: node.auth.uuid,
                encryption: 'none',
                ...(node.protocolOptions.flow ? { flow: node.protocolOptions.flow } : {}),
              },
            ],
          },
        ],
      };
      break;
    default:
      throw new Error('Unsupported Xray protocol');
  }
  const stream: Record<string, unknown> = {
    network:
      node.protocol === 'hysteria2'
        ? 'hysteria'
        : node.transport.type === 'tcp'
          ? 'raw'
          : node.transport.type,
    security: node.tls.mode,
  };
  if (node.transport.type === 'ws')
    stream.wsSettings = {
      path: node.transport.path,
      ...(node.transport.host ? { host: node.transport.host } : {}),
    };
  if (node.transport.type === 'grpc')
    stream.grpcSettings = { serviceName: node.transport.serviceName };
  if (node.tls.mode === 'tls')
    stream.tlsSettings = {
      ...(node.tls.serverName ? { serverName: node.tls.serverName } : {}),
      ...(node.tls.alpn.length ? { alpn: node.tls.alpn } : {}),
      ...(node.tls.fingerprint ? { fingerprint: node.tls.fingerprint } : {}),
    };
  if (node.tls.mode === 'reality')
    stream.realitySettings = {
      serverName: node.tls.serverName,
      fingerprint: node.tls.fingerprint || 'chrome',
      password: node.tls.publicKey,
      shortId: node.tls.shortId,
    };
  if (node.protocol === 'hysteria2') {
    stream.hysteriaSettings = { version: 2, auth: node.auth.password };
    stream.tlsSettings = {
      serverName: node.tls.serverName || node.server,
      alpn: ['h3'],
      ...(node.protocolOptions.pinSHA256
        ? { pinnedPeerCertSha256: node.protocolOptions.pinSHA256 }
        : {}),
    };
    const finalmask: Record<string, unknown> = {};
    if (node.protocolOptions.obfs)
      finalmask.udp = [
        { type: 'salamander', settings: { password: node.protocolOptions.obfsPassword } },
      ];
    if (node.protocolOptions.ports)
      finalmask.quicParams = {
        udpHop: {
          ports: node.protocolOptions.ports,
          ...(node.protocolOptions.hopInterval === null
            ? {}
            : { interval: node.protocolOptions.hopInterval }),
        },
      };
    if (Object.keys(finalmask).length) stream.finalmask = finalmask;
  }
  return {
    tag: node.name,
    protocol:
      node.protocol === 'ss'
        ? 'shadowsocks'
        : node.protocol === 'hysteria2'
          ? 'hysteria'
          : node.protocol,
    settings,
    streamSettings: stream,
    // Xray exposes XUDP through mux; keep TCP connections independent.
    ...(node.protocol === 'vless'
      ? { mux: { enabled: true, concurrency: -1, xudpConcurrency: 16, xudpProxyUDP443: 'allow' } }
      : {}),
  };
}
