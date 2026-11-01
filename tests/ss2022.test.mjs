import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isIPv4 } from 'node:net';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { checkedDraft } from '../dist/server/converter/normalized.js';
import { toUpstream, validateDraft } from '../dist/server/converter/model.js';
import { produceInput } from '../dist/server/converter/engine.js';
import { KernelManager } from '../dist/server/kernels.js';
import { MiaospeedClient } from '../dist/server/miaospeed-client.js';
import { measurements } from '../dist/server/miaospeed-results.js';
import { launchBridge, freeBridgePort } from '../dist/server/miaospeed-bridge.js';
import { runNodeProbe, portReady } from '../dist/server/node-probe.js';
import { newSubscription, outputFormats } from '../dist/server/shared/subscriptions.js';
import { node, items } from './fixtures.mjs';
import { fixture, waitFor } from './upstream-fixture.mjs';
import { controlledNetwork } from './miaospeed-fixture.mjs';
import { testCertificate, testKey } from './source-tls-fixture.mjs';

const methods = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
];
const keySize = (method) => (method === methods[0] ? 16 : 32);
const ss = (method, password = Buffer.alloc(keySize(method), 251).toString('base64')) => {
  const draft = node('ss');
  draft.protocolOptions.method = method;
  draft.auth.password = password;
  return draft;
};

test('SS2022 validates exact single-key PSKs and reports safe field diagnostics', async () => {
  for (const method of methods) {
    const draft = ss(method);
    assert.deepEqual(checkedDraft(toUpstream(draft)), draft);
    assert.deepEqual(validateDraft(draft, 0), []);
    for (const password of [
      '',
      'invalid-secret!@',
      draft.auth.password.replace(/=+$/, ''),
      draft.auth.password.replaceAll('+', '-').replaceAll('/', '_'),
      Buffer.alloc(keySize(method) - 1).toString('base64'),
      Buffer.alloc(keySize(method) + 1).toString('base64'),
      draft.auth.password + ':' + draft.auth.password,
      draft.auth.password.replace(/=+$/, 'A='),
    ]) {
      const invalid = ss(method, password);
      assert.throws(
        () => checkedDraft(toUpstream(invalid), 7),
        (error) => {
          assert.equal(error.code, 'TARGET_UNSUPPORTED');
          assert.equal(error.status, 422);
          assert.equal(error.diagnostics[0].nodeIndex, 7);
          assert.equal(error.diagnostics[0].field, 'auth.password');
          if (password) assert.ok(!JSON.stringify(error).includes(password));
          assert.match(error.message, /SS2022/);
          return true;
        },
      );
      await assert.rejects(produceInput({ items: items(invalid) }), {
        code: 'CONVERSION_FAILED',
      });
    }
  }
  assert.throws(
    () => checkedDraft({ ...toUpstream(ss(methods[0])), cipher: 'unknown-secret-cipher' }),
    (error) => {
      assert.equal(error.code, 'TARGET_UNSUPPORTED');
      assert.equal(error.diagnostics[0].field, 'protocolOptions.method');
      assert.match(error.message, /加密方式/);
      assert.ok(!JSON.stringify(error).includes('unknown-secret-cipher'));
      return true;
    },
  );
});

test('pinned Sub-Store imports both SS2022 URI forms and its bundled script generates all eight outputs', async (t) => {
  const f = await fixture(t);
  const drafts = methods.flatMap((method, i) =>
    ['legacy', 'standard'].map((form) => ({ ...ss(method), name: form + '-' + i })),
  );
  const content = drafts
    .map((draft, i) => {
      const userinfo =
        i % 2 === 0
          ? Buffer.from(draft.protocolOptions.method + ':' + draft.auth.password)
              .toString('base64')
              .replace(/=+$/, '')
          : draft.protocolOptions.method + ':' + encodeURIComponent(draft.auth.password);
      return 'ss://' + userinfo + '@example.com:443#' + draft.name;
    })
    .join('\n');
  const resource = await f.nodes.create({ name: 'SS2022', source: 'local', content });
  const list = await f.nodes.list(resource.id);
  assert.equal(list.nodes.length, drafts.length);
  assert.ok(
    list.nodes.every((row) => row.testable),
    JSON.stringify(list.nodes),
  );
  const plan = await f.subscriptions.create({
    ...newSubscription(),
    name: 'SS2022',
    inputs: [{ kind: 'resource', id: resource.id }],
    formats: outputFormats,
  });
  let uri;
  for (const format of outputFormats) {
    const output = (await f.subscriptions.artifact(plan.id, format)).content;
    if (format === 'uri' || format === 'base64') {
      const text = format === 'base64' ? Buffer.from(output, 'base64').toString('utf8') : output;
      if (format === 'uri') uri = text;
      else assert.equal(text, uri);
      const lines = text.trim().split('\n');
      assert.equal(lines.length, drafts.length);
      for (const [i, line] of lines.entries()) {
        assert.ok(line.startsWith('ss://' + drafts[i].protocolOptions.method + ':'));
        assert.ok(line.includes(encodeURIComponent(drafts[i].auth.password)));
        const restored = await f.client.convert(line, 'JSON', true);
        assert.deepEqual(checkedDraft(restored[0]), {
          ...drafts[i],
          server: 'example.com',
          port: 443,
        });
      }
      continue;
    }
    const config = format.startsWith('mihomo') ? parse(output) : JSON.parse(output);
    const rows = format.startsWith('mihomo') ? config.proxies : config.outbounds;
    const proxies = rows.filter(
      (row) => row.type === 'ss' || row.type === 'shadowsocks' || row.protocol === 'shadowsocks',
    );
    assert.equal(proxies.length, drafts.length);
    for (const [i, row] of proxies.entries()) {
      const connection = row.settings?.servers[0] ?? row;
      assert.equal(connection.cipher ?? connection.method, drafts[i].protocolOptions.method);
      assert.equal(connection.password, drafts[i].auth.password);
      assert.equal(connection.address ?? connection.server, 'example.com');
      assert.equal(connection.server_port ?? connection.port, 443);
      assert.equal(row.name ?? row.tag, drafts[i].name);
    }
  }
});

for (const method of methods) {
  test(
    method + ' uses real HTTPS, TCP/UDP, uploads/downloads, authentication and cancellation',
    { timeout: 180000 },
    async (t) => {
      const f = await fixture(t),
        kernels = new KernelManager(f.directory);
      await kernels.initialize();
      const lease = kernels.snapshot();
      assert.equal(lease.binaries.size, 3);
      const net = await controlledNetwork(
        lease.binaries.get('singbox').path,
        join(f.directory, 'network'),
        method,
      );
      // miaospeed's Mihomo resolver does not use Docker's /etc/hosts aliases.
      const bridgeHost = isIPv4(process.env.MIAOSPEED_BRIDGE_HOST)
        ? process.env.MIAOSPEED_BRIDGE_HOST
        : execFileSync(
            'docker',
            [
              'inspect',
              process.env.SUBMELD_TEST_MIAOSPEED_CONTAINER,
              '--format',
              '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}',
            ],
            { encoding: 'utf8', windowsHide: true },
          ).trim();
      assert.ok(isIPv4(bridgeHost));
      net.raw.server = bridgeHost;
      let httpsHits = 0;
      const destination = createServer({ cert: testCertificate, key: testKey }, (_req, res) => {
        httpsHits++;
        res.writeHead(204);
        res.end();
      });
      destination.on('tlsClientError', () => {});
      destination.listen(0, '127.0.0.1');
      await once(destination, 'listening');
      f.beforeClose(async () => {
        destination.closeAllConnections();
        await new Promise((resolve) => destination.close(resolve));
        await net.close();
        await lease.release();
        await kernels.close();
      });
      const backend = new MiaospeedClient(process.env.MIAOSPEED_URL, process.env.MIAOSPEED_TOKEN);
      const metrics = ['TEST_HTTP_CODE', 'SPEED_AVERAGE', 'USPEED_AVERAGE', 'UDP_TYPE'];
      const matrices = metrics.map((Type) => ({ Type, Params: '' }));
      const measured = async (name, payload) => {
        const before = { ...net.counts };
        const result = await backend.run(
          net.settings,
          [{ Name: name, Payload: payload }],
          matrices,
          [],
          AbortSignal.timeout(45000),
        );
        const rows = measurements(result.slots[0], metrics, []);
        for (const row of rows)
          assert.equal(row.status, 'measured', method + '/' + name + ': ' + JSON.stringify(row));
        assert.equal(rows[0].value, '204, 204, 204');
        assert.ok(rows[1].value > 0 && rows[2].value > 0);
        for (const key of ['stun', 'download', 'upload'])
          assert.ok(net.counts[key] > before[key], name + ': ' + key);
      };
      await measured(
        'native',
        await f.miaospeedInput.payload(net.raw, 'native', AbortSignal.timeout(10000)),
      );
      const resource = await f.nodes.create({
        name: method,
        source: 'local',
        content: JSON.stringify(toUpstream(net.draft)),
      });
      const wrong = structuredClone(net.draft);
      wrong.auth.password = randomBytes(keySize(method)).toString('base64');
      const bad = await f.nodes.create({
        name: 'wrong-key',
        source: 'local',
        content: JSON.stringify(toUpstream(wrong)),
      });
      for (const core of ['mihomo', 'singbox', 'xray']) {
        const port = await freeBridgePort();
        const plan = await f.subscriptions.create({
          ...newSubscription(),
          name: method + '/' + core,
          inputs: [{ kind: 'resource', id: resource.id }],
          formats: [core],
          listenPort: port,
        });
        const full = (await f.subscriptions.artifact(plan.id, core)).content;
        const probe = (configuration) =>
          runNodeProbe(
            lease.binaries.get(core),
            configuration,
            port,
            'https://source.test:' + destination.address().port + '/probe',
            f.directory,
            AbortSignal.timeout(10000),
            {
              resolve: async () => [{ address: '127.0.0.1', family: 4 }],
              validateAddress: (address) => address,
              ca: testCertificate,
              timeoutMs: 1500,
            },
          );
        assert.equal((await probe(full)).httpStatus, 204);
        const badPlan = await f.subscriptions.create({
          ...newSubscription(),
          name: 'wrong/' + core,
          inputs: [{ kind: 'resource', id: bad.id }],
          formats: [core],
          listenPort: port,
        });
        const beforeBad = httpsHits;
        await assert.rejects(
          probe((await f.subscriptions.artifact(badPlan.id, core)).content),
          (error) => ['TEST_NETWORK_FAILED', 'TEST_TIMEOUT'].includes(error.code),
        );
        assert.equal(httpsHits, beforeBad, 'Wrong SS2022 keys must not fall back to direct');
        const abort = new AbortController();
        const bridge = await launchBridge(
          lease.binaries.get(core),
          full,
          port,
          f.directory,
          bridgeHost,
          abort.signal,
          bridgeHost,
        );
        try {
          await measured(core, bridge.payload);
          const beforeHang = net.counts.http;
          const cancelled = assert.rejects(
            backend.run(
              {
                ...net.settings,
                pingUrl: 'http://127.0.0.1:' + net.port + '/hang',
                requestTimeoutMs: 10000,
              },
              [{ Name: core, Payload: bridge.payload }],
              [{ Type: 'TEST_HTTP_CODE', Params: '' }],
              [],
              abort.signal,
            ),
            (error) => error.code === 'TEST_CANCELLED',
          );
          await waitFor(() => net.counts.http > beforeHang);
          abort.abort();
          await cancelled;
        } finally {
          abort.abort();
          await bridge.close();
        }
        assert.equal(await portReady(port, AbortSignal.timeout(1000), bridgeHost), false);
        assert.deepEqual(await readdir(join(f.directory, 'node-test-tmp')), []);
      }
      net.assertProxyTraffic();
    },
  );
}
