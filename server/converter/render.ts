import { stringify } from 'yaml';
import { AppError } from '../errors.js';
import {
  MAX_BYTES,
  diagnostic,
  renderRequestSchema,
  type NodeDraft,
  type RenderResult,
} from '../shared/contracts.js';
import { record, fromUpstream, toUpstream } from './model.js';
import { prepareItems, produceUpstream } from './engine.js';
import { xrayOutbound } from './xray.js';
import { basicConfig, SELECTOR } from '../templates/basic.js';
function at(value: unknown, path: string): unknown {
  for (const part of path.split('.')) value = record(value) ? value[part] : undefined;
  return value;
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Connection field changed');
}
function checkMihomo(value: Record<string, unknown>, node: NodeDraft) {
  const restored = fromUpstream(
    { ...value, ...(['trojan', 'hysteria2', 'tuic'].includes(node.protocol) ? { tls: true } : {}) },
    0,
  );
  equal(restored.protocol, node.protocol);
  equal(restored.name, node.name);
  equal(restored.server, node.server);
  equal(restored.port, node.port);
  equal(restored.auth, node.auth);
  equal(restored.protocolOptions, node.protocolOptions);
  equal(restored.tls, node.tls);
  equal(restored.transport.type, node.transport.type);
  if (node.transport.type === 'ws') {
    equal(restored.transport.path, node.transport.path);
    equal(restored.transport.host, node.transport.host);
  }
  if (node.transport.type === 'grpc')
    equal(restored.transport.serviceName, node.transport.serviceName);
}
function checkSingbox(value: Record<string, unknown>, node: NodeDraft) {
  const check = (path: string, expected: unknown, fallback?: unknown) =>
    equal(at(value, path) ?? fallback, expected);
  check('type', node.protocol === 'ss' ? 'shadowsocks' : node.protocol);
  check('tag', node.name);
  check('server', node.server);
  check('server_port', node.port);
  for (const [key, val] of Object.entries(node.auth)) check(key, val);
  if (node.protocol === 'ss') check('method', node.protocolOptions.method);
  if (node.protocol === 'vmess') {
    check('security', node.protocolOptions.security);
    check('alter_id', 0);
  }
  if (node.protocol === 'vless') check('flow', node.protocolOptions.flow, '');
  if (node.protocol === 'hysteria2') {
    check('obfs.type', node.protocolOptions.obfs, '');
    if (node.protocolOptions.obfs) check('obfs.password', node.protocolOptions.obfsPassword);
  }
  if (node.protocol === 'tuic') {
    check('congestion_control', node.protocolOptions.congestionControl, 'cubic');
    check('udp_relay_mode', node.protocolOptions.udpRelayMode, 'native');
    check('zero_rtt_handshake', node.protocolOptions.reduceRtt, false);
  }
  check('tls.enabled', node.tls.mode !== 'none', false);
  if (node.tls.mode !== 'none') {
    check('tls.insecure', node.tls.insecure, false);
    check('tls.server_name', node.tls.serverName || node.server);
    check('tls.alpn', node.tls.alpn, []);
    check('tls.reality.enabled', node.tls.mode === 'reality', false);
    if (node.tls.fingerprint) {
      check('tls.utls.enabled', true);
      check('tls.utls.fingerprint', node.tls.fingerprint);
    }
    if (node.tls.mode === 'reality') {
      check('tls.reality.public_key', node.tls.publicKey);
      check('tls.reality.short_id', node.tls.shortId, '');
    }
  }
  check('transport.type', node.transport.type, 'tcp');
  if (node.transport.type === 'ws') {
    check('transport.path', node.transport.path);
    check('transport.headers.Host', node.transport.host, '');
  }
  if (node.transport.type === 'grpc')
    check('transport.service_name', node.transport.serviceName, '');
}
export function renderInput(input: unknown): RenderResult {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数据超过 4 MiB。', 413);
  const parsed = renderRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', '目标生成请求无效。', 400);
  const { target, listenPort } = parsed.data;
  const { items, included, diagnostics } = prepareItems({ items: parsed.data.items });
  const used = new Set([SELECTOR, 'DIRECT', 'REJECT', 'GLOBAL', 'PASS', 'COMPATIBLE']);
  const nodes: Record<string, unknown>[] = [],
    names: string[] = [];
  for (const item of included) {
    if (!item.draft) continue;
    const node = structuredClone(item.draft);
    if (
      target === 'xray' &&
      (!['ss', 'vmess', 'vless', 'trojan'].includes(node.protocol) || node.tls.insecure)
    ) {
      diagnostics.push(
        diagnostic(
          item.nodeIndex,
          'TARGET_UNSUPPORTED',
          node.tls.insecure
            ? '锁定 Xray 版本不支持关闭证书验证；请使用其他目标或明确修改节点。'
            : '本项目 Xray 目标尚不支持 Hysteria2／TUIC，请明确排除或选择其他目标。',
        ),
      );
      continue;
    }
    if (target === 'xray' && node.tls.mode === 'reality' && node.tls.alpn.length) {
      diagnostics.push(
        diagnostic(
          item.nodeIndex,
          'TARGET_UNSUPPORTED',
          'Xray REALITY 不开放自定义 ALPN；不能静默丢弃该设置。',
          'tls.alpn',
        ),
      );
      continue;
    }
    let name = node.name,
      suffix = 2;
    while (used.has(name)) name = node.name + ' (' + suffix++ + ')';
    used.add(name);
    if (name !== node.name)
      diagnostics.push(
        diagnostic(
          item.nodeIndex,
          'OUTPUT_NAME_ADJUSTED',
          '节点名称与其他节点或模板保留名称重复，导出副本已追加序号。',
          'name',
          'warning',
        ),
      );
    node.name = name;
    if (node.tls.mode === 'reality' && !node.tls.fingerprint) {
      node.tls.fingerprint = 'chrome';
      diagnostics.push(
        diagnostic(
          item.nodeIndex,
          'REALITY_DEFAULT_FINGERPRINT',
          '此目标的 REALITY 使用 chrome 默认指纹。',
          'tls.fingerprint',
          'warning',
        ),
      );
    }
    try {
      let output: Record<string, unknown>;
      if (target === 'xray') output = xrayOutbound(node);
      else {
        const raw: unknown = produceUpstream(
          [structuredClone(toUpstream(node))],
          target === 'mihomo' ? 'Mihomo' : 'sing-box',
          'internal',
        );
        if (!Array.isArray(raw) || raw.length !== 1 || !record(raw[0]))
          throw new Error('Missing node');
        output = raw[0];
        if (target === 'mihomo') checkMihomo(output, node);
        else checkSingbox(output, node);
      }
      nodes.push(output);
      names.push(name);
    } catch {
      diagnostics.push(
        diagnostic(
          item.nodeIndex,
          'EXPORT_FIELD_LOSS',
          '此项无法完整输出已开放的连接字段，请修正参数或明确排除。',
        ),
      );
    }
  }
  if (diagnostics.some((d) => d.level === 'error') || nodes.length !== included.length)
    throw new AppError('CONVERSION_FAILED', '此目标生成失败；其他目标仍可使用。', 422, diagnostics);
  const serialize = (value: unknown) =>
    target === 'mihomo'
      ? stringify(value, { lineWidth: 0 })
      : JSON.stringify(value, null, 2) + '\n';
  const fragment = serialize(target === 'mihomo' ? { proxies: nodes } : { outbounds: nodes });
  const full = serialize(basicConfig(target, nodes, names, listenPort));
  if ([fragment, full].some((value) => Buffer.byteLength(value) > MAX_BYTES))
    throw new AppError('OUTPUT_LIMIT_EXCEEDED', '此目标输出超过 4 MiB。');
  return {
    target,
    full,
    nodes: fragment,
    diagnostics,
    counts: { input: items.length, output: nodes.length, filtered: items.length - included.length },
  };
}
