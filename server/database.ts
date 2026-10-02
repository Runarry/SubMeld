import Database from 'better-sqlite3';
import { chmodSync, lstatSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SubStoreClient } from './sub-store.js';
import { UpstreamResources } from './upstream-resources.js';
import { UpstreamFiles } from './upstream-files.js';
import { createNodeStore } from './nodes.js';
import { createChainStore } from './chains.js';
import { createSubscriptionStore } from './subscriptions.js';
import { createNodeTestStore } from './node-test-store.js';
import { TestActivity } from './test-activity.js';
import { MiaospeedStore } from './miaospeed-store.js';
import { MiaospeedScripts } from './miaospeed-scripts.js';
import { MiaospeedInput } from './miaospeed-input.js';
import { TelegramStore } from './telegram-store.js';
import { metricIds } from './shared/miaospeed.js';
import { NodeReporting } from './node-reporting.js';
export function openSettings(dataDir: string, development: boolean, client = new SubStoreClient()) {
  if (process.platform === 'win32' && !development)
    throw new Error('生产数据权限需要 Linux 容器；Windows 仅支持显式开发模式。');
  if (process.platform !== 'win32') process.umask(0o077);
  if (existsSync(join(dataDir, 'submeld.sqlite')))
    throw new Error('旧版数据目录不会自动迁移，请为上游版本配置新目录。');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataDir).isDirectory()) throw new Error('数据路径必须为独立目录。');
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
  const lock = new Database(join(dataDir, 'instance.lock.sqlite'), { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE; PRAGMA user_version=1;');
  } catch {
    lock.close();
    throw new Error('数据目录正在使用，请先停止应用。');
  }
  let input: MiaospeedInput | undefined;
  let db: Database.Database | undefined,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input?.close();
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
    if (![0, 1, 2, 3].includes(Number(version))) throw new Error('增强数据库版本不受支持。');
    if (version === 1) {
      const count = z
        .object({ n: z.number() })
        .parse(
          db
            .prepare('SELECT (SELECT COUNT(*) FROM chains)+(SELECT COUNT(*) FROM subscriptions) n')
            .get(),
        ).n;
      if (count)
        throw new Error(
          '旧链或增强方案仍存在；本版不自动搬迁它们，请保留原数据库并使用新的数据目录。',
        );
      db.transaction(() =>
        db!.exec(
          'CREATE TABLE preserved_test_results(key TEXT PRIMARY KEY,result_json TEXT NOT NULL); INSERT INTO preserved_test_results SELECT key,result_json FROM node_test_results; DROP TABLE node_test_results; ALTER TABLE preserved_test_results RENAME TO node_test_results; DROP TABLE artifacts; DROP TABLE subscription_inputs; DROP TABLE subscriptions; DROP TABLE chains; DROP TABLE nodes; DROP TABLE sources; PRAGMA user_version=2;',
        ),
      )();
    }
    db.exec(
      'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS node_test_results(key TEXT PRIMARY KEY,result_json TEXT NOT NULL); PRAGMA user_version=3;',
    );
    if (process.platform !== 'win32')
      for (const file of readdirSync(dataDir))
        if (file.startsWith('submeld-v2.sqlite') || file.startsWith('instance.lock.sqlite'))
          chmodSync(join(dataDir, file), 0o600);
    const database = db,
      resources = new UpstreamResources(client),
      files = new UpstreamFiles(resources);
    const nodes = createNodeStore(resources),
      chains = createChainStore(resources, files),
      subscriptions = createSubscriptionStore(resources, files);
    input = new MiaospeedInput(resources, chains);
    const miaospeedStore = new MiaospeedStore(database);
    const miaospeedScripts = new MiaospeedScripts(resources);
    const telegramStore = new TelegramStore(database, () => ({
      settings: miaospeedStore.settings(),
      metrics: [...metricIds],
      scriptIds: miaospeedScripts
        .list()
        .scripts.filter((script) => script.enabled)
        .map((script) => script.id),
    }));
    return {
      resources,
      files,
      nodes,
      nodeReporting: new NodeReporting(database, resources),
      chains,
      subscriptions,
      testActivity: new TestActivity(),
      miaospeedStore,
      miaospeedScripts,
      telegramStore,
      miaospeedInput: input,
      nodeTests: createNodeTestStore(database, resources, chains),
      getPasswordHash(): string | undefined {
        const row: unknown = database
          .prepare("SELECT value FROM settings WHERE key='admin_password_hash'")
          .get();
        return row === undefined
          ? undefined
          : z.object({ value: z.string().startsWith('$argon2id$') }).parse(row).value;
      },
      setPasswordHash(hash: string) {
        z.string().startsWith('$argon2id$').parse(hash);
        database
          .prepare(
            "INSERT INTO settings(key,value) VALUES ('admin_password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
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
