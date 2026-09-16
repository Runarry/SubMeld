import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { AppError } from '../errors.js';
import { guardStructure } from '../input.js';
import {
  MAX_BYTES,
  MAX_DEPTH,
  MAX_NODES,
  diagnostic,
  type Diagnostic,
} from '../shared/contracts.js';
import { record } from './model.js';

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
export function splitInput(
  text: string,
  format: 'auto' | 'uri' | 'base64' | 'yaml',
): { entries: (string | Record<string, unknown>)[]; diagnostics: Diagnostic[] } {
  byteLimit(text);
  let content = text.replace(/^\uFEFF/, '').trim();
  if (!content) throw new AppError('EMPTY_INPUT', '请先输入节点。');
  if (/^\s*</.test(content)) throw new AppError('INPUT_FORMAT_UNSUPPORTED', '不接受 HTML 内容。');
  if (format === 'auto') {
    if (/^[\w-]+:\/\//.test(content)) format = 'uri';
    else if (/^(\{|\[)/.test(content))
      throw new AppError('INPUT_FORMAT_UNSUPPORTED', 'P1 不支持原生 JSON 配置导入。');
    else if (/(?:^|\n)\s*(?:proxies|proxy-providers)\s*:/.test(content)) format = 'yaml';
    else format = 'base64';
  }
  if (format === 'base64') {
    content = decodeBase64(content);
    format = 'uri';
  }
  const diagnostics: Diagnostic[] = [];
  let entries: (string | Record<string, unknown>)[];
  if (format === 'yaml') {
    const document = yamlObject(content);
    if (!record(document) || !Array.isArray(document.proxies))
      throw new AppError('NO_INLINE_NODES', '只接受 proxies 内联节点；provider 不会联网获取。');
    if (Object.keys(document).some((k) => k !== 'proxies'))
      diagnostics.push(
        diagnostic(
          -1,
          'YAML_METADATA_NOT_IMPORTED',
          '仅提取内联节点；provider、规则、DNS 和代理组未导入，也不会联网。',
          undefined,
          'warning',
        ),
      );
    entries = document.proxies.map((item: unknown) => (record(item) ? item : {}));
  } else
    entries = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  if (!entries.length) throw new AppError('EMPTY_INPUT', '输入中没有节点。');
  if (entries.length > MAX_NODES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数量超过 2,000。', 413);
  return { entries, diagnostics };
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
const queryFields = new Set([
  'security',
  'type',
  'encryption',
  'sni',
  'peer',
  'servername',
  'alpn',
  'fp',
  'pbk',
  'sid',
  'flow',
  'path',
  'host',
  'serviceName',
  'allowInsecure',
  'insecure',
  'allow_insecure',
  'skip-cert-verify',
  'obfs',
  'obfs-password',
  'congestion_control',
  'congestion-controller',
  'udp_relay_mode',
  'udp-relay-mode',
  'reduce_rtt',
]);
const commonTlsQuery = ['sni', 'alpn', 'fp', 'allowInsecure'];
const queryByProtocol: Record<string, Set<string>> = {
  ss: new Set(),
  vless: new Set([
    ...commonTlsQuery,
    'security',
    'type',
    'encryption',
    'pbk',
    'sid',
    'flow',
    'path',
    'host',
    'serviceName',
  ]),
  trojan: new Set([...commonTlsQuery, 'type', 'path', 'host', 'serviceName']),
  hysteria2: new Set(['sni', 'peer', 'insecure', 'obfs', 'obfs-password']),
  hy2: new Set(['sni', 'peer', 'insecure', 'obfs', 'obfs-password']),
  tuic: new Set([
    'sni',
    'alpn',
    'allow_insecure',
    'insecure',
    'congestion_control',
    'congestion-controller',
    'udp_relay_mode',
    'udp-relay-mode',
    'reduce_rtt',
  ]),
};
export function preflight(entry: string | Record<string, unknown>, i: number): Diagnostic[] {
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
  if (typeof entry === 'string') {
    const scheme = entry.split('://')[0];
    if (!['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic'].includes(scheme)) {
      fail('protocol');
      return diagnostics;
    }
    try {
      decodeURIComponent(entry);
      if (scheme === 'vmess') {
        const raw = decodeBase64(entry.slice(8));
        const data: unknown = JSON.parse(raw);
        if (!record(data)) {
          fail();
          return diagnostics;
        }
        // Use YAML's duplicate-key check too; JSON.parse alone silently overwrites keys.
        yamlObject(raw);
        if (data.net && !['tcp', 'ws', 'grpc'].includes(String(data.net))) fail('transport.type');
        if (data.tls && !['tls', 'none'].includes(String(data.tls))) fail('tls.mode');
        if (
          data.scy &&
          !['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'].includes(String(data.scy))
        )
          fail('protocolOptions.security');
        if (data.aid && Number(data.aid) !== 0) fail('protocolOptions.alterId');
        if (data.type && !['none', 'gun'].includes(String(data.type))) fail('transport.type');
        const keys = new Set([
          'v',
          'ps',
          'add',
          'port',
          'id',
          'aid',
          'scy',
          'net',
          'type',
          'host',
          'path',
          'tls',
          'sni',
          'alpn',
          'fp',
          'allowInsecure',
        ]);
        if (Object.keys(data).some((k) => !keys.has(k))) warning();
      } else {
        const url = new URL(entry);
        const params = url.searchParams;
        if (params.get('security') === 'reality' && !params.get('pbk')) fail('tls.publicKey');
        if (params.has('security') && !['vless', 'vmess'].includes(scheme)) fail('tls.mode');
        const transport = params.get('type') || 'tcp';
        if ((params.has('path') || params.has('host')) && transport !== 'ws') fail('transport');
        if (params.has('serviceName') && transport !== 'grpc') fail('transport.serviceName');
        if (params.has('sni') && ['', 'off'].includes(params.get('sni') ?? ''))
          fail('tls.serverName');
        const seen = new Set<string>();
        for (const [key, val] of params) {
          if (seen.has(key))
            diagnostics.push(diagnostic(i, 'DUPLICATE_PARAMETER', 'URI 含重复参数。'));
          seen.add(key);
          if (unsupportedFields.has(key)) fail();
          else if (queryFields.has(key) && !queryByProtocol[scheme]?.has(key)) fail();
          else if (!queryFields.has(key)) warning();
          if (key === 'obfs' && !['none', 'salamander', ''].includes(val))
            fail('protocolOptions.obfs');
          if (['pbk', 'sid'].includes(key) && params.get('security') !== 'reality')
            fail('tls.mode');
          if (key === 'type' && !['tcp', 'ws', 'grpc'].includes(val)) fail('transport.type');
          if (key === 'security' && !['none', 'tls', 'reality'].includes(val)) fail('tls.mode');
          if (key === 'encryption' && val !== 'none') fail('protocolOptions');
          if (
            [
              'allowInsecure',
              'insecure',
              'allow_insecure',
              'skip-cert-verify',
              'reduce_rtt',
            ].includes(key) &&
            !['0', '1', 'true', 'false'].includes(val.toLowerCase())
          )
            fail('tls.insecure');
        }
        if (scheme === 'ss' && params.size) fail('protocolOptions');
        if (scheme === 'hysteria2' || scheme === 'hy2') {
          if (params.has('alpn') || params.has('fp')) fail('tls');
          const authority = entry.split('://')[1]?.split(/[/?#]/)[0]?.split('@').at(-1) ?? '';
          if (/:[\d,;-]+$/.test(authority) && !/:\d+$/.test(authority)) fail('port');
        }
      }
    } catch {
      diagnostics.push(diagnostic(i, 'NODE_PARSE_FAILED', '节点链接格式或编码无效。'));
    }
  } else {
    if (!['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic'].includes(String(entry.type)))
      fail('protocol');
    for (const key of Object.keys(entry))
      if (
        unsupportedFields.has(key) &&
        entry[key] !== undefined &&
        entry[key] !== false &&
        entry[key] !== ''
      )
        fail();
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
      'obfs',
      'obfs-password',
    ]) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') fail();
    }
    if (
      ['sni', 'servername'].some((key) => key in entry && ['', 'off'].includes(String(entry[key])))
    )
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
    if (Object.keys(entry).some((k) => !allowed.has(k) && !unsupportedFields.has(k))) warning();
  }
  // Avoid unbounded/repetitive diagnostics for a single hostile item.
  return diagnostics.slice(0, 32);
}
