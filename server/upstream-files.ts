import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AppError } from './errors.js';
import { hash, marker, type UpstreamResources } from './upstream-resources.js';
import { identityKey, type UpstreamRecord } from './sub-store.js';
import { defaultTemplates } from './templates/basic.js';
import { hy2ResolverConnectionSchema } from './shared/hy2-certificates.js';
export const SCRIPT_VERSION = 1;
export class UpstreamFiles {
  private certificateConnection?: string;
  constructor(readonly resources: UpstreamResources) {}
  configureCertificateResolver(connection: unknown) {
    this.certificateConnection = JSON.stringify(
      hy2ResolverConnectionSchema.parse(connection),
      null,
      2,
    );
  }
  get(id: string, role: string) {
    const entry = this.resources.record(id);
    if (
      entry.type !== 'file' ||
      marker(entry.record)?.role !== role ||
      marker(entry.record)?.version !== SCRIPT_VERSION
    )
      throw new AppError('FILE_INVALID', '上游文件用途或格式版本不兼容。', 409);
    return { record: entry.record, revision: hash(entry.record) };
  }
  async put(role: 'chain' | 'plan', config: { name: string }, id?: string, revision?: string) {
    const client = this.resources.client;
    if (id) {
      const old = this.get(id, role);
      if (old.revision !== revision)
        throw new AppError('REVISION_CONFLICT', '上游文件已修改，请重新载入。', 409);
      await client.api(
        '/api/file/' + encodeURIComponent(old.record.name),
        { displayName: config.name, content: JSON.stringify(config, null, 2) },
        'PATCH',
      );
    } else {
      id = randomUUID();
      await client.api('/api/files', {
        name: 'sm-' + role + '-' + id,
        displayName: config.name,
        source: 'local',
        type: 'file',
        content: JSON.stringify(config, null, 2),
        process: [],
        [identityKey]: { id, role, version: SCRIPT_VERSION },
      });
    }
    await this.resources.syncUnlocked();
    return id;
  }
  async remove(id: string, role: string, revision: string) {
    const old = this.get(id, role);
    if (old.revision !== revision)
      throw new AppError('REVISION_CONFLICT', '上游文件已修改，请重新载入。', 409);
    await this.resources.client.revoke(old.record.name);
    await this.resources.client.api(
      '/api/file/' + encodeURIComponent(old.record.name),
      undefined,
      'DELETE',
    );
  }
  private builtins() {
    const defaults: { name: string; role: string; format?: string; content: string }[] = [
      {
        name: 'sm-runtime-v1',
        role: 'runtime',
        content: readFileSync(
          new URL(
            import.meta.url.endsWith('.ts')
              ? '../dist/upstream/runtime.js'
              : '../upstream/runtime.js',
            import.meta.url,
          ),
          'utf8',
        ),
      },
      ...Object.entries(defaultTemplates()).map(([format, template]) => ({
        name: 'sm-template-' + format,
        role: 'template',
        format,
        content: JSON.stringify(template, null, 2),
      })),
    ];

    if (this.certificateConnection)
      defaults.push({
        name: 'sm-hy2-resolver-v1',
        role: 'certificate-resolver',
        content: this.certificateConnection,
      });

    return defaults;
  }
  supportFiles() {
    const defaults = this.builtins();
    return {
      files: this.resources.files().flatMap(({ id, record }) => {
        const meta = marker(record);
        if (
          meta?.role !== 'runtime' &&
          meta?.role !== 'template' &&
          meta?.role !== 'certificate-resolver'
        )
          return [];
        const seed = defaults.find((s) => s.role === meta.role && s.format === meta.format);
        if (!seed) return [];
        return [
          {
            id,
            name: (typeof record.displayName === 'string' && record.displayName) || record.name,
            role: meta.role,
            revision: hash(record),
            matchesBuiltin:
              record.content === seed.content &&
              record.source === 'local' &&
              record.type === 'file' &&
              (!Array.isArray(record.process) || !record.process.length) &&
              !['localFirst', 'remoteFirst'].includes(String(record.mergeSources)),
          },
        ];
      }),
    };
  }
  async updateSupport(id: string, revision: string) {
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      const entry = this.resources.record(id),
        meta = marker(entry.record);
      const seed = this.builtins().find((s) => s.role === meta?.role && s.format === meta?.format);
      if (entry.type !== 'file' || !seed)
        throw new AppError('FILE_INVALID', '此文件不是配套脚本或模板。', 400);
      if (hash(entry.record) !== revision)
        throw new AppError('REVISION_CONFLICT', '配套文件已被修改，请刷新后重试。', 409);
      await this.resources.client.api(
        '/api/file/' + encodeURIComponent(entry.record.name),
        {
          content: seed.content,
          type: 'file',
          source: 'local',
          url: '',
          mergeSources: null,
          process: [],
          [identityKey]: { ...meta, version: SCRIPT_VERSION },
        },
        'PATCH',
      );
      await this.resources.syncUnlocked();
      return this.supportFiles();
    });
  }
  async initialize() {
    const client = this.resources.client;
    const defaults = this.builtins();
    for (const seed of defaults) {
      const existing = this.resources
        .files(seed.role)
        .filter((f) => marker(f.record)?.format === seed.format);
      if (existing.length > 1)
        throw new AppError('FILE_DUPLICATE', '配套文件重复，请保留一份有效模板或运行脚本。', 409);
      if (existing.length) continue;
      await client.api('/api/files', {
        name: seed.name,
        displayName: seed.name,
        type: 'file',
        source: 'local',
        content: seed.content,
        process: [],
        [identityKey]: {
          id: randomUUID(),
          role: seed.role,
          version: SCRIPT_VERSION,
          ...(seed.format ? { format: seed.format } : {}),
        },
      });
      await this.resources.syncUnlocked();
    }
  }
}
export function outputScript(planId: string, format: string) {
  return [
    'try {',
    ' const files = $substore.read("files") || [];',
    ' const helpers = files.filter(f => f._submeld?.role === "runtime" && f._submeld?.version === 1);',
    ' if (helpers.length !== 1) throw new Error("Runtime missing");',
    ' const code = await produceArtifact({type: "file", name: helpers[0].name});',
    ' const generate = new Function("require", code + "; return SubMeldRuntime.generate;")(require);',
    ' const result = await generate({ read: key => $substore.read(key), ProxyUtils, artifact: produceArtifact }, ' +
      JSON.stringify(planId) +
      ', ' +
      JSON.stringify(format) +
      ', !!$options?.noCache);',
    ' $content = result.content;',
    '} catch (error) {',
    ' $options._res = { status: 422, headers: { "Content-Type": "application/json; charset=utf-8" } };',
    ' $content = JSON.stringify({error: {code: typeof error.code === "string" ? error.code : "GENERATION_FAILED", message: typeof error.code === "string" ? error.message : "上游脚本生成失败，请检查配套文件。", diagnostics: Array.isArray(error.diagnostics) ? error.diagnostics : []}});',
    '}',
  ].join('\n');
}
export function outputRecord(planId: string, format: string): UpstreamRecord {
  return {
    name: 'sm-output-' + planId + '-' + format,
    displayName: format,
    type: 'file',
    source: 'local',
    content: '',
    process: [
      { type: 'Script Operator', args: { content: outputScript(planId, format), mode: 'script' } },
    ],
    [identityKey]: {
      id: randomUUID(),
      role: 'output',
      parent: planId,
      format,
      version: SCRIPT_VERSION,
    },
  };
}
