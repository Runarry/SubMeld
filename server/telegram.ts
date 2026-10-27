import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AppError } from './errors.js';
import { TelegramClient, TelegramApiError } from './telegram-client.js';
import { TelegramStore, unfinished } from './telegram-store.js';
import type { MiaospeedTester } from './miaospeed.js';
import type { BackendConnection } from './miaospeed-backends.js';
import { MAX_BYTES } from './shared/contracts.js';
import { type SpeedPreview, type SpeedReport, previewInputSchema } from './shared/miaospeed.js';
import {
  telegramTaskLabels,
  telegramSettingsPatchSchema,
  type TelegramProfile,
  type TelegramStatus,
  type TelegramTask,
} from './shared/telegram.js';
import { reportCsv } from './shared/report-export.js';
import { reportImages } from './telegram-report.js';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const messageSchema = z.object({
  message_id: id,
  from: z.object({ id, is_bot: z.boolean().optional() }).optional(),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  text: z.string().optional(),
  document: z
    .object({ file_id: z.string(), file_size: z.number().int().nonnegative().optional() })
    .optional(),
});
const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id, is_bot: z.boolean().optional() }),
      message: messageSchema.optional(),
      data: z.string().optional(),
    })
    .optional(),
});
const updateEnvelopeSchema = updateSchema.pick({ update_id: true });
type Input = z.infer<typeof previewInputSchema> | { kind: 'telegram-file'; fileId: string };
type Pending = {
  input?: Input;
  profile: TelegramProfile;
  backend: BackendConnection;
  preview?: SpeedPreview;
  abort: AbortController;
};
const safeError = (error: unknown) =>
  error instanceof AppError ? error.message : '操作未完成，请检查连接或重新提交。';
const messageId = (value: unknown) => z.object({ message_id: id }).parse(value).message_id;
const retryDelay = (error: unknown, attempts: number) =>
  error instanceof TelegramApiError && error.retryAfterMs
    ? error.retryAfterMs
    : Math.min(60000, 2000 * 2 ** Math.min(attempts, 5));

export class TelegramService {
  private client: TelegramClient | undefined;
  private connection = new AbortController();
  private pollTask: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private worker: Promise<void> | undefined;
  private delivery: Promise<void> | undefined;
  private preparingId: string | null = null;
  private deliveringId: string | null = null;
  private activeId: string | null = null;
  private queue = new Map<string, Pending>();
  private progressAt = new Map<string, number>();
  private progressBusy = new Set<string>();
  private closed = false;
  private started = false;
  private control: Promise<unknown> = Promise.resolve();
  private value: Omit<TelegramStatus, 'queued' | 'activeTaskId'> = {
    state: 'disabled',
    botId: null,
    username: null,
    error: null,
    checkedAt: null,
  };
  constructor(
    readonly store: TelegramStore,
    private speed: MiaospeedTester,
    private options: {
      client?: (token: string, proxyUrl: string | null) => TelegramClient;
      now?: () => number;
      intervalMs?: number;
    } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private makeClient() {
    const config = this.store.settings();
    if (!config.token) throw new AppError('TELEGRAM_UNCONFIGURED', '请先保存 Bot Token。', 400);
    return (
      this.options.client?.(config.token, config.proxyUrl) ??
      new TelegramClient(config.token, config.proxyUrl)
    );
  }
  status(): TelegramStatus {
    return {
      ...this.value,
      queued: [...this.queue.keys()].filter((key) => this.store.get(key).state === 'queued').length,
      activeTaskId: this.activeId ?? this.preparingId,
    };
  }
  async settings() {
    if (!this.store.hasSettings()) await this.speed.input.resources.sync();
    return this.store.view();
  }
  private patch(id: string, patch: Partial<TelegramTask>) {
    const task = { ...this.store.get(id), ...patch };
    this.store.saveTask(task);
    return task;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.control.then(operation);
    this.control = next.catch(() => {});
    return next;
  }
  update(input: unknown) {
    return this.serial(async () => {
      const before = this.store.settings();
      const patch = telegramSettingsPatchSchema.parse(input);
      const profile = patch.profile ?? before.profile;
      if ((patch.enabled ?? before.enabled) || patch.profile?.backendId) {
        if (!profile.backendId)
          throw new AppError('MIAOSPEED_UNCONFIGURED', '请先选择 Telegram 测速服务。', 400);
        this.speed.captureBackend(profile.backendId, profile.settings.nodeCore);
      }
      const after = this.store.update(patch);
      for (const task of this.store.all()) {
        if (!after.enabled || !after.allowedUserIds.includes(task.userId)) {
          if (unfinished(task)) this.cancel(task.id);
          if (!['sent', 'suppressed'].includes(task.deliveryState))
            this.patch(task.id, { deliveryState: 'suppressed', nextDeliveryAt: null });
        }
      }
      if (
        before.token !== after.token ||
        before.proxyUrl !== after.proxyUrl ||
        before.enabled !== after.enabled
      )
        await this.connect();
      return this.store.view();
    });
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    void this.serial(() => this.connect()).catch((error) => {
      this.value.state = 'error';
      this.value.error = safeError(error);
    });
    this.schedule();
  }
  private async identity(client: TelegramClient, signal: AbortSignal) {
    const bot = z
      .object({ id, is_bot: z.literal(true), username: z.string().optional() })
      .parse(await client.call('getMe', {}, signal));
    const webhook = z
      .object({ url: z.string() })
      .parse(await client.call('getWebhookInfo', {}, signal));
    if (webhook.url)
      throw new AppError(
        'TELEGRAM_CONFLICT',
        '此机器人已配置 Webhook，请先停止原服务并移除 Webhook。',
        409,
      );
    return { botId: String(bot.id), username: bot.username ?? null };
  }
  check() {
    return this.serial(async () => {
      if (this.store.settings().enabled) {
        await this.connect();
        return this.status();
      }
      const client = this.makeClient();
      try {
        this.value = {
          ...this.value,
          ...(await this.identity(client, AbortSignal.timeout(15000))),
          error: null,
          checkedAt: new Date(this.now()).toISOString(),
          state: 'disabled',
        };
      } catch (error) {
        this.value = {
          ...this.value,
          error: safeError(error),
          checkedAt: new Date(this.now()).toISOString(),
        };
      } finally {
        await client.close();
      }
      return this.status();
    });
  }
  private async stopConnection() {
    this.connection.abort();
    await this.pollTask;
    await this.client?.close();
    this.client = undefined;
    this.pollTask = undefined;
  }
  private async connect() {
    await this.stopConnection();
    this.value = { ...this.value, state: 'disabled', error: null, botId: null, username: null };
    if (this.closed || !this.store.settings().enabled) return;
    this.connection = new AbortController();
    const signal = this.connection.signal;
    this.value.state = 'connecting';
    try {
      this.client = this.makeClient();
    } catch (error) {
      this.value.state = 'error';
      this.value.error = safeError(error);
      return;
    }
    // One worker owns the polling offset and retries; HTTP service startup never waits for Telegram.
    this.pollTask = this.poll(this.client, signal);
  }
  private async poll(client: TelegramClient, signal: AbortSignal) {
    let botId: string | undefined;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!botId) {
          const identity = await this.identity(client, signal);
          if (signal.aborted) return;
          botId = identity.botId;
          this.value = {
            ...identity,
            state: 'connected',
            error: null,
            checkedAt: new Date(this.now()).toISOString(),
          };
          for (const task of this.store.all())
            if (task.botId !== botId) {
              if (unfinished(task)) this.cancel(task.id);
              if (!['sent', 'suppressed'].includes(task.deliveryState))
                this.patch(task.id, { deliveryState: 'suppressed', nextDeliveryAt: null });
            }
        }
        const requestedOffset = this.store.offset(botId);
        const updates = z.array(z.unknown()).parse(
          await client.call(
            'getUpdates',
            {
              offset: requestedOffset,
              timeout: 30,
              allowed_updates: ['message', 'callback_query'],
            },
            signal,
          ),
        );
        if (signal.aborted) return;
        const first = updates
          .map((update) => updateEnvelopeSchema.safeParse(update))
          .find((envelope) => envelope.success);
        // Bot API falls back to the queue head when a saved offset exceeds its new tail.
        if (first?.success && first.data.update_id < requestedOffset)
          this.store.setOffset(botId, first.data.update_id);
        for (const update of updates) {
          if (signal.aborted) return;
          await this.receive(update, botId, client, signal);
        }
        failures = 0;
        this.value.state = 'connected';
        this.value.error = null;
        // Empty test responses and a misbehaving remote must not create a hot loop.
        if (!updates.length) await delay(250, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        this.value.state = 'error';
        this.value.error = safeError(error);
        if (
          (error instanceof TelegramApiError && [401, 409].includes(error.telegramCode)) ||
          (error instanceof AppError && error.code === 'TELEGRAM_CONFLICT')
        )
          return;
        try {
          await delay(retryDelay(error, failures++), undefined, { signal });
        } catch {
          return;
        }
      }
    }
  }
  private permitted(task: TelegramTask) {
    const config = this.store.settings();
    return (
      !this.closed &&
      config.enabled &&
      this.value.botId === task.botId &&
      config.allowedUserIds.includes(task.userId) &&
      task.deliveryState !== 'suppressed'
    );
  }
  private async reply(
    client: TelegramClient,
    chatId: number | string,
    text: string,
    signal: AbortSignal,
    extra: Record<string, unknown> = {},
  ) {
    return client.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: Array.from(text).slice(0, 4000).join(''),
        link_preview_options: { is_disabled: true },
        ...extra,
      },
      signal,
    );
  }
  private async receive(raw: unknown, botId: string, client: TelegramClient, signal: AbortSignal) {
    const envelope = updateEnvelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.update_id < this.store.offset(botId)) return;
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) {
      this.store.advance(botId, envelope.data.update_id);
      return;
    }
    const update = parsed.data;
    const message = update.message ?? update.callback_query?.message;
    const from = update.callback_query?.from ?? message?.from;
    if (
      !message ||
      !from ||
      from.is_bot ||
      message.chat.type !== 'private' ||
      message.chat.id !== from.id
    ) {
      this.store.advance(botId, update.update_id);
      return;
    }
    const userId = String(from.id);
    const allowed = this.store.settings().allowedUserIds.includes(userId);
    const text = message.text?.trim() ?? '';
    if (update.callback_query || text.startsWith('/') || !allowed) {
      this.store.advance(botId, update.update_id);
      try {
        if (update.callback_query) {
          const query = update.callback_query;
          let answer = '没有权限操作此任务。';
          if (allowed && query.data?.startsWith('cancel:')) {
            const task = this.owned(query.data.slice(7), botId, userId);
            this.cancel(task.id);
            answer = '已请求取消，已有结果保留。';
          }
          await client.call(
            'answerCallbackQuery',
            { callback_query_id: query.id, text: answer },
            signal,
          );
        } else if (/^\/(start|help)(?:@\w+)?(?:\s|$)/.test(text)) {
          await this.reply(
            client,
            from.id,
            `你的 Telegram 用户 ID：${userId}\n${allowed ? '发送节点文本、一个订阅链接或配置文件即可自动排队测速。\n/status 查看任务\n/cancel <任务号> 取消自己的任务\n/result <任务号> 获取结果\n每份输入最多 4 MiB、2,000 个节点；排队 30 分钟过期。' : '请由管理员将此 ID 加入白名单。'}`,
            signal,
          );
        } else if (allowed) {
          const [command, taskId] = text.split(/\s+/);
          const name = command?.split('@')[0];
          if (name === '/status') {
            const tasks = this.store
              .all()
              .filter((task) => task.botId === botId && task.userId === userId)
              .slice(-8)
              .reverse();
            await this.reply(
              client,
              from.id,
              tasks.length
                ? tasks.map((task) => this.description(task)).join('\n\n')
                : '还没有测速任务。',
              signal,
            );
          } else if (name === '/cancel' || name === '/result') {
            if (!taskId)
              throw new AppError(
                'INVALID_REQUEST',
                '请在命令后填写任务号，可用 /status 查看。',
                400,
              );
            const task = this.owned(taskId, botId, userId);
            if (name === '/cancel') this.cancel(task.id);
            else this.resend(task.id);
            await this.reply(
              client,
              from.id,
              name === '/cancel' ? '已请求取消，已有结果保留。' : '结果已加入回传队列。',
              signal,
            );
          } else
            await this.reply(
              client,
              from.id,
              '请发送节点文本、订阅链接或配置文件；/help 查看用法。',
              signal,
            );
        }
      } catch (error) {
        if (signal.aborted) return;
        // Command errors contain no submitted payload or credentials.
        if (!(error instanceof TelegramApiError)) {
          if (update.callback_query)
            await client
              .call(
                'answerCallbackQuery',
                {
                  callback_query_id: update.callback_query.id,
                  text: safeError(error),
                },
                signal,
              )
              .catch(() => {});
          else await this.reply(client, from.id, safeError(error), signal).catch(() => {});
        }
      }
      return;
    }
    let input: Input;
    const profile = structuredClone(this.store.settings().profile);
    let backend: BackendConnection;
    try {
      if (!profile.backendId)
        throw new AppError('MIAOSPEED_UNCONFIGURED', '请先选择 Telegram 测速服务。', 400);
      backend = this.speed.captureBackend(profile.backendId, profile.settings.nodeCore);
      if (message.document) {
        if ((message.document.file_size ?? 0) > MAX_BYTES)
          throw new AppError('INPUT_LIMIT_EXCEEDED', '配置文件不能超过 4 MiB。', 413);
        input = { kind: 'telegram-file', fileId: message.document.file_id };
      } else {
        if (!text) {
          this.store.advance(botId, update.update_id);
          return;
        }
        if (Buffer.byteLength(text, 'utf8') > MAX_BYTES)
          throw new AppError('INPUT_LIMIT_EXCEEDED', '节点文本不能超过 4 MiB。', 413);
        input = previewInputSchema.parse(
          /^https?:\/\/\S+$/i.test(text)
            ? { kind: 'url', url: text }
            : { kind: 'text', content: text },
        );
      }
    } catch (error) {
      this.store.advance(botId, update.update_id);
      await this.reply(client, from.id, safeError(error), signal).catch(() => {});
      return;
    }
    const { task, created } = this.store.create({
      botId,
      userId,
      chatId: userId,
      updateId: update.update_id,
      messageId: message.message_id,
    });
    if (!created) return;
    this.queue.set(task.id, {
      input,
      profile,
      backend,
      abort: new AbortController(),
    });
    await this.progress(task.id);
  }
  private owned(taskId: string, botId: string, userId: string) {
    const task = this.store.get(taskId);
    if (task.botId !== botId || task.userId !== userId)
      throw new AppError('FORBIDDEN', '只能操作自己提交的任务。', 403);
    return task;
  }
  private description(task: TelegramTask) {
    const ahead = [...this.queue.keys()]
      .filter((key) => this.store.get(key).state === 'queued')
      .indexOf(task.id);
    return `任务 ${task.id}\n${telegramTaskLabels[task.state]}${task.state === 'queued' && ahead >= 0 ? ` · 排队位置 ${ahead + 1}` : ''}${task.total ? ` · ${task.completed}/${task.total}` : ''}${task.error ? '\n' + task.error : ''}${task.reportId ? '\n报告 ' + task.reportId : ''}`;
  }
  private async progress(taskId: string) {
    if (this.progressBusy.has(taskId)) return;
    let task = this.store.get(taskId);
    const last = this.progressAt.get(taskId);
    if (!this.client || !this.permitted(task) || (last !== undefined && this.now() - last < 5000))
      return;
    this.progressBusy.add(taskId);
    this.progressAt.set(taskId, this.now());
    const signal = this.connection.signal;
    try {
      const markup = {
        inline_keyboard: unfinished(task)
          ? [[{ text: '取消任务', callback_data: 'cancel:' + task.id }]]
          : [],
      };
      if (task.progressMessageId) {
        await this.client.call(
          'editMessageText',
          {
            chat_id: task.chatId,
            message_id: task.progressMessageId,
            text: this.description(task),
            reply_markup: markup,
          },
          signal,
        );
      } else {
        const sent = await this.reply(this.client, task.chatId, this.description(task), signal, {
          reply_parameters: { message_id: task.messageId, allow_sending_without_reply: true },
          reply_markup: markup,
        });
        this.patch(task.id, { progressMessageId: messageId(sent) });
      }
    } catch (error) {
      if (this.closed) return;
      if (error instanceof TelegramApiError && error.retryAfterMs)
        this.progressAt.set(taskId, this.now() + error.retryAfterMs);
      task = this.store.get(taskId);
      if (
        !signal.aborted &&
        !(error instanceof TelegramApiError && error.notModified) &&
        task.deliveryState !== 'suppressed'
      )
        this.patch(task.id, { deliveryError: safeError(error) });
    } finally {
      this.progressBusy.delete(taskId);
    }
  }
  cancel(taskId: string) {
    const task = this.store.get(taskId);
    if (!unfinished(task)) return task;
    const pending = this.queue.get(taskId);
    pending?.abort.abort();
    if (pending) {
      pending.backend.token = '';
      pending.input = undefined;
      if (pending.preview) this.speed.input.discard([pending.preview.id]);
    }
    this.queue.delete(taskId);
    if (task.reportId) {
      try {
        const report = this.speed.cancel(task.reportId);
        if (report.state === 'running')
          return this.patch(taskId, { error: '正在取消，等待后端当前项结束。' });
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
      }
    }
    return this.patch(taskId, { state: 'cancelled', error: '任务已取消。' });
  }
  resend(taskId: string) {
    const task = this.store.get(taskId);
    const config = this.store.settings();
    if (
      this.closed ||
      !config.enabled ||
      task.botId !== this.value.botId ||
      !config.allowedUserIds.includes(task.userId)
    )
      throw new AppError('TELEGRAM_UNAVAILABLE', '当前机器人或白名单不允许回传此任务。', 409);
    if (unfinished(task) || this.deliveringId === taskId)
      throw new AppError('TEST_BUSY', '任务或回传仍在进行中。', 409);
    return this.patch(taskId, {
      deliveryState: 'pending',
      deliveredParts: task.deliveryState === 'sent' ? [] : task.deliveredParts,
      deliveryAttempts: 0,
      nextDeliveryAt: null,
      deliveryError: null,
    });
  }
  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      try {
        this.tick();
      } catch {
        this.value.error = 'Telegram 任务状态处理失败，请检查服务状态。';
      }
      this.schedule();
    }, this.options.intervalMs ?? 1000);
    this.timer.unref();
  }
  private tick() {
    for (const [key, pending] of this.queue) {
      const task = this.store.get(key);
      if (task.state === 'queued' && Date.parse(task.expiresAt) <= this.now()) {
        pending.backend.token = '';
        pending.abort.abort();
        pending.input = undefined;
        if (pending.preview) this.speed.input.discard([pending.preview.id]);
        this.queue.delete(key);
        this.patch(key, {
          state: 'expired',
          error: '排队超过 30 分钟，临时内容已清除，请重新发送。',
        });
      }
    }
    if (this.activeId) {
      const task = this.store.get(this.activeId);
      try {
        const report = this.speed.store.get(task.reportId!);
        this.patch(task.id, {
          state: report.state === 'running' ? 'running' : report.state,
          total: report.total,
          completed: report.completed,
          error: report.error ?? (report.state === 'running' ? task.error : null),
        });
        void this.progress(task.id);
        if (report.state !== 'running' && !this.speed.status().active) this.activeId = null;
      } catch (error) {
        if (!this.speed.status().active) {
          this.patch(task.id, { state: 'failed', error: safeError(error) });
          this.activeId = null;
        }
      }
    }
    if (
      !this.worker &&
      !this.activeId &&
      !this.speed.status().active &&
      this.value.botId &&
      this.store.settings().enabled
    ) {
      const next = [...this.queue.keys()].find((key) => this.permitted(this.store.get(key)));
      if (next)
        this.worker = this.run(next).finally(() => {
          this.worker = undefined;
          this.preparingId = null;
        });
    }
    if (!this.delivery && this.client && this.store.settings().enabled) {
      const task = this.store
        .all()
        .find(
          (task) =>
            !unfinished(task) &&
            this.preparingId !== task.id &&
            this.activeId !== task.id &&
            this.permitted(task) &&
            (task.deliveryState === 'pending' ||
              (task.deliveryState === 'failed' &&
                task.nextDeliveryAt !== null &&
                Date.parse(task.nextDeliveryAt) <= this.now())),
        );
      if (task) {
        this.deliveringId = task.id;
        this.delivery = this.deliver(task.id).finally(() => {
          this.delivery = undefined;
          this.deliveringId = null;
        });
      }
    }
    // Queue acknowledgements can recover from an unavailable Telegram connection.
    for (const key of this.queue.keys()) void this.progress(key);
  }
  private async run(taskId: string) {
    const pending = this.queue.get(taskId)!;
    this.preparingId = taskId;
    this.patch(taskId, { state: 'preparing' });
    try {
      if (!pending.preview) {
        let input = pending.input!;
        if (input.kind === 'telegram-file') {
          if (!this.client)
            throw new AppError('TELEGRAM_UNAVAILABLE', 'Telegram 连接尚未就绪。', 503);
          input = previewInputSchema.parse({
            kind: 'file',
            content: await this.client.download(input.fileId, pending.abort.signal),
          });
        }
        pending.abort.signal.throwIfAborted();
        pending.preview = await this.speed.input.preview(input, pending.abort.signal);
        pending.input = undefined;
      }
      pending.abort.signal.throwIfAborted();
      await this.speed.input.resources.sync();
      const scripts = this.speed.scripts.list().scripts;
      const selected = pending.profile.scriptIds.map((id) => {
        const script = scripts.find((script) => script.id === id);
        if (!script?.enabled)
          throw new AppError(
            'REVISION_CONFLICT',
            '预设中的检测脚本已删除或停用，请修改 Telegram 预设后重新提交。',
            409,
          );
        return { id, revision: script.revision };
      });
      pending.abort.signal.throwIfAborted();
      const reportId = randomUUID();
      this.patch(taskId, { reportId, total: pending.preview.nodes.length });
      const report = await this.speed.start(
        {
          name: 'Telegram ' + taskId.slice(0, 8),
          backendId: pending.backend.backend.id,
          settings: pending.profile.settings,
          metrics: pending.profile.metrics,
          scripts: selected,
          subjects: pending.preview.nodes.map((node) => ({
            kind: 'temporary',
            previewId: pending.preview!.id,
            nodeIndex: node.index,
          })),
        },
        'telegram',
        reportId,
        pending.backend,
      );
      this.activeId = taskId;
      this.patch(taskId, {
        state: report.state === 'running' ? 'running' : report.state,
        total: report.total,
        completed: report.completed,
      });
      if (pending.abort.signal.aborted || !this.permitted(this.store.get(taskId)))
        this.speed.cancel(reportId);
      this.queue.delete(taskId);
      pending.backend.token = '';
      pending.input = undefined;
      pending.preview = undefined;
    } catch (error) {
      if (
        !pending.abort.signal.aborted &&
        error instanceof AppError &&
        error.code === 'TEST_BUSY'
      ) {
        this.patch(taskId, { state: 'queued', reportId: null });
        return;
      }
      if (pending.preview) this.speed.input.discard([pending.preview.id]);
      pending.preview = undefined;
      pending.input = undefined;
      pending.backend.token = '';
      this.queue.delete(taskId);
      this.patch(taskId, {
        state: this.closed ? 'interrupted' : pending.abort.signal.aborted ? 'cancelled' : 'failed',
        error: this.closed
          ? '服务停止，临时凭据已清除，请重新发送节点。'
          : pending.abort.signal.aborted
            ? '任务已取消。'
            : safeError(error),
        reportId: null,
      });
    }
    await this.progress(taskId);
  }
  private async deliver(taskId: string) {
    const client = this.client!;
    const signal = this.connection.signal;
    this.patch(taskId, { deliveryState: 'sending' });
    const part = async (key: string, send: (task: TelegramTask) => Promise<unknown>) => {
      const task = this.store.get(taskId);
      if (!this.permitted(task) || signal.aborted)
        throw new AppError('TELEGRAM_CANCELLED', '回传已停止。', 409);
      if (task.deliveredParts.includes(key)) return;
      messageId(await send(task));
      const current = this.store.get(taskId);
      this.patch(taskId, { deliveredParts: [...current.deliveredParts, key] });
      await delay(1000, undefined, { signal });
    };
    try {
      await this.progress(taskId);
      const task = this.store.get(taskId);
      let report: SpeedReport | undefined;
      if (task.reportId) report = this.speed.store.get(task.reportId);
      await part('summary', (task) =>
        this.reply(
          client,
          task.chatId,
          this.description(task) +
            (report ? '\n图片及 CSV 包含各项真实测量结果；未知结果不代表解锁成功。' : ''),
          signal,
          { reply_parameters: { message_id: task.messageId, allow_sending_without_reply: true } },
        ),
      );
      if (report) {
        let index = 0;
        for await (const file of reportImages(report)) {
          const page = ++index;
          await part('png:' + page, (task) =>
            client.upload(
              'sendPhoto',
              { chat_id: task.chatId, caption: `任务 ${task.id} · 图片 ${page}` },
              file,
              signal,
            ),
          );
        }
        const data = new TextEncoder().encode(reportCsv(report));
        await part('csv', (task) =>
          client.upload(
            'sendDocument',
            { chat_id: task.chatId, caption: `任务 ${task.id} · 完整结果` },
            { name: `submeld-${report!.id}.csv`, contentType: 'text/csv', data },
            signal,
          ),
        );
      }
      if (this.permitted(this.store.get(taskId)))
        this.patch(taskId, { deliveryState: 'sent', deliveryError: null, nextDeliveryAt: null });
      this.progressAt.delete(taskId);
    } catch (error) {
      const task = this.store.get(taskId);
      if (task.deliveryState === 'suppressed') return;
      if (signal.aborted) {
        this.patch(taskId, { deliveryState: 'pending' });
        return;
      }
      const attempts = task.deliveryAttempts + 1;
      const permanent =
        (error instanceof TelegramApiError && [400, 401, 403, 409].includes(error.telegramCode)) ||
        (error instanceof AppError && error.code === 'NOT_FOUND');
      this.patch(taskId, {
        deliveryState: 'failed',
        deliveryAttempts: attempts,
        deliveryError: safeError(error),
        nextDeliveryAt:
          !permanent && attempts < 5
            ? new Date(this.now() + retryDelay(error, attempts)).toISOString()
            : null,
      });
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.control;
    this.connection.abort();
    for (const [key, pending] of this.queue) {
      pending.backend.token = '';
      pending.abort.abort();
      pending.input = undefined;
      if (pending.preview) this.speed.input.discard([pending.preview.id]);
      this.patch(key, {
        state: 'interrupted',
        error: '服务停止，临时凭据已清除，请重新发送节点。',
      });
    }
    this.queue.clear();
    if (this.activeId) {
      const task = this.store.get(this.activeId);
      if (task.reportId) this.speed.cancel(task.reportId);
    }
    await this.worker;
    await this.delivery;
    await this.stopConnection();
  }
}
