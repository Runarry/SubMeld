import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { downloadOfficial } from '../dist/server/kernels.js';

const lock = JSON.parse(await readFile('reality-scanner.lock.json', 'utf8'));
const cache = resolve('.cache/reality-scanner', lock.tag);
const output = resolve('dist/reality-scanner');
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
async function prepare(name, url, sha256) {
  const cached = join(cache, name);
  let data;
  try {
    data = await readFile(cached);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!data || digest(data) !== sha256) {
    data = await downloadOfficial(url, 32 * 1024 * 1024, AbortSignal.timeout(120000));
    if (digest(data) !== sha256) throw new Error('RealiTLScanner checksum mismatch: ' + name);
    await writeFile(cached, data);
  }
  await copyFile(cached, join(output, name));
}
for (const [platform, asset] of Object.entries(lock.platforms)) {
  await prepare(
    asset.asset,
    `https://github.com/${lock.repo}/releases/download/${lock.tag}/${asset.asset}`,
    asset.sha256,
  );
  if (platform.startsWith('linux') && process.platform !== 'win32')
    await chmod(join(output, asset.asset), 0o755);
}
await prepare(
  'source.tar.gz',
  `https://codeload.github.com/${lock.repo}/tar.gz/refs/tags/${lock.tag}`,
  lock.sourceSha256,
);
const license = execFileSync(
  'tar',
  ['-xOf', join(output, 'source.tar.gz'), 'RealiTLScanner-' + lock.version + '/LICENSE'],
  { windowsHide: true },
);
await writeFile(join(output, 'LICENSE'), license);
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      ...lock,
      license: 'MPL-2.0',
      source: 'https://github.com/' + lock.repo + '/tree/' + lock.tag,
    },
    null,
    2,
  ) + '\n',
);
console.info(
  'Prepared official RealiTLScanner ' +
    lock.version +
    ', verified binaries and corresponding source',
);
