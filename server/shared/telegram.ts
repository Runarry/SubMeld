import { z } from 'zod';
import { metricIdSchema, metricIds, speedSettingsSchema } from './miaospeed.js';
import { backendIdSchema } from './miaospeed-backends.js';

export const telegramUserIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)), '请输入 Telegram 数字用户 ID。');
export const telegramProfileSchema = z
  .strictObject({
    backendId: backendIdSchema.nullable().default('environment'),
    settings: speedSettingsSchema,
    metrics: z
      .array(metricIdSchema)
      .max(metricIds.length)
      .refine((v) => new Set(v).size === v.length),
    scriptIds: z
      .array(z.string().uuid())
      .max(200)
      .refine((v) => new Set(v).size === v.length),
  })
  .refine((v) => v.metrics.length + v.scriptIds.length > 0, '至少选择一个测试项。');
export type TelegramProfile = z.infer<typeof telegramProfileSchema>;

export const telegramSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  token: z
    .string()
    .trim()
    .regex(/^\d+:[A-Za-z0-9_-]+$/)
    .max(256)
    .nullable()
    .default(null),
  proxyUrl: z.string().trim().min(1).max(2048).nullable().default(null),
  allowedUserIds: z.array(telegramUserIdSchema).max(1000).default([]),
  profile: telegramProfileSchema,
});
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;
// Zod 4 applies defaults inside optional fields; a PATCH must leave omitted values untouched.
export const telegramSettingsPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  token: telegramSettingsSchema.shape.token.removeDefault().optional(),
  proxyUrl: telegramSettingsSchema.shape.proxyUrl.removeDefault().optional(),
  allowedUserIds: telegramSettingsSchema.shape.allowedUserIds.removeDefault().optional(),
  profile: telegramProfileSchema.optional(),
});
export const telegramSettingsViewSchema = telegramSettingsSchema
  .omit({ token: true, proxyUrl: true })
  .extend({
    tokenConfigured: z.boolean(),
    proxyConfigured: z.boolean(),
    proxyDisplay: z.string().nullable(),
  });
export type TelegramSettingsView = z.infer<typeof telegramSettingsViewSchema>;
export const telegramStatusSchema = z.strictObject({
  state: z.enum(['disabled', 'connecting', 'connected', 'error']),
  botId: z.string().nullable(),
  username: z.string().nullable(),
  error: z.string().nullable(),
  checkedAt: z.string().nullable(),
  queued: z.number().int(),
  activeTaskId: z.string().nullable(),
});
export type TelegramStatus = z.infer<typeof telegramStatusSchema>;
export const telegramTaskSchema = z.strictObject({
  id: z.string().uuid(),
  botId: telegramUserIdSchema,
  userId: telegramUserIdSchema,
  chatId: telegramUserIdSchema,
  updateId: z.number().int().nonnegative(),
  messageId: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
  state: z.enum([
    'queued',
    'preparing',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'expired',
  ]),
  reportId: z.string().uuid().nullable(),
  progressMessageId: z.number().int().nullable(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  error: z.string().nullable(),
  deliveryState: z.enum(['pending', 'sending', 'sent', 'failed', 'suppressed']),
  deliveredParts: z.array(z.string()),
  deliveryError: z.string().nullable(),
  deliveryAttempts: z.number().int().nonnegative(),
  nextDeliveryAt: z.string().nullable(),
});
export type TelegramTask = z.infer<typeof telegramTaskSchema>;
export const telegramTaskListSchema = z.strictObject({
  tasks: z.array(telegramTaskSchema),
  total: z.number().int(),
});
export const telegramTaskLabels: Record<TelegramTask['state'], string> = {
  queued: '排队中',
  preparing: '解析中',
  running: '测速中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  expired: '已过期',
};
export const telegramDeliveryLabels: Record<TelegramTask['deliveryState'], string> = {
  pending: '待回传',
  sending: '回传中',
  sent: '已回传',
  failed: '回传失败',
  suppressed: '已停止回传',
};
