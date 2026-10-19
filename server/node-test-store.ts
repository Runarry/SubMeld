import type Database from 'better-sqlite3';
import { z } from 'zod';
import { rawDraft, type UpstreamResources } from './upstream-resources.js';
import type { RenderItem, RenderTarget } from './shared/contracts.js';
import { AppError } from './errors.js';
import { probeUrl } from './node-probe.js';
import {
  DEFAULT_PROBE_URL,
  subjectKey,
  sameSubject,
  testResultSchema,
  testSettingsSchema,
  type TestSubject,
  type TestResult,
} from './shared/node-tests.js';
export function createNodeTestStore(db: Database.Database, resources: UpstreamResources) {
  function inspect(subject: TestSubject): { subject: TestSubject; name: string; item: RenderItem } {
    const snapshot = resources.cached(subject.resourceId),
      row = snapshot.rows[subject.nodeIndex];
    if (!row) throw new AppError('NOT_FOUND', '节点已不存在。', 404);
    const view = row.view;
    return {
      subject: {
        kind: 'node',
        resourceId: view.resourceId,
        revision: view.revision,
        snapshotHash: view.snapshotHash,
        nodeIndex: view.nodeIndex,
      },
      name: view.name,
      item: {
        nodeIndex: 0,
        excluded: false,
        diagnostics: [],
        draft: rawDraft(row.processed ?? row.original),
      },
    };
  }
  function matches(subject: TestSubject) {
    try {
      return sameSubject(inspect(subject).subject, subject);
    } catch (error) {
      if (error instanceof AppError) return false;
      throw error;
    }
  }
  function settings() {
    const raw: unknown = db.prepare("SELECT value FROM settings WHERE key='node_test_url'").get();
    return raw
      ? testSettingsSchema.parse({ url: z.object({ value: z.string() }).parse(raw).value })
      : { url: DEFAULT_PROBE_URL };
  }
  function capture(subject: TestSubject) {
    const value = inspect(subject);
    if (!sameSubject(value.subject, subject))
      throw new AppError('REVISION_CONFLICT', '节点内容或顺序已变化，请刷新列表。', 409);
    return value;
  }
  function fresh(result: TestResult, versions: Map<RenderTarget, string | null>) {
    return {
      ...result,
      stale:
        result.stale ||
        !matches(result.subject) ||
        result.url !== settings().url ||
        result.coreVersion !== versions.get(result.core),
    };
  }
  return {
    async refresh(subjects: TestSubject[]) {
      await resources.sync();
      await resources.prepare(subjects.map((subject) => subject.resourceId));
    },
    inspect,
    matches,
    capture,
    settings,
    fresh,
    selection: (subjects: TestSubject[]) =>
      subjects.map((subject) => ({ subject, name: capture(subject).name })),
    updateSettings(input: unknown) {
      const parsed = testSettingsSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '测试地址格式无效。', 400);
      const url = probeUrl(parsed.data.url).href;
      if (!testSettingsSchema.safeParse({ url }).success)
        throw new AppError('TEST_URL_INVALID', '测试地址编码后过长。', 400);
      db.prepare(
        "INSERT INTO settings(key,value) VALUES ('node_test_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(url);
      return { url };
    },
    save(result: TestResult) {
      if (!matches(result.subject) || ['cancelled', 'stale'].includes(result.status)) return false;
      db.prepare(
        'INSERT INTO node_test_results(key,result_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET result_json=excluded.result_json',
      ).run(
        subjectKey(result.subject) + ':' + result.core,
        JSON.stringify(testResultSchema.parse(result)),
      );
      return true;
    },
    results(subjects: TestSubject[], versions: Map<RenderTarget, string | null>) {
      const results: TestResult[] = [];
      for (const subject of subjects)
        for (const target of ['mihomo', 'singbox', 'xray']) {
          const row = z
            .object({ result_json: z.string() })
            .optional()
            .parse(
              db
                .prepare('SELECT result_json FROM node_test_results WHERE key=?')
                .get(subjectKey(subject) + ':' + target),
            );
          if (!row) continue;
          const result = testResultSchema.parse(JSON.parse(row.result_json));
          if (sameSubject(subject, result.subject)) results.push(fresh(result, versions));
        }
      return { results };
    },
  };
}
export type NodeTestStore = ReturnType<typeof createNodeTestStore>;
