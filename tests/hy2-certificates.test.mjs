import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { parse } from 'yaml';
import { hy2Fixture, socksUdpRequest, fixturePin } from './hy2-fixture.mjs';
import { socksRequest, start, dualPort } from './chain-connections.mjs';
import { chainItem } from './chain-fixtures.mjs';
import { hy2CertificateRequest } from '../dist/server/shared/hy2-certificates.js';
import { outputFormats } from '../dist/server/shared/subscriptions.js';
import { renderInput } from '../dist/server/converter/render.js';
import { renewedCertificate, differentCertificate, differentKey } from './hy2-renewal-fixture.mjs';
import { X509Certificate } from 'node:crypto';
import { testCertificate } from './source-tls-fixture.mjs';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';

test('native artifacts and shares acquire HY2 certificates and all three cores carry real TCP/UDP', async (t) => {
  const f = await hy2Fixture(t);
  const server = await f.proxy('hysteria2', { obfs: true });
  const clientPort = await dualPort();
  await f.hopping(server.draft);
  const saved = await f.plan(server.draft, [...outputFormats], clientPort);
  const unauthorized = await f.app.request('/api/internal/hy2-certificates/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);
  const configs = {};
  for (const format of outputFormats) {
    const value = (await f.subscriptions.artifact(saved.id, format)).content;
    assert.ok(value.length);
    assert.ok(!value.includes(f.certificateResolverToken()));
    if (['mihomo', 'singbox', 'xray'].includes(format))
      configs[format] = format === 'mihomo' ? parse(value) : JSON.parse(value);
  }
  assert.equal(
    configs.xray.outbounds[0].streamSettings.tlsSettings.pinnedPeerCertSha256,
    fixturePin,
  );
  assert.equal(
    configs.xray.outbounds[0].streamSettings.hysteriaSettings.auth,
    server.draft.auth.password,
  );
  assert.equal(configs.mihomo.proxies[0].fingerprint, fixturePin);
  assert.ok(configs.singbox.outbounds[1].tls.certificate_public_key_sha256[0]);
  await f.subscriptions.share(saved.id, saved.revision, false);
  const output = f.subscriptions
    .outputs(saved.id)
    .find((entry) => entry.record._submeld.format === 'singbox');
  const token = (await f.client.tokens(output.record.name))[0].token;
  const shared = await f.app.request('/share/file/' + output.record.name + '?token=' + token);
  assert.equal(shared.status, 200);
  assert.deepEqual(await shared.json(), configs.singbox);
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const process = await start(
      f.binaries[target],
      target,
      configs[target],
      join(f.directory, 'client-' + target),
    );
    try {
      await process.ready(clientPort, true);
      await socksRequest(clientPort, f.httpPort);
      await socksUdpRequest(clientPort, f.udpPort);
    } finally {
      await process.stop();
    }
  }
  assert.equal(f.counts.tcp, 3);
  assert.equal(f.counts.udp, 3);
  await f.resources.sync();
  const cache = String(f.resources.files('certificate-cache')[0].record.content);
  assert.ok(cache.includes(fixturePin));
  assert.ok(!cache.includes(server.draft.auth.password));
  assert.ok(!cache.includes(server.draft.protocolOptions.obfsPassword));
  await server.stop();
  assert.ok(
    (await f.subscriptions.artifact(saved.id, 'singbox')).content.includes(
      'certificate_public_key_sha256',
    ),
    'Cached public certificate works while node is offline',
  );
});

test('HY2 certificate mismatch fails closed and Xray retains explicit stable-version limits', async (t) => {
  const f = await hy2Fixture(t);
  const server = await f.proxy();
  const wrong = structuredClone(server.draft);
  wrong.protocolOptions.pinSHA256 = 'ab'.repeat(32);
  await assert.rejects(f.certificates.resolve(hy2CertificateRequest(wrong)), {
    code: 'HY2_CERTIFICATE_MISMATCH',
  });
  const saved = await f.plan(wrong);
  await assert.rejects(f.subscriptions.artifact(saved.id, 'singbox'), (error) =>
    error.diagnostics.some((d) => d.code === 'HY2_CERTIFICATE_MISMATCH'),
  );
  assert.ok((await f.subscriptions.artifact(saved.id, 'mihomo')).content);
  assert.ok((await f.subscriptions.artifact(saved.id, 'xray')).content);
  for (const target of ['mihomo', 'xray']) {
    const port = await dualPort();
    const output = await renderInput(
      {
        target,
        listenPort: port,
        items: [{ nodeIndex: 0, draft: wrong, excluded: false, diagnostics: [] }],
      },
      f.client,
    );
    const process = await start(
      f.binaries[target],
      target,
      target === 'mihomo' ? parse(output.full) : JSON.parse(output.full),
      join(f.directory, 'wrong-' + target),
    );
    try {
      await process.ready(port, true);
      await assert.rejects(socksRequest(port, f.httpPort));
    } finally {
      await process.stop();
    }
  }
  assert.equal(f.counts.tcp, 0);
  const chain = chainItem('ss', 'hysteria2');
  chain.exit = structuredClone(server.draft);
  chain.exit.protocolOptions.ports = String(server.draft.port);
  await assert.rejects(renderInput({ target: 'xray', items: [chain] }, f.client), (error) =>
    error.diagnostics.some((d) => d.field === 'exit.protocolOptions.ports'),
  );
  const fast = structuredClone(server.draft);
  fast.protocolOptions.ports = String(fast.port);
  fast.protocolOptions.hopInterval = 1;
  await assert.rejects(
    renderInput(
      { target: 'xray', items: [{ nodeIndex: 0, draft: fast, excluded: false, diagnostics: [] }] },
      f.client,
    ),
    (error) => error.diagnostics.some((d) => d.field === 'protocolOptions.hopInterval'),
  );
});

test('HY2 certificate acquisition through an authenticated entry is cancelled cleanly and preserves real two-hop traffic', async (t) => {
  const f = await hy2Fixture(t);
  const entry = await f.proxy('ss');
  const exit = await f.proxy('hysteria2', { obfs: true });
  const request = hy2CertificateRequest(exit.draft, entry.draft);
  const proof = await f.certificates.resolve(request);
  assert.equal(proof.pinSHA256, fixturePin);
  assert.ok(entry.log.includes('outbound'), 'Probe reached the HY2 server through the entry');
  const temporary = join(f.directory, 'node-test-tmp');
  assert.deepEqual(await readdir(temporary), []);
  for (const pair of [
    [entry.draft, exit.draft],
    [exit.draft, entry.draft],
  ]) {
    const chain = { ...chainItem(), entry: pair[0], exit: pair[1] };
    const port = await dualPort();
    const saved = await f.plan(chain, ['mihomo', 'singbox', 'xray'], port);
    for (const target of ['mihomo', 'singbox', 'xray']) {
      const rendered = (await f.subscriptions.artifact(saved.id, target)).content;
      const process = await start(
        f.binaries[target],
        target,
        target === 'mihomo' ? parse(rendered) : JSON.parse(rendered),
        join(f.directory, 'chain-' + pair[0].protocol + '-' + target),
      );
      try {
        await process.ready(port, true);
        await socksRequest(port, f.httpPort);
        await socksUdpRequest(port, f.udpPort);
      } catch (error) {
        await process.stop();
        throw new Error(
          pair[0].protocol +
            ' -> ' +
            pair[1].protocol +
            ' / ' +
            target +
            ': ' +
            error.message +
            '\nclient: ' +
            process.log +
            '\nentry: ' +
            entry.log +
            '\nexit: ' +
            exit.log,
          { cause: error },
        );
      } finally {
        await process.stop();
      }
    }
  }
  await f.hopping(exit.draft);
  const hoppingChain = { ...chainItem(), entry: entry.draft, exit: exit.draft };
  const hoppingPort = await dualPort();
  const hoppingPlan = await f.plan(hoppingChain, ['mihomo', 'singbox'], hoppingPort);
  for (const target of ['mihomo', 'singbox']) {
    const rendered = (await f.subscriptions.artifact(hoppingPlan.id, target)).content;
    const process = await start(
      f.binaries[target],
      target,
      target === 'mihomo' ? parse(rendered) : JSON.parse(rendered),
      join(f.directory, 'chain-hopping-' + target),
    );
    try {
      await process.ready(hoppingPort, true);
      await socksRequest(hoppingPort, f.httpPort);
      await socksUdpRequest(hoppingPort, f.udpPort);
    } catch (error) {
      await process.stop();
      throw new Error(
        'Hopping chain / ' +
          target +
          ': ' +
          error.message +
          '\nclient: ' +
          process.log +
          '\nentry: ' +
          entry.log +
          '\nexit: ' +
          exit.log,
        { cause: error },
      );
    } finally {
      await process.stop();
    }
  }
  const abort = new AbortController();
  const missing = { ...request, pinSHA256: 'cd'.repeat(32), port: await dualPort(), ports: '' };
  const pending = f.certificates.resolve(missing, abort.signal);
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(pending, { name: 'AbortError' });
  await f.certificates.close();
  assert.deepEqual(await readdir(temporary), []);
});

test('sing-box accepts a certificate renewed with the same key while certificate pins remain exact', async (t) => {
  const f = await hy2Fixture(t);
  const server = await f.proxy();
  const port = await dualPort();
  const saved = await f.plan(server.draft, ['mihomo', 'singbox', 'xray'], port);
  const configs = {};
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const content = (await f.subscriptions.artifact(saved.id, target)).content;
    configs[target] = target === 'mihomo' ? parse(content) : JSON.parse(content);
  }
  assert.deepEqual(
    new X509Certificate(renewedCertificate).publicKey.export({ type: 'spki', format: 'der' }),
    new X509Certificate(testCertificate).publicKey.export({ type: 'spki', format: 'der' }),
  );
  await server.replaceCertificate(renewedCertificate);
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const process = await start(
      f.binaries[target],
      target,
      configs[target],
      join(f.directory, 'renewed-' + target),
    );
    try {
      await process.ready(port, true);
      if (target === 'singbox') {
        await socksRequest(port, f.httpPort);
        await socksUdpRequest(port, f.udpPort);
      } else await assert.rejects(socksRequest(port, f.httpPort));
    } catch (error) {
      throw new Error(
        'Certificate renewal / ' +
          target +
          ': ' +
          error.message +
          '\nclient: ' +
          process.log +
          '\nserver: ' +
          server.log,
        { cause: error },
      );
    } finally {
      await process.stop();
    }
  }
  const newPin = new X509Certificate(renewedCertificate).fingerprint256
    .replaceAll(':', '')
    .toLowerCase();
  const proof = await f.certificates.resolve({
    ...hy2CertificateRequest(server.draft),
    pinSHA256: newPin,
  });
  assert.equal(
    proof.publicKeySha256,
    configs.singbox.outbounds[1].tls.certificate_public_key_sha256[0],
  );
  await server.replaceCertificate(differentCertificate, differentKey);
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const process = await start(
      f.binaries[target],
      target,
      configs[target],
      join(f.directory, 'new-key-' + target),
    );
    try {
      await process.ready(port, true);
      await assert.rejects(socksRequest(port, f.httpPort));
    } finally {
      await process.stop();
    }
  }
  assert.equal(f.counts.tcp, 1);
  assert.equal(f.counts.udp, 1);
});

test('HY2 IPv6 acquisition and cancellation without a certificate never create an unverified cache', async (t) => {
  const f = await hy2Fixture(t);
  const server = await f.proxy('hysteria2', { host: '::1' });
  assert.equal(
    (await f.certificates.resolve(hy2CertificateRequest(server.draft))).pinSHA256,
    fixturePin,
  );
  const abort = new AbortController();
  const waiting = f.certificates.resolve(
    { ...hy2CertificateRequest(server.draft), pinSHA256: 'ef'.repeat(32), port: await dualPort() },
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(waiting, { name: 'AbortError' });
  await f.certificates.close();
  await f.resources.sync();
  const cache = JSON.parse(f.resources.files('certificate-cache')[0].record.content);
  assert.deepEqual(Object.keys(cache), [fixturePin]);
});

test('an unresponsive controlled HY2 endpoint times out without caching or weakening verification', async (t) => {
  const f = await hy2Fixture(t);
  const blackhole = createSocket('udp4');
  blackhole.bind(0, '127.0.0.1');
  await once(blackhole, 'listening');
  f.beforeClose(() => new Promise((resolve) => blackhole.close(resolve)));
  let received = 0;
  blackhole.on('message', () => {
    received++;
  });
  await assert.rejects(
    f.certificates.resolve({
      server: '127.0.0.1',
      port: blackhole.address().port,
      ports: '',
      serverName: 'source.test',
      obfs: '',
      obfsPassword: '',
      pinSHA256: fixturePin,
    }),
    { code: 'HY2_CERTIFICATE_TIMEOUT' },
  );
  assert.ok(received > 0, 'The probe performed actual QUIC handshakes');
  await f.resources.sync();
  assert.equal(f.resources.files('certificate-cache').length, 0);
});
