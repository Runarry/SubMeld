import { fileURLToPath } from 'node:url';
import { relative, isAbsolute } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openSettings } from './database.js';
import { Auth } from './auth.js';
import { Converter } from './converter/pool.js';

import { SubStoreClient } from './sub-store.js';
import { KernelManager } from './kernels.js';
import { NodeTester } from './node-tests.js';

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
  const client = new SubStoreClient(config.subStoreUrl);
  const settings = openSettings(config.dataDir, config.development, client, config.koipyConfigPath);
  const passwordHash = settings.getPasswordHash();
  if (!passwordHash) {
    settings.close();
    throw new Error('请先通过本地 admin:init 命令初始化管理员。');
  }
  const auth = new Auth(passwordHash);
  const converter = new Converter(client);
  try {
    await converter.ready;
  } catch (error) {
    await converter.close();
    settings.close();
    throw error;
  }

  const kernels = new KernelManager(config.dataDir);
  const tester = new NodeTester(settings.nodeTests, kernels, converter, config.dataDir);
  let app: ReturnType<typeof createApp>;
  try {
    await kernels.initialize();
    app = createApp({
      koipy: settings.koipy,
      webRoot,
      resources: settings.resources,
      tester,
      config,
      auth,

      nodes: settings.nodes,
      chains: settings.chains,

      subscriptions: settings.subscriptions,
    });
  } catch (error) {
    await tester.close();
    await kernels.close();

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
    await tester.close();
    await kernels.close();

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
