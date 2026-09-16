import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Auth } from './auth.js';
import type { Converter } from './converter/pool.js';
import { AppError, publicError } from './errors.js';
import { readJson } from './input.js';
import { MAX_BYTES, parseRequestSchema, produceRequestSchema } from './shared/contracts.js';

export type AppOptions = {
  webRoot?: string;
  config: Config;
  auth: Auth;
  converter: Pick<Converter, 'run'>;
};
export function createApp({ webRoot, config, auth, converter }: AppOptions) {
  const app = new Hono();
  const cookieName = config.development ? 'submeld-session' : '__Host-submeld-session';
  const writes = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/convert/parse',
    '/api/convert/produce',
  ]);
  app.use('*', async (context, next) => {
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
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
    if (context.req.method === 'POST' && writes.has(context.req.path)) {
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
      (writes.has(context.req.path) && context.req.path !== '/api/auth/login') ||
      context.req.path === '/api/auth/me'
    ) {
      if (!auth.valid(getCookie(context, cookieName)))
        throw new AppError('UNAUTHENTICATED', '请先登录。', 401);
    }
    await next();
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
  if (webRoot) {
    const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
    app.get('/', (context) => {
      context.header('Cache-Control', 'no-store');
      return context.html(indexHtml);
    });
    app.get('/assets/*', serveStatic({ root: webRoot }));
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
