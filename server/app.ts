import { UpstreamResources } from './upstream-resources.js';
import { SubStoreClient } from './sub-store.js';
import { frontendWorkerBoundary } from './frontend-worker.js';
import type { KoipySettingsStore } from './koipy.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Auth } from './auth.js';
import type { NodeStore } from './nodes.js';
import type { ChainStore } from './chains.js';
import type { SourceStore } from './sources.js';
import type { SubscriptionStore } from './subscriptions.js';
import type { Publisher } from './publisher.js';
import type { NodeTester } from './node-tests.js';
import { testSelectionSchema } from './shared/node-tests.js';
import { renderTargetSchema } from './shared/contracts.js';
import { outputFormatSchema } from './shared/subscriptions.js';
import type { Converter } from './converter/pool.js';
import { AppError, publicError } from './errors.js';
import { readJson } from './input.js';
import {
  MAX_BYTES,
  parseRequestSchema,
  produceRequestSchema,
  renderRequestSchema,
  revisionRequestSchema,
} from './shared/contracts.js';

export type AppOptions = {
  koipy: KoipySettingsStore;
  resources: UpstreamResources;
  webRoot?: string;
  tester?: NodeTester;
  nodes: NodeStore;
  chains: ChainStore;
  sources: SourceStore;
  subscriptions: SubscriptionStore;
  publisher: Publisher;
  config: Config;
  auth: Auth;
  converter: Pick<Converter, 'run'>;
};
export function createApp({
  koipy,
  resources,
  webRoot,
  tester,
  config,
  auth,
  converter,
  nodes,
  chains,
  sources,
  subscriptions,
  publisher,
}: AppOptions) {
  const app = new Hono();
  const cookieName = config.development ? 'submeld-session' : '__Host-submeld-session';
  const writes = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/convert/parse',
    '/api/convert/produce',
    '/api/convert/render',
    '/api/nodes',
    '/api/chains',
    '/api/sources',
    '/api/subscriptions',
    '/api/node-tests',
    '/api/kernels',
    '/api/integrations',
  ]);
  app.use('*', async (context, next) => {
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    if (context.req.path.startsWith('/submeld') || context.req.path.startsWith('/api/'))
      context.header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
    await next();
  });
  app.use('/api/*', async (context, next) => {
    context.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.use('/api/*', async (context, next) => {
    const managed =
      writes.has(context.req.path) ||
      [
        '/api/nodes/',
        '/api/chains/',
        '/api/sources/',
        '/api/subscriptions/',
        '/api/node-tests/',
        '/api/kernels/',
        '/api/integrations/',
      ].some((prefix) => context.req.path.startsWith(prefix));
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(context.req.method) && managed) {
      const origin = context.req.header('Origin');
      let validOrigin = false;
      try {
        if (origin && origin !== 'null') {
          const url = new URL(origin);
          validOrigin = url.origin === origin && url.origin === config.publicOrigin;
        }
      } catch {
        /* Rejected below. */
      }
      if (
        !validOrigin ||
        context.req.header('X-SubMeld-Request') !== '1' ||
        !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
          context.req.header('Content-Type') ?? '',
        )
      )
        throw new AppError('ORIGIN_REJECTED', '请求未通过同源 JSON 校验。', 403);
    }
    if (
      (managed && context.req.path !== '/api/auth/login') ||
      context.req.path === '/api/auth/me'
    ) {
      if (!auth.valid(getCookie(context, cookieName)))
        throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
    }
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (
      /^\/api\/(nodes|chains|sources|subscriptions|node-tests)(?:\/|$)/.test(c.req.path) &&
      !/\/(artifacts|cancel)(?:\/|$)/.test(c.req.path)
    )
      await resources.sync();
    await next();
  });
  app.get('/api/integrations', (c) => {
    if (!auth.valid(getCookie(c, cookieName)))
      throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
    const username = koipy.username(config.telegramBot);
    return c.json({
      subStore: '/?api=' + encodeURIComponent(config.publicOrigin + '/upstream/sub-store'),
      telegram: username ? 'https://t.me/' + username : null,
    });
  });
  app.get('/api/integrations/koipy', (c) => c.json(koipy.get(config.telegramBot)));
  app.patch('/api/integrations/koipy', async (c) =>
    c.json(koipy.update(await readJson(c.req.raw, 32 * 1024))),
  );
  const frontend = new SubStoreClient(new URL(resources.client.origin).origin);
  app.get('/sw.js', async (c) => {
    const response = await frontend.request('/sw.js', { signal: c.req.raw.signal });
    if (!response.ok) return response;
    return c.body(frontendWorkerBoundary + (await response.text()), 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  });
  // The native frontend may keep the proxy prefix when its backend secret path differs.
  app.on(['GET', 'HEAD'], ['/share/*', '/upstream/sub-store/share/*'], async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.replace(/^\/upstream\/sub-store(?=\/share\/)/, '');
    const response = await frontend.request(path + url.search, {
      method: c.req.method,
      headers: { 'user-agent': c.req.header('User-Agent') ?? 'SubMeld' },
      signal: c.req.raw.signal,
    });
    response.headers.delete('set-cookie');
    response.headers.delete('access-control-allow-origin');
    response.headers.delete('access-control-allow-credentials');
    response.headers.set('cache-control', 'private, no-store');
    return response;
  });
  app.all('/upstream/sub-store/*', async (c) => {
    if (!auth.valid(getCookie(c, cookieName)))
      throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
    const write = !['GET', 'HEAD'].includes(c.req.method);
    if (write && c.req.header('Origin') !== config.publicOrigin)
      throw new AppError('ORIGIN_REJECTED', '请从本站管理界面操作。', 403);
    const url = new URL(c.req.url);
    const path = url.pathname.slice('/upstream/sub-store'.length);
    const body = write ? await readJson(c.req.raw, 26 * 1024 * 1024, true) : undefined;
    const forward = () =>
      resources.client.request(path + url.search, {
        method: c.req.method,
        signal: c.req.raw.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': c.req.header('User-Agent') ?? 'SubMeld',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const pure = /^\/api\/(proxy|rule|preview)(?:\/|$)/.test(path);
    const response =
      write && !pure
        ? await resources.write(forward, [], () =>
            resources.guardMutation(path, c.req.method, body),
          )
        : await forward();
    response.headers.delete('set-cookie');
    response.headers.delete('access-control-allow-origin');
    response.headers.delete('access-control-allow-credentials');
    response.headers.set('cache-control', 'private, no-store');
    return response;
  });
  app.get('/healthz', (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json({ status: 'ok' });
  });
  app.post('/api/auth/login', async (context) => {
    const input = z
      .strictObject({ password: z.string().min(1).max(1024) })
      .safeParse(await readJson(context.req.raw, 8192));
    if (!input.success || Buffer.byteLength(input.data.password) > 1024)
      throw new AppError('INVALID_REQUEST', '登录请求格式无效。', 400);
    const token = await auth.login(input.data.password);
    auth.logout(getCookie(context, cookieName));
    setCookie(context, cookieName, token, {
      httpOnly: true,
      secure: !config.development || config.publicOrigin.startsWith('https:'),
      sameSite: 'Strict',
      path: '/',
      maxAge: 86400,
    });
    return context.json({ authenticated: true });
  });
  app.get('/api/auth/me', (context) => context.json({ authenticated: true }));
  app.post('/api/auth/logout', async (context) => {
    const value = z.strictObject({}).safeParse(await readJson(context.req.raw, 1024));
    if (!value.success) throw new AppError('INVALID_REQUEST', '退出请求应为 JSON 空对象。', 400);
    auth.logout(getCookie(context, cookieName));
    deleteCookie(context, cookieName, {
      path: '/',
      secure: !config.development || config.publicOrigin.startsWith('https:'),
      httpOnly: true,
      sameSite: 'Strict',
    });
    return context.json({ authenticated: false });
  });
  app.post('/api/convert/parse', async (context) => {
    const input = parseRequestSchema.safeParse(await readJson(context.req.raw, 26 * 1024 * 1024));
    if (!input.success) throw new AppError('INVALID_REQUEST', '解析请求格式无效。', 400);
    if (Buffer.byteLength(input.data.text) > MAX_BYTES)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '输入超过 4 MiB。', 413);
    return context.json(
      await converter.run({ kind: 'parse', input: input.data }, context.req.raw.signal),
    );
  });
  app.post('/api/convert/produce', async (context) => {
    const raw = await readJson(context.req.raw, 26 * 1024 * 1024);
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数据超过 4 MiB。', 413);
    const input = produceRequestSchema.safeParse(raw);
    if (!input.success) throw new AppError('INVALID_REQUEST', '节点数据结构无效。', 400);
    return context.json(
      await converter.run({ kind: 'produce', input: input.data }, context.req.raw.signal),
    );
  });
  app.get('/api/nodes', (context) => {
    const page = z.coerce
      .number()
      .int()
      .min(0)
      .max(1000000)
      .safeParse(context.req.query('page') ?? 0);
    if (!page.success) throw new AppError('INVALID_REQUEST', '页码无效。', 400);
    return context.json(nodes.list(page.data));
  });
  app.post('/api/nodes', async (context) =>
    context.json(await nodes.create(await readJson(context.req.raw, 26 * 1024 * 1024)), 201),
  );
  app.post('/api/nodes/load', async (context) =>
    context.json(nodes.load(await readJson(context.req.raw, 128 * 1024))),
  );
  app.get('/api/nodes/:id', (context) => context.json(nodes.get(context.req.param('id'))));
  app.patch('/api/nodes/:id', async (context) =>
    context.json(
      await nodes.update(
        context.req.param('id'),
        await readJson(context.req.raw, 26 * 1024 * 1024),
      ),
    ),
  );
  app.delete('/api/nodes/:id', async (context) => {
    const input = revisionRequestSchema.safeParse(await readJson(context.req.raw, 1024));
    if (!input.success) throw new AppError('INVALID_REQUEST', '删除请求缺少有效版本。', 400);
    await nodes.delete(context.req.param('id'), input.data.revision);
    return context.json({ deleted: true });
  });
  app.post('/api/convert/render', async (context) => {
    const raw = await readJson(context.req.raw, 26 * 1024 * 1024);
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES)
      throw new AppError('INPUT_LIMIT_EXCEEDED', '节点数据超过 4 MiB。', 413);
    const input = renderRequestSchema.safeParse(raw);
    if (!input.success) throw new AppError('INVALID_REQUEST', '目标生成请求无效。', 400);
    return context.json(
      await converter.run({ kind: 'render', input: input.data }, context.req.raw.signal),
    );
  });
  function listPage(value: string | undefined) {
    const page = z.coerce
      .number()
      .int()
      .min(0)
      .max(1000000)
      .safeParse(value ?? 0);
    if (!page.success) throw new AppError('INVALID_REQUEST', '页码无效。', 400);
    return page.data;
  }
  async function requestRevision(request: Request) {
    const input = revisionRequestSchema.safeParse(await readJson(request, 1024));
    if (!input.success) throw new AppError('INVALID_REQUEST', '请求缺少有效版本。', 400);
    return input.data.revision;
  }
  const detail = (id: string) =>
    subscriptions.detail(id, publisher.engineVersion, publisher.status(id));
  function issued(id: string, token: string, key: string) {
    const subscription = detail(id);
    return {
      subscription,
      urls: Object.fromEntries(
        subscription.formats.map((format) => [
          format,
          config.publicOrigin + '/s/' + token + '/' + format + '?key=' + key,
        ]),
      ),
    };
  }
  function testing() {
    if (!tester) throw new AppError('TEST_UNAVAILABLE', '节点测试服务尚未就绪。', 503);
    return tester;
  }
  async function empty(request: Request) {
    if (!z.strictObject({}).safeParse(await readJson(request, 1024)).success)
      throw new AppError('INVALID_REQUEST', '此操作不接受额外参数。', 400);
  }
  app.get('/api/node-tests/settings', (c) => c.json(testing().store.settings()));
  app.patch('/api/node-tests/settings', async (c) =>
    c.json(testing().store.updateSettings(await readJson(c.req.raw, 8192))),
  );
  app.post('/api/node-tests', async (c) => {
    const selection = testSelectionSchema.safeParse(await readJson(c.req.raw, MAX_BYTES));
    if (!selection.success)
      throw new AppError('INVALID_REQUEST', '请选择有效且不重复的已保存测试对象。', 400);
    await testing().store.refresh(selection.data.subjects);
    return c.json(testing().start(selection.data), 202);
  });
  app.get('/api/node-tests/current', (c) =>
    c.json(testing().current(listPage(c.req.query('page')))),
  );
  app.post('/api/node-tests/results/query', async (c) => {
    const selection = testSelectionSchema.safeParse(await readJson(c.req.raw, MAX_BYTES));
    if (!selection.success) throw new AppError('INVALID_REQUEST', '测试结果查询对象无效。', 400);
    const runner = testing();
    return c.json(runner.store.results(selection.data.subjects, runner.kernels.versions()));
  });
  app.get('/api/node-tests/:id', (c) =>
    c.json(testing().get(c.req.param('id'), listPage(c.req.query('page')))),
  );
  app.post('/api/node-tests/:id/cancel', async (c) => {
    await empty(c.req.raw);
    return c.json(testing().cancel(c.req.param('id')));
  });
  app.get('/api/kernels', (c) => c.json(testing().kernels.status()));
  app.post('/api/kernels/check', async (c) => {
    await empty(c.req.raw);
    return c.json(await testing().kernels.check());
  });
  app.post('/api/kernels/:target/update', async (c) => {
    await empty(c.req.raw);
    const target = renderTargetSchema.safeParse(c.req.param('target'));
    if (!target.success) throw new AppError('INVALID_REQUEST', '内核目标无效。', 400);
    return c.json(testing().kernels.update(target.data), 202);
  });
  app.get('/api/chains', (c) => c.json(chains.list(listPage(c.req.query('page')))));
  app.post('/api/chains', async (c) =>
    c.json(chains.create(await readJson(c.req.raw, 16 * 1024)), 201),
  );
  app.get('/api/chains/:id', (c) => c.json(chains.get(c.req.param('id'))));
  app.patch('/api/chains/:id', async (c) =>
    c.json(chains.update(c.req.param('id'), await readJson(c.req.raw, 16 * 1024))),
  );
  app.delete('/api/chains/:id', async (c) => {
    chains.delete(c.req.param('id'), await requestRevision(c.req.raw));
    return c.json({ deleted: true });
  });
  app.get('/api/sources', (c) => c.json(sources.list(listPage(c.req.query('page')))));
  app.get('/api/sources/:id', async (c) => {
    await sources.prepare([c.req.param('id')]);
    return c.json(sources.get(c.req.param('id')));
  });
  app.post('/api/sources/:id/refresh', async (c) =>
    c.json(await sources.requestRefresh(c.req.param('id'), await requestRevision(c.req.raw))),
  );
  app.get('/api/subscriptions', (c) => c.json(subscriptions.list(listPage(c.req.query('page')))));
  app.post('/api/subscriptions', async (c) => {
    const { id, token, key } = subscriptions.create(await readJson(c.req.raw, 26 * 1024 * 1024));
    return c.json(issued(id, token, key), 201);
  });
  app.get('/api/subscriptions/:id', (c) => c.json(detail(c.req.param('id'))));
  app.patch('/api/subscriptions/:id', async (c) => {
    subscriptions.update(c.req.param('id'), await readJson(c.req.raw, 26 * 1024 * 1024));
    return c.json(detail(c.req.param('id')));
  });
  app.delete('/api/subscriptions/:id', async (c) => {
    subscriptions.delete(c.req.param('id'), await requestRevision(c.req.raw));
    return c.json({ deleted: true });
  });
  app.post('/api/subscriptions/:id/generate', async (c) => {
    const sub = subscriptions.current(c.req.param('id'), await requestRevision(c.req.raw));
    if (!sub.enabled) throw new AppError('SUBSCRIPTION_DISABLED', '请先启用方案。', 422);
    publisher.schedule([sub.id]);
    return c.json(detail(sub.id), 202);
  });
  app.post('/api/subscriptions/:id/reset-token', async (c) => {
    const { id, token, key } = subscriptions.resetToken(
      c.req.param('id'),
      await requestRevision(c.req.raw),
    );
    return c.json(issued(id, token, key));
  });
  app.get('/api/subscriptions/:id/artifacts/:format', (c) => {
    const format = outputFormatSchema.safeParse(c.req.param('format'));
    if (!format.success) throw new AppError('NOT_FOUND', '请求的资源不存在。', 404);
    return c.json(subscriptions.artifact(c.req.param('id'), format.data, publisher.engineVersion));
  });
  app.use('/s/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.use('/s', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.on(['GET', 'HEAD'], '/s/:token/:format', (c) => {
    const artifact = subscriptions.read(
      c.req.param('token'),
      c.req.param('format'),
      publisher.engineVersion,
      c.req.query('key'),
    );
    const type = artifact.format.startsWith('mihomo')
      ? 'application/yaml'
      : ['uri', 'base64'].includes(artifact.format)
        ? 'text/plain'
        : 'application/json';
    c.header('Content-Type', type + '; charset=utf-8');
    c.header('Content-Length', String(Buffer.byteLength(artifact.content)));
    return c.req.method === 'HEAD' ? c.body(null, 200) : c.body(artifact.content, 200);
  });
  if (webRoot) {
    const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
    app.get('/submeld/', (context) => {
      context.header('Cache-Control', 'no-store');
      return context.html(indexHtml);
    });
    app.get(
      '/submeld/assets/*',
      serveStatic({ root: webRoot, rewriteRequestPath: (path) => path.replace(/^\/submeld/, '') }),
    );
    app.get('/submeld', (c) => c.redirect('/submeld/'));
  }
  app.get(
    '/source.tar.gz',
    serveStatic({
      root: fileURLToPath(
        new URL(import.meta.url.endsWith('.ts') ? '../dist/' : '../', import.meta.url),
      ),
      path: 'submeld-source.tar.gz',
    }),
  );
  app.on(['GET', 'HEAD'], '*', async (c) => {
    if (/^\/(api|s|upstream|submeld|download|gateway|server|data)(?:\/|$)/.test(c.req.path))
      throw new AppError('NOT_FOUND', '请求的资源不存在。', 404);
    if (!auth.valid(getCookie(c, cookieName))) return c.redirect('/submeld/');
    const url = new URL(c.req.url);
    if (url.pathname === '/' && !url.searchParams.has('api'))
      return c.redirect('/?api=' + encodeURIComponent(config.publicOrigin + '/upstream/sub-store'));
    const response = await frontend.request(url.pathname + url.search, {
      method: c.req.method,
      signal: c.req.raw.signal,
    });
    response.headers.delete('set-cookie');
    response.headers.delete('access-control-allow-origin');
    response.headers.delete('access-control-allow-credentials');
    return response;
  });
  app.notFound((context) =>
    context.json({ code: 'NOT_FOUND', message: '请求的资源不存在。' }, 404),
  );
  app.onError((error, context) => {
    const result = publicError(error);
    console.warn(
      JSON.stringify({
        route: context.req.routePath,
        status: error instanceof AppError ? error.status : 500,
        code: result.code,
      }),
    );
    return context.json(result, error instanceof AppError ? error.status : 500);
  });
  return app;
}
