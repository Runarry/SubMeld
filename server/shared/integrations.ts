import { z } from 'zod';

const username = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(z.string().regex(/^(?:[A-Za-z0-9_]{5,32})?$/));
const adminIds = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(20);
const address = z
  .string()
  .trim()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL('http://' + value);
      return (
        !!url.hostname &&
        !!url.port &&
        url.pathname === '/' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, '请填写 host:port 格式的后端地址。');
const backend = z.strictObject({
  address,
  path: z
    .string()
    .trim()
    .max(512)
    .regex(/^\/[^\s?#]*$/),
  tls: z.boolean(),
  skipCertVerify: z.boolean(),
});
const secret = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));
export const koipyUpdateSchema = z.strictObject({
  revision: z.string(),
  botUsername: username,
  adminIds,
  backend,
  license: secret.nullable().optional(),
  botToken: secret
    .regex(/^\d+:[A-Za-z0-9_-]+$/)
    .nullable()
    .optional(),
  miaospeedToken: secret.nullable().optional(),
  botProxy: secret
    .refine((value) => {
      try {
        return ['http:', 'socks5:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, '机器人代理需要 http:// 或 socks5:// 地址。')
    .nullable()
    .optional(),
});
export const koipySettingsSchema = z.strictObject({
  revision: z.string(),
  botUsername: username,
  adminIds,
  backend,
  hasLicense: z.boolean(),
  hasBotToken: z.boolean(),
  hasMiaospeedToken: z.boolean(),
  hasBotProxy: z.boolean(),
  configured: z.boolean(),
  savedAt: z.string().nullable(),
  configPath: z.string(),
});
export type KoipySettings = z.infer<typeof koipySettingsSchema>;
