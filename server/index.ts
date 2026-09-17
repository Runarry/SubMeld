import { fileURLToPath } from 'node:url';
import { relative, isAbsolute } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openSettings } from './database.js';
import { Auth } from './auth.js';
import { Converter } from './converter/pool.js';
import { Publisher } from './publisher.js';
import { SourceRefresher } from './source-refresher.js';

async function main() {
  const config = loadConfig(process.argv.includes('--dev'));
  const webRoot = import.meta.url.endsWith('.ts')
    ? undefined
    : fileURLToPath(new URL('../web/', import.meta.url));
  if (webRoot) {
    const rel = relative(webRoot, config.dataDir);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
      throw new Error('数据目录不能位于网页目录内。');
  }
  const settings = openSettings(config.dataDir, config.development);
  const passwordHash = settings.getPasswordHash();
  if (!passwordHash) {
    settings.close();
    throw new Error('请先通过本地 admin:init 命令初始化管理员。');
  }
  const auth = new Auth(passwordHash);
  const converter = new Converter();
  try {
    await converter.ready;
  } catch (error) {
    await converter.close();
    settings.close();
    throw error;
  }
  const publisher = new Publisher(
    settings.subscriptions,
    settings.nodes,
    settings.sources,
    converter,
  );
  const refresher = new SourceRefresher(settings.sources, converter);
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp({
      webRoot,
      config,
      auth,
      converter,
      nodes: settings.nodes,
      sources: settings.sources,
      subscriptions: settings.subscriptions,
      publisher,
    });
    publisher.start();
    refresher.start();
  } catch (error) {
    await refresher.close();
    await publisher.close();
    await converter.close();
    auth.close();
    settings.close();
    throw error;
  }
  const hostname = config.development ? '127.0.0.1' : '0.0.0.0';
  const server = serve({ fetch: app.fetch, hostname, port: 3000 }, () =>
    console.info('SubMeld started on port 3000.'),
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await refresher.close();
    await publisher.close();
    await converter.close();
    auth.close();
    settings.close();
  };
  server.once('error', () => {
    console.error('HTTP server could not start.');
    process.exitCode = 1;
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}
main().catch((error) => {
  console.error(
    error instanceof Error && error.message.startsWith('请')
      ? error.message
      : 'SubMeld 启动失败，请检查配置、数据目录和构建产物。',
  );
  process.exitCode = 1;
});
