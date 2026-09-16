import { blankDraft } from '../dist/server/shared/contracts.js';
export const UUID = '00000000-0000-4000-8000-000000000000';
export const TEST_PASSWORD = 'test-only:密@码/?#&=+%';
export function node(protocol, transport = 'tcp') {
  const draft = blankDraft(protocol);
  draft.name = '测试节点 · ' + protocol;
  draft.server = '2001:db8::1';
  draft.port = 443;
  if ('password' in draft.auth) draft.auth.password = TEST_PASSWORD;
  if ('uuid' in draft.auth) draft.auth.uuid = UUID;
  if (protocol !== 'ss') {
    draft.tls.mode = 'tls';
    draft.tls.serverName = 'tls.example.com';
    draft.tls.insecure = true;
    if (protocol !== 'hysteria2') draft.tls.alpn = ['h2', 'http/1.1'];
  }
  if (['vmess', 'vless', 'trojan'].includes(protocol)) {
    draft.tls.fingerprint = 'chrome';
    draft.transport.type = transport;
    if (transport === 'ws') {
      draft.transport.path = '/路径?key=%2F&a=1';
      draft.transport.host = 'ws.example.com';
    }
    if (transport === 'grpc') draft.transport.serviceName = 'test/service';
  }
  if (protocol === 'hysteria2') {
    draft.protocolOptions.obfs = 'salamander';
    draft.protocolOptions.obfsPassword = TEST_PASSWORD;
  }
  if (protocol === 'tuic') {
    draft.protocolOptions.congestionControl = 'bbr';
    draft.protocolOptions.reduceRtt = true;
  }
  return draft;
}
export function items(...drafts) {
  return drafts.map((draft, nodeIndex) => ({ nodeIndex, draft, excluded: false, diagnostics: [] }));
}
