import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const lock = JSON.parse(await readFile('miaospeed-scripts.lock.json', 'utf8'));
const cache = resolve('.cache/miaospeed-scripts', lock.version);
const output = resolve('dist/diagnostics');
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const digest = (data) => createHash('sha256').update(data).digest('hex');
async function asset(name, url, sha) {
  const path = join(cache, name);
  let data;
  try {
    data = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!data || (sha && digest(data) !== sha)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Could not fetch pinned script asset: ' + name);
    data = Buffer.from(await response.arrayBuffer());
    if (sha && digest(data) !== sha) throw new Error('Pinned script checksum mismatch: ' + name);
    await writeFile(path, data);
  }
  return data;
}
const base = 'https://github.com/' + lock.repo + '/releases/download/' + lock.version + '/';
await asset('scripts.zip', base + 'scripts.zip', lock.archiveSha256);
const index = JSON.parse(await asset('index.json', base + 'index.json', lock.indexSha256));
const unpack = join(cache, 'unpack');
await mkdir(unpack, { recursive: true });
execFileSync(
  process.platform === 'win32' ? 'tar' : 'unzip',
  process.platform === 'win32'
    ? ['-xf', join(cache, 'scripts.zip'), '-C', unpack]
    : ['-qo', join(cache, 'scripts.zip'), '-d', unpack],
  { windowsHide: true },
);
const scripts = [];
for (const id of lock.scripts) {
  const entry = index.find((value) => value.id === id);
  if (!entry || !/^[\w+./-]+\.js$/.test(entry.path) || entry.path.includes('..'))
    throw new Error('Invalid pinned script index: ' + id);
  const content = await readFile(join(unpack, entry.path), 'utf8');
  scripts.push({
    builtinId: id,
    name: entry.name,
    description: entry.description,
    enabled: true,
    timeoutMs: 20000,
    content,
    source: 'https://github.com/' + lock.repo + '/tree/' + lock.version,
  });
}
await writeFile(join(output, 'scripts.json'), JSON.stringify(scripts));
const source = await asset(
  'source.tar.gz',
  'https://codeload.github.com/' + lock.repo + '/tar.gz/refs/tags/' + lock.version,
);
await copyFile(join(cache, 'source.tar.gz'), join(output, 'source.tar.gz'));
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      ...lock,
      sourceSha256: digest(source),
      license: 'AGPL-3.0; original license and copyrights are in source.tar.gz',
    },
    null,
    2,
  ),
);
console.info(
  'Bundled ' + scripts.length + ' pinned miaospeed diagnostic scripts and corresponding source',
);
