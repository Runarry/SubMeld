import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './upstream-fixture.mjs';
import { node } from './fixtures.mjs';
import { fixturePin } from './hy2-fixture.mjs';
import { testCertificate } from './source-tls-fixture.mjs';
import { certificateProof } from '../dist/server/converter/certificate-pin.js';
import { Hy2Certificates } from '../dist/server/hy2-certificates.js';
import { hy2CertificateRequest } from '../dist/server/shared/hy2-certificates.js';
import { AppError } from '../dist/server/errors.js';

const input = () => {
  const draft = node('hysteria2');
  draft.protocolOptions.pinSHA256 = fixturePin;
  return hy2CertificateRequest(draft);
};

test('certificate resolution merges subscribers, keeps remaining callers alive and rejects corrupted cache proofs', async (t) => {
  const f = await fixture(t);
  let calls = 0,
    release,
    started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = new Hy2Certificates(f.resources, f.certificateResolverToken(), async () => {
    calls++;
    started();
    await gate;
    return certificateProof(fixturePin, testCertificate);
  });
  f.beforeClose(() => service.close());
  const abort = new AbortController();
  const first = service.resolve(input(), abort.signal);
  const second = service.resolve(input());
  await entered;
  abort.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release();
  const proof = await second;
  assert.equal(calls, 1);
  assert.deepEqual(await service.resolve(input()), proof);
  assert.equal(calls, 1, 'A content-addressed verified certificate is reusable without probing');
  const cache = f.resources.files('certificate-cache')[0];
  const entries = JSON.parse(cache.record.content);
  entries[fixturePin].publicKeySha256 = Buffer.alloc(32).toString('base64');
  await f.client.api(
    '/api/file/' + cache.record.name,
    { content: JSON.stringify(entries) },
    'PATCH',
  );
  await assert.rejects(service.resolve(input()), { code: 'HY2_CERTIFICATE_INVALID' });
});

test('certificate probe concurrency is bounded at four and queued requests retain failures', async (t) => {
  const f = await fixture(t);
  let active = 0,
    maximum = 0,
    calls = 0,
    release,
    filled;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const full = new Promise((resolve) => {
    filled = resolve;
  });
  const service = new Hy2Certificates(f.resources, f.certificateResolverToken(), async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    if (active === 4) filled();
    try {
      await gate;
      throw new AppError('HY2_CERTIFICATE_MISMATCH', 'Controlled certificate mismatch', 422);
    } finally {
      active--;
    }
  });
  f.beforeClose(() => service.close());
  const pending = Array.from({ length: 9 }, (_, i) =>
    service.resolve({ ...input(), pinSHA256: (i + 1).toString(16).padStart(64, '0') }),
  );
  const results = Promise.allSettled(pending);
  try {
    await Promise.race([
      full,
      delay(5000).then(() => {
        throw new Error('Probe queue did not fill');
      }),
    ]);
  } finally {
    release();
  }
  assert.equal(maximum, 4);
  assert.ok(
    (await results).every(
      (result) => result.status === 'rejected' && result.reason.code === 'HY2_CERTIFICATE_MISMATCH',
    ),
  );
  assert.equal(calls, 9);
  assert.equal(active, 0);
  await f.resources.sync();
  assert.equal(f.resources.files('certificate-cache').length, 0);
});
