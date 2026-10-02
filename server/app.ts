import { UpstreamFiles } from './upstream-files.js';
import { UpstreamResources } from './upstream-resources.js';
import { SubStoreClient } from './sub-store.js';
import { frontendWorkerBoundary } from './frontend-worker.js';
import { type MiaospeedTester, validateSpeedSettings } from './miaospeed.js';
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

import type { SubscriptionStore } from './subscriptions.js';

import type { NodeTester } from './node-tests.js';
import { testSelectionSchema } from './shared/node-tests.js';
import { renderTargetSchema } from './shared/contracts.js';
import { outputFormatSchema } from './shared/subscriptions.js';

import { AppError, publicError } from './errors.js';
import { readJson } from './input.js';
import { MAX_BYTES } from './shared/contracts.js';
import { revisionSchema } from './shared/resources.js';
import { scriptConfigSchema } from './shared/miaospeed.js';
import type { TelegramService } from './telegram.js';
import type { NodeReporting } from './node-reporting.js';

export type AppOptions = {
  nodeReporting?: NodeReporting;
  miaospeed?: MiaospeedTester;
  telegram?: TelegramService;
  resources: UpstreamResources;
  webRoot?: string;
  tester?: NodeTester;
  nodes: NodeStore;
  chains: ChainStore;
  subscriptions: SubscriptionStore;
  config: Config;
  auth: Auth;
};
export function createApp({
  nodeReporting,
  miaospeed,
  telegram,
  resources,
  webRoot,
  tester,
  config,
  auth,
  nodes,
  chains,
  subscriptions,
}: AppOptions) {
  const app = new Hono();
  const secureCookie = config.publicOrigin.startsWith('https:');
  const cookieName =
    !config.development && secureCookie ? '__Host-submeld-session' : 'submeld-session';
  const writes = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/nodes',
    '/api/chains',
    '/api/subscriptions',
    '/api/node-tests',
    '/api/kernels',
    '/api/integrations',
    '/api/miaospeed',
    '/api/telegram',
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
        '/api/subscriptions/',
        '/api/node-tests/',
        '/api/kernels/',
        '/api/integrations/',
        '/api/miaospeed/',
        '/api/telegram/',
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
      /^\/api\/(nodes|chains|subscriptions)(?:\/|$)/.test(c.req.path) &&
      !/\/(artifacts|cancel)(?:\/|$)/.test(c.req.path)
    )
      await resources.sync();
    await next();
  });
  app.get('/api/integrations', (c) => {
    if (!auth.valid(getCookie(c, cookieName)))
      throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
    return c.json({
      subStore: '/?api=' + encodeURIComponent(config.publicOrigin + '/upstream/sub-store'),
    });
  });
  const reporting = () => {
    if (!nodeReporting) throw new AppError('REPORT_UNAVAILABLE', '节点上报服务尚未就绪。', 503);
    return nodeReporting;
  };
  app.get('/api/integrations/node-reporting', (c) => c.json(reporting().view()));
  app.patch('/api/integrations/node-reporting', async (c) =>
    c.json(reporting().update(await readJson(c.req.raw, 1024))),
  );
  app.post('/api/integrations/node-reporting/token', async (c) => {
    z.strictObject({}).parse(await readJson(c.req.raw, 1024));
    return c.json(reporting().rotateToken());
  });
  app.put('/api/node-reports/:machineId', async (c) => {
    const service = reporting();
    const authorization = c.req.header('Authorization');
    service.authorize(authorization);
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
        c.req.header('Content-Type') ?? '',
      )
    )
      throw new AppError('CONTENT_TYPE_UNSUPPORTED', '请发送 application/json 请求。', 415);
    const result = await service.report(
      c.req.param('machineId'),
      await readJson(c.req.raw, 26 * 1024 * 1024),
      authorization,
      c.req.raw.signal,
    );
    return c.json(result, result.action === 'created' ? 201 : 200);
  });
  const speed = () => {
    if (!miaospeed) throw new AppError('TEST_UNAVAILABLE', '综合测试服务尚未就绪。', 503);
    return miaospeed;
  };
  const bot = () => {
    if (!telegram) throw new AppError('TEST_UNAVAILABLE', 'Telegram 服务尚未就绪。', 503);
    return telegram;
  };
  app.get('/api/telegram/settings', async (c) => c.json(await bot().settings()));
  app.patch('/api/telegram/settings', async (c) =>
    c.json(await bot().update(await readJson(c.req.raw, MAX_BYTES))),
  );
  app.get('/api/telegram/status', (c) => c.json(bot().status()));
  app.post('/api/telegram/check', async (c) => {
    await empty(c.req.raw);
    return c.json(await bot().check());
  });
  app.get('/api/telegram/tasks', (c) =>
    c.json(
      bot().store.list(
        z.coerce
          .number()
          .int()
          .min(0)
          .max(1000000)
          .parse(c.req.query('page') ?? 0),
      ),
    ),
  );
  app.post('/api/telegram/tasks/:id/cancel', async (c) => {
    await empty(c.req.raw);
    return c.json(bot().cancel(c.req.param('id')));
  });
  app.post('/api/telegram/tasks/:id/resend', async (c) => {
    await empty(c.req.raw);
    return c.json(bot().resend(c.req.param('id')));
  });
  app.get('/api/miaospeed/status', (c) => c.json(speed().status()));
  app.post('/api/miaospeed/status/check', async (c) => {
    await empty(c.req.raw);
    return c.json(await speed().check());
  });
  app.get('/api/miaospeed/settings', (c) => c.json(speed().store.settings()));
  app.patch('/api/miaospeed/settings', async (c) =>
    c.json(speed().store.updateSettings(validateSpeedSettings(await readJson(c.req.raw, 8192)))),
  );
  app.post('/api/miaospeed/preview', async (c) =>
    c.json(await speed().input.preview(await readJson(c.req.raw, 26 * 1024 * 1024)), 201),
  );
  app.post('/api/miaospeed/tests', async (c) =>
    c.json(await speed().start(await readJson(c.req.raw, MAX_BYTES)), 202),
  );
  app.get('/api/miaospeed/tests/current', async (c) => c.json(await speed().current()));
  app.get('/api/miaospeed/tests/:id', async (c) => c.json(await speed().report(c.req.param('id'))));
  app.post('/api/miaospeed/tests/:id/cancel', async (c) => {
    await empty(c.req.raw);
    return c.json(speed().cancel(c.req.param('id')));
  });
  app.get('/api/miaospeed/reports', (c) =>
    c.json(speed().store.list(listPage(c.req.query('page')))),
  );
  app.get('/api/miaospeed/reports/:id', async (c) =>
    c.json(await speed().report(c.req.param('id'))),
  );
  app.delete('/api/miaospeed/reports/:id', async (c) => {
    await empty(c.req.raw);
    return c.json(speed().store.remove(c.req.param('id')));
  });
  app.get('/api/miaospeed/scripts', async (c) => {
    await resources.sync();
    return c.json(speed().scripts.list());
  });
  app.post('/api/miaospeed/scripts/initialize', async (c) => {
    await empty(c.req.raw);
    return c.json(await speed().scripts.initialize());
  });
  app.post('/api/miaospeed/scripts', async (c) =>
    c.json(await speed().scripts.put(await readJson(c.req.raw, MAX_BYTES)), 201),
  );
  app.patch('/api/miaospeed/scripts/:id', async (c) =>
    c.json(await speed().scripts.put(await readJson(c.req.raw, MAX_BYTES), c.req.param('id'))),
  );
  app.delete('/api/miaospeed/scripts/:id', async (c) =>
    c.json(await speed().scripts.remove(c.req.param('id'), await requestRevision(c.req.raw))),
  );
  app.post('/api/miaospeed/scripts/:id/restore', async (c) => {
    const revision = await requestRevision(c.req.raw);
    await resources.sync();
    const old = speed()
      .scripts.list()
      .scripts.find((s) => s.id === c.req.param('id'));
    if (!old) throw new AppError('NOT_FOUND', '脚本已不存在。', 404);
    const data = scriptConfigSchema.strip().parse(old);
    return c.json(await speed().scripts.put({ ...data, revision }, old.id, true));
  });
  const supportFiles = new UpstreamFiles(resources);
  app.get('/api/integrations/files', async (c) => {
    await resources.sync();
    return c.json(supportFiles.supportFiles());
  });
  app.patch('/api/integrations/files/:id', async (c) =>
    c.json(await supportFiles.updateSupport(c.req.param('id'), await requestRevision(c.req.raw))),
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
      write && !pure ? await resources.write(forward, path, c.req.method, body) : await forward();
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
      secure: secureCookie,
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
      secure: secureCookie,
      httpOnly: true,
      sameSite: 'Strict',
    });
    return context.json({ authenticated: false });
  });
  app.get('/api/nodes/resources', (c) => c.json({ resources: resources.listResources() }));
  app.get('/api/nodes', async (c) =>
    c.json(
      await nodes.list(
        c.req.query('resourceId'),
        c.req.query('search') ?? '',
        listPage(c.req.query('page')),
        c.req.query('refresh') === '1',
      ),
    ),
  );
  app.post('/api/nodes', async (c) =>
    c.json(await nodes.create(await readJson(c.req.raw, 26 * 1024 * 1024)), 201),
  );
  app.post('/api/nodes/detail', async (c) =>
    c.json(await nodes.get(await readJson(c.req.raw, 8192))),
  );
  app.post('/api/nodes/delete', async (c) =>
    c.json(await nodes.delete(await readJson(c.req.raw, MAX_BYTES))),
  );
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
    const value = z.object({ revision: revisionSchema }).safeParse(await readJson(request, 1024));
    if (!value.success) throw new AppError('INVALID_REQUEST', '请求缺少有效版本。', 400);
    return value.data.revision;
  }
  async function updateBody(request: Request) {
    const value = z
      .object({ revision: revisionSchema })
      .catchall(z.unknown())
      .safeParse(await readJson(request, MAX_BYTES));
    if (!value.success) throw new AppError('INVALID_REQUEST', '请求缺少有效版本。', 400);
    const { revision, ...config } = value.data;
    return { revision, config };
  }
  const detail = (id: string) => subscriptions.detail(id, config.publicOrigin);
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
  app.get('/api/chains', async (c) => c.json(await chains.list(listPage(c.req.query('page')))));
  app.post('/api/chains', async (c) =>
    c.json(await chains.create(await readJson(c.req.raw, 16 * 1024)), 201),
  );
  app.get('/api/chains/:id', async (c) => c.json(await chains.get(c.req.param('id'))));
  app.patch('/api/chains/:id', async (c) => {
    const body = await updateBody(c.req.raw);
    return c.json(await chains.update(c.req.param('id'), body.config, body.revision));
  });
  app.delete('/api/chains/:id', async (c) => {
    await chains.delete(c.req.param('id'), await requestRevision(c.req.raw));
    return c.json({ deleted: true });
  });
  app.get('/api/subscriptions', (c) => c.json(subscriptions.list(listPage(c.req.query('page')))));
  app.post('/api/subscriptions', async (c) => {
    const plan = await subscriptions.create(await readJson(c.req.raw, MAX_BYTES));
    return c.json(await detail(plan.id), 201);
  });
  app.get('/api/subscriptions/:id', async (c) => c.json(await detail(c.req.param('id'))));
  app.patch('/api/subscriptions/:id', async (c) => {
    const body = await updateBody(c.req.raw);
    const plan = await subscriptions.update(c.req.param('id'), body.config, body.revision);
    return c.json(await detail(plan.id));
  });
  app.delete('/api/subscriptions/:id', async (c) => {
    await subscriptions.delete(c.req.param('id'), await requestRevision(c.req.raw));
    return c.json({ deleted: true });
  });
  app.post('/api/subscriptions/:id/share', async (c) => {
    await subscriptions.share(c.req.param('id'), await requestRevision(c.req.raw), false);
    return c.json(await detail(c.req.param('id')));
  });
  app.post('/api/subscriptions/:id/revoke', async (c) => {
    await subscriptions.share(c.req.param('id'), await requestRevision(c.req.raw), true);
    return c.json(await detail(c.req.param('id')));
  });
  app.get('/api/subscriptions/:id/artifacts/:format', async (c) => {
    const format = outputFormatSchema.safeParse(c.req.param('format'));
    if (!format.success) throw new AppError('NOT_FOUND', '请求的格式不存在。', 404);
    return c.json(
      await subscriptions.artifact(c.req.param('id'), format.data, c.req.query('refresh') === '1'),
    );
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
  app.onError((failure, context) => {
    const error =
      failure instanceof z.ZodError
        ? new AppError('INVALID_REQUEST', '请求格式无效。', 400)
        : failure;
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
