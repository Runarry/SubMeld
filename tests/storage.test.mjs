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
test('settings migrate once, preserve password hashes and enforce single instance', async () => {
  const dir = temporary();
  let settings;
  try {
    settings = openSettings(dir.path, true);
    assert.equal(settings.getPasswordHash(), undefined);
    const hash = await hashPassword('only-a-test-password');
    settings.setPasswordHash(hash);
    assert.throws(() => openSettings(dir.path, true), /正在使用/);
    settings.close();
    settings = undefined;
    const reopened = openSettings(dir.path, true);
    assert.equal(reopened.getPasswordHash(), hash);
    reopened.close();
    const db = new Database(join(dir.path, 'submeld.sqlite'));
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
        .sort(),
      ['settings', 'nodes', 'sources', 'subscriptions', 'subscription_inputs', 'artifacts'].sort(),
    );
    db.close();
    assert.equal(
      readFileSync(join(dir.path, 'submeld.sqlite')).includes(Buffer.from('only-a-test-password')),
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
    const db = new Database(join(dir.path, 'submeld.sqlite'));
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
test('HTTP is only available with explicit loopback development configuration', () => {
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
});
