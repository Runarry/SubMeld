import { mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('dist', { recursive: true });
// Explicit roots exclude credentials, dependencies, caches and runtime data.
const sources = [
  'AGENTS.md',
  'README.md',
  'LICENSE',
  'package.json',
  'pnpm-lock.yaml',
  '.npmrc',
  '.node-version',
  '.gitattributes',
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
  '.env.example',
  '.dockerignore',
  'Dockerfile',
  'compose.yaml',
  'compose.dev.yaml',
  'eslint.config.js',
  'vite.config.ts',
  'playwright.config.ts',
  'tsconfig.json',
  'tsconfig.server.json',
  'tsconfig.web.json',
  'tsconfig.tools.json',
  'server',
  'web',
  'scripts',
  'tests',
  'tools/hy2-cert-probe',
  'upstreams.lock.json',
  'miaospeed-scripts.lock.json',
  'docs',
];
if (existsSync('dist/diagnostics/manifest.json'))
  sources.push('dist/diagnostics/manifest.json', 'dist/diagnostics/source.tar.gz');
if (existsSync('dist/hy2-cert-probe/source.tar.gz'))
  sources.push('dist/hy2-cert-probe/source.tar.gz');
if (existsSync('dist/kernel-sources/manifest.json'))
  sources.push(
    'dist/kernel-sources/manifest.json',
    ...['mihomo', 'singbox', 'xray'].map((target) => 'dist/kernel-sources/' + target + '.tar.gz'),
  );
const result = spawnSync('tar', ['-czf', 'dist/submeld-source.tar.gz', '--', ...sources], {
  stdio: 'inherit',
});
if (result.error || result.status !== 0) throw new Error('Could not package corresponding source');
