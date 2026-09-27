import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { renderInput } from '../dist/server/converter/render.js';
import { parseInput, produceInput } from '../dist/server/converter/engine.js';
import { SubStoreClient } from '../dist/server/sub-store.js';
import { Converter } from '../dist/server/converter/pool.js';
import { node, items, UUID, TEST_PASSWORD } from './fixtures.mjs';
import { renderFixtures } from './render-fixtures.mjs';
test('foreground conversion waits behind publication and cancelled waiters do not block later work', async () => {
  const client = new SubStoreClient();
  const convert = client.convert.bind(client);
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  let calls = 0;
  client.convert = async (...args) => {
    if (++calls === 1) {
      started();
      await gate;
    }
    return convert(...args);
  };
  const converter = new Converter(client);
  const request = {
    kind: 'parse',
    input: { format: 'uri', text: `vless://${UUID}@example.com:443?security=tls#queue` },
  };
  const first = converter.run(request);
  await entered;
  const abort = new AbortController();
  const cancelled = converter.run(request, abort.signal);
  const last = converter.run(request);
  abort.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(calls, 1);
  release();
  assert.equal((await first).counts.output, 1);
  assert.equal((await last).counts.output, 1);
  assert.equal(calls, 2);
  assert.equal(converter.isAvailable(), true);
  await converter.close();
  await assert.rejects(() => converter.run(request), { code: 'CONVERTER_CLOSED' });
});
test('native VLESS defaults survive source JSON, URI and every enhanced target', async () => {
  const proxies = await new SubStoreClient().convert(
    `vless://${UUID}@example.com:443?security=tls#native-default`,
    'JSON',
    true,
  );
  const input = await parseInput({ format: 'yaml', text: JSON.stringify({ proxies }) });
  assert.equal(input.counts.output, 1, JSON.stringify(input.items[0].diagnostics));
  assert.equal(input.items[0].draft.protocolOptions.packetEncoding, 'xudp');
  const uri = await produceInput({ items: input.items });
  assert.equal(new URL(uri.uri).searchParams.get('packetEncoding'), 'xudp');
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const output = await renderInput({ target, items: input.items });
    if (target === 'mihomo')
      assert.equal(parse(output.nodes).proxies[0]['packet-encoding'], 'xudp');
    else if (target === 'singbox')
      assert.equal(JSON.parse(output.nodes).outbounds[0].packet_encoding, 'xudp');
    else {
      const mux = JSON.parse(output.nodes).outbounds[0].mux;
      assert.equal(mux.enabled, true);
      assert.equal(mux.concurrency, -1);
      assert.ok(mux.xudpConcurrency > 0);
      assert.equal(mux.xudpProxyUDP443, 'allow');
    }
  }
});
for (const target of ['mihomo', 'singbox', 'xray'])
  test(
    target + ' preserves connection fields, ordering, both documents and input immutability',
    async () => {
      const input = { target, listenPort: 12345, items: items(...renderFixtures(target)) };
      const before = structuredClone(input);
      const result = await renderInput(input);
      assert.deepEqual(input, before);
      assert.deepEqual(await renderInput(input), result);
      const full = target === 'mihomo' ? parse(result.full) : JSON.parse(result.full),
        fragment = target === 'mihomo' ? parse(result.nodes) : JSON.parse(result.nodes);
      const nodes = target === 'mihomo' ? fragment.proxies : fragment.outbounds;
      assert.equal(nodes.length, input.items.length);
      assert.equal(result.counts.output, nodes.length);
      const reality = nodes[0];
      if (target === 'mihomo') {
        assert.deepEqual(full.proxies, nodes);
        assert.equal(full['mixed-port'], 12345);
        assert.equal(full['bind-address'], '127.0.0.1');
        assert.equal(full['proxy-groups'][0].proxies[0], input.items[0].draft.name);
        assert.deepEqual(full.rules, ['MATCH,SUBMELD']);
        assert.equal(reality['reality-opts']['short-id'], '00aabb');
      } else if (target === 'singbox') {
        assert.deepEqual(full.outbounds.slice(1), nodes);
        assert.equal(full.inbounds[0].listen, '127.0.0.1');
        assert.equal(full.inbounds[0].listen_port, 12345);
        assert.equal(full.outbounds[0].default, input.items[0].draft.name);
        assert.equal(full.route.final, 'SUBMELD');
        assert.equal(reality.tls.reality.short_id, '00aabb');
        assert.equal(reality.flow, 'xtls-rprx-vision');
      } else {
        assert.deepEqual(full.outbounds, nodes);
        assert.equal(full.inbounds[0].listen, '127.0.0.1');
        assert.equal(full.inbounds[0].port, 12345);
        assert.equal(full.routing.rules[0].outboundTag, input.items[0].draft.name);
        assert.equal(reality.streamSettings.realitySettings.shortId, '00aabb');
        assert.equal(
          reality.streamSettings.realitySettings.password,
          input.items[0].draft.tls.publicKey,
        );
        assert.equal(reality.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
      }
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i],
          d = input.items[i].draft;
        if (target === 'mihomo') {
          assert.equal(n.server, d.server);
          assert.equal(n.port, d.port);
          if ('password' in d.auth) assert.equal(n.password, TEST_PASSWORD);
          else assert.equal(n.uuid, d.auth.uuid);
          if (d.transport.type === 'ws') {
            assert.equal(n['ws-opts'].path, d.transport.path);
            assert.equal(n['ws-opts'].headers.Host, d.transport.host);
          }
          if (d.transport.type === 'grpc')
            assert.equal(n['grpc-opts']['grpc-service-name'], d.transport.serviceName);
        } else if (target === 'singbox') {
          assert.equal(n.server, d.server);
          assert.equal(n.server_port, d.port);
          if ('password' in d.auth) assert.equal(n.password, TEST_PASSWORD);
          else assert.equal(n.uuid, d.auth.uuid);
          if (d.transport.type === 'ws') {
            assert.equal(n.transport.path, d.transport.path);
            assert.equal(n.transport.headers.Host, d.transport.host);
          }
          if (d.transport.type === 'grpc')
            assert.equal(n.transport.service_name, d.transport.serviceName);
          if (d.protocol === 'tuic') {
            assert.equal(n.zero_rtt_handshake ?? false, d.protocolOptions.reduceRtt);
            assert.equal(n.congestion_control ?? 'cubic', d.protocolOptions.congestionControl);
          }
        } else {
          const server = (n.settings.servers ?? n.settings.vnext)[0];
          assert.equal(server.address, d.server);
          assert.equal(server.port, d.port);
          if ('password' in d.auth) assert.equal(server.password, TEST_PASSWORD);
          else assert.equal(server.users[0].id, d.auth.uuid);
          if (d.transport.type === 'ws') {
            assert.equal(n.streamSettings.wsSettings.path, d.transport.path);
            assert.equal(n.streamSettings.wsSettings.host, d.transport.host);
          }
          if (d.transport.type === 'grpc')
            assert.equal(n.streamSettings.grpcSettings.serviceName, d.transport.serviceName);
        }
      }
    },
  );
test('duplicates and reserved names are renamed deterministically without touching saved drafts', async () => {
  const drafts = ['SUBMELD', 'DIRECT', 'a', 'a', 'a (2)'].map((name) => ({ ...node('ss'), name }));
  const result = await renderInput({ target: 'mihomo', items: items(...drafts) });
  const names = parse(result.nodes).proxies.map((n) => n.name);
  assert.deepEqual(names, ['SUBMELD (2)', 'DIRECT (2)', 'a', 'a (2)', 'a (2) (2)']);
  assert.equal(result.diagnostics.filter((d) => d.code === 'OUTPUT_NAME_ADJUSTED').length, 4);
  assert.equal(drafts[0].name, 'SUBMELD');
});
test('Xray rejects unsupported and insecure nodes until explicitly excluded; other targets still work', async () => {
  const batch = items(node('ss'), node('hysteria2'), node('trojan'));
  await assert.rejects(
    async () => await renderInput({ target: 'xray', items: batch }),
    (e) =>
      e.code === 'CONVERSION_FAILED' &&
      e.diagnostics.filter((d) => d.code === 'TARGET_UNSUPPORTED').length === 2,
  );
  assert.equal((await renderInput({ target: 'mihomo', items: batch })).counts.output, 3);
  assert.equal((await renderInput({ target: 'singbox', items: batch })).counts.output, 3);
  batch[1].excluded = true;
  batch[2].excluded = true;
  assert.deepEqual((await renderInput({ target: 'xray', items: batch })).counts, {
    input: 3,
    output: 1,
    filtered: 2,
  });
  batch[0].excluded = true;
  await assert.rejects(async () => await renderInput({ target: 'xray', items: batch }), {
    code: 'EMPTY_OUTPUT',
  });
});
test('Xray REALITY refuses ALPN instead of dropping it', async () => {
  const d = renderFixtures('xray')[0];
  d.tls.alpn = ['h2'];
  await assert.rejects(
    async () => await renderInput({ target: 'xray', items: items(d) }),
    (e) => e.diagnostics.some((d) => d.field === 'tls.alpn'),
  );
});
test('malformed nodes, unsupported settings and output limits cannot create a partial success', async () => {
  await assert.rejects(async () => await renderInput({ target: 'mihomo', items: items(null) }), {
    code: 'CONVERSION_FAILED',
  });
  await assert.rejects(
    async () => await renderInput({ target: 'mihomo', items: items(node('ss')), listenPort: 0 }),
    {
      status: 400,
    },
  );
  await assert.rejects(
    async () =>
      await renderInput({ target: 'mihomo', items: items(node('ss')), template: { evil: true } }),
    { status: 400 },
  );
  const large = Array.from({ length: 230 }, () => {
    const d = node('ss');
    d.auth.password = '\u0001'.repeat(16000);
    return d;
  });
  await assert.rejects(
    async () => await renderInput({ target: 'singbox', items: items(...large) }),
    { status: 413 },
  );
  const multiline = Array.from({ length: 200 }, () => {
    const d = node('ss');
    d.auth.password = 'a\n'.repeat(4000);
    return d;
  });
  const request = { target: 'mihomo', items: items(...multiline) };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 4 * 1024 * 1024);
  await assert.rejects(async () => await renderInput(request), { code: 'OUTPUT_LIMIT_EXCEEDED' });
});
test('remote converter renders configurations, then retains the URI/Base64 path', async () => {
  const converter = new Converter();
  try {
    await converter.ready;
    const input = items(node('ss'));
    const result = await converter.run({
      kind: 'render',
      input: { items: input, target: 'xray', listenPort: 1080 },
    });
    assert.equal(result.target, 'xray');
    const uri = await converter.run({ kind: 'produce', input: { items: input } });
    assert.equal(Buffer.from(uri.base64, 'base64').toString('utf8'), uri.uri);
    assert.equal(uri.uri, (await produceInput({ items: input })).uri);
  } finally {
    await converter.close();
  }
});
