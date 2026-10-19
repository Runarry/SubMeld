import type { MachineAction, MachineSnapshot } from '../server/shared/machines';

export type FieldOption = { value: string; label: string };
export type MachineField = {
  key: string;
  label: string;
  kind?:
    'number' | 'flag' | 'select' | 'core' | 'profile' | 'node' | 'exit' | 'binding' | 'forward';
  options?: FieldOption[];
  required?: boolean;
  advanced?: boolean;
  multiple?: boolean;
  hint?: string;
};
export type MachineActionDefinition = {
  action: MachineAction;
  label: string;
  group: string;
  fields: MachineField[];
  warning?: string;
};
const choices = (...values: string[]): FieldOption[] =>
  values.map((value) => ({ value, label: value }));
const select = (key: string, label: string, values: string[], advanced = false): MachineField => ({
  key,
  label,
  kind: 'select',
  options: choices(...values),
  advanced,
});
const core: MachineField = { key: 'core', label: '内核', kind: 'core', required: true };
const profile: MachineField = { key: 'profile', label: '协议配置', kind: 'profile' };
const name: MachineField = { key: 'name', label: '名称' };
const id = (kind: 'node' | 'exit' | 'binding' | 'forward', label: string): MachineField => ({
  key: 'id',
  label,
  kind,
  required: true,
});
const flag = (key: string, label: string, advanced = false): MachineField => ({
  key,
  label,
  kind: 'flag',
  advanced,
});
const ipStrategy = select('ip-strategy', '出站 IP 策略', [
  'auto',
  'prefer_ipv4',
  'prefer_ipv6',
  'ipv4_only',
  'ipv6_only',
]);
const nodeFields: MachineField[] = [
  name,
  { key: 'port', label: '监听端口', kind: 'number' },
  { key: 'address', label: '客户端连接地址', hint: '客户端实际访问的 IP 或域名。' },
  { key: 'listen', label: '监听地址', advanced: true },
  { key: 'sni', label: 'TLS / REALITY 服务器名称（SNI）', advanced: true },
  select('reality-anti-relay', 'REALITY 防偷', ['on', 'off'], true),
  { key: 'path', label: '传输路径', advanced: true },
  { key: 'service-name', label: 'gRPC 服务名称', advanced: true },
  select('xhttp-mode', 'XHTTP 模式', ['auto', 'packet-up', 'stream-up', 'stream-one'], true),
  { key: 'host', label: '传输 Host', advanced: true },
  select('cert-mode', '证书模式', ['self-signed', 'imported', 'managed'], true),
  { key: 'cert-file', label: '机器上的证书文件路径', advanced: true },
  { key: 'key-file', label: '机器上的私钥文件路径', advanced: true },
  { key: 'cert-id', label: '托管证书 ID', advanced: true },
  select('obfs', '混淆方式', ['none', 'salamander', 'gecko'], true),
  { key: 'up-mbps', label: '上行带宽（Mbps）', kind: 'number', advanced: true },
  { key: 'down-mbps', label: '下行带宽（Mbps）', kind: 'number', advanced: true },
  {
    key: 'hop-ports',
    label: '跳跃端口',
    advanced: true,
    hint: '例如 20000-20100,21000；off 明确关闭。',
  },
  select('bbr-profile', 'BBR 档位', ['default', 'standard', 'conservative', 'aggressive'], true),
  select('congestion-control', 'TUIC 拥塞控制', ['bbr', 'cubic', 'new_reno'], true),
  { ...ipStrategy, advanced: true },
];
const exitFields: MachineField[] = [
  name,
  {
    key: 'uri',
    label: '协议出口链接',
    hint: '协议出口填写链接；直连出口填写目标地址及端口。留空保留现有凭据。',
  },
  { key: 'target', label: '直连目标地址' },
  { key: 'target-port', label: '直连目标端口', kind: 'number' },
  { ...profile, advanced: true },
  { ...core, required: false, advanced: true },
  { key: 'tls-cert-file', label: '机器上的出口证书文件', advanced: true },
  { key: 'tls-spki-sha256', label: 'TLS 公钥 SHA-256（Base64）', advanced: true },
  select('chrome-parrot', 'Chrome QUIC 模拟', ['default', 'on', 'off'], true),
  select(
    'bbr-profile',
    '出口 BBR 档位',
    ['default', 'standard', 'conservative', 'aggressive'],
    true,
  ),
  { key: 'hop-ports', label: '出口跳跃端口', advanced: true, hint: '端口集合；off 明确关闭。' },
  {
    key: 'hop-interval',
    label: '出口跳跃间隔（秒）',
    advanced: true,
    hint: '秒数、MIN-MAX 或 default，至少 5 秒。',
  },
  select('bandwidth-mode', '出口带宽模式', ['auto', 'manual'], true),
  { key: 'up-mbps', label: '出口上行（Mbps）', kind: 'number', advanced: true },
  { key: 'down-mbps', label: '出口下行（Mbps）', kind: 'number', advanced: true },
];
const forwardFields: MachineField[] = [
  name,
  { key: 'exit-id', label: '出口', kind: 'exit' },
  { key: 'listen-ports', label: '入口端口或端口范围', hint: '例如 8443 或 20000-20100。' },
  select('network', '网络协议', ['auto', 'tcp', 'udp', 'both']),
  select('family', '地址族', ['dual', 'ipv4', 'ipv6']),
  { key: 'address', label: '客户端连接地址' },
];
const releases: MachineField[] = [
  core,
  select('release-channel', '发布通道', ['stable', 'prerelease']),
  { key: 'version', label: '精确版本标签', hint: '与发布通道互斥；留空执行默认稳定更新。' },
];

export const machineActions: MachineActionDefinition[] = [
  { action: 'core.install', label: '安装内核', group: '内核', fields: releases },
  {
    action: 'core.update',
    label: '升级内核',
    group: '内核',
    fields: [...releases, flag('confirm-external-update', '允许替换已登记的外部内核二进制', true)],
    warning: '升级后可能需要显式重启。指定发布通道或版本允许降级。',
  },
  {
    action: 'core.start',
    label: '启动内核',
    group: '内核',
    fields: [core, flag('enable', '同时启用开机启动')],
  },
  {
    action: 'core.stop',
    label: '停止内核',
    group: '内核',
    fields: [core, flag('disable', '同时关闭开机启动')],
    warning: '该内核上的代理连接将停止。',
  },
  {
    action: 'core.restart',
    label: '重启内核',
    group: '内核',
    fields: [core, flag('confirm-disruptive', '确认短暂中断该内核连接')],
    warning: '重启会应用待生效配置或内核更新。',
  },
  {
    action: 'core.uninstall',
    label: '卸载内核',
    group: '内核',
    fields: [
      core,
      flag('purge', '彻底删除该内核的受管配置、节点、备份和日志'),
      flag('confirm-purge', '确认不可逆清除'),
    ],
    warning: '普通卸载停止服务并保留配置；彻底清除不可恢复。',
  },
  {
    action: 'node.add',
    label: '添加机器节点',
    group: '节点',
    fields: [{ ...profile, required: true }, core, ...nodeFields],
  },
  {
    action: 'node.edit',
    label: '编辑机器节点',
    group: '节点',
    fields: [id('node', '节点'), ...nodeFields],
    warning: '只提交填写的字段；留空保留原值。凭据由机器管理，不可直接编辑。',
  },
  {
    action: 'node.delete',
    label: '删除机器节点',
    group: '节点',
    fields: [
      id('node', '节点'),
      flag('cascade-relay', '同时删除依赖此节点的中转关联'),
      flag('confirm-delete', '确认删除该节点'),
    ],
    warning: '删除节点后，使用该节点的客户端连接将失效。',
  },
  {
    action: 'node.switch',
    label: '切换节点内核',
    group: '节点',
    fields: [id('node', '节点'), core, flag('confirm-disruptive', '确认切换并中断现有连接')],
    warning: '保留节点端点和凭据，由兼容且已安装的目标内核立即接管。',
  },
  {
    action: 'node.ip-policy',
    label: '设置节点 IP 策略',
    group: '节点',
    fields: [
      core,
      { ...ipStrategy, required: true },
      { key: 'id', label: '指定节点（可多选）', kind: 'node', multiple: true },
      profile,
      flag('all', '此内核的全部节点'),
    ],
    warning: '指定节点、协议配置、全部节点三种范围选择一种。',
  },
  {
    action: 'dns.set',
    label: '设置 DNS',
    group: 'DNS',
    fields: [
      core,
      select('preset', 'DNS 预设', ['cloudflare-doh']),
      select('mode', 'DNS 模式', ['system', 'system-native', 'udp', 'tcp', 'dot', 'doh']),
      { key: 'server', label: 'DNS 服务器' },
      { key: 'port', label: 'DNS 端口', kind: 'number' },
      { key: 'tls-server-name', label: 'DNS TLS 服务器名称', advanced: true },
      { key: 'path', label: 'DoH 路径', advanced: true },
      { key: 'bootstrap', label: '引导 DNS IP', advanced: true },
    ],
    warning: 'DNS 仅适用于 sing-box。预设与自定义模式及字段互斥。',
  },
  { action: 'dns.reset', label: '恢复系统 DNS', group: 'DNS', fields: [core] },
  { action: 'exit.add', label: '添加原生出口', group: '原生中转', fields: exitFields },
  {
    action: 'exit.edit',
    label: '编辑原生出口',
    group: '原生中转',
    fields: [id('exit', '出口'), ...exitFields],
  },
  {
    action: 'exit.delete',
    label: '删除原生出口',
    group: '原生中转',
    fields: [
      id('exit', '出口'),
      flag('cascade', '同时删除全部节点关联和端口转发'),
      flag('confirm-cascade', '确认级联删除'),
    ],
    warning: '仍被引用的出口需先解除关联，或明确选择级联删除。',
  },
  {
    action: 'binding.add',
    label: '关联节点出口',
    group: '原生中转',
    fields: [
      { key: 'node-id', label: '入口节点', kind: 'node', required: true },
      { key: 'exit-id', label: '出口', kind: 'exit', required: true },
    ],
    warning:
      '每个入口只能关联一个同内核协议出口。更换出口时，先删除旧关联，等待任务应用后再建立新关联。',
  },
  {
    action: 'binding.delete',
    label: '删除节点关联',
    group: '原生中转',
    fields: [id('binding', '关联'), flag('confirm-delete', '确认删除该关联')],
  },
  {
    action: 'forward.add',
    label: '添加原生转发',
    group: '原生中转',
    fields: forwardFields.map((field) => ({
      ...field,
      required: ['name', 'exit-id', 'listen-ports'].includes(field.key),
    })),
  },
  {
    action: 'forward.edit',
    label: '编辑原生转发',
    group: '原生中转',
    fields: [id('forward', '转发'), ...forwardFields],
  },
  {
    action: 'forward.delete',
    label: '删除原生转发',
    group: '原生中转',
    fields: [id('forward', '转发'), flag('confirm-delete', '确认删除该转发')],
  },
  {
    action: 'forward.refresh',
    label: '刷新原生转发',
    group: '原生中转',
    fields: [{ ...id('forward', '转发'), required: false }],
  },
  { action: 'time.sync', label: '同步系统时间', group: '系统', fields: [] },
];

export const machineActionLabels = Object.fromEntries(
  machineActions.map((item) => [item.action, item.label]),
);
export const machineStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  applied: '已应用',
  pending_restart: '待重启',
  conflict: '版本冲突',
  failed: '失败',
  unknown: '结果未知',
  cancelled: '已取消',
};

export function fieldOptions(
  field: MachineField,
  snapshot: MachineSnapshot,
  action: MachineAction,
  values: Record<string, string | string[] | boolean>,
): FieldOption[] {
  if (field.options) return field.options;
  if (field.kind === 'core') {
    const node = snapshot.nodes.find((item) => item.id === values.id);
    const selectedProfile = String(
      values.profile || (action === 'node.switch' ? node?.profile || '' : ''),
    );
    const allowed = snapshot.capabilities.profiles.find(
      (item) => item.id === selectedProfile,
    )?.cores;
    if (selectedProfile && !allowed) return [];
    const available = snapshot.cores
      .filter((item) => {
        if (action.startsWith('dns.')) return item.core === 'sing-box' && item.installed;
        if (action === 'core.install') return !item.installed;
        if (!item.installed) return false;
        if (action === 'core.start') return !item.running;
        if (action === 'core.stop' || action === 'core.restart') return item.running;
        if (action === 'node.switch' && node?.core === item.core) return false;
        return !allowed || allowed.includes(item.core);
      })
      .map((item) => ({ value: String(item.core), label: String(item.core) }));
    if (available.length > 1 && (action === 'core.install' || action === 'core.update'))
      available.push({ value: 'all', label: '全部适用内核' });
    return available;
  }
  if (field.kind === 'profile')
    return snapshot.capabilities.profiles
      .filter((item) => !values.core || item.cores.some((core) => core === values.core))
      .map((item) => ({ value: item.id, label: item.label + ' · ' + item.id }));
  const records =
    field.kind === 'node'
      ? snapshot.nodes.filter((item) => {
          if (action === 'node.ip-policy') return !values.core || item.core === values.core;
          if (action === 'binding.add')
            return !snapshot.relay.bindings.some((binding) => binding.node_id === item.id);
          return true;
        })
      : field.kind === 'exit'
        ? snapshot.relay.exits.filter((exit) => {
            if (action !== 'binding.add') return true;
            const node = snapshot.nodes.find((node) => node.id === values['node-id']);
            return exit.type === 'protocol' && (!node || exit.core === node.core);
          })
        : field.kind === 'binding'
          ? snapshot.relay.bindings
          : field.kind === 'forward'
            ? snapshot.relay.forwards
            : [];
  return records.flatMap((item) =>
    typeof item.id === 'string'
      ? [
          {
            value: item.id,
            label:
              String(item.name || item['node_id'] || item.id) +
              (typeof item.core === 'string' ? ' · ' + item.core : ''),
          },
        ]
      : [],
  );
}

export function machineParams(
  definition: MachineActionDefinition,
  values: Record<string, string | string[] | boolean>,
): Record<string, string | string[] | number | boolean> {
  const params: Record<string, string | string[] | number | boolean> = {};
  for (const field of definition.fields) {
    const value = values[field.key];
    if (
      value === undefined ||
      value === '' ||
      value === false ||
      (Array.isArray(value) && !value.length)
    ) {
      if (field.required) throw new Error('请填写' + field.label + '。');
      continue;
    }
    if (field.kind === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number))
        throw new Error(field.label + '必须是正整数。');
      if ((field.key === 'port' || field.key === 'target-port') && number > 65535)
        throw new Error(field.label + '不能超过 65535。');
      params[field.key] = number;
    } else params[field.key] = value;
  }
  if (params.version && params['release-channel'])
    throw new Error('发布通道与精确版本标签只能选择一种。');
  if (params.core === 'all' && params.version) throw new Error('精确版本请分别为单个内核指定。');
  if (params['cert-mode'] === 'managed' && !params['cert-id'])
    throw new Error('托管证书模式需要填写托管证书 ID。');
  if (params['cert-mode'] === 'imported' && (!params['cert-file'] || !params['key-file']))
    throw new Error('导入证书需要填写机器上的证书和私钥路径。');
  if (params.purge && !params['confirm-purge']) throw new Error('彻底清除需要勾选不可逆清除确认。');
  if (params.cascade && !params['confirm-cascade']) throw new Error('级联删除需要勾选确认。');
  if (
    (definition.action === 'node.switch' || definition.action === 'core.restart') &&
    !params['confirm-disruptive']
  )
    throw new Error('请确认连接中断后再提交。');
  if (
    definition.action === 'node.ip-policy' &&
    [params.id, params.profile, params.all].filter(Boolean).length !== 1
  )
    throw new Error('指定节点、协议配置、全部节点必须选择且只能选择一种。');
  if (definition.action === 'dns.set') {
    if (!params.preset && !params.mode) throw new Error('请选择 DNS 预设或模式。');
    if (
      params.preset &&
      ['mode', 'server', 'port', 'tls-server-name', 'path', 'bootstrap'].some(
        (key) => params[key] !== undefined,
      )
    )
      throw new Error('DNS 预设不能和自定义字段同时提交。');
  }
  if (definition.action === 'exit.add') {
    if (!params.name) throw new Error('请填写出口名称。');
    if (params.uri && (params.target || params['target-port']))
      throw new Error('协议链接与直连目标只能选择一种。');
    if (!params.uri && (!params.target || !params['target-port']))
      throw new Error('请填写协议出口链接，或完整的直连目标地址和端口。');
  }
  return params;
}
