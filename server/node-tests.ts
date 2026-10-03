import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import type { Converter } from './converter/pool.js';
import { renderResultSchema, type RenderItem, type RenderTarget } from './shared/contracts.js';
import {
  coreTargets,
  testSelectionSchema,
  type TestBatch,
  type TestResult,
} from './shared/node-tests.js';
import type { NodeTestStore } from './node-test-store.js';
import type { KernelManager } from './kernels.js';
import { freeProbePort, runNodeProbe } from './node-probe.js';
import { TestActivity } from './test-activity.js';

type TestConverter = Pick<Converter, 'run' | 'isAvailable' | 'onAvailable'>;
export class NodeTester {
  private batch: TestBatch | null = null;
  private task: Promise<void> | undefined;
  private abort = new AbortController();
  private closed = false;
  constructor(
    readonly store: NodeTestStore,
    readonly kernels: KernelManager,
    private converter: TestConverter,
    private dataDir: string,
    private probe: typeof runNodeProbe = runNodeProbe,
    private activity = new TestActivity(),
  ) {}
  current(page = 0) {
    if (!this.batch) return { batch: null };
    return {
      batch: {
        ...this.batch,
        current: this.batch.current ? { ...this.batch.current } : null,
        results: this.batch.results
          .slice(page * 25, page * 25 + 25)
          .map((result) => this.store.fresh(result, this.kernels.versions())),
        page,
      },
    };
  }
  get(id: string, page = 0) {
    if (this.batch?.id !== id)
      throw new AppError('NOT_FOUND', '此测试批次已结束或应用已重启。', 404);
    return this.current(page).batch;
  }
  start(input: unknown) {
    if (this.closed || this.task)
      throw new AppError('TEST_BUSY', '已有测试批次正在运行，请查看进度或取消后重试。', 503);
    const parsed = testSelectionSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('INVALID_REQUEST', '请选择 1～2,000 个不重复的已保存测试对象。', 400);
    const subjects = parsed.data.subjects;
    const selection = this.store.selection(subjects);
    const releaseActivity = this.activity.acquire('三内核连通性');
    let lease: ReturnType<KernelManager['snapshot']>;
    let url: string;
    try {
      lease = this.kernels.snapshot();
      url = this.store.settings().url;
    } catch (error) {
      releaseActivity();
      throw error;
    }
    const batch: TestBatch = {
      id: randomUUID(),
      state: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      total: subjects.length * coreTargets.length,
      completed: 0,
      current: null,
      results: [],
      page: 0,
    };
    this.batch = batch;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.task = Promise.resolve()
      .then(async () => {
        for (const { subject, name } of selection) {
          for (const core of coreTargets) {
            if (signal.aborted) return;
            batch.current = { name, core };
            const binary = lease.binaries.get(core);
            const result: TestResult = {
              subject,
              name,
              core,
              coreVersion: binary?.version ?? null,
              url,
              testedAt: new Date().toISOString(),
              status: 'passed',
              latencyMs: null,
              httpStatus: null,
              message: 'HTTPS 请求成功。',
              stale: false,
            };
            try {
              await this.store.refresh([subject]);
              const { item } = this.store.capture(subject);
              const port = await freeProbePort();
              const rendered = await this.render(item, core, port, signal);
              if (!binary)
                throw new AppError(
                  'TEST_CORE_MISSING',
                  '此内核尚未安装或校验失败，请前往内核管理安装。',
                );
              signal.throwIfAborted();
              const measured = await this.probe(
                binary,
                rendered.full,
                port,
                url,
                this.dataDir,
                signal,
              );
              Object.assign(result, measured);
              if (measured.httpStatus < 200 || measured.httpStatus >= 300) {
                result.status = 'http_error';
                result.message =
                  '已收到 HTTPS 响应，测试目标返回 HTTP ' + measured.httpStatus + '。';
              }
            } catch (error) {
              if (signal.aborted) {
                result.status = 'cancelled';
                result.message = '测试已取消，已有完成结果保留。';
              } else if (error instanceof AppError) {
                result.message =
                  error.diagnostics
                    ?.filter((diagnostic) => diagnostic.level === 'error')
                    .map((diagnostic) => diagnostic.message)
                    .join(' ') || error.message;
                if (error.code === 'TARGET_UNSUPPORTED') {
                  result.status = 'unsupported';
                } else if (
                  error.diagnostics?.some((diagnostic) => diagnostic.code === 'TARGET_UNSUPPORTED')
                ) {
                  result.status = 'unsupported';
                } else if (error.code === 'REVISION_CONFLICT' || error.code === 'NOT_FOUND')
                  result.status = 'stale';
                else if (
                  ['TEST_DNS_FAKE_IP', 'TEST_DNS_FAILED', 'TEST_ADDRESS_REJECTED'].includes(
                    error.code,
                  )
                )
                  result.status = 'target_error';
                else if (error.code === 'TEST_CORE_MISSING') result.status = 'core_unavailable';
                else if (
                  error.code === 'TEST_TIMEOUT' ||
                  error.code === 'TEST_START_TIMEOUT' ||
                  error.code === 'WORKER_TIMEOUT'
                )
                  result.status = 'timeout';
                else if (error.code === 'TEST_TLS_FAILED') result.status = 'tls_error';
                else if (error.code.startsWith('TEST_') && error.code !== 'TEST_CONFIG_FAILED')
                  result.status = 'network_error';
                else result.status = 'config_error';
              } else {
                result.status = 'network_error';
                result.message = '测试无法完成，临时进程已关闭。';
              }
            }
            if (!['cancelled', 'stale'].includes(result.status)) {
              try {
                await this.store.refresh([subject]);
              } catch {
                result.status = 'stale';
                result.stale = true;
                result.message = '无法确认上游对象仍有效，结果未保存。';
              }
            }
            if (!['cancelled', 'stale'].includes(result.status) && !this.store.save(result)) {
              result.status = 'stale';
              result.stale = true;
              result.message = '测试期间内容已变化，结果未保存。';
            }
            batch.results.push(result);
            batch.completed++;
          }
        }
      })
      .catch(() => {
        batch.state = 'failed';
        batch.error = '测试结果保存失败，批次已停止。';
      })
      .finally(async () => {
        await lease.release();
        releaseActivity();
        if (batch.state !== 'failed') batch.state = signal.aborted ? 'cancelled' : 'completed';
        batch.finishedAt = new Date().toISOString();
        batch.current = null;
        this.task = undefined;
      });
    return this.current().batch;
  }
  private async render(
    item: RenderItem,
    target: RenderTarget,
    listenPort: number,
    signal: AbortSignal,
  ) {
    for (;;) {
      signal.throwIfAborted();
      if (!this.converter.isAvailable())
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            unsubscribe();
            signal.removeEventListener('abort', abort);
          };
          const ready = () => {
            cleanup();
            resolve();
          };
          const abort = () => {
            cleanup();
            reject(new AppError('TEST_CANCELLED', '测试已取消。'));
          };
          const unsubscribe = this.converter.onAvailable(ready);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else if (this.converter.isAvailable()) ready();
        });
      try {
        return renderResultSchema.parse(
          await this.converter.run(
            { kind: 'render', input: { target, listenPort, items: [item] } },
            signal,
          ),
        );
      } catch (error) {
        if (error instanceof AppError && error.code === 'CONVERTER_BUSY') continue;
        throw error;
      }
    }
  }
  cancel(id: string) {
    this.get(id);
    if (this.batch?.state === 'running') this.abort.abort();
    return this.current().batch;
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.task;
  }
}
