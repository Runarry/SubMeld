import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseInput, produceInput } from '../dist/server/converter/engine.js';
import { Converter } from '../dist/server/converter/pool.js';
import { MAX_BYTES } from '../dist/server/shared/contracts.js';
import { node, items, UUID, TEST_PASSWORD } from './fixtures.mjs';

for (const protocol of ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic']) {
  for (const transport of ['vmess', 'vless', 'trojan'].includes(protocol)
    ? ['tcp', 'ws', 'grpc']
    : ['tcp']) {
    test(
      protocol + '/' + transport + ' preserves edited credentials, IPv6 and connection fields',
      () => {
        const draft = node(protocol, transport);
        const input = { items: items(draft) };
        const before = structuredClone(input);
        const result = produceInput(input);
        assert.deepEqual(input, before, 'producer must not mutate draft');
        assert.equal(Buffer.from(result.base64, 'base64').toString('utf8'), result.uri);
        assert.equal(produceInput(input).uri, result.uri, 'output must be deterministic');
        assert.equal(result.uri.includes('\n'), false);
        const parsed = parseInput({ format: 'uri', text: result.uri });
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
        const edited = produceInput(input);
        assert.notEqual(edited.uri, result.uri);
        assert.equal(
          parseInput({ format: 'base64', text: edited.base64 }).items[0].draft.name,
          '修改后的名称',
        );
      },
    );
  }
  test(protocol + ' missing credentials blocks output and never silently drops a node', () => {
    const broken = node(protocol);
    if ('uuid' in broken.auth) broken.auth.uuid = '';
    else broken.auth.password = '';
    assert.throws(
      () => produceInput({ items: items(node('vless'), broken) }),
      (e) => e.code === 'CONVERSION_FAILED' && e.diagnostics.some((d) => d.nodeIndex === 1),
    );
  });
}
test('REALITY public key, leading-zero short ID and flow survive YAML and URI', () => {
  const yaml =
    'proxies:\n  - name: Reality\n    type: vless\n    server: example.com\n    port: 443\n    uuid: ' +
    UUID +
    '\n    tls: true\n    servername: tls.example.com\n    client-fingerprint: chrome\n    flow: xtls-rprx-vision\n    reality-opts:\n      public-key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n      short-id: 0088\n';
  const parsed = parseInput({ format: 'yaml', text: yaml });
  assert.equal(parsed.items[0].draft?.tls.shortId, '0088');
  const result = produceInput({ items: parsed.items });
  const url = new URL(result.uri);
  assert.equal(url.searchParams.get('security'), 'reality');
  assert.equal(url.searchParams.get('sid'), '0088');
  assert.equal(url.searchParams.get('pbk'), 'A'.repeat(43));
  assert.equal(url.searchParams.get('flow'), 'xtls-rprx-vision');
});
test('YAML inline nodes and textual credentials are imported without fetching providers', () => {
  const parsed = parseInput({
    format: 'auto',
    text: 'proxy-providers:\n  external:\n    url: https://example.com/private\nproxies:\n  - {type: trojan, name: yaml, server: example.com, port: 443, password: 00123}\n',
  });
  assert.equal(parsed.items[0].draft.auth.password, '00123');
  assert.equal(parsed.diagnostics[0].code, 'YAML_METADATA_NOT_IMPORTED');
  assert.match(produceInput({ items: parsed.items }).uri, /^trojan:\/\/00123@/);
});
test('errors remain visible until explicitly excluded', () => {
  const uri = produceInput({ items: items(node('ss')) }).uri;
  const parsed = parseInput({
    format: 'uri',
    text: uri + '\nvless://bad@example.com:443?security=tls#bad\nhttps://example.com/private',
  });
  assert.equal(parsed.items.length, 3);
  assert.ok(parsed.items[1].diagnostics.some((d) => d.level === 'error'));
  assert.throws(() => produceInput({ items: parsed.items }), { code: 'CONVERSION_FAILED' });
  parsed.items[1].excluded = true;
  parsed.items[2].excluded = true;
  const result = produceInput({ items: parsed.items });
  assert.deepEqual(result.counts, { input: 3, output: 1, filtered: 2 });
  assert.equal(result.uri, uri);
  parsed.items[0].excluded = true;
  assert.throws(() => produceInput({ items: parsed.items }), { code: 'EMPTY_OUTPUT' });
});
test('unknown security, transports, SS2022 and missing REALITY key are rejected', () => {
  for (const suffix of [
    'security=unknown',
    'type=xhttp',
    'security=reality',
    'security=tls&type=ws&packetEncoding=xudp',
  ]) {
    const parsed = parseInput({
      format: 'uri',
      text: 'vless://' + UUID + '@example.com:443?' + suffix + '#test',
    });
    assert.ok(
      parsed.items[0].diagnostics.some((d) => d.level === 'error'),
      suffix,
    );
    assert.throws(() => produceInput({ items: parsed.items }));
  }
  const parsed = parseInput({
    format: 'yaml',
    text: 'proxies: [{type: ss, name: bad, server: example.com, port: 443, cipher: 2022-blake3-aes-128-gcm, password: test}]',
  });
  assert.equal(parsed.counts.output, 0);
});
test('input guards reject nested wrappers, HTML, duplicate parameters, aliases and excessive depth', () => {
  const uri = produceInput({ items: items(node('ss')) }).uri;
  const encoded = Buffer.from(uri).toString('base64url');
  assert.equal(parseInput({ format: 'base64', text: encoded }).counts.output, 1);
  const double = Buffer.from(encoded).toString('base64');
  assert.equal(parseInput({ format: 'base64', text: double }).counts.output, 0);
  assert.throws(() => parseInput({ format: 'auto', text: '<html>private page</html>' }));
  assert.throws(() => parseInput({ format: 'yaml', text: 'a: &a [*a]\nproxies: *a' }));
  assert.throws(() =>
    parseInput({ format: 'yaml', text: 'proxies: ' + '['.repeat(35) + ']'.repeat(35) }),
  );
  assert.throws(() => parseInput({ format: 'yaml', text: 'proxies: []\nproxies: []' }));
  const duplicate = parseInput({
    format: 'uri',
    text: 'vless://' + UUID + '@example.com:443?security=tls&security=none#test',
  });
  assert.equal(duplicate.counts.output, 0);
  assert.throws(() => parseInput({ format: 'uri', text: 'x'.repeat(MAX_BYTES + 1) }), {
    status: 413,
  });
  assert.throws(() => parseInput({ format: 'uri', text: Array(2001).fill(uri).join('\n') }), {
    status: 413,
  });
});
test('Base64 has its own output cap while valid URI remains available', () => {
  const drafts = Array.from({ length: 200 }, () => {
    const d = node('trojan');
    d.auth.password = 'x'.repeat(16000);
    return d;
  });
  const result = produceInput({ items: items(...drafts) });
  assert.ok(Buffer.byteLength(result.uri) < MAX_BYTES);
  assert.ok(result.base64 === null);
  assert.equal(result.diagnostics.at(-1).code, 'BASE64_OUTPUT_LIMIT');
});
test('build excludes service, processors, network and file runtime dependencies', () => {
  const info = JSON.parse(
    readFileSync(new URL('../dist/converter/build.json', import.meta.url), 'utf8'),
  );
  assert.equal(info.commit, 'ece585cdac30d6a6f25a2b8815ac1dde26414153');
  assert.equal(
    info.inputs.some((p) =>
      /restful|open-api|utils\/download|proxy-utils\/processors\//.test(p.replaceAll('\\', '/')),
    ),
    false,
  );
});
test('Worker is exclusive, terminates blocked work, and recovers for a real conversion', async () => {
  const worker = new Converter(new URL('./worker-fixture.mjs', import.meta.url), 150);
  try {
    await worker.ready;
    const blocking = worker.run({ kind: 'parse', input: { format: 'uri', text: 'BLOCK' } });
    await assert.rejects(worker.run({ kind: 'parse', input: { format: 'uri', text: 'BLOCK' } }), {
      code: 'CONVERTER_BUSY',
    });
    await assert.rejects(blocking, { code: 'WORKER_TIMEOUT' });
    await worker.ready;
    const result = await worker.run({ kind: 'produce', input: { items: items(node('vless')) } });
    assert.equal(result.counts.output, 1);
  } finally {
    await worker.close();
  }
});

test('protocol-specific and malformed security inputs cannot be silently normalized away', () => {
  for (const text of [
    'trojan://test@example.com:443?security=none#bad',
    'hysteria2://test@example.com:443?obfs=unknown#bad',
    'vless://' + UUID + '@example.com:443?security=tls&pbk=' + 'A'.repeat(43) + '#bad',
    'tuic://' + UUID + ':test@example.com:443?fp=chrome#bad',
  ]) {
    const parsed = parseInput({ format: 'uri', text });
    assert.equal(parsed.counts.output, 0);
  }
  for (const extra of ['tls: invalid', 'skip-cert-verify: "true"', 'tls: false']) {
    assert.equal(
      parseInput({
        format: 'yaml',
        text:
          'proxies: [{type: trojan, name: bad, server: example.com, port: 443, password: test, ' +
          extra +
          '}]',
      }).counts.output,
      0,
    );
  }
});
test('Worker startup failure remains unavailable without a restart loop', async () => {
  const worker = new Converter(new URL('./absent-worker.mjs', import.meta.url));
  try {
    await assert.rejects(worker.ready, /failed to start|exited/);
    await assert.rejects(worker.run({ kind: 'parse', input: { format: 'uri', text: 'test' } }), {
      code: 'CONVERTER_BUSY',
    });
  } finally {
    await worker.close();
  }
});

test('invalid optional YAML fields cannot silently become defaults', () => {
  for (const patch of [
    'network: ws, ws-opts: {path: [/one, /two]}',
    'network: ws, ws-opts: {path: /one, headers: {Host: [one.example, two.example]}}',
    'network: ws, ws-opts: [invalid]',
    'client-fingerprint: {invalid: true}',
    'sni: ""',
  ]) {
    const result = parseInput({
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
test('disabled certificate checks are never inferred from false boolean strings', () => {
  for (const protocol of ['vmess', 'vless', 'trojan', 'hysteria2', 'tuic']) {
    const draft = node(protocol);
    draft.tls.insecure = false;
    const result = produceInput({ items: items(draft) });
    const parsed = parseInput({ format: 'uri', text: result.uri });
    assert.equal(parsed.items[0].draft.tls.insecure, false, protocol);
  }
  for (const param of ['allowInsecure=0', 'allowInsecure=false']) {
    const parsed = parseInput({
      format: 'uri',
      text: 'vless://' + UUID + '@example.com:443?security=tls&' + param + '#test',
    });
    assert.equal(parsed.items[0].draft.tls.insecure, false);
  }
});
