import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { fixture, waitFor } from './upstream-fixture.mjs';

const evidence = resolve('.cache/machine-acceptance');
const remote = '/tmp/submeld-machine-acceptance-20261019-' + randomUUID();
const source = remote + '/source';
const host = 'host-vps-scripts';
const ssh = (command) =>
  execFileSync('ssh', [host, command], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
const scp = (file, target) =>
  execFileSync('scp', [file, host + ':' + target], { windowsHide: true, timeout: 60000 });

test('real Linux Agent and native vpsctl snapshot preserve existing records through official Sub-Store', async (t) => {
  const f = await fixture(t);
  mkdirSync(evidence, { recursive: true });
  ssh(
    `mkdir -p ${source} ${remote}/root/var/lib/vpsctl/service/proxy ${remote}/state && chmod 700 ${remote} ${remote}/state`,
  );
  const archive = resolve(evidence, 'vps-source.tar');
  execFileSync(
    'tar',
    ['-cf', archive, '-C', resolve('../vps-script-lite'), 'bin', 'commands', 'lib', 'VERSION'],
    { windowsHide: true },
  );
  scp(archive, remote + '/vps-source.tar');
  ssh(`tar -xf ${remote}/vps-source.tar -C ${source}`);
  const node = {
    id: 'node-0123456789abcdef',
    core: 'sing-box',
    profile: 'shadowsocks-aes-256-gcm',
    name: 'native-existing',
    listen: '127.0.0.1',
    port: 33490,
    address: 'existing.example',
    ip_strategy: 'prefer_ipv6',
    created_at: '2026-10-19T00:00:00Z',
    updated_at: '2026-10-19T00:00:00Z',
    credentials: {
      password: 'acceptance-public-test-password',
      uuid: '',
      username: '',
      private_key: '',
      public_key: '',
      short_id: '',
      shadowtls_password: '',
    },
    tls: {
      enabled: false,
      mode: 'none',
      server_name: '',
      certificate_path: '',
      key_path: '',
      insecure: false,
      certificate_sha256: '',
      certificate_id: '',
    },
    transport: { type: 'tcp', path: '', service_name: '', flow: '' },
    options: {
      method: 'aes-256-gcm',
      padding: false,
      shadowtls: false,
      obfs_type: '',
      obfs_password: '',
      up_mbps: 0,
      down_mbps: 0,
      congestion_control: '',
    },
    future_native_field: { retained: ['opaque-native-value'] },
  };
  const relay = {
    schema_version: 1,
    exits: [
      {
        id: 'exit-0123456789abcdef',
        name: 'native-direct-exit',
        type: 'direct',
        endpoint: { host: '192.0.2.20', port: 443 },
        network_hint: 'both',
        created_at: '',
        updated_at: '',
        native_extension: { retained: true },
      },
    ],
    bindings: [],
    forwards: [],
  };
  for (const [name, data] of [
    ['nodes.json', { schema_version: 1, nodes: [node] }],
    ['relay.json', relay],
  ]) {
    writeFileSync(resolve(evidence, name), JSON.stringify(data));
    scp(resolve(evidence, name), remote + '/root/var/lib/vpsctl/service/proxy/' + name);
  }
  const wrapper = `#!/bin/bash\nexport VPSCTL_TESTING=1 VPSCTL_SYSTEM_ROOT=${remote}/root\nexec /bin/bash ${source}/bin/vpsctl "$@"\n`;
  writeFileSync(resolve(evidence, 'vpsctl'), wrapper);
  scp(resolve(evidence, 'vpsctl'), remote + '/vpsctl');
  scp(resolve('dist/agent/submeld-agent-linux-amd64'), remote + '/agent');
  ssh(`chmod 700 ${remote}/vpsctl ${remote}/agent`);
  const native = JSON.parse(
    ssh(`${remote}/vpsctl --non-interactive service proxy machine snapshot`),
  );
  assert.deepEqual(native.nodes, [node]);
  assert.deepEqual(native.relay, relay);
  writeFileSync(resolve(evidence, 'native-snapshot.json'), JSON.stringify(native, null, 2));

  const enrolled = f.machines.create({ name: 'actual Linux Agent' });
  let deliveries = 0;
  const deliveryAttempts = new Map();
  const server = serve({
    fetch: async (request) => {
      const resultId =
        new URL(request.url).pathname === '/api/agent/results'
          ? (await request.clone().json()).result.requestId
          : undefined;
      const response = await f.app.fetch(request);
      if (resultId && response.status === 200) {
        deliveries++;
        const attempts = (deliveryAttempts.get(resultId) ?? 0) + 1;
        deliveryAttempts.set(resultId, attempts);
        // Lose the first acknowledgement after the panel persisted its receipt.
        if (attempts === 1) return new Response('controlled lost acknowledgement', { status: 503 });
      }
      return response;
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  if (!server.listening) await new Promise((done) => server.once('listening', done));
  const remotePort = 42193;
  writeFileSync(
    resolve(evidence, 'agent-config.json'),
    JSON.stringify({
      server: 'http://127.0.0.1:' + remotePort,
      machineId: enrolled.machine.id,
      token: enrolled.token,
      vpsctl: remote + '/vpsctl',
      stateDir: remote + '/state',
      allowHttp: true,
    }),
  );
  scp(resolve(evidence, 'agent-config.json'), remote + '/config.json');
  ssh(`chmod 600 ${remote}/config.json`);
  const agent = spawn(
    'ssh',
    [
      '-o',
      'ExitOnForwardFailure=yes',
      '-R',
      `127.0.0.1:${remotePort}:127.0.0.1:${server.address().port}`,
      host,
      `exec ${remote}/agent run --config ${remote}/config.json`,
    ],
    { windowsHide: true },
  );
  let logs = '';
  agent.stdout.on('data', (data) => {
    logs += data;
  });
  agent.stderr.on('data', (data) => {
    logs += data;
  });
  f.beforeClose(async () => {
    ssh(`pkill -f '^${remote}/agent run --config ${remote}/config.json$' || true`);
    agent.kill();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    writeFileSync(resolve(evidence, 'agent.log'), logs);
  });
  await waitFor(() => f.machines.list()[0].revision === native.revision, 45000);
  const stored = await f.machines.getPrivateSnapshot(enrolled.machine.id);
  assert.deepEqual(stored.nativeManifest, native.nativeManifest);
  assert.deepEqual(stored.nodes, native.nodes);
  assert.deepEqual(stored.relay, native.relay);
  assert.deepEqual(stored.exports, native.exports);
  const projected = f.resources.record(enrolled.machine.resourceId).record;
  assert.equal(projected.content, native.exports.map((item) => item.uri).join('\n'));
  const parsed = await f.resources.preview(enrolled.machine.resourceId);
  assert.equal(parsed.rows.length, 1);

  const { task } = await f.machines.enqueue(enrolled.machine.id, {
    action: 'node.add',
    expectedRevision: native.revision,
    params: { unsupported: 'acceptance-secret-should-not-leak' },
  });
  await waitFor(() => f.machines.task(task.id).status === 'failed' && deliveries >= 2, 45000);
  assert.equal(f.machines.task(task.id).resultRevision, native.revision);
  const receipts = JSON.parse(ssh(`cat ${remote}/state/results/${task.id}.json`));
  assert.equal(receipts.result.status, 'failed');
  const after = JSON.parse(
    ssh(`${remote}/vpsctl --non-interactive service proxy machine snapshot`),
  );
  assert.deepEqual(after.nodes, native.nodes);
  assert.deepEqual(after.relay, native.relay);
  assert.equal(after.revision, native.revision);
  const applied = await f.machines.enqueue(enrolled.machine.id, {
    action: 'exit.add',
    expectedRevision: native.revision,
    params: { name: 'central-added-direct', target: '192.0.2.30', 'target-port': 8443 },
  });
  await waitFor(
    () =>
      f.machines.task(applied.task.id).status === 'applied' &&
      deliveryAttempts.get(applied.task.id) >= 2,
    45000,
  );
  const updated = JSON.parse(
    ssh(`${remote}/vpsctl --non-interactive service proxy machine snapshot`),
  );
  assert.deepEqual(updated.nodes, native.nodes);
  assert.deepEqual(
    updated.relay.exits.find((item) => item.id === relay.exits[0].id),
    relay.exits[0],
  );
  const added = updated.relay.exits.filter((item) => item.name === 'central-added-direct');
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].endpoint, { host: '192.0.2.30', port: 8443 });
  assert.notEqual(updated.revision, native.revision);
  assert.equal(f.machines.task(applied.task.id).resultRevision, updated.revision);
  const current = await f.machines.getPrivateSnapshot(enrolled.machine.id);
  assert.deepEqual(current.relay, updated.relay);
  assert.equal(current.revision, updated.revision);
  writeFileSync(resolve(evidence, 'applied-snapshot.json'), JSON.stringify(updated, null, 2));
  assert.equal(logs.includes(enrolled.token), false);
  assert.equal(logs.includes('acceptance-secret-should-not-leak'), false);
  writeFileSync(
    resolve(evidence, 'result-summary.json'),
    JSON.stringify(
      {
        snapshotRevision: native.revision,
        nativeNodeCount: native.nodes.length,
        nativeExitCount: native.relay.exits.length,
        agentAcknowledgementAttempts: deliveries,
        taskStatus: f.machines.task(task.id).status,
        nativeStateUnchanged: true,
        successfulMutationStatus: f.machines.task(applied.task.id).status,
        successfulMutationAcknowledgements: deliveryAttempts.get(applied.task.id),
        addedDirectExitCount: added.length,
        appliedRevision: updated.revision,
        remote,
      },
      null,
      2,
    ),
  );
});
