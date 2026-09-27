import { SubStoreClient } from './sub-store.js';
import { UpstreamResources } from './upstream-resources.js';
import Database from 'better-sqlite3';
import { createNodeStore } from './nodes.js';
import { createChainStore } from './chains.js';
import { createSourceStore } from './sources.js';
import { createSubscriptionStore } from './subscriptions.js';
import { chmodSync, lstatSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createNodeTestStore } from './node-test-store.js';
import { KoipySettingsStore } from './koipy.js';

export function openSettings(
  dataDir: string,
  development: boolean,
  client = new SubStoreClient(),
  koipyConfigPath = join(dataDir, 'koipy/config.yaml'),
) {
  if (process.platform === 'win32' && !development)
    throw new Error('生产数据权限需要 Linux 容器；Windows 仅支持显式开发模式。');
  if (process.platform !== 'win32') process.umask(0o077);
  if (existsSync(join(dataDir, 'submeld.sqlite')))
    throw new Error('旧版数据目录不会自动迁移，请为上游版本配置新目录。');
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
    db = new Database(join(dataDir, 'submeld-v2.sqlite'));
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    const version = db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) throw new Error('增强数据库版本不受支持。');
    if (version === 0)
      db.transaction(() => {
        db?.exec(`
        CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE nodes (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,upstream_name TEXT NOT NULL,upstream_type TEXT NOT NULL,
          enabled INTEGER NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,present INTEGER NOT NULL,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,protocol TEXT
        );
        CREATE TABLE sources (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,upstream_name TEXT NOT NULL,upstream_type TEXT NOT NULL,
          enabled INTEGER NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,present INTEGER NOT NULL,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
          snapshot_hash TEXT NOT NULL DEFAULT '',saved_at TEXT,node_count INTEGER NOT NULL DEFAULT 0,last_attempt_at TEXT,error_json TEXT
        );
        CREATE TABLE chains (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,
          entry_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
          exit_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK(entry_node_id != exit_node_id)
        );
        CREATE INDEX chain_entry ON chains(entry_node_id);
        CREATE INDEX chain_exit ON chains(exit_node_id);
        CREATE TABLE subscriptions (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,
          config_json TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,key_hash TEXT UNIQUE
        );
        CREATE TABLE subscription_inputs (
          subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,position INTEGER NOT NULL,
          node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
          chain_id TEXT REFERENCES chains(id) ON DELETE CASCADE,PRIMARY KEY(subscription_id,position),
          CHECK((node_id IS NOT NULL)+(source_id IS NOT NULL)+(chain_id IS NOT NULL)=1)
        );
        CREATE INDEX subscription_node ON subscription_inputs(node_id);
        CREATE INDEX subscription_source ON subscription_inputs(source_id);
        CREATE INDEX subscription_chain ON subscription_inputs(chain_id);
        CREATE TABLE artifacts (
          subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,format TEXT NOT NULL,
          body TEXT,built_revision INTEGER,engine_version TEXT,generated_at TEXT,counts_json TEXT,diagnostics_json TEXT,error_json TEXT,
          PRIMARY KEY(subscription_id,format)
        );
        CREATE TABLE node_test_results (
          key TEXT PRIMARY KEY,node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
          chain_id TEXT REFERENCES chains(id) ON DELETE CASCADE,result_json TEXT NOT NULL,
          CHECK((node_id IS NOT NULL)+(source_id IS NOT NULL)+(chain_id IS NOT NULL)=1)
        );
        CREATE INDEX node_test_source ON node_test_results(source_id);
        PRAGMA user_version=1;
      `);
      })();
    if (process.platform !== 'win32') {
      for (const file of readdirSync(dataDir))
        if (file.startsWith('submeld-v2.sqlite') || file.startsWith('instance.lock.sqlite'))
          chmodSync(join(dataDir, file), 0o600);
    }
    const database = db;
    const subscriptions = createSubscriptionStore(database);
    const resources = new UpstreamResources(database, client, subscriptions);
    const nodes = createNodeStore(database, resources);
    const chains = createChainStore(database, nodes, subscriptions);
    const sources = createSourceStore(database, resources);
    return {
      koipy: new KoipySettingsStore(database, koipyConfigPath),
      resources,
      nodes,
      chains,
      sources,
      nodeTests: createNodeTestStore(database, nodes, chains, sources),
      subscriptions,
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
