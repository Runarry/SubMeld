import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError } from './errors.js';
import { UpstreamResources, hash, marker } from './upstream-resources.js';
import { identityKey } from './sub-store.js';
import { MAX_BYTES } from './shared/contracts.js';
import {
  hy2CertificateRequestSchema,
  type Hy2Certificate,
  type Hy2CertificateRequest,
  type Hy2CertificateResolver,
} from './shared/hy2-certificates.js';
import { certificateProof, verifyCertificateProof } from './converter/certificate-pin.js';
import { hysteriaPortRanges } from './converter/hysteria2.js';
import { startProcess } from './kernel-process.js';

type Job = { controller: AbortController; promise: Promise<Hy2Certificate>; users: number };
const cacheSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.unknown());
const messages: Record<string, string> = {
  HY2_CERTIFICATE_MISMATCH: 'HY2 服务端证书与 pinSHA256 不匹配，未生成公钥固定校验。',
  HY2_CERTIFICATE_TIMEOUT: 'HY2 证书握手超时；节点不可达且没有已验证缓存时无法生成 sing-box 配置。',
  HY2_CERTIFICATE_DNS: 'HY2 节点地址解析失败，无法取得服务器证书。',
  HY2_CERTIFICATE_UNREACHABLE: '无法完成 HY2 证书握手，请检查节点地址、端口、SNI 和混淆设置。',
  HY2_CERTIFICATE_INVALID: 'HY2 服务端未返回有效证书。',
  HY2_PROBE_INVALID: 'HY2 证书探测参数无效。',
};

/** Only public certificate proofs are persisted; probe inputs stay in memory. */
export class Hy2Certificates {
  private jobs = new Map<string, Job>();
  private waiters = new Set<() => void>();
  private active = 0;
  private closed = false;
  constructor(
    readonly resources: UpstreamResources,
    private readonly token: string,
    private readonly probeOverride?: Hy2CertificateResolver,
  ) {}

  authorize(value?: string) {
    const supplied = Buffer.from(value ?? '');
    const expected = Buffer.from('Bearer ' + this.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new AppError('HY2_RESOLVER_UNAUTHORIZED', '证书解析服务认证失败。', 401);
  }

  resolve = async (input: unknown, signal?: AbortSignal): Promise<Hy2Certificate> => {
    if (this.closed) throw new AppError('HY2_RESOLVER_UNAVAILABLE', '证书解析服务已停止。', 503);
    signal?.throwIfAborted();
    const request = hy2CertificateRequestSchema.parse(input);
    try {
      hysteriaPortRanges(request.ports);
    } catch {
      throw new AppError('HY2_PROBE_INVALID', 'HY2 证书探测端口范围无效。', 422);
    }
    const key = hash([
      request.pinSHA256,
      request.server,
      request.port,
      request.ports,
      request.serverName,
      request.obfs,
      request.obfsPassword,
    ]);
    let job = this.jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      job = { controller, users: 0, promise: this.work(request, controller.signal) };
      const current = job;
      this.jobs.set(key, current);
      void current.promise
        .finally(() => {
          if (this.jobs.get(key) === current) this.jobs.delete(key);
        })
        .catch(() => {});
    }
    const current = job;
    current.users++;
    return new Promise<Hy2Certificate>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener('abort', abort);
        if (--current.users === 0) current.controller.abort();
        return true;
      };
      const abort = () => {
        if (finish()) reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (proof) => {
          if (finish()) resolve(proof);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
      if (signal?.aborted) abort();
    });
  };

  private cache() {
    const files = this.resources.files('certificate-cache');
    if (files.length > 1) throw new AppError('HY2_CACHE_INVALID', 'HY2 证书缓存文件重复。', 422);
    const file = files[0];
    if (!file) return { file, entries: {} as Record<string, unknown> };
    try {
      if (
        marker(file.record)?.version !== 1 ||
        file.record.source !== 'local' ||
        (Array.isArray(file.record.process) && file.record.process.length)
      )
        throw new Error('Invalid cache');
      return { file, entries: cacheSchema.parse(JSON.parse(String(file.record.content))) };
    } catch {
      throw new AppError(
        'HY2_CACHE_INVALID',
        'HY2 证书缓存文件格式无效，请检查 Sub-Store 配套文件。',
        422,
      );
    }
  }

  private async remember(proof: Hy2Certificate, signal: AbortSignal) {
    await this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      signal.throwIfAborted();
      const { file, entries } = this.cache();
      if (entries[proof.pinSHA256]) {
        verifyCertificateProof(proof.pinSHA256, entries[proof.pinSHA256]);
        return;
      }
      const revision = file ? hash(file.record) : undefined;
      entries[proof.pinSHA256] = proof;
      // Derived, content-addressed cache entries may be evicted; source nodes are untouched.
      while (Buffer.byteLength(JSON.stringify(entries)) > MAX_BYTES) {
        const oldest = Object.keys(entries).find((key) => key !== proof.pinSHA256);
        if (!oldest) throw new AppError('HY2_CACHE_INVALID', 'HY2 证书超过缓存大小限制。', 422);
        delete entries[oldest];
      }
      if (file) {
        await this.resources.syncUnlocked();
        if (hash(this.resources.record(file.id).record) !== revision)
          throw new AppError('HY2_CACHE_CONFLICT', 'HY2 证书缓存已变化，请重新生成。', 409);
        await this.resources.client.api(
          '/api/file/' + encodeURIComponent(file.record.name),
          { content: JSON.stringify(entries) },
          'PATCH',
          signal,
        );
      } else {
        await this.resources.client.api(
          '/api/files',
          {
            name: 'sm-hy2-certificates-v1',
            displayName: 'HY2 已验证证书缓存',
            source: 'local',
            type: 'file',
            content: JSON.stringify(entries),
            process: [],
            [identityKey]: { id: randomUUID(), role: 'certificate-cache', version: 1 },
          },
          'POST',
          signal,
        );
      }
      await this.resources.syncUnlocked();
    });
  }

  private async work(request: Hy2CertificateRequest, signal: AbortSignal) {
    await this.resources.sync();
    signal.throwIfAborted();
    const cached = this.cache().entries[request.pinSHA256];
    if (cached) return verifyCertificateProof(request.pinSHA256, cached);
    while (this.active >= 4) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => {
          this.waiters.delete(wake);
          signal.removeEventListener('abort', abort);
        };
        this.waiters.add(wake);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    this.active++;
    const abort = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      const value = await (this.probeOverride
        ? this.probeOverride(request, abort)
        : this.probe(request, abort));
      abort.throwIfAborted();
      const proof = verifyCertificateProof(request.pinSHA256, value);
      await this.remember(proof, abort);
      return proof;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (abort.aborted)
        throw new AppError('HY2_CERTIFICATE_TIMEOUT', messages.HY2_CERTIFICATE_TIMEOUT!, 422);
      throw error;
    } finally {
      this.active--;
      for (const wake of [...this.waiters]) wake();
    }
  }

  private async probe(request: Hy2CertificateRequest, signal: AbortSignal) {
    let child: ReturnType<typeof startProcess> | undefined;
    const abort = () => {
      void child?.stop();
    };
    try {
      const binary = fileURLToPath(
        new URL(
          (import.meta.url.endsWith('.ts') ? '../dist/' : '../') +
            'hy2-cert-probe/' +
            (process.platform === 'win32' ? 'windows-amd64.exe' : 'linux-amd64'),
          import.meta.url,
        ),
      );
      signal.throwIfAborted();
      child = startProcess(binary, [], undefined, JSON.stringify(request));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      await child.done;
      signal.throwIfAborted();
      let result;
      try {
        result = z
          .object({ certificatePem: z.string().max(65536).optional(), code: z.string().optional() })
          .parse(JSON.parse(child.stdout));
      } catch {
        throw new AppError(
          'HY2_RESOLVER_UNAVAILABLE',
          'HY2 证书探测器不可用，请检查构建产物。',
          422,
        );
      }
      if (result.code || !result.certificatePem) {
        const code = result.code && messages[result.code] ? result.code : 'HY2_CERTIFICATE_INVALID';
        throw new AppError(code, messages[code]!, 422);
      }
      return certificateProof(request.pinSHA256, result.certificatePem);
    } finally {
      signal.removeEventListener('abort', abort);
      await child?.stop();
    }
  }

  async close() {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.promise));
  }
}
