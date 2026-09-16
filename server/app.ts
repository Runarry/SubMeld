import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

export function createApp(webRoot?: string) {
  const app = new Hono();

  app.get('/healthz', (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json({ status: 'ok' });
  });

  if (webRoot) {
    const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
    app.get('/', (context) => context.html(indexHtml));
    app.get('/assets/*', serveStatic({ root: webRoot }));
  }

  app.notFound((context) =>
    context.json({ code: 'NOT_FOUND', message: '请求的资源不存在。' }, 404),
  );

  app.onError((_error, context) =>
    context.json({ code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求。' }, 500),
  );

  return app;
}
