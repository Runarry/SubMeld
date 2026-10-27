import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  backendIdSchema,
  backendInputSchema,
  backendUrlSchema,
  type BackendSnapshot,
  type BackendView,
} from './shared/miaospeed-backends.js';

export type BackendConnection = { backend: BackendSnapshot; token: string };
const storedSchema = z.strictObject({
  defaultBackendId: backendIdSchema.nullable(),
  backends: z.array(backendInputSchema.extend({ id: z.string().uuid(), token: z.string().min(1) })),
});
type Stored = z.infer<typeof storedSchema>;

export class MiaospeedBackends {
  private environment: BackendConnection = {
    backend: { id: 'environment', name: '部署配置服务', url: '', kind: 'environment' },
    token: '',
  };
  constructor(private db: Database.Database) {}
  configure(url: string, token: string) {
    this.environment = {
      backend: {
        id: 'environment',
        name: '部署配置服务',
        url: url ? backendUrlSchema.parse(url) : '',
        kind: 'environment',
      },
      token,
    };
  }
  private read(): Stored {
    const row = z
      .object({ value: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT value FROM settings WHERE key='miaospeed.backends'").get());
    return row
      ? storedSchema.parse(JSON.parse(row.value))
      : {
          defaultBackendId:
            this.environment.token && this.environment.backend.url ? 'environment' : null,
          backends: [],
        };
  }
  private save(value: Stored) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('miaospeed.backends',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(storedSchema.parse(value)));
  }
  list() {
    const value = this.read();
    const backends: BackendView[] = [
      {
        ...this.environment.backend,
        tokenConfigured: !!this.environment.token && !!this.environment.backend.url,
        readOnly: true,
      },
      ...value.backends.map(({ id, name, url }) => ({
        id,
        name,
        url,
        kind: 'remote' as const,
        tokenConfigured: true,
        readOnly: false,
      })),
    ];
    return { backends, defaultBackendId: value.defaultBackendId };
  }
  capture(id?: string): BackendConnection {
    const value = this.read();
    const selected = id === undefined ? value.defaultBackendId : backendIdSchema.parse(id);
    if (!selected) throw new AppError('MIAOSPEED_UNCONFIGURED', '请先选择测速服务。', 503);
    if (selected === 'environment') {
      if (!this.environment.token || !this.environment.backend.url)
        throw new AppError(
          'MIAOSPEED_UNCONFIGURED',
          '部署配置服务尚未配置，请选择其他测速服务。',
          503,
        );
      return structuredClone(this.environment);
    }
    const found = value.backends.find((backend) => backend.id === selected);
    if (!found)
      throw new AppError('MIAOSPEED_BACKEND_MISSING', '测速服务已删除，请重新选择。', 409);
    return {
      backend: { id: found.id, name: found.name, url: found.url, kind: 'remote' },
      token: found.token,
    };
  }
  put(input: unknown, id?: string) {
    const patch = backendInputSchema.parse(input);
    const value = this.read();
    if (id === 'environment')
      throw new AppError('INVALID_REQUEST', '部署配置服务只能通过环境变量修改。', 400);
    const previous =
      id === undefined ? undefined : value.backends.find((backend) => backend.id === id);
    if (id !== undefined && !previous) throw new AppError('NOT_FOUND', '测速服务已不存在。', 404);
    const token = patch.token || previous?.token;
    if (!token) throw new AppError('INVALID_REQUEST', '新增测速服务需要 Token。', 400);
    const next = { id: previous?.id ?? randomUUID(), name: patch.name, url: patch.url, token };
    if (previous) value.backends[value.backends.indexOf(previous)] = next;
    else {
      value.backends.push(next);
      if (!value.defaultBackendId) value.defaultBackendId = next.id;
    }
    this.save(value);
    return this.list();
  }
  setDefault(id: string | null) {
    if (id !== null) this.capture(id);
    const value = this.read();
    value.defaultBackendId = id;
    this.save(value);
    return this.list();
  }
  remove(id: string) {
    if (id === 'environment')
      throw new AppError('INVALID_REQUEST', '部署配置服务不能在页面删除。', 400);
    const value = this.read();
    if (!value.backends.some((backend) => backend.id === id))
      throw new AppError('NOT_FOUND', '测速服务已不存在。', 404);
    value.backends = value.backends.filter((backend) => backend.id !== id);
    if (value.defaultBackendId === id) value.defaultBackendId = null;
    this.save(value);
    return this.list();
  }
}
