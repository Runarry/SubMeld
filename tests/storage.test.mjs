import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { verify } from 'argon2';
import Database from 'better-sqlite3';
import { openSettings } from '../dist/server/database.js';
import { hashPassword } from '../dist/server/auth.js';
import { loadConfig } from '../dist/server/config.js';
function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'submeld-test-'));
  return {
    path,
    cleanup() {
      assert.ok(resolve(path).startsWith(resolve(tmpdir())));
      assert.ok(path.includes('submeld-test-'));
      rmSync(path, { recursive: true, force: true });
    },
  };
}
test('new settings initialize once, preserve password hashes and enforce single instance', async () => {
  const dir = temporary();
  let settings;
  try {
    settings = openSettings(dir.path, true);
    assert.equal(settings.getPasswordHash(), undefined);
    const hash = await hashPassword('only-a-test-password');
    settings.setPasswordHash(hash);
    const resolverToken = settings.certificateResolverToken();
    assert.match(resolverToken, /^[a-f0-9]{64}$/);
    assert.throws(() => openSettings(dir.path, true), /正在使用/);
    settings.close();
    settings = undefined;
    const reopened = openSettings(dir.path, true);
    assert.equal(reopened.getPasswordHash(), hash);
    assert.equal(reopened.certificateResolverToken(), resolverToken);
    reopened.close();
    const db = new Database(join(dir.path, 'submeld-v2.sqlite'));
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
        .sort(),
      ['settings', 'node_test_results', 'speed_reports', 'speed_results', 'telegram_tasks'].sort(),
    );
    db.close();
    assert.equal(
      readFileSync(join(dir.path, 'submeld-v2.sqlite')).includes(
        Buffer.from('only-a-test-password'),
      ),
      false,
    );
  } finally {
    settings?.close();
    dir.cleanup();
  }
});
test('unsupported migration version stops and releases directory lock', () => {
  const dir = temporary();
  try {
    const settings = openSettings(dir.path, true);
    settings.close();
    const db = new Database(join(dir.path, 'submeld-v2.sqlite'));
    db.pragma('user_version=99');
    db.close();
    assert.throws(() => openSettings(dir.path, true), /版本/);
    assert.throws(() => openSettings(dir.path, true), /版本/);
  } finally {
    dir.cleanup();
  }
});
async function cli(dir, command, password) {
  const child = spawn(process.execPath, ['dist/server/cli.js', command, '--dev'], {
    env: { ...process.env, PUBLIC_ORIGIN: 'http://127.0.0.1:5173', DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += String(c)));
  child.stderr.on('data', (c) => (output += String(c)));
  child.stdin.end(password + '\n');
  const [code] = await once(child, 'close');
  return { code, output };
}
test('maintenance CLI initializes and resets through stdin only when stopped', async () => {
  const dir = temporary();
  const password = 'stdin-only-test-password';
  try {
    const init = await cli(dir.path, 'init', password);
    assert.equal(init.code, 0);
    assert.ok(!init.output.includes(password));
    const settings = openSettings(dir.path, true);
    assert.equal(await verify(settings.getPasswordHash(), password), true);
    const locked = await cli(dir.path, 'reset-password', 'new-test-password');
    assert.notEqual(locked.code, 0);
    settings.close();
    assert.notEqual((await cli(dir.path, 'init', password)).code, 0);
    assert.equal((await cli(dir.path, 'reset-password', 'new-test-password')).code, 0);
    const reopened = openSettings(dir.path, true);
    assert.equal(await verify(reopened.getPasswordHash(), 'new-test-password'), true);
    reopened.close();
  } finally {
    dir.cleanup();
  }
});
test('HTTP requires loopback development or an explicit production opt-in', () => {
  assert.throws(() =>
    loadConfig(false, { PUBLIC_ORIGIN: 'http://127.0.0.1:3000', DATA_DIR: 'data' }),
  );
  assert.throws(() => loadConfig(true, { PUBLIC_ORIGIN: 'http://example.com', DATA_DIR: 'data' }));
  assert.throws(() =>
    loadConfig(true, { PUBLIC_ORIGIN: 'http://127.0.0.1:5173/path', DATA_DIR: 'data' }),
  );
  assert.throws(() => loadConfig(true, {}));
  assert.equal(
    loadConfig(true, { PUBLIC_ORIGIN: 'http://127.0.0.1:5173', DATA_DIR: 'data' }).development,
    true,
  );
  const env = { PUBLIC_ORIGIN: 'http://192.168.5.12:3012', DATA_DIR: 'data' };
  assert.throws(() => loadConfig(false, env));
  assert.throws(() => loadConfig(false, { ...env, ALLOW_HTTP: 'false' }));
  const configured = loadConfig(false, { ...env, ALLOW_HTTP: 'true', PORT: '3012' });
  assert.equal(configured.publicOrigin, env.PUBLIC_ORIGIN);
  assert.equal(configured.development, false);
  assert.equal(configured.port, 3012);
  assert.throws(() =>
    loadConfig(false, { ...env, ALLOW_HTTP: 'true', PUBLIC_ORIGIN: 'ftp://192.168.5.12' }),
  );
});

test('listener configuration validates ports and the IPv4 chain bind address', () => {
  const env = { PUBLIC_ORIGIN: 'https://submeld.example', DATA_DIR: 'data' };
  assert.equal(loadConfig(false, env).port, 3000);
  assert.equal(loadConfig(false, env).miaospeedBridgeBind, '0.0.0.0');
  assert.equal(
    loadConfig(false, { ...env, MIAOSPEED_BRIDGE_BIND: '172.26.12.2' }).miaospeedBridgeBind,
    '172.26.12.2',
  );
  for (const PORT of ['', '0', '65536', '3012.5', '3e3', 'invalid'])
    assert.throws(() => loadConfig(false, { ...env, PORT }));
  for (const MIAOSPEED_BRIDGE_BIND of ['', 'submeld', '::1', '999.1.1.1'])
    assert.throws(() => loadConfig(false, { ...env, MIAOSPEED_BRIDGE_BIND }));
  assert.equal(loadConfig(false, env).hy2ResolverOrigin, 'http://submeld:3000');
  for (const MIAOSPEED_BRIDGE_HOST of ['192.168.1.10', '::1'])
    assert.equal(
      loadConfig(true, {
        ...env,
        PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
        MIAOSPEED_BRIDGE_HOST,
        PORT: '3012',
      }).hy2ResolverOrigin,
      'http://host.docker.internal:3012',
    );
  assert.equal(
    loadConfig(false, { ...env, HY2_RESOLVER_ORIGIN: 'http://[::1]:3012' }).hy2ResolverOrigin,
    'http://[::1]:3012',
  );
  for (const HY2_RESOLVER_ORIGIN of [
    'ftp://localhost',
    'http://user:secret@localhost',
    'http://localhost/path',
  ])
    assert.throws(() => loadConfig(false, { ...env, HY2_RESOLVER_ORIGIN }));
});

test('empty v2 business definitions upgrade while preserving account settings and legacy test records', async () => {
  const dir = temporary();
  let settings;
  try {
    const hash = await hashPassword('migration-test-only');
    const db = new Database(join(dir.path, 'submeld-v2.sqlite'));
    db.exec(
      'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE nodes(id TEXT PRIMARY KEY); CREATE TABLE sources(id TEXT PRIMARY KEY); CREATE TABLE chains(id TEXT PRIMARY KEY); CREATE TABLE subscriptions(id TEXT PRIMARY KEY); CREATE TABLE subscription_inputs(id TEXT); CREATE TABLE artifacts(id TEXT); CREATE TABLE node_test_results(key TEXT PRIMARY KEY,node_id TEXT REFERENCES nodes(id),result_json TEXT NOT NULL); PRAGMA user_version=1;',
    );
    db.prepare('INSERT INTO settings VALUES (?,?)').run('admin_password_hash', hash);
    db.prepare('INSERT INTO node_test_results VALUES (?,NULL,?)').run(
      'legacy-reference',
      '{"legacy":true}',
    );
    db.close();
    settings = openSettings(dir.path, true);
    assert.equal(settings.getPasswordHash(), hash);
    settings.close();
    settings = undefined;
    const upgraded = new Database(join(dir.path, 'submeld-v2.sqlite'), { readonly: true });
    assert.equal(upgraded.pragma('user_version', { simple: true }), 3);
    assert.equal(
      upgraded
        .prepare('SELECT result_json FROM node_test_results WHERE key=?')
        .get('legacy-reference').result_json,
      '{"legacy":true}',
    );
    assert.deepEqual(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name),
      ['node_test_results', 'settings', 'speed_reports', 'speed_results', 'telegram_tasks'],
    );
    upgraded.close();
  } finally {
    settings?.close();
    dir.cleanup();
  }
});
