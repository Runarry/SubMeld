<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { z } from 'zod';
import {
  machineDetailSchema,
  machineViewSchema,
  relayRouteSchema,
  type MachineDetail,
  type MachineView,
  type RelayRoute,
} from '../server/shared/machines';
import { ApiError } from './api';
import ModalDialog from './ui/ModalDialog.vue';
import { machineActionLabels, machineStatusLabels } from './machineActions';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const routeInputSchema = relayRouteSchema.omit({
  id: true,
  revision: true,
  status: true,
  message: true,
  health: true,
  taskIds: true,
});
type RouteInput = z.infer<typeof routeInputSchema>;
const routes = ref<RelayRoute[]>([]);
const machines = ref<MachineView[]>([]);
const details = ref<Record<string, MachineDetail>>({});
const busy = ref(false);
const loading = ref(false);
const message = ref('');
const form = ref<RouteInput | null>(null);
const deleting = ref<RelayRoute | null>(null);
let alive = true;
let timer: ReturnType<typeof setInterval> | undefined;
const statuses: Record<RelayRoute['status'], string> = {
  pending: '等待编排',
  applying: '应用中',
  active: '已生效',
  failed: '失败',
  deleting: '删除中',
  deleted: '已删除',
  stale: '需重新应用',
};
const kinds = { forward: '端口转发', protocol: '协议中转', tunnel: '隧道中转' };
const targetNodes = computed(() =>
  form.value ? details.value[form.value.targetMachineId]?.snapshot?.nodes || [] : [],
);
const entryNodes = computed(() =>
  form.value ? details.value[form.value.entryMachineId]?.snapshot?.nodes || [] : [],
);
const eligibleMachines = computed(() =>
  machines.value.filter((machine) => machine.enabled && machine.revision),
);
const errorText = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && /REVISION|CONFLICT/.test(error.code)
    ? '版本冲突：线路或机器状态已变化，请刷新后核对再重试。' + error.message
    : error instanceof Error
      ? error.message
      : '操作失败。';
const machineName = (id: string) => machines.value.find((machine) => machine.id === id)?.name || id;
const nodeName = (machineId: string, nodeId: string) =>
  details.value[machineId]?.snapshot?.nodes.find((node) => node.id === nodeId)?.name || nodeId;
function routePath(route: RouteInput) {
  return [
    machineName(route.entryMachineId),
    ...(route.kind === 'tunnel' ? route.hops.map((hop) => machineName(hop.machineId)) : []),
    ...(route.kind !== 'tunnel' || route.hops.at(-1)?.machineId !== route.targetMachineId
      ? [machineName(route.targetMachineId)]
      : []),
    nodeName(route.targetMachineId, route.targetNodeId),
  ]
    .filter(Boolean)
    .join(' → ');
}
function routeTasks(route: RelayRoute) {
  return Object.values(details.value).flatMap((detail) =>
    detail.tasks
      .filter((task) => route.taskIds.includes(task.id))
      .map((task) => ({ ...task, machineName: detail.machine.name })),
  );
}
async function loadDetail(id: string) {
  if (!id) return;
  const value = machineDetailSchema.parse(await props.api('/api/machines/' + id));
  if (alive) details.value[id] = value;
}
async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    const values = await Promise.all([
      props
        .api('/api/machines')
        .then((value) => z.object({ machines: z.array(machineViewSchema) }).parse(value)),
      props
        .api('/api/relays')
        .then((value) => z.object({ routes: z.array(relayRouteSchema) }).parse(value)),
    ]);
    if (!alive) return;
    machines.value = values[0].machines;
    routes.value = values[1].routes;
    const ids = new Set(
      routes.value.flatMap((route) => [
        route.entryMachineId,
        route.targetMachineId,
        ...route.hops.map((hop) => hop.machineId),
      ]),
    );
    if (form.value)
      for (const id of [form.value.entryMachineId, form.value.targetMachineId]) if (id) ids.add(id);
    const outcomes = await Promise.allSettled([...ids].map(loadDetail));
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } finally {
    if (alive) loading.value = false;
  }
}
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await fn();
  } catch (error) {
    if (alive) message.value = errorText(error);
  } finally {
    if (alive) busy.value = false;
  }
}
function create() {
  message.value = '';
  form.value = {
    name: '',
    kind: 'tunnel',
    entryMachineId: '',
    targetMachineId: '',
    targetNodeId: '',
    listenPort: 8443,
    address: '',
    network: 'both',
    family: 'dual',
    hops: [],
  };
}
function changeKind() {
  if (!form.value) return;
  delete form.value.entryNodeId;
  if (form.value.kind === 'tunnel') defaultHop();
  else form.value.hops = [];
}
function defaultHop() {
  if (!form.value || form.value.kind !== 'tunnel' || !form.value.targetMachineId) return;
  if (form.value.hops.length <= 1)
    form.value.hops = [{ machineId: form.value.targetMachineId, address: '', port: 24443 }];
}
async function targetChanged() {
  if (!form.value) return;
  form.value.targetNodeId = '';
  defaultHop();
  await loadDetail(form.value.targetMachineId);
}
async function entryChanged() {
  if (!form.value) return;
  delete form.value.entryNodeId;
  if (form.value.targetMachineId === form.value.entryMachineId) {
    form.value.targetMachineId = '';
    form.value.targetNodeId = '';
  }
  form.value.hops = form.value.hops.filter((hop) => hop.machineId !== form.value!.entryMachineId);
  await loadDetail(form.value.entryMachineId);
}
function entryNodeChanged() {
  if (!form.value) return;
  const node = entryNodes.value.find((node) => node.id === form.value?.entryNodeId);
  if (typeof node?.port === 'number') form.value.listenPort = node.port;
  if (typeof node?.address === 'string') form.value.address = node.address;
}
function hopOptions(index: number) {
  if (!form.value) return [];
  const used = new Set([
    form.value.entryMachineId,
    ...form.value.hops.filter((_, i) => i !== index).map((hop) => hop.machineId),
  ]);
  return eligibleMachines.value.filter(
    (machine) =>
      !used.has(machine.id) &&
      (machine.id !== form.value!.targetMachineId || index === form.value!.hops.length - 1),
  );
}
function addHop() {
  if (!form.value) return;
  const index =
    form.value.hops.at(-1)?.machineId === form.value.targetMachineId
      ? form.value.hops.length - 1
      : form.value.hops.length;
  form.value.hops.splice(index, 0, { machineId: '', address: '', port: 24443 });
}
function moveHop(index: number, delta: number) {
  if (!form.value) return;
  const next = index + delta;
  if (next < 0 || next >= form.value.hops.length) return;
  const hop = form.value.hops[index]!;
  if (
    (hop.machineId === form.value.targetMachineId && next !== form.value.hops.length - 1) ||
    form.value.hops[next]?.machineId === form.value.targetMachineId
  )
    return;
  form.value.hops.splice(index, 1);
  form.value.hops.splice(next, 0, hop);
}
async function save() {
  if (!form.value) return;
  const result = routeInputSchema.safeParse(form.value);
  if (!result.success)
    throw new Error(
      '请填写线路名称、机器、目标节点、地址与有效端口。隧道每跳都需要机器、可达地址和端口。',
    );
  const input = result.data;
  if (input.entryMachineId === input.targetMachineId)
    throw new Error('入口与目标请选择不同机器，避免线路环路。');
  const machineIds = [input.entryMachineId, ...input.hops.map((hop) => hop.machineId)];
  if (new Set(machineIds).size !== machineIds.length)
    throw new Error('同一条隧道不能重复经过相同机器。');
  if (!targetNodes.value.some((node) => node.id === input.targetNodeId))
    throw new Error('目标节点已不可用，请重新选择。');
  if (input.kind === 'protocol' && !entryNodes.value.some((node) => node.id === input.entryNodeId))
    throw new Error('请选择入口机器上已有的入口节点。');
  if (input.kind === 'tunnel') {
    if (!input.hops.length) throw new Error('隧道至少需要一跳目标机器。');
    if (
      input.hops.some(
        (hop, index) => hop.machineId === input.targetMachineId && index !== input.hops.length - 1,
      )
    )
      throw new Error('目标机器只能作为隧道最后一跳。');
    const node = targetNodes.value.find((node) => node.id === input.targetNodeId);
    const address = String(node?.address || '');
    const listen = String(node?.listen || '');
    if (
      (/^(?:127\.|localhost$|::1$|\[::1\]$)/i.test(address) ||
        /^(?:127\.|::1$|\[::1\]$)/.test(listen)) &&
      input.hops.at(-1)?.machineId !== input.targetMachineId
    )
      throw new Error('目标节点使用回环地址，隧道最后一跳必须是目标机器。');
  }
  if (input.kind !== 'protocol') delete input.entryNodeId;
  await props.api('/api/relays', input);
  if (!alive) return;
  form.value = null;
  await refresh();
  message.value = '线路已创建，正在按路径下发任务。请查看实际执行结果。';
}
async function apply(route: RelayRoute) {
  await props.api('/api/relays/' + route.id + '/apply', { revision: route.revision });
  await refresh();
}
async function remove() {
  if (!deleting.value) return;
  await props.api(
    '/api/relays/' + deleting.value.id,
    { revision: deleting.value.revision },
    'DELETE',
  );
  deleting.value = null;
  await refresh();
  message.value = '已开始分步删除此线路，请查看清理结果。';
}
function poll() {
  if (document.visibilityState === 'visible')
    void refresh().catch((error) => {
      if (alive) message.value = errorText(error);
    });
}
onMounted(() => {
  void act(refresh);
  timer = setInterval(poll, 5000);
  document.addEventListener('visibilitychange', poll);
});
onBeforeUnmount(() => {
  alive = false;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', poll);
});
</script>

<template>
  <section class="page relays-page">
    <header class="page-header">
      <div>
        <h1>中转线路</h1>
        <p>选择已上报的机器和节点，编排端口转发、协议中转或多跳隧道。每 5 秒刷新执行结果。</p>
      </div>
      <div class="actions">
        <button :disabled="busy || loading" @click="act(refresh)">刷新线路</button
        ><button class="primary" @click="create">添加线路</button>
      </div>
    </header>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <div class="panel" aria-label="中转线路列表">
      <p v-if="!routes.length">尚未创建线路。请先在“机器”页安装 Agent 并创建目标节点。</p>
      <article v-for="route in routes" :key="route.id" class="relay-route">
        <header class="route-header">
          <div>
            <h2>{{ route.name }}</h2>
            <p>
              {{ kinds[route.kind] }} · {{ statuses[route.status] }} ·
              {{
                {
                  unknown: '运行状态待核对',
                  online: 'Agent 在线',
                  offline: '部分 Agent 离线',
                  degraded: '运行异常',
                }[route.health]
              }}
            </p>
          </div>
          <div class="actions">
            <button
              :disabled="busy || ['applying', 'deleting', 'deleted'].includes(route.status)"
              @click="act(() => apply(route))"
            >
              {{ route.status === 'failed' ? '重试应用' : '重新应用' }}</button
            ><button
              v-if="route.status !== 'deleted'"
              class="danger"
              :disabled="busy || route.status === 'deleting'"
              @click="
                deleting = route;
                message = '';
              "
            >
              删除线路
            </button>
          </div>
        </header>
        <p class="route-path">{{ routePath(route) }}</p>
        <p>
          入口 {{ route.address }}:{{ route.listenPort }} · {{ route.network }} · {{ route.family }}
        </p>
        <p v-if="route.entryNodeId">
          入口节点：{{ nodeName(route.entryMachineId, route.entryNodeId) }}
        </p>
        <ol v-if="route.kind === 'tunnel'" class="hop-path">
          <li v-for="(hop, index) in route.hops" :key="hop.machineId">
            第 {{ index + 1 }} 跳：{{ machineName(hop.machineId) }} · {{ hop.address }}:{{
              hop.port
            }}
          </li>
        </ol>
        <p v-if="route.message" :class="{ failure: ['failed', 'stale'].includes(route.status) }">
          {{ route.message }}
        </p>
        <details v-if="route.taskIds.length">
          <summary>任务与失败明细（{{ route.taskIds.length }}）</summary>
          <p v-if="!routeTasks(route).length">正在读取机器任务记录。</p>
          <ul>
            <li
              v-for="task in routeTasks(route)"
              :key="task.id"
              :class="{ failure: ['failed', 'conflict', 'unknown'].includes(task.status) }"
            >
              {{ task.machineName }} · {{ machineActionLabels[task.action] || task.action }} ·
              {{ machineStatusLabels[task.status] || task.status
              }}<span v-if="task.message">：{{ task.message }}</span>
            </li>
          </ul>
        </details>
      </article>
    </div>
    <ModalDialog v-if="form" label="添加中转线路" wide :dismissible="!busy" @close="form = null">
      <h2>添加中转线路</h2>
      <p>选择机器与已有节点。先完成机器首次上报；离线机器需重新连接后才能执行。</p>
      <form id="relay-route-form" @submit.prevent="act(save)">
        <div class="form-grid">
          <label>线路名称<input v-model="form.name" required maxlength="128" /></label>
          <label
            >线路类型<select v-model="form.kind" aria-label="线路类型" @change="changeKind">
              <option value="tunnel">隧道中转</option>
              <option value="forward">端口转发</option>
              <option value="protocol">协议中转</option>
            </select></label
          >
          <label
            >入口机器<select
              v-model="form.entryMachineId"
              aria-label="入口机器"
              required
              :disabled="busy"
              @change="act(entryChanged)"
            >
              <option value="">请选择入口机器</option>
              <option v-for="machine in eligibleMachines" :key="machine.id" :value="machine.id">
                {{ machine.name }}{{ machine.online ? '' : '（离线）' }}
              </option>
            </select></label
          >
          <label
            >目标机器<select
              v-model="form.targetMachineId"
              aria-label="目标机器"
              required
              :disabled="busy"
              @change="act(targetChanged)"
            >
              <option value="">请选择目标机器</option>
              <option
                v-for="machine in eligibleMachines.filter(
                  (machine) => machine.id !== form!.entryMachineId,
                )"
                :key="machine.id"
                :value="machine.id"
              >
                {{ machine.name }}{{ machine.online ? '' : '（离线）' }}
              </option>
            </select></label
          >
          <label
            >目标节点<select
              v-model="form.targetNodeId"
              aria-label="目标节点"
              required
              :disabled="busy || !form.targetMachineId"
            >
              <option value="">请选择目标节点</option>
              <option v-for="node in targetNodes" :key="node.id" :value="node.id">
                {{ node.name }} · {{ node.core }} · {{ node.profile }}
              </option>
            </select></label
          >
          <label v-if="form.kind === 'protocol'"
            >入口节点<select
              v-model="form.entryNodeId"
              aria-label="入口节点"
              required
              :disabled="busy || !form.entryMachineId"
              @change="entryNodeChanged"
            >
              <option value="">请选择入口节点</option>
              <option v-for="node in entryNodes" :key="node.id" :value="node.id">
                {{ node.name }} · {{ node.core }} · {{ node.profile }}
              </option>
            </select></label
          >
          <label
            >入口端口<input
              v-model.number="form.listenPort"
              aria-label="入口端口"
              type="number"
              required
              min="1"
              max="65535"
            /><small>{{
              form.kind === 'protocol'
                ? '协议中转复用已有入口节点及其凭据。'
                : '客户端访问入口机器的端口。'
            }}</small></label
          >
          <label
            >入口连接地址<input
              v-model="form.address"
              aria-label="入口连接地址"
              required
              maxlength="253"
            /><small>客户端可访问的入口机器 IP 或域名。</small></label
          >
          <label
            >网络协议<select v-model="form.network" aria-label="网络协议">
              <option value="both">TCP + UDP</option>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select></label
          >
          <label
            >地址族<select v-model="form.family" aria-label="地址族">
              <option value="dual">双栈</option>
              <option value="ipv4">IPv4</option>
              <option value="ipv6">IPv6</option>
            </select></label
          >
        </div>
        <section v-if="form.kind === 'tunnel'" aria-label="隧道路径">
          <h3>隧道路径</h3>
          <p>
            流量从入口依次经过下列机器。默认最后一跳是目标机器；请填写前一跳可达的地址及隧道端口。目标节点若只监听回环地址，最后一跳必须在目标同机。
          </p>
          <fieldset v-for="(hop, index) in form.hops" :key="index" class="hop-fields">
            <legend>第 {{ index + 1 }} 跳</legend>
            <div class="form-grid">
              <label
                >经过机器<select v-model="hop.machineId" aria-label="经过机器" required>
                  <option value="">请选择机器</option>
                  <option
                    v-for="machine in hopOptions(index)"
                    :key="machine.id"
                    :value="machine.id"
                  >
                    {{ machine.name }}
                  </option>
                </select></label
              ><label
                >这一跳的可达地址<input v-model="hop.address" required maxlength="253" /></label
              ><label
                >隧道监听端口<input
                  v-model.number="hop.port"
                  type="number"
                  required
                  min="1"
                  max="65535"
              /></label>
            </div>
            <div class="actions">
              <button type="button" :disabled="index === 0" @click="moveHop(index, -1)">上移</button
              ><button
                type="button"
                :disabled="index === form.hops.length - 1"
                @click="moveHop(index, 1)"
              >
                下移</button
              ><button type="button" class="danger" @click="form!.hops.splice(index, 1)">
                移除此跳
              </button>
            </div>
          </fieldset>
          <button type="button" :disabled="form.hops.length >= 8" @click="addHop">增加一跳</button>
        </section>
        <p
          v-if="form.entryMachineId && form.targetMachineId && form.targetNodeId"
          class="route-path"
        >
          预览路径：{{ routePath(form) }}
        </p>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="form = null">取消</button
        ><button
          form="relay-route-form"
          class="primary"
          :disabled="busy || !eligibleMachines.length"
        >
          创建并应用线路
        </button></template
      >
    </ModalDialog>
    <ModalDialog v-if="deleting" label="删除中转线路" :dismissible="!busy" @close="deleting = null"
      ><h2>删除 {{ deleting.name }}</h2>
      <p>将按步骤撤销此线路创建的转发、关联与隧道。删除期间请查看任务结果；只清理本线路。</p>
      <p v-if="message" role="alert">{{ message }}</p>
      <template #footer
        ><button :disabled="busy" @click="deleting = null">取消</button
        ><button class="danger" :disabled="busy" @click="act(remove)">
          确认删除线路
        </button></template
      ></ModalDialog
    >
  </section>
</template>

<style scoped>
.relays-page {
  display: grid;
  gap: 18px;
}
.page-header p {
  margin: 8px 0 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.relay-route {
  padding: 18px 0;
  border-bottom: 1px solid var(--border);
  display: grid;
  gap: 12px;
  overflow-wrap: anywhere;
}
.relay-route:last-child {
  border-bottom: 0;
}
.relay-route p {
  margin-bottom: 0;
}
.route-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
}
.route-header > div {
  min-width: 0;
}
.route-header p {
  margin-top: 8px;
}
.route-path {
  padding: 12px;
  border-radius: var(--radius);
  background: var(--row-active);
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.hop-path,
ul {
  padding-left: 24px;
  margin: 0;
}
li {
  margin-block: 6px;
}
.failure {
  color: var(--error-text);
}
summary {
  cursor: pointer;
}
form {
  display: grid;
  gap: 18px;
  margin-top: 16px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
small {
  color: var(--muted);
  font-weight: 400;
}
.hop-fields {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin: 12px 0;
  min-width: 0;
}
.hop-fields .actions {
  margin-top: 12px;
}
legend {
  font-size: 13px;
  font-weight: 600;
}
@media (max-width: 650px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
  .route-header {
    flex-direction: column;
    align-items: stretch;
  }
  .actions > button {
    flex-grow: 1;
  }
}
</style>
