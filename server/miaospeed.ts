import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { AppError } from './errors.js';
import type { Config } from './config.js';
import type { Converter } from './converter/pool.js';
import type { KernelManager } from './kernels.js';
import type { TestActivity } from './test-activity.js';
import { MiaospeedClient, type Matrix } from './miaospeed-client.js';
import { MiaospeedInput } from './miaospeed-input.js';
import { MiaospeedScripts, backendScript } from './miaospeed-scripts.js';
import { MiaospeedStore } from './miaospeed-store.js';
import type { BackendConnection } from './miaospeed-backends.js';
import { startBridge } from './miaospeed-bridge.js';
import { measurements } from './miaospeed-results.js';
import { publicAddress, resolveSource } from './probe-address.js';
import { probeUrl } from './node-probe.js';
import {
  speedRequestSchema,
  speedSettingsSchema,
  metricDefinitions,
  executionCore,
  type SpeedSettings,
  type SpeedReport,
} from './shared/miaospeed.js';

export function validateSpeedSettings(input: unknown): SpeedSettings {
  const value = speedSettingsSchema.parse(input);
  for (const field of ['pingUrl', 'uploadUrl', 'downloadUrl'] as const) {
    if (field === 'downloadUrl' && value[field] === 'DYNAMIC:INTL') continue;
    const url = new URL(value[field]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new AppError('INVALID_REQUEST', '测试地址需要不含用户信息的 HTTP(S) URL。', 400);
  }
  probeUrl(value.pingUrl);
  const stun = new URL(value.stunAddress);
  if (stun.protocol !== 'udp:' || !stun.hostname || !stun.port || stun.username || stun.password)
    throw new AppError('INVALID_REQUEST', 'STUN 地址需要 udp://主机:端口 格式。', 400);
  return value;
}
export async function validateTargets(
  settings: SpeedSettings,
  selected: string[],
  signal: AbortSignal,
) {
  const urls = new Set<string>();
  if (selected.some((id) => id.startsWith('TEST_PING_') || id === 'TEST_HTTP_CODE'))
    urls.add(settings.pingUrl);
  if (selected.some((id) => id.startsWith('SPEED_')))
    // 4.7.6 resolves DYNAMIC:INTL to this fixed Google download (RefetchDownloadFiles).
    urls.add(
      settings.downloadUrl === 'DYNAMIC:INTL'
        ? 'https://dl.google.com/android/studio/maven-google-com/stable/offline-gmaven-stable.zip'
        : settings.downloadUrl,
    );
  if (selected.some((id) => id.startsWith('USPEED_'))) urls.add(settings.uploadUrl);
  if (selected.includes('UDP_TYPE')) urls.add(settings.stunAddress);
  for (const target of urls) {
    try {
      const host = new URL(target).hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host }] : await resolveSource(host, signal);
      for (const { address } of addresses) {
        if (/^198\.(18|19)\./.test(address))
          throw new AppError(
            'TEST_TARGET_ERROR',
            '测试目标 DNS 返回 Fake-IP，未执行节点测试。',
            422,
          );
        publicAddress(address);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AppError(
        'TEST_TARGET_ERROR',
        error instanceof AppError && error.code === 'TEST_TARGET_ERROR'
          ? error.message
          : '测试目标 DNS 失败或解析到非公网地址，无法据此判断节点状态。',
        422,
      );
    }
  }
}
type ReportValidity = { checkedAt: number; staleRows: Set<number> };
type BackendStatus = {
  connected: boolean;
  version: string | null;
  checkedAt: string | null;
  error: string | null;
};
const emptyStatus = (): BackendStatus => ({
  connected: false,
  version: null,
  checkedAt: null,
  error: null,
});
const connectionKey = (connection: BackendConnection) =>
  createHash('sha256').update(JSON.stringify(connection)).digest('hex');

export class MiaospeedTester {
  private currentId: string | null = null;
  private currentValidity: { id: string; value?: ReportValidity } | undefined;
  private reportChecks = new Map<string, Promise<ReportValidity>>();
  private task: Promise<void> | undefined;
  private activeId: string | null = null;
  private closing: Promise<void> | undefined;
  private abort = new AbortController();
  private closed = false;
  private statuses = new Map<string, { key: string; value: BackendStatus }>();
  readonly client: MiaospeedClient;
  constructor(
    readonly store: MiaospeedStore,
    readonly scripts: MiaospeedScripts,
    readonly input: MiaospeedInput,
    private kernels: KernelManager,
    private converter: Converter,
    private activity: TestActivity,
    private config: Pick<
      Config,
      'dataDir' | 'miaospeedUrl' | 'miaospeedToken' | 'miaospeedBridgeHost' | 'miaospeedBridgeBind'
    >,
    private targetCheck = validateTargets,
  ) {
    store.backends.configure(config.miaospeedUrl, config.miaospeedToken);
    this.client = new MiaospeedClient(config.miaospeedUrl, config.miaospeedToken);
  }
  captureBackend(id: string | undefined, core: SpeedSettings['nodeCore']): BackendConnection {
    const connection = this.store.backends.capture(id);
    if (connection.backend.kind === 'remote' && core !== 'native')
      throw new AppError(
        'MIAOSPEED_CORE_UNSUPPORTED',
        '远端测速服务仅支持 miaospeed 内置 Mihomo，请修改执行内核。',
        422,
      );
    return connection;
  }
  private clientFor(connection: BackendConnection) {
    return connection.backend.kind === 'environment'
      ? this.client
      : new MiaospeedClient(connection.backend.url, connection.token);
  }
  private saveStatus(connection: BackendConnection, value: BackendStatus) {
    // A late response must not replace the status of edited or deleted configuration.
    try {
      const current = this.store.backends.capture(connection.backend.id);
      if (connectionKey(current) === connectionKey(connection))
        this.statuses.set(connection.backend.id, { key: connectionKey(connection), value });
    } catch {
      /* The service may have been deleted while this task ran. */
    }
  }
  status(id?: string) {
    let connection: BackendConnection | undefined;
    let value = emptyStatus();
    try {
      connection = this.store.backends.capture(id);
      const cached = this.statuses.get(connection.backend.id);
      if (cached?.key === connectionKey(connection)) value = cached.value;
    } catch (error) {
      value.error = error instanceof AppError ? error.message : '测速服务配置无效。';
    }
    return {
      ...value,
      backendId: connection?.backend.id ?? null,
      configured: !!connection,
      apiVersion: 3 as const,
      uploadEnabled: null,
      active: this.activity.current(),
    };
  }
  async check(id?: string) {
    const connection = this.store.backends.capture(id);
    const client = this.clientFor(connection);
    try {
      const value = await client.run(
        this.store.settings(),
        [],
        [],
        [],
        AbortSignal.timeout(10000),
        undefined,
        true,
      );
      this.saveStatus(connection, {
        connected: true,
        version: value.version,
        checkedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      this.saveStatus(connection, {
        ...emptyStatus(),
        connected: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof AppError ? error.message : '后端检查失败。',
      });
    } finally {
      connection.token = '';
      if (connection.backend.kind === 'remote') client.clearCredentials();
    }
    return this.status(connection.backend.id);
  }
  private checkReport(report: SpeedReport) {
    const pending = this.reportChecks.get(report.id);
    if (pending) return pending;
    const check = (async (): Promise<ReportValidity> => {
      const saved = report.results.filter((row) => row.subject.kind !== 'temporary'),
        staleRows = new Set<number>();
      if (saved.length) {
        let confirmed = true;
        try {
          await this.input.refresh(saved.map((row) => row.subject));
        } catch {
          confirmed = false;
        }
        for (const row of saved)
          if (!confirmed || !this.input.matches(row.subject)) staleRows.add(row.index);
      }
      return { checkedAt: Date.now(), staleRows };
    })();
    if (!this.closed) this.reportChecks.set(report.id, check);
    void check
      .finally(() => {
        if (this.reportChecks.get(report.id) === check) this.reportChecks.delete(report.id);
      })
      .catch(() => {});
    return check;
  }
  private async readReport(id: string, useCache: boolean) {
    const report = this.store.get(id);
    const slot = !this.closed && this.currentValidity?.id === id ? this.currentValidity : undefined;
    const cached =
      useCache && slot?.value && Date.now() - slot.value.checkedAt < 30_000
        ? slot.value
        : undefined;
    const validity = cached ?? (await this.checkReport(report));
    if (slot && !this.closed && this.currentValidity === slot) slot.value = validity;
    // Progress may have advanced while the upstream snapshot was being checked.
    const current = cached ? report : this.store.get(id);
    for (const row of current.results)
      if (validity.staleRows.has(row.index)) {
        row.stale = true;
        if (!['pending', 'running', 'cancelled'].includes(row.state)) row.state = 'stale';
      }
    return current;
  }
  report(id: string) {
    return this.readReport(id, false);
  }
  removeReport(id: string) {
    const result = this.store.remove(id);
    if (this.currentId === id) this.currentId = null;
    if (this.currentValidity?.id === id) this.currentValidity = undefined;
    this.reportChecks.delete(id);
    return result;
  }
  async current(): Promise<{ report: SpeedReport | null }> {
    const id = this.currentId ?? this.store.list(0).reports[0]?.id;
    if (this.currentValidity?.id !== id) this.currentValidity = undefined;
    if (id && !this.closed && !this.currentValidity) this.currentValidity = { id };
    try {
      return { report: id ? await this.readReport(id, true) : null };
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') {
        if (this.currentValidity?.id === id) this.currentValidity = undefined;
        if (id) this.reportChecks.delete(id);
        if (this.currentId === id) this.currentId = null;
        return this.current();
      }
      throw error;
    }
  }
  async start(
    input: unknown,
    origin: SpeedReport['origin'] = 'web',
    reportId = randomUUID(),
    capturedBackend?: BackendConnection,
  ) {
    if (this.closed) throw new AppError('TEST_UNAVAILABLE', '测试服务已停止。', 503);
    const value = speedRequestSchema.parse(input),
      settings = validateSpeedSettings(value.settings);
    if (
      new Set(value.subjects.map((subject) => JSON.stringify(subject))).size !==
        value.subjects.length ||
      new Set(value.scripts.map((s) => s.id)).size !== value.scripts.length
    )
      throw new AppError('INVALID_REQUEST', '测试对象或脚本不能重复。', 400);
    const connection = capturedBackend
      ? structuredClone(capturedBackend)
      : this.captureBackend(value.backendId, settings.nodeCore);
    if (connection.backend.kind === 'remote' && settings.nodeCore !== 'native')
      throw new AppError(
        'MIAOSPEED_CORE_UNSUPPORTED',
        '远端测速服务仅支持 miaospeed 内置 Mihomo，请修改执行内核。',
        422,
      );
    const release = this.activity.acquire('miaospeed');
    const client = this.clientFor(connection);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let resolveReady!: (report: SpeedReport) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<SpeedReport>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const captured: ReturnType<MiaospeedInput['capture']>[] = [];
    let lease: ReturnType<KernelManager['snapshot']> | undefined;
    const checkAvailable = () => {
      if (this.closed || signal.aborted)
        throw new AppError('TEST_UNAVAILABLE', '测试服务已停止。', 503);
    };
    this.activeId = reportId;
    this.task = Promise.resolve().then(async () => {
      try {
        checkAvailable();
        await this.input.resources.sync();
        checkAvailable();
        await this.input.refresh(value.subjects);
        checkAvailable();
        const scripts = this.scripts.selected(value.scripts);
        for (const subject of value.subjects) captured.push(this.input.capture(subject));
        lease = this.kernels.snapshot();
        const report: SpeedReport = {
          id: reportId,
          origin,
          name: value.name,
          state: 'running',
          createdAt: new Date().toISOString(),
          finishedAt: null,
          backendVersion: null,
          backend: connection.backend,
          settings,
          metrics: value.metrics,
          scripts: scripts.map(({ id, name, revision, source }) => ({
            id,
            name,
            revision,
            source,
          })),
          total: captured.length,
          completed: 0,
          current: null,
          error: null,
          results: captured.map((node, index) => ({
            index,
            subject: value.subjects[index]!,
            name: node.name,
            protocol: node.protocol,
            state: 'pending',
            stale: false,
            message: '',
            testedAt: null,
            coreVersion: null,
            measurements: [],
          })),
        };
        this.store.create(report);
        this.currentId = report.id;
        this.currentValidity = undefined;
        const heldLease = lease;
        const refs = new Set(
          value.subjects.flatMap((subject) =>
            subject.kind === 'temporary' ? [subject.previewId] : [],
          ),
        );
        this.input.discard(refs);
        resolveReady(this.store.get(report.id));
        await Promise.resolve()
          .then(async () => {
            await this.targetCheck(settings, value.metrics, signal);
            for (const row of report.results) {
              if (signal.aborted) break;
              row.state = 'running';
              report.current = row.name;
              this.store.saveRow(report.id, row);
              this.store.save(report);
              const node = captured[row.index]!;
              let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
              try {
                if (node.error) throw new AppError('TARGET_UNSUPPORTED', node.error, 422);
                if (row.subject.kind !== 'temporary') {
                  await this.input.refresh([row.subject]);
                  this.input.capture(row.subject);
                }
                const name = 'sm-' + row.index;
                let payload: string;
                const core = executionCore(settings);
                if (core !== 'native') {
                  const binary = heldLease.binaries.get(core);
                  if (!binary)
                    throw new AppError('TARGET_UNSUPPORTED', '所选执行内核尚未安装。', 422);
                  row.coreVersion = binary.version;
                  bridge = await startBridge(
                    binary,
                    this.input.bridgeItem(node),
                    this.converter,
                    this.config.dataDir,
                    this.config.miaospeedBridgeHost,
                    signal,
                    this.config.miaospeedBridgeBind,
                  );
                  payload = bridge.payload;
                } else payload = await this.input.payload(node.raw!, name, signal);
                const ids = [
                  ...new Set(
                    value.metrics.map((id) =>
                      id === 'TEST_PING_MAX_CONN' ? 'TEST_PING_TOTAL_CONN' : id,
                    ),
                  ),
                ];
                if (value.metrics.some((id) => id.startsWith('TEST_PING_'))) {
                  for (const id of [
                    'TEST_PING_TOTAL_RTT',
                    'TEST_PING_TOTAL_CONN',
                    'TEST_HTTP_CODE',
                  ] as const)
                    if (!ids.includes(id)) ids.push(id);
                }
                const matrices: Matrix[] = [
                  ...ids.map((Type) => ({ Type, Params: '' })),
                  ...scripts.map((s) => ({ Type: 'TEST_SCRIPT', Params: s.id })),
                ];
                const update = (slot: Parameters<typeof measurements>[0], version: string) => {
                  report.backendVersion = version || report.backendVersion;
                  // A bridge's address is internal, including in progress or cancelled reports.
                  const result = bridge
                    ? {
                        ...slot,
                        Matrices: slot.Matrices?.filter((m) => m.Type !== 'GEOIP_INBOUND') ?? null,
                      }
                    : slot;
                  row.measurements = measurements(result, value.metrics, scripts);
                  this.store.saveRow(report.id, row);
                  this.store.save(report);
                };
                const result = await client.run(
                  settings,
                  [{ Name: name, Payload: payload }],
                  matrices,
                  scripts.map(backendScript),
                  signal,
                  (slot, _index, version) => update(slot, version),
                );
                if (result.slots.length !== 1)
                  throw new AppError('MIAOSPEED_PROTOCOL', '后端返回的节点数量与请求不一致。', 502);
                update(result.slots[0]!, result.version);
                this.saveStatus(connection, {
                  connected: true,
                  version: result.version,
                  checkedAt: new Date().toISOString(),
                  error: null,
                });
                const entry = bridge ? node.raw : null;
                if (entry && value.metrics.includes('GEOIP_INBOUND')) {
                  const entryMetric = row.measurements.find((m) => m.id === 'GEOIP_INBOUND')!;
                  try {
                    const entryPayload = await this.input.payload(entry, 'node-entry', signal);
                    const entryResult = await client.run(
                      settings,
                      [{ Name: 'node-entry', Payload: entryPayload }],
                      [{ Type: 'GEOIP_INBOUND', Params: '' }],
                      [],
                      signal,
                    );
                    Object.assign(
                      entryMetric,
                      measurements(
                        entryResult.slots[0] ?? { Matrices: [] },
                        ['GEOIP_INBOUND'],
                        [],
                      )[0],
                    );
                    entryMetric.message = '真实节点地址信息；出口与性能经所选内核测得。';
                  } catch (error) {
                    if (signal.aborted) throw error;
                    Object.assign(entryMetric, {
                      value: null,
                      geo: [],
                      status: 'unknown',
                      message: '无法取得真实入口节点信息。',
                    });
                  }
                }
                row.state = row.measurements.every((m) => m.status === 'measured')
                  ? 'completed'
                  : 'partial';
                row.message =
                  row.state === 'partial'
                    ? '部分检测没有确定结论；请查看各项结果。'
                    : '检测完成；具体可用性以各项结果为准。';
              } catch (error) {
                row.state = signal.aborted
                  ? 'cancelled'
                  : error instanceof AppError &&
                      (error.code === 'TARGET_UNSUPPORTED' ||
                        error.diagnostics?.some(
                          (diagnostic) => diagnostic.code === 'TARGET_UNSUPPORTED',
                        ))
                    ? 'unsupported'
                    : error instanceof AppError && error.code === 'REVISION_CONFLICT'
                      ? 'stale'
                      : 'failed';
                row.message = signal.aborted
                  ? '已取消，已有结果保留。'
                  : error instanceof AppError
                    ? error.diagnostics
                        ?.filter((diagnostic) => diagnostic.level === 'error')
                        .map((diagnostic) => diagnostic.message)
                        .join(' ') || error.message
                    : '测试无法完成，未将未知结果视为成功。';
                row.stale = row.state === 'stale';
                if (error instanceof AppError && error.code.startsWith('MIAOSPEED_')) {
                  this.saveStatus(connection, {
                    ...emptyStatus(),
                    checkedAt: new Date().toISOString(),
                    error: row.message,
                  });
                  report.state = 'failed';
                  report.error = row.message;
                }
              } finally {
                await bridge?.close();
                if (row.subject.kind !== 'temporary' && !signal.aborted) {
                  try {
                    await this.input.refresh([row.subject]);
                    if (!this.input.matches(row.subject)) {
                      row.stale = true;
                      row.state = 'stale';
                      row.message = '内容已变化，结果仅作为历史记录。';
                    }
                  } catch {
                    row.stale = true;
                    row.state = 'stale';
                    row.message = '内容已变化或无法核对，结果仅作为历史记录。';
                  }
                }
                row.testedAt = new Date().toISOString();
                report.completed++;
                this.store.saveRow(report.id, row);
                this.store.save(report);
                captured[row.index] = {
                  name: node.name,
                  protocol: node.protocol,
                  raw: null,
                  error: null,
                };
              }
              if (report.state === 'failed') break;
            }
          })
          .catch((error) => {
            report.state = signal.aborted ? 'cancelled' : 'failed';
            report.error = signal.aborted
              ? '测试已取消。'
              : error instanceof AppError
                ? error.message
                : '任务停止，已完成的结果保留。';
            if (error instanceof AppError && error.code === 'TEST_TARGET_ERROR')
              for (const row of report.results) {
                row.state = 'failed';
                row.message = error.message;
                row.measurements = value.metrics.map((id) => ({
                  id,
                  label: metricDefinitions.find((m) => m[0] === id)![1],
                  unit: '',
                  status: 'target_error',
                  value: null,
                  samples: [],
                  geo: [],
                  color: null,
                  message: error.message,
                }));
                this.store.saveRow(report.id, row);
              }
          })
          .finally(() => {
            for (const row of report.results)
              if (row.state === 'pending' || row.state === 'running') {
                row.state = 'cancelled';
                row.message = signal.aborted ? '测试已取消。' : '批次停止，此项未执行。';
                this.store.saveRow(report.id, row);
              }
            if (report.state === 'running')
              report.state = signal.aborted ? 'cancelled' : 'completed';
            report.current = null;
            report.finishedAt = new Date().toISOString();
            this.store.save(report);
          });
      } finally {
        connection.token = '';
        if (connection.backend.kind === 'remote') client.clearCredentials();
        captured.length = 0;
        try {
          await lease?.release();
        } finally {
          this.activeId = null;
          release();
        }
      }
    });
    // Observe preparation and late cleanup failures without creating an unhandled rejection.
    void this.task.catch(rejectReady);
    return ready;
  }
  cancel(id: string) {
    const report = this.store.get(id);
    if (id === this.activeId) {
      this.abort.abort();
      report.current = '正在取消，等待后端当前项结束';
      this.store.save(report);
    }
    return this.store.get(id);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.currentValidity = undefined;
    this.reportChecks.clear();
    this.abort.abort();
    this.closing = (async () => {
      try {
        await this.task;
      } catch (error) {
        if (!(
          error instanceof AppError &&
          error.code === 'TEST_UNAVAILABLE' &&
          error.status === 503
        ))
          throw error;
      } finally {
        this.input.close();
      }
    })();
    return this.closing;
  }
}
