import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { AppError } from './errors.js';
import { startProcess } from './kernel-process.js';
import { parseScannerLine } from './reality-scanner-output.js';
import { fetchScannerPage, extractScannerDomains } from './reality-scanner-source.js';
import { RealityScannerStore, type ScanFilter } from './reality-scanner-store.js';
import {
  SCANNER_VERSION,
  SCAN_MAX_BYTES,
  normalizeScanTargets,
  scanActive,
  scanDomain,
  scanStartSchema,
  scanPreviewInputSchema,
  type ScanSummary,
  type ScanResult,
} from './shared/reality-scanner.js';

type Options = { launch?: typeof startProcess; fetchPage?: typeof fetchScannerPage };
type ActiveScan = { summary: ScanSummary; controller: AbortController; done: Promise<void> };
export class RealityScanner {
  private root: string;
  private binary = '';
  private available = false;
  private availabilityMessage = '扫描器尚未初始化。';
  private geoip: 'unknown' | 'available' | 'unavailable' = 'unknown';
  private active: ActiveScan | null = null;
  private closed = false;
  private previews = new Set<AbortController>();
  constructor(
    readonly store: RealityScannerStore,
    dataDir: string,
    private options: Options = {},
  ) {
    this.root = resolve(dataDir, 'reality-scanner');
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^scan-[a-f0-9-]{36}$/.test(entry.name))
        await rm(join(this.root, entry.name), { recursive: true, force: true });
    }
    const directory = fileURLToPath(
      new URL(
        (import.meta.url.endsWith('.ts') ? '../dist/' : '../') + 'reality-scanner/',
        import.meta.url,
      ),
    );
    try {
      const manifest = z
        .object({
          version: z.literal(SCANNER_VERSION),
          platforms: z.record(
            z.string(),
            z.object({
              asset: z.string().regex(/^[\w.-]+$/),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          ),
        })
        .parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
      const asset = manifest.platforms[process.platform + '-' + process.arch];
      if (!asset) throw new Error('Unsupported platform');
      this.binary = join(directory, asset.asset);
      if (
        createHash('sha256')
          .update(await readFile(this.binary))
          .digest('hex') !== asset.sha256
      )
        throw new Error('Checksum mismatch');
      this.available = true;
      this.availabilityMessage = '';
    } catch {
      this.availabilityMessage = '官方扫描器缺失、校验失败或平台不受支持，请重新构建。';
    }
    try {
      await access(join(this.root, 'Country.mmdb'));
    } catch {
      this.geoip = 'unavailable';
    }
    if (this.available && this.geoip === 'unknown') await this.inspectGeoip();
  }
  private async inspectGeoip() {
    const directory = join(this.root, 'scan-' + randomUUID());
    await mkdir(directory, { mode: 0o700 });
    let child: ReturnType<typeof startProcess> | undefined;
    try {
      const input = join(directory, 'input.txt');
      await writeFile(input, '', { mode: 0o600 });
      child = startProcess(this.binary, ['-in', input, '-out', '', '-v'], this.root);
      const timer = setTimeout(() => {
        void child?.stop();
      }, 5000);
      try {
        await child.done;
        this.geoip = child.stdout.includes('msg="Enabled GeoIP"') ? 'available' : 'unavailable';
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await child?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
  status() {
    return {
      version: SCANNER_VERSION,
      available: this.available && !this.closed,
      message: this.availabilityMessage,
      geoip: this.geoip,
      active: this.active ? { ...this.active.summary } : null,
    };
  }
  async preview(input: unknown) {
    const value = scanPreviewInputSchema.parse(input);
    if (this.closed) throw new AppError('SCANNER_CLOSED', '扫描服务正在停止。', 503);
    if (value.kind === 'text') return normalizeScanTargets(value.text, value.enableIpv6);
    const controller = new AbortController();
    this.previews.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    try {
      const html = await (this.options.fetchPage ?? fetchScannerPage)(value.url, signal);
      signal.throwIfAborted();
      if (Buffer.byteLength(html) > SCAN_MAX_BYTES)
        throw new AppError('SCAN_PAGE_LIMIT', '网页正文超过 4 MiB。', 413);
      return normalizeScanTargets(extractScannerDomains(html).join('\n'), value.enableIpv6);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'SCAN_PAGE_FAILED',
        signal.aborted ? '网页获取已取消或超过 20 秒。' : '网页获取失败，请检查地址与网络。',
        502,
      );
    } finally {
      this.previews.delete(controller);
    }
  }
  start(input: unknown): ScanSummary {
    const value = scanStartSchema.parse(input);
    const preview = normalizeScanTargets(value.targets.join('\n'), value.parameters.enableIpv6);
    if (preview.invalidCount)
      throw new AppError(
        'SCAN_INPUT_INVALID',
        preview.errors.map((e) => (e.line ? '第 ' + e.line + ' 行：' : '') + e.message).join('\n'),
        400,
      );
    if (!this.available || this.closed)
      throw new AppError('SCANNER_UNAVAILABLE', this.availabilityMessage || '扫描器不可用。', 503);
    if (this.active)
      throw new AppError('SCAN_BUSY', '已有扫描正在运行，请查看当前任务或停止后重试。', 409);
    const summary: ScanSummary = {
      id: randomUUID(),
      version: SCANNER_VERSION,
      state: 'preparing',
      parameters: value.parameters,
      total: preview.count,
      completed: 0,
      matched: 0,
      unmatched: 0,
      failed: 0,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      message: '',
      geoip: 'unknown',
    };
    this.store.save(summary);
    const task: ActiveScan = {
      summary,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = task;
    task.done = this.run(task, preview.targets);
    // The runner records failures; observe unexpected persistence/cleanup failures as well.
    void task.done.catch(() => {});
    return { ...summary };
  }
  private async run(task: ActiveScan, targets: string[]) {
    const summary = task.summary,
      signal = task.controller.signal;
    const directory = join(this.root, 'scan-' + summary.id);
    let child: ReturnType<typeof startProcess> | undefined;
    let started = false,
      completed = false,
      fatal = '',
      cancelled = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const buffers = { stdout: '', stderr: '' };
    const line = (text: string) => {
      if (!text.trim() || fatal) return;
      try {
        const event = parseScannerLine(text, summary.parameters.port, summary.completed);
        if (event.kind === 'started') {
          started = true;
          if (summary.state !== 'cancelling') summary.state = 'running';
          this.store.save(summary);
        } else if (event.kind === 'completed') completed = true;
        else if (event.kind === 'geoip') {
          summary.geoip = this.geoip = event.available ? 'available' : 'unavailable';
          this.store.save(summary);
        } else if (event.kind === 'fatal') {
          fatal = event.message;
          void child?.stop();
        } else if (event.kind === 'result') {
          if (summary.completed >= summary.total) throw new Error('Excess scanner results');
          summary.completed++;
          summary[event.result.state]++;
          this.store.append(summary, event.result);
        }
      } catch {
        fatal = '扫描器输出无法完整解析，已停止并保留此前结果。';
        void child?.stop();
      }
    };
    const output = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      buffers[stream] += decoders[stream].write(chunk);
      let end: number;
      while ((end = buffers[stream].indexOf('\n')) !== -1) {
        const text = buffers[stream].slice(0, end);
        buffers[stream] = buffers[stream].slice(end + 1);
        if (text.length > 65536) {
          fatal = '扫描器输出行超过限制。';
          void child?.stop();
          return;
        }
        line(text);
      }
      if (buffers[stream].length > 65536) {
        fatal = '扫描器输出行超过限制。';
        buffers[stream] = '';
        void child?.stop();
      }
    };
    const abort = () => {
      cancelled = true;
      void child?.stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await mkdir(directory, { mode: 0o700 });
      const input = join(directory, 'input.txt');
      await writeFile(input, targets.join('\n') + '\n', { mode: 0o600 });
      targets.length = 0;
      signal.throwIfAborted();
      const p = summary.parameters;
      child = (this.options.launch ?? startProcess)(
        this.binary,
        [
          '-in',
          input,
          '-out',
          '',
          '-v',
          '-port',
          String(p.port),
          '-thread',
          String(p.concurrency),
          '-timeout',
          String(p.timeoutSeconds),
          ...(p.enableIpv6 ? ['-46'] : []),
        ],
        this.root,
        undefined,
        output,
      );
      if (signal.aborted) abort();
      const code = await child.done;
      for (const stream of ['stdout', 'stderr'] as const) {
        buffers[stream] += decoders[stream].end();
        // Killing the process may cut a slog record mid-write. Only complete lines
        // are results after an intentional stop; a truncated suffix is not a failure.
        if (buffers[stream] && !signal.aborted) line(buffers[stream]);
      }
      if (
        !cancelled &&
        (code !== 0 || !started || !completed || summary.completed !== summary.total)
      )
        fatal ||= '扫描器异常结束或结果不完整，已保留收到的结果。';
    } catch {
      if (!signal.aborted) fatal ||= '无法启动或完成扫描，请检查构建产物及数据目录。';
    } finally {
      targets.length = 0;
      signal.removeEventListener('abort', abort);
      try {
        await child?.stop();
        await rm(directory, { recursive: true, force: true });
      } catch {
        fatal ||= '扫描已停止，但临时文件清理失败，请检查数据目录权限。';
      }
      summary.state = this.closed
        ? 'interrupted'
        : fatal
          ? 'failed'
          : signal.aborted
            ? 'cancelled'
            : 'completed';
      summary.message =
        fatal ||
        (this.closed
          ? '服务停止，扫描已中断。'
          : signal.aborted
            ? '扫描已停止，已收到的结果予以保留。'
            : '有限目标已扫描完毕。');
      summary.finishedAt = new Date().toISOString();
      try {
        this.store.save(summary);
      } finally {
        if (this.active === task) this.active = null;
      }
    }
  }
  cancel(id: string) {
    const task = this.active;
    if (!task || task.summary.id !== id) return this.store.get(id);
    task.summary.state = 'cancelling';
    this.store.save(task.summary);
    task.controller.abort();
    return { ...task.summary };
  }
  async close() {
    this.closed = true;
    for (const preview of this.previews) preview.abort();
    const task = this.active;
    if (task) {
      this.cancel(task.summary.id);
      await task.done;
    }
  }
  export(id: string, filter: ScanFilter, format: 'csv' | 'ips' | 'domains') {
    const rows = this.store.allResults(id, filter);
    if (format !== 'csv') {
      const values = [
        ...new Set(
          rows
            .map((row) => (format === 'ips' ? row.ip : (scanDomain(row.origin) ?? '')))
            .filter(Boolean),
        ),
      ];
      return values.join('\n') + (values.length ? '\n' : '');
    }
    const cell = (value: string | number) => {
      const text = String(value);
      const safe = /^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    const fields: (keyof ScanResult)[] = [
      'ip',
      'origin',
      'tls',
      'alpn',
      'curve',
      'certLength',
      'certSignature',
      'certPublicKey',
      'certDomain',
      'certIssuer',
      'countryCode',
      'port',
      'state',
      'message',
    ];
    return (
      '\uFEFFIP,ORIGIN,TLS,ALPN,CURVE,CERT_LENGTH,CERT_SIGNATURE,CERT_PUBLICKEY,CERT_DOMAIN,CERT_ISSUER,GEO_CODE,PORT,STATE,MESSAGE\r\n' +
      rows.map((row) => fields.map((key) => cell(row[key])).join(',')).join('\r\n') +
      (rows.length ? '\r\n' : '')
    );
  }
  remove(id: string) {
    if (this.active?.summary.id === id || scanActive(this.store.get(id).state))
      throw new AppError('SCAN_BUSY', '请先停止扫描，再删除记录。', 409);
    this.store.remove(id);
  }
}
