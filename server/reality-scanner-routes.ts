import type { Hono } from 'hono';
import { z } from 'zod';
import { readJson } from './input.js';
import { SCAN_MAX_BYTES, scanResultStateSchema } from './shared/reality-scanner.js';
import type { RealityScanner } from './reality-scanner.js';

const querySchema = z.object({
  page: z.coerce.number().int().min(0).max(1000000).default(0),
  state: z.union([scanResultStateSchema, z.literal('all')]).default('all'),
  search: z.string().max(512).default(''),
});
export function registerRealityScannerRoutes(app: Hono, scanner: RealityScanner) {
  const base = '/api/reality-scanner';
  const id = (value: unknown) => z.string().uuid().parse(value);
  app.get(base + '/status', (c) => c.json(scanner.status()));
  app.post(base + '/preview', async (c) =>
    c.json(await scanner.preview(await readJson(c.req.raw, SCAN_MAX_BYTES * 2 + 65536))),
  );
  app.post(base + '/scans', async (c) =>
    c.json(scanner.start(await readJson(c.req.raw, SCAN_MAX_BYTES * 2 + 65536)), 201),
  );
  app.get(base + '/scans', (c) =>
    c.json(scanner.store.list(querySchema.parse(c.req.query()).page)),
  );
  app.get(base + '/scans/:id', (c) => c.json(scanner.store.get(id(c.req.param('id')))));
  app.get(base + '/scans/:id/results', (c) => {
    const query = querySchema.parse(c.req.query());
    return c.json(
      scanner.store.results(
        id(c.req.param('id')),
        { search: query.search, state: query.state === 'all' ? undefined : query.state },
        query.page,
      ),
    );
  });
  app.get(base + '/scans/:id/export', (c) => {
    const query = querySchema.parse(c.req.query());
    const format = z.enum(['csv', 'ips', 'domains']).parse(c.req.query('format') ?? 'csv');
    const scanId = id(c.req.param('id'));
    const content = scanner.export(
      scanId,
      { search: query.search, state: query.state === 'all' ? undefined : query.state },
      format,
    );
    c.header(
      'Content-Type',
      format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
    );
    c.header(
      'Content-Disposition',
      'attachment; filename="reality-' +
        scanId +
        '-' +
        format +
        (format === 'csv' ? '.csv' : '.txt') +
        '"',
    );
    return c.body(content);
  });
  app.post(base + '/scans/:id/cancel', async (c) => {
    z.strictObject({}).parse(await readJson(c.req.raw, 1024));
    return c.json(scanner.cancel(id(c.req.param('id'))));
  });
  app.delete(base + '/scans/:id', async (c) => {
    z.strictObject({}).parse(await readJson(c.req.raw, 1024));
    scanner.remove(id(c.req.param('id')));
    return c.json({ removed: true });
  });
}
