import { AppError, publicError } from './errors.js';
import type { Converter } from './converter/pool.js';
import type { NodeStore } from './nodes.js';
import type { SourceStore } from './sources.js';
import { ENGINE_VERSION, type SubscriptionStore, type ArtifactWrite } from './subscriptions.js';
import {
  produceResultSchema,
  renderResultSchema,
  isChain,
  diagnostic,
  type RenderItem,
  type WorkbenchItem,
} from './shared/contracts.js';
import {
  MAX_SUBSCRIPTIONS,
  outputGroup,
  targetGroups,
  type Subscription,
  type TargetGroup,
} from './shared/subscriptions.js';

export function composeItems(
  subscription: Subscription,
  input: RenderItem[],
  group: TargetGroup,
): RenderItem[] {
  return input.map((item) => {
    if (isChain(item)) {
      const chain = structuredClone(item);
      chain.excluded =
        item.excluded ||
        group === 'uri' ||
        !subscription.protocols[group].includes(chain.entry.protocol) ||
        !subscription.protocols[group].includes(chain.exit.protocol) ||
        (!!subscription.includeName && !chain.name.includes(subscription.includeName)) ||
        (!!subscription.excludeName && chain.name.includes(subscription.excludeName));
      if (group === 'uri')
        chain.diagnostics.push(
          diagnostic(
            chain.nodeIndex,
            'CHAIN_URI_EXCLUDED',
            'URI／Base64 不支持链式代理，已明确排除此链。',
            undefined,
            'warning',
          ),
        );
      if (!chain.excluded) chain.name = subscription.prefix + chain.name + subscription.suffix;
      return chain;
    }
    const draft = item.draft ? structuredClone(item.draft) : null;
    const excluded =
      item.excluded ||
      (!!draft &&
        (!subscription.protocols[group].includes(draft.protocol) ||
          (!!subscription.includeName && !draft.name.includes(subscription.includeName)) ||
          (!!subscription.excludeName && draft.name.includes(subscription.excludeName))));
    if (draft && !excluded) draft.name = subscription.prefix + draft.name + subscription.suffix;
    return { ...item, draft, excluded };
  });
}

type PublishingConverter = Pick<Converter, 'run' | 'ready' | 'isAvailable' | 'onAvailable'>;
export class Publisher {
  private interval: ReturnType<typeof setInterval> | undefined;
  private pending = new Set<string>();
  private running: string | undefined;
  private task: Promise<void> | undefined;
  private closed = false;
  private abort = new AbortController();
  private unsubscribe: () => void;
  private unlisten: () => void;
  constructor(
    private store: SubscriptionStore,
    private nodes: NodeStore,
    private sources: SourceStore,
    private converter: PublishingConverter,
    readonly engineVersion = ENGINE_VERSION,
  ) {
    this.unsubscribe = converter.onAvailable(() => this.wake());
    this.unlisten = store.listen((ids) => this.schedule(ids));
  }
  start() {
    this.interval = setInterval(() => this.schedule(this.store.enabledIds()), 6 * 60 * 60 * 1000);
    this.interval.unref?.();
    this.schedule(this.store.needsBuild(this.engineVersion));
  }
  status(id: string): 'idle' | 'queued' | 'running' {
    return this.running === id ? 'running' : this.pending.has(id) ? 'queued' : 'idle';
  }
  schedule(ids: string[]) {
    if (this.closed) return;
    for (const id of this.pending) if (!this.store.isEnabled(id)) this.pending.delete(id);
    for (const id of ids) {
      if (this.store.isEnabled(id)) this.pending.add(id);
      else this.pending.delete(id);
    }
    if (this.pending.size > MAX_SUBSCRIPTIONS) throw new Error('Subscription queue limit exceeded');
    this.wake();
  }
  private wake() {
    if (this.closed || this.task || !this.converter.isAvailable() || !this.pending.size) return;
    // Defer until the write response can be constructed. No work occurs in a DB transaction.
    this.task = Promise.resolve()
      .then(async () => {
        while (!this.closed && this.pending.size && this.converter.isAvailable()) {
          const id = this.pending.values().next().value;
          if (!id) break;
          this.pending.delete(id);
          this.running = id;
          try {
            await this.build(id);
          } catch {
            console.warn(JSON.stringify({ route: 'publisher', code: 'PUBLICATION_FAILED' }));
          }
          this.running = undefined;
        }
      })
      .finally(() => {
        this.task = undefined;
        this.running = undefined;
        this.wake();
      });
  }
  private async build(id: string) {
    let subscription: Subscription;
    try {
      subscription = this.store.get(id);
    } catch {
      return;
    }
    if (!subscription.enabled) return;
    let snapshot;
    try {
      await this.sources.sync();
      await this.sources.prepare(
        subscription.inputs.filter((i) => i.kind === 'source').map((i) => i.id),
      );
      snapshot = this.store.snapshot(id, this.nodes, this.sources);
    } catch (error) {
      if (!this.store.fail(id, subscription.revision, subscription.formats, publicError(error)))
        this.schedule([id]);
      return;
    }
    if (!snapshot) return;
    subscription = snapshot.subscription;
    for (const group of targetGroups) {
      const formats = subscription.formats.filter((f) => outputGroup(f) === group);
      if (!formats.length || this.closed) continue;
      if (!this.store.isEnabled(id)) return;
      try {
        await this.converter.ready;
        if (this.closed) return;
        const items = composeItems(subscription, snapshot.items, group);
        const warnings = items
          .filter((i) => !i.excluded)
          .flatMap((i) => i.diagnostics.filter((d) => d.level === 'warning'));
        let writes: ArtifactWrite[];
        if (group === 'uri') {
          const ordinary = items.filter((item): item is WorkbenchItem => !isChain(item));
          warnings.push(
            ...items
              .filter(isChain)
              .flatMap((item) => item.diagnostics.filter((d) => d.code === 'CHAIN_URI_EXCLUDED')),
          );
          if (!ordinary.some((item) => !item.excluded))
            throw new AppError(
              'EMPTY_OUTPUT',
              'URI／Base64 没有可输出的普通节点；链式代理仅提供内核配置。',
              422,
              warnings,
            );
          const result = produceResultSchema.parse(
            await this.converter.run(
              { kind: 'produce', input: { items: ordinary } },
              this.abort.signal,
            ),
          );
          if (formats.includes('base64') && result.base64 === null)
            throw new AppError(
              'BASE64_OUTPUT_LIMIT',
              'Base64 输出超过 4 MiB；已启用的 URI／Base64 本批均未替换。',
              422,
              result.diagnostics,
            );
          writes = formats.map((format) => ({
            format,
            content: format === 'uri' ? result.uri : (result.base64 ?? ''),
            counts: {
              ...result.counts,
              input: items.length,
              filtered: result.counts.filtered + items.length - ordinary.length,
            },
            diagnostics: [
              ...warnings,
              ...result.diagnostics.filter((d) => d.code !== 'BASE64_OUTPUT_LIMIT'),
            ],
          }));
        } else {
          const result = renderResultSchema.parse(
            await this.converter.run(
              {
                kind: 'render',
                input: { items, target: group, listenPort: subscription.listenPort },
              },
              this.abort.signal,
            ),
          );
          writes = formats.map((format) => ({
            format,
            content: format === group ? result.full : result.nodes,
            counts: result.counts,
            diagnostics: [...warnings, ...result.diagnostics],
          }));
        }
        if (this.closed) return;
        await this.sources.sync();
        if (!this.store.commit(id, subscription.revision, this.engineVersion, writes)) {
          this.schedule([id]);
          return;
        }
      } catch (error) {
        if (this.closed) return;
        if (error instanceof AppError && error.code === 'CONVERTER_BUSY') {
          this.schedule([id]);
          return;
        }
        if (!this.store.fail(id, subscription.revision, formats, publicError(error))) {
          this.schedule([id]);
          return;
        }
      }
    }
  }
  async idle() {
    while (this.task) await this.task;
  }
  async close() {
    clearInterval(this.interval);
    this.closed = true;
    this.unsubscribe();
    this.unlisten();
    this.pending.clear();
    this.abort.abort();
    await this.task;
  }
}
