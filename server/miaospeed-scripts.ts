import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError } from './errors.js';
import { UpstreamFiles } from './upstream-files.js';
import { hash, type UpstreamResources } from './upstream-resources.js';
import { identityKey } from './sub-store.js';
import { scriptConfigSchema, type TestScript } from './shared/miaospeed.js';
import type { BackendScript } from './miaospeed-client.js';

const ownScripts = [
  {
    builtinId: 'dns-region',
    name: 'DNS 地区',
    description: '通过节点查询 EDNS 可见的递归 DNS 地址及地区。',
    content: `function handler() {
  var response = fetch('http://edns.ip-api.com/json', {timeout: 10000, retry: 1});
  if (!response || response.statusCode !== 200) return {text: '未知：DNS 检测服务不可用', background: '142,140,142'};
  var value = safeParse(response.body), dns = value.dns;
  if (!dns || !dns.ip || !dns.geo) return {text: '未知：DNS 检测响应无效', background: '142,140,142'};
  return {text: dns.ip + ' · ' + dns.geo, background: '186,230,126'};
}`,
  },
  {
    builtinId: 'ssh22',
    name: 'SSH 22 端口',
    description: '通过节点连接 github.com:22 并检查 SSH 服务标识；不尝试登录。',
    content: `function handler() {
  var response = netcat('http://github.com:22', 'SSH-2.0-SubMeld_Probe\\r\\n', {timeout: 5000, retry: 1});
  if (response && /^SSH-2\\.0-/m.test(response.data || '')) return {text: '可达：收到 SSH 标识', background: '186,230,126'};
  return {text: '未知：未收到 SSH 标识（目标或链路可能受限）', background: '142,140,142'};
}`,
  },
].map((value) => ({
  ...value,
  enabled: true,
  source: 'SubMeld / AGPL-3.0-only',
  timeoutMs: 15000,
}));

export function bundledScripts() {
  return [
    ...z
      .array(scriptConfigSchema)
      .parse(
        JSON.parse(
          readFileSync(
            new URL(
              import.meta.url.endsWith('.ts')
                ? '../dist/diagnostics/scripts.json'
                : '../diagnostics/scripts.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      ),
    ...ownScripts,
  ];
}
export function backendScript(script: TestScript): BackendScript {
  return {
    ID: script.id,
    Type: 'media',
    TimeoutMillis: script.timeoutMs,
    Content:
      'var module = {exports: {}}; var exports = module.exports;\n' +
      script.content +
      `
var __smHandler = typeof handler === 'function' ? handler : module.exports;
this.handler = function() {
  var value = __smHandler();
  if (value && Array.isArray(value.extra)) {
    value.text = String(value.text || '') + '\\n' + value.extra.slice(0, 20).map(function(item) {
      return String(item.label || item.key || '') + ': ' + String(item.value === undefined ? '' : item.value);
    }).join(' · ');
  }
  return value;
};`,
  };
}
export class MiaospeedScripts {
  constructor(private resources: UpstreamResources) {}
  list() {
    const seeds = bundledScripts();
    return {
      scripts: this.resources.files('test-script').map(({ id, record }) => {
        const value = scriptConfigSchema.safeParse(JSON.parse(String(record.content)));
        if (!value.success)
          throw new AppError(
            'TEST_SCRIPT_INVALID',
            '检测脚本文件格式无效，请在 Sub-Store 中修正。',
            409,
          );
        const seed = seeds.find((seed) => seed.builtinId === value.data.builtinId);
        return {
          ...value.data,
          id,
          revision: hash(record),
          modified: !seed || !isDeepStrictEqual(scriptConfigSchema.parse(seed), value.data),
        } satisfies TestScript;
      }),
    };
  }
  async initialize() {
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      const current = this.list().scripts;
      for (const seed of bundledScripts()) {
        if (current.some((script) => script.builtinId === seed.builtinId)) continue;
        const id = randomUUID();
        await this.resources.client.api('/api/files', {
          name: 'sm-test-script-' + id,
          displayName: seed.name,
          type: 'file',
          source: 'local',
          process: [],
          content: JSON.stringify(seed),
          [identityKey]: { id, role: 'test-script', version: 1 },
        });
      }
      await this.resources.syncUnlocked();
      return this.list();
    });
  }
  async put(input: unknown, id?: string, restore = false) {
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      const request = scriptConfigSchema.extend({ revision: z.string().optional() }).parse(input);
      const { revision, ...config } = request;
      const old = id ? this.list().scripts.find((value) => value.id === id) : undefined;
      if (id && !old) throw new AppError('NOT_FOUND', '检测脚本已不存在。', 404);
      if (old && revision !== old.revision)
        throw new AppError('REVISION_CONFLICT', '检测脚本已修改，请重新载入。', 409);
      const data = restore
        ? bundledScripts().find((seed) => seed.builtinId === old?.builtinId)
        : config;
      if (!data) throw new AppError('INVALID_REQUEST', '此脚本没有内置版本。', 400);
      if (old) {
        const entry = this.resources.record(old.id);
        await this.resources.client.api(
          '/api/file/' + encodeURIComponent(entry.record.name),
          { content: JSON.stringify(data), displayName: data.name },
          'PATCH',
        );
      } else {
        const uuid = randomUUID();
        await this.resources.client.api('/api/files', {
          name: 'sm-test-script-' + uuid,
          displayName: data.name,
          source: 'local',
          type: 'file',
          content: JSON.stringify({ ...data, builtinId: undefined }),
          process: [],
          [identityKey]: { id: uuid, role: 'test-script', version: 1 },
        });
      }
      await this.resources.syncUnlocked();
      return this.list();
    });
  }
  async remove(id: string, revision: string) {
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      await new UpstreamFiles(this.resources).remove(id, 'test-script', revision);
      await this.resources.syncUnlocked();
      return this.list();
    });
  }
  selected(refs: { id: string; revision: string }[]) {
    const catalog = this.list().scripts;
    return refs.map((ref) => {
      const script = catalog.find((script) => script.id === ref.id);
      if (!script || !script.enabled || script.revision !== ref.revision)
        throw new AppError('REVISION_CONFLICT', '所选检测脚本已变化或停用，请重新选择。', 409);
      return script;
    });
  }
}
