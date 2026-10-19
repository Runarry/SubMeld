import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AppError } from './errors.js';
import { storedSpeedSettings } from './legacy-test-data.js';
import { record } from './converter/model.js';
import {
  speedReportSchema,
  speedRowSchema,
  speedSettingsSchema,
  reportSummarySchema,
  type SpeedReport,
  type SpeedRow,
} from './shared/miaospeed.js';

const resultCounts = `SELECT report_id,
  SUM(CASE WHEN json_extract(result,'$.subject.kind')='chain' THEN 1 ELSE 0 END) retired,
  SUM(CASE WHEN json_extract(result,'$.subject.kind')='chain' THEN 0 ELSE 1 END) visible,
  SUM(CASE WHEN json_extract(result,'$.subject.kind')='chain' OR json_extract(result,'$.state') IN ('pending','running') THEN 0 ELSE 1 END) finished
  FROM speed_results GROUP BY report_id`;
const visibleReports = `FROM speed_reports r LEFT JOIN (${resultCounts}) c ON r.id=c.report_id
  WHERE COALESCE(c.retired,0)=0 OR c.visible>0`;
const countsSchema = z.object({ retired: z.number(), visible: z.number(), finished: z.number() });
function storedSummary(input: unknown) {
  return reportSummarySchema.parse(
    record(input) ? { ...input, settings: storedSpeedSettings(input.settings) } : input,
  );
}
function legacyProgress<T extends z.infer<typeof reportSummarySchema>>(report: T): T {
  if (report.state !== 'running') return report;
  return {
    ...report,
    state: 'interrupted',
    current: null,
    error: '服务重启，未完成的任务已中断。',
  };
}

export class MiaospeedStore {
  constructor(private db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS speed_reports(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,metadata TEXT NOT NULL); CREATE TABLE IF NOT EXISTS speed_results(report_id TEXT NOT NULL REFERENCES speed_reports(id) ON DELETE CASCADE,position INTEGER NOT NULL,result TEXT NOT NULL,PRIMARY KEY(report_id,position));',
    );
    for (const entry of z
      .array(z.object({ id: z.string(), metadata: z.string() }))
      .parse(db.prepare('SELECT id,metadata FROM speed_reports').all())) {
      // Retired mixed reports are exposed as a read-only view; never rewrite their original rows.
      if (this.counts(entry.id).retired) continue;
      const meta = storedSummary(JSON.parse(entry.metadata));
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
    return storedSpeedSettings(row ? JSON.parse(row.value) : {});
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
    const raw: unknown[] = results.map((row) => JSON.parse(row.result));
    const visible = raw.filter(
      (value) => !(record(value) && record(value.subject) && value.subject.kind === 'chain'),
    );
    const retired = visible.length !== raw.length;
    if (retired && !visible.length) throw new AppError('NOT_FOUND', '测试报告已不存在。', 404);
    const report = speedReportSchema.parse({
      ...storedSummary(JSON.parse(row.metadata)),
      results: visible,
    });
    if (!retired) return report;
    report.total = report.results.length;
    report.completed = report.results.filter(
      (value) => !['pending', 'running'].includes(value.state),
    ).length;
    report.current = null;
    if (report.state === 'running') {
      for (const value of report.results)
        if (value.state === 'pending' || value.state === 'running') {
          value.state = 'cancelled';
          value.message = '服务重启，凭据副本已清除；请重新发起测试。';
        }
    }
    return legacyProgress(report);
  }
  private counts(id: string) {
    return countsSchema.parse(
      this.db
        .prepare(`SELECT retired,visible,finished FROM (${resultCounts}) WHERE report_id=?`)
        .get(id) ?? { retired: 0, visible: 0, finished: 0 },
    );
  }
  list(page: number) {
    return {
      reports: z
        .array(
          z.object({
            metadata: z.string(),
            retired: z.number(),
            visible: z.number(),
            finished: z.number(),
          }),
        )
        .parse(
          this.db
            .prepare(
              `SELECT r.metadata,COALESCE(c.retired,0) retired,COALESCE(c.visible,0) visible,COALESCE(c.finished,0) finished ${visibleReports} ORDER BY r.created_at DESC LIMIT 25 OFFSET ?`,
            )
            .all(page * 25),
        )
        .map((row) => {
          const meta = storedSummary(JSON.parse(row.metadata));
          return row.retired
            ? legacyProgress({
                ...meta,
                total: row.visible,
                completed: row.finished,
                current: null,
              })
            : meta;
        }),
      total: z
        .object({ n: z.number() })
        .parse(this.db.prepare(`SELECT COUNT(*) n ${visibleReports}`).get()).n,
    };
  }
  remove(id: string) {
    if (this.get(id).state === 'running')
      throw new AppError('TEST_BUSY', '请先取消正在运行的测试。', 409);
    this.db.prepare('DELETE FROM speed_reports WHERE id=?').run(id);
    return { deleted: true };
  }
}
