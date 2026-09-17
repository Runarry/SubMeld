import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { openSettings } from '../dist/server/database.js';
import { hashPassword } from '../dist/server/auth.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';
import { node, items } from './fixtures.mjs';
import { ControlledConverter } from './publication-fixtures.mjs';

test('schema 6 upgrades once preserving nodes, snapshots, chains, references, artifacts and both token digests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'submeld-schema7-'));
  let settings;
  try {
    settings = openSettings(directory, true);
    settings.setPasswordHash(await hashPassword('schema-seven-test-password'));
    const converter = new ControlledConverter();
    const [entry, exit] = settings.nodes.create({
      drafts: [node('ss'), { ...node('ss'), name: 'exit' }],
    }).nodes;
    const source = await settings.sources.create(
      {
        name: 'source',
        format: 'uri',
        text: (await converter.run({ kind: 'produce', input: { items: items(node('ss')) } })).uri,
      },
      converter,
    );
    const chain = settings.chains.create({
      name: 'chain',
      entryNodeId: entry.id,
      exitNodeId: exit.id,
    });
    const subscription = settings.subscriptions.create({
      ...newSubscription(),
      name: 'plan',
      inputs: [
        { kind: 'source', id: source.id },
        { kind: 'node', id: entry.id },
        { kind: 'chain', id: chain.id },
      ],
    });
    settings.close();
    settings = undefined;
    const database = new Database(join(directory, 'submeld.sqlite'));
    database
      .prepare(
        'INSERT INTO artifacts(subscription_id,format,body,built_revision,engine_version,generated_at,counts_json,diagnostics_json) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        subscription.id,
        'uri',
        'preserved-test-artifact',
        1,
        'p4-2',
        '2026-09-17T00:00:00.000Z',
        '{"input":1,"output":1,"filtered":0}',
        '[]',
      );
    database.exec(
      'DROP TABLE node_test_results; ALTER TABLE sources DROP COLUMN snapshot_version; PRAGMA user_version=6;',
    );
    const tables = [
      'settings',
      'nodes',
      'sources',
      'chains',
      'subscriptions',
      'subscription_inputs',
      'artifacts',
    ];
    const before = Object.fromEntries(
      tables.map((table) => [table, database.prepare('SELECT * FROM ' + table).all()]),
    );
    database.close();
    for (let startup = 0; startup < 2; startup++) {
      settings = openSettings(directory, true);
      assert.equal(settings.sources.get(source.id).snapshotVersion, 1);
      assert.equal(settings.sources.get(source.id).revision, source.revision);
      assert.equal(settings.chains.get(chain.id).entryNodeId, entry.id);
      settings.close();
      settings = undefined;
      const check = new Database(join(directory, 'submeld.sqlite'));
      assert.equal(check.pragma('user_version', { simple: true }), 7);
      assert.deepEqual(check.pragma('foreign_key_check'), []);
      for (const table of tables) {
        let rows = check.prepare('SELECT * FROM ' + table).all();
        if (table === 'sources')
          rows = rows.map((row) => {
            const copy = { ...row };
            delete copy.snapshot_version;
            return copy;
          });
        assert.deepEqual(rows, before[table]);
      }
      check.close();
    }
  } finally {
    settings?.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        directory.includes('submeld-schema7-'),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});
