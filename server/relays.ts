import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { MachineStore } from './machines.js';
import { AppError } from './errors.js';
import { readJson } from './input.js';
import { identityKey } from './sub-store.js';
import { hash, marker, type Entry, type UpstreamResources } from './upstream-resources.js';
import { tunnelCertificate } from './machine-assets.js';
import { relayRouteSchema, machineOperationSchema } from './shared/machines.js';
import { revisionSchema } from './shared/resources.js';

const createSchema = relayRouteSchema
  .omit({
    id: true,
    revision: true,
    status: true,
    message: true,
    taskIds: true,
    health: true,
    outputResourceId: true,
  })
  .strict();
const updateSchema = createSchema.extend({ revision: revisionSchema });
type Operation = z.infer<typeof machineOperationSchema>;
const stepSchema = z.object({
  machineId: z.string().uuid(),
  requestId: z.string().uuid(),
  expectedRevision: revisionSchema,
  operation: machineOperationSchema,
  reportedTunnelRevision: revisionSchema.nullable().optional(),
});
const hopSchema = z.object({
  machineId: z.string().uuid(),
  address: z.string(),
  port: z.number(),
  id: z.string().uuid(),
  username: z.string(),
  password: z.string(),
  serverName: z.string(),
  certificatePEM: z.string(),
  privateKeyPEM: z.string(),
  appliedRevision: z.string().default(''),
});
const deploymentSchema = z.object({
  schemaVersion: z.literal(1),
  route: relayRouteSchema.omit({ revision: true }),
  sourceId: z.string().uuid(),
  stage: z.number().int().nonnegative(),
  deleting: z.boolean(),
  targetRevision: revisionSchema,
  targetUri: z.string(),
  targetHost: z.string(),
  targetListen: z.string().default('0.0.0.0'),
  targetPort: z.number(),
  targetProfile: z.string(),
  targetCore: z.enum(['sing-box', 'xray']),
  targetSpki: z.string().optional(),
  exitId: z.string().optional(),
  bindingId: z.string().optional(),
  forwardId: z.string().optional(),
  hops: z.array(hopSchema),
  entryTunnelRevision: z.string().default(''),
  sourceNodeName: z.string().optional(),
  step: stepSchema.optional(),
});
const retiredTunnelSchema = z.object({
  machineId: z.string().uuid(),
  id: z.string().uuid(),
  revision: z.string(),
});
const savedSchema = deploymentSchema.extend({
  migration: z
    .object({
      previous: deploymentSchema,
      phase: z.enum(['cleanup', 'deploy', 'retire']),
      retire: z.array(retiredTunnelSchema).max(9),
      retireIndex: z.number().int().nonnegative().default(0),
    })
    .optional(),
});
type Saved = z.infer<typeof savedSchema>;
type Deployment = z.infer<typeof deploymentSchema>;
const active = (task: ReturnType<MachineStore['task']>, machines: MachineStore) =>
  ['queued', 'running'].includes(task.status) ||
  (task.status === 'unknown' && machines.activeTask(task.machineId)?.id === task.id);
const textField = (obj: Record<string, unknown>, key: string) =>
  typeof obj[key] === 'string' ? obj[key] : '';

function readRelay(entry: Entry): { saved: Saved; revision: string } {
  if (entry.type !== 'file' || marker(entry.record)?.role !== 'relay-route')
    throw new AppError('NOT_FOUND', '中转线路不存在。', 404);
  try {
    return {
      saved: savedSchema.parse(JSON.parse(String(entry.record.content))),
      revision: hash(entry.record),
    };
  } catch {
    throw new AppError('RELAY_INVALID', '中转线路配置无法读取。', 422);
  }
}

/** Called with a fresh catalog while the caller holds the Sub-Store lock. */
export function machineRelayReferences(resources: UpstreamResources, machineId: string) {
  return resources.files('relay-route').flatMap(({ id }) => {
    const { saved, revision } = readRelay(resources.record(id));
    if (saved.route.status === 'deleted') return [];
    const deployments = [saved, ...(saved.migration ? [saved.migration.previous] : [])];
    const referenced =
      deployments.some((deployment) =>
        [
          deployment.route.entryMachineId,
          deployment.route.targetMachineId,
          ...deployment.route.hops.map((hop) => hop.machineId),
          ...deployment.hops.map((hop) => hop.machineId),
          deployment.step?.machineId,
        ].includes(machineId),
      ) || saved.migration?.retire.some((item) => item.machineId === machineId);
    return referenced ? [{ kind: 'relay' as const, id, name: saved.route.name, revision }] : [];
  });
}

export function relayEndpoint(uri: string, host: string, port: number, name: string): string {
  // Native vpsctl exports SIP002 and standard URI protocols. Preserve all identity fields.
  const url = new URL(uri);
  if (url.protocol === 'ss:' && !uri.split('#')[0]!.includes('@')) {
    const data = Buffer.from(url.hostname, 'base64').toString('utf8');
    const at = data.lastIndexOf('@');
    if (at < 1) throw new AppError('RELAY_URI_INVALID', '无法保留此节点的连接身份。', 422);
    return (
      'ss://' +
      Buffer.from(
        data.slice(0, at + 1) + (host.includes(':') ? '[' + host + ']' : host) + ':' + port,
      ).toString('base64') +
      '#' +
      encodeURIComponent(name)
    );
  }
  url.hostname = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
  url.port = String(port);
  if (url.protocol === 'hy2:' || url.protocol === 'hysteria2:') url.searchParams.delete('mport');
  url.hash = encodeURIComponent(name);
  return url.toString();
}

export class RelayStore {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(
    private machines: MachineStore,
    private resources: UpstreamResources,
  ) {
    machines.beforeEnqueue = (id, input, requestId) => this.assertOperation(id, input, requestId);
    machines.coordinateDeletion = (operation) => this.exclusive(operation);
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 2000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
  }
  private async assertOperation(machineId: string, input: Operation, requestId?: string) {
    await this.resources.sync();
    for (const { id } of this.resources.files('relay-route')) {
      const { saved } = this.read(id);
      if (saved.route.status === 'deleted' || (requestId && saved.step?.requestId === requestId))
        continue;
      for (const deployment of [saved, ...(saved.migration ? [saved.migration.previous] : [])]) {
        const r = deployment.route;
        const target = r.targetMachineId === machineId && input.params.id === r.targetNodeId;
        const entry = r.entryMachineId === machineId && input.params.id === r.entryNodeId;
        if (input.action === 'node.delete' && (target || entry))
          throw new AppError('RELAY_REFERENCED', '节点仍被中转线路引用，请先删除线路。', 409);
        if (
          input.action === 'core.uninstall' &&
          input.params.purge === true &&
          [
            r.entryMachineId,
            r.targetMachineId,
            ...deployment.hops.map((hop) => hop.machineId),
          ].includes(machineId)
        )
          throw new AppError(
            'RELAY_REFERENCED',
            '机器仍有中转线路，请先处理线路后彻底清除内核配置。',
            409,
          );
        if (
          ['tunnel.apply', 'tunnel.delete'].includes(input.action) &&
          ((machineId === r.entryMachineId && input.params.id === r.id) ||
            deployment.hops.some(
              (hop) => hop.machineId === machineId && hop.id === input.params.id,
            ))
        )
          throw new AppError('RELAY_REFERENCED', '该隧道仍由中转线路管理，请从中转页面操作。', 409);
        if (r.entryMachineId !== machineId) continue;
        const ids = [deployment.exitId, deployment.forwardId, deployment.bindingId].filter(Boolean);
        if (
          ['exit.edit', 'exit.delete', 'forward.edit', 'forward.delete', 'binding.delete'].includes(
            input.action,
          ) &&
          ids.includes(String(input.params.id))
        )
          throw new AppError(
            'RELAY_REFERENCED',
            '该资源由集中中转线路管理，请从中转页面操作。',
            409,
          );
      }
    }
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.pending.then(fn, fn);
    this.pending = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private read(id: string): { saved: Saved; revision: string } {
    return readRelay(this.resources.record(id));
  }
  private async save(saved: Saved, expected?: string) {
    return this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      const item = this.resources.files('relay-route').find((f) => f.id === saved.route.id);
      if (item) {
        if (expected && hash(item.record) !== expected)
          throw new AppError('REVISION_CONFLICT', '线路已修改，请刷新。', 409);
        await this.resources.client.api(
          '/api/file/' + encodeURIComponent(item.record.name),
          { content: JSON.stringify(saved), displayName: saved.route.name },
          'PATCH',
        );
      } else {
        if (expected) throw new AppError('NOT_FOUND', '线路已删除。', 404);
        await this.resources.client.api('/api/files', {
          name: 'sm-relay-' + saved.route.id,
          displayName: saved.route.name,
          source: 'local',
          type: 'file',
          content: JSON.stringify(saved),
          process: [],
          [identityKey]: { id: saved.route.id, role: 'relay-route', version: 1 },
        });
      }
      await this.resources.syncUnlocked();
      return hash(this.resources.record(saved.route.id).record);
    });
  }
  async list() {
    await this.resources.sync();
    const entries = this.resources.files('relay-route').map(({ id }) => this.read(id));
    return {
      routes: await Promise.all(
        entries.map(async ({ saved, revision }) => ({
          ...saved.route,
          revision,
          outputResourceId:
            saved.route.kind === 'tunnel'
              ? saved.sourceId
              : this.machines.list().find((machine) => machine.id === saved.route.entryMachineId)
                  ?.resourceId,
          ...(await this.health(saved)),
        })),
      ),
    };
  }
  private async health(
    saved: Saved,
  ): Promise<{ health: 'unknown' | 'online' | 'offline' | 'degraded'; message: string }> {
    const { route: r } = saved;
    if (r.status !== 'active') return { health: 'unknown', message: r.message };
    const machines = this.machines.list(),
      involved = [r.entryMachineId, r.targetMachineId, ...saved.hops.map((h) => h.machineId)];
    if (involved.some((id) => !machines.find((m) => m.id === id)?.online))
      return {
        health: 'offline',
        message: '配置已应用，但部分 Agent 离线，当前运行状态无法确认。',
      };
    if (r.kind === 'tunnel') {
      const expected = [{ machineId: r.entryMachineId, id: r.id }, ...saved.hops];
      const states = await Promise.all(
        expected.map(async (item) =>
          (await this.machines.getTunnelReports(item.machineId)).find(
            (report) => report.id === item.id,
          ),
        ),
      );
      if (states.some((state) => !state?.running))
        return { health: 'degraded', message: '配置已应用，但隧道进程未全部运行。' };
    }
    const target = await this.snapshot(r.targetMachineId);
    if (!target.cores.some((core) => core.core === saved.targetCore && core.running))
      return { health: 'degraded', message: '配置已应用，但目标内核未运行。' };
    if (r.kind !== 'tunnel') {
      const entry = await this.snapshot(r.entryMachineId);
      const found =
        r.kind === 'forward'
          ? entry.relay.forwards.some((f) => f.id === saved.forwardId)
          : entry.relay.bindings.some((b) => b.id === saved.bindingId);
      if (!found)
        return { health: 'degraded', message: '机器中的线路规则已变化，请重新核对或应用。' };
      if (r.kind === 'protocol') {
        const node = entry.nodes.find((n) => n.id === r.entryNodeId);
        if (!node || !entry.cores.some((core) => core.core === node.core && core.running))
          return { health: 'degraded', message: '入口代理内核未运行。' };
      }
    }
    return {
      health: 'online',
      message: 'Agent 与已知运行状态正常；端到端连通性请在测试中心验证。',
    };
  }
  private async snapshot(id: string) {
    const snap = await this.machines.getPrivateSnapshot(id);
    if (!snap) throw new AppError('MACHINE_NOT_READY', '请等待机器完成首次上报。', 409);
    return snap;
  }
  private async prepare(input: unknown, id: string, previous?: Deployment): Promise<Saved> {
    const route = createSchema.parse(input);
    if (route.kind !== 'tunnel' && route.hops.length)
      throw new AppError('TUNNEL_HOPS', '跳路径仅适用于 TLS 隧道线路。', 400);
    const [entry, target] = await Promise.all([
      this.snapshot(route.entryMachineId),
      this.snapshot(route.targetMachineId),
    ]);
    const node = target.nodes.find((n) => n.id === route.targetNodeId);
    const exported = target.exports.find((e) => e.id === route.targetNodeId && e.kind === 'node');
    if (!node || !exported || target.pendingCores.includes(node.core))
      throw new AppError('TARGET_NOT_APPLIED', '目标节点不存在或仍在等待应用。', 409);
    if (
      route.entryMachineId === route.targetMachineId &&
      (route.kind !== 'protocol' || route.entryNodeId === route.targetNodeId)
    )
      throw new AppError('RELAY_LOOP', '入口和目标不能构成同机转发回环。', 400);
    if (route.kind === 'protocol' && !entry.nodes.some((n) => n.id === route.entryNodeId))
      throw new AppError('ENTRY_REQUIRED', '请选择入口代理节点。', 400);
    await this.resources.sync();
    const routes = this.resources
      .files('relay-route')
      .flatMap(({ id: key }) => {
        const { saved } = this.read(key);
        return [saved.route, ...(saved.migration ? [saved.migration.previous.route] : [])];
      })
      .filter((r) => r.status !== 'deleted' && r.id !== id);
    if (route.kind === 'protocol') {
      const key = (m: string, n: string) => m + '/' + n;
      if (
        routes.some(
          (r) =>
            r.kind === 'protocol' &&
            r.entryMachineId === route.entryMachineId &&
            r.entryNodeId === route.entryNodeId,
        )
      )
        throw new AppError('ENTRY_BOUND', '该入口已由另一条线路管理。', 409);
      const entryKey = key(route.entryMachineId, route.entryNodeId!);
      const pending = [key(route.targetMachineId, route.targetNodeId)],
        visited = new Set<string>();
      while (pending.length) {
        const cursor = pending.pop()!;
        if (cursor === entryKey) throw new AppError('RELAY_LOOP', '中转线路形成循环。', 409);
        if (visited.has(cursor)) continue;
        visited.add(cursor);
        pending.push(
          ...routes
            .filter(
              (r) => r.kind === 'protocol' && key(r.entryMachineId, r.entryNodeId ?? '') === cursor,
            )
            .map((r) => key(r.targetMachineId, r.targetNodeId)),
        );
      }
    }
    const host = typeof node.address === 'string' ? node.address : '';
    const port = typeof node.port === 'number' ? node.port : Number(node.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new AppError('TARGET_ENDPOINT', '目标节点缺少有效的发布地址与端口。', 422);
    const hops: Saved['hops'] = [];
    if (route.kind === 'tunnel') {
      if (
        !route.hops.length ||
        new Set([route.entryMachineId, ...route.hops.map((h) => h.machineId)]).size !==
          route.hops.length + 1
      )
        throw new AppError('TUNNEL_HOPS', '请选择不重复且不含入口机器的隧道节点。', 400);
      for (const hop of route.hops) {
        await this.snapshot(hop.machineId);
        const retained =
          previous?.route.kind === 'tunnel' &&
          previous.hops.find((item) => item.machineId === hop.machineId);
        if (retained) {
          hops.push({ ...retained, ...hop });
          continue;
        }
        const hopId = randomUUID(),
          serverName = hopId + '.submeld.internal';
        hops.push({
          ...hop,
          id: hopId,
          serverName,
          username: randomBytes(16).toString('hex'),
          password: randomBytes(32).toString('base64url'),
          ...(await tunnelCertificate(serverName)),
          appliedRevision: '',
        });
      }
    }
    const saved: Saved = {
      schemaVersion: 1,
      route: {
        ...route,
        id,
        status: 'pending',
        message: '等待部署。',
        taskIds: previous?.route.taskIds ?? [],
        health: 'unknown',
      },
      sourceId: previous?.sourceId ?? randomUUID(),
      stage: 0,
      deleting: false,
      targetRevision: target.revision,
      targetUri: exported.uri,
      targetHost: host,
      targetListen: typeof node.listen === 'string' ? node.listen : '0.0.0.0',
      targetPort: port,
      targetProfile: node.profile,
      targetCore: node.core,
      ...(typeof exported.tlsSpkiSha256 === 'string' ? { targetSpki: exported.tlsSpkiSha256 } : {}),
      hops,
      entryTunnelRevision:
        previous?.route.entryMachineId === route.entryMachineId ? previous.entryTunnelRevision : '',
      ...(previous?.sourceNodeName ? { sourceNodeName: previous.sourceNodeName } : {}),
    };
    return saved;
  }
  async create(input: unknown) {
    return this.exclusive(async () => {
      const id = randomUUID(),
        saved = await this.prepare(input, id);
      await this.save(saved);
      return { route: { ...saved.route, revision: this.read(id).revision } };
    });
  }
  private taskFor(saved: Saved) {
    if (!saved.step) return undefined;
    try {
      return this.machines.task(saved.step.requestId);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'MACHINE_TASK_NOT_FOUND') throw error;
      return undefined;
    }
  }
  async update(id: string, input: unknown) {
    const { revision, ...value } = updateSchema.parse(input);
    return this.exclusive(async () => {
      await this.resources.sync();
      const { saved: previous, revision: current } = this.read(id);
      if (revision !== current)
        throw new AppError('REVISION_CONFLICT', '线路已更新，请刷新。', 409);
      if (previous.migration)
        throw new AppError(
          'RELAY_UPDATE_PENDING',
          '上次更新尚未完成，请先重试应用并完成旧资源清理。',
          409,
        );
      if (previous.deleting || previous.route.status === 'deleted')
        throw new AppError('RELAY_DELETING', '线路正在删除或已删除。', 409);
      const task = this.taskFor(previous);
      if (
        ['pending', 'applying'].includes(previous.route.status) ||
        (task && active(task, this.machines))
      )
        throw new AppError('MACHINE_BUSY', '线路操作仍在进行，请完成后再编辑。', 409);
      if (task?.status === 'unknown')
        throw new AppError(
          'RELAY_RESULT_UNKNOWN',
          '上次执行结果未知，请先核对机器状态并重试应用。',
          409,
        );
      if (
        previous.route.kind === 'protocol' &&
        value.kind === 'protocol' &&
        value.entryMachineId === previous.route.entryMachineId &&
        value.entryNodeId === previous.route.entryNodeId &&
        ['listenPort', 'address', 'network', 'family'].some(
          (key) => value[key as keyof typeof value] !== previous.route[key as keyof typeof value],
        )
      )
        throw new AppError(
          'ENTRY_CONFIGURATION',
          '协议线路沿用入口节点的监听配置；请在节点编辑中修改端口、地址或网络。',
          422,
        );
      if (previous.route.kind !== 'tunnel') await this.nativeRecords(previous);
      if (previous.route.kind === 'tunnel') {
        const source = this.resources.listResources().find((item) => item.id === previous.sourceId);
        if (source) {
          const entry = this.resources.record(source.id);
          const preview = await this.resources.client.preview('sub', {
            ...entry.record,
            process: [],
          });
          if (preview.original.length !== 1 || typeof preview.original[0]?.name !== 'string')
            throw new AppError(
              'RELAY_SOURCE_CONFLICT',
              '线路来源不能唯一定位已发布名称，未更新。',
              409,
            );
          previous.sourceNodeName = preview.original[0].name;
        }
      }
      if (
        Object.keys(createSchema.shape)
          .filter((key) => key !== 'name')
          .every(
            (key) =>
              JSON.stringify(value[key as keyof typeof value]) ===
              JSON.stringify(previous.route[key as keyof typeof value]),
          )
      ) {
        previous.route.name = value.name;
        const next = await this.save(previous, current);
        return { route: { ...previous.route, revision: next } };
      }
      const saved = await this.prepare(value, id, previous);
      const compatible =
        previous.route.kind === value.kind &&
        previous.route.entryMachineId === value.entryMachineId &&
        (value.kind !== 'protocol' || previous.route.entryNodeId === value.entryNodeId);
      if (compatible && value.kind !== 'tunnel') {
        saved.exitId = previous.exitId;
        saved.forwardId = previous.forwardId;
        saved.bindingId = previous.bindingId;
      }
      const retired =
        compatible && value.kind === 'tunnel'
          ? [...previous.hops]
              .reverse()
              .filter((hop) => !saved.hops.some((item) => item.id === hop.id))
              .map((hop) => ({
                machineId: hop.machineId,
                id: hop.id,
                revision: hop.appliedRevision,
              }))
          : [];
      previous.stage = 0;
      previous.deleting = !compatible;
      delete previous.step;
      saved.migration = {
        previous: deploymentSchema.parse(previous),
        phase: compatible ? 'deploy' : 'cleanup',
        retire: retired,
        retireIndex: 0,
      };
      saved.route.message = compatible
        ? '更新已保存，等待应用；完成前保留旧目标与资源引用。'
        : '更新已保存，将清理旧入口资源后部署新配置，期间连接会中断。';
      const next = await this.save(saved, current);
      await this.invalidateSource(saved);
      return { route: { ...saved.route, revision: next } };
    });
  }
  async apply(id: string, revision: string) {
    return this.exclusive(async () => {
      await this.resources.sync();
      const { saved, revision: current } = this.read(id);
      if (current !== revision)
        throw new AppError('REVISION_CONFLICT', '线路已更新，请刷新。', 409);
      if (saved.deleting || saved.route.status === 'deleted')
        throw new AppError('RELAY_DELETING', '线路正在删除或已经删除。', 409);
      await this.reconcileStep(saved);
      if (saved.migration?.phase === 'retire') {
        saved.route.status = 'pending';
        saved.route.message = '继续清理旧隧道跳，保留已应用的新入口。';
        const next = await this.save(saved, current);
        return { route: { ...saved.route, revision: next } };
      }
      const target = await this.snapshot(saved.route.targetMachineId);
      const node = target.nodes.find((n) => n.id === saved.route.targetNodeId),
        exp = target.exports.find((e) => e.id === saved.route.targetNodeId);
      if (!node || !exp || target.pendingCores.includes(node.core))
        throw new AppError('TARGET_NOT_APPLIED', '目标节点不可用或仍待应用。', 409);
      const targetChanged = saved.targetRevision !== target.revision;
      saved.targetRevision = target.revision;
      saved.targetUri = exp.uri;
      saved.targetHost = String(node.address);
      saved.targetListen = typeof node.listen === 'string' ? node.listen : '0.0.0.0';
      saved.targetPort = Number(node.port);
      saved.targetCore = node.core;
      saved.targetProfile = node.profile;
      saved.targetSpki = typeof exp.tlsSpkiSha256 === 'string' ? exp.tlsSpkiSha256 : undefined;
      if (!saved.migration || targetChanged) {
        saved.stage = 0;
        if (!saved.migration || saved.migration.phase === 'deploy') delete saved.step;
      }
      saved.route.status = 'pending';
      saved.route.message = saved.migration
        ? '继续上次更新，已确认的清理进度会保留。'
        : '等待重新应用。';
      const next = await this.save(saved, current);
      return { route: { ...saved.route, revision: next } };
    });
  }
  async remove(id: string, revision: string) {
    return this.exclusive(async () => {
      await this.resources.sync();
      const { saved, revision: current } = this.read(id);
      if (revision !== current)
        throw new AppError('REVISION_CONFLICT', '线路已更新，请刷新。', 409);
      if (saved.migration)
        throw new AppError(
          'RELAY_UPDATE_PENDING',
          '线路更新尚未完成，请先重试应用并完成旧资源清理。',
          409,
        );
      if (saved.step && this.taskFor(saved)?.status === 'queued') {
        try {
          await this.machines.cancel(saved.step.machineId, saved.step.requestId);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'MACHINE_TASK_RUNNING') throw error;
        }
      }
      await this.reconcileStep(saved);
      saved.deleting = true;
      saved.stage = 0;
      delete saved.step;
      saved.route.status = 'deleting';
      saved.route.message = '等待删除线路资源。';
      const next = await this.save(saved, current);
      return { route: { ...saved.route, revision: next } };
    });
  }
  private async nativeRecords(saved: Deployment) {
    const r = saved.route,
      snapshot = await this.snapshot(r.entryMachineId),
      name = 'sm-route-' + r.id;
    const exit = snapshot.relay.exits.find((e) =>
        saved.exitId ? e.id === saved.exitId : e.name === name,
      ),
      forward = snapshot.relay.forwards.find((f) =>
        saved.forwardId ? f.id === saved.forwardId : f.name === name,
      );
    if (exit) saved.exitId = textField(exit, 'id');
    if (forward) saved.forwardId = textField(forward, 'id');
    const binding = snapshot.relay.bindings.find((b) =>
      saved.bindingId
        ? b.id === saved.bindingId
        : b.node_id === r.entryNodeId && b.exit_id === saved.exitId,
    );
    if (binding) saved.bindingId = textField(binding, 'id');
    return { snapshot, name, exit, forward, binding };
  }
  private stepOwner(saved: Saved): Deployment {
    return saved.migration?.phase === 'cleanup' ? saved.migration.previous : saved;
  }
  private advanceStep(saved: Saved) {
    const step = saved.step;
    if (!step) return;
    if (saved.migration?.phase === 'retire') saved.migration.retireIndex++;
    else {
      const owner = this.stepOwner(saved);
      if (step.operation.action === 'tunnel.apply') {
        const params = step.operation.params;
        if (params.id === owner.route.id) owner.entryTunnelRevision = String(params.revision);
        else {
          const hop = owner.hops.find((item) => item.id === params.id);
          if (hop) hop.appliedRevision = String(params.revision);
        }
      }
      owner.stage++;
    }
    delete saved.step;
  }
  private async acceptOwnTargetRevision(saved: Saved, task: ReturnType<MachineStore['task']>) {
    if (
      task.machineId !== saved.route.targetMachineId ||
      task.expectedRevision !== saved.targetRevision
    )
      return;
    const snapshot = await this.snapshot(task.machineId);
    if (snapshot.revision !== task.resultRevision) return;
    const node = snapshot.nodes.find((item) => item.id === saved.route.targetNodeId),
      exported = snapshot.exports.find(
        (item) => item.id === saved.route.targetNodeId && item.kind === 'node',
      );
    if (
      node &&
      exported &&
      !snapshot.pendingCores.includes(node.core) &&
      exported.uri === saved.targetUri &&
      node.address === saved.targetHost &&
      Number(node.port) === saved.targetPort &&
      (typeof node.listen === 'string' ? node.listen : '0.0.0.0') === saved.targetListen &&
      node.core === saved.targetCore &&
      node.profile === saved.targetProfile &&
      exported.tlsSpkiSha256 === saved.targetSpki
    )
      saved.targetRevision = snapshot.revision;
  }
  private async reconcileStep(saved: Saved) {
    const task = this.taskFor(saved),
      step = saved.step;
    if (!step || !task) return;
    if (active(task, this.machines)) throw new AppError('MACHINE_BUSY', '线路操作仍未结束。', 409);
    if (task.status === 'applied') {
      await this.acceptOwnTargetRevision(saved, task);
      this.advanceStep(saved);
      return;
    }
    if (task.status === 'unknown') {
      const { action, params } = step.operation;
      let observed: boolean;
      if (action.startsWith('tunnel.')) {
        const report = (await this.machines.getTunnelReports(step.machineId)).find(
          (item) => item.id === params.id,
        );
        const completed =
          action === 'tunnel.apply'
            ? report?.revision === params.revision
            : !report && !!step.reportedTunnelRevision;
        if (completed) {
          this.advanceStep(saved);
          return;
        }
        observed = !!report;
      } else {
        const records = await this.nativeRecords(this.stepOwner(saved));
        const native = action.startsWith('exit.')
          ? records.exit
          : action.startsWith('forward.')
            ? records.forward
            : records.binding;
        observed = !!native;
        if (!native && action.endsWith('.delete')) {
          this.advanceStep(saved);
          return;
        }
      }
      if (!observed)
        throw new AppError(
          'RELAY_RESULT_UNKNOWN',
          '执行结果未知且当前状态不能确认原资源；请核对机器状态后重新上报，未重放操作。',
          409,
        );
    }
    // A terminal receipt is retried only after resolving native IDs against the
    // current snapshot; unconfirmed requests keep their original request ID.
    delete saved.step;
  }
  private async nextStep(
    saved: Saved,
  ): Promise<{ machineId: string; operation: Operation } | null> {
    const migration = saved.migration;
    if (migration?.phase === 'cleanup') {
      const previous = migration.previous;
      const next =
        previous.route.kind === 'tunnel'
          ? await this.tunnelStep(previous)
          : await this.nativeStep(previous);
      if (next) return next;
      if (previous.route.kind === 'tunnel' && saved.route.kind !== 'tunnel')
        await this.publishTunnel(previous, true);
      migration.phase = 'deploy';
      saved.stage = 0;
    }
    if (migration?.phase !== 'retire') {
      if (
        !saved.deleting &&
        (await this.snapshot(saved.route.targetMachineId)).revision !== saved.targetRevision
      )
        throw new AppError('TARGET_CHANGED', '目标配置已变化，线路未继续应用。', 409);
      const next =
        saved.route.kind === 'tunnel' ? await this.tunnelStep(saved) : await this.nativeStep(saved);
      if (next) return next;
      if (!migration?.retire.length) return null;
      if (saved.route.kind === 'tunnel') await this.publishTunnel(saved);
      migration.phase = 'retire';
    }
    const retired = migration?.retire[migration.retireIndex];
    if (!retired) return null;
    const report = (await this.machines.getTunnelReports(retired.machineId)).find(
      (item) => item.id === retired.id,
    );
    if (!report && !retired.revision) {
      migration!.retireIndex++;
      return this.nextStep(saved);
    }
    return {
      machineId: retired.machineId,
      operation: {
        action: 'tunnel.delete',
        params: {
          id: retired.id,
          'expected-tunnel-revision': report?.revision ?? retired.revision,
        },
      },
    };
  }
  private async nativeStep(
    saved: Deployment,
  ): Promise<{ machineId: string; operation: Operation } | null> {
    const r = saved.route,
      { snapshot, name, exit, forward, binding } = await this.nativeRecords(saved);
    const task = (action: Operation['action'], params: Operation['params']) => ({
      machineId: r.entryMachineId,
      operation: { action, params: { ...params, 'install-deps': true } },
    });
    if (saved.deleting) {
      if (forward) return task('forward.delete', { id: saved.forwardId!, 'confirm-delete': true });
      if (binding) return task('binding.delete', { id: saved.bindingId!, 'confirm-delete': true });
      if (exit) return task('exit.delete', { id: saved.exitId! });
      return null;
    }
    const entryNode = snapshot.nodes.find((n) => n.id === r.entryNodeId);
    const core = r.kind === 'protocol' ? entryNode?.core : saved.targetCore;
    if (!core) throw new AppError('ENTRY_REQUIRED', '入口节点已不存在。', 409);
    if (
      r.kind === 'protocol' &&
      snapshot.relay.bindings.some((b) => b.node_id === r.entryNodeId && b.exit_id !== saved.exitId)
    )
      throw new AppError('ENTRY_BOUND', '入口已绑定其他出口，请先处理现有绑定。', 409);
    if (!exit || saved.stage === 0) {
      const params: Operation['params'] = {
        name: exit ? textField(exit, 'name') || name : name,
        uri: saved.targetUri,
        core,
        profile: saved.targetProfile,
      };
      if (core === 'sing-box' && saved.targetSpki) params['tls-spki-sha256'] = saved.targetSpki;
      if (exit) params.id = saved.exitId!;
      else delete saved.exitId;
      return task(exit ? 'exit.edit' : 'exit.add', params);
    }
    if (r.kind === 'forward' && (!forward || saved.stage === 1)) {
      if (!forward) delete saved.forwardId;
      return task(forward ? 'forward.edit' : 'forward.add', {
        ...(forward ? { id: saved.forwardId! } : {}),
        name: forward ? textField(forward, 'name') || name : name,
        'exit-id': saved.exitId!,
        'listen-ports': String(r.listenPort),
        network: r.network,
        family: r.family,
        address: r.address,
      });
    }
    if (r.kind === 'protocol' && !binding)
      return task('binding.add', { 'node-id': r.entryNodeId!, 'exit-id': saved.exitId! });
    return null;
  }
  private async tunnelStep(
    saved: Deployment,
  ): Promise<{ machineId: string; operation: Operation } | null> {
    const r = saved.route;
    if (saved.deleting) {
      const resources = [
        { machineId: r.entryMachineId, id: r.id, revision: saved.entryTunnelRevision },
        ...[...saved.hops]
          .reverse()
          .map((h) => ({ machineId: h.machineId, id: h.id, revision: h.appliedRevision })),
      ];
      const current = resources[saved.stage];
      if (!current) return null;
      const reports = await this.machines.getTunnelReports(current.machineId);
      const existing = reports.find((t) => t.id === current.id);
      if (!existing && !current.revision) {
        saved.stage++;
        return this.tunnelStep(saved);
      }
      return {
        machineId: current.machineId,
        operation: {
          action: 'tunnel.delete',
          params: {
            id: current.id,
            'expected-tunnel-revision': existing?.revision ?? current.revision,
          },
        },
      };
    }
    const hop = saved.hops[saved.stage];
    let config: unknown, machineId: string, id: string, role: string;
    if (hop) {
      config = {
        listenHost: '::',
        listenPort: hop.port,
        username: hop.username,
        password: hop.password,
        certificatePEM: hop.certificatePEM,
        privateKeyPEM: hop.privateKeyPEM,
      };
      machineId = hop.machineId;
      id = hop.id;
      role = 'hop';
    } else if (saved.stage === saved.hops.length) {
      const last = saved.hops.at(-1)!;
      config = {
        listenHost: r.family === 'ipv4' ? '0.0.0.0' : '::',
        listenPort: r.listenPort,
        network: r.network,
        targetHost:
          last.machineId === r.targetMachineId
            ? saved.targetListen === '::'
              ? '::1'
              : saved.targetListen === '0.0.0.0'
                ? '127.0.0.1'
                : saved.targetListen
            : saved.targetHost,
        targetPort: saved.targetPort,
        hops: saved.hops.map((h) => ({
          address: h.address,
          port: h.port,
          username: h.username,
          password: h.password,
          certificatePEM: h.certificatePEM,
          serverName: h.serverName,
        })),
      };
      machineId = r.entryMachineId;
      id = r.id;
      role = 'entry';
    } else return null;
    const json = JSON.stringify(config),
      revision = createHash('sha256').update(json).digest('hex');
    const reports = await this.machines.getTunnelReports(machineId),
      previous = reports.find((t) => t.id === id);
    return {
      machineId,
      operation: {
        action: 'tunnel.apply',
        params: {
          id,
          role,
          config: json,
          revision,
          'expected-tunnel-revision': previous?.revision ?? '',
        },
      },
    };
  }
  private async publishTunnel(saved: Deployment, remove = false) {
    const content = remove
      ? ''
      : relayEndpoint(
          saved.targetUri,
          saved.route.address,
          saved.route.listenPort,
          saved.sourceNodeName ?? saved.route.name,
        );
    if (content) {
      const result = await this.resources.client.convert(content, 'JSON', true);
      if (!Array.isArray(result) || result.length !== 1)
        throw new AppError('RELAY_EXPORT_FAILED', '上游无法完整解析隧道入口，未更新订阅。', 422);
    }
    await this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      const existing = this.resources.listResources().find((r) => r.id === saved.sourceId);
      if (existing) {
        const rec = this.resources.record(saved.sourceId);
        if (marker(rec.record)?.role !== 'relay-source')
          throw new AppError('RELAY_SOURCE_CONFLICT', '线路订阅身份冲突。', 409);
        if (
          rec.record.content === content &&
          marker(rec.record)?.deploymentRevision === saved.targetRevision
        )
          return;
        await this.resources.client.api(
          '/api/sub/' + encodeURIComponent(rec.record.name),
          {
            content,
            [identityKey]: { ...marker(rec.record), deploymentRevision: saved.targetRevision },
          },
          'PATCH',
        );
      } else if (!remove)
        await this.resources.client.api('/api/subs', {
          name: 'sm-route-source-' + saved.sourceId,
          displayName: saved.route.name,
          source: 'local',
          content,
          url: '',
          process: [],
          [identityKey]: {
            id: saved.sourceId,
            role: 'relay-source',
            version: 1,
            deploymentRevision: saved.targetRevision,
          },
        });
      await this.resources.syncUnlocked();
    });
  }
  private async invalidateSource(saved: Saved) {
    const machine = this.machines.list().find((m) => m.id === saved.route.entryMachineId);
    const resourceId = saved.route.kind === 'tunnel' ? saved.sourceId : machine?.resourceId;
    if (!resourceId) return;
    await this.resources.client.exclusive(async () => {
      await this.resources.syncUnlocked();
      let rec;
      try {
        rec = this.resources.record(resourceId);
      } catch {
        return;
      }
      const routes =
        saved.route.kind === 'tunnel'
          ? [saved]
          : this.resources
              .files('relay-route')
              .flatMap(({ id }) => {
                const entry = this.read(id).saved;
                return [entry, ...(entry.migration ? [entry.migration.previous] : [])];
              })
              .filter((s) => s.route.entryMachineId === saved.route.entryMachineId);
      const revision = hash(
        routes
          .filter((s) => s.route.status !== 'deleted')
          .map((s) => ({ id: s.route.id, target: s.targetRevision, status: s.route.status })),
      );
      if (marker(rec.record)?.topologyRevision === revision) return;
      await this.resources.client.api(
        '/api/sub/' + encodeURIComponent(rec.record.name),
        { [identityKey]: { ...marker(rec.record), topologyRevision: revision } },
        'PATCH',
      );
      await this.resources.syncUnlocked();
    });
    const previous = saved.migration?.previous;
    if (
      previous &&
      (previous.route.kind === 'tunnel'
        ? saved.route.kind !== 'tunnel'
        : saved.route.kind === 'tunnel' ||
          previous.route.entryMachineId !== saved.route.entryMachineId)
    )
      await this.invalidateSource({
        ...previous,
        route: { ...previous.route, status: saved.route.status },
      });
  }
  tick(): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return;
      await this.resources.sync();
      const ids = this.resources.files('relay-route').map((f) => f.id);
      for (const id of ids) {
        const { saved, revision } = this.read(id);
        if (saved.route.status === 'deleted') continue;
        try {
          if (saved.route.status === 'active') {
            const target = await this.snapshot(saved.route.targetMachineId);
            if (target.revision !== saved.targetRevision) {
              saved.route.status = 'stale';
              saved.route.message = '目标配置已改变，请重新应用线路。';
              await this.save(saved, revision);
              await this.invalidateSource(saved);
            }
            continue;
          }
          if (['failed', 'stale'].includes(saved.route.status)) continue;
          if (saved.step) {
            let task = this.taskFor(saved);
            if (!task)
              task = (
                await this.machines.enqueue(
                  saved.step.machineId,
                  { ...saved.step.operation, expectedRevision: saved.step.expectedRevision },
                  saved.step.requestId,
                )
              ).task;
            if (active(task, this.machines)) continue;
            if (task.status !== 'applied') {
              saved.route.status = 'failed';
              saved.route.message =
                (saved.migration?.phase === 'retire' ? '新入口已应用，旧隧道清理尚未完成：' : '') +
                (task.status === 'pending_restart'
                  ? '配置尚待重启，完成应用后重试线路。'
                  : '线路步骤失败：' + task.message);
              await this.save(saved, revision);
              await this.invalidateSource(saved);
              continue;
            }
            await this.acceptOwnTargetRevision(saved, task);
            this.advanceStep(saved);
          }
          const next = await this.nextStep(saved);
          if (!next) {
            if (saved.route.kind === 'tunnel') await this.publishTunnel(saved, saved.deleting);
            const previous = saved.migration?.previous;
            const changed =
              !saved.deleting &&
              (await this.snapshot(saved.route.targetMachineId)).revision !== saved.targetRevision;
            saved.route.status = saved.deleting ? 'deleted' : changed ? 'stale' : 'active';
            saved.route.message = saved.deleting
              ? '线路资源已删除。'
              : changed
                ? '更新与旧资源清理已完成，但目标随后变化，请重新应用。'
                : '机器已确认应用；连通性请在测试中心验证。';
            delete saved.migration;
            await this.save(saved, revision);
            await this.invalidateSource(saved);
            if (
              previous &&
              (previous.route.kind !== saved.route.kind ||
                previous.route.entryMachineId !== saved.route.entryMachineId)
            )
              await this.invalidateSource({
                ...previous,
                route: { ...previous.route, status: 'deleted' },
              });
            continue;
          }
          const snapshot = await this.snapshot(next.machineId);
          saved.step = {
            machineId: next.machineId,
            operation: next.operation,
            requestId: randomUUID(),
            expectedRevision: snapshot.revision,
            ...(next.operation.action.startsWith('tunnel.')
              ? {
                  reportedTunnelRevision:
                    (await this.machines.getTunnelReports(next.machineId)).find(
                      (item) => item.id === next.operation.params.id,
                    )?.revision ?? null,
                }
              : {}),
          };
          saved.route.taskIds.push(saved.step.requestId);
          saved.route.status = saved.deleting ? 'deleting' : 'applying';
          saved.route.message = saved.migration
            ? saved.migration.phase === 'cleanup'
              ? '正在清理旧入口资源；尚未部署新配置。'
              : saved.migration.phase === 'retire'
                ? '新入口已应用，正在清理旧隧道跳。'
                : '正在应用更新，完成前保留旧目标引用。'
            : '等待机器执行第 ' + (saved.stage + 1) + ' 步。';
          await this.save(saved, revision);
          await this.machines.enqueue(
            next.machineId,
            { ...next.operation, expectedRevision: snapshot.revision },
            saved.step.requestId,
          );
        } catch (error) {
          if (error instanceof AppError && error.code === 'MACHINE_BUSY') continue;
          const latest = this.read(id);
          // Preserve durable intent for upstream/network recovery, but expose concrete failure.
          latest.saved.route.status = 'failed';
          latest.saved.route.message =
            error instanceof AppError ? error.message : '线路操作失败，请检查机器和上游连接。';
          await this.save(latest.saved, latest.revision);
          await this.invalidateSource(latest.saved);
        }
      }
    });
  }
}

export function registerRelayRoutes(app: Hono, store: RelayStore) {
  app.get('/api/relays', async (c) => c.json(await store.list()));
  app.post('/api/relays', async (c) =>
    c.json(await store.create(await readJson(c.req.raw, 65536)), 201),
  );
  app.patch('/api/relays/:id', async (c) =>
    c.json(await store.update(c.req.param('id'), await readJson(c.req.raw, 65536))),
  );
  const revision = async (request: Request) =>
    z.strictObject({ revision: revisionSchema }).parse(await readJson(request, 1024)).revision;
  app.post('/api/relays/:id/apply', async (c) =>
    c.json(await store.apply(c.req.param('id'), await revision(c.req.raw))),
  );
  app.delete('/api/relays/:id', async (c) =>
    c.json(await store.remove(c.req.param('id'), await revision(c.req.raw))),
  );
}
