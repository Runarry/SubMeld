import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { AppError } from './errors.js';
import { guardStructure } from './input.js';
import { record } from './converter/model.js';
import { koipySettingsSchema, koipyUpdateSchema } from './shared/integrations.js';
const object = (value: unknown): Record<string, unknown> => (record(value) ? value : {});
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export class KoipySettingsStore {
  constructor(
    private db: Database.Database,
    readonly path: string,
  ) {}
  private read() {
    try {
      const raw = readFileSync(this.path, 'utf8');
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Configuration too large');
      const document = parseDocument(raw, { uniqueKeys: true });
      if (document.errors.length) throw new Error('Invalid YAML');
      const data: unknown = document.toJS({ maxAliasCount: 50 });
      guardStructure(data);
      if (!record(data)) throw new Error('Expected a mapping');
      return {
        data,
        revision: createHash('sha256').update(raw).digest('hex'),
        savedAt: statSync(this.path).mtime.toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { data: {} as Record<string, unknown>, revision: '', savedAt: null };
      throw new AppError(
        'KOIPY_CONFIG_INVALID',
        '无法读取 Koipy 配置文件，请检查文件格式和读取权限。',
      );
    }
  }
  username(fallback = '') {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='koipy.botUsername'").get();
    return record(row) ? text(row.value) : fallback;
  }
  get(fallback = '') {
    const { data, revision, savedAt } = this.read();
    const bot = object(data.bot),
      slaveConfig = object(data.slaveConfig),
      slaves = Array.isArray(slaveConfig.slaves) ? slaveConfig.slaves : [],
      slave = object(slaves.find((value) => record(value) && value.id === 'local'));
    const hasLicense = !!text(data.license),
      hasBotToken = !!text(bot['bot-token'] ?? bot.bot_token),
      hasMiaospeedToken = !!text(slave.token),
      admins = Array.isArray(data.admin) ? data.admin : [];
    const result = koipySettingsSchema.safeParse({
      revision,
      savedAt,
      configPath: this.path,
      botUsername: this.username(fallback),
      adminIds: admins,
      hasLicense,
      hasBotToken,
      hasMiaospeedToken,
      hasBotProxy: !!text(bot.proxy),
      backend: {
        address: slave.address ?? 'miaospeed:8765',
        path: slave.path ?? '/miaospeed',
        tls: slave.tls ?? false,
        skipCertVerify: slave.skipCertVerify ?? false,
      },
      configured: hasLicense && hasBotToken && hasMiaospeedToken && admins.length > 0,
    });
    if (!result.success)
      throw new AppError(
        'KOIPY_CONFIG_INVALID',
        'Koipy 的管理员或 local 后端配置格式不受支持，请在配置文件中修正。',
      );
    return result.data;
  }
  update(input: unknown) {
    const parsed = koipyUpdateSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'INVALID_REQUEST',
        'Koipy 配置格式无效，请检查用户名、管理员 ID、Token 和后端地址。',
        400,
      );
    const value = parsed.data,
      current = this.read();
    if (value.revision !== current.revision)
      throw new AppError('REVISION_CONFLICT', 'Koipy 配置已修改，请重新载入后保存。', 409);
    const data = current.data,
      bot = { ...object(data.bot) },
      slaveConfig = { ...object(data.slaveConfig) };
    const slaves: unknown[] = Array.isArray(slaveConfig.slaves) ? [...slaveConfig.slaves] : [];
    const index = slaves.findIndex((entry) => record(entry) && entry.id === 'local');
    const slave = { ...object(slaves[index]), type: 'miaospeed', id: 'local', ...value.backend };
    const setSecret = (
      target: Record<string, unknown>,
      key: string,
      secret: string | null | undefined,
    ) => {
      if (secret === null) delete target[key];
      else if (secret !== undefined) target[key] = secret;
    };
    setSecret(data, 'license', value.license);
    setSecret(bot, 'bot-token', value.botToken);
    if (value.botToken !== undefined) delete bot.bot_token;
    setSecret(bot, 'proxy', value.botProxy);
    setSecret(slave, 'token', value.miaospeedToken);
    if (index >= 0) slaves[index] = slave;
    else slaves.push(slave);
    data.admin = value.adminIds;
    data.bot = bot;
    data.slaveConfig = { ...slaveConfig, slaves };
    if (!data.webapi) data.webapi = { enable: false };
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Keep the inode: the official container mounts this native configuration file.
      writeFileSync(this.path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    } catch {
      throw new AppError(
        'KOIPY_CONFIG_WRITE_FAILED',
        '无法写入 Koipy 配置，请检查共享配置目录的写入权限。',
      );
    }
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('koipy.botUsername',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(value.botUsername);
    return this.get();
  }
}
