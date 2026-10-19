import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adoptNodeDraft,
  carryNodeCommonDraft,
  hy2FeatureReason,
  initialNodeProfile,
  newNodeDraft,
  nodeCoreAvailability,
  nodeCreateFields,
  nodeCreateParams,
  nodeTemplate,
  preferredNodeCore,
  setNodeDraftValue,
  suggestedNodePort,
  uniqueReportedAddress,
  versionAtLeast,
} from '../web/machineNodeTemplates.ts';

const vision = 'vless-reality-vision';
function snapshot() {
  return {
    schemaVersion: 1,
    revision: 'a'.repeat(64),
    vpsctlVersion: '0.8.15',
    capabilities: {
      actions: ['node.add', 'core.install', 'core.update'],
      profiles: [
        vision,
        'hysteria2',
        'vless-ws-tls',
        'vless-grpc-tls',
        'vless-grpc-reality',
        'vless-xhttp-tls',
        'vless-xhttp-reality',
        'trojan-xhttp-reality',
        'tuic-v5',
        'shadowsocks-2022-shadowtls',
        'shadowsocks-aes-256-gcm',
        'anytls-tls',
        'future-profile',
      ].map((id) => ({ id, label: id, cores: ['sing-box', 'xray'] })),
    },
    cores: [
      {
        core: 'sing-box',
        installed: true,
        running: true,
        enabled: true,
        pending_restart: false,
        version: '1.14.0',
      },
      {
        core: 'xray',
        installed: true,
        running: true,
        enabled: true,
        pending_restart: false,
        version: '26.6.1',
      },
    ],
    nodes: [],
    relay: { exits: [], bindings: [], forwards: [] },
    exports: [],
    pendingCores: [],
  };
}
function values(draft, changes) {
  for (const [key, value] of Object.entries(changes)) setNodeDraftValue(draft, key, value);
  return draft;
}

test('reported Vision default has concrete values and submits no generated secrets or irrelevant fields', () => {
  const state = snapshot();
  assert.equal(initialNodeProfile(state), vision);
  const draft = newNodeDraft(state, ['203.0.113.20', '203.0.113.20'], vision);
  assert.deepEqual(nodeCreateParams(state, draft), {
    profile: vision,
    name: vision + '-443',
    core: 'xray',
    port: 443,
    address: '203.0.113.20',
    sni: 'www.amd.com',
    'reality-anti-relay': 'on',
    listen: '::',
    'ip-strategy': 'auto',
    'install-deps': true,
  });
  assert.equal(nodeTemplate(vision).tls, false);
  assert.equal(
    nodeCreateFields(state, draft).some((field) => field.key.startsWith('cert-')),
    false,
  );
  values(draft, { port: '8443' });
  assert.equal(draft.values.name, vision + '-8443');
  values(draft, { name: '自定义节点', port: '9443' });
  assert.equal(draft.values.name, '自定义节点');
});

test('only reported protocol/core combinations are selected; installed compatible preferences are honored', () => {
  const state = snapshot();
  assert.equal(preferredNodeCore(state, vision), 'xray');
  assert.equal(preferredNodeCore(state, 'hysteria2'), 'sing-box');
  state.cores[1].installed = false;
  assert.equal(preferredNodeCore(state, vision), 'sing-box');
  assert.equal(nodeCoreAvailability(state, vision, 'xray').action, 'core.install');
  state.cores[0].installed = false;
  state.cores[1].installed = true;
  state.cores[1].version = '26.3.27';
  assert.equal(preferredNodeCore(state, 'hysteria2'), 'xray');
  state.cores[1].version = '26.3.26';
  assert.equal(preferredNodeCore(state, 'hysteria2'), 'sing-box');
  assert.equal(nodeCoreAvailability(state, 'hysteria2', 'xray').action, 'core.update');
  state.capabilities.actions = ['node.add'];
  assert.equal(nodeCoreAvailability(state, 'hysteria2', 'xray').action, null);
  state.capabilities.profiles = [{ id: 'future-profile', label: 'Future', cores: ['sing-box'] }];
  assert.equal(initialNodeProfile(state), 'future-profile');
  assert.equal(preferredNodeCore(state, vision), '');
  assert.equal(nodeCoreAvailability(state, 'future-profile', 'xray').available, false);
});

test('version gates compare semantic versions, v prefix, prereleases, and missing/invalid versions', () => {
  assert.equal(versionAtLeast('v1.14.0+local', '1.14.0'), true);
  assert.equal(versionAtLeast('1.14.0-rc.2', '1.14.0'), false);
  assert.equal(versionAtLeast('1.14.0-rc.10', '1.14.0-rc.2'), true);
  assert.equal(versionAtLeast('1.14.0-rc.2', '1.14.0-rc.10'), false);
  assert.equal(versionAtLeast('26.10.1', '26.6.1'), true);
  assert.equal(versionAtLeast('unknown', '1.14.0'), false);
  assert.equal(hy2FeatureReason('sing-box', '', 'base'), '');
  for (const [core, feature, minimum, older] of [
    ['sing-box', 'hop-ports', '1.11.0', '1.10.9'],
    ['sing-box', 'gecko', '1.14.0', '1.13.9'],
    ['sing-box', 'bbr-profile', '1.14.0', '1.13.9'],
    ['xray', 'base', '26.3.27', '26.3.26'],
    ['xray', 'hop-ports', '26.3.27', '26.3.26'],
    ['xray', 'bbr-profile', '26.4.13', '26.4.12'],
    ['xray', 'gecko', '26.6.1', '26.5.31'],
  ]) {
    assert.equal(hy2FeatureReason(core, minimum, feature), '');
    assert.ok(hy2FeatureReason(core, older, feature).includes(minimum));
    assert.ok(hy2FeatureReason(core, '', feature).includes('未知'));
    assert.ok(hy2FeatureReason(core, minimum + '-rc.1', feature).includes(minimum));
  }
});

test('port suggestion avoids visible node, guard, hop and forwarding occupancy without inventing availability', () => {
  const state = snapshot();
  state.nodes = [{ id: 'n', name: 'existing', core: 'xray', profile: vision, port: 443 }];
  state.relay.forwards = [{ listen_port_start: 8000, listen_port_end: 9000 }];
  assert.equal(suggestedNodePort(state), '9443');
  state.nodes[0].options = { hop_ports: '9400-9450' };
  assert.equal(suggestedNodePort(state), '');
  const draft = newNodeDraft(state, [], vision);
  assert.throws(() => nodeCreateParams(state, draft), /请填写节点名称/);
  values(draft, { name: 'valid', port: '443' });
  assert.throws(() => nodeCreateParams(state, draft), /已被上报节点或转发占用/);
  state.nodes[0].port = 12345;
  state.nodes[0].tls = { reality_guard: { listen_port: 443 } };
  assert.equal(suggestedNodePort(state), '');
});

test('only one valid distinct reported address is prefilled; automatic address is omitted', () => {
  assert.equal(
    uniqueReportedAddress(['', '[已隐藏]', '203.0.113.20', '203.0.113.20']),
    '203.0.113.20',
  );
  assert.equal(uniqueReportedAddress(['203.0.113.20', '2001:db8::1']), '');
  assert.equal(
    uniqueReportedAddress(['https://example.test/a', 'example.test:443', '999.1.1.1']),
    '',
  );
  assert.equal(uniqueReportedAddress(['2001:db8::1']), '2001:db8::1');
  const state = snapshot(),
    draft = newNodeDraft(state, [], vision);
  assert.equal(draft.values['address-mode'], 'auto');
  assert.equal('address' in nodeCreateParams(state, draft), false);
  values(draft, { 'address-mode': 'manual', address: 'node.example.test' });
  assert.equal(nodeCreateParams(state, draft).address, 'node.example.test');
  values(draft, { 'address-mode': 'auto' });
  assert.equal('address' in nodeCreateParams(state, draft), false);
  values(draft, { 'address-mode': 'manual' });
  assert.equal(nodeCreateParams(state, draft).address, 'node.example.test');
});

test('TLS certificate modes validate conditional fields and never submit hidden certificate inputs', () => {
  const state = snapshot(),
    draft = newNodeDraft(state, [], 'vless-ws-tls');
  assert.equal(nodeCreateParams(state, draft)['cert-mode'], 'self-signed');
  values(draft, { 'cert-mode': 'imported' });
  assert.throws(() => nodeCreateParams(state, draft), /证书文件路径/);
  values(draft, { 'cert-file': 'local.pem', 'key-file': '/etc/key.pem' });
  assert.throws(() => nodeCreateParams(state, draft), /绝对路径/);
  values(draft, { 'cert-file': '/etc/cert.pem' });
  assert.equal(nodeCreateParams(state, draft)['key-file'], '/etc/key.pem');
  values(draft, { 'cert-mode': 'managed', 'cert-id': 'crt-invalid' });
  assert.throws(() => nodeCreateParams(state, draft), /托管证书 ID/);
  values(draft, { 'cert-id': 'crt-0123456789abcdef' });
  const managed = nodeCreateParams(state, draft);
  assert.equal(managed['cert-id'], 'crt-0123456789abcdef');
  assert.equal('key-file' in managed, false);
  values(draft, { 'cert-mode': 'self-signed' });
  assert.equal('cert-id' in nodeCreateParams(state, draft), false);
  values(draft, { 'cert-mode': 'imported' });
  assert.equal(nodeCreateParams(state, draft)['cert-file'], '/etc/cert.pem');
});

test('random transport modes retain manual drafts while omitting their inactive values', () => {
  const state = snapshot();
  for (const profile of [
    'vless-ws-tls',
    'vless-xhttp-tls',
    'vless-xhttp-reality',
    'trojan-xhttp-reality',
  ]) {
    const draft = newNodeDraft(state, [], profile);
    assert.equal('path' in nodeCreateParams(state, draft), false);
    if (profile.includes('xhttp'))
      assert.equal(
        nodeCreateParams(state, draft)['xhttp-mode'],
        profile === 'vless-xhttp-tls' ? 'auto' : 'stream-one',
      );
    assert.equal('host' in nodeCreateParams(state, draft), false);
    values(draft, { 'path-mode': 'manual', path: '/custom/path' });
    assert.equal(nodeCreateParams(state, draft).path, '/custom/path');
    values(draft, { 'path-mode': 'auto' });
    assert.equal('path' in nodeCreateParams(state, draft), false);
    values(draft, { 'path-mode': 'manual' });
    assert.equal(nodeCreateParams(state, draft).path, '/custom/path');
  }
  const grpc = newNodeDraft(state, [], 'vless-grpc-reality');
  assert.equal('service-name' in nodeCreateParams(state, grpc), false);
  values(grpc, { 'service-mode': 'manual', 'service-name': 'manual-service' });
  assert.equal(nodeCreateParams(state, grpc)['service-name'], 'manual-service');
  values(grpc, { 'service-mode': 'auto' });
  assert.equal('service-name' in nodeCreateParams(state, grpc), false);
  assert.equal(grpc.values['service-name'], 'manual-service');
});

test('HY2 gates advanced features but still allows safe defaults on old sing-box; TUIC remains independent', () => {
  const state = snapshot();
  state.cores[0].version = '1.10.0';
  const draft = newNodeDraft(state, [], 'hysteria2');
  const params = nodeCreateParams(state, draft);
  assert.equal(params['up-mbps'], 10000);
  assert.equal(params['down-mbps'], 10000);
  assert.equal(params.obfs, 'none');
  assert.equal(params['hop-ports'], 'off');
  assert.equal(params['bbr-profile'], 'default');
  assert.equal('congestion-control' in params, false);
  values(draft, { obfs: 'gecko' });
  assert.throws(() => nodeCreateParams(state, draft), /Gecko.*1.14.0/);
  values(draft, { obfs: 'none', 'bbr-profile': 'aggressive' });
  assert.throws(() => nodeCreateParams(state, draft), /BBR.*1.14.0/);
  values(draft, { 'bbr-profile': 'default', 'hop-mode': 'on', 'hop-ports': '20000-20100' });
  assert.throws(() => nodeCreateParams(state, draft), /端口跳跃.*1.11.0/);
  state.cores[0].version = '1.14.0';
  assert.equal(nodeCreateParams(state, draft)['hop-ports'], '20000-20100');
  values(draft, { 'hop-ports': '20100-20000' });
  assert.throws(() => nodeCreateParams(state, draft), /递增范围/);
  values(draft, { 'hop-mode': 'off' });
  assert.equal(nodeCreateParams(state, draft)['hop-ports'], 'off');
  assert.equal(draft.values['hop-ports'], '20100-20000');
  const tuic = nodeCreateParams(state, newNodeDraft(state, [], 'tuic-v5'));
  assert.equal(tuic['congestion-control'], 'bbr');
  assert.equal('bbr-profile' in tuic, false);
});

test('switching carries common inputs, preserves protocol drafts, and adoption respects manual core choices', () => {
  const state = snapshot(),
    drafts = {
      [vision]: newNodeDraft(state, ['203.0.113.20'], vision),
      hysteria2: newNodeDraft(state, ['203.0.113.20'], 'hysteria2'),
    };
  values(drafts[vision], {
    name: 'manual',
    port: '12345',
    address: 'manual.example.test',
    sni: 'sni.example.test',
    core: 'sing-box',
  });
  values(drafts.hysteria2, { 'up-mbps': '123' });
  carryNodeCommonDraft(drafts[vision], drafts.hysteria2);
  assert.equal(drafts.hysteria2.values.name, 'manual');
  assert.equal(drafts.hysteria2.values.port, '12345');
  assert.equal(drafts.hysteria2.values.address, 'manual.example.test');
  assert.equal(drafts.hysteria2.values.sni, 'www.amd.com');
  assert.equal(drafts.hysteria2.values['up-mbps'], '123');
  const before = structuredClone(drafts[vision]);
  state.cores[1].installed = false;
  adoptNodeDraft(drafts[vision], state);
  assert.deepEqual(drafts[vision], before);
  drafts.hysteria2 = newNodeDraft(state, [], 'hysteria2');
  assert.deepEqual(drafts[vision], before);
  const autoCore = newNodeDraft(state, [], vision);
  assert.equal(autoCore.values.core, 'sing-box');
  state.cores[1].installed = true;
  adoptNodeDraft(autoCore, state);
  assert.equal(autoCore.values.core, 'xray');
  assert.equal(autoCore.values.port, '443');
  carryNodeCommonDraft(autoCore, drafts.hysteria2);
  assert.equal(drafts.hysteria2.values.name, 'hysteria2-443');
  assert.equal(drafts.hysteria2.values.port, '443');
});

test('ShadowTLS has SNI but no certificate; unknown profiles submit common fields only', () => {
  const state = snapshot(),
    shadow = newNodeDraft(state, [], 'shadowsocks-2022-shadowtls');
  assert.equal(nodeCreateParams(state, shadow).sni, 'www.amd.com');
  assert.equal('cert-mode' in nodeCreateParams(state, shadow), false);
  const unknown = newNodeDraft(state, [], 'future-profile');
  assert.equal(nodeTemplate('future-profile').known, false);
  assert.deepEqual(
    Object.keys(nodeCreateParams(state, unknown)).sort(),
    ['profile', 'name', 'core', 'port', 'listen', 'ip-strategy', 'install-deps'].sort(),
  );
  const bad = newNodeDraft(state, [], vision);
  values(bad, { sni: '203.0.113.1' });
  assert.throws(() => nodeCreateParams(state, bad), /DNS 域名/);
  values(bad, { 'reality-anti-relay': 'off' });
  assert.throws(() => nodeCreateParams(state, bad), /DNS 域名/);
  values(bad, { sni: 'valid.example.test', name: 'x'.repeat(129) });
  assert.throws(() => nodeCreateParams(state, bad), /128/);
  values(bad, { name: 'duplicate' });
  state.nodes.push({ id: 'one', name: 'duplicate', core: 'xray', profile: vision, port: 12443 });
  assert.throws(() => nodeCreateParams(state, bad), /同名/);
});
