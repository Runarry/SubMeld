import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { NodeStore } from './nodes.js';
import type { ChainStore } from './chains.js';
import type { SourceStore } from './sources.js';
import type { Source } from './shared/subscriptions.js';
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

export function createNodeTestStore(
  db: Database.Database,
  nodes: NodeStore,
  chains: ChainStore,
  sources: SourceStore,
) {
  function inspect(
    subject: TestSubject,
    sourceSnapshot?: Source,
  ): { subject: TestSubject; name: string; item: RenderItem } {
    if (subject.kind === 'node') {
      const node = nodes.get(subject.id);
      return {
        subject: { kind: 'node', id: node.id, revision: node.revision },
        name: node.name,
        item: { nodeIndex: 0, excluded: false, diagnostics: [], draft: node.draft },
      };
    }
    if (subject.kind === 'chain') {
      const chain = chains.get(subject.id);
      return {
        subject: {
          kind: 'chain',
          id: chain.id,
          revision: chain.revision,
          entryRevision: chain.entry.revision,
          exitRevision: chain.exit.revision,
        },
        name: chain.name,
        item: {
          kind: 'chain',
          nodeIndex: 0,
          excluded: false,
          diagnostics: [],
          name: chain.name,
          entry: nodes.get(chain.entryNodeId).draft,
          exit: nodes.get(chain.exitNodeId).draft,
          available: true,
        },
      };
    }
    const source = sourceSnapshot ?? sources.get(subject.id),
      item = source.items.find((item) => item.nodeIndex === subject.nodeIndex);
    if (!item?.draft) throw new AppError('NOT_FOUND', '来源节点不存在或尚无成功快照。', 404);
    return {
      subject: {
        kind: 'source',
        id: source.id,
        revision: source.revision,
        snapshotHash: source.snapshotHash,
        nodeIndex: subject.nodeIndex,
      },
      name: item.draft.name,
      item: { ...item, nodeIndex: 0, excluded: false },
    };
  }
  function currentSubject(subject: TestSubject): TestSubject {
    let row: unknown;
    if (subject.kind === 'node') {
      row = db.prepare('SELECT revision FROM nodes WHERE id=? AND present=1').get(subject.id);
    } else if (subject.kind === 'source') {
      row = db
        .prepare('SELECT revision,snapshot_hash snapshotHash FROM sources WHERE id=? AND present=1')
        .get(subject.id);
    } else {
      row = db
        .prepare(
          'SELECT c.revision, e.revision entryRevision, x.revision exitRevision FROM chains c JOIN nodes e ON e.id=c.entry_node_id JOIN nodes x ON x.id=c.exit_node_id WHERE c.id=? AND e.present=1 AND x.present=1',
        )
        .get(subject.id);
    }
    if (!row) throw new AppError('NOT_FOUND', '测试对象已删除。', 404);
    const value = z
      .object({
        revision: z.number().int().positive(),
        snapshotHash: z.string().optional(),
        entryRevision: z.number().int().positive().optional(),
        exitRevision: z.number().int().positive().optional(),
      })
      .parse(row);
    if (subject.kind === 'source')
      return {
        ...subject,
        revision: value.revision,
        snapshotHash: z.string().parse(value.snapshotHash),
      };
    if (subject.kind === 'chain')
      return {
        ...subject,
        revision: value.revision,
        entryRevision: z.number().int().positive().parse(value.entryRevision),
        exitRevision: z.number().int().positive().parse(value.exitRevision),
      };
    return { ...subject, revision: value.revision };
  }
  function matches(subject: TestSubject) {
    try {
      return sameSubject(currentSubject(subject), subject);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return false;
      throw error;
    }
  }
  function settings() {
    const raw: unknown = db.prepare("SELECT value FROM settings WHERE key='node_test_url'").get();
    return raw
      ? testSettingsSchema.parse({ url: z.object({ value: z.string() }).parse(raw).value })
      : { url: DEFAULT_PROBE_URL };
  }
  return {
    async refresh(subjects: TestSubject[]) {
      await sources.sync();
      await sources.prepare(subjects.filter((s) => s.kind === 'source').map((s) => s.id));
    },
    inspect,
    matches,
    settings,
    selection(subjects: TestSubject[]) {
      const names = new Map<string, string>();
      const sourceGroups = new Map<string, TestSubject[]>();
      const captureName = (subject: TestSubject, source?: Source) => {
        const value = inspect(subject, source);
        if (!sameSubject(value.subject, subject))
          throw new AppError(
            'REVISION_CONFLICT',
            '测试对象已修改或来源已刷新，请重新载入列表。',
            409,
          );
        names.set(subjectKey(subject), value.name);
      };
      for (const subject of subjects) {
        if (subject.kind !== 'source') captureName(subject);
        else {
          const group = sourceGroups.get(subject.id) ?? [];
          group.push(subject);
          sourceGroups.set(subject.id, group);
        }
      }
      for (const [id, group] of sourceGroups) {
        const source = sources.get(id);
        for (const subject of group) captureName(subject, source);
      }
      return subjects.map((subject) => ({
        subject,
        name: z.string().parse(names.get(subjectKey(subject))),
      }));
    },
    capture(subject: TestSubject) {
      const value = inspect(subject);
      if (!sameSubject(value.subject, subject))
        throw new AppError(
          'REVISION_CONFLICT',
          '测试对象已修改或来源已刷新，请重新载入列表。',
          409,
        );
      return value;
    },
    updateSettings(input: unknown) {
      const parsed = testSettingsSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_REQUEST', '测试地址格式无效。', 400);
      const url = probeUrl(parsed.data.url).href;
      if (!testSettingsSchema.safeParse({ url }).success)
        throw new AppError('TEST_URL_INVALID', '测试地址编码后不能超过 2,048 个字符。', 400);
      db.prepare(
        "INSERT INTO settings(key,value) VALUES ('node_test_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(url);
      return { url };
    },
    save(result: TestResult) {
      return db.transaction(() => {
        if (!matches(result.subject) || ['cancelled', 'stale'].includes(result.status))
          return false;
        const subject = result.subject;
        db.prepare(
          `INSERT INTO node_test_results(key,node_id,source_id,chain_id,result_json) VALUES (?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET result_json=excluded.result_json`,
        ).run(
          subjectKey(subject) + ':' + result.core,
          subject.kind === 'node' ? subject.id : null,
          subject.kind === 'source' ? subject.id : null,
          subject.kind === 'chain' ? subject.id : null,
          JSON.stringify(testResultSchema.parse(result)),
        );
        return true;
      })();
    },
    fresh(result: TestResult, versions: Map<RenderTarget, string | null>) {
      return {
        ...result,
        stale:
          result.stale ||
          !matches(result.subject) ||
          result.url !== settings().url ||
          result.coreVersion !== versions.get(result.core),
      };
    },
    results(subjects: TestSubject[], versions: Map<RenderTarget, string | null>) {
      const results: TestResult[] = [],
        url = settings().url;
      for (const subject of subjects) {
        let current: TestSubject;
        try {
          current = currentSubject(subject);
        } catch (error) {
          if (error instanceof AppError && error.status === 404) continue;
          throw error;
        }
        const rows = z
          .array(z.object({ result_json: z.string() }))
          .parse(
            db
              .prepare('SELECT result_json FROM node_test_results WHERE key IN (?,?,?)')
              .all(
                ...['mihomo', 'singbox', 'xray'].map(
                  (target) => subjectKey(subject) + ':' + target,
                ),
              ),
          );
        for (const row of rows) {
          const result = testResultSchema.parse(JSON.parse(row.result_json));
          if (
            current.kind === 'source' &&
            (result.subject.kind !== 'source' ||
              result.subject.snapshotHash !== current.snapshotHash)
          )
            continue;
          results.push({
            ...result,
            stale:
              !sameSubject(current, result.subject) ||
              url !== result.url ||
              result.coreVersion !== versions.get(result.core),
          });
        }
      }
      return { results };
    },
  };
}
export type NodeTestStore = ReturnType<typeof createNodeTestStore>;
