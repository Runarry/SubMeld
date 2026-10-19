import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

mkdirSync('dist/agent', { recursive: true });
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
for (const [os, arch] of [
  ['linux', 'amd64'],
  ['linux', 'arm64'],
  ['windows', 'amd64'],
]) {
  const name = `submeld-agent-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
  const output = resolve('dist/agent', name);
  const result = spawnSync(
    'go',
    [
      'build',
      '-mod=readonly',
      '-trimpath',
      '-ldflags=-s -w -X main.version=' + version,
      '-o',
      output,
      '.',
    ],
    {
      cwd: resolve('agent'),
      env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) throw new Error('Agent build failed: ' + name);
  writeFileSync(
    output + '.sha256',
    createHash('sha256').update(readFileSync(output)).digest('hex') + '  ' + name + '\n',
  );
}
copyFileSync('agent/install.sh', 'dist/agent/install.sh');
const sources = readdirSync('agent')
  .filter(
    (name) => /\.(?:go|mod|sum|md)$/.test(name) || ['install.sh', 'gost.lock.json'].includes(name),
  )
  .map((name) => 'agent/' + name);
const archive = spawnSync(
  'tar',
  ['-czf', resolve('dist/agent/source.tar.gz'), '--', ...sources, 'LICENSE'],
  {
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (archive.error || archive.status !== 0) throw new Error('Agent source packaging failed');
