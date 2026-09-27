import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AppError } from './errors.js';
import { UpstreamResources } from './upstream-resources.js';
import { sourceSummarySchema } from './shared/subscriptions.js';

export function createSourceStore(db: Database.Database, resources: UpstreamResources) {
  return {
    sync: () => resources.sync(),
    get: (id: string) => resources.source(id),
    async prepare(ids: string[], force = false) {
      for (const id of new Set(ids)) await resources.refresh(id, force);
    },
    async requestRefresh(id: string, revision: number) {
      if (resources.source(id).revision !== revision)
        throw new AppError('REVISION_CONFLICT', '来源已修改，请重新载入。', 409);
      return resources.refresh(id, true);
    },
    list(page: number) {
      const rows = z
        .array(z.object({ id: z.string() }))
        .parse(
          db
            .prepare(
              'SELECT id FROM sources WHERE present=1 ORDER BY created_at,id LIMIT 25 OFFSET ?',
            )
            .all(page * 25),
        );
      return {
        sources: rows.map(({ id }) => sourceSummarySchema.strip().parse(resources.source(id))),
        total: z
          .object({ n: z.number() })
          .parse(db.prepare('SELECT COUNT(*) n FROM sources WHERE present=1').get()).n,
      };
    },
  };
}
export type SourceStore = ReturnType<typeof createSourceStore>;
