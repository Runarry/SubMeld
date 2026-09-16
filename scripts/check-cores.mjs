import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { renderInput } from '../dist/server/converter/render.js';
import { items } from '../tests/fixtures.mjs';
import { renderFixtures } from '../tests/render-fixtures.mjs';
const locks = JSON.parse(
  await readFile(new URL('../tests/kernels.lock.json', import.meta.url), 'utf8'),
);
const platform = process.platform + '-' + process.arch;
const cache = resolve('.cache/kernels');
const results = resolve('.cache/core-results');
await mkdir(results, { recursive: true });
function execute(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      'Kernel check failed: ' + (result.error?.message ?? result.stderr ?? result.stdout),
    );
  return result.stdout + result.stderr;
}
for (const [target, lock] of Object.entries(locks)) {
  const asset = lock.platforms[platform];
  if (!asset)
    throw new Error('No locked test kernel for ' + platform + '; no checks were skipped.');
  const dir = join(cache, target + '-' + lock.version, platform);
  await mkdir(dir, { recursive: true });
  const archive = join(dir, asset.asset);
  let data;
  try {
    data = await readFile(archive);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!data) {
    console.log('Downloading locked ' + target + ' ' + lock.version);
    const response = await fetch(
      'https://github.com/' + lock.repo + '/releases/download/' + lock.tag + '/' + asset.asset,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok) throw new Error('Kernel download failed: HTTP ' + response.status);
    data = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(
    createHash('sha256').update(data).digest('hex'),
    asset.sha256,
    'Official kernel archive digest mismatch',
  );
  await writeFile(archive, data);
  const binary = join(dir, asset.binary);
  // Re-extract from the verified archive, so a modified cached executable cannot pass unnoticed.
  if (asset.asset.endsWith('.gz') && !asset.asset.endsWith('.tar.gz'))
    await writeFile(binary, gunzipSync(data));
  else execute('tar', ['-xf', archive, '-C', dir]);
  await access(binary);
  if (process.platform !== 'win32') await chmod(binary, 0o700);
  const version = execute(binary, target === 'mihomo' ? ['-v'] : ['version']);
  assert.ok(version.includes(lock.version), target + ' version mismatch');
  const generated = renderInput({
    target,
    items: items(...renderFixtures(target)),
    listenPort: 1080,
  });
  const config = join(results, target + (target === 'mihomo' ? '.yaml' : '.json'));
  await writeFile(config, generated.full);
  const args =
    target === 'mihomo'
      ? ['-t', '-d', results, '-f', config]
      : target === 'singbox'
        ? ['check', '-c', config]
        : ['run', '-test', '-c', config];
  execute(binary, args);
  console.log(
    'PASS ' +
      target +
      ' ' +
      lock.version +
      ': ' +
      generated.counts.output +
      ' nodes, complete configuration',
  );
}
