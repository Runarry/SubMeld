import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, waitFor } from './upstream-fixture.mjs';
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
  const second = service.resolve(Object.fromEntries(Object.entries(input()).reverse()));
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

test('same-pin unhealthy and healthy endpoints resolve independently and share only verified cache proofs', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  const calls = [];
  const service = new Hy2Certificates(
    f.resources,
    f.certificateResolverToken(),
    async (request) => {
      calls.push(request);
      await gate.promise;
      if (request.server === 'unreachable.invalid')
        throw new AppError('HY2_CERTIFICATE_UNREACHABLE', 'Controlled unreachable endpoint', 422);
      return certificateProof(fixturePin, testCertificate);
    },
  );
  f.beforeClose(() => service.close());
  const request = { ...input(), server: 'unreachable.invalid' };
  const outcomes = Promise.allSettled([
    service.resolve(request),
    service.resolve({ ...request, server: 'healthy.invalid' }),
  ]);
  try {
    await waitFor(() => calls.length === 2, 2000);
  } finally {
    gate.resolve();
  }
  const [failed, healthy] = await outcomes;
  assert.equal(failed.status, 'rejected');
  assert.equal(failed.reason.code, 'HY2_CERTIFICATE_UNREACHABLE');
  assert.equal(healthy.status, 'fulfilled');
  assert.deepEqual(
    await service.resolve({
      ...request,
      server: 'another.invalid',
      port: 444,
      ports: '444-445',
      serverName: 'another.invalid',
      obfs: '',
      obfsPassword: '',
    }),
    healthy.value,
  );
  assert.equal(
    calls.length,
    2,
    'Verified proofs are reused by pin regardless of connection parameters',
  );
  const entries = JSON.parse(f.resources.files('certificate-cache')[0].record.content);
  assert.deepEqual(Object.keys(entries), [fixturePin]);
  assert.deepEqual(entries[fixturePin], healthy.value);
});

test('pending probes distinguish every request field, including candidate ports within the same range', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  const calls = [];
  const service = new Hy2Certificates(
    f.resources,
    f.certificateResolverToken(),
    async (request) => {
      calls.push(request);
      await gate.promise;
      throw new AppError('HY2_CERTIFICATE_UNREACHABLE', 'Controlled unreachable endpoint', 422);
    },
  );
  f.beforeClose(() => service.close());
  const request = { ...input(), ports: '443-445' };
  const requests = [
    request,
    ...[
      { pinSHA256: 'cd'.repeat(32) },
      { server: 'another.invalid' },
      { port: 444 },
      { ports: '443-446' },
      { serverName: 'another.invalid' },
      { obfs: '' },
      { obfsPassword: 'different-test-obfs' },
    ].map((changed) => ({ ...request, ...changed })),
  ];
  const results = Promise.allSettled(requests.map((value) => service.resolve(value)));
  try {
    await waitFor(() => calls.length === 4, 2000);
  } finally {
    gate.resolve();
  }
  assert.ok(
    (await results).every(
      (result) =>
        result.status === 'rejected' && result.reason.code === 'HY2_CERTIFICATE_UNREACHABLE',
    ),
  );
  assert.deepEqual(
    new Set(calls.map((value) => JSON.stringify(value))),
    new Set(requests.map((value) => JSON.stringify(value))),
  );
  assert.equal(calls.length, requests.length);
  await assert.rejects(service.resolve(request), { code: 'HY2_CERTIFICATE_UNREACHABLE' });
  assert.equal(calls.length, requests.length + 1, 'Failed probes do not populate a cache or retry');
  assert.equal(f.resources.files('certificate-cache').length, 0);
});

test('cancelling one candidate-port attempt leaves another same-pin attempt running', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  const calls = [];
  const service = new Hy2Certificates(
    f.resources,
    f.certificateResolverToken(),
    async (request, signal) => {
      calls.push({ request, signal });
      if (request.port === 444)
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      await gate.promise;
      return certificateProof(fixturePin, testCertificate);
    },
  );
  f.beforeClose(() => service.close());
  const request = { ...input(), ports: '443-445' };
  const abort = new AbortController();
  const outcomes = Promise.allSettled([
    service.resolve(request),
    service.resolve({ ...request, port: 444 }, abort.signal),
  ]);
  try {
    await waitFor(() => calls.length === 2, 2000);
    abort.abort();
    assert.equal(calls.find((call) => call.request.port === 444).signal.aborted, true);
    assert.equal(calls.find((call) => call.request.port === 443).signal.aborted, false);
  } finally {
    abort.abort();
    gate.resolve();
  }
  const [healthy, cancelled] = await outcomes;
  assert.equal(healthy.status, 'fulfilled');
  assert.equal(cancelled.status, 'rejected');
  assert.equal(cancelled.reason.name, 'AbortError');
  assert.equal(calls.length, 2);
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
