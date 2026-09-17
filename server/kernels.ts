import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  rename,
  chmod,
  lstat,
  cp,
  readdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { AppError } from './errors.js';
import { runProcess } from './kernel-process.js';
import { basicConfig } from './templates/basic.js';
import { coreTargets, type KernelStatus } from './shared/node-tests.js';
import { type RenderTarget, renderTargetSchema } from './shared/contracts.js';
import { stringify } from 'yaml';

const repositories = {
  mihomo: 'MetaCubeX/mihomo',
  singbox: 'SagerNet/sing-box',
  xray: 'XTLS/Xray-core',
};
const versionSchema = z.string().regex(/^\d[\da-zA-Z.-]{0,63}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const installedSchema = z.strictObject({
  version: versionSchema,
  directory: z.string().regex(/^\d[\da-zA-Z.-]{0,80}$/),
  sha256: digestSchema,
});
type Installed = z.infer<typeof installedSchema>;
export type KernelBinary = { target: RenderTarget; version: string; path: string };
type Asset = {
  target: RenderTarget;
  version: string;
  name: string;
  member: string;
  sha256: string;
  url: string;
};
const releaseSchema = z.object({
  tag_name: z.string().regex(/^v\d[\da-zA-Z.-]{0,63}$/),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(z.object({ name: z.string(), digest: z.string().nullable().optional() })),
});
export const kernelLocksSchema = z.record(
  renderTargetSchema,
  z.object({
    version: versionSchema,
    repo: z.string(),
    tag: z.string(),
    platforms: z.record(
      z.string(),
      z.object({ asset: z.string(), sha256: digestSchema, binary: z.string() }),
    ),
  }),
);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const executable = () => (process.platform === 'win32' ? 'core.exe' : 'core');

function assetNames(target: RenderTarget, version: string) {
  if (process.arch !== 'x64' || !['win32', 'linux'].includes(process.platform))
    throw new AppError(
      'KERNEL_PLATFORM_UNSUPPORTED',
      '内核测试目前支持 Windows x64 和 Linux x64。',
    );
  const windows = process.platform === 'win32';
  if (target === 'mihomo')
    return {
      name: `mihomo-${windows ? 'windows' : 'linux'}-amd64-v1-v${version}.${windows ? 'zip' : 'gz'}`,
      member: windows ? 'mihomo-windows-amd64-v1.exe' : 'mihomo',
    };
  if (target === 'singbox') {
    const folder = `sing-box-${version}-${windows ? 'windows' : 'linux'}-amd64`;
    return {
      name: folder + (windows ? '.zip' : '.tar.gz'),
      member: folder + '/sing-box' + (windows ? '.exe' : ''),
    };
  }
  return {
    name: `Xray-${windows ? 'windows' : 'linux'}-64.zip`,
    member: windows ? 'xray.exe' : 'xray',
  };
}

export async function downloadOfficial(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  for (let redirect = 0; redirect <= 4; redirect++) {
    const location = new URL(url);
    if (
      location.protocol !== 'https:' ||
      location.username ||
      location.password ||
      location.port ||
      ![
        'api.github.com',
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
        'codeload.github.com',
      ].includes(location.hostname)
    )
      throw new AppError('KERNEL_DOWNLOAD_REJECTED', '内核下载地址不是官方发布地址。');
    const response = await fetch(location, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'SubMeld-Kernels/1.0' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      if (!next) break;
      url = new URL(next, location).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AppError(
        'KERNEL_DOWNLOAD_FAILED',
        '官方内核下载失败（HTTP ' + response.status + '）。',
      );
    }
    const reader = response.body.getReader(),
      chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, bytes);
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new AppError('KERNEL_DOWNLOAD_LIMIT', '内核下载超过大小限制。');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
  }
  throw new AppError('KERNEL_DOWNLOAD_FAILED', '官方内核下载重定向无效。');
}

export function kernelSmokeConfig(target: RenderTarget) {
  const node =
    target === 'mihomo'
      ? {
          name: 'test',
          type: 'ss',
          server: '127.0.0.1',
          port: 9,
          cipher: 'aes-128-gcm',
          password: 'submeld-self-check',
        }
      : target === 'singbox'
        ? {
            tag: 'test',
            type: 'shadowsocks',
            server: '127.0.0.1',
            server_port: 9,
            method: 'aes-128-gcm',
            password: 'submeld-self-check',
          }
        : {
            tag: 'test',
            protocol: 'shadowsocks',
            settings: {
              servers: [
                {
                  address: '127.0.0.1',
                  port: 9,
                  method: 'aes-128-gcm',
                  password: 'submeld-self-check',
                },
              ],
            },
          };
  const config = basicConfig(target, [node], ['test'], 1080);
  if (target === 'xray')
    return JSON.stringify({
      ...config,
      inbounds: [
        { tag: 'local-in', listen: '127.0.0.1', port: 1080, protocol: 'http', settings: {} },
      ],
    });
  return target === 'mihomo' ? stringify(config) : JSON.stringify(config);
}

export class KernelManager {
  readonly root: string;
  private installed = new Map<RenderTarget, Installed>();
  private states = new Map<RenderTarget, KernelStatus>(
    coreTargets.map((target) => [
      target,
      {
        target,
        currentVersion: null,
        latestVersion: null,
        checkedAt: null,
        state: 'idle',
        error: null,
      },
    ]),
  );
  private leases = new Map<string, number>();
  private operation: Promise<void> | undefined;
  private cleanup = Promise.resolve();
  private abort = new AbortController();
  private transfer: typeof downloadOfficial;
  private command: typeof runProcess;
  private bundle: string | null;
  constructor(
    dataDir: string,
    options: {
      transfer?: typeof downloadOfficial;
      command?: typeof runProcess;
      bundledDir?: string | null;
    } = {},
  ) {
    this.root = resolve(dataDir, 'kernels');
    this.transfer = options.transfer ?? downloadOfficial;
    this.command = options.command ?? runProcess;
    this.bundle =
      options.bundledDir === undefined
        ? fileURLToPath(
            new URL(
              import.meta.url.endsWith('.ts') ? '../dist/kernels/' : '../kernels/',
              import.meta.url,
            ),
          )
        : options.bundledDir;
  }
  private patch(target: RenderTarget, change: Partial<KernelStatus>) {
    const state = this.states.get(target);
    if (state) Object.assign(state, change);
  }
  status() {
    return { kernels: coreTargets.map((target) => ({ ...this.states.get(target) })) };
  }
  versions() {
    return new Map(
      coreTargets.map((target) => [target, this.installed.get(target)?.version ?? null]),
    );
  }
  private path(target: RenderTarget, installed: Installed) {
    return join(this.root, target, installed.directory, executable());
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const target of coreTargets) {
      try {
        const manifest = join(this.root, target, 'current.json');
        let raw: string;
        try {
          raw = await readFile(manifest, 'utf8');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          if (!this.bundle || resolve(this.bundle) === this.root) continue;
          const bundled = installedSchema.parse(
            JSON.parse(await readFile(join(this.bundle, target, 'current.json'), 'utf8')),
          );
          await mkdir(join(this.root, target), { recursive: true, mode: 0o700 });
          await cp(
            join(this.bundle, target, bundled.directory),
            join(this.root, target, bundled.directory),
            { recursive: true },
          );
          raw = JSON.stringify(bundled);
          await writeFile(manifest, raw, { mode: 0o600 });
        }
        const value = installedSchema.parse(JSON.parse(raw)),
          path = this.path(target, value);
        if (!(await lstat(path)).isFile() || sha256(await readFile(path)) !== value.sha256)
          throw new Error('Invalid binary');
        if (process.platform !== 'win32') await chmod(path, 0o700);
        this.installed.set(target, value);
        this.patch(target, { currentVersion: value.version, error: null });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          this.patch(target, { error: '已安装内核校验失败，请重新安装。' });
      }
    }
  }
  snapshot() {
    const binaries = new Map<RenderTarget, KernelBinary>();
    for (const [target, installed] of this.installed) {
      const path = this.path(target, installed);
      binaries.set(target, { target, version: installed.version, path });
      this.leases.set(path, (this.leases.get(path) ?? 0) + 1);
    }
    let released = false;
    return {
      binaries,
      release: async () => {
        if (released) return;
        released = true;
        for (const { path } of binaries.values()) {
          const count = (this.leases.get(path) ?? 1) - 1;
          if (count) this.leases.set(path, count);
          else this.leases.delete(path);
        }
        // Cleanup is retried on the next update if a file is still locked by the OS.
        if (!this.operation) {
          this.cleanup = this.cleanup.then(() => this.prune()).catch(() => {});
          await this.cleanup;
        }
      },
    };
  }
  private async latest(target: RenderTarget, signal: AbortSignal): Promise<Asset> {
    const repo = repositories[target];
    const release = releaseSchema.parse(
      JSON.parse(
        (
          await this.transfer(
            `https://api.github.com/repos/${repo}/releases/latest`,
            2 * 1024 * 1024,
            signal,
          )
        ).toString('utf8'),
      ),
    );
    const version = versionSchema.parse(release.tag_name.slice(1)),
      names = assetNames(target, version);
    const asset = release.assets.find((item) => item.name === names.name);
    if (!asset) throw new AppError('KERNEL_ASSET_MISSING', '官方正式版未提供当前平台内核。');
    let digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    const base = `https://github.com/${repo}/releases/download/${release.tag_name}/`;
    if (!digest) {
      const checksum = release.assets.find(
        (item) =>
          item.name === names.name + '.dgst' ||
          item.name === 'checksums.txt' ||
          item.name === `sing-box-${version}-checksums.txt`,
      );
      if (checksum) {
        const lines = (
          await this.transfer(base + encodeURIComponent(checksum.name), 1024 * 1024, signal)
        )
          .toString('utf8')
          .split(/\r?\n/);
        for (const line of lines) {
          if (line.includes(names.name) || checksum.name === names.name + '.dgst') {
            const match = line.match(/(?:^|[^a-fA-F0-9])([a-fA-F0-9]{64})(?:$|[^a-fA-F0-9])/);
            if (match) {
              digest = match[1].toLowerCase();
              break;
            }
          }
        }
      }
    }
    if (!digest)
      throw new AppError('KERNEL_DIGEST_MISSING', '官方发布缺少可验证的 SHA-256，尚未安装。');
    this.patch(target, { latestVersion: version, checkedAt: new Date().toISOString() });
    return {
      target,
      version,
      ...names,
      sha256: digest,
      url: base + encodeURIComponent(names.name),
    };
  }
  private available() {
    if (this.operation || this.abort.signal.aborted)
      throw new AppError('KERNEL_BUSY', '内核操作正在进行，请稍后重试。', 503);
  }
  async check() {
    this.available();
    this.operation = (async () => {
      for (const target of coreTargets) {
        this.patch(target, { state: 'checking', error: null });
        try {
          await this.latest(
            target,
            AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]),
          );
        } catch (error) {
          this.patch(target, { error: this.message(error) });
        } finally {
          this.patch(target, { state: 'idle' });
        }
      }
    })();
    try {
      await this.operation;
    } finally {
      this.operation = undefined;
    }
    return this.status();
  }
  update(target: RenderTarget) {
    this.available();
    this.patch(target, { state: 'updating', error: null });
    this.operation = (async () => {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(180000)]);
      try {
        await this.install(await this.latest(target, signal), signal);
      } catch (error) {
        this.patch(target, { error: this.message(error) });
      } finally {
        this.patch(target, { state: 'idle' });
      }
    })().finally(() => {
      this.operation = undefined;
    });
    return this.status();
  }
  private message(error: unknown) {
    return error instanceof AppError ? error.message : '内核操作失败或超时，当前可用版本保持不变。';
  }
  async prepareBaseline(input: unknown, cacheRoot: string) {
    const locks = kernelLocksSchema.parse(input);
    for (const target of coreTargets) {
      const lock = locks[target];
      if (lock.repo !== repositories[target] || lock.tag !== 'v' + lock.version)
        throw new Error('Invalid core lock');
      const platform = process.platform + '-' + process.arch,
        asset = lock.platforms[platform];
      const names = assetNames(target, lock.version);
      if (!asset || asset.asset !== names.name || asset.binary !== names.member)
        throw new Error('Unsupported core lock');
      const data = await readFile(
        join(cacheRoot, target + '-' + lock.version, platform, asset.asset),
      ).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(180000)]);
      await this.install(
        {
          target,
          version: lock.version,
          ...names,
          sha256: asset.sha256,
          url: `https://github.com/${lock.repo}/releases/download/${lock.tag}/${asset.asset}`,
        },
        signal,
        data,
      );
    }
  }
  private async install(asset: Asset, signal: AbortSignal, cached?: Buffer) {
    // A finished batch may be pruning old files when a new update is requested.
    await this.cleanup;
    signal.throwIfAborted();
    const root = join(this.root, asset.target);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = asset.version + '-' + asset.sha256.slice(0, 12);
    const destination = join(root, directory);
    if (this.installed.get(asset.target)?.directory === directory) return;
    const staging = await mkdtemp(join(root, 'stage-'));
    try {
      const data = cached ?? (await this.transfer(asset.url, 128 * 1024 * 1024, signal));
      if (sha256(data) !== asset.sha256)
        throw new AppError(
          'KERNEL_DIGEST_MISMATCH',
          '内核压缩包 SHA-256 校验失败，当前版本未更改。',
        );
      signal.throwIfAborted();
      const archive = join(staging, asset.name),
        unpack = join(staging, 'unpack');
      await mkdir(unpack, { mode: 0o700 });
      let binaryData: Buffer;
      if (asset.name.endsWith('.gz') && !asset.name.endsWith('.tar.gz')) {
        binaryData = gunzipSync(data, { maxOutputLength: 256 * 1024 * 1024 });
      } else {
        await writeFile(archive, data, { mode: 0o600 });
        const args =
          asset.name.endsWith('.zip') && process.platform !== 'win32'
            ? ['-q', archive, asset.member, '-d', unpack]
            : ['-xf', archive, '-C', unpack, asset.member];
        await this.command(
          asset.name.endsWith('.zip') && process.platform !== 'win32' ? 'unzip' : 'tar',
          args,
          AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        );
        const extracted = join(unpack, asset.member),
          info = await lstat(extracted);
        if (!info.isFile() || info.size > 256 * 1024 * 1024)
          throw new Error('Invalid extracted core');
        binaryData = await readFile(extracted);
      }
      const binary = join(staging, executable());
      await writeFile(binary, binaryData, { mode: 0o700 });
      const commandSignal = () => AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const version = await this.command(
        binary,
        asset.target === 'mihomo' ? ['-v'] : ['version'],
        commandSignal(),
        staging,
      );
      if (
        !version
          .split(/[^\da-zA-Z.-]+/)
          .some((part) => part === asset.version || part === 'v' + asset.version)
      )
        throw new AppError('KERNEL_VERSION_MISMATCH', '下载内核的实际版本与发布信息不一致。');
      const config = join(staging, asset.target === 'mihomo' ? 'check.yaml' : 'check.json');
      await writeFile(config, kernelSmokeConfig(asset.target), { mode: 0o600 });
      await this.command(
        binary,
        asset.target === 'mihomo'
          ? ['-t', '-d', staging, '-f', config]
          : asset.target === 'singbox'
            ? ['check', '-c', config]
            : ['run', '-test', '-c', config],
        commandSignal(),
        staging,
      );
      signal.throwIfAborted();
      await mkdir(destination, { recursive: true, mode: 0o700 });
      const finalBinary = join(destination, executable());
      // A directory used by a running batch is never overwritten.
      if (this.leases.has(finalBinary))
        throw new AppError('KERNEL_BUSY', '此内核版本仍在测试中，请完成测试后重试。', 503);
      await rename(binary, finalBinary);
      const manifest: Installed = { version: asset.version, directory, sha256: sha256(binaryData) };
      const temporary = join(root, 'manifest-' + randomUUID() + '.json');
      await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
      await rename(temporary, join(root, 'current.json'));
      this.installed.set(asset.target, manifest);
      this.patch(asset.target, { currentVersion: asset.version, error: null });
      await this.prune().catch(() => {});
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  private async prune() {
    for (const target of coreTargets) {
      const root = join(this.root, target);
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (
          !entry.isDirectory() ||
          !/^\d[\da-zA-Z.-]{0,80}$/.test(entry.name) ||
          this.installed.get(target)?.directory === entry.name
        )
          continue;
        if (!this.leases.has(join(root, entry.name, executable())))
          await rm(join(root, entry.name), { recursive: true, force: true });
      }
    }
  }
  async close() {
    this.abort.abort();
    await this.operation;
    await this.cleanup;
  }
}
