import { removeLocalNodes } from './local-content.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './errors.js';
import {
  SubStoreClient,
  identityKey,
  upstreamIdentitySchema,
  type UpstreamRecord,
} from './sub-store.js';
import { checkedDraft } from './converter/normalized.js';
import {
  addResourceSchema,
  deleteNodesSchema,
  type DeleteNodesResult,
  type NodeRef,
  type NodeSelector,
  type NodeView,
  type Resource,
} from './shared/resources.js';
import type { NodeDraft } from './shared/contracts.js';
import { MAX_BYTES } from './shared/contracts.js';
import { hysteriaPortRanges } from './converter/hysteria2.js';

export const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
export type Entry = { type: 'sub' | 'collection' | 'file'; record: UpstreamRecord };
type RawNode = Record<string, unknown>;
export type Snapshot = {
  resource: Resource;
  snapshotHash: string;
  original: RawNode[];
  processed: RawNode[];
  rows: {
    view: NodeView;
    original: RawNode | null;
    processed: RawNode | null;
    rawIndex: number | null;
  }[];
};
export function marker(record: UpstreamRecord) {
  const value = upstreamIdentitySchema.safeParse(record[identityKey]);
  return value.success ? value.data : null;
}
export const rawDraft = (raw: unknown): NodeDraft => checkedDraft(raw);
const cleanRaw = (raw: RawNode) =>
  Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) =>
        ![
          'id',
          '_subName',
          '_subDisplayName',
          '_collectionName',
          '_collectionDisplayName',
        ].includes(key),
    ),
  );

function snapshotNode(raw: RawNode) {
  if (raw.type === 'hysteria2' && typeof raw.ports === 'string' && raw.ports) {
    try {
      // Sub-Store picks a random port for multi-port URIs. `ports` controls the
      // actual connection; retain it and every other field in the snapshot.
      const ranges = hysteriaPortRanges(raw.ports);
      return { ...raw, port: ranges[0]![0] };
    } catch {
      // Invalid ranges must not hide changes to the ordinary connection port.
    }
  }
  return raw;
}
const nodeContentHash = (nodes: RawNode[]) => hash(nodes.map((raw) => cleanRaw(snapshotNode(raw))));

/** Upstream records and preview credentials stay in memory. No editable node database. */
export class UpstreamResources {
  private entries = new Map<string, Entry>();
  private snapshots = new Map<string, Snapshot>();
  private previewTickets = new Map<string, number>();
  private sequence = 0;
  private catalogVersion = 0;
  constructor(readonly client: SubStoreClient) {}
  sync() {
    return this.client.exclusive(() => this.syncUnlocked());
  }
  async syncUnlocked() {
    try {
      await this.readCatalog();
    } catch (error) {
      for (const id of this.entries.keys()) this.invalidate(id);
      throw error;
    }
  }
  private invalidate(id: string) {
    this.snapshots.delete(id);
    this.previewTickets.set(id, ++this.sequence);
  }
  private invalidateCollections(name: string) {
    for (const [id, entry] of this.entries)
      if (
        entry.type === 'collection' &&
        Array.isArray(entry.record.subscriptions) &&
        entry.record.subscriptions.includes(name)
      )
        this.invalidate(id);
  }
  private acceptRecord(id: string, entry: Entry) {
    const old = this.entries.get(id);
    if (hash(old?.record) === hash(entry.record)) return;
    this.catalogVersion++;
    this.invalidate(id);
    if (old?.type === 'sub') this.invalidateCollections(old.record.name);
    if (entry.type === 'sub') this.invalidateCollections(entry.record.name);
    this.entries.set(id, entry);
  }
  private async readCatalog() {
    const catalog = (
      await Promise.all(
        (['sub', 'collection', 'file'] as const).map(async (type) =>
          (await this.client.records(type)).map((record) => ({ type, record })),
        ),
      )
    ).flat();
    const next = new Map<string, Entry>();
    for (const entry of catalog) {
      const legacy = entry.record[identityKey];
      if (
        entry.type === 'file' &&
        legacy !== null &&
        typeof legacy === 'object' &&
        'role' in legacy &&
        legacy.role === 'chain'
      )
        continue;
      let id = marker(entry.record);
      if (!id && entry.type === 'file') continue;
      if (!id) {
        id = { id: randomUUID() };
        await this.client.api(
          '/api/' + entry.type + '/' + encodeURIComponent(entry.record.name),
          { [identityKey]: id },
          'PATCH',
        );
        entry.record = { ...entry.record, [identityKey]: id };
      }
      if (next.has(id.id))
        throw new AppError(
          'UPSTREAM_ID_DUPLICATE',
          '上游资源 UUID 重复，请在 Sub-Store 中修正标记。',
          409,
        );
      next.set(id.id, entry);
    }
    for (const [id, entry] of next) this.acceptRecord(id, entry);
    for (const [id, entry] of this.entries)
      if (!next.has(id)) {
        this.catalogVersion++;
        this.invalidate(id);
        if (entry.type === 'sub') this.invalidateCollections(entry.record.name);
      }
    this.entries = next;
  }
  record(id: string): Entry {
    const item = this.entries.get(id);
    if (!item) throw new AppError('NOT_FOUND', '上游资源或身份标记已不存在，请重新选择。', 404);
    return item;
  }
  files(role?: string) {
    return [...this.entries.entries()]
      .filter(([, e]) => e.type === 'file' && (!role || marker(e.record)?.role === role))
      .map(([id, e]) => ({ id, record: e.record }));
  }
  resource(id: string): Resource {
    const entry = this.record(id);
    if (entry.type === 'file') throw new AppError('INVALID_RESOURCE', '此资源不是订阅。', 400);
    return {
      id,
      type: entry.type,
      name:
        (typeof entry.record.displayName === 'string' && entry.record.displayName.trim()) ||
        entry.record.name,
      upstreamName: entry.record.name,
      revision: hash(entry.record),
    };
  }
  listResources() {
    return [...this.entries.keys()]
      .filter((id) => this.record(id).type !== 'file')
      .map((id) => this.resource(id));
  }
  cached(id: string) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.resource.revision !== this.resource(id).revision)
      throw new AppError('REVISION_CONFLICT', '节点内容已变化，请刷新列表。', 409);
    return snapshot;
  }
  async preview(id: string, force = false) {
    const entry = this.record(id),
      resource = this.resource(id);
    const ticket = ++this.sequence;
    this.previewTickets.set(id, ticket);
    let data: Awaited<ReturnType<SubStoreClient['preview']>>;
    try {
      data = await this.client.preview(resource.type, entry.record, force);
    } catch (error) {
      if (this.previewTickets.get(id) === ticket) this.invalidate(id);
      throw error;
    }
    if (this.previewTickets.get(id) !== ticket || this.resource(id).revision !== resource.revision)
      throw new AppError('REVISION_CONFLICT', '读取期间订阅已修改，请重试。', 409);
    const snapshotHash = hash({
      original: data.original.map(snapshotNode),
      processed: data.processed.map(snapshotNode),
    });
    const rows: Snapshot['rows'] = [];
    const counts = new Map<number, number>();
    for (const raw of data.processed)
      if (Number.isInteger(raw.id))
        counts.set(Number(raw.id), (counts.get(Number(raw.id)) ?? 0) + 1);
    const linked = new Set<number>();
    const local =
      resource.type === 'sub' &&
      ((entry.record.source === 'local' &&
        !['localFirst', 'remoteFirst'].includes(String(entry.record.mergeSources))) ||
        (['localFirst', 'remoteFirst'].includes(String(entry.record.mergeSources)) &&
          typeof entry.record.url === 'string' &&
          !entry.record.url.trim()));
    const add = (original: RawNode | null, processed: RawNode | null, rawIndex: number | null) => {
      const raw = processed ?? original ?? {};
      const name = typeof raw.name === 'string' ? raw.name : '未命名节点';
      let testReason = '';
      try {
        rawDraft(raw);
      } catch (e) {
        testReason = e instanceof Error ? e.message : '此节点尚不支持测试。';
      }
      const unique = data.processed.filter((n) => n.name === name).length === 1;
      rows.push({
        original,
        processed,
        rawIndex,
        view: {
          resourceId: id,
          revision: resource.revision,
          snapshotHash,
          nodeIndex: rows.length,
          name,
          protocol: typeof raw.type === 'string' ? raw.type : '未知',
          resourceName: resource.name,
          available: processed !== null,
          testable: !testReason,
          testReason,
          deletion: ['machine-source', 'relay-source'].includes(marker(entry.record)?.role ?? '')
            ? 'unavailable'
            : local && rawIndex !== null
              ? 'content'
              : processed && unique
                ? 'filter'
                : 'unavailable',
        },
      });
    };
    for (const processed of data.processed) {
      const index =
        Number.isInteger(processed.id) &&
        Number(processed.id) >= 0 &&
        Number(processed.id) < data.original.length &&
        counts.get(Number(processed.id)) === 1
          ? Number(processed.id)
          : null;
      if (index !== null) linked.add(index);
      add(index === null ? null : (data.original[index] ?? null), processed, index);
    }
    for (const [index, original] of data.original.entries())
      if (!linked.has(index) && !counts.has(index)) add(original, null, index);
    const snapshot = { resource, snapshotHash, ...data, rows };
    const previous = this.snapshots.get(id);
    if (resource.type === 'sub' && previous && previous.snapshotHash !== snapshotHash)
      this.invalidateCollections(entry.record.name);
    this.snapshots.set(id, snapshot);
    return snapshot;
  }
  async list(resourceId?: string, search = '', page = 0, force = false) {
    await this.sync();
    const version = this.catalogVersion;
    const resources = this.listResources();
    const selected = resourceId
      ? resources.filter((r) => r.id === resourceId)
      : resources.filter((r) => r.type === 'sub');
    if (resourceId && !selected.length) throw new AppError('NOT_FOUND', '订阅已不存在。', 404);
    const nodes: NodeView[] = [],
      errors: { resourceId: string; message: string }[] = [];
    const readSnapshots: Snapshot[] = [];
    for (const resource of selected) {
      try {
        const snapshot = await this.preview(resource.id, force);
        readSnapshots.push(snapshot);
        nodes.push(...snapshot.rows.map((row) => row.view));
      } catch (error) {
        errors.push({
          resourceId: resource.id,
          message: error instanceof AppError ? error.message : '无法读取上游订阅。',
        });
      }
    }
    if (this.catalogVersion !== version)
      throw new AppError('REVISION_CONFLICT', '读取期间订阅已修改，请刷新列表。', 409);
    for (const snapshot of readSnapshots)
      if (this.cached(snapshot.resource.id).snapshotHash !== snapshot.snapshotHash)
        throw new AppError('REVISION_CONFLICT', '读取期间节点预览已变化，请刷新列表。', 409);
    const filtered = nodes.filter((node) =>
      (node.name + ' ' + node.protocol + ' ' + node.resourceName)
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
    return {
      nodes: filtered.slice(page * 25, page * 25 + 25),
      resources,
      errors,
      total: filtered.length,
      readAt: new Date().toISOString(),
      complete: errors.length === 0,
    };
  }
  current(ref: NodeRef, snapshot = this.cached(ref.resourceId)) {
    const row = snapshot.rows[ref.nodeIndex];
    if (
      !row ||
      snapshot.resource.id !== ref.resourceId ||
      snapshot.snapshotHash !== ref.snapshotHash ||
      snapshot.resource.revision !== ref.revision
    )
      throw new AppError('REVISION_CONFLICT', '节点内容或顺序已变化，请刷新列表。', 409);
    return row;
  }
  resolve(selector: NodeSelector) {
    const matches = this.cached(selector.resourceId).rows.filter(
      (row) => row.view.available && row.view.name === selector.nodeName,
    );
    if (matches.length !== 1)
      throw new AppError(
        'CHAIN_REFERENCE_INVALID',
        matches.length
          ? '链成员名称重复，请重命名后重新选择。'
          : '链成员已被删除、改名或排除，请重新选择。',
        422,
      );
    return matches[0]!;
  }
  async prepare(ids: string[], force = false) {
    for (const id of new Set(ids)) await this.preview(id, force);
  }
  async create(input: unknown) {
    if (
      typeof input === 'object' &&
      input &&
      'content' in input &&
      typeof input.content === 'string' &&
      Buffer.byteLength(input.content) > MAX_BYTES
    )
      throw new AppError('INPUT_LIMIT_EXCEEDED', '节点内容超过 4 MiB。', 413);
    const parsed = addResourceSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '请填写订阅名称及有效的内容。', 400);
    const value = parsed.data;
    if (value.source === 'local' ? !value.content.trim() : !value.url.trim())
      throw new AppError('INVALID_REQUEST', '节点内容或订阅地址不能为空。', 400);
    if (value.source === 'remote')
      for (const url of value.url.trim().split(/\r?\n/)) {
        let valid = false;
        try {
          valid = ['http:', 'https:'].includes(new URL(url.trim()).protocol);
        } catch {
          /* validated below */
        }
        if (!valid) throw new AppError('INVALID_REQUEST', '订阅地址必须是 HTTP(S) URL。', 400);
      }
    return this.client.exclusive(async () => {
      await this.syncUnlocked();
      const id = randomUUID();
      await this.client.api('/api/subs', {
        name: 'sm-' + id,
        displayName: value.name,
        source: value.source,
        content: value.source === 'local' ? value.content : '',
        url: value.source === 'remote' ? value.url : '',
        process: [],
        [identityKey]: { id },
      });
      await this.syncUnlocked();
      return this.resource(id);
    });
  }
  async deleteNodes(input: unknown) {
    const parsed = deleteNodesSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', '删除请求缺少有效的节点快照。', 400);
    const refs = parsed.data.nodes;
    if (new Set(refs.map((r) => r.resourceId + ':' + r.nodeIndex)).size !== refs.length)
      throw new AppError('INVALID_REQUEST', '不能重复选择同一节点。', 400);
    return this.client.exclusive(async () => {
      await this.syncUnlocked();
      const captured = new Map<string, { entry: Entry; snapshot: Snapshot }>();
      for (const id of new Set(refs.map((ref) => ref.resourceId)))
        captured.set(id, {
          entry: structuredClone(this.record(id)),
          snapshot: await this.preview(id),
        });
      const changes = new Map<string, { removed: Set<number>; names: string[] }>();
      for (const ref of refs) {
        const capture = captured.get(ref.resourceId)!;
        const row = this.current(ref, capture.snapshot);
        if (['machine-source', 'relay-source'].includes(marker(capture.entry.record)?.role ?? ''))
          throw new AppError('MANAGED_NODE', '此节点由机器或中转线路管理，请在对应页面删除。', 409);
        if (row.view.deletion === 'unavailable')
          throw new AppError(
            'NODE_DELETE_UNSAFE',
            '无法唯一定位此节点，请在 Sub-Store 原生页面编辑。',
            409,
          );
        const change = changes.get(ref.resourceId) ?? { removed: new Set<number>(), names: [] };
        if (row.view.deletion === 'content' && row.rawIndex !== null)
          change.removed.add(row.rawIndex);
        else change.names.push(row.view.name);
        changes.set(ref.resourceId, change);
      }
      const patches: {
        id: string;
        entry: Entry;
        patch: Record<string, unknown>;
        expected: Awaited<ReturnType<SubStoreClient['preview']>>;
        deleted: number;
        excluded: number;
      }[] = [];
      for (const [id, change] of changes) {
        const { entry, snapshot } = captured.get(id)!;
        const patch: Record<string, unknown> = {};
        const remaining = snapshot.original.filter((_, index) => !change.removed.has(index));
        if (change.removed.size) {
          const content = await removeLocalNodes(
            String(entry.record.content ?? ''),
            change.removed,
            snapshot.original.length,
            (line) => this.client.convert(line, 'JSON', true),
          );
          const checked = await this.client.preview('sub', {
            ...entry.record,
            content,
            process: [],
          });
          if (nodeContentHash(checked.original) !== nodeContentHash(remaining))
            throw new AppError(
              'NODE_DELETE_UNSAFE',
              '无法保证其他节点字段完整，请在 Sub-Store 原生页面编辑。',
              409,
            );
          patch.content = content;
        }
        if (change.names.length)
          patch.process = [
            ...(Array.isArray(entry.record.process) ? entry.record.process : []),
            {
              type: 'Regex Filter',
              args: {
                regex: change.names.map(
                  (name) => '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
                ),
                keep: false,
              },
              _submeldExcluded: true,
            },
          ];
        const expected = await this.client.preview(snapshot.resource.type, {
          ...entry.record,
          ...patch,
        });
        if (
          nodeContentHash(expected.original) !== nodeContentHash(remaining) ||
          expected.processed.some((raw) => change.names.includes(String(raw.name))) ||
          (!change.removed.size &&
            nodeContentHash(expected.processed) !==
              nodeContentHash(
                snapshot.processed.filter((raw) => !change.names.includes(String(raw.name))),
              ))
        )
          throw new AppError(
            'NODE_DELETE_UNSAFE',
            '上游预览与预期修改不一致，尚未写入；请刷新后检查处理规则。',
            409,
          );
        patches.push({
          id,
          entry,
          patch,
          expected,
          deleted: change.removed.size,
          excluded: change.names.length,
        });
      }
      const result: DeleteNodesResult = {
        deleted: 0,
        excluded: 0,
        resources: patches.map(({ id }) => ({
          resourceId: id,
          name: captured.get(id)!.snapshot.resource.name,
          state: 'notAttempted',
          deleted: 0,
          excluded: 0,
          message: '尚未执行。',
        })),
      };
      let conflict = false;
      for (const [index, { id, entry, patch, expected, deleted, excluded }] of patches.entries()) {
        const outcome = result.resources[index]!;
        // A batch holds immutable preflight snapshots; previews from other requests
        // cannot change the source positions used to build these patches.
        try {
          const latest = await this.readRecord(id, entry.type);
          this.acceptRecord(id, { type: entry.type, record: latest });
          if (!isDeepStrictEqual(latest, entry.record)) {
            conflict = true;
            outcome.state = 'failed';
            outcome.message = '写入前订阅已变化，未覆盖新内容；请重新选择。';
            break;
          }
        } catch {
          this.invalidate(id);
          outcome.state = 'failed';
          outcome.message = '写入前无法核对上游资源，本订阅未执行。';
          break;
        }
        let writeFailed = false;
        try {
          await this.client.api(
            '/api/' + entry.type + '/' + encodeURIComponent(entry.record.name),
            patch,
            'PATCH',
          );
        } catch {
          writeFailed = true;
        }
        this.invalidate(id);
        if (entry.type === 'sub') this.invalidateCollections(entry.record.name);
        try {
          const saved = await this.readRecord(id, entry.type);
          this.acceptRecord(id, { type: entry.type, record: saved });
          if (isDeepStrictEqual(saved, entry.record)) {
            outcome.state = 'failed';
            outcome.message = '回读确认原文和处理规则未改变，修改未生效。';
          } else if (!isDeepStrictEqual(saved, { ...entry.record, ...patch })) {
            outcome.state = 'unknown';
            outcome.message = '回读内容与预期不同，无法确认修改结果；请检查上游当前内容。';
          } else {
            const checked = await this.client.preview(
              captured.get(id)!.snapshot.resource.type,
              saved,
            );
            // Re-read after preview as a provider or an external writer can change
            // the record while upstream processors are running.
            const after = await this.readRecord(id, entry.type);
            this.acceptRecord(id, { type: entry.type, record: after });
            if (
              !isDeepStrictEqual(after, saved) ||
              nodeContentHash(checked.original) !== nodeContentHash(expected.original) ||
              nodeContentHash(checked.processed) !== nodeContentHash(expected.processed)
            ) {
              outcome.state = 'unknown';
              outcome.message = '已发出修改，但保存内容或实际预览未通过核验；请刷新检查。';
            } else {
              outcome.state = 'verified';
              outcome.deleted = deleted;
              outcome.excluded = excluded;
              outcome.message = '已回读保存内容并核验实际预览。';
              result.deleted += deleted;
              result.excluded += excluded;
            }
          }
        } catch {
          this.invalidate(id);
          outcome.state = 'unknown';
          outcome.message = '修改已发出，回读或预览失败，结果无法确认；请刷新检查。';
        }
        if (writeFailed || outcome.state !== 'verified') break;
      }
      if (result.resources.some((resource) => resource.state !== 'verified'))
        throw new AppError(
          conflict ? 'REVISION_CONFLICT' : 'UPSTREAM_PARTIAL_WRITE',
          '未能确认全部操作完成。已核验删除 ' +
            result.deleted +
            ' 个、排除 ' +
            result.excluded +
            ' 个。',
          conflict ? 409 : 502,
          undefined,
          result,
        );
      return result;
    });
  }
  private async readRecord(id: string, type: Entry['type']) {
    const matches = (await this.client.records(type)).filter((record) => marker(record)?.id === id);
    if (matches.length !== 1)
      throw new AppError('REVISION_CONFLICT', '上游资源已消失或身份不唯一，请重新选择。', 409);
    return matches[0]!;
  }
  async write(forward: () => Promise<Response>) {
    return this.client.exclusive(async () => {
      await this.syncUnlocked();
      try {
        return await forward();
      } finally {
        await this.syncUnlocked();
      }
    });
  }
}
