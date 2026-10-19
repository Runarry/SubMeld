import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  telegramSettingsSchema,
  telegramSettingsPatchSchema,
  telegramTaskSchema,
  type TelegramSettings,
  type TelegramSettingsView,
  type TelegramProfile,
  type TelegramTask,
} from './shared/telegram.js';
import { validateSpeedSettings } from './miaospeed.js';
import { storedTelegramSettings } from './legacy-test-data.js';

export const QUEUE_TTL_MS = 30 * 60 * 1000;
const rowSchema = z.object({ value: z.string() });
export const unfinished = (task: TelegramTask) =>
  ['queued', 'preparing', 'running'].includes(task.state);
export class TelegramStore {
  constructor(
    private db: Database.Database,
    private defaults: () => TelegramProfile,
    private now = Date.now,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS telegram_tasks(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,update_id INTEGER NOT NULL,created_at TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(bot_id,update_id));',
    );
    for (const task of this.all()) {
      if (unfinished(task)) {
        task.state = 'interrupted';
        task.error = '服务重启，临时凭据已清除，请重新发送节点。';
        task.deliveryState = task.deliveryState === 'suppressed' ? 'suppressed' : 'pending';
        task.nextDeliveryAt = null;
        this.saveTask(task);
      } else if (task.deliveryState === 'sending') {
        task.deliveryState = 'pending';
        this.saveTask(task);
      }
    }
  }
  settings(): TelegramSettings {
    const row = rowSchema
      .optional()
      .parse(this.db.prepare("SELECT value FROM settings WHERE key='telegram.settings'").get());
    return telegramSettingsSchema.parse(
      storedTelegramSettings(row ? JSON.parse(row.value) : { profile: this.defaults() }),
    );
  }
  hasSettings() {
    return (
      this.db.prepare("SELECT 1 FROM settings WHERE key='telegram.settings'").get() !== undefined
    );
  }
  view(): TelegramSettingsView {
    const { token, proxyUrl, ...value } = this.settings();
    return {
      ...value,
      tokenConfigured: !!token,
      proxyConfigured: !!proxyUrl,
      proxyDisplay: proxyUrl ? new URL(proxyUrl).origin : null,
    };
  }
  update(input: unknown): TelegramSettings {
    const patch = telegramSettingsPatchSchema.parse(input);
    const next = telegramSettingsSchema.parse({ ...this.settings(), ...patch });
    next.allowedUserIds = [...new Set(next.allowedUserIds)];
    validateSpeedSettings(next.profile.settings);
    if (next.proxyUrl) {
      let valid = false;
      try {
        const proxy = new URL(next.proxyUrl);
        valid =
          ['http:', 'https:'].includes(proxy.protocol) &&
          !!proxy.hostname &&
          proxy.pathname === '/' &&
          !proxy.hash &&
          !proxy.search;
      } catch {
        /* Return only a static error, never proxy credentials. */
      }
      if (!valid)
        throw new AppError(
          'INVALID_REQUEST',
          '代理需要 HTTP(S) 地址，可包含认证信息，但不能包含路径、查询或片段。',
          400,
        );
    }
    if (next.enabled && (!next.token || !next.allowedUserIds.length))
      throw new AppError(
        'INVALID_REQUEST',
        '启用 Telegram 需要 Bot Token 和至少一个用户 ID。',
        400,
      );
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('telegram.settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(next));
    return next;
  }
  offset(botId: string): number {
    const row = rowSchema
      .optional()
      .parse(
        this.db.prepare('SELECT value FROM settings WHERE key=?').get('telegram.offset.' + botId),
      );
    return row ? z.number().int().nonnegative().parse(JSON.parse(row.value)) : 0;
  }
  advance(botId: string, updateId: number) {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('telegram.offset.' + botId, JSON.stringify(updateId + 1));
  }
  create(
    input: Pick<TelegramTask, 'botId' | 'userId' | 'chatId' | 'updateId' | 'messageId'>,
  ): TelegramTask {
    const task = telegramTaskSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + QUEUE_TTL_MS).toISOString(),
      state: 'queued',
      reportId: null,
      progressMessageId: null,
      total: 0,
      completed: 0,
      error: null,
      deliveryState: 'pending',
      deliveredParts: [],
      deliveryError: null,
      deliveryAttempts: 0,
      nextDeliveryAt: null,
    });
    this.db.transaction(() => {
      this.saveTask(task);
      this.advance(task.botId, task.updateId);
    })();
    return task;
  }
  saveTask(task: TelegramTask) {
    const value = telegramTaskSchema.parse(task);
    this.db
      .prepare(
        'INSERT INTO telegram_tasks(id,bot_id,update_id,created_at,value) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(value.id, value.botId, value.updateId, value.createdAt, JSON.stringify(value));
  }
  get(id: string): TelegramTask {
    const row = rowSchema
      .optional()
      .parse(this.db.prepare('SELECT value FROM telegram_tasks WHERE id=?').get(id));
    if (!row) throw new AppError('NOT_FOUND', 'Telegram 任务不存在。', 404);
    return telegramTaskSchema.parse(JSON.parse(row.value));
  }
  all(): TelegramTask[] {
    return z
      .array(rowSchema)
      .parse(this.db.prepare('SELECT value FROM telegram_tasks ORDER BY created_at,rowid').all())
      .map((r) => telegramTaskSchema.parse(JSON.parse(r.value)));
  }
  list(page = 0) {
    const tasks = z
      .array(rowSchema)
      .parse(
        this.db
          .prepare(
            'SELECT value FROM telegram_tasks ORDER BY created_at DESC,rowid DESC LIMIT 25 OFFSET ?',
          )
          .all(page * 25),
      )
      .map((r) => telegramTaskSchema.parse(JSON.parse(r.value)));
    const total = z
      .object({ n: z.number() })
      .parse(this.db.prepare('SELECT COUNT(*) n FROM telegram_tasks').get()).n;
    return { tasks, total };
  }
}
