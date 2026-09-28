import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  speedReportSchema,
  speedRowSchema,
  speedSettingsSchema,
  reportSummarySchema,
  type SpeedReport,
  type SpeedRow,
} from './shared/miaospeed.js';

export class MiaospeedStore {
  constructor(private db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS speed_reports(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,metadata TEXT NOT NULL); CREATE TABLE IF NOT EXISTS speed_results(report_id TEXT NOT NULL REFERENCES speed_reports(id) ON DELETE CASCADE,position INTEGER NOT NULL,result TEXT NOT NULL,PRIMARY KEY(report_id,position));',
    );
    for (const entry of z
      .array(z.object({ id: z.string(), metadata: z.string() }))
      .parse(db.prepare('SELECT id,metadata FROM speed_reports').all())) {
      const meta = reportSummarySchema.parse(JSON.parse(entry.metadata));
      if (meta.state !== 'running') continue;
      const report = this.get(entry.id);
      report.state = 'interrupted';
      report.current = null;
      report.finishedAt = new Date().toISOString();
      report.error = '服务重启，未完成的任务已中断。';
      for (const row of report.results)
        if (row.state === 'pending' || row.state === 'running') {
          row.state = 'cancelled';
          row.message = '服务重启，凭据副本已清除；请重新发起测试。';
          this.saveRow(report.id, row);
        }
      this.save(report);
    }
  }
  settings() {
    const row = z
      .object({ value: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT value FROM settings WHERE key='miaospeed.settings'").get());
    return speedSettingsSchema.parse(row ? JSON.parse(row.value) : {});
  }
  updateSettings(input: unknown) {
    const value = speedSettingsSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('miaospeed.settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(value));
    return value;
  }
  create(report: SpeedReport) {
    this.db.transaction(() => {
      this.save(report);
      for (const row of report.results) this.saveRow(report.id, row);
    })();
  }
  save(report: SpeedReport) {
    const meta = reportSummarySchema.strip().parse(report);
    this.db
      .prepare(
        'INSERT INTO speed_reports(id,created_at,metadata) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata',
      )
      .run(report.id, report.createdAt, JSON.stringify(meta));
  }
  saveRow(id: string, row: SpeedRow) {
    this.db
      .prepare(
        'INSERT INTO speed_results(report_id,position,result) VALUES(?,?,?) ON CONFLICT(report_id,position) DO UPDATE SET result=excluded.result',
      )
      .run(id, row.index, JSON.stringify(speedRowSchema.parse(row)));
  }
  get(id: string): SpeedReport {
    const row = z
      .object({ metadata: z.string() })
      .optional()
      .parse(this.db.prepare('SELECT metadata FROM speed_reports WHERE id=?').get(id));
    if (!row) throw new AppError('NOT_FOUND', '测试报告已不存在。', 404);
    const results = z
      .array(z.object({ result: z.string() }))
      .parse(
        this.db
          .prepare('SELECT result FROM speed_results WHERE report_id=? ORDER BY position')
          .all(id),
      );
    return speedReportSchema.parse({
      ...JSON.parse(row.metadata),
      results: results.map((row) => JSON.parse(row.result)),
    });
  }
  list(page: number) {
    return {
      reports: z
        .array(z.object({ metadata: z.string() }))
        .parse(
          this.db
            .prepare(
              'SELECT metadata FROM speed_reports ORDER BY created_at DESC LIMIT 25 OFFSET ?',
            )
            .all(page * 25),
        )
        .map((row) => reportSummarySchema.parse(JSON.parse(row.metadata))),
      total: z
        .object({ n: z.number() })
        .parse(this.db.prepare('SELECT COUNT(*) n FROM speed_reports').get()).n,
    };
  }
  remove(id: string) {
    if (this.get(id).state === 'running')
      throw new AppError('TEST_BUSY', '请先取消正在运行的测试。', 409);
    this.db.prepare('DELETE FROM speed_reports WHERE id=?').run(id);
    return { deleted: true };
  }
}
