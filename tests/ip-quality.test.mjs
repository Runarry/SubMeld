import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { IpQualityService } from '../dist/server/ip-quality.js';
import { parseIpQualityData, IPREGISTRY_DEFAULT_KEY } from '../dist/server/ip-quality-providers.js';
import {
  IpQualityDnsbls,
  reverseDnsblAddress,
  classifyDnsbl,
  ipQualityDnsblLists,
} from '../dist/server/ip-quality-dnsbl.js';
import { ipQualityReportSchema, ipQualityAddress } from '../dist/server/shared/ip-quality.js';
import { createApp } from '../dist/server/app.js';
import { Auth, hashPassword } from '../dist/server/auth.js';
import { UpstreamResources } from '../dist/server/upstream-resources.js';
import { SubStoreClient } from '../dist/server/sub-store.js';
import {
  qualityPayloads,
  qualityRequest,
  qualityFetch,
  qualityDns,
  absent,
} from './ip-quality-fixtures.mjs';

const source = (report, id) => report.sources.find((item) => item.id === id);
const service = (options = {}) =>
  new IpQualityService({ fetch: qualityFetch, resolve: qualityDns, ...options });
const waitForAbort = (signal) =>
  new Promise((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

test('IP quality adapters retain independent source meanings and distinguish false, zero and missing', () => {
  const parsed = Object.fromEntries(
    Object.entries(qualityPayloads()).map(([id, payload]) => [
      id,
      parseIpQualityData(id, payload, '1.1.1.1'),
    ]),
  );
  assert.equal(Object.keys(parsed).length, 9);
  assert.equal(parsed.ipinfo.info.asn, 'AS13335');
  assert.equal(parsed.ipinfo.factors.vpn, true);
  assert.equal(parsed.scamalytics.scores[0].value, 0);
  assert.equal(parsed.scamalytics.scores[0].level, '低');
  assert.equal(parsed.scamalytics.factors.proxy, false);
  assert.equal(parsed.scamalytics.factors.bot, null);
  assert.equal(parsed.ipregistry.factors.tor, false);
  assert.equal(
    parsed.ipdata.factors.abuser,
    null,
    'two negatives and a missing flag are not all-negative',
  );
  assert.equal(parsed.ipapi.scores[0].value, 12.5);
  assert.equal(parsed.ipapi.scores[0].scope, 'network');
  assert.equal(parsed.ipapi.scores[1].value, 0.5);
  assert.equal(parsed.abuseipdb.totalReports, 0);
  assert.equal(parsed.abuseipdb.lastReportedAt, null);
  assert.equal(parsed.ip2location.networkType, '机房');
  assert.equal(parsed.ip2location.factors.proxy, false);
  assert.equal(parsed.ipqs.scores[0].level, '有风险');
});

test('parsers validate echoed IPs, provider errors and data types instead of manufacturing clean results', () => {
  for (const value of [
    null,
    [],
    {},
    { success: false },
    { error: 'secret must not escape' },
    { data: { error: 'bad', privacy: { vpn: false } } },
    { data: { privacy: { vpn: 'false' } } },
    { data: { ip: '8.8.8.8', privacy: { vpn: false } } },
  ])
    assert.throws(() => parseIpQualityData('ipinfo', value, '1.1.1.1'), { status: 'invalid' });
  for (const ip of [123, 'not-ip', '127.0.0.1'])
    assert.throws(() => parseIpQualityData('ipqs', { ip, country_code: 'AU' }, '1.1.1.1'), {
      status: 'invalid',
    });
  const ipv6 = '2606:4700:4700::1111';
  assert.equal(
    parseIpQualityData(
      'ipinfo',
      { data: { ip: '2606:4700:4700:0000:0000:0000:0000:1111', privacy: { vpn: false } } },
      ipv6,
    ).factors.vpn,
    false,
  );
  assert.equal(
    parseIpQualityData('ipqs', { fraud_score: 900, country_code: 'AU' }, '1.1.1.1').scores.length,
    0,
  );
  assert.equal(
    parseIpQualityData('ipdata', { threat: { is_known_attacker: true } }, '1.1.1.1').factors.abuser,
    true,
  );
});

test('invalid or non-public inputs never cause HTTP or DNS requests', async () => {
  let requests = 0;
  const tester = service({
    fetch: async () => {
      requests++;
      throw new Error();
    },
    resolve: async () => {
      requests++;
      return [];
    },
  });
  for (const ip of [
    '127.0.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '198.19.255.254',
    '::1',
    'fe80::1%eth0',
    'fc00::1',
    '2001:db8::1',
    '::ffff:192.168.1.1',
    '1.1.1.1:443',
    'https://1.1.1.1',
    'example.com',
    '1.1.1.0/24',
    '1.1.1.1,8.8.8.8',
    '001.1.1.1',
    '',
  ])
    await assert.rejects(tester.query({ ip }), { code: 'IP_QUALITY_INPUT_INVALID' });
  await assert.rejects(tester.query({ ip: '1.1.1.1', endpoint: 'https://example.com' }), {
    code: 'IP_QUALITY_INPUT_INVALID',
  });
  assert.equal(requests, 0);
  assert.deepEqual(ipQualityAddress(' ::ffff:1.1.1.1 '), { ip: '1.1.1.1', family: 4 });
});

test('queries are explicit, dual-stack, independently cached and never use DB-IP self', async () => {
  let now = Date.parse('2026-10-25T00:00:00Z');
  const urls = [],
    names = [];
  const tester = service({
    now: () => now,
    fetch: async (url, options) => {
      urls.push({ url, options });
      return qualityFetch(url);
    },
    resolve: async (name) => {
      names.push(name);
      return qualityDns(name);
    },
  });
  const report = ipQualityReportSchema.parse(await tester.query({ ip: ' ::ffff:1.1.1.1 ' }));
  assert.equal(report.status, 'complete');
  assert.equal(report.ip, '1.1.1.1');
  assert.equal(report.sources.length, 10);
  assert.equal(source(report, 'dbip').status, 'unsupported');
  assert.deepEqual(report.blacklist, { queried: 5, valid: 5, listed: 0 });
  assert.equal(report.dnsbl.find((v) => v.id === 'sem-ipv6').status, 'unsupported');
  assert.equal(urls.length, 10);
  assert.ok(urls.every(({ url }) => !url.includes('db-ip') && !url.includes('/self')));
  assert.ok(
    urls
      .filter(({ url }) => qualityRequest(url).id !== 'registry-page')
      .every(({ url }) => qualityRequest(url).ip === '1.1.1.1'),
  );
  assert.ok(urls.every(({ options }) => options.redirect === 'manual'));
  assert.ok(!JSON.stringify(report).includes(IPREGISTRY_DEFAULT_KEY));
  const dnsCount = names.length;
  const cached = await tester.query({ ip: '1.1.1.1' });
  assert.ok(cached.sources.filter((v) => v.status === 'success').every((v) => v.cached));
  assert.equal(urls.length, 10);
  assert.equal(names.length, dnsCount);
  const fresh = await tester.query({ ip: '1.1.1.1', refresh: true });
  assert.equal(source(fresh, 'ipinfo').cached, false);
  assert.equal(urls.length, 19, 'key is reused but provider result cache is bypassed');
  assert.equal(names.length, dnsCount + 5, 'health cache is reused');
  const ipv6 = await tester.query({ ip: '2606:4700:4700::1111' });
  assert.equal(ipv6.family, 6);
  assert.deepEqual(ipv6.blacklist, { queried: 1, valid: 1, listed: 0 });
  now += 600001;
  assert.equal(source(await tester.query({ ip: '1.1.1.1' }), 'ipinfo').cached, false);
  assert.equal(
    source(await service().query({ ip: '1.1.1.1' }), 'ipinfo').cached,
    false,
    'new service has no persisted report',
  );
});

test('source failures preserve other results and never echo remote errors or keys', async () => {
  for (const [response, state] of [
    [() => new Response('Forbidden key=do-not-echo', { status: 403 }), 'unavailable'],
    [() => new Response('<html>blocked</html>'), 'invalid'],
    [() => new Response('{broken'), 'invalid'],
    [() => Response.json({ data: { ip: '8.8.8.8', privacy: { vpn: false } } }), 'invalid'],
    [() => Response.json({ error: 'do-not-echo', data: { country: 'AU' } }), 'invalid'],
  ]) {
    const tester = service({
      fetch: async (url) => (qualityRequest(url).id === 'ipinfo' ? response() : qualityFetch(url)),
    });
    const report = await tester.query({ ip: '1.1.1.1' });
    assert.equal(source(report, 'ipinfo').status, state);
    assert.equal(source(report, 'ipinfo').data, undefined);
    assert.equal(source(report, 'ipregistry').status, 'success');
    assert.equal(report.status, 'partial');
    assert.ok(!JSON.stringify(report).includes('do-not-echo'));
  }
});

test('dynamic registry key is cached, removed after authentication failure and falls back only when absent', async () => {
  let pageCalls = 0,
    fail = false;
  const keys = [];
  const tester = service({
    fetch: async (url, options) => {
      const { id } = qualityRequest(url);
      if (id === 'registry-page') return new Response('apiKey="DynamicKey' + ++pageCalls + '"');
      if (id === 'ipregistry') {
        keys.push(new URL(url).searchParams.get('key'));
        assert.equal(options.headers.Origin, 'https://ipregistry.co');
        if (fail) return new Response('secret', { status: 401 });
      }
      return qualityFetch(url);
    },
  });
  await tester.query({ ip: '1.1.1.1' });
  fail = true;
  const rejected = await tester.query({ ip: '1.1.1.1', refresh: true });
  assert.equal(source(rejected, 'ipregistry').status, 'unavailable');
  fail = false;
  const recovered = await tester.query({ ip: '1.1.1.1', refresh: true });
  assert.deepEqual(keys, ['DynamicKey1', 'DynamicKey1', 'DynamicKey2']);
  assert.equal(pageCalls, 2);
  assert.ok(!JSON.stringify(recovered).includes('DynamicKey'));
  let fallback;
  await service({
    fetch: async (url) => {
      if (qualityRequest(url).id === 'registry-page')
        return new Response('no key', { status: 503 });
      if (qualityRequest(url).id === 'ipregistry') fallback = new URL(url).searchParams.get('key');
      return qualityFetch(url);
    },
  }).query({ ip: '1.1.1.1' });
  assert.equal(fallback, IPREGISTRY_DEFAULT_KEY);
});

test('429 Retry-After blocks even refresh until its deadline; failures are not cached as success', async () => {
  for (const header of ['60', 'Sun, 25 Oct 2026 00:01:00 GMT']) {
    let now = Date.parse('2026-10-25T00:00:00Z'),
      calls = 0;
    const tester = service({
      now: () => now,
      fetch: async (url) => {
        if (qualityRequest(url).id === 'ipinfo' && ++calls === 1)
          return new Response('', { status: 429, headers: { 'Retry-After': header } });
        return qualityFetch(url);
      },
    });
    const first = await tester.query({ ip: '1.1.1.1' });
    assert.equal(source(first, 'ipinfo').retryAt, '2026-10-25T00:01:00.000Z');
    const second = await tester.query({ ip: '1.1.1.1', refresh: true });
    assert.equal(source(second, 'ipinfo').status, 'rate_limited');
    assert.equal(source(second, 'ipinfo').cached, false);
    assert.equal(calls, 1);
    now += 60001;
    assert.equal(source(await tester.query({ ip: '1.1.1.1' }), 'ipinfo').status, 'success');
    assert.equal(calls, 2);
  }
});

test('HTTP and DNS limits hold across simultaneous queries', async () => {
  let http = 0,
    dns = 0,
    maxHttp = 0,
    maxDns = 0;
  const tester = service({
    fetch: async (url, { signal }) => {
      maxHttp = Math.max(maxHttp, ++http);
      try {
        await delay(3, undefined, { signal });
        return await qualityFetch(url);
      } finally {
        http--;
      }
    },
    resolve: async (name, signal) => {
      maxDns = Math.max(maxDns, ++dns);
      try {
        await delay(3, undefined, { signal });
        return await qualityDns(name);
      } finally {
        dns--;
      }
    },
  });
  const reports = await Promise.all(['1.1.1.1', '8.8.8.8'].map((ip) => tester.query({ ip })));
  assert.ok(reports.every((r) => r.status === 'complete'));
  assert.equal(maxHttp, 4);
  assert.equal(maxDns, 4);
  assert.equal(http, 0);
  assert.equal(dns, 0);
});

test('source timeout aborts work and total timeout preserves finished sources', async () => {
  let aborted = 0;
  const tester = service({
    sourceTimeoutMs: 20,
    fetch: async (url, { signal }) => {
      if (qualityRequest(url).id === 'ipinfo') {
        try {
          await waitForAbort(signal);
        } finally {
          aborted++;
        }
      }
      return qualityFetch(url);
    },
  });
  const report = await tester.query({ ip: '1.1.1.1' });
  assert.equal(source(report, 'ipinfo').status, 'timeout');
  assert.equal(source(report, 'ipregistry').status, 'success');
  assert.equal(aborted, 1);
  const total = service({
    sourceTimeoutMs: 1000,
    queryTimeoutMs: 25,
    fetch: async (url, { signal }) => {
      if (qualityRequest(url).id === 'maxmind') return qualityFetch(url);
      return waitForAbort(signal);
    },
  });
  const partial = await total.query({ ip: '1.1.1.1' });
  assert.equal(source(partial, 'maxmind').status, 'success');
  assert.equal(source(partial, 'ipqs').status, 'timeout');
  assert.equal(partial.status, 'partial');
});

test('client cancellation drains active operations and cancels queued operations', async () => {
  let active = 0,
    started = 0;
  const tester = service({
    fetch: async (_url, { signal }) => {
      active++;
      started++;
      try {
        return await waitForAbort(signal);
      } finally {
        active--;
      }
    },
    resolve: async (_name, signal) => {
      active++;
      started++;
      try {
        return await waitForAbort(signal);
      } finally {
        active--;
      }
    },
  });
  const controller = new AbortController();
  const pending = tester.query({ ip: '1.1.1.1' }, controller.signal);
  await delay(5);
  assert.equal(active, 8);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(active, 0);
  assert.equal(started, 8);
});

test('DNSBL names, positive/negative checks and ambiguous codes retain honest states', async () => {
  assert.equal(reverseDnsblAddress('1.2.3.4'), '4.3.2.1');
  assert.equal(
    reverseDnsblAddress('::ffff:127.0.0.2'),
    '2.0.0.0.0.0.f.7.f.f.f.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0',
  );
  assert.equal(classifyDnsbl('dronebl', ['127.0.0.8', '127.0.0.13']).status, 'listed');
  for (const answers of [
    [],
    ['127.255.255.254'],
    ['198.18.0.1'],
    ['8.8.8.8'],
    ['127.0.0.2', '127.0.0.99'],
  ])
    assert.equal(classifyDnsbl('spamcop', answers).status, 'unknown');
  const list = ipQualityDnsblLists[0],
    signal = new AbortController().signal;
  let now = 0,
    calls = 0,
    healthBad = true;
  const dns = new IpQualityDnsbls(
    async (name) => {
      calls++;
      if (name.startsWith('2.0.0.127.') && healthBad) throw absent();
      return qualityDns(name);
    },
    () => now,
  );
  assert.equal((await dns.query(list, '1.1.1.1', 4, signal)).status, 'unavailable');
  assert.equal(calls, 2, 'no target lookup when health fails');
  healthBad = false;
  assert.equal((await dns.query(list, '1.1.1.1', 4, signal)).status, 'unavailable');
  assert.equal(calls, 2, 'failed health remains explicitly failed while cached');
  now = 600001;
  assert.equal((await dns.query(list, '1.1.1.1', 4, signal)).status, 'not_listed');
  const wildcard = new IpQualityDnsbls(async () => ['127.0.0.2']);
  assert.equal((await wildcard.query(list, '1.1.1.1', 4, signal)).status, 'unavailable');
  const error = new IpQualityDnsbls(async () => {
    throw Object.assign(new Error(), { code: 'ESERVFAIL' });
  });
  assert.equal((await error.query(list, '1.1.1.1', 4, signal)).status, 'unavailable');
  const slow = new IpQualityDnsbls((_name, abortSignal) => waitForAbort(abortSignal), Date.now, 10);
  assert.equal((await slow.query(list, '1.1.1.1', 4, signal)).status, 'timeout');
});

test('cache evicts beyond 100 IPs and expired registry keys are fetched again', async () => {
  let now = 0,
    pageCalls = 0;
  const tester = service({
    now: () => now,
    fetch: async (url) => {
      if (qualityRequest(url).id === 'registry-page') pageCalls++;
      return qualityFetch(url);
    },
  });
  for (let i = 1; i <= 101; i++) await tester.query({ ip: '1.1.2.' + i });
  assert.equal(source(await tester.query({ ip: '1.1.2.101' }), 'ipinfo').cached, true);
  assert.equal(source(await tester.query({ ip: '1.1.2.1' }), 'ipinfo').cached, false);
  assert.equal(pageCalls, 1);
  now += 3600001;
  await tester.query({ ip: '1.1.2.1' });
  assert.equal(pageCalls, 2);
});

async function makeApp(t, tester) {
  const password = 'IP-quality-local-test-only';
  const auth = new Auth(await hashPassword(password));
  t.after(() => auth.close());
  const resources = new UpstreamResources(new SubStoreClient('http://127.0.0.1:1'));
  resources.sync = async () => {
    throw new Error('IP queries must not need Sub-Store');
  };
  const config = { publicOrigin: 'http://127.0.0.1:3000', development: true };
  const app = createApp({
    resources,
    nodes: {},
    subscriptions: {},
    config,
    auth,
    ipQuality: tester,
  });
  const headers = {
    Origin: config.publicOrigin,
    'Content-Type': 'application/json',
    'X-SubMeld-Request': '1',
    Cookie: 'submeld-session=' + (await auth.login(password)),
  };
  return { app, headers, config };
}

test('IP query API requires auth and same-origin JSON, validates input and works without either upstream', async (t) => {
  const { app, headers } = await makeApp(t, service());
  const post = (data, changes = {}) =>
    app.request('/api/ip-quality/query', {
      method: 'POST',
      headers: { ...headers, ...changes },
      body: JSON.stringify(data),
    });
  assert.equal((await post({ ip: '1.1.1.1' }, { Cookie: '' })).status, 401);
  for (const changes of [
    { Origin: 'https://other.test' },
    { 'X-SubMeld-Request': '' },
    { 'Content-Type': 'text/plain' },
  ])
    assert.equal((await post({ ip: '1.1.1.1' }, changes)).status, 403);
  assert.equal((await post({ ip: '127.0.0.1' })).status, 400);
  const response = await post({ ip: '1.1.1.1' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(ipQualityReportSchema.parse(await response.json()).status, 'complete');
});

test('real HTTP socket disconnection aborts backend lookups', async (t) => {
  let started = 0,
    active = 0;
  const tester = service({
    fetch: async (_url, { signal }) => {
      active++;
      started++;
      try {
        return await waitForAbort(signal);
      } finally {
        active--;
      }
    },
  });
  const { app, headers, config } = await makeApp(t, tester);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  config.publicOrigin = 'http://127.0.0.1:' + server.address().port;
  const controller = new AbortController();
  const pending = fetch(config.publicOrigin + '/api/ip-quality/query', {
    method: 'POST',
    headers: { ...headers, Origin: config.publicOrigin },
    body: JSON.stringify({ ip: '1.1.1.1' }),
    signal: controller.signal,
  });
  const deadline = Date.now() + 2000;
  while (started < 4 && Date.now() < deadline) await delay(10);
  assert.equal(started, 4);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  while (active && Date.now() < deadline) await delay(10);
  assert.equal(active, 0);
  assert.equal(started, 4, 'queued lookups were cancelled too');
});
