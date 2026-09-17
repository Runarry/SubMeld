import { AppError, publicError } from './errors.js';
import { parseSource, type SourceStore } from './sources.js';
import { SourceFetcher } from './source-fetcher.js';
import type { Converter } from './converter/pool.js';
import { MAX_SOURCES, type Source } from './shared/subscriptions.js';
import type { WorkerRequest } from './shared/contracts.js';

type RefreshConverter = Pick<Converter, 'run' | 'ready' | 'isAvailable' | 'onAvailable'>;
const clock = { now: Date.now, setInterval, clearInterval };
export class SourceRefresher {
  private pending = new Set<string>();
  private running: { id: string; revision: number; abort: AbortController } | undefined;
  private task: Promise<void> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private started = false;
  private unlisten: () => void;
  constructor(
    private sources: SourceStore,
    private converter: RefreshConverter,
    private fetcher: Pick<SourceFetcher, 'fetch'> = new SourceFetcher(),
    private time = clock,
  ) {
    this.unlisten = sources.listenRefresh(
      (id, refresh) => this.schedule(id, refresh),
      (id) => this.status(id),
    );
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const refreshAll = () => {
      for (const id of this.sources.enabledRemoteIds()) this.schedule(id);
    };
    refreshAll();
    this.interval = this.time.setInterval(refreshAll, 6 * 60 * 60 * 1000);
    this.interval.unref?.();
  }
  status(id: string): Source['refresh'] {
    return this.running?.id === id ? 'running' : this.pending.has(id) ? 'queued' : 'idle';
  }
  private schedule(id: string, refresh = true) {
    if (this.closed) return;
    if (!this.sources.isRemoteEnabled(id)) {
      this.pending.delete(id);
      if (this.running?.id === id) this.running.abort.abort();
      return;
    }
    if (this.running?.id === id) {
      // Repeated refresh clicks share the running attempt; edits cancel it and queue the new version.
      if (this.sources.get(id).revision === this.running.revision) return;
      this.running.abort.abort();
      this.pending.add(id);
    } else if (refresh) this.pending.add(id);
    if (this.pending.size > MAX_SOURCES) throw new Error('Source refresh queue limit exceeded');
    this.wake();
  }
  private wake() {
    if (this.closed || this.task || !this.pending.size) return;
    this.task = Promise.resolve()
      .then(async () => {
        while (!this.closed && this.pending.size) {
          const id = this.pending.values().next().value;
          if (!id) break;
          this.pending.delete(id);
          if (!this.sources.isRemoteEnabled(id)) continue;
          const source = this.sources.get(id);
          const abort = new AbortController();
          this.running = { id, revision: source.revision, abort };
          const attemptedAt = new Date(this.time.now()).toISOString();
          try {
            if (!source.url || !source.headers) throw new Error('Invalid stored remote source');
            const text = await this.fetcher.fetch(
              { url: source.url, headers: source.headers },
              abort.signal,
            );
            if (abort.signal.aborted || this.closed) continue;
            const snapshot = await parseSource(
              text,
              source.format,
              {
                run: (request, signal) => this.runWhenAvailable(request, signal ?? abort.signal),
              },
              abort.signal,
            );
            if (abort.signal.aborted || this.closed) continue;
            if (!this.sources.accept(id, source.revision, text, snapshot, attemptedAt))
              this.schedule(id);
          } catch (error) {
            if (!abort.signal.aborted && !this.closed) {
              const { code, message } = publicError(error);
              this.sources.fail(id, source.revision, { code, message }, attemptedAt);
            }
          } finally {
            this.running = undefined;
          }
        }
      })
      .catch(() => {
        console.warn(JSON.stringify({ route: 'source-refresh', code: 'SOURCE_REFRESH_FAILED' }));
      })
      .finally(() => {
        this.task = undefined;
        this.running = undefined;
        this.wake();
      });
  }
  private runWhenAvailable(
    request: WorkerRequest,
    signal: AbortSignal,
  ): ReturnType<Converter['run']> {
    return new Promise((resolve, reject) => {
      let started = false;
      const cleanup = () => {
        unlisten();
        signal.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new AppError('SOURCE_CANCELLED', '来源刷新已取消。'));
      };
      const attempt = () => {
        if (started || signal.aborted || !this.converter.isAvailable()) return;
        started = true;
        cleanup();
        // Claim the Worker synchronously from its availability event. No downloaded body queue grows.
        this.converter.run(request, signal).then(resolve, reject);
      };
      const unlisten = this.converter.onAvailable(attempt);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      else {
        attempt();
        void this.converter.ready.then(attempt, (error: unknown) => {
          cleanup();
          reject(error);
        });
      }
    });
  }
  async idle() {
    while (this.task) await this.task;
  }
  async close() {
    this.closed = true;
    this.unlisten();
    if (this.interval) this.time.clearInterval(this.interval);
    this.pending.clear();
    this.running?.abort.abort();
    await this.task;
  }
}
