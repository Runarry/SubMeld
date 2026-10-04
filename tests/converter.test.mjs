import assert from 'node:assert/strict';
import { test } from 'node:test';
import { produceInput } from '../dist/server/converter/engine.js';
import { hysteriaUri } from '../dist/server/converter/hysteria2.js';
import { toUpstream } from '../dist/server/converter/model.js';
import { checkedDraft } from '../dist/server/converter/normalized.js';
import { SubStoreClient } from '../dist/server/sub-store.js';
import { MAX_BYTES } from '../dist/server/shared/contracts.js';
import { node, items, UUID, TEST_PASSWORD } from './fixtures.mjs';

test('HY2 mport and multi-port authorities retain port hopping and certificate pins through URI and Base64', async () => {
  const pin = 'ab'.repeat(32);
  const client = new SubStoreClient();
  for (const authority of [
    '[2001:db8::1]:20120?mport=20120-20200&',
    '[2001:db8::1]:20120-20200?',
  ]) {
    for (const scheme of ['hysteria2', 'hy2']) {
      const text =
        scheme +
        '://test-only@' +
        authority +
        'sni=example.com&insecure=1&pinSHA256=' +
        pin +
        '#HY2';
      const raw = await client.convert(hysteriaUri(text), 'JSON', true);
      assert.equal(raw.length, 1);
      const draft = checkedDraft(raw[0]);
      assert.equal(draft.port, 20120);
      assert.equal(draft.protocolOptions.ports, '20120-20200');
      assert.equal(draft.protocolOptions.pinSHA256, pin);
      const output = await produceInput({ items: items(draft) });
      const url = new URL(output.uri);
      assert.equal(url.searchParams.get('mport'), '20120-20200');
      assert.equal(url.searchParams.get('pinSHA256'), pin);
      assert.equal(Buffer.from(output.base64, 'base64').toString('utf8'), output.uri);
    }
  }
});

test('HY2 malformed hopping and certificate pins are rejected before enhanced output', () => {
  const raw = toUpstream(node('hysteria2'));
  for (const patch of [
    { ports: '0-20' },
    { ports: '20120-65536' },
    { ports: '20200-20120' },
    { ports: '20120,,20121' },
    { 'tls-fingerprint': 'not-a-sha256' },
    { 'tls-fingerprint': 'ab'.repeat(32), fingerprint: 'cd'.repeat(32) },
    { ports: '20120-20200', 'hop-interval': 0 },
    { 'hop-interval': 10 },
  ]) {
    assert.throws(() => checkedDraft({ ...raw, ...patch }), { code: 'TARGET_UNSUPPORTED' });
  }
  assert.throws(
    () => hysteriaUri('hy2://test-only@example.com:20120-20200?mport=30120-30200#HY2'),
    /Conflicting Hysteria2 ports/,
  );
});
for (const protocol of ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic']) {
  for (const transport of ['vmess', 'vless', 'trojan'].includes(protocol)
    ? ['tcp', 'ws', 'grpc']
    : ['tcp']) {
    test(
      protocol + '/' + transport + ' preserves edited credentials, IPv6 and connection fields',
      async () => {
        const draft = node(protocol, transport);
        const input = { items: items(draft) };
        const before = structuredClone(input);
        const result = await produceInput(input);
        assert.deepEqual(input, before, 'producer must not mutate draft');
        assert.equal(Buffer.from(result.base64, 'base64').toString('utf8'), result.uri);
        assert.equal((await produceInput(input)).uri, result.uri, 'output must be deterministic');
        assert.equal(result.uri.includes('\n'), false);
        assert.deepEqual(result.counts, { input: 1, output: 1, filtered: 0 });
        if (protocol === 'vmess') {
          const json = JSON.parse(Buffer.from(result.uri.slice(8), 'base64').toString('utf8'));
          assert.equal(json.id, UUID);
          assert.equal(json.ps, draft.name);
          assert.equal(json.add, '2001:db8::1');
          assert.equal(Number(json.port), draft.port);
          assert.equal(json.allowInsecure, 1);
          assert.equal(json.sni, draft.tls.serverName);
          assert.equal(json.alpn, draft.tls.alpn.join(','));
          assert.equal(json.net, transport);
          if (transport === 'ws') {
            assert.equal(json.path, draft.transport.path);
            assert.equal(json.host, draft.transport.host);
          }
          if (transport === 'grpc') assert.equal(json.path, draft.transport.serviceName);
        } else {
          const url = new URL(result.uri);
          assert.equal(url.hostname, '[2001:db8::1]');
          assert.equal(Number(url.port), draft.port);
          assert.equal(decodeURIComponent(url.hash.slice(1)), draft.name);
          if (protocol === 'ss') {
            assert.equal(
              Buffer.from(decodeURIComponent(url.username), 'base64').toString('utf8'),
              draft.protocolOptions.method + ':' + TEST_PASSWORD,
            );
          } else {
            assert.equal(url.searchParams.get('sni'), draft.tls.serverName);
            if (protocol === 'trojan' || protocol === 'hysteria2')
              assert.equal(decodeURIComponent(url.username), TEST_PASSWORD);
            else assert.equal(url.username, UUID);
            if (protocol === 'tuic') assert.equal(decodeURIComponent(url.password), TEST_PASSWORD);
            if (protocol !== 'hysteria2')
              assert.equal(url.searchParams.get('alpn'), draft.tls.alpn.join(','));
            if (transport === 'ws') {
              assert.equal(url.searchParams.get('path'), draft.transport.path);
              assert.equal(url.searchParams.get('host'), draft.transport.host);
            }
            if (transport === 'grpc')
              assert.equal(url.searchParams.get('serviceName'), draft.transport.serviceName);
          }
        }
        draft.name = '修改后的名称';
        if ('password' in draft.auth) draft.auth.password = 'changed-test-password';
        const edited = await produceInput(input);
        assert.notEqual(edited.uri, result.uri);
        assert.equal(Buffer.from(edited.base64, 'base64').toString('utf8'), edited.uri);
        if (protocol === 'vmess') {
          const json = JSON.parse(Buffer.from(edited.uri.slice(8), 'base64').toString('utf8'));
          assert.equal(json.ps, draft.name);
        } else {
          const url = new URL(edited.uri);
          assert.equal(decodeURIComponent(url.hash.slice(1)), draft.name);
          if (protocol === 'ss')
            assert.equal(
              Buffer.from(decodeURIComponent(url.username), 'base64').toString('utf8'),
              draft.protocolOptions.method + ':' + draft.auth.password,
            );
          else if (protocol === 'tuic')
            assert.equal(decodeURIComponent(url.password), draft.auth.password);
          else if ('password' in draft.auth)
            assert.equal(decodeURIComponent(url.username), draft.auth.password);
        }
      },
    );
  }
  test(
    protocol + ' missing credentials blocks output and never silently drops a node',
    async () => {
      const broken = node(protocol);
      if ('uuid' in broken.auth) broken.auth.uuid = '';
      else broken.auth.password = '';
      await assert.rejects(
        async () => await produceInput({ items: items(node('vless'), broken) }),
        (e) => e.code === 'CONVERSION_FAILED' && e.diagnostics.some((d) => d.nodeIndex === 1),
      );
    },
  );
}

test('REALITY public key, leading-zero short ID and flow survive checked native nodes and URI', async () => {
  const draft = checkedDraft({
    ...toUpstream(node('vless')),
    alpn: [],
    'skip-cert-verify': false,
    flow: 'xtls-rprx-vision',
    'reality-opts': { 'public-key': 'A'.repeat(43), 'short-id': '0088' },
  });
  assert.equal(draft.tls.shortId, '0088');
  const result = await produceInput({ items: items(draft) });
  const url = new URL(result.uri);
  assert.equal(url.searchParams.get('security'), 'reality');
  assert.equal(url.searchParams.get('sid'), '0088');
  assert.equal(url.searchParams.get('pbk'), 'A'.repeat(43));
  assert.equal(url.searchParams.get('flow'), 'xtls-rprx-vision');
});

test('invalid nodes block output until explicitly excluded', async () => {
  const valid = node('ss');
  const broken = node('vless');
  broken.auth.uuid = 'bad';
  const batch = items(valid, broken, null);
  await assert.rejects(async () => await produceInput({ items: batch }), {
    code: 'CONVERSION_FAILED',
  });
  batch[1].excluded = true;
  batch[2].excluded = true;
  const result = await produceInput({ items: batch });
  assert.deepEqual(result.counts, { input: 3, output: 1, filtered: 2 });
  assert.equal(result.uri, (await produceInput({ items: items(valid) })).uri);
  batch[0].excluded = true;
  await assert.rejects(async () => await produceInput({ items: batch }), { code: 'EMPTY_OUTPUT' });
  await assert.rejects(async () => await produceInput({ items: [] }), { code: 'EMPTY_OUTPUT' });
});

test('unsupported transports, SS2022 and missing REALITY key are rejected in native nodes', () => {
  for (const patch of [
    { network: 'xhttp' },
    { 'reality-opts': {} },
    { 'packet-encoding': 'packetaddr' },
  ]) {
    assert.throws(() => checkedDraft({ ...toUpstream(node('vless')), ...patch }), {
      code: 'TARGET_UNSUPPORTED',
    });
  }
  assert.throws(
    () => checkedDraft({ ...toUpstream(node('ss')), cipher: '2022-blake3-aes-128-gcm' }),
    { code: 'TARGET_UNSUPPORTED' },
  );
});

test('Base64 has its own output cap while valid URI remains available', async () => {
  const drafts = Array.from({ length: 200 }, () => {
    const d = node('trojan');
    d.auth.password = 'x'.repeat(16000);
    return d;
  });
  const result = await produceInput({ items: items(...drafts) });
  assert.ok(Buffer.byteLength(result.uri) < MAX_BYTES);
  assert.ok(result.base64 === null);
  assert.equal(result.diagnostics.at(-1).code, 'BASE64_OUTPUT_LIMIT');
});

test('malformed native security fields cannot silently become defaults', () => {
  for (const patch of [{ tls: 'invalid' }, { 'skip-cert-verify': 'true' }, { tls: false }]) {
    assert.throws(() => checkedDraft({ ...toUpstream(node('trojan')), ...patch }), {
      code: 'TARGET_UNSUPPORTED',
    });
  }
  assert.throws(() => checkedDraft({ ...toUpstream(node('hysteria2')), obfs: 'unknown' }), {
    code: 'TARGET_UNSUPPORTED',
  });
  assert.throws(
    () => checkedDraft({ ...toUpstream(node('tuic')), 'client-fingerprint': 'chrome' }),
    { code: 'TARGET_UNSUPPORTED' },
  );
});

test('invalid optional native fields cannot silently become defaults', () => {
  for (const patch of [
    { network: 'ws', 'ws-opts': { path: ['/one', '/two'] } },
    {
      network: 'ws',
      'ws-opts': { path: '/one', headers: { Host: ['one.example', 'two.example'] } },
    },
    { network: 'ws', 'ws-opts': ['invalid'] },
    { 'client-fingerprint': { invalid: true } },
    { sni: '' },
  ]) {
    assert.throws(() => checkedDraft({ ...toUpstream(node('vless')), ...patch }), {
      code: 'TARGET_UNSUPPORTED',
    });
  }
});

test('disabled certificate checks are not introduced into verified URI output', async () => {
  for (const protocol of ['vmess', 'vless', 'trojan', 'hysteria2', 'tuic']) {
    const draft = node(protocol);
    draft.tls.insecure = false;
    const result = await produceInput({ items: items(draft) });
    if (protocol === 'vmess') {
      const json = JSON.parse(Buffer.from(result.uri.slice(8), 'base64').toString('utf8'));
      assert.equal(json.allowInsecure, 0);
    } else {
      const url = new URL(result.uri);
      for (const key of ['allowInsecure', 'insecure', 'allow_insecure', 'skip-cert-verify'])
        assert.ok([null, '0', 'false'].includes(url.searchParams.get(key)), protocol + '/' + key);
    }
  }
});
