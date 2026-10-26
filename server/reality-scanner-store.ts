import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  scanActive,
  scanSummarySchema,
  scanResultSchema,
  type ScanSummary,
  type ScanResult,
} from './shared/reality-scanner.js';

export type ScanFilter = { state?: ScanResult['state']; search?: string };
export class RealityScannerStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS reality_scans(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reality_scan_results(scan_id TEXT NOT NULL REFERENCES reality_scans(id) ON DELETE CASCADE,position INTEGER NOT NULL,state TEXT NOT NULL,search TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scan_id,position));
      CREATE INDEX IF NOT EXISTS reality_scan_results_state ON reality_scan_results(scan_id,state,position);`);
    const rows = z
      .array(z.object({ metadata: z.string() }))
      .parse(db.prepare('SELECT metadata FROM reality_scans').all());
    for (const row of rows) {
      const scan = scanSummarySchema.parse(JSON.parse(row.metadata));
      if (!scanActive(scan.state)) continue;
      this.save({
        ...scan,
        state: 'interrupted',
        finishedAt: new Date().toISOString(),
        message: '服务重启，未完成的扫描已中断。',
      });
    }
  }
  save(scan: ScanSummary) {
    const value = scanSummarySchema.parse(scan);
    this.db
      .prepare(
        'INSERT INTO reality_scans(id,created_at,metadata) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata',
      )
      .run(value.id, value.createdAt, JSON.stringify(value));
  }
  append(scan: ScanSummary, result: ScanResult) {
    this.db.transaction(() => {
      const row = scanResultSchema.parse(result);
      this.db
        .prepare(
          'INSERT INTO reality_scan_results(scan_id,position,state,search,result) VALUES(?,?,?,?,?)',
        )
        .run(
          scan.id,
          row.position,
          row.state,
          [row.ip, row.origin, row.certDomain, row.certIssuer, row.countryCode, row.message]
            .join('\n')
            .toLowerCase(),
          JSON.stringify(row),
        );
      this.save(scan);
    })();
  }
  get(id: string): ScanSummary {
    const row = z
      .object({ metadata: z.string() })
      .optional()
      .parse(this.db.prepare('SELECT metadata FROM reality_scans WHERE id=?').get(id));
    if (!row) throw new AppError('SCAN_NOT_FOUND', '扫描记录不存在。', 404);
    return scanSummarySchema.parse(JSON.parse(row.metadata));
  }
  list(page: number) {
    const rows = z
      .array(z.object({ metadata: z.string() }))
      .parse(
        this.db
          .prepare(
            'SELECT metadata FROM reality_scans ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?',
          )
          .all(page * 25),
      );
    return {
      scans: rows.map((r) => scanSummarySchema.parse(JSON.parse(r.metadata))),
      total: z
        .object({ total: z.number() })
        .parse(this.db.prepare('SELECT COUNT(*) total FROM reality_scans').get()).total,
    };
  }
  private selection(id: string, filter: ScanFilter) {
    this.get(id);
    const clauses = ['scan_id=?'],
      args: string[] = [id];
    if (filter.state) {
      clauses.push('state=?');
      args.push(filter.state);
    }
    if (filter.search) {
      clauses.push('instr(search,?)>0');
      args.push(filter.search.toLowerCase());
    }
    return { where: clauses.join(' AND '), args };
  }
  results(id: string, filter: ScanFilter, page: number) {
    const { where, args } = this.selection(id, filter);
    const rows = z
      .array(z.object({ result: z.string() }))
      .parse(
        this.db
          .prepare(
            'SELECT result FROM reality_scan_results WHERE ' +
              where +
              ' ORDER BY position LIMIT 25 OFFSET ?',
          )
          .all(...args, page * 25),
      );
    const total = z
      .object({ total: z.number() })
      .parse(
        this.db
          .prepare('SELECT COUNT(*) total FROM reality_scan_results WHERE ' + where)
          .get(...args),
      ).total;
    return { results: rows.map((r) => scanResultSchema.parse(JSON.parse(r.result))), total };
  }
  allResults(id: string, filter: ScanFilter): ScanResult[] {
    const { where, args } = this.selection(id, filter);
    return z
      .array(z.object({ result: z.string() }))
      .parse(
        this.db
          .prepare('SELECT result FROM reality_scan_results WHERE ' + where + ' ORDER BY position')
          .all(...args),
      )
      .map((r) => scanResultSchema.parse(JSON.parse(r.result)));
  }
  remove(id: string) {
    if (scanActive(this.get(id).state))
      throw new AppError('SCAN_BUSY', '请先停止扫描，再删除记录。', 409);
    this.db.prepare('DELETE FROM reality_scans WHERE id=?').run(id);
  }
}
