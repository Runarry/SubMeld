import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { fixture, waitFor } from './upstream-fixture.mjs';
import { controlledNetwork } from './miaospeed-fixture.mjs';
import { telegramFixture, telegramMessage } from './telegram-fixture.mjs';
import { TelegramClient } from '../dist/server/telegram-client.js';
import { TelegramService } from '../dist/server/telegram.js';
import { TelegramStore } from '../dist/server/telegram-store.js';
import { MiaospeedTester } from '../dist/server/miaospeed.js';
import { KernelManager } from '../dist/server/kernels.js';
import { createApp } from '../dist/server/app.js';
import { speedSettingsSchema } from '../dist/server/shared/miaospeed.js';
import { reportCsv } from '../dist/server/shared/report-export.js';

const token = '90001:public-test-only';
const raw = {
  name: 'Telegram fixture',
  type: 'ss',
  server: '127.0.0.1',
  port: 12345,
  cipher: 'aes-128-gcm',
  password: 'input-secret-public-test-only',
};
const content = JSON.stringify({ proxies: [raw] });
const profile = (scriptIds = []) => ({
  settings: speedSettingsSchema.parse({}),
  metrics: ['TEST_HTTP_CODE'],
  scriptIds,
});

async function setup(t, options = {}) {
  const f = await fixture(t),
    peer = await telegramFixture(),
    kernels = new KernelManager(f.directory);
  const speed = new MiaospeedTester(
    f.miaospeedStore,
    f.miaospeedScripts,
    f.miaospeedInput,
    kernels,
    f.converter,
    f.testActivity,
    f.config,
    async () => {},
  );
  const clients = [];
  const makeClient = (savedToken) => {
    const client = new TelegramClient(savedToken, null, { apiOrigin: peer.origin });
    clients.push(client);
    return client;
  };
  const service = new TelegramService(f.telegramStore, speed, {
    client: makeClient,
    intervalMs: 25,
    ...options,
  });
  let net, lease;
  const extras = [];
  f.beforeClose(async () => {
    for (const cleanup of extras.reverse()) await cleanup();
    await service.close();
    await speed.close();
    for (const client of clients) await client.close();
    await peer.close();
    await net?.close();
    await lease?.release();
    await kernels.close();
  });
  service.start();
  const app = createApp({
    ...f,
    miaospeed: speed,
    telegram: service,
    webRoot: resolve('dist/web'),
  });
  const headers = {
    Origin: f.config.publicOrigin,
    'Content-Type': 'application/json',
    'X-SubMeld-Request': '1',
    Cookie: f.cookie,
  };
  const request = (path, body, method = body === undefined ? 'GET' : 'POST', override = {}) =>
    app.request(path, {
      method,
      headers: { ...headers, ...override },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const enable = async (preset = profile()) => {
    await service.update({ enabled: true, token, allowedUserIds: ['101', '202'], profile: preset });
    await waitFor(() => service.status().state === 'connected');
  };
  return {
    ...f,
    peer,
    speed,
    kernels,
    service,
    makeClient,
    app,
    headers,
    request,
    enable,
    extras,
    async network() {
      await kernels.initialize();
      lease = kernels.snapshot();
      assert.equal(lease.binaries.size, 3, 'Official kernels must be prepared');
      net = await controlledNetwork(
        lease.binaries.get('singbox').path,
        join(f.directory, 'telegram-network'),
      );
      return net;
    },
  };
}

async function accepted(f, updateId, value, userId = 101) {
  f.peer.push(telegramMessage(updateId, value, userId));
  await waitFor(() => f.telegramStore.all().some((task) => task.updateId === updateId));
  return f.telegramStore.all().find((task) => task.updateId === updateId);
}

function taskDatabase(t) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  t.after(() => db.close());
  return db;
}

function historicalTask(overrides = {}) {
  return {
    id: randomUUID(),
    botId: '90001',
    userId: '101',
    chatId: '101',
    updateId: 7,
    messageId: 701,
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:30:00.000Z',
    state: 'completed',
    reportId: randomUUID(),
    progressMessageId: 1001,
    total: 2,
    completed: 2,
    error: null,
    deliveryState: 'sent',
    deliveredParts: ['summary', 'png:1', 'csv'],
    deliveryError: null,
    deliveryAttempts: 1,
    nextDeliveryAt: null,
    ...overrides,
  };
}

function legacyTasks(db, tasks) {
  db.exec(
    'CREATE TABLE telegram_tasks(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,update_id INTEGER NOT NULL,created_at TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(bot_id,update_id))',
  );
  const insert = db.prepare(
    'INSERT INTO telegram_tasks(rowid,id,bot_id,update_id,created_at,value) VALUES(?,?,?,?,?,?)',
  );
  for (const [index, task] of tasks.entries())
    insert.run(
      index * 3 + 2,
      task.id,
      task.botId,
      task.updateId,
      task.createdAt,
      JSON.stringify(task, null, 2),
    );
}

async function pollingService(t, store, peer) {
  // Exercise real polling and intake without starting a measurement worker in these protocol tests.
  const service = new TelegramService(store, undefined, {
    client: (savedToken) => new TelegramClient(savedToken, null, { apiOrigin: peer.origin }),
    intervalMs: 60000,
  });
  t.after(() => service.close());
  store.update({ enabled: true, token, allowedUserIds: ['101', '202'], profile: profile() });
  return service;
}

test('Telegram fixture acknowledges only through offsets and falls back from an invalid high offset', async (t) => {
  const peer = await telegramFixture();
  const client = new TelegramClient(token, null, { apiOrigin: peer.origin });
  t.after(async () => {
    await client.close();
    await peer.close();
  });
  const updates = [telegramMessage(10, content), telegramMessage(11, content)];
  peer.push(...updates);
  const get = (offset) =>
    client.call('getUpdates', { offset, timeout: 0 }, AbortSignal.timeout(5000));
  assert.deepEqual(await get(0), updates);
  assert.deepEqual(await get(10), updates, 'Reading a batch does not remove it');
  assert.deepEqual(await get(11), [updates[1]]);
  assert.deepEqual(await get(12), []);
  peer.resetQueue(telegramMessage(2, content), telegramMessage(3, content));
  assert.deepEqual(
    (await get(1000)).map((update) => update.update_id),
    [2, 3],
  );
  assert.deepEqual(
    (await get(2)).map((update) => update.update_id),
    [2, 3],
  );
  assert.deepEqual(await get(4), []);
});

test('Telegram task identity allows reused update IDs and advances duplicate messages atomically', (t) => {
  const db = taskDatabase(t),
    store = new TelegramStore(db, profile);
  const input = { botId: '90001', userId: '101', chatId: '101', updateId: 20, messageId: 100 };
  const first = store.create(input);
  assert.equal(first.created, true);
  const original = db.prepare('SELECT * FROM telegram_tasks WHERE id=?').get(first.task.id);
  const replay = store.create({ ...input, updateId: 30 });
  assert.equal(replay.created, false);
  assert.deepEqual(replay.task, first.task);
  assert.deepEqual(
    db.prepare('SELECT * FROM telegram_tasks WHERE id=?').get(first.task.id),
    original,
  );
  assert.equal(store.offset(input.botId), 31);
  assert.equal(store.create({ ...input, messageId: 101 }).created, true);
  assert.equal(store.create({ ...input, userId: '202', chatId: '202' }).created, true);
  assert.equal(store.create({ ...input, botId: '90002' }).created, true);
  assert.equal(store.all().length, 4);
  const before = db.prepare('SELECT * FROM telegram_tasks ORDER BY rowid').all();
  const offset = store.offset(input.botId);
  db.exec(
    "CREATE TRIGGER fail_offset BEFORE UPDATE ON settings WHEN NEW.key='telegram.offset.90001' BEGIN SELECT RAISE(ABORT,'offset write failed'); END",
  );
  assert.throws(
    () => store.create({ ...input, updateId: 40, messageId: 900 }),
    /offset write failed/,
  );
  assert.throws(() => store.create({ ...input, updateId: 41 }), /offset write failed/);
  assert.deepEqual(db.prepare('SELECT * FROM telegram_tasks ORDER BY rowid').all(), before);
  assert.equal(
    store.offset(input.botId),
    offset,
    'A failed offset write cannot leave a new task behind',
  );
});

test('Telegram legacy task migration preserves identities, ownership, raw history and column constraints', (t) => {
  const db = taskDatabase(t);
  const tasks = [
    historicalTask(),
    historicalTask({
      updateId: 8,
      userId: '202',
      chatId: '202',
      state: 'cancelled',
      error: '历史取消原因',
      deliveryState: 'suppressed',
    }),
  ];
  legacyTasks(db, tasks);
  db.prepare('INSERT INTO settings VALUES (?,?)').run('telegram.offset.90001', '100001');
  const before = db.prepare('SELECT rowid,* FROM telegram_tasks ORDER BY rowid').all();
  const columns = db.prepare('PRAGMA table_info(telegram_tasks)').all();
  const store = new TelegramStore(db, profile);
  const after = db.prepare('SELECT rowid,* FROM telegram_tasks ORDER BY rowid').all();
  assert.deepEqual(
    after.map(({ chat_id, message_id, ...row }) => {
      const task = tasks.find((task) => task.id === row.id);
      assert.equal(chat_id, task.chatId);
      assert.equal(message_id, task.messageId);
      return row;
    }),
    before,
  );
  const migratedColumns = db.prepare('PRAGMA table_info(telegram_tasks)').all();
  assert.deepEqual(migratedColumns.slice(0, columns.length), columns);
  for (const name of ['chat_id', 'message_id'])
    assert.equal(migratedColumns.find((column) => column.name === name).notnull, 1);
  assert.deepEqual(store.all(), tasks);
  assert.deepEqual(store.list().tasks, [...tasks].reverse());
  assert.equal(store.offset('90001'), 100001);
  assert.throws(
    () => store.saveTask({ ...tasks[0], id: randomUUID(), updateId: 9 }),
    /UNIQUE constraint failed/,
  );
  assert.deepEqual(
    new TelegramStore(db, profile).all(),
    tasks,
    'Reopening an upgraded table is idempotent',
  );
  assert.deepEqual(db.prepare('SELECT rowid,* FROM telegram_tasks ORDER BY rowid').all(), after);
});

test('Telegram legacy task migration rolls back every copied row and schema change on conflicting messages', (t) => {
  const db = taskDatabase(t);
  legacyTasks(db, [historicalTask(), historicalTask({ updateId: 8 })]);
  db.prepare('INSERT INTO settings VALUES (?,?)').run('telegram.offset.90001', '100001');
  const rows = db.prepare('SELECT rowid,* FROM telegram_tasks ORDER BY rowid').all();
  const schema = db
    .prepare("SELECT * FROM sqlite_master WHERE name LIKE '%telegram_tasks%' ORDER BY name")
    .all();
  assert.throws(() => new TelegramStore(db, profile), /UNIQUE constraint failed/);
  assert.deepEqual(db.prepare('SELECT rowid,* FROM telegram_tasks ORDER BY rowid').all(), rows);
  assert.deepEqual(
    db
      .prepare("SELECT * FROM sqlite_master WHERE name LIKE '%telegram_tasks%' ORDER BY name")
      .all(),
    schema,
  );
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key='telegram.offset.90001'").get().value,
    '100001',
  );
});

test('Telegram legacy task migration retains restart interruption and delivery checkpoints', (t) => {
  const db = taskDatabase(t);
  const tasks = ['queued', 'preparing', 'running', 'completed'].map((state, index) =>
    historicalTask({
      state,
      updateId: index + 1,
      messageId: index + 10,
      deliveryState: index === 0 ? 'suppressed' : 'sending',
      deliveredParts: ['summary', 'png:1'],
      nextDeliveryAt: '2026-10-23T00:00:00.000Z',
    }),
  );
  legacyTasks(db, tasks);
  const store = new TelegramStore(db, profile);
  for (const [index, original] of tasks.entries()) {
    const task = store.get(original.id);
    assert.equal(task.state, index < 3 ? 'interrupted' : 'completed');
    assert.equal(task.deliveryState, index === 0 ? 'suppressed' : 'pending');
    assert.equal(task.reportId, original.reportId);
    assert.equal(task.progressMessageId, original.progressMessageId);
    assert.deepEqual(task.deliveredParts, original.deliveredParts);
    if (index < 3) {
      assert.match(task.error, /服务重启/);
      assert.equal(task.nextDeliveryAt, null);
    }
    const replay = store.create({ ...original, updateId: 100 + index });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.task, task);
  }
  assert.equal(store.all().length, tasks.length);
  assert.deepEqual(new TelegramStore(db, profile).all(), store.all());
});

test('Telegram cursor recovers a lower queue after restart without replaying historical messages or same-batch IDs', async (t) => {
  const db = taskDatabase(t);
  let store = new TelegramStore(db, profile);
  const history = historicalTask();
  store.saveTask(history);
  store.advance('90001', 100000);
  store = new TelegramStore(db, profile);
  const peer = await telegramFixture();
  t.after(() => peer.close());
  const service = await pollingService(t, store, peer);
  service.start();
  await waitFor(() => peer.calls.filter((call) => call.method === 'getUpdates').length >= 2);
  assert.equal(store.offset('90001'), 100001, 'Empty polls do not reset the persisted offset');
  const message = (updateId, messageId, userId = 101) => {
    const update = telegramMessage(updateId, content, userId);
    update.message.message_id = messageId;
    return update;
  };
  peer.resetQueue(message(7, 702), message(8, 703, 202));
  await waitFor(() => store.offset('90001') === 9);
  assert.equal(store.all().length, 3);
  assert.deepEqual(store.get(history.id), history);
  const reused = store.all().find((task) => task.messageId === 702);
  assert.equal(reused.updateId, history.updateId, 'A new message may reuse a historical update ID');
  const pending = service.queue.get(reused.id);
  const sends = () =>
    peer.calls.filter((call) =>
      ['sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument'].includes(call.method),
    ).length;
  await waitFor(() =>
    peer.calls.some((call) => call.method === 'getUpdates' && call.body.offset === 9),
  );
  const beforeSends = sends();
  peer.push(message(9, 702), message(10, history.messageId));
  await waitFor(() => store.offset('90001') === 11);
  assert.equal(store.all().length, 3);
  assert.equal(service.queue.size, 2);
  assert.equal(
    service.queue.get(reused.id),
    pending,
    'Duplicate intake must not replace queued credentials',
  );
  assert.deepEqual(store.get(history.id), history);
  assert.equal(sends(), beforeSends, 'Replayed messages do not resend acknowledgements or results');
  peer.respond(
    { update_id: 'invalid' },
    message(11, 704),
    message(10, 705),
    message(11, 706),
    message(12, 707),
  );
  await waitFor(() => store.offset('90001') === 13);
  assert.deepEqual(
    store
      .all()
      .slice(3)
      .map((task) => task.messageId),
    [704, 707],
  );
  await service.close();
});

test('Telegram cursor fallback persists the first legal ID before receipt and resumes it after interruption', async (t) => {
  const db = taskDatabase(t),
    store = new TelegramStore(db, profile);
  store.advance('90001', 100000);
  const peer = await telegramFixture();
  t.after(() => peer.close());
  peer.resetQueue(telegramMessage(2, content));
  peer.respond({}, telegramMessage(2, content));
  const service = await pollingService(t, store, peer);
  let interrupted = false;
  service.receive = async () => {
    assert.equal(store.offset('90001'), 2, 'Reset to the first ID, never first ID + 1');
    interrupted = true;
    service.connection.abort();
  };
  service.start();
  await waitFor(() => interrupted);
  await service.close();
  assert.equal(store.all().length, 0);
  const recovered = new TelegramStore(db, profile);
  assert.equal(recovered.offset('90001'), 2);
  const restarted = await pollingService(t, recovered, peer);
  restarted.start();
  await waitFor(() => recovered.offset('90001') === 3);
  assert.equal(recovered.all().length, 1);
  assert.equal(recovered.all()[0].updateId, 2);
  assert.equal(restarted.queue.size, 1);
  await restarted.close();
});

test(
  'Telegram local protocol: authenticated settings, whitelist before parsing/download, private chat, deduplication and ownership',
  { timeout: 30000 },
  async (t) => {
    const f = await setup(t);
    const release = f.testActivity.acquire('kernel-check');
    f.extras.push(release);
    let previews = 0;
    const preview = f.miaospeedInput.preview.bind(f.miaospeedInput);
    f.miaospeedInput.preview = (...args) => {
      previews++;
      return preview(...args);
    };
    for (const path of ['/api/telegram/settings', '/api/telegram/status', '/api/telegram/tasks']) {
      assert.equal((await f.request(path, undefined, 'GET', { Cookie: '' })).status, 401);
    }
    assert.equal(
      (
        await f.request('/api/telegram/settings', { enabled: true }, 'PATCH', {
          Origin: 'http://evil.example',
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.request('/api/telegram/check', {}, 'POST', { 'X-SubMeld-Request': '' })).status,
      403,
    );
    const stored = await f.request(
      '/api/telegram/settings',
      { token, proxyUrl: 'http://proxy-user:proxy-secret@127.0.0.1:9999', profile: profile() },
      'PATCH',
    );
    assert.equal(stored.status, 200);
    const view = await stored.json();
    assert.equal(view.tokenConfigured, true);
    assert.equal(view.proxyDisplay, 'http://127.0.0.1:9999');
    assert.ok(!JSON.stringify(view).includes(token));
    assert.ok(!JSON.stringify(view).includes('proxy-secret'));
    await f.service.update({ proxyUrl: null });
    assert.equal(
      (await f.service.settings()).tokenConfigured,
      true,
      'A partial proxy update preserves the token',
    );
    await f.enable();
    f.peer.push(
      telegramMessage(1, { file_id: 'untrusted', file_size: 10 }, 303),
      telegramMessage(2, content, 303),
      telegramMessage(3, content, 101, { id: -100, type: 'group' }),
      telegramMessage(4, content, 101, { id: 202 }),
      telegramMessage(5, '/start', 303),
    );
    await waitFor(() => f.telegramStore.offset('90001') === 6);
    assert.equal(f.telegramStore.all().length, 0);
    assert.equal(previews, 0);
    assert.equal(f.peer.calls.filter((c) => c.method === 'getFile').length, 0);
    await waitFor(() =>
      f.peer.calls.some(
        (c) => c.method === 'sendMessage' && c.body.chat_id === 303 && c.body.text.includes('303'),
      ),
    );
    const task = await accepted(f, 6, content);
    f.peer.respond(
      telegramMessage(7, '/cancel ' + task.id, 202),
      telegramMessage(6, content),
      telegramMessage(7, content),
    );
    await waitFor(() => f.telegramStore.offset('90001') === 8);
    assert.equal(f.telegramStore.all().length, 1);
    assert.equal(f.telegramStore.get(task.id).state, 'queued');
    assert.equal(previews, 0, 'Shared kernel lock prevents Telegram parsing and testing');
    f.peer.push({
      update_id: 8,
      callback_query: {
        id: 'wrong-owner',
        from: { id: 202 },
        data: 'cancel:' + task.id,
        message: telegramMessage(0, '', 202).message,
      },
    });
    await waitFor(() => f.telegramStore.offset('90001') === 9);
    await waitFor(() =>
      f.peer.calls.some(
        (c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'wrong-owner',
      ),
    );
    assert.equal(f.telegramStore.get(task.id).state, 'queued');
    assert.ok(
      f.peer.calls.some(
        (c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'wrong-owner',
      ),
    );
    assert.equal(
      (await f.request('/api/telegram/tasks/' + task.id + '/cancel', {}, 'POST', { Cookie: '' }))
        .status,
      401,
    );
    f.peer.push(telegramMessage(9, '/cancel ' + task.id));
    await waitFor(() => f.telegramStore.get(task.id).state === 'cancelled');
    assert.equal(f.service.queue.size, 0, 'Cancelled queued credentials are released');
  },
);

test(
  'Telegram intake limits, missing/disabled scripts, expiry and configuration revocation release pending credentials',
  { timeout: 60000 },
  async (t) => {
    let now = Date.now();
    const f = await setup(t, { now: () => now });
    const release = f.testActivity.acquire('web');
    await f.enable(profile([randomUUID()]));
    // Telegram itself caps text below this size; call the intake boundary directly
    // so the HTTP client's independent envelope limit does not mask this check.
    await f.service.receive(
      telegramMessage(1, 'x'.repeat(4 * 1024 * 1024 + 1)),
      '90001',
      f.makeClient(token),
      AbortSignal.timeout(5000),
    );
    f.peer.push(telegramMessage(2, { file_id: 'too-large', file_size: 4 * 1024 * 1024 + 1 }));
    await waitFor(() => f.telegramStore.offset('90001') === 3);
    assert.equal(f.telegramStore.all().length, 0);
    assert.equal(f.peer.calls.filter((c) => c.method === 'getFile').length, 0);
    const expiring = await accepted(f, 3, content);
    now = Date.parse(expiring.expiresAt) + 1;
    await waitFor(() => f.telegramStore.get(expiring.id).state === 'expired');
    assert.equal(f.service.queue.size, 0);
    now = Date.now();
    const revoked = await accepted(f, 4, { file_id: 'revoked', file_size: 10 });
    await f.service.update({ allowedUserIds: ['202'] });
    const reduced = await f.service.settings();
    assert.equal(reduced.enabled, true, 'Whitelist edits preserve enabled state');
    assert.equal(reduced.tokenConfigured, true, 'Whitelist edits preserve the bot token');
    assert.deepEqual(reduced.allowedUserIds, ['202']);
    assert.equal(reduced.profile.scriptIds.length, 1, 'Whitelist edits preserve the preset');
    assert.equal(f.telegramStore.get(revoked.id).state, 'cancelled');
    assert.equal(f.telegramStore.get(revoked.id).deliveryState, 'suppressed');
    assert.equal(f.service.queue.size, 0);
    await f.service.update({ allowedUserIds: ['101', '202'] });
    const disabled = await accepted(f, 5, content);
    await f.service.update({ enabled: false });
    assert.equal(f.telegramStore.get(disabled.id).state, 'cancelled');
    assert.equal(f.telegramStore.get(disabled.id).deliveryState, 'suppressed');
    await f.enable(profile([randomUUID()]));
    const replacement = await accepted(f, 6, content);
    f.peer.setBotId(90002);
    await f.service.update({ token: '90002:replacement-public-test-only' });
    await waitFor(() => f.service.status().botId === '90002');
    assert.equal(f.telegramStore.get(replacement.id).state, 'cancelled');
    assert.equal(f.telegramStore.get(replacement.id).deliveryState, 'suppressed');
    release();
    const tooMany = await accepted(
      f,
      7,
      JSON.stringify({
        proxies: Array.from({ length: 2001 }, (_, i) => ({ ...raw, name: 'node-' + i })),
      }),
    );
    await waitFor(() => f.telegramStore.get(tooMany.id).state === 'failed');
    assert.match(f.telegramStore.get(tooMany.id).error, /2,000/);
    const missing = await accepted(f, 8, content);
    await waitFor(() => f.telegramStore.get(missing.id).state === 'failed');
    assert.match(f.telegramStore.get(missing.id).error, /删除或停用/);
    const catalog = await f.miaospeedScripts.put({
      name: 'Disabled acceptance script',
      enabled: false,
      timeoutMs: 1000,
      content: 'function handler(){return {text:"controlled"};}',
    });
    const script = catalog.scripts.find((s) => s.name === 'Disabled acceptance script');
    await f.service.update({ profile: profile([script.id]) });
    const stoppedScript = await accepted(f, 9, content);
    await waitFor(() => f.telegramStore.get(stoppedScript.id).state === 'failed');
    assert.match(f.telegramStore.get(stoppedScript.id).error, /删除或停用/);
    assert.equal(f.miaospeedInput.previews.size, 0, 'Failed input is discarded');
    assert.equal(
      f.miaospeedStore.list(0).reports.length,
      0,
      'No fake or partial engine report is created for invalid intake',
    );
    f.peer.files.set('oversize-download', { data: Buffer.alloc(4 * 1024 * 1024 + 1) });
    const oversizeDownload = await accepted(f, 10, { file_id: 'oversize-download' });
    await waitFor(() => f.telegramStore.get(oversizeDownload.id).state === 'failed');
    assert.match(f.telegramStore.get(oversizeDownload.id).error, /4 MiB/);
    f.peer.files.set('hanging-download', { data: Buffer.from(content), hang: true });
    const downloading = await accepted(f, 11, { file_id: 'hanging-download' });
    await waitFor(
      () =>
        f.telegramStore.get(downloading.id).state === 'preparing' &&
        f.peer.calls.some(
          (call) => call.method === 'getFile' && call.body.file_id === 'hanging-download',
        ),
    );
    f.service.cancel(downloading.id);
    await waitFor(() => f.service.preparingId === null);
    assert.equal(f.telegramStore.get(downloading.id).state, 'cancelled');
    assert.equal(f.service.queue.size, 0);
    assert.equal(f.miaospeedInput.previews.size, 0);
  },
);

test(
  'Telegram real isolated Sub-Store and miaospeed: text/file/URL FIFO, fixed preset, measured PNG/CSV and restart delivery checkpoints',
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      net = await f.network();
    const settings = { ...net.settings, pingUrl: 'https://fixture.example/ping' };
    const metrics = ['TEST_HTTP_CODE', 'SPEED_AVERAGE', 'USPEED_AVERAGE', 'UDP_TYPE'];
    const run = f.speed.client.run.bind(f.speed.client),
      executions = [];
    f.speed.client.run = (...args) => {
      executions.push(args[1].map((node) => JSON.parse(node.Payload)));
      args[0] = { ...args[0], pingUrl: `http://127.0.0.1:${net.port}/ping` };
      return run(...args);
    };
    const controlled = JSON.stringify({ proxies: [net.raw] });
    f.peer.files.set('controlled-file', { data: Buffer.from(controlled) });
    f.peer.setSubscription(controlled);
    const release = f.testActivity.acquire('kernel-check');
    await f.enable({ settings, metrics, scriptIds: [] });
    const first = await accepted(f, 1, controlled);
    const second = await accepted(f, 2, {
      file_id: 'controlled-file',
      file_size: Buffer.byteLength(controlled),
    });
    const third = await accepted(f, 3, f.peer.subscriptionUrl);
    await f.service.update({ profile: { settings, metrics: ['TEST_HTTP_CODE'], scriptIds: [] } });
    const changed = await f.service.settings();
    assert.equal(changed.enabled, true, 'Preset edits preserve enabled state');
    assert.equal(changed.tokenConfigured, true, 'Preset edits preserve the bot token');
    assert.deepEqual(changed.allowedUserIds, ['101', '202']);
    assert.deepEqual(changed.profile.metrics, ['TEST_HTTP_CODE']);
    assert.equal(executions.length, 0);
    f.peer.fail('sendDocument', {
      error_code: 429,
      description: 'fixture retry',
      parameters: { retry_after: 60 },
    });
    release();
    const tasks = [first, second, third];
    await waitFor(
      () =>
        tasks.every((task) =>
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(
            f.telegramStore.get(task.id).state,
          ),
        ),
      100000,
    );
    assert.deepEqual(
      tasks.map((task) => f.telegramStore.get(task.id).state),
      ['completed', 'completed', 'completed'],
      JSON.stringify(tasks.map((task) => f.telegramStore.get(task.id))),
    );
    assert.equal(executions.length, 3);
    assert.equal(f.peer.calls.filter((c) => c.method === 'getFile').length, 1);
    for (const task of tasks) {
      const current = f.telegramStore.get(task.id),
        report = f.miaospeedStore.get(current.reportId);
      assert.equal(report.origin, 'telegram');
      assert.equal(report.backendVersion, '4.7.6');
      assert.deepEqual(
        report.metrics,
        metrics,
        'Preset is frozen when each submission enters the queue',
      );
      assert.equal(report.results.length, 1);
      const measured = (id) => report.results[0].measurements.find((m) => m.id === id);
      assert.equal(measured('TEST_HTTP_CODE').value, '204, 204, 204');
      for (const id of ['SPEED_AVERAGE', 'USPEED_AVERAGE']) {
        assert.equal(measured(id).status, 'measured');
        assert.ok(measured(id).value > 0);
        assert.equal(measured(id).unit, 'B/s');
      }
      assert.equal(measured('UDP_TYPE').status, 'measured');
      assert.ok(!JSON.stringify(report).includes(net.raw.password));
      assert.ok(!JSON.stringify(report).includes(f.peer.subscriptionUrl));
    }
    const reports = tasks.map((task) =>
      f.miaospeedStore.get(f.telegramStore.get(task.id).reportId),
    );
    assert.ok(
      reports[0].finishedAt <= reports[1].createdAt &&
        reports[1].finishedAt <= reports[2].createdAt,
      'FIFO reports do not overlap',
    );
    assert.ok(net.counts.download > 100000 && net.counts.upload > 100000 && net.counts.stun >= 12);
    await waitFor(
      () =>
        f.telegramStore.get(first.id).deliveryState === 'failed' &&
        [second, third].every((task) => f.telegramStore.get(task.id).deliveryState === 'sent'),
      30000,
    );
    const checkpoint = f.telegramStore.get(first.id);
    assert.deepEqual(checkpoint.deliveredParts, ['summary', 'png:1']);
    assert.equal(checkpoint.deliveryAttempts, 1);
    for (const photo of f.peer.uploads.filter((u) => u.method === 'sendPhoto')) {
      assert.equal(photo.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(photo.data.readUInt32BE(16) > 0 && photo.data.readUInt32BE(20) > 0);
    }
    for (const report of reports.slice(1)) {
      const csv = f.peer.uploads.find((u) => u.name === `submeld-${report.id}.csv`);
      assert.equal(csv.data.toString('utf8'), reportCsv(report));
    }
    assert.equal(f.miaospeedInput.previews.size, 0, 'Real engine completion discards credentials');
    assert.deepEqual(
      await f.client.api('/api/subs'),
      [],
      'Temporary Telegram inputs never create native subscriptions',
    );
    await f.service.close();
    const db = new Database(join(f.directory, 'submeld-v2.sqlite'));
    f.extras.push(() => db.close());
    const persisted = db
      .prepare('SELECT value FROM telegram_tasks')
      .all()
      .map((row) => row.value)
      .join('\n');
    for (const secret of [
      net.raw.password,
      controlled,
      f.peer.subscriptionUrl,
      'controlled-file',
      token,
    ])
      assert.ok(!persisted.includes(secret));
    // Reproduce a crash after durable successful-part checkpoints, before final delivery state.
    f.telegramStore.saveTask({ ...checkpoint, deliveryState: 'sending' });
    const { task: interrupted } = f.telegramStore.create({
      botId: '90001',
      userId: '101',
      chatId: '101',
      updateId: 4,
      messageId: 5,
    });
    const recovered = new TelegramStore(db, () => profile());
    assert.equal(recovered.get(first.id).deliveryState, 'pending');
    assert.equal(recovered.get(interrupted.id).state, 'interrupted');
    assert.deepEqual(recovered.get(first.id).deliveredParts, ['summary', 'png:1']);
    const beforePhotos = f.peer.uploads.filter((u) => u.method === 'sendPhoto').length;
    const next = new TelegramService(recovered, f.speed, { client: f.makeClient, intervalMs: 25 });
    f.extras.push(() => next.close());
    next.start();
    await waitFor(() => recovered.get(first.id).deliveryState === 'sent', 15000);
    assert.equal(
      f.peer.uploads.filter((u) => u.method === 'sendPhoto').length,
      beforePhotos,
      'Restart does not resend completed PNG parts',
    );
    const firstCsv = f.peer.uploads.find((u) => u.name === `submeld-${reports[0].id}.csv`);
    assert.equal(firstCsv.data.toString('utf8'), reportCsv(reports[0]));
    assert.equal(recovered.offset('90001'), 5);
    assert.equal(
      executions.length,
      3,
      'Restart never resumes measurements without the original input',
    );
  },
);
