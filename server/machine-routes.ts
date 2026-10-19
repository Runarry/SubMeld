import type { Hono } from 'hono';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { readJson } from './input.js';
import type { MachineStore } from './machines.js';

export function registerMachineRoutes(app: Hono, store: MachineStore, _config?: Config) {
  void _config;
  app.get('/api/machines', (c) => c.json({ machines: store.list() }));
  app.post('/api/machines', async (c) =>
    c.json(store.create(await readJson(c.req.raw, 4096)), 201),
  );
  app.get('/api/machines/:id', async (c) => c.json(await store.detail(c.req.param('id'))));
  app.patch('/api/machines/:id', async (c) =>
    c.json(await store.update(c.req.param('id'), await readJson(c.req.raw, 4096))),
  );
  app.post('/api/machines/:id/token', async (c) => {
    z.strictObject({}).parse(await readJson(c.req.raw, 1024));
    return c.json(await store.rotateToken(c.req.param('id')));
  });
  app.get('/api/machines/:id/snapshot', async (c) =>
    c.json({ snapshot: await store.getPrivateSnapshot(c.req.param('id')) }),
  );
  app.post('/api/machines/:id/commands', async (c) =>
    c.json(await store.enqueue(c.req.param('id'), await readJson(c.req.raw, 1024 * 1024)), 201),
  );
  app.post('/api/machines/:id/commands/:taskId/cancel', async (c) => {
    z.strictObject({}).parse(await readJson(c.req.raw, 1024));
    return c.json(await store.cancel(c.req.param('id'), c.req.param('taskId')));
  });
  app.use('/api/agent/*', async (c, next) => {
    if (
      c.req.method === 'POST' &&
      !/^application\/json(?:\s*;.*)?$/i.test(c.req.header('Content-Type') ?? '')
    )
      throw new AppError('CONTENT_TYPE_UNSUPPORTED', '请发送 application/json 请求。', 415);
    await next();
  });
  app.post('/api/agent/report', async (c) =>
    c.json(
      await store.report(
        await readJson(c.req.raw, 16 * 1024 * 1024),
        c.req.header('Authorization'),
        c.req.raw.signal,
      ),
    ),
  );
  app.get('/api/agent/commands', async (c) => {
    try {
      return c.json(
        await store.poll(
          z.string().uuid().parse(c.req.query('machineId')),
          c.req.header('Authorization'),
          z.coerce
            .number()
            .int()
            .min(0)
            .max(25)
            .parse(c.req.query('wait') ?? 25),
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      throw error;
    }
  });
  app.post('/api/agent/results', async (c) =>
    c.json(
      await store.result(
        await readJson(c.req.raw, 16 * 1024 * 1024),
        c.req.header('Authorization'),
        c.req.raw.signal,
      ),
    ),
  );
}
