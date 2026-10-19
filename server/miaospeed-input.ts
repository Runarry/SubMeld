import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { type UpstreamResources, rawDraft } from './upstream-resources.js';
import { inlineNodeEntries } from './inline-node-input.js';
import { produceUpstream } from './converter/engine.js';
import { MAX_NODES, type RenderItem } from './shared/contracts.js';
import { previewInputSchema, type SpeedPreview, type SpeedSubject } from './shared/miaospeed.js';
import { record } from './converter/model.js';
import { isDeepStrictEqual } from 'node:util';

type Raw = Record<string, unknown>;
export type CapturedNode = {
  name: string;
  protocol: string;
  raw: Raw | null;
  error: string | null;
};
export class MiaospeedInput {
  private previews = new Map<string, { expires: number; nodes: CapturedNode[] }>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    readonly resources: UpstreamResources,
    private now = Date.now,
  ) {
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref();
  }
  private cleanup() {
    for (const [id, value] of this.previews)
      if (value.expires <= this.now()) this.previews.delete(id);
  }
  async preview(input: unknown, signal?: AbortSignal): Promise<SpeedPreview> {
    signal?.throwIfAborted();
    const value = previewInputSchema.parse(input);
    const nodes: CapturedNode[] = [];
    if (value.kind === 'url') {
      const url = new URL(value.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new AppError('INVALID_REQUEST', '临时订阅需要 HTTP(S) 地址。', 400);
      const parsed = await this.resources.client.preview(
        'sub',
        { name: 'temporary-' + randomUUID(), source: 'remote', url: value.url, process: [] },
        true,
      );
      signal?.throwIfAborted();
      for (const raw of parsed.original) nodes.push(this.describe(raw));
    } else {
      const list = inlineNodeEntries(value.content);
      if (list.length > MAX_NODES)
        throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数量超过 2,000。', 413);
      for (const [index, entry] of list.entries()) {
        signal?.throwIfAborted();
        try {
          const parsed = await this.resources.client.convert(
            typeof entry === 'string' ? entry : JSON.stringify(entry),
            'JSON',
            true,
          );
          if (!Array.isArray(parsed) || parsed.length !== 1 || !record(parsed[0]))
            throw new Error('Missing node');
          nodes.push(this.describe(parsed[0]));
        } catch (error) {
          if (error instanceof AppError && error.status >= 500) throw error;
          nodes.push({
            name:
              record(entry) && typeof entry.name === 'string'
                ? entry.name
                : '第 ' + (index + 1) + ' 项',
            protocol: '未知',
            raw: null,
            error: 'Sub-Store 无法完整解析此项。',
          });
        }
      }
    }
    signal?.throwIfAborted();
    if (!nodes.length || nodes.length > MAX_NODES)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '请选择包含 1～2,000 个节点的输入。', 400);
    const id = randomUUID(),
      expires = this.now() + 30 * 60 * 1000;
    this.cleanup();
    this.previews.set(id, { expires, nodes });
    return {
      id,
      expiresAt: new Date(expires).toISOString(),
      nodes: nodes.map((node, index) => ({
        index,
        name: node.name,
        protocol: node.protocol,
        error: node.error,
      })),
    };
  }
  private describe(raw: Raw): CapturedNode {
    return {
      name: String(raw.name ?? '未命名节点').slice(0, 500),
      protocol: String(raw.type ?? '未知'),
      raw: structuredClone(raw),
      error: null,
    };
  }
  discard(ids: Iterable<string>) {
    for (const id of ids) this.previews.delete(id);
  }
  async refresh(subjects: SpeedSubject[]) {
    const saved = subjects.filter((subject) => subject.kind !== 'temporary');
    if (!saved.length) return;
    await this.resources.sync();
    await this.resources.prepare(saved.map((subject) => subject.resourceId));
  }
  capture(subject: SpeedSubject): CapturedNode {
    if (subject.kind === 'temporary') {
      this.cleanup();
      const preview = this.previews.get(subject.previewId),
        node = preview?.nodes[subject.nodeIndex];
      if (!preview || !node)
        throw new AppError('PREVIEW_EXPIRED', '临时预览已过期，请重新输入。', 409);
      preview.expires = this.now() + 30 * 60 * 1000;
      return structuredClone(node);
    }
    const row = this.resources.current(subject);
    return this.describe(row.processed ?? row.original ?? {});
  }
  matches(subject: SpeedSubject) {
    if (subject.kind === 'temporary') return true;
    try {
      this.capture(subject);
      return true;
    } catch {
      return false;
    }
  }
  async payload(raw: Raw, name: string, signal?: AbortSignal) {
    if (['dialer-proxy', 'underlying-proxy', 'detour'].some((key) => raw[key]))
      throw new AppError('TARGET_UNSUPPORTED', '此节点依赖其他代理，无法作为独立节点测试。', 422);
    const converted = await produceUpstream(
      [raw],
      'Mihomo',
      'internal',
      this.resources.client,
      signal,
    );
    const list = z.array(z.record(z.string(), z.unknown())).parse(converted);
    if (list.length !== 1 || !list[0]?.type || !list[0]?.server || !list[0]?.port)
      throw new AppError('TARGET_UNSUPPORTED', 'Sub-Store 无法完整生成此节点的 Mihomo 配置。', 422);
    const output = list[0];
    const back = await produceUpstream([output], 'JSON', 'internal', this.resources.client, signal);
    if (!Array.isArray(back) || back.length !== 1 || !record(back[0]))
      throw new AppError('TARGET_UNSUPPORTED', '节点连接参数无法复核。', 422);
    for (const [key, value] of Object.entries(raw)) {
      if (
        key === 'name' ||
        key === 'id' ||
        key.startsWith('_') ||
        value === undefined ||
        value === null ||
        value === ''
      )
        continue;
      const actual = back[0][key] ?? output[key];
      if (value === false && actual === undefined) continue;
      if (!isDeepStrictEqual(actual, value))
        throw new AppError('TARGET_UNSUPPORTED', '无法完整保留连接字段：' + key + '。', 422);
    }
    return JSON.stringify({ ...output, name });
  }
  bridgeItem(node: CapturedNode): RenderItem {
    if (!node.raw) throw new AppError('INVALID_REQUEST', '此节点没有有效配置。', 400);
    return {
      nodeIndex: 0,
      excluded: false,
      diagnostics: [],
      draft: rawDraft(node.raw),
    };
  }
  close() {
    clearInterval(this.timer);
    this.previews.clear();
  }
}
