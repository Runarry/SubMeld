import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { MiaospeedStore } from '../dist/server/miaospeed-store.js';
import { TelegramStore } from '../dist/server/telegram-store.js';
import { speedSettingsSchema, speedRequestSchema } from '../dist/server/shared/miaospeed.js';
import { testSelectionSchema } from '../dist/server/shared/node-tests.js';
import { reportCsv } from '../dist/server/shared/report-export.js';

function database(t) {
  const db = new Database(':memory:');
  db.exec(
    'PRAGMA foreign_keys=ON; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  );
  t.after(() => db.close());
  return db;
}
function nodeResult(index = 0, state = 'completed') {
  return {
    index,
    subject: {
      kind: 'node',
      resourceId: randomUUID(),
      revision: 'a'.repeat(64),
      snapshotHash: 'b'.repeat(64),
      nodeIndex: index,
    },
    name: 'ordinary-' + index,
    protocol: 'ss',
    state,
    stale: false,
    message: '',
    testedAt: '2026-10-19T00:00:00.000Z',
    coreVersion: null,
    measurements: [],
  };
}
const retiredResult = () => ({
  subject: { kind: 'chain', id: 'invalid legacy id' },
  name: 'retired-secret-name',
});
function seed(db, results, sequence = 0, state = 'completed') {
  const id = randomUUID();
  const at = new Date(Date.UTC(2026, 9, 19, 0, 0, sequence)).toISOString();
  const meta = {
    id,
    origin: 'web',
    name: 'history-' + sequence,
    state,
    createdAt: at,
    finishedAt: state === 'running' ? null : at,
    backendVersion: '4.7.6',
    settings: { ...speedSettingsSchema.parse({}), chainCore: { obsolete: true } },
    metrics: ['TEST_HTTP_CODE'],
    scripts: [],
    total: results.length,
    completed: state === 'running' ? 0 : results.length,
    current: null,
    error: null,
  };
  db.prepare('INSERT INTO speed_reports VALUES (?,?,?)').run(id, at, JSON.stringify(meta));
  for (const [position, row] of results.entries())
    db.prepare('INSERT INTO speed_results VALUES (?,?,?)').run(id, position, JSON.stringify(row));
  return id;
}
function snapshot(db) {
  return {
    reports: db.prepare('SELECT * FROM speed_reports ORDER BY id').all(),
    results: db.prepare('SELECT * FROM speed_results ORDER BY report_id,position').all(),
    settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
  };
}

test('stored speed and Telegram settings ignore only the retired key without rewriting originals', (t) => {
  const db = database(t),
    store = new MiaospeedStore(db);
  const legacy = {
    ...speedSettingsSchema.parse({ nodeCore: 'xray' }),
    chainCore: 'invalid-retired-core',
  };
  db.prepare('INSERT INTO settings VALUES (?,?)').run('miaospeed.settings', JSON.stringify(legacy));
  const profile = { settings: legacy, metrics: ['TEST_HTTP_CODE'], scriptIds: [] };
  db.prepare('INSERT INTO settings VALUES (?,?)').run(
    'telegram.settings',
    JSON.stringify({ profile }),
  );
  const before = snapshot(db);
  const telegram = new TelegramStore(db, () => profile);
  assert.equal(store.settings().nodeCore, 'xray');
  assert.equal(telegram.settings().profile.settings.nodeCore, 'xray');
  assert.equal('chainCore' in store.settings(), false);
  assert.equal('chainCore' in telegram.view().profile.settings, false);
  assert.deepEqual(snapshot(db), before);
  assert.throws(() => store.updateSettings(legacy));
  assert.throws(() => telegram.update({ profile }));
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(
    JSON.stringify({ ...legacy, nodeCore: 'invalid-active-core' }),
    'miaospeed.settings',
  );
  assert.throws(() => store.settings());
});

test('legacy mixed reports expose only ordinary results and pure reports are absent before pagination', (t) => {
  const db = database(t),
    store = new MiaospeedStore(db);
  const mixed = seed(db, [retiredResult(), nodeResult(7)]);
  for (let index = 1; index <= 30; index++) seed(db, [retiredResult()], index);
  for (let index = 31; index <= 55; index++) seed(db, [nodeResult()], index);
  const before = snapshot(db);
  assert.equal(store.list(0).total, 26);
  assert.equal(store.list(0).reports.length, 25);
  assert.equal(store.list(1).reports.length, 1);
  assert.equal(store.list(1).reports[0].id, mixed);
  const report = store.get(mixed);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].index, 7);
  assert.equal(report.total, 1);
  assert.equal(report.completed, 1);
  assert.equal('chainCore' in report.settings, false);
  assert.doesNotMatch(reportCsv(report), /chainCore|retired-secret-name|链内核/);
  assert.deepEqual(snapshot(db), before);
});

test('restarting with unfinished legacy reports never parses chain payloads or rewrites their history', (t) => {
  const db = database(t);
  new MiaospeedStore(db);
  const pure = seed(db, [retiredResult()], 0, 'running');
  const mixed = seed(db, [nodeResult(0, 'pending'), retiredResult()], 1, 'running');
  const before = snapshot(db);
  const restarted = new MiaospeedStore(db);
  assert.equal(restarted.list(0).total, 1);
  assert.equal(restarted.list(0).reports[0].state, 'interrupted');
  assert.equal(restarted.get(mixed).state, 'interrupted');
  assert.equal(restarted.get(mixed).results[0].state, 'cancelled');
  assert.throws(() => restarted.get(pure), { code: 'NOT_FOUND' });
  assert.deepEqual(snapshot(db), before);
});

test('retired subjects are not accepted for new tests and unrelated bad history remains invalid', (t) => {
  const db = database(t),
    store = new MiaospeedStore(db);
  assert.equal(
    testSelectionSchema.safeParse({ subjects: [{ kind: 'chain', id: randomUUID() }] }).success,
    false,
  );
  assert.equal(
    speedRequestSchema.safeParse({
      name: 'retired',
      subjects: [{ kind: 'chain', id: randomUUID() }],
      metrics: ['TEST_HTTP_CODE'],
      scripts: [],
      settings: speedSettingsSchema.parse({}),
    }).success,
    false,
  );
  const id = seed(db, [retiredResult(), { ...nodeResult(), state: 'invalid-active-state' }]);
  assert.throws(() => store.get(id));
});
