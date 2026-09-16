import Database from 'better-sqlite3';
import { createNodeStore } from './nodes.js';
import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export function openSettings(dataDir: string, development: boolean) {
  if (process.platform === 'win32' && !development)
    throw new Error('生产数据权限需要 Linux 容器；Windows 仅支持显式开发模式。');
  if (process.platform !== 'win32') process.umask(0o077);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataDir).isDirectory()) throw new Error('数据路径必须为独立目录。');
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
  // A separate SQLite write lock survives PID reuse/container namespaces and is
  // automatically released by the OS on a crash. It contains no business data.
  const lock = new Database(join(dataDir, 'instance.lock.sqlite'), { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE; PRAGMA user_version=1;');
  } catch {
    lock.close();
    throw new Error('数据目录正在使用，请先停止应用。');
  }
  let db: Database.Database | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      db?.close();
    } finally {
      lock.close();
    }
  };
  try {
    db = new Database(join(dataDir, 'submeld.sqlite'));
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    const version = db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1 && version !== 2)
      throw new Error('数据库版本不受支持，停止启动。');
    if (version === 0)
      db.transaction(() => {
        db?.exec(
          'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;',
        );
      })();
    if (version === 0 || version === 1)
      db.transaction(() => {
        db?.exec(`CREATE TABLE nodes (
          id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          revision INTEGER NOT NULL CHECK(revision > 0), model_version INTEGER NOT NULL,
          draft_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ); PRAGMA user_version = 2;`);
      })();
    if (process.platform !== 'win32') {
      for (const file of readdirSync(dataDir))
        if (file.startsWith('submeld.sqlite') || file.startsWith('instance.lock.sqlite'))
          chmodSync(join(dataDir, file), 0o600);
    }
    const database = db;
    return {
      nodes: createNodeStore(database),
      getPasswordHash(): string | undefined {
        const row: unknown = database
          .prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'")
          .get();
        if (row === undefined) return undefined;
        return z.object({ value: z.string().startsWith('$argon2id$') }).parse(row).value;
      },
      setPasswordHash(hash: string) {
        z.string().startsWith('$argon2id$').parse(hash);
        database
          .prepare(
            "INSERT INTO settings(key,value) VALUES ('admin_password_hash', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(hash);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
