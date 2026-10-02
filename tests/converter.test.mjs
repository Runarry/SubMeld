import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInput, produceInput } from '../dist/server/converter/engine.js';
import { MAX_BYTES } from '../dist/server/shared/contracts.js';
import { node, items, UUID, TEST_PASSWORD } from './fixtures.mjs';

test('HY2 mport and multi-port authorities retain port hopping and certificate pins through URI and Base64', async () => {
  const pin = 'ab'.repeat(32);
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
      const parsed = await parseInput({ format: 'uri', text });
      assert.equal(parsed.counts.output, 1, JSON.stringify(parsed.items[0].diagnostics));
      const draft = parsed.items[0].draft;
      assert.equal(draft.port, 20120);
      assert.equal(draft.protocolOptions.ports, '20120-20200');
      assert.equal(draft.protocolOptions.pinSHA256, pin);
      const output = await produceInput({ items: parsed.items });
      const url = new URL(output.uri);
      assert.equal(url.searchParams.get('mport'), '20120-20200');
      assert.equal(url.searchParams.get('pinSHA256'), pin);
      assert.deepEqual(
        (await parseInput({ format: 'base64', text: output.base64 })).items[0].draft,
        draft,
      );
    }
  }
});

test('HY2 malformed hopping, conflicting ranges and invalid certificate pins are rejected', async () => {
  for (const parameters of [
    'mport=0-20',
    'mport=20120-65536',
    'mport=20200-20120',
    'mport=20120,,20121',
    'mport=',
    'pinSHA256=not-a-sha256',
    'pinSHA256=',
    'mport=20120-20200&hop-interval=0',
  ]) {
    const parsed = await parseInput({
      format: 'uri',
      text: 'hysteria2://test-only@example.com:20120?' + parameters + '#HY2',
    });
    assert.equal(parsed.counts.output, 0, parameters);
  }
  const conflict = await parseInput({
    format: 'uri',
    text: 'hy2://test-only@example.com:20120-20200?mport=30120-30200#HY2',
  });
  assert.equal(conflict.counts.output, 0);
  const duplicate = await parseInput({
    format: 'uri',
    text: 'hy2://test-only@example.com:20120-20200?mport=20120-20200&mport=30120-30200#HY2',
  });
  assert.equal(duplicate.counts.output, 0);
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
        const parsed = await parseInput({ format: 'uri', text: result.uri });
        assert.equal(parsed.counts.output, 1);
        const roundTrip = parsed.items[0].draft;
        assert.deepEqual(roundTrip.auth, draft.auth);
        assert.equal(roundTrip.name, draft.name);
        assert.equal(roundTrip.server, draft.server);
        assert.equal(roundTrip.tls.insecure, draft.tls.insecure);
        if (draft.tls.mode !== 'none') assert.equal(roundTrip.tls.serverName, draft.tls.serverName);
        if (protocol === 'vmess') {
          const json = JSON.parse(Buffer.from(result.uri.slice(8), 'base64').toString());
          assert.equal(json.id, UUID);
          assert.equal(json.add, '2001:db8::1');
          assert.equal(json.allowInsecure, 1);
          assert.equal(json.net, transport);
          if (transport === 'grpc') assert.equal(json.path, 'test/service');
        } else if (protocol !== 'ss') {
          const url = new URL(result.uri);
          assert.equal(url.hostname, '[2001:db8::1]');
          if (protocol === 'trojan' || protocol === 'hysteria2')
            assert.equal(decodeURIComponent(url.username), TEST_PASSWORD);
          if (transport === 'ws') assert.equal(url.searchParams.get('path'), '/路径?key=%2F&a=1');
        }
        draft.name = '修改后的名称';
        if ('password' in draft.auth) draft.auth.password = 'changed-test-password';
        const edited = await produceInput(input);
        assert.notEqual(edited.uri, result.uri);
        assert.equal(
          (await parseInput({ format: 'base64', text: edited.base64 })).items[0].draft.name,
          '修改后的名称',
        );
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
test('REALITY public key, leading-zero short ID and flow survive YAML and URI', async () => {
  const yaml =
    'proxies:\n  - name: Reality\n    type: vless\n    server: example.com\n    port: 443\n    uuid: ' +
    UUID +
    '\n    tls: true\n    servername: tls.example.com\n    client-fingerprint: chrome\n    flow: xtls-rprx-vision\n    reality-opts:\n      public-key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n      short-id: 0088\n';
  const parsed = await parseInput({ format: 'yaml', text: yaml });
  assert.equal(parsed.items[0].draft?.tls.shortId, '0088');
  const result = await produceInput({ items: parsed.items });
  const url = new URL(result.uri);
  assert.equal(url.searchParams.get('security'), 'reality');
  assert.equal(url.searchParams.get('sid'), '0088');
  assert.equal(url.searchParams.get('pbk'), 'A'.repeat(43));
  assert.equal(url.searchParams.get('flow'), 'xtls-rprx-vision');
});
test('YAML inline nodes and textual credentials are imported without fetching providers', async () => {
  const parsed = await parseInput({
    format: 'auto',
    text: 'proxy-providers:\n  external:\n    url: https://example.com/private\nproxies:\n  - {type: trojan, name: yaml, server: example.com, port: 443, password: 00123}\n',
  });
  assert.equal(parsed.items[0].draft.auth.password, '00123');
  assert.equal(parsed.diagnostics[0].code, 'YAML_METADATA_NOT_IMPORTED');
  assert.match((await produceInput({ items: parsed.items })).uri, /^trojan:\/\/00123@/);
});
test('errors remain visible until explicitly excluded', async () => {
  const uri = (await produceInput({ items: items(node('ss')) })).uri;
  const parsed = await parseInput({
    format: 'uri',
    text: uri + '\nvless://bad@example.com:443?security=tls#bad\nhttps://example.com/private',
  });
  assert.equal(parsed.items.length, 3);
  assert.ok(parsed.items[1].diagnostics.some((d) => d.level === 'error'));
  await assert.rejects(async () => await produceInput({ items: parsed.items }), {
    code: 'CONVERSION_FAILED',
  });
  parsed.items[1].excluded = true;
  parsed.items[2].excluded = true;
  const result = await produceInput({ items: parsed.items });
  assert.deepEqual(result.counts, { input: 3, output: 1, filtered: 2 });
  assert.equal(result.uri, uri);
  parsed.items[0].excluded = true;
  await assert.rejects(async () => await produceInput({ items: parsed.items }), {
    code: 'EMPTY_OUTPUT',
  });
});
test('unknown security, transports, SS2022 and missing REALITY key are rejected', async () => {
  for (const suffix of [
    'security=unknown',
    'type=xhttp',
    'security=reality',
    'security=tls&type=ws&packetEncoding=packetaddr',
  ]) {
    const parsed = await parseInput({
      format: 'uri',
      text: 'vless://' + UUID + '@example.com:443?' + suffix + '#test',
    });
    assert.ok(
      parsed.items[0].diagnostics.some((d) => d.level === 'error'),
      suffix,
    );
    await assert.rejects(async () => await produceInput({ items: parsed.items }));
  }
  const parsed = await parseInput({
    format: 'yaml',
    text: 'proxies: [{type: ss, name: bad, server: example.com, port: 443, cipher: 2022-blake3-aes-128-gcm, password: test}]',
  });
  assert.equal(parsed.counts.output, 0);
});
test('input guards reject nested wrappers, HTML, duplicate parameters, aliases and excessive depth', async () => {
  const uri = (await produceInput({ items: items(node('ss')) })).uri;
  const encoded = Buffer.from(uri).toString('base64url');
  assert.equal((await parseInput({ format: 'base64', text: encoded })).counts.output, 1);
  const double = Buffer.from(encoded).toString('base64');
  assert.equal((await parseInput({ format: 'base64', text: double })).counts.output, 0);
  await assert.rejects(
    async () => await parseInput({ format: 'auto', text: '<html>private page</html>' }),
  );
  await assert.rejects(
    async () => await parseInput({ format: 'yaml', text: 'a: &a [*a]\nproxies: *a' }),
  );
  await assert.rejects(
    async () =>
      await parseInput({ format: 'yaml', text: 'proxies: ' + '['.repeat(35) + ']'.repeat(35) }),
  );
  await assert.rejects(
    async () => await parseInput({ format: 'yaml', text: 'proxies: []\nproxies: []' }),
  );
  const duplicate = await parseInput({
    format: 'uri',
    text: 'vless://' + UUID + '@example.com:443?security=tls&security=none#test',
  });
  assert.equal(duplicate.counts.output, 0);
  await assert.rejects(
    async () => await parseInput({ format: 'uri', text: 'x'.repeat(MAX_BYTES + 1) }),
    {
      status: 413,
    },
  );
  await assert.rejects(
    async () => await parseInput({ format: 'uri', text: Array(2001).fill(uri).join('\n') }),
    {
      status: 413,
    },
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
test('protocol-specific and malformed security inputs cannot be silently normalized away', async () => {
  for (const text of [
    'trojan://test@example.com:443?security=none#bad',
    'hysteria2://test@example.com:443?obfs=unknown#bad',
    'vless://' + UUID + '@example.com:443?security=tls&pbk=' + 'A'.repeat(43) + '#bad',
    'tuic://' + UUID + ':test@example.com:443?fp=chrome#bad',
  ]) {
    const parsed = await parseInput({ format: 'uri', text });
    assert.equal(parsed.counts.output, 0);
  }
  for (const extra of ['tls: invalid', 'skip-cert-verify: "true"', 'tls: false']) {
    assert.equal(
      (
        await parseInput({
          format: 'yaml',
          text:
            'proxies: [{type: trojan, name: bad, server: example.com, port: 443, password: test, ' +
            extra +
            '}]',
        })
      ).counts.output,
      0,
    );
  }
});
test('invalid optional YAML fields cannot silently become defaults', async () => {
  for (const patch of [
    'network: ws, ws-opts: {path: [/one, /two]}',
    'network: ws, ws-opts: {path: /one, headers: {Host: [one.example, two.example]}}',
    'network: ws, ws-opts: [invalid]',
    'client-fingerprint: {invalid: true}',
    'sni: ""',
  ]) {
    const result = await parseInput({
      format: 'yaml',
      text:
        'proxies: [{type: vless, name: bad, server: example.com, port: 443, uuid: ' +
        UUID +
        ', tls: true, ' +
        patch +
        '}]',
    });
    assert.equal(result.counts.output, 0, patch);
  }
});
test('disabled certificate checks are never inferred from false boolean strings', async () => {
  for (const protocol of ['vmess', 'vless', 'trojan', 'hysteria2', 'tuic']) {
    const draft = node(protocol);
    draft.tls.insecure = false;
    const result = await produceInput({ items: items(draft) });
    const parsed = await parseInput({ format: 'uri', text: result.uri });
    assert.equal(parsed.items[0].draft.tls.insecure, false, protocol);
  }
  for (const param of ['allowInsecure=0', 'allowInsecure=false']) {
    const parsed = await parseInput({
      format: 'uri',
      text: 'vless://' + UUID + '@example.com:443?security=tls&' + param + '#test',
    });
    assert.equal(parsed.items[0].draft.tls.insecure, false);
  }
});
