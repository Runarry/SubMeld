import { randomUUID } from 'node:crypto';
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
export class MiaospeedTester {
  private currentId: string | null = null;
  private task: Promise<void> | undefined;
  private abort = new AbortController();
  private closed = false;
  private statusValue = {
    connected: false,
    version: null as string | null,
    checkedAt: null as string | null,
    error: null as string | null,
  };
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
    this.client = new MiaospeedClient(config.miaospeedUrl, config.miaospeedToken);
  }
  status() {
    return {
      ...this.statusValue,
      configured: this.client.configured(),
      apiVersion: 3 as const,
      uploadEnabled: this.client.configured(),
      active: this.activity.current(),
    };
  }
  async check() {
    try {
      const value = await this.client.run(
        this.store.settings(),
        [],
        [],
        [],
        AbortSignal.timeout(10000),
        undefined,
        true,
      );
      this.statusValue = {
        connected: true,
        version: value.version,
        checkedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      this.statusValue = {
        ...this.statusValue,
        connected: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof AppError ? error.message : '后端检查失败。',
      };
    }
    return this.status();
  }
  async report(id: string) {
    const report = this.store.get(id),
      saved = report.results.filter((row) => row.subject.kind !== 'temporary');
    if (saved.length) {
      let confirmed = true;
      try {
        await this.input.refresh(saved.map((row) => row.subject));
      } catch {
        confirmed = false;
      }
      for (const row of saved)
        if (!confirmed || !this.input.matches(row.subject)) {
          row.stale = true;
          if (!['pending', 'running', 'cancelled'].includes(row.state)) row.state = 'stale';
        }
    }
    return report;
  }
  async current(): Promise<{ report: SpeedReport | null }> {
    const id = this.currentId ?? this.store.list(0).reports[0]?.id;
    try {
      return { report: id ? await this.report(id) : null };
    } catch (error) {
      if (this.currentId && error instanceof AppError && error.code === 'NOT_FOUND') {
        this.currentId = null;
        return this.current();
      }
      throw error;
    }
  }
  async start(input: unknown) {
    if (this.closed) throw new AppError('TEST_UNAVAILABLE', '测试服务已停止。', 503);
    const value = speedRequestSchema.parse(input),
      settings = validateSpeedSettings(value.settings);
    if (
      new Set(value.subjects.map((subject) => JSON.stringify(subject))).size !==
        value.subjects.length ||
      new Set(value.scripts.map((s) => s.id)).size !== value.scripts.length
    )
      throw new AppError('INVALID_REQUEST', '测试对象或脚本不能重复。', 400);
    if (!this.client.configured())
      throw new AppError('MIAOSPEED_UNCONFIGURED', '请先配置 miaospeed 后端。', 503);
    const release = this.activity.acquire('miaospeed');
    let lease: ReturnType<KernelManager['snapshot']> | undefined;
    try {
      await this.input.resources.sync();
      await this.input.refresh(value.subjects);
      const scripts = this.scripts.selected(value.scripts);
      const captured = value.subjects.map((subject) => this.input.capture(subject));
      lease = this.kernels.snapshot();
      const report: SpeedReport = {
        id: randomUUID(),
        name: value.name,
        state: 'running',
        createdAt: new Date().toISOString(),
        finishedAt: null,
        backendVersion: null,
        settings,
        metrics: value.metrics,
        scripts: scripts.map(({ id, name, revision, source }) => ({ id, name, revision, source })),
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
      this.abort = new AbortController();
      const signal = this.abort.signal,
        heldLease = lease;
      const refs = new Set(
        value.subjects.flatMap((subject) =>
          subject.kind === 'temporary' ? [subject.previewId] : [],
        ),
      );
      this.input.discard(refs);
      this.task = Promise.resolve()
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
              const core = executionCore(settings, row.subject);
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
              const result = await this.client.run(
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
              this.statusValue = {
                connected: true,
                version: result.version,
                checkedAt: new Date().toISOString(),
                error: null,
              };
              const entry = node.entry ?? (bridge ? node.raw : null);
              if (entry && value.metrics.includes('GEOIP_INBOUND')) {
                const entryMetric = row.measurements.find((m) => m.id === 'GEOIP_INBOUND')!;
                try {
                  const entryPayload = await this.input.payload(entry, 'node-entry', signal);
                  const entryResult = await this.client.run(
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
                  entryMetric.message = node.entry
                    ? '真实前置节点地址信息；出口与性能由整条链测得。'
                    : '真实节点地址信息；出口与性能经所选内核测得。';
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
                    ['TARGET_UNSUPPORTED', 'CONVERSION_FAILED'].includes(error.code)
                  ? 'unsupported'
                  : error instanceof AppError && error.code === 'REVISION_CONFLICT'
                    ? 'stale'
                    : 'failed';
              row.message = signal.aborted
                ? '已取消，已有结果保留。'
                : error instanceof AppError
                  ? error.message
                  : '测试无法完成，未将未知结果视为成功。';
              row.stale = row.state === 'stale';
              if (error instanceof AppError && error.code.startsWith('MIAOSPEED_')) {
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
        .finally(async () => {
          for (const row of report.results)
            if (row.state === 'pending' || row.state === 'running') {
              row.state = 'cancelled';
              row.message = signal.aborted ? '测试已取消。' : '批次停止，此项未执行。';
              this.store.saveRow(report.id, row);
            }
          if (report.state === 'running') report.state = signal.aborted ? 'cancelled' : 'completed';
          report.current = null;
          report.finishedAt = new Date().toISOString();
          this.store.save(report);
          captured.length = 0;
          await heldLease.release();
          release();
          this.task = undefined;
        });
      return this.store.get(report.id);
    } catch (error) {
      await lease?.release();
      release();
      throw error;
    }
  }
  cancel(id: string) {
    const report = this.store.get(id);
    if (id === this.currentId && this.task) {
      this.abort.abort();
      report.current = '正在取消，等待后端当前项结束';
      this.store.save(report);
    }
    return this.store.get(id);
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.task;
    this.input.close();
  }
}
