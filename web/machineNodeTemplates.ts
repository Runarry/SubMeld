import type { MachineSnapshot } from '../server/shared/machines';

export type NodeCore = 'sing-box' | 'xray';
export type NodeCreateParams = Record<string, string | number | string[] | boolean>;
export type NodeCreateDraft = {
  values: Record<string, string>;
  explicit: Record<string, boolean>;
  installDeps: boolean;
};
export type CreateField = {
  key: string;
  label: string;
  required?: boolean;
  number?: boolean;
  full?: boolean;
  hint?: string;
  placeholder?: string;
  options?: { value: string; label: string; reason?: string }[];
  section: 'basic' | 'tls' | 'transport' | 'performance' | 'network';
};
const tls = new Set([
  'vless-ws-tls',
  'trojan-ws-tls',
  'vless-grpc-tls',
  'anytls-tls',
  'hysteria2',
  'tuic-v5',
  'vless-xhttp-tls',
  'trojan-grpc-tls',
]);
const reality = new Set([
  'vless-reality-vision',
  'anytls-reality',
  'vless-grpc-reality',
  'vless-xhttp-reality',
  'trojan-xhttp-reality',
  'trojan-grpc-reality',
]);
const known = new Set([
  ...tls,
  ...reality,
  'shadowsocks-aes-256-gcm',
  'shadowsocks-chacha20-poly1305',
  'shadowsocks-2022',
  'shadowsocks-2022-padding',
  'shadowsocks-2022-shadowtls',
  'vless-tcp',
  'socks5',
]);
export function nodeTemplate(profile: string) {
  const isKnown = known.has(profile);
  return {
    known: isKnown,
    tls: tls.has(profile),
    reality: reality.has(profile),
    sni: tls.has(profile) || reality.has(profile) || profile === 'shadowsocks-2022-shadowtls',
    transport: !isKnown
      ? 'tcp'
      : profile.includes('-ws-')
        ? 'ws'
        : profile.includes('-grpc-')
          ? 'grpc'
          : profile.includes('-xhttp-')
            ? 'xhttp'
            : 'tcp',
  };
}
export function initialNodeProfile(snapshot: MachineSnapshot): string {
  const profiles = snapshot.capabilities.profiles;
  return (
    ['vless-reality-vision', 'hysteria2'].find((id) => profiles.some((p) => p.id === id)) ||
    profiles[0]?.id ||
    ''
  );
}

// Match the native semantic version gate, including prereleases below the matching release.
export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) =>
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  const a = parse(version),
    b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  if (!a[4] || !b[4]) return !a[4] || !!b[4];
  const left = a[4].split('.'),
    right = b[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i],
      y = right[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return y === undefined;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return yn;
    return x > y;
  }
  return true;
}
export function hy2FeatureReason(
  core: string,
  version: string,
  feature: 'base' | 'hop-ports' | 'gecko' | 'bbr-profile',
): string {
  if (core === 'sing-box' && feature === 'base') return '';
  const minimum =
    core === 'sing-box'
      ? feature === 'hop-ports'
        ? '1.11.0'
        : '1.14.0'
      : core === 'xray'
        ? feature === 'gecko'
          ? '26.6.1'
          : feature === 'bbr-profile'
            ? '26.4.13'
            : '26.3.27'
        : '';
  if (!minimum) return '请先选择机器上报的兼容内核。';
  const label = {
    base: 'Hysteria2',
    'hop-ports': '端口跳跃',
    gecko: 'Gecko 混淆',
    'bbr-profile': 'BBR 档位',
  }[feature];
  return versionAtLeast(version, minimum)
    ? ''
    : `${label} 需要 ${core} ≥ ${minimum}；当前版本：${version || '未知'}。`;
}
export function nodeCoreAvailability(snapshot: MachineSnapshot, profile: string, core: string) {
  const reported = snapshot.capabilities.profiles.find((item) => item.id === profile);
  if (!reported) return { available: false, reason: '机器未上报此协议配置。', action: null };
  if (!reported.cores.some((item) => item === core))
    return { available: false, reason: '机器未上报此协议与内核的兼容能力。', action: null };
  const state = snapshot.cores.find((item) => item.core === core);
  const action = !state?.installed ? ('core.install' as const) : ('core.update' as const);
  const reason = !state?.installed
    ? `${core} 尚未安装。`
    : profile === 'hysteria2'
      ? hy2FeatureReason(core, state.version, 'base')
      : '';
  return {
    available: !reason,
    reason,
    action: reason && snapshot.capabilities.actions.includes(action) ? action : null,
  };
}
export function preferredNodeCore(snapshot: MachineSnapshot, profile: string): NodeCore | '' {
  const supported = snapshot.capabilities.profiles.find((item) => item.id === profile)?.cores || [];
  const preference: NodeCore[] =
    profile === 'vless-reality-vision' ? ['xray', 'sing-box'] : ['sing-box', 'xray'];
  const choices = preference.filter((core) => supported.includes(core));
  return (
    choices.find((core) => nodeCoreAvailability(snapshot, profile, core).available) ||
    choices[0] ||
    ''
  );
}

function validIp(value: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value))
    return value.split('.').every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  if (!value.includes(':') || !/^[\da-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}
export function validNodeAddress(value: string): boolean {
  if (!value || value.length > 253) return false;
  if (validIp(value)) return true;
  if (/^[\d.]+$/.test(value)) return false;
  return value.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}
export function uniqueReportedAddress(addresses: string[]): string {
  const valid = [...new Set(addresses.map((value) => value.trim()).filter(validNodeAddress))];
  return valid.length === 1 ? valid[0] : '';
}
function inPorts(port: number, value: unknown): boolean {
  if (typeof value === 'number') return value === port;
  if (typeof value !== 'string') return false;
  return value.split(',').some((part) => {
    if (!/^\d+(?:-\d+)?$/.test(part)) return false;
    const [start, end = start] = part.split('-').map(Number);
    return start <= port && port <= end;
  });
}
export function nodePortOccupied(snapshot: MachineSnapshot, port: number): boolean {
  return (
    snapshot.nodes.some((node) => {
      const options =
        node.options && typeof node.options === 'object'
          ? (node.options as Record<string, unknown>)
          : {};
      const nodeTls =
        node.tls && typeof node.tls === 'object' ? (node.tls as Record<string, unknown>) : {};
      const guard =
        nodeTls.reality_guard && typeof nodeTls.reality_guard === 'object'
          ? (nodeTls.reality_guard as Record<string, unknown>)
          : {};
      return (
        inPorts(port, node.port) ||
        inPorts(port, options.hop_ports) ||
        inPorts(port, guard.listen_port)
      );
    }) ||
    snapshot.relay.forwards.some((forward) => {
      const start = Number(forward.listen_port_start),
        end = Number(forward.listen_port_end ?? forward.listen_port_start);
      return (
        (Number.isInteger(start) && Number.isInteger(end) && start <= port && port <= end) ||
        inPorts(port, forward.listen_ports)
      );
    })
  );
}
export function suggestedNodePort(snapshot: MachineSnapshot): string {
  return [443, 8443, 9443].find((port) => !nodePortOccupied(snapshot, port))?.toString() || '';
}
export function newNodeDraft(
  snapshot: MachineSnapshot,
  addresses: string[],
  profile: string,
): NodeCreateDraft {
  const port = suggestedNodePort(snapshot),
    address = uniqueReportedAddress(addresses);
  return {
    explicit: {},
    installDeps: true,
    values: {
      profile,
      core: preferredNodeCore(snapshot, profile),
      name: port ? `${profile}-${port}` : '',
      port,
      address,
      'address-mode': address ? 'reported' : 'auto',
      listen: '::',
      'ip-strategy': 'auto',
      sni: 'www.amd.com',
      'reality-anti-relay': 'on',
      'cert-mode': 'self-signed',
      'cert-file': '',
      'key-file': '',
      'cert-id': '',
      'path-mode': 'auto',
      path: '',
      'service-mode': 'auto',
      'service-name': '',
      'xhttp-mode': profile === 'vless-xhttp-tls' ? 'auto' : 'stream-one',
      host: '',
      obfs: 'none',
      'up-mbps': '10000',
      'down-mbps': '10000',
      'hop-mode': 'off',
      'hop-ports': '',
      'bbr-profile': 'default',
      'congestion-control': 'bbr',
    },
  };
}
export function setNodeDraftValue(draft: NodeCreateDraft, key: string, value: string): void {
  draft.values[key] = value;
  draft.explicit[key] = true;
  if (key === 'port' && !draft.explicit.name)
    draft.values.name = value ? `${draft.values.profile}-${value}` : '';
  if (key === 'address') draft.values['address-mode'] = 'manual';
}
export function adoptNodeDraft(draft: NodeCreateDraft, snapshot: MachineSnapshot): void {
  if (!draft.explicit.core) draft.values.core = preferredNodeCore(snapshot, draft.values.profile);
}
export function carryNodeCommonDraft(from: NodeCreateDraft, to: NodeCreateDraft): void {
  for (const key of ['name', 'port', 'address', 'address-mode', 'listen', 'ip-strategy']) {
    to.values[key] = from.values[key];
    to.explicit[key] = !!from.explicit[key];
  }
  if (!to.explicit.name)
    to.values.name = to.values.port ? `${to.values.profile}-${to.values.port}` : '';
  to.installDeps = from.installDeps;
}

const options = (...values: string[]) => values.map((value) => ({ value, label: value }));
export function nodeCreateFields(snapshot: MachineSnapshot, draft: NodeCreateDraft): CreateField[] {
  const v = draft.values,
    template = nodeTemplate(v.profile);
  const core = snapshot.cores.find((item) => item.core === v.core);
  const feature = (name: 'hop-ports' | 'gecko' | 'bbr-profile') =>
    hy2FeatureReason(v.core, core?.version || '', name);
  const fields: CreateField[] = [
    { key: 'name', label: '节点名称', required: true, full: true, section: 'basic' },
    {
      key: 'core',
      label: '内核',
      required: true,
      section: 'basic',
      options: (snapshot.capabilities.profiles.find((p) => p.id === v.profile)?.cores || []).map(
        (value) => ({ value, label: value }),
      ),
    },
    {
      key: 'port',
      label: '监听端口',
      number: true,
      required: true,
      section: 'basic',
      hint: '优先建议未在快照中占用的 443、8443、9443；机器会最终检查实际端口占用。',
    },
    {
      key: 'address-mode',
      label: '连接地址来源',
      section: 'basic',
      options: [
        ...(v.address && v['address-mode'] === 'reported'
          ? [{ value: 'reported', label: '沿用机器地址' }]
          : []),
        { value: 'auto', label: '机器自动探测' },
        { value: 'manual', label: '手动输入' },
      ],
      hint: '上报地址或自动探测结果不代表已确认公网可达。',
    },
  ];
  if (v['address-mode'] !== 'auto')
    fields.push({
      key: 'address',
      label: '客户端连接地址',
      required: true,
      section: 'basic',
      hint: '客户端实际访问的 IP 或域名，不带协议、端口或路径。',
    });
  if (template.sni)
    fields.push({
      key: 'sni',
      label: 'SNI',
      required: true,
      section: 'tls',
      hint: template.reality
        ? 'REALITY 必须使用有效 DNS 域名，不能填写 IP、URL 或端口。'
        : '证书服务器名称 / 握手目标。',
    });
  if (template.reality)
    fields.push({
      key: 'reality-anti-relay',
      label: 'REALITY 防偷',
      section: 'tls',
      options: [
        { value: 'on', label: '开启' },
        { value: 'off', label: '关闭' },
      ],
    });
  if (template.tls) {
    fields.push({
      key: 'cert-mode',
      label: '证书模式',
      section: 'tls',
      options: [
        { value: 'self-signed', label: '自签名证书' },
        { value: 'imported', label: '导入现有证书' },
        { value: 'managed', label: '托管证书' },
      ],
    });
    if (v['cert-mode'] === 'imported')
      fields.push(
        {
          key: 'cert-file',
          label: '机器上的证书文件路径',
          required: true,
          full: true,
          section: 'tls',
          placeholder: '/etc/ssl/example/fullchain.pem',
        },
        {
          key: 'key-file',
          label: '机器上的私钥文件路径',
          required: true,
          full: true,
          section: 'tls',
          placeholder: '/etc/ssl/example/privkey.pem',
        },
      );
    if (v['cert-mode'] === 'managed')
      fields.push({
        key: 'cert-id',
        label: '托管证书 ID',
        required: true,
        full: true,
        section: 'tls',
        placeholder: 'crt-0123456789abcdef',
        hint: '填写该机器 security tls 已管理的证书 ID。',
      });
  }
  if (['ws', 'xhttp'].includes(template.transport)) {
    fields.push({
      key: 'path-mode',
      label: '传输路径来源',
      section: 'transport',
      options: [
        { value: 'auto', label: '机器随机生成' },
        { value: 'manual', label: '手动输入' },
      ],
    });
    if (v['path-mode'] === 'manual')
      fields.push({
        key: 'path',
        label: '传输路径',
        required: true,
        section: 'transport',
        hint: '以 / 开头，最多 256 字符。',
      });
  }
  if (template.transport === 'grpc') {
    fields.push({
      key: 'service-mode',
      label: 'gRPC 服务名称来源',
      section: 'transport',
      options: [
        { value: 'auto', label: '机器随机生成' },
        { value: 'manual', label: '手动输入' },
      ],
    });
    if (v['service-mode'] === 'manual')
      fields.push({
        key: 'service-name',
        label: 'gRPC 服务名称',
        required: true,
        section: 'transport',
      });
  }
  if (template.transport === 'xhttp')
    fields.push(
      {
        key: 'xhttp-mode',
        label: 'XHTTP 模式',
        section: 'transport',
        options: options('auto', 'packet-up', 'stream-up', 'stream-one'),
      },
      {
        key: 'host',
        label: '传输 Host',
        section: 'transport',
        placeholder: '未指定',
        hint: '可留空；与 SNI 独立。',
      },
    );
  if (v.profile === 'hysteria2')
    fields.push(
      {
        key: 'up-mbps',
        label: '上行带宽（Mbps）',
        required: true,
        number: true,
        section: 'performance',
        hint: '配置默认值，非实测带宽。',
      },
      {
        key: 'down-mbps',
        label: '下行带宽（Mbps）',
        required: true,
        number: true,
        section: 'performance',
        hint: '配置默认值，非实测带宽。',
      },
      {
        key: 'obfs',
        label: '混淆方式',
        section: 'performance',
        options: [
          { value: 'none', label: '无混淆' },
          { value: 'salamander', label: 'Salamander' },
          { value: 'gecko', label: 'Gecko', reason: feature('gecko') },
        ],
      },
      {
        key: 'bbr-profile',
        label: 'BBR 档位',
        section: 'performance',
        hint: '仅在协商使用 BBR 时生效，不替代带宽设置。',
        options: options('default', 'standard', 'conservative', 'aggressive').map((o) => ({
          ...o,
          label: o.value === 'default' ? '内核默认' : o.label,
          reason: o.value === 'default' ? '' : feature('bbr-profile'),
        })),
      },
      {
        key: 'hop-mode',
        label: 'UDP 端口跳跃',
        section: 'network',
        options: [
          { value: 'off', label: '关闭' },
          { value: 'on', label: '开启', reason: feature('hop-ports') },
        ],
      },
      ...(v['hop-mode'] === 'on'
        ? [
            {
              key: 'hop-ports',
              label: '跳跃端口',
              required: true,
              section: 'network' as const,
              hint: '例如 20000-20100,21000；仅影响当前节点的 UDP 端口。',
            },
          ]
        : []),
    );
  if (v.profile === 'tuic-v5')
    fields.push({
      key: 'congestion-control',
      label: 'TUIC 拥塞控制',
      section: 'performance',
      options: options('bbr', 'cubic', 'new_reno'),
    });
  fields.push(
    {
      key: 'listen',
      label: '监听地址',
      required: true,
      section: 'network',
      hint: ':: 表示 IPv4＋IPv6；0.0.0.0 表示仅 IPv4。',
    },
    {
      key: 'ip-strategy',
      label: '出站 IP 策略',
      section: 'network',
      options: [
        { value: 'auto', label: '自动' },
        { value: 'prefer_ipv4', label: '优先 IPv4' },
        { value: 'prefer_ipv6', label: '优先 IPv6' },
        { value: 'ipv4_only', label: '仅 IPv4' },
        { value: 'ipv6_only', label: '仅 IPv6' },
      ],
    },
  );
  return fields;
}

export function nodeCreateParams(
  snapshot: MachineSnapshot,
  draft: NodeCreateDraft,
): NodeCreateParams {
  const v = draft.values,
    template = nodeTemplate(v.profile);
  if (!snapshot.capabilities.actions.includes('node.add'))
    throw new Error('机器未上报创建节点能力。');
  const availability = nodeCoreAvailability(snapshot, v.profile, v.core);
  if (!availability.available) throw new Error(availability.reason);
  const fields = nodeCreateFields(snapshot, draft);
  const params: NodeCreateParams = { profile: v.profile };
  for (const field of fields) {
    const value = (v[field.key] || '').trim();
    if (field.required && !value) throw new Error(`请填写${field.label}。`);
    if (field.options) {
      const option = field.options.find((item) => item.value === value);
      if (!option) throw new Error(`${field.label}选项无效。`);
      if (option.reason) throw new Error(option.reason);
    }
    if (
      field.key.endsWith('-mode') &&
      ['address-mode', 'path-mode', 'service-mode', 'hop-mode'].includes(field.key)
    )
      continue;
    if (!value) continue;
    if (
      field.number &&
      (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    )
      throw new Error(`${field.label}必须是正整数。`);
    params[field.key] = field.number ? Number(value) : value;
  }
  if (Number(v.port) > 65535) throw new Error('监听端口必须在 1–65535 之间。');
  if ([...v.name.trim()].length > 128 || /[\r\n]/.test(v.name))
    throw new Error('节点名称不能换行且最多 128 个字符。');
  if (snapshot.nodes.some((node) => node.name === v.name.trim()))
    throw new Error('机器上已有同名节点，请更换节点名称。');
  if (nodePortOccupied(snapshot, Number(v.port)))
    throw new Error('监听端口已被上报节点或转发占用，请选择其他端口；机器仍会最终检查实际占用。');
  if (params.address && !validNodeAddress(String(params.address)))
    throw new Error('客户端连接地址应为有效 IP 或域名。');
  if (!validIp(v.listen.trim())) throw new Error('监听地址必须为 IPv4 或 IPv6 地址。');
  if (template.sni && !validNodeAddress(v.sni.trim())) throw new Error('SNI 应为有效 IP 或域名。');
  if (template.reality && (!v.sni.includes('.') || validIp(v.sni) || !validNodeAddress(v.sni)))
    throw new Error('REALITY 需要有效 DNS 域名作为 SNI，不能使用 IP、通配符、URL 或端口。');
  if (
    template.tls &&
    v['cert-mode'] === 'imported' &&
    (!v['cert-file'].startsWith('/') || !v['key-file'].startsWith('/'))
  )
    throw new Error('证书与私钥必须填写机器上的绝对路径。');
  if (template.tls && v['cert-mode'] === 'managed' && !/^crt-[0-9a-f]{16}$/.test(v['cert-id']))
    throw new Error('托管证书 ID 格式应为 crt- 加 16 位小写十六进制字符。');
  if (
    params.path &&
    (!String(params.path).startsWith('/') ||
      String(params.path).length > 256 ||
      /[\r\n]/.test(String(params.path)))
  )
    throw new Error('传输路径必须以 / 开头，且不超过 256 字符。');
  if (params['service-name'] && !/^[A-Za-z0-9._/-]{1,128}$/.test(String(params['service-name'])))
    throw new Error('gRPC 服务名称仅支持字母、数字、点、下划线、斜线和连字符，最多 128 字符。');
  if (params.host && !validNodeAddress(String(params.host)))
    throw new Error('传输 Host 应为有效 IP 或域名。');
  if (v.profile === 'hysteria2') {
    if (v['hop-mode'] === 'off') params['hop-ports'] = 'off';
    else if (
      !/^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/.test(v['hop-ports']) ||
      v['hop-ports'].split(',').some((part) => {
        const [start, end = start] = part.split('-').map(Number);
        return start < 1 || end > 65535 || end < start;
      })
    )
      throw new Error('跳跃端口需要 1–65535 的端口或递增范围，以逗号分隔。');
  }
  if (draft.installDeps) params['install-deps'] = true;
  return params;
}
