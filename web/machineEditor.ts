import type { MachineSnapshot } from '../server/shared/machines';
import { machineActions, machineParams, type MachineField } from './machineActions';

export type MachineNode = MachineSnapshot['nodes'][number];
export type NodeEditorValues = Record<string, string>;
export type NodeEditorField = MachineField & {
  section: 'basic' | 'tls' | 'transport' | 'advanced';
};
const tlsProfiles = new Set([
  'vless-ws-tls',
  'trojan-ws-tls',
  'vless-grpc-tls',
  'anytls-tls',
  'hysteria2',
  'tuic-v5',
  'vless-xhttp-tls',
  'trojan-grpc-tls',
]);
const realityProfiles = new Set([
  'vless-reality-vision',
  'anytls-reality',
  'vless-grpc-reality',
  'vless-xhttp-reality',
  'trojan-xhttp-reality',
  'trojan-grpc-reality',
]);
const paths: Record<string, string[]> = {
  name: ['name'],
  port: ['port'],
  address: ['address'],
  listen: ['listen'],
  sni: ['tls', 'server_name'],
  'cert-mode': ['tls', 'mode'],
  'cert-id': ['tls', 'certificate_id'],
  'reality-anti-relay': ['tls', 'reality_guard', 'enabled'],
  path: ['transport', 'path'],
  'service-name': ['transport', 'service_name'],
  'xhttp-mode': ['transport', 'mode'],
  host: ['transport', 'host'],
  obfs: ['options', 'obfs_type'],
  'up-mbps': ['options', 'up_mbps'],
  'down-mbps': ['options', 'down_mbps'],
  'hop-ports': ['options', 'hop_ports'],
  'bbr-profile': ['options', 'bbr_profile'],
  'congestion-control': ['options', 'congestion_control'],
  'ip-strategy': ['ip_strategy'],
};
function atPath(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function nodeEditorValues(node: MachineNode): NodeEditorValues {
  return Object.fromEntries(
    Object.entries(paths).map(([key, path]) => {
      const value = atPath(node, path);
      return [
        key,
        key === 'reality-anti-relay' && typeof value === 'boolean'
          ? value
            ? 'on'
            : 'off'
          : typeof value === 'string' || typeof value === 'number'
            ? String(value)
            : '',
      ];
    }),
  );
}
export function nodeProtocol(node: MachineNode): string {
  if (node.profile === 'hysteria2') return 'Hysteria2';
  if (node.profile === 'tuic-v5') return 'TUIC';
  if (node.profile.startsWith('shadowsocks') || node.profile === 'ss') return 'Shadowsocks';
  if (node.profile.startsWith('vless')) return 'VLESS';
  if (node.profile.startsWith('trojan')) return 'Trojan';
  if (node.profile.startsWith('anytls')) return 'AnyTLS';
  if (node.profile === 'socks5') return 'SOCKS5';
  return node.profile;
}
export function nodeEditorFields(node: MachineNode, values: NodeEditorValues): NodeEditorField[] {
  const fields = machineActions.find((item) => item.action === 'node.edit')!.fields;
  const transport = atPath(node, ['transport', 'type']);
  const isXhttp = transport === 'xhttp' || node.profile.includes('-xhttp-');
  const isGrpc = transport === 'grpc' || node.profile.includes('-grpc-');
  const isWs = transport === 'ws' || node.profile.includes('-ws-');
  return fields.flatMap((field) => {
    let section: NodeEditorField['section'] = 'advanced';
    if (['id'].includes(field.key)) return [];
    if (['name', 'address', 'port', 'listen'].includes(field.key)) section = 'basic';
    else if (field.key === 'sni') {
      if (
        !tlsProfiles.has(node.profile) &&
        !realityProfiles.has(node.profile) &&
        node.profile !== 'shadowsocks-2022-shadowtls'
      )
        return [];
      section = 'tls';
    } else if (field.key === 'reality-anti-relay') {
      if (!realityProfiles.has(node.profile)) return [];
      section = 'tls';
    } else if (field.key.startsWith('cert-') || field.key === 'key-file') {
      if (!tlsProfiles.has(node.profile)) return [];
      if (['cert-file', 'key-file'].includes(field.key) && values['cert-mode'] !== 'imported')
        return [];
      if (field.key === 'cert-id' && values['cert-mode'] !== 'managed') return [];
      section = 'tls';
    } else if (['path', 'service-name', 'xhttp-mode', 'host'].includes(field.key)) {
      if (field.key === 'path' && !isWs && !isXhttp) return [];
      if (field.key === 'service-name' && !isGrpc) return [];
      if (['host', 'xhttp-mode'].includes(field.key) && !isXhttp) return [];
      section = 'transport';
    } else if (['obfs', 'up-mbps', 'down-mbps', 'hop-ports', 'bbr-profile'].includes(field.key)) {
      if (node.profile !== 'hysteria2') return [];
    } else if (field.key === 'congestion-control' && node.profile !== 'tuic-v5') return [];
    return [
      {
        ...field,
        label:
          field.key === 'name' ? '节点名称' : field.key === 'sni' ? '服务器名称 SNI' : field.label,
        section,
      },
    ];
  });
}
export function nodeChanges(
  node: MachineNode,
  baseline: NodeEditorValues,
  values: NodeEditorValues,
) {
  return nodeEditorFields(node, values)
    .filter((field) => (values[field.key] || '') !== (baseline[field.key] || ''))
    .map((field) => ({ field, before: baseline[field.key] || '', after: values[field.key] || '' }));
}
export function nodeEditParams(
  node: MachineNode,
  baseline: NodeEditorValues,
  values: NodeEditorValues,
) {
  const changes = nodeChanges(node, baseline, values);
  if (!changes.length) throw new Error('尚未修改节点参数。');
  if (changes.some((change) => !change.after))
    throw new Error('留空不会清除原值；请使用字段支持的 off / default 选项，或恢复原值。');
  const dirty = Object.fromEntries(changes.map((change) => [change.field.key, change.after]));
  const mode = values['cert-mode'];
  if (dirty['cert-file'] || dirty['key-file']) {
    if (!values['cert-file'] || !values['key-file'])
      throw new Error('导入证书需要同时提供机器上的证书与私钥路径。');
    dirty['cert-file'] = values['cert-file'];
    dirty['key-file'] = values['key-file'];
  }
  if (
    mode === 'imported' &&
    (dirty.sni || dirty['cert-mode']) &&
    (!dirty['cert-file'] || !dirty['key-file'])
  )
    throw new Error('切换为导入证书或修改其 SNI 时，必须提供匹配的新证书与私钥路径。');
  if (mode === 'managed' && dirty['cert-mode']) {
    if (!values['cert-id']) throw new Error('托管证书需要证书 ID。');
    dirty['cert-id'] = values['cert-id'];
  }
  return machineParams(
    machineActions.find((item) => item.action === 'node.edit')!,
    { id: node.id, ...dirty },
  );
}
