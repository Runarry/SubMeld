import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { KernelManager, downloadOfficial, kernelLocksSchema } from '../dist/server/kernels.js';

const manager = new KernelManager(resolve('dist'), { bundledDir: null });
const locks = kernelLocksSchema.parse(
  JSON.parse(await readFile('tests/kernels.lock.json', 'utf8')),
);
try {
  await manager.initialize();
  await manager.prepareBaseline(locks, resolve('.cache/kernels'));
  const directory = resolve('dist/kernel-sources');
  await mkdir(directory, { recursive: true });
  let previous = {};
  try {
    previous = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const manifest = {};
  for (const target of ['mihomo', 'singbox', 'xray']) {
    const lock = locks[target],
      filename = join(directory, target + '.tar.gz');
    let data;
    try {
      data = await readFile(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const digest = (data) => createHash('sha256').update(data).digest('hex');
    const prior = previous[target];
    if (
      !data ||
      prior?.repo !== lock.repo ||
      prior?.tag !== lock.tag ||
      prior?.sha256 !== digest(data)
    ) {
      data = await downloadOfficial(
        'https://codeload.github.com/' + lock.repo + '/tar.gz/refs/tags/' + lock.tag,
        128 * 1024 * 1024,
        AbortSignal.timeout(180000),
      );
      if (data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('Invalid official source archive');
      await writeFile(filename, data);
    }
    manifest[target] = {
      repo: lock.repo,
      tag: lock.tag,
      sha256: digest(data),
      source: 'https://github.com/' + lock.repo + '/tree/' + lock.tag,
      license:
        'License and copyright files are included in the unmodified official source archive.',
    };
    console.log('Prepared ' + target + ' ' + lock.version + ' and corresponding source');
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const packed = spawnSync(process.execPath, ['scripts/package-source.mjs'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (packed.error || packed.status !== 0)
    throw new Error('Could not package core source materials');
} finally {
  await manager.close();
}
