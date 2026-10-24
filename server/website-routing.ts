import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  websiteRoutingAddSchema,
  websiteRoutingOrigin,
  websiteRoutingPresets,
  websiteRoutingSiteSchema,
  type WebsiteRoutingSite,
} from './shared/website-routing.js';

const key = 'websiteRouting.sites';
export class WebsiteRoutingStore {
  constructor(private db: Database.Database) {}

  list(): WebsiteRoutingSite[] {
    const row = z
      .object({ value: z.string() })
      .optional()
      .parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key));
    if (row) return websiteRoutingSiteSchema.array().parse(JSON.parse(row.value));
    const sites = websiteRoutingPresets.map(({ name, url, probe }) => ({
      id: randomUUID(),
      name,
      url,
      probe,
    }));
    this.save(sites);
    return sites;
  }

  private save(sites: WebsiteRoutingSite[]) {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(sites));
  }

  add(input: unknown): WebsiteRoutingSite {
    const value = websiteRoutingAddSchema.parse(input);
    let site: WebsiteRoutingSite;
    if ('presetId' in value) {
      const preset = websiteRoutingPresets.find((item) => item.key === value.presetId);
      if (!preset) throw new AppError('WEBSITE_PRESET_NOT_FOUND', '预置网站不存在。', 400);
      site = { id: randomUUID(), name: preset.name, url: preset.url, probe: preset.probe };
    } else {
      let origin: string;
      try {
        origin = websiteRoutingOrigin(value.domain);
      } catch {
        throw new AppError(
          'WEBSITE_DOMAIN_INVALID',
          '请输入有效的网站域名或 HTTP(S) 地址，不能包含用户名或密码。',
          400,
        );
      }
      const preset = websiteRoutingPresets.find((item) => new URL(item.url).origin === origin);
      site = {
        id: randomUUID(),
        name: value.name ?? preset?.name ?? new URL(origin).host,
        url: preset?.url ?? origin + '/cdn-cgi/trace',
        probe: preset?.probe ?? 'cf-trace',
      };
      site = websiteRoutingSiteSchema.parse(site);
    }
    return this.db.transaction(() => {
      const sites = this.list();
      if (sites.some((item) => new URL(item.url).origin === new URL(site.url).origin))
        throw new AppError('WEBSITE_ALREADY_EXISTS', '该网站已在列表中。', 409);
      this.save([...sites, site]);
      return site;
    })();
  }

  remove(id: string) {
    z.string().uuid().parse(id);
    this.db.transaction(() => {
      this.save(this.list().filter((site) => site.id !== id));
    })();
  }
}
