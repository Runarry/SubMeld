import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from './errors.js';
import { marker, type UpstreamResources } from './upstream-resources.js';
import { record } from './converter/model.js';

const assetRoot = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? '../dist/agent/' : '../agent/', import.meta.url),
);
export function registerAgentAssets(app: Hono) {
  app.get('/agent/:file', (c) => {
    const name = c.req.param('file');
    if (
      !/^(?:install\.sh|source\.tar\.gz|submeld-agent-linux-(?:amd64|arm64)(?:\.sha256)?)$/.test(
        name,
      )
    )
      throw new AppError('NOT_FOUND', 'Agent 文件不存在。', 404);
    let content: Buffer;
    try {
      content = readFileSync(assetRoot + name);
    } catch {
      throw new AppError('AGENT_NOT_BUILT', '请先完成 Agent 构建。', 503);
    }
    c.header(
      'Content-Type',
      name.endsWith('.sh') || name.endsWith('.sha256')
        ? 'text/plain; charset=utf-8'
        : 'application/octet-stream',
    );
    c.header('Cache-Control', 'no-store');
    return c.body(new Uint8Array(content));
  });
}
export async function tunnelCertificate(serverName: string) {
  const os = process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const binary = assetRoot + `submeld-agent-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
  try {
    const { stdout } = await promisify(execFile)(
      binary,
      ['certificate', '--server-name', serverName],
      {
        timeout: 15000,
        maxBuffer: 65536,
        windowsHide: true,
      },
    );
    return z
      .object({ certificatePEM: z.string().min(100), privateKeyPEM: z.string().min(100) })
      .parse(JSON.parse(stdout));
  } catch {
    throw new AppError('CERTIFICATE_FAILED', '无法生成隧道证书，请检查 Agent 构建。', 503);
  }
}
const privateRoles = new Set(['machine-snapshot', 'machine-command', 'relay-route']);
export async function assertPrivateFileNotShared(
  resources: UpstreamResources,
  path: string,
  body?: unknown,
) {
  // Managed deployment files contain server credentials and must never become client artifacts.
  if (!path.startsWith('/share/file/') && !/^\/api\/(?:token|tokens|file\/)/.test(path)) return;
  const names = new Set<string>();
  if (path.startsWith('/share/file/'))
    names.add(decodeURIComponent(path.slice('/share/file/'.length).split('/')[0] ?? ''));
  if (record(body) && body.type === 'file' && typeof body.name === 'string') names.add(body.name);
  if (
    record(body) &&
    record(body.payload) &&
    body.payload.type === 'file' &&
    typeof body.payload.name === 'string'
  )
    names.add(body.payload.name);
  if (!names.size) return;
  await resources.sync();
  if (
    resources
      .files()
      .some(
        ({ record: file }) => names.has(file.name) && privateRoles.has(marker(file)?.role ?? ''),
      )
  )
    throw new AppError(
      'PRIVATE_DEPLOYMENT_FILE',
      '服务器部署文件包含私有配置，不能创建分享。',
      403,
    );
}
