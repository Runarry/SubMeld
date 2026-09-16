import type { NodeDraft } from '../shared/contracts.js';
export function xrayOutbound(node: NodeDraft): Record<string, unknown> {
  let settings: Record<string, unknown>;
  const address = node.server,
    port = node.port;
  switch (node.protocol) {
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
    network: node.transport.type === 'tcp' ? 'raw' : node.transport.type,
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
  return {
    tag: node.name,
    protocol: node.protocol === 'ss' ? 'shadowsocks' : node.protocol,
    settings,
    streamSettings: stream,
  };
}
