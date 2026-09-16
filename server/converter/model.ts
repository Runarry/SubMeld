import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import {
  blankDraft,
  diagnostic,
  draftSchema,
  protocols,
  type Diagnostic,
  type NodeDraft,
} from '../shared/contracts.js';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const string = (v: unknown) => (typeof v === 'string' ? v : '');
const object = (v: unknown): Record<string, unknown> => (record(v) ? v : {});
export function validateDraft(node: NodeDraft, i: number): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const fail = (field: string, message: string) =>
    errors.push(diagnostic(i, 'NODE_INVALID', message, field));
  if (!node.name.trim()) fail('name', '请填写节点名称。');
  const host = node.server;
  if (
    !host ||
    /[\s/@?#\\[\]\0]/.test(host) ||
    (!isIP(host) &&
      (!domainToASCII(host) ||
        !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(domainToASCII(host)) ||
        host.includes('..') ||
        host.includes(':')))
  )
    fail('server', '请输入有效的域名或不含方括号的 IP 地址。');
  if (node.port < 1 || node.port > 65535) fail('port', '端口必须在 1～65535 之间。');
  if (
    'uuid' in node.auth &&
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(node.auth.uuid)
  )
    fail('auth.uuid', 'UUID 格式无效。');
  if ('password' in node.auth && !node.auth.password) fail('auth.password', '认证密码不能为空。');
  if (['ss', 'hysteria2', 'tuic'].includes(node.protocol) && node.transport.type !== 'tcp')
    fail('transport.type', '此协议不支持选择 WS 或 gRPC 传输。');
  if (node.protocol === 'ss' && node.tls.mode !== 'none')
    fail('tls.mode', 'P1 的 SS 不包含 TLS 或插件。');
  if (['trojan', 'hysteria2', 'tuic'].includes(node.protocol) && node.tls.mode !== 'tls')
    fail('tls.mode', '此协议需要 TLS。');
  if (node.tls.mode === 'reality') {
    if (node.protocol !== 'vless' || node.transport.type !== 'tcp')
      fail('tls.mode', 'REALITY 当前只开放 VLESS TCP。');
    if (!/^[A-Za-z0-9_-]{43}$/.test(node.tls.publicKey))
      fail('tls.publicKey', 'REALITY 公钥必须为 32 字节的 Base64url 编码。');
    if (!/^(?:[\da-fA-F]{2}){0,8}$/.test(node.tls.shortId))
      fail('tls.shortId', 'short ID 必须是最多 16 位的偶数长度十六进制。');
    if (!node.tls.serverName) fail('tls.serverName', 'REALITY 需要 SNI。');
  }
  if (
    node.protocol === 'vless' &&
    node.protocolOptions.flow &&
    (node.transport.type !== 'tcp' || node.tls.mode === 'none')
  )
    fail('protocolOptions.flow', 'Vision 仅用于启用 TLS／REALITY 的 VLESS TCP。');
  if (
    node.protocol === 'hysteria2' &&
    node.protocolOptions.obfs &&
    !node.protocolOptions.obfsPassword
  )
    fail('protocolOptions.obfsPassword', 'Salamander 需要混淆密码。');
  if (
    node.tls.mode === 'none' &&
    (node.tls.insecure || node.tls.serverName || node.tls.alpn.length || node.tls.fingerprint)
  )
    fail('tls', '请启用 TLS 后设置 TLS 参数。');
  if (node.tls.mode !== 'reality' && (node.tls.publicKey || node.tls.shortId))
    fail('tls', 'REALITY 参数需要选择 REALITY。');
  if (node.protocol === 'hysteria2' && (node.tls.alpn.length || node.tls.fingerprint))
    fail('tls', '本阶段 Hysteria2 URI 不开放自定义 ALPN／指纹。');
  if (node.protocol === 'tuic' && node.tls.fingerprint)
    fail('tls.fingerprint', 'TUIC URI 不开放 TLS 客户端指纹。');
  if (
    node.tls.fingerprint &&
    ![
      'chrome',
      'firefox',
      'safari',
      'ios',
      'android',
      'edge',
      '360',
      'qq',
      'random',
      'randomized',
    ].includes(node.tls.fingerprint)
  )
    fail('tls.fingerprint', 'TLS 客户端指纹不在已开放范围。');
  if (
    /[\r\n\0]/.test(node.tls.serverName) ||
    /[\r\n\0]/.test(node.transport.host) ||
    node.tls.alpn.some((x) => !x || /[,\r\n\0]/.test(x))
  )
    fail('tls', 'SNI、Host 或 ALPN 格式无效。');
  if (node.transport.type === 'ws' && !node.transport.path.startsWith('/'))
    fail('transport.path', 'WebSocket path 必须以 / 开头。');
  if (node.protocol === 'tuic' && node.protocolOptions.reduceRtt)
    errors.push(
      diagnostic(
        i,
        'EARLY_DATA',
        '此节点启用 0-RTT，早期数据可能被重放；输出保留该设置。',
        'protocolOptions.reduceRtt',
        'warning',
      ),
    );
  if (node.tls.insecure)
    errors.push(
      diagnostic(
        i,
        'INSECURE_TLS',
        '此节点明确关闭证书验证，将按原值保留。',
        'tls.insecure',
        'warning',
      ),
    );
  return errors;
}
export function fromUpstream(value: unknown, index: number): NodeDraft {
  if (!record(value) || !protocols.some((p) => p === value.type))
    throw new Error('Unsupported protocol');
  const type = protocols.find((p) => p === value.type);
  if (!type) throw new Error('Unsupported protocol');
  const draft = blankDraft(type);
  const reality = object(value['reality-opts']);
  const network = value.network ?? 'tcp';
  const t = object(value[String(network) + '-opts']);
  const headers = object(t.headers);
  const common = {
    ...draft,
    name: string(value.name),
    server: string(value.server).replace(/^\[|\]$/g, ''),
    port: value.port,
    tls: {
      mode: value['reality-opts'] ? 'reality' : value.tls ? 'tls' : 'none',
      serverName: string(value.sni ?? value.servername),
      insecure: value['skip-cert-verify'] === true,
      alpn: Array.isArray(value.alpn) ? value.alpn : string(value.alpn).split(',').filter(Boolean),
      fingerprint: string(value['client-fingerprint']),
      publicKey: string(reality['public-key']),
      shortId: string(reality['short-id']),
    },
    transport: {
      type: network,
      path: string(t.path) || '/',
      host: string(headers.Host ?? headers.host),
      serviceName: string(t['grpc-service-name']),
    },
  };
  let auth: unknown;
  let protocolOptions: unknown;
  switch (type) {
    case 'ss':
      auth = { password: string(value.password) };
      protocolOptions = { method: value.cipher };
      break;
    case 'vmess':
      auth = { uuid: string(value.uuid) };
      protocolOptions = { security: value.cipher || 'auto', alterId: value.alterId ?? 0 };
      break;
    case 'vless':
      auth = { uuid: string(value.uuid) };
      protocolOptions = { flow: value.flow ?? '' };
      break;
    case 'trojan':
      auth = { password: string(value.password) };
      protocolOptions = {};
      break;
    case 'hysteria2':
      auth = { password: string(value.password) };
      protocolOptions = { obfs: value.obfs ?? '', obfsPassword: string(value['obfs-password']) };
      break;
    case 'tuic':
      auth = { uuid: string(value.uuid), password: string(value.password) };
      protocolOptions = {
        version: 5,
        congestionControl: value['congestion-controller'] ?? 'cubic',
        udpRelayMode: value['udp-relay-mode'] ?? 'native',
        reduceRtt: value['reduce-rtt'] === true,
      };
      break;
  }
  const result = draftSchema.safeParse({ ...common, auth, protocolOptions });
  if (!result.success) throw new Error('Unsupported or invalid fields at ' + index);
  return result.data;
}
export function toUpstream(draft: NodeDraft): Record<string, unknown> {
  const proxy: Record<string, unknown> = {
    type: draft.protocol,
    name: draft.name,
    server: draft.server,
    port: draft.port,
    ...draft.auth,
  };
  if (draft.protocol === 'ss') proxy.cipher = draft.protocolOptions.method;
  if (draft.protocol === 'vmess') {
    proxy.cipher = draft.protocolOptions.security;
    proxy.alterId = 0;
  }
  if (draft.protocol === 'vless' && draft.protocolOptions.flow)
    proxy.flow = draft.protocolOptions.flow;
  if (draft.protocol === 'hysteria2' && draft.protocolOptions.obfs) {
    proxy.obfs = draft.protocolOptions.obfs;
    proxy['obfs-password'] = draft.protocolOptions.obfsPassword;
  }
  if (draft.protocol === 'tuic') {
    proxy['congestion-controller'] = draft.protocolOptions.congestionControl;
    proxy['udp-relay-mode'] = draft.protocolOptions.udpRelayMode;
    proxy['reduce-rtt'] = draft.protocolOptions.reduceRtt;
  }
  if (draft.tls.mode !== 'none') {
    proxy.tls = true;
    proxy['skip-cert-verify'] = draft.tls.insecure;
    if (draft.tls.serverName) proxy.sni = draft.tls.serverName;
    if (draft.tls.alpn.length) proxy.alpn = [...draft.tls.alpn];
    if (draft.tls.fingerprint) proxy['client-fingerprint'] = draft.tls.fingerprint;
    if (draft.tls.mode === 'reality')
      proxy['reality-opts'] = { 'public-key': draft.tls.publicKey, 'short-id': draft.tls.shortId };
  }
  if (['vmess', 'vless', 'trojan'].includes(draft.protocol)) proxy.network = draft.transport.type;
  if (draft.transport.type === 'ws')
    proxy['ws-opts'] = {
      path: draft.transport.path,
      ...(draft.transport.host ? { headers: { Host: draft.transport.host } } : {}),
    };
  if (draft.transport.type === 'grpc')
    proxy['grpc-opts'] = { 'grpc-service-name': draft.transport.serviceName };
  return proxy;
}
