import { SubStoreClient } from '../sub-store.js';
import { stringify } from 'yaml';
import { AppError } from '../errors.js';
import {
  MAX_BYTES,
  MAX_NODES,
  isChain,
  type Diagnostic,
  diagnostic,
  renderRequestSchema,
  type NodeDraft,
  type RenderResult,
} from '../shared/contracts.js';
import { record, fromUpstream, toUpstream, validateDraft } from './model.js';
import { produceUpstream } from './engine.js';
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
  if (node.protocol === 'vless') {
    check('flow', node.protocolOptions.flow, '');
    check('packet_encoding', node.protocolOptions.packetEncoding, 'xudp');
  }
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
export async function renderInput(
  input: unknown,
  client = new SubStoreClient(),
  signal?: AbortSignal,
): Promise<RenderResult> {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数据超过 4 MiB。', 413);
  const parsed = renderRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', '目标生成请求无效。', 400);
  const { target, listenPort, items } = parsed.data;
  if (new Set(items.map((item) => item.nodeIndex)).size !== items.length)
    throw new AppError('INVALID_REQUEST', '节点序号不能重复。', 400);
  if (items.reduce((n, item) => n + (isChain(item) ? 2 : 1), 0) > MAX_NODES)
    throw new AppError('INPUT_LIMIT_EXCEEDED', '展开后的节点数量超过 2,000。', 413);
  const included = items.filter((item) => !item.excluded);
  if (!included.length) throw new AppError('EMPTY_OUTPUT', '至少保留一个有效节点。');
  const diagnostics: Diagnostic[] = [];
  for (const item of included) {
    if (isChain(item)) {
      if (!item.available)
        diagnostics.push(
          diagnostic(
            item.nodeIndex,
            'CHAIN_NODE_DISABLED',
            '链式代理的前置或出口节点已停用，请启用节点或停用此链。',
          ),
        );
      for (const role of ['entry', 'exit'] as const)
        diagnostics.push(
          ...validateDraft(item[role], item.nodeIndex).map((d) => ({
            ...d,
            field: role + (d.field ? '.' + d.field : ''),
            message: (role === 'entry' ? '前置代理：' : '出口代理：') + d.message,
          })),
        );
    } else if (item.draft) diagnostics.push(...validateDraft(item.draft, item.nodeIndex));
    else
      diagnostics.push(
        diagnostic(item.nodeIndex, 'NODE_REQUIRED', '此项尚未解析成功，请修正或明确排除。'),
      );
  }
  if (diagnostics.some((d) => d.level === 'error'))
    throw new AppError('CONVERSION_FAILED', '请修正或明确排除错误节点。', 422, diagnostics);
  const used = new Set([SELECTOR, 'DIRECT', 'REJECT', 'GLOBAL', 'PASS', 'COMPATIBLE']);
  function allocate(original: string, index: number) {
    let name = original,
      suffix = 2;
    while (used.has(name)) name = original + ' (' + suffix++ + ')';
    used.add(name);
    if (name !== original)
      diagnostics.push(
        diagnostic(
          index,
          'OUTPUT_NAME_ADJUSTED',
          '节点名称与其他节点或模板保留名称重复，导出副本已追加序号。',
          'name',
          'warning',
        ),
      );
    return name;
  }
  async function convert(draft: NodeDraft, name: string, index: number, role?: 'entry' | 'exit') {
    const node = structuredClone(draft);
    node.name = name;
    const report = (
      code: string,
      message: string,
      field?: string,
      level: 'error' | 'warning' = 'error',
    ) => {
      diagnostics.push(
        diagnostic(
          index,
          code,
          (role ? (role === 'entry' ? '前置代理：' : '出口代理：') : '') + message,
          role ? role + (field ? '.' + field : '') : field,
          level,
        ),
      );
    };
    if (
      target === 'xray' &&
      (!['ss', 'vmess', 'vless', 'trojan'].includes(node.protocol) || node.tls.insecure)
    ) {
      report(
        'TARGET_UNSUPPORTED',
        node.tls.insecure
          ? '锁定 Xray 版本不支持关闭证书验证；请使用其他目标或明确修改节点。'
          : '本项目 Xray 目标尚不支持 Hysteria2／TUIC，请明确排除或选择其他目标。',
      );
      return;
    }
    if (target === 'xray' && node.tls.mode === 'reality' && node.tls.alpn.length) {
      report(
        'TARGET_UNSUPPORTED',
        'Xray REALITY 不开放自定义 ALPN；不能静默丢弃该设置。',
        'tls.alpn',
      );
      return;
    }
    if (node.tls.mode === 'reality' && !node.tls.fingerprint) {
      node.tls.fingerprint = 'chrome';
      report(
        'REALITY_DEFAULT_FINGERPRINT',
        '此目标的 REALITY 使用 chrome 默认指纹。',
        'tls.fingerprint',
        'warning',
      );
    }
    try {
      if (target === 'xray') return xrayOutbound(node);
      const raw: unknown = await produceUpstream(
        [structuredClone(toUpstream(node))],
        target === 'mihomo' ? 'Mihomo' : 'sing-box',
        'internal',
        client,
        signal,
      );
      if (!Array.isArray(raw) || raw.length !== 1 || !record(raw[0]))
        throw new Error('Missing node');
      const output = raw[0];
      if (target === 'mihomo') checkMihomo(output, node);
      else checkSingbox(output, node);
      return output;
    } catch (error) {
      if (error instanceof AppError && error.status >= 500) throw error;
      report('EXPORT_FIELD_LOSS', '此项无法完整输出已开放的连接字段，请修正参数或明确排除。');
    }
  }
  const nodes: Record<string, unknown>[] = [],
    names: string[] = [];
  for (const item of included) {
    if (isChain(item)) {
      const name = allocate(item.name, item.nodeIndex);
      const entryName = allocate(item.name.slice(0, 480) + ' · 前置', item.nodeIndex);
      const entry = await convert(item.entry, entryName, item.nodeIndex, 'entry');
      const exit = await convert(item.exit, name, item.nodeIndex, 'exit');
      if (!entry || !exit) continue;
      if (['hysteria2', 'tuic'].includes(item.exit.protocol)) {
        diagnostics.push(
          diagnostic(
            item.nodeIndex,
            'CHAIN_UDP_REQUIRED',
            '出口使用 UDP 协议，前置代理服务端必须支持 UDP 转发。',
            'entry',
            'warning',
          ),
        );
        if (target === 'mihomo') entry.udp = true;
      }
      if (target === 'mihomo') exit['dialer-proxy'] = entryName;
      else if (target === 'singbox') exit.detour = entryName;
      else {
        const stream = exit.streamSettings;
        if (!record(stream)) throw new AppError('CONVERSION_FAILED', 'Xray 链式配置缺少传输设置。');
        stream.sockopt = { dialerProxy: entryName };
      }
      // The visible exit stays first; the helper is never a selector/default choice.
      nodes.push(exit, entry);
      names.push(name);
    } else if (item.draft) {
      const name = allocate(item.draft.name, item.nodeIndex);
      const output = await convert(item.draft, name, item.nodeIndex);
      if (output) {
        nodes.push(output);
        names.push(name);
      }
    }
  }
  if (diagnostics.some((d) => d.level === 'error') || names.length !== included.length)
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
    counts: { input: items.length, output: names.length, filtered: items.length - included.length },
  };
}
