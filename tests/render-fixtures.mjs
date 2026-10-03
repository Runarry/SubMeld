import { blankDraft } from '../dist/server/shared/contracts.js';
import { node } from './fixtures.mjs';
export function renderFixtures(target) {
  const result = [];
  for (const p of ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic']) {
    if (target === 'xray' && p === 'tuic') continue;
    for (const transport of ['vmess', 'vless', 'trojan'].includes(p)
      ? ['tcp', 'ws', 'grpc']
      : ['tcp']) {
      const n = node(p, transport);
      n.tls.insecure = false;
      n.name = p + ' ' + transport;
      result.push(n);
    }
  }
  const reality = node('vless');
  reality.name = 'REALITY 首选';
  reality.tls.insecure = false;
  reality.tls.mode = 'reality';
  reality.tls.alpn = [];
  reality.tls.publicKey = Buffer.from(
    '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    'hex',
  ).toString('base64url');
  reality.tls.shortId = '00aabb';
  reality.protocolOptions.flow = 'xtls-rprx-vision';
  for (const method of ['aes-256-gcm', 'chacha20-ietf-poly1305']) {
    const n = node('ss');
    n.name = 'SS ' + method;
    n.protocolOptions.method = method;
    result.push(n);
  }
  for (const security of ['aes-128-gcm', 'chacha20-poly1305', 'none', 'zero']) {
    const n = node('vmess');
    n.name = 'VMess ' + security;
    n.tls.insecure = false;
    n.protocolOptions.security = security;
    result.push(n);
  }
  for (const p of ['vmess', 'vless']) {
    const n = node(p);
    n.name = p + ' without TLS';
    n.tls = blankDraft(p).tls;
    result.push(n);
  }
  for (const fingerprint of [
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
  ]) {
    const n = node('vless');
    n.name = 'TLS ' + fingerprint;
    n.tls.insecure = false;
    n.tls.fingerprint = fingerprint;
    result.push(n);
  }
  const vision = node('vless');
  vision.tls.insecure = false;
  vision.protocolOptions.flow = 'xtls-rprx-vision';
  vision.name = 'TLS Vision';
  result.push(vision);
  if (target !== 'xray') {
    for (const cc of ['cubic', 'new_reno']) {
      const n = node('tuic');
      n.name = 'TUIC ' + cc;
      n.protocolOptions.congestionControl = cc;
      n.protocolOptions.udpRelayMode = 'quic';
      n.protocolOptions.reduceRtt = false;
      result.push(n);
    }
    const hy = node('hysteria2');
    hy.name = 'Hysteria2 without obfs';
    hy.protocolOptions.obfs = '';
    hy.protocolOptions.obfsPassword = '';
    result.push(hy);
    const hopping = node('hysteria2');
    hopping.name = 'HY2 hopping' + (target === 'mihomo' ? ' with certificate pin' : '');
    hopping.protocolOptions.ports = '20120,20122-20200';
    hopping.protocolOptions.hopInterval = 30;
    if (target === 'mihomo') hopping.protocolOptions.pinSHA256 = 'ab'.repeat(32);
    result.push(hopping);
  }
  result.unshift(reality);
  return result;
}
