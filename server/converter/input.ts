import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { AppError } from '../errors.js';
import { guardStructure } from '../input.js';
import { MAX_BYTES, MAX_DEPTH, diagnostic, type Diagnostic } from '../shared/contracts.js';
import { record } from './model.js';
import { certificatePin, hysteriaPortRanges } from './hysteria2.js';

export function byteLimit(text: string) {
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '输入或解码正文超过 4 MiB。', 413);
}
export function decodeBase64(text: string): string {
  const compact = text.replace(/[\r\n\t ]/g, '');
  if (
    !compact ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) ||
    compact.replace(/=/g, '').length % 4 === 1 ||
    (compact.includes('=') && compact.length % 4 !== 0)
  )
    throw new AppError('INVALID_BASE64', 'Base64 编码无效。');
  const canonical = compact.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Buffer.from(canonical, 'base64');
  if (bytes.length > MAX_BYTES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '解码正文超过 4 MiB。', 413);
  if (bytes.toString('base64').replace(/=+$/, '') !== canonical.replace(/=+$/, ''))
    throw new AppError('INVALID_BASE64', 'Base64 编码无效。');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError('INVALID_ENCODING', '解码结果不是 UTF-8 文本。');
  }
}
const stringFields = new Set([
  'password',
  'uuid',
  'short-id',
  'public-key',
  'obfs-password',
  'name',
  'server',
  'servername',
  'sni',
  'path',
  'Host',
  'host',
  'grpc-service-name',
]);
export function yamlObject(text: string): unknown {
  const doc = parseDocument(text, {
    uniqueKeys: true,
    strict: true,
    schema: 'core',
    prettyErrors: false,
  });
  if (doc.errors.length || doc.warnings.length)
    throw new AppError('INVALID_YAML', 'YAML 格式无效、键重复或含不支持的标签。');
  let count = 0;
  function visit(value: unknown, depth: number, field = '') {
    if (depth > MAX_DEPTH || ++count > 100000)
      throw new AppError('INPUT_LIMIT_EXCEEDED', 'YAML 结构超过限制。', 413);
    if (isAlias(value)) return;
    if (isMap(value)) {
      if (value.tag && value.tag !== 'tag:yaml.org,2002:map')
        throw new AppError('INVALID_YAML', '不支持自定义 YAML 标签。');
      for (const pair of value.items) {
        if (
          !isScalar(pair.key) ||
          typeof pair.key.value !== 'string' ||
          ['__proto__', 'constructor', 'prototype'].includes(pair.key.value)
        )
          throw new AppError('INVALID_YAML', 'YAML 键不受支持。');
        visit(pair.value, depth + 1, pair.key.value);
      }
    } else if (isSeq(value)) for (const child of value.items) visit(child, depth + 1);
    else if (isScalar(value)) {
      if (
        value.tag &&
        ![
          'tag:yaml.org,2002:str',
          'tag:yaml.org,2002:int',
          'tag:yaml.org,2002:bool',
          'tag:yaml.org,2002:null',
          'tag:yaml.org,2002:float',
        ].includes(value.tag)
      )
        throw new AppError('INVALID_YAML', '不支持自定义 YAML 标签。');
      if (stringFields.has(field) && typeof value.value !== 'string' && value.source !== undefined)
        value.value = value.source;
    }
  }
  visit(doc.contents, 0);
  let result: unknown;
  try {
    result = doc.toJS({ maxAliasCount: 50 });
  } catch {
    throw new AppError('INPUT_LIMIT_EXCEEDED', 'YAML 别名展开超过限制。', 413);
  }
  guardStructure(result);
  return result;
}
const unsupportedFields = new Set([
  'plugin',
  'plugin-opts',
  'ports',
  'mport',
  'hop-interval',
  'hop_interval',
  'ech',
  'ech-opts',
  'packet-encoding',
  'packetEncoding',
  'packetaddr',
  'xudp',
  'encryption-extra',
  'ca',
  'ca-str',
  'ca_str',
  '_ca',
  'tls-fingerprint',
  'pinSHA256',
  'certificate',
  'disable-sni',
  'token',
  'shadow-tls-opts',
  'smux',
  'dialer-proxy',
  'detour',
  'interface-name',
  'routing-mark',
  'ip-version',
  'tfo',
  'fastopen',
  'fast_open',
  'keepalive',
  'upmbps',
  'downmbps',
]);
const hysteriaFields = new Set(['ports', 'hop-interval', 'tls-fingerprint', 'fingerprint']);
export function preflight(entry: Record<string, unknown>, i: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fail = (field?: string) =>
    diagnostics.push(
      diagnostic(
        i,
        'TARGET_FEATURE_UNSUPPORTED',
        '节点含本阶段无法表达的协议、安全或传输参数。',
        field,
      ),
    );
  const warning = () =>
    diagnostics.push(
      diagnostic(
        i,
        'EXTRA_FIELDS_NOT_IMPORTED',
        '部分附加参数未纳入已验证字段，不会带入输出。',
        undefined,
        'warning',
      ),
    );
  if (!['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic'].includes(String(entry.type)))
    fail('protocol');
  for (const key of Object.keys(entry))
    if (
      unsupportedFields.has(key) &&
      !(entry.type === 'hysteria2' && hysteriaFields.has(key)) &&
      !(key === 'packet-encoding' && entry.type === 'vless' && entry[key] === 'xudp') &&
      entry[key] !== undefined &&
      entry[key] !== false &&
      entry[key] !== ''
    )
      fail(key);
  if (entry.type === 'hysteria2') {
    for (const key of ['ports', 'tls-fingerprint', 'fingerprint']) {
      if (entry[key] === undefined) continue;
      try {
        if (typeof entry[key] !== 'string') throw new Error('Expected text');
        if (key === 'ports') hysteriaPortRanges(entry[key]);
        else certificatePin(entry[key]);
      } catch {
        fail(key);
      }
    }
    if (entry['tls-fingerprint'] && entry.fingerprint) {
      try {
        if (
          certificatePin(String(entry['tls-fingerprint'])) !==
          certificatePin(String(entry.fingerprint))
        )
          fail('tls-fingerprint');
      } catch {
        fail('tls-fingerprint');
      }
    }
    if (
      entry['hop-interval'] !== undefined &&
      (!entry.ports ||
        typeof entry['hop-interval'] !== 'number' ||
        !Number.isSafeInteger(entry['hop-interval']) ||
        entry['hop-interval'] <= 0)
    )
      fail('hop-interval');
  }
  for (const key of [
    'name',
    'server',
    'password',
    'uuid',
    'sni',
    'servername',
    'client-fingerprint',
    'cipher',
    'flow',
    'packet-encoding',
    'obfs',
    'obfs-password',
  ]) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') fail();
  }
  if (['sni', 'servername'].some((key) => key in entry && ['', 'off'].includes(String(entry[key]))))
    fail('tls.serverName');
  if (
    entry.alpn !== undefined &&
    typeof entry.alpn !== 'string' &&
    !(Array.isArray(entry.alpn) && entry.alpn.every((x) => typeof x === 'string'))
  )
    fail('tls.alpn');
  if (entry.tls !== undefined && typeof entry.tls !== 'boolean') fail('tls.mode');
  if (entry['skip-cert-verify'] !== undefined && typeof entry['skip-cert-verify'] !== 'boolean')
    fail('tls.insecure');
  if (entry.tls === false && ['trojan', 'hysteria2', 'tuic'].includes(String(entry.type)))
    fail('tls.mode');
  if (entry.obfs && !['salamander'].includes(String(entry.obfs))) fail('protocolOptions.obfs');
  if (
    entry.type === 'vmess' &&
    entry.cipher &&
    !['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'].includes(String(entry.cipher))
  )
    fail('protocolOptions.security');
  if (entry.type === 'hysteria2' && entry.obfs && !entry['obfs-password'])
    fail('protocolOptions.obfsPassword');
  if (entry.network && !['tcp', 'ws', 'grpc'].includes(String(entry.network)))
    fail('transport.type');
  if (
    'reality-opts' in entry &&
    (!record(entry['reality-opts']) || !entry['reality-opts']['public-key'])
  )
    fail('tls.publicKey');
  for (const key of ['ws-opts', 'grpc-opts', 'reality-opts']) {
    const options = entry[key];
    if (options === undefined) continue;
    if (!record(options)) {
      fail('transport');
      continue;
    }
    if (key === 'ws-opts' && entry.network !== 'ws') fail('transport.type');
    if (key === 'grpc-opts' && entry.network !== 'grpc') fail('transport.type');
    for (const field of ['path', 'grpc-service-name', 'public-key', 'short-id'])
      if (options[field] !== undefined && typeof options[field] !== 'string') fail('transport');
    if (options.headers !== undefined) {
      if (
        !record(options.headers) ||
        Object.values(options.headers).some((x) => typeof x !== 'string')
      )
        fail('transport.host');
      else if ('host' in options.headers && 'Host' in options.headers) fail('transport.host');
    }
    const allowed =
      key === 'ws-opts'
        ? ['path', 'headers']
        : key === 'grpc-opts'
          ? ['grpc-service-name']
          : ['public-key', 'short-id'];
    if (Object.keys(options).some((k) => !allowed.includes(k))) fail('transport');
    if (
      record(options.headers) &&
      Object.keys(options.headers).some((k) => !['host', 'Host'].includes(k))
    )
      fail('transport.host');
  }
  const allowed = new Set([
    'type',
    'name',
    'server',
    'port',
    'cipher',
    'password',
    'uuid',
    'alterId',
    'tls',
    'servername',
    'sni',
    'skip-cert-verify',
    'alpn',
    'client-fingerprint',
    'network',
    'ws-opts',
    'grpc-opts',
    'reality-opts',
    'flow',
    'obfs',
    'obfs-password',
    'congestion-controller',
    'udp-relay-mode',
    'reduce-rtt',
    'udp',
  ]);
  if (
    Object.keys(entry).some(
      (k) =>
        !allowed.has(k) &&
        !unsupportedFields.has(k) &&
        !(entry.type === 'hysteria2' && hysteriaFields.has(k)),
    )
  )
    warning();
  // Avoid unbounded/repetitive diagnostics for a single hostile item.
  return diagnostics.slice(0, 32);
}
