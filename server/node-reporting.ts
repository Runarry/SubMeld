import type Database from 'better-sqlite3';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { inlineNodeEntries } from './inline-node-input.js';
import { record } from './converter/model.js';
import { MAX_NODES } from './shared/contracts.js';
import {
  machineIdSchema,
  nodeReportSchema,
  nodeReportingPatchSchema,
  type NodeReportResult,
  type NodeReportingSettings,
} from './shared/node-reporting.js';
import { identityKey } from './sub-store.js';
import { marker, type Entry, type UpstreamResources } from './upstream-resources.js';

const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  tokenHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
});
const digest = (token: string) => createHash('sha256').update(token).digest();

export class NodeReporting {
  constructor(
    private db: Database.Database,
    private resources: UpstreamResources,
  ) {}
  private settings() {
    const row = z
      .object({ value: z.string() })
      .optional()
      .parse(
        this.db.prepare("SELECT value FROM settings WHERE key='nodeReporting.settings'").get(),
      );
    return settingsSchema.parse(row ? JSON.parse(row.value) : {});
  }
  private save(value: z.infer<typeof settingsSchema>) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('nodeReporting.settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(value));
  }
  view(): NodeReportingSettings {
    const { enabled, tokenHash } = this.settings();
    return { enabled, tokenConfigured: tokenHash !== null };
  }
  update(input: unknown) {
    const patch = nodeReportingPatchSchema.parse(input);
    const next = { ...this.settings(), ...patch };
    if (next.enabled && !next.tokenHash)
      throw new AppError('REPORT_TOKEN_REQUIRED', '请先生成上报 Token。', 400);
    this.save(next);
    return this.view();
  }
  rotateToken() {
    const token = randomBytes(32).toString('base64url');
    this.save({ ...this.settings(), tokenHash: digest(token).toString('hex') });
    return { ...this.view(), token };
  }
  authorize(authorization: string | undefined) {
    const value = this.settings();
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1];
    if (
      !token ||
      !value.tokenHash ||
      !timingSafeEqual(digest(token), Buffer.from(value.tokenHash, 'hex'))
    )
      throw new AppError('REPORT_UNAUTHENTICATED', '上报 Token 缺失或无效。', 401);
    if (!value.enabled) throw new AppError('REPORT_DISABLED', '节点上报功能已停用。', 403);
  }
  async report(
    id: string,
    input: unknown,
    authorization: string | undefined,
    signal?: AbortSignal,
  ): Promise<NodeReportResult> {
    this.authorize(authorization);
    const machineId = machineIdSchema.parse(id);
    const value = nodeReportSchema.parse(input);
    const entries = inlineNodeEntries(value.content);
    if (!entries.length) throw new AppError('EMPTY_INPUT', '上报必须包含至少一个节点。', 400);
    if (entries.length > MAX_NODES)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数量超过 2,000。', 413);
    const client = this.resources.client;
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const parsed = await client.convert(
        typeof entry === 'string' ? entry : JSON.stringify(entry),
        'JSON',
        true,
        signal,
      );
      if (!Array.isArray(parsed) || parsed.length !== 1 || !record(parsed[0]))
        throw new AppError('REPORT_INPUT_INVALID', '第 ' + (index + 1) + ' 项无法完整解析。', 422);
    }
    const name = 'sm-report-' + machineId;
    const preview = await client.preview(
      'sub',
      { name, source: 'local', content: value.content, process: [] },
      true,
    );
    if (preview.original.length !== entries.length)
      throw new AppError('REPORT_INPUT_INVALID', '完整内容解析的节点数量不一致，未保存。', 422);

    return client.exclusive(async () => {
      signal?.throwIfAborted();
      await this.resources.syncUnlocked();
      let entry: Entry | undefined;
      try {
        entry = this.resources.record(machineId);
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 404) throw error;
      }
      if (
        entry &&
        (entry.type !== 'sub' ||
          marker(entry.record)?.role !== 'report-source' ||
          marker(entry.record)?.version !== 1 ||
          entry.record.source !== 'local' ||
          ['localFirst', 'remoteFirst'].includes(String(entry.record.mergeSources)))
      )
        throw new AppError('REPORT_ID_CONFLICT', '此 UUID 已被其他资源或非本地上报订阅占用。', 409);
      if (
        !entry &&
        this.resources.listResources().some((r) => r.type === 'sub' && r.upstreamName === name)
      )
        throw new AppError('REPORT_ID_CONFLICT', '上报订阅的内部名称已被占用。', 409);
      // Settings can change while parsing or waiting for the shared upstream write lock.
      this.authorize(authorization);
      signal?.throwIfAborted();
      const result = { machineId, nodeCount: entries.length };
      if (entry?.record.content === value.content && entry.record.displayName === value.name)
        return { ...result, action: 'unchanged' };
      if (entry)
        await client.api(
          '/api/sub/' + encodeURIComponent(entry.record.name),
          { content: value.content, displayName: value.name },
          'PATCH',
        );
      else
        await client.api('/api/subs', {
          name,
          displayName: value.name,
          source: 'local',
          content: value.content,
          url: '',
          process: [],
          [identityKey]: { id: machineId, role: 'report-source', version: 1 },
        });
      await this.resources.syncUnlocked();
      return { ...result, action: entry ? 'updated' : 'created' };
    });
  }
}
