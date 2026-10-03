import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('tools/hy2-cert-probe');
mkdirSync('dist/hy2-cert-probe', { recursive: true });
for (const platform of ['windows', 'linux']) {
  const output = resolve(
    'dist/hy2-cert-probe/' + platform + '-amd64' + (platform === 'windows' ? '.exe' : ''),
  );
  const result = spawnSync(
    'go',
    ['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', output, '.'],
    {
      cwd: root,
      env: { ...process.env, GOOS: platform, GOARCH: 'amd64', CGO_ENABLED: '0' },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) throw new Error('HY2 certificate probe build failed');
}
const source = resolve('dist/hy2-cert-probe/source');
mkdirSync(source, { recursive: true });
const vendor = spawnSync('go', ['mod', 'vendor', '-o', source + '/vendor'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (vendor.error || vendor.status !== 0)
  throw new Error('HY2 probe dependency source packaging failed');
for (const file of ['main.go', 'go.mod', 'go.sum'])
  copyFileSync(root + '/' + file, source + '/' + file);
copyFileSync('LICENSE', source + '/LICENSE');
const archive = spawnSync(
  'tar',
  ['-czf', resolve('dist/hy2-cert-probe/source.tar.gz'), '-C', source, '.'],
  { stdio: 'inherit', windowsHide: true },
);
if (archive.error || archive.status !== 0) throw new Error('HY2 probe source packaging failed');
