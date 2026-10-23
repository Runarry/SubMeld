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
import SearchSelect from './ui/SearchSelect.vue';
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
  outputResourceId: true,
});
type RouteInput = z.infer<typeof routeInputSchema>;
type Editing = { id: string; revision: string; input: RouteInput };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const queryFor = (values: Record<string, string>) => new URLSearchParams(values);
const routes = ref<RelayRoute[]>([]),
  machines = ref<MachineView[]>([]),
  details = ref<Record<string, MachineDetail>>({});
const busy = ref(false),
  loading = ref(false),
  message = ref(''),
  failed = ref(false);
const form = ref<RouteInput | null>(null),
  editing = ref<Editing | null>(null);
const draft = ref<{ form: RouteInput; editing: Editing | null; step: number } | null>(null);
const deleting = ref<RelayRoute | null>(null),
  selectedId = ref('');
const search = ref(''),
  status = ref(''),
  step = ref(1);
let alive = true,
  timer: ReturnType<typeof setInterval> | undefined,
  previousTarget = '',
  navigation = 0;
const statuses: Record<RelayRoute['status'], string> = {
  pending: '等待编排',
  applying: '应用中',
  active: '已应用',
  failed: '失败',
  deleting: '删除中',
  deleted: '已删除',
  stale: '需重新应用',
};
const kinds = { forward: '端口转发', protocol: '协议中转', tunnel: '加密隧道' };
const kindHints = {
  forward: '透传已有代理端口',
  protocol: '入口节点经落地出站',
  tunnel: '跨机器加密传输',
};
const healthLabels = {
  unknown: '运行状态待核对',
  online: 'Agent 与已知运行状态正常',
  offline: '部分 Agent 离线',
  degraded: '运行异常',
};
const selected = computed(() => routes.value.find((route) => route.id === selectedId.value));
const filtered = computed(() =>
  routes.value.filter(
    (route) =>
      (status.value ? route.status === status.value : route.status !== 'deleted') &&
      [
        route.name,
        machineName(route.entryMachineId),
        machineName(route.targetMachineId),
        route.address,
      ].some((value) => value.toLowerCase().includes(search.value.toLowerCase())),
  ),
);
const targetNodes = computed(() =>
  form.value ? (details.value[form.value.targetMachineId]?.snapshot?.nodes ?? []) : [],
);
const entryNodes = computed(() =>
  form.value ? (details.value[form.value.entryMachineId]?.snapshot?.nodes ?? []) : [],
);
const targetNode = computed(() =>
  targetNodes.value.find((node) => node.id === form.value?.targetNodeId),
);
const conflict = computed(
  () =>
    !!editing.value &&
    routes.value.find((route) => route.id === editing.value?.id)?.revision !==
      editing.value.revision,
);
const machineOptions = computed(() =>
  machines.value.map((machine) => ({
    value: machine.id,
    label: machine.name,
    hint: !machine.enabled
      ? '已禁用'
      : !machine.revision
        ? '等待首次上报'
        : machine.online
          ? machine.summary?.addresses.join(' · ') || '在线'
          : '离线 · 任务将等待连接',
    disabled: !machine.enabled || !machine.revision,
  })),
);
const targetOptions = computed(() =>
  targetNodes.value.map((node) => ({
    value: node.id,
    label: node.name,
    hint:
      node.profile +
      ' · ' +
      endpoint(node.address, node.port) +
      (details.value[form.value!.targetMachineId]?.snapshot?.pendingCores.includes(node.core)
        ? ' · 内核待重启'
        : ''),
    disabled: details.value[form.value!.targetMachineId]?.snapshot?.pendingCores.includes(
      node.core,
    ),
  })),
);
const entryOptions = computed(() =>
  entryNodes.value.map((node) => ({
    value: node.id,
    label: node.name,
    hint: node.core + ' · ' + endpoint(node.address, node.port),
  })),
);
const offlineNames = computed(() =>
  form.value
    ? [
        ...new Set([
          form.value.entryMachineId,
          form.value.targetMachineId,
          ...form.value.hops.map((hop) => hop.machineId),
        ]),
      ]
        .filter((id) => id && !machines.value.find((machine) => machine.id === id)?.online)
        .map(machineName)
    : [],
);
const changedFields = computed(() => {
  if (!editing.value || !form.value) return [];
  const labels: Record<keyof RouteInput, string> = {
    name: '线路名称',
    kind: '连接方式',
    entryMachineId: '入口机器',
    targetMachineId: '落地机器',
    targetNodeId: '落地节点',
    entryNodeId: '入口节点',
    listenPort: '入口端口',
    address: '连接地址',
    network: '网络协议',
    family: '地址族',
    hops: '隧道路径',
  };
  return (Object.keys(labels) as (keyof RouteInput)[])
    .filter((key) => JSON.stringify(editing.value!.input[key]) !== JSON.stringify(form.value![key]))
    .map((key) => ({
      key,
      label: labels[key],
      before: describe(key, editing.value!.input),
      after: describe(key, form.value!),
    }));
});
function machineName(id: string) {
  return machines.value.find((machine) => machine.id === id)?.name ?? '未选择机器';
}
function nodeName(machineId: string, nodeId?: string) {
  return (
    details.value[machineId]?.snapshot?.nodes.find((node) => node.id === nodeId)?.name ?? '落地节点'
  );
}
function endpoint(address: unknown, port: unknown) {
  const host = typeof address === 'string' ? address : '';
  return host
    ? (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) +
        (port ? ':' + String(port) : '')
    : '地址待填写';
}
function describe(key: keyof RouteInput, value: RouteInput): string {
  if (key === 'kind') return kinds[value.kind];
  if (key === 'entryMachineId' || key === 'targetMachineId') return machineName(String(value[key]));
  if (key === 'entryNodeId' || key === 'targetNodeId')
    return nodeName(
      key === 'entryNodeId' ? value.entryMachineId : value.targetMachineId,
      value[key],
    );
  if (key === 'hops')
    return (
      value.hops
        .map((hop) => machineName(hop.machineId) + ' · ' + endpoint(hop.address, hop.port))
        .join(' → ') || '无中间跳'
    );
  return String(value[key] ?? '—');
}
function path(route: RouteInput) {
  return [
    machineName(route.entryMachineId),
    ...(route.kind === 'tunnel' ? route.hops.map((hop) => machineName(hop.machineId)) : []),
    ...(route.kind !== 'tunnel' || route.hops.at(-1)?.machineId !== route.targetMachineId
      ? [machineName(route.targetMachineId)]
      : []),
  ].join(' → ');
}
function tasks(route: RelayRoute) {
  return route.taskIds.flatMap((id) =>
    Object.values(details.value).flatMap((detail) =>
      detail.tasks
        .filter((task) => task.id === id)
        .map((task) => ({ ...task, machineName: detail.machine.name })),
    ),
  );
}
function editable(route: RelayRoute) {
  return !['pending', 'applying', 'deleting', 'deleted'].includes(route.status);
}
function machineLink(id: string) {
  return '#/machines?machine=' + encodeURIComponent(id) + '&tab=nodes';
}
function nodeLink(route: RelayRoute) {
  return '#/nodes?resource=' + encodeURIComponent(route.outputResourceId ?? '');
}
function candidateAddress(id: string) {
  const values = machines.value
    .find((machine) => machine.id === id)
    ?.summary?.addresses.filter(
      (value) => !/^(?:0\.0\.0\.0|::|127\..*|localhost|\[?::1\]?)$/.test(value),
    );
  return values?.length === 1 ? values[0]! : '';
}
function errorText(error: unknown) {
  return error instanceof ApiError && error.status === 409 && /REVISION|CONFLICT/.test(error.code)
    ? '线路已更新。请核对最新配置后继续，当前输入已保留。'
    : error instanceof Error
      ? error.message
      : '操作失败。';
}
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  failed.value = false;
  try {
    await fn();
  } catch (error) {
    if (alive) {
      message.value = errorText(error);
      failed.value = true;
    }
  } finally {
    if (alive) busy.value = false;
  }
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
    const [machineList, routeList] = await Promise.all([
      props.api('/api/machines'),
      props.api('/api/relays'),
    ]);
    if (!alive) return;
    machines.value = z.object({ machines: machineViewSchema.array() }).parse(machineList).machines;
    routes.value = z.object({ routes: relayRouteSchema.array() }).parse(routeList).routes;
    const current = form.value ?? selected.value;
    if (current) {
      const ids = [
        ...new Set([
          current.entryMachineId,
          current.targetMachineId,
          ...current.hops.map((hop) => hop.machineId),
        ]),
      ].filter(Boolean);
      const outcomes = await Promise.allSettled(ids.map(loadDetail));
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  } finally {
    if (alive) loading.value = false;
  }
}
function writeLocation(query = new URLSearchParams()) {
  location.hash = '/relays' + (query.size ? '?' + query : '');
}
function showRoute(route: RelayRoute) {
  writeLocation(new URLSearchParams({ route: route.id }));
}
function startCreate() {
  if (form.value) return;
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
  editing.value = null;
  previousTarget = '';
  step.value = 1;
  selectedId.value = '';
  message.value = '';
}
async function edit(route: RelayRoute) {
  if (!editable(route)) return;
  editing.value = { id: route.id, revision: route.revision, input: routeInputSchema.parse(route) };
  form.value = copy(editing.value.input);
  previousTarget = route.targetMachineId;
  step.value = 1;
  message.value = '';
  await Promise.all(
    [
      ...new Set([
        route.entryMachineId,
        route.targetMachineId,
        ...route.hops.map((hop) => hop.machineId),
      ]),
    ].map(loadDetail),
  );
}
function closeWizard() {
  if (form.value)
    draft.value = {
      form: copy(form.value),
      editing: editing.value ? copy(editing.value) : null,
      step: step.value,
    };
  form.value = null;
  editing.value = null;
  message.value = '';
  writeLocation();
}
function resumeDraft() {
  if (!draft.value) return;
  form.value = copy(draft.value.form);
  editing.value = draft.value.editing ? copy(draft.value.editing) : null;
  step.value = draft.value.step;
  previousTarget = form.value.targetMachineId;
  writeLocation(new URLSearchParams(editing.value ? { edit: editing.value.id } : { create: '1' }));
}
async function locationChanged() {
  if (!/^#\/?relays(?:\?|$)/.test(location.hash)) return;
  const ticket = ++navigation,
    query = new URLSearchParams(location.hash.split('?')[1]);
  if (query.has('create')) {
    if (!form.value) {
      startCreate();
      const machine = query.get('targetMachine');
      if (machine && machines.value.some((item) => item.id === machine)) {
        form.value!.targetMachineId = machine;
        await targetChanged();
        const current = form.value as RouteInput | null;
        if (ticket !== navigation || !current) return;
        const node = query.get('targetNode');
        if (targetNodes.value.some((item) => item.id === node)) current.targetNodeId = node!;
      }
    }
    return;
  }
  const editId = query.get('edit');
  if (editId) {
    if (editing.value?.id !== editId) {
      const route = routes.value.find((item) => item.id === editId);
      if (route) await edit(route);
    }
    return;
  }
  if (form.value) {
    draft.value = {
      form: copy(form.value),
      editing: editing.value ? copy(editing.value) : null,
      step: step.value,
    };
    form.value = null;
    editing.value = null;
  }
  selectedId.value = query.get('route') ?? '';
  search.value = query.get('q') ?? '';
  status.value = query.get('status') ?? '';
  if (selected.value) await refresh();
}
function filterLocation() {
  const query = new URLSearchParams();
  if (search.value) query.set('q', search.value);
  if (status.value) query.set('status', status.value);
  history.replaceState(null, '', '#/relays' + (query.size ? '?' + query : ''));
}
async function targetChanged() {
  if (!form.value) return;
  form.value.targetNodeId = '';
  const old = previousTarget;
  previousTarget = form.value.targetMachineId;
  await loadDetail(form.value.targetMachineId);
  if (!form.value) return;
  if (form.value.kind === 'tunnel') {
    form.value.hops = form.value.hops.filter(
      (hop) => hop.machineId !== old && hop.machineId !== form.value!.targetMachineId,
    );
    form.value.hops.push({
      machineId: form.value.targetMachineId,
      address: candidateAddress(form.value.targetMachineId),
      port: 24443,
    });
  }
  if (targetOptions.value.filter((node) => !node.disabled).length === 1)
    form.value.targetNodeId = targetOptions.value.find((node) => !node.disabled)!.value;
}
async function entryChanged() {
  if (!form.value) return;
  delete form.value.entryNodeId;
  form.value.hops = form.value.hops.filter((hop) => hop.machineId !== form.value!.entryMachineId);
  await loadDetail(form.value.entryMachineId);
  if (form.value) form.value.address = candidateAddress(form.value.entryMachineId);
}
function entryNodeChanged() {
  if (!form.value) return;
  const node = entryNodes.value.find((node) => node.id === form.value?.entryNodeId);
  if (typeof node?.port === 'number') form.value.listenPort = node.port;
  if (typeof node?.address === 'string') form.value.address = node.address;
}
function changeKind(kind: RouteInput['kind']) {
  if (!form.value || form.value.kind === kind) return;
  form.value.kind = kind;
  if (kind === 'tunnel')
    form.value.hops = [
      {
        machineId: form.value.targetMachineId,
        address: candidateAddress(form.value.targetMachineId),
        port: 24443,
      },
    ];
  else form.value.hops = [];
  if (kind !== 'protocol') delete form.value.entryNodeId;
  else if (entryNodes.value.length === 1) {
    form.value.entryNodeId = entryNodes.value[0]!.id;
    entryNodeChanged();
  }
}
function hopOptions(index: number) {
  if (!form.value) return [];
  const used = new Set([
    form.value.entryMachineId,
    ...form.value.hops.filter((_, i) => i !== index).map((hop) => hop.machineId),
  ]);
  return machineOptions.value.map((option) => ({
    ...option,
    disabled:
      option.disabled ||
      used.has(option.value) ||
      (option.value === form.value!.targetMachineId && index !== form.value!.hops.length - 1),
    hint: used.has(option.value) ? '已在当前路径中' : option.hint,
  }));
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
  const next = index + delta,
    hops = form.value.hops;
  if (
    next < 0 ||
    next >= hops.length ||
    hops[index]?.machineId === form.value.targetMachineId ||
    hops[next]?.machineId === form.value.targetMachineId
  )
    return;
  const [hop] = hops.splice(index, 1);
  if (hop) hops.splice(next, 0, hop);
}
function validateEndpoints() {
  if (!form.value) return;
  if (!form.value.name.trim()) throw new Error('请填写线路名称。');
  for (const [id, label] of [
    [form.value.entryMachineId, '入口机器'],
    [form.value.targetMachineId, '落地机器'],
  ])
    if (!machineOptions.value.some((machine) => machine.value === id && !machine.disabled))
      throw new Error('请选择可管理的' + label + '。');
  if (
    !targetOptions.value.some((node) => node.value === form.value?.targetNodeId && !node.disabled)
  )
    throw new Error('请选择已生效的落地节点。');
}
function validated(): RouteInput {
  validateEndpoints();
  const parsed = routeInputSchema.safeParse(form.value);
  if (!parsed.success)
    throw new Error('请填写连接地址和有效端口；隧道每跳都需要机器、可达地址与端口。');
  const input = parsed.data;
  if (
    input.entryMachineId === input.targetMachineId &&
    (input.kind !== 'protocol' || input.entryNodeId === input.targetNodeId)
  )
    throw new Error('当前路径会形成回环，请调整入口或落地。');
  if (input.kind === 'protocol' && !entryNodes.value.some((node) => node.id === input.entryNodeId))
    throw new Error('请选择入口机器上已有的入口节点。');
  if (input.kind === 'tunnel') {
    const ids = [input.entryMachineId, ...input.hops.map((hop) => hop.machineId)];
    if (!input.hops.length || new Set(ids).size !== ids.length)
      throw new Error('请选择至少一跳且不重复经过入口机器的隧道路径。');
    if (
      input.hops.some(
        (hop, index) => hop.machineId === input.targetMachineId && index !== input.hops.length - 1,
      )
    )
      throw new Error('落地机器只能在隧道最后一跳。');
    if (
      input.hops.some(
        (hop) =>
          !machineOptions.value.some(
            (machine) => machine.value === hop.machineId && !machine.disabled,
          ),
      )
    )
      throw new Error('路径中有无法管理的机器。');
    const node = targetNode.value;
    if (
      (/^(?:127\.|localhost$|::1$|\[::1\]$)/i.test(String(node?.address ?? '')) ||
        /^(?:127\.|::1$|\[::1\]$)/.test(String(node?.listen ?? ''))) &&
      input.hops.at(-1)?.machineId !== input.targetMachineId
    )
      throw new Error('落地节点只监听回环地址，最后一跳必须在落地机器。');
  } else input.hops = [];
  if (input.kind !== 'protocol') delete input.entryNodeId;
  return input;
}
async function next() {
  if (step.value === 1) {
    validateEndpoints();
    step.value = 2;
  } else if (step.value === 2) {
    validated();
    step.value = 3;
  } else await save();
}
async function save() {
  if (conflict.value) throw new Error('线路版本已变化，请先对比最新配置。');
  const input = validated();
  const value = z
    .object({ route: relayRouteSchema })
    .parse(
      await props.api(
        editing.value ? '/api/relays/' + editing.value.id : '/api/relays',
        editing.value ? { ...input, revision: editing.value.revision } : input,
        editing.value ? 'PATCH' : 'POST',
      ),
    );
  if (!alive) return;
  form.value = null;
  editing.value = null;
  draft.value = null;
  selectedId.value = value.route.id;
  await refresh();
  showRoute(value.route);
  message.value = '配置已提交，请查看每一步的实际执行结果。';
}
function rebase() {
  const current = routes.value.find((route) => route.id === editing.value?.id);
  if (!current || !editing.value || !editable(current)) return;
  editing.value = {
    id: current.id,
    revision: current.revision,
    input: routeInputSchema.parse(current),
  };
  step.value = 3;
  message.value = '输入已保留，请核对与最新配置的差异后保存。';
  failed.value = false;
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
  message.value = '正在分步撤销此线路资源。';
}
function poll() {
  if (document.visibilityState === 'visible')
    void refresh().catch((error) => {
      if (alive) {
        message.value = errorText(error);
        failed.value = true;
      }
    });
}
function onLocation() {
  void locationChanged().catch((error) => {
    message.value = errorText(error);
    failed.value = true;
  });
}
onMounted(() => {
  void act(async () => {
    await refresh();
    await locationChanged();
  });
  timer = setInterval(poll, 5000);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('hashchange', onLocation);
});
onBeforeUnmount(() => {
  alive = false;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', poll);
  window.removeEventListener('hashchange', onLocation);
});
</script>

<template>
  <section class="page relays-page">
    <template v-if="form">
      <div class="breadcrumb">
        <button type="button" @click="closeWizard">中转线路</button
        ><span>/ {{ editing ? '编辑线路' : '新建线路' }}</span>
      </div>
      <header class="page-header">
        <div>
          <h1>{{ editing ? '编辑中转线路' : '配置中转线路' }}</h1>
          <p class="muted">选择入口与落地，核对流量路径后应用。</p>
        </div>
        <button @click="closeWizard">暂存并返回</button>
      </header>
      <ol class="wizard-steps" aria-label="配置步骤">
        <li
          v-for="(label, index) in ['选择入口与落地', '连接方式与路径', '核对并应用']"
          :key="label"
          :class="{ current: step === index + 1, complete: step > index + 1 }"
        >
          <button
            type="button"
            :disabled="index + 1 > step || busy"
            :aria-current="step === index + 1 ? 'step' : undefined"
            @click="
              step = index + 1;
              message = '';
            "
          >
            <span>{{ step > index + 1 ? '✓' : index + 1 }}</span
            >{{ label }}
          </button>
        </li>
      </ol>
      <p v-if="conflict" class="notice is-warning" role="alert">
        线路已更新，当前输入已保留。<button :disabled="busy" @click="rebase">与最新配置对比</button>
      </p>
      <p v-if="message" class="notice" :class="{ 'is-error': failed }" role="alert">
        {{ message }}
      </p>
      <div class="wizard-layout">
        <form
          id="relay-route-form"
          class="panel wizard-form"
          :aria-label="editing ? '编辑中转线路' : '添加中转线路'"
          @submit.prevent="act(next)"
        >
          <template v-if="step === 1">
            <h2>选择入口与落地</h2>
            <label
              >线路名称<input
                v-model="form.name"
                required
                maxlength="128"
                placeholder="例如 香港 → 东京 → 美国"
            /></label>
            <SearchSelect
              v-model="form.entryMachineId"
              label="入口机器"
              :options="machineOptions"
              :disabled="busy"
              @update:model-value="act(entryChanged)"
            />
            <SearchSelect
              v-model="form.targetMachineId"
              label="落地机器"
              :options="machineOptions"
              :disabled="busy"
              @update:model-value="act(targetChanged)"
            />
            <SearchSelect
              v-model="form.targetNodeId"
              label="落地节点"
              :options="targetOptions"
              :disabled="busy || !form.targetMachineId"
            />
            <p class="muted">
              入口接收客户端连接，落地节点负责访问目标。待重启的落地节点需要先在机器页面应用。
            </p>
            <p v-if="!machines.length" class="notice">
              尚无可管理机器。<a href="#/machines">先添加机器并接入 Agent →</a>
            </p>
          </template>
          <template v-else-if="step === 2">
            <div class="endpoint-summary">
              <span>入口：{{ machineName(form.entryMachineId) }}</span
              ><span
                >落地：{{ machineName(form.targetMachineId) }} /
                {{ nodeName(form.targetMachineId, form.targetNodeId) }}</span
              ><button type="button" class="linkish" @click="step = 1">更换</button>
            </div>
            <section>
              <h2>连接方式</h2>
              <div class="kind-options">
                <button
                  v-for="kind in ['forward', 'protocol', 'tunnel'] as const"
                  :key="kind"
                  type="button"
                  :class="{ selected: form.kind === kind }"
                  :aria-pressed="form.kind === kind"
                  @click="changeKind(kind)"
                >
                  <span
                    >{{ kinds[kind]
                    }}<b aria-hidden="true">{{ form.kind === kind ? '●' : '○' }}</b></span
                  ><small>{{ kindHints[kind] }}</small>
                </button>
              </div>
            </section>
            <section>
              <h2>入口配置</h2>
              <SearchSelect
                v-if="form.kind === 'protocol'"
                :model-value="form.entryNodeId ?? ''"
                label="入口节点"
                :options="entryOptions"
                :disabled="busy"
                @update:model-value="
                  form!.entryNodeId = $event;
                  entryNodeChanged();
                "
              />
              <div class="form-grid">
                <label
                  >对外连接地址<input
                    v-model="form.address"
                    aria-label="入口连接地址"
                    required
                    maxlength="253"
                    :readonly="form.kind === 'protocol'"
                    placeholder="客户端可访问的 IP 或域名" /></label
                ><label class="port-field"
                  >入口端口<input
                    v-model.number="form.listenPort"
                    aria-label="入口端口"
                    type="number"
                    required
                    min="1"
                    max="65535"
                    :readonly="form.kind === 'protocol'"
                /></label>
              </div>
              <p class="muted">
                {{
                  form.kind === 'protocol'
                    ? '地址和端口来自所选入口节点，认证信息保持不变。'
                    : '已知的单一连接地址会作为候选值填入，请核对客户端是否可达。'
                }}
              </p>
            </section>
            <section v-if="form.kind === 'tunnel'" aria-label="隧道路径">
              <h2>隧道路径</h2>
              <p class="muted">按顺序经过下列机器；每跳地址需要能从上一跳访问。</p>
              <fieldset v-for="(hop, index) in form.hops" :key="index" class="hop-fields">
                <legend>
                  第 {{ index + 1 }} 跳{{
                    hop.machineId === form.targetMachineId ? ' · 落地机器' : ''
                  }}
                </legend>
                <SearchSelect
                  v-model="hop.machineId"
                  :label="'第 ' + (index + 1) + ' 跳机器'"
                  :options="hopOptions(index)"
                  @update:model-value="hop.address = candidateAddress(hop.machineId)"
                />
                <div class="form-grid">
                  <label>可达地址<input v-model="hop.address" required maxlength="253" /></label
                  ><label class="port-field"
                    >隧道端口<input
                      v-model.number="hop.port"
                      type="number"
                      required
                      min="1"
                      max="65535"
                  /></label>
                </div>
                <details class="hop-menu">
                  <summary :aria-label="'第 ' + (index + 1) + ' 跳操作'">⋯</summary>
                  <div class="hop-actions">
                    <button
                      type="button"
                      :disabled="index === 0 || hop.machineId === form.targetMachineId"
                      @click="moveHop(index, -1)"
                    >
                      上移</button
                    ><button
                      type="button"
                      :disabled="
                        index === form.hops.length - 1 ||
                        form.hops[index + 1]?.machineId === form.targetMachineId
                      "
                      @click="moveHop(index, 1)"
                    >
                      下移</button
                    ><button type="button" class="linkish" @click="form!.hops.splice(index, 1)">
                      移除此跳
                    </button>
                  </div>
                </details>
              </fieldset>
              <button type="button" :disabled="form.hops.length >= 8" @click="addHop">
                ＋ 添加中间节点
              </button>
            </section>
            <details v-if="form.kind !== 'protocol'">
              <summary>
                高级选项
                <small
                  >{{ form.network === 'both' ? 'TCP + UDP' : form.network.toUpperCase() }} ·
                  {{ { dual: '双栈', ipv4: 'IPv4', ipv6: 'IPv6' }[form.family] }}</small
                >
              </summary>
              <div class="form-grid">
                <label
                  >网络协议<select v-model="form.network" aria-label="网络协议">
                    <option value="both">TCP + UDP</option>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select></label
                ><label
                  >地址族<select v-model="form.family" aria-label="地址族">
                    <option value="dual">双栈</option>
                    <option value="ipv4">IPv4</option>
                    <option value="ipv6">IPv6</option>
                  </select></label
                >
              </div>
            </details>
          </template>
          <template v-else>
            <h2>{{ editing ? '核对本次修改' : '核对线路配置' }}</h2>
            <dl class="review-fields">
              <dt>线路名称</dt>
              <dd>{{ form.name }}</dd>
              <dt>连接方式</dt>
              <dd>{{ kinds[form.kind] }}</dd>
              <dt>入口</dt>
              <dd>
                {{ machineName(form.entryMachineId) }} ·
                {{ endpoint(form.address, form.listenPort) }}
              </dd>
              <dt>落地</dt>
              <dd>
                {{ machineName(form.targetMachineId) }} /
                {{ nodeName(form.targetMachineId, form.targetNodeId) }}
              </dd>
              <dt>完整路径</dt>
              <dd>{{ path(form) }}</dd>
            </dl>
            <div v-if="editing" class="change-list">
              <h3>{{ changedFields.length }} 项修改</h3>
              <p v-if="!changedFields.length" class="muted">配置没有变化。</p>
              <div v-for="change in changedFields" :key="change.key">
                <strong>{{ change.label }}</strong
                ><span>{{ change.before }} → {{ change.after }}</span>
              </div>
            </div>
            <p class="notice">
              {{
                editing
                  ? '保留线路身份和已有引用，按步骤更新相关机器。更换入口、类型或路径可能短暂中断连接；失败时保留执行结果，可继续处理。'
                  : '将按路径下发任务。应用完成表示机器已确认配置，端到端连通性仍需测试。'
              }}
            </p>
          </template>
        </form>
        <aside class="panel path-preview" aria-label="路径预览">
          <h2>路径预览</h2>
          <div class="topology">
            <div class="path-node client">客户端</div>
            <span class="arrow" aria-hidden="true">↓</span>
            <div class="path-node">
              <div>
                <strong>{{
                  form.entryMachineId ? machineName(form.entryMachineId) : '选择入口机器'
                }}</strong
                ><span class="role-label">入口</span>
              </div>
              <small>{{ endpoint(form.address, form.listenPort) }}</small>
            </div>
            <template v-for="(hop, index) in form.kind === 'tunnel' ? form.hops : []" :key="index"
              ><span class="arrow" aria-hidden="true">↓</span>
              <div class="path-node">
                <div>
                  <strong>{{ hop.machineId ? machineName(hop.machineId) : '选择经过机器' }}</strong
                  ><span class="role-label">{{
                    hop.machineId === form.targetMachineId ? '落地' : '中转'
                  }}</span>
                </div>
                <small>加密隧道 · {{ hop.port }}</small
                ><small v-if="hop.machineId === form.targetMachineId"
                  >{{ nodeName(form.targetMachineId, form.targetNodeId) }} ·
                  {{ targetNode?.port || '—' }}</small
                >
              </div></template
            ><template
              v-if="form.kind !== 'tunnel' || form.hops.at(-1)?.machineId !== form.targetMachineId"
              ><span class="arrow" aria-hidden="true">↓</span>
              <div class="path-node">
                <div>
                  <strong>{{
                    form.targetMachineId ? machineName(form.targetMachineId) : '选择落地机器'
                  }}</strong
                  ><span class="role-label">落地</span>
                </div>
                <small>{{
                  form.targetNodeId
                    ? nodeName(form.targetMachineId, form.targetNodeId)
                    : '选择落地节点'
                }}</small>
              </div></template
            >
          </div>
          <p v-if="offlineNames.length" class="notice is-warning">
            {{ offlineNames.join('、') }} 离线，任务会等待连接。
          </p>
          <div class="preview-note">
            <strong>尚未应用此配置</strong>
            <p>提交后可查看每台机器的执行结果。</p>
          </div>
        </aside>
      </div>
      <footer class="wizard-footer">
        <span>{{ editing ? '修改现有线路' : '新建线路' }} · 第 {{ step }} / 3 步</span>
        <div class="actions">
          <button
            v-if="step > 1"
            :disabled="busy"
            @click="
              step--;
              message = '';
            "
          >
            上一步</button
          ><button
            form="relay-route-form"
            class="primary"
            :disabled="busy || (step === 3 && (conflict || (!!editing && !changedFields.length)))"
          >
            {{
              busy
                ? '正在处理…'
                : step === 1
                  ? '选择连接方式'
                  : step === 2
                    ? '核对配置'
                    : editing
                      ? '保存并应用修改'
                      : '创建并应用线路'
            }}
          </button>
        </div>
      </footer>
    </template>
    <template v-else-if="selected">
      <div class="breadcrumb">
        <button @click="writeLocation()">中转线路</button><span>/ {{ selected.name }}</span>
      </div>
      <header class="page-header">
        <div>
          <h1>{{ selected.name }}</h1>
          <p class="muted">
            {{ kinds[selected.kind] }} · 入口 {{ endpoint(selected.address, selected.listenPort) }}
          </p>
        </div>
        <div class="actions">
          <button
            class="primary"
            :disabled="busy || !editable(selected)"
            @click="writeLocation(queryFor({ edit: selected.id }))"
          >
            编辑配置</button
          ><button
            :disabled="
              busy || ['pending', 'applying', 'deleting', 'deleted'].includes(selected.status)
            "
            @click="act(() => apply(selected!))"
          >
            {{ selected.status === 'failed' ? '继续 / 重试应用' : '重新应用' }}</button
          ><button
            class="danger"
            :disabled="busy || ['deleting', 'deleted'].includes(selected.status)"
            @click="
              deleting = selected;
              message = '';
            "
          >
            删除线路
          </button>
        </div>
      </header>
      <p v-if="message" class="notice" :class="{ 'is-error': failed }" role="status">
        {{ message }}
      </p>
      <div class="panel route-overview">
        <div class="status-line">
          <span class="state-pill" :data-state="selected.status">{{
            statuses[selected.status]
          }}</span
          ><span>{{ healthLabels[selected.health] }}</span>
        </div>
        <p>{{ selected.message }}</p>
        <div class="route-path">{{ path(selected) }}</div>
        <div class="actions">
          <a :href="machineLink(selected.entryMachineId)">查看入口机器 →</a
          ><a :href="machineLink(selected.targetMachineId)">查看落地机器 →</a
          ><a v-if="selected.outputResourceId" :href="nodeLink(selected)"
            >{{ selected.kind === 'tunnel' ? '查看生成节点 / 测试' : '查看入口节点 / 测试' }} →</a
          >
        </div>
      </div>
      <section class="panel">
        <h2>任务与执行结果</h2>
        <p v-if="!selected.taskIds.length" class="muted">等待编排任务。</p>
        <p v-else-if="!tasks(selected).length" class="muted">正在读取机器任务记录。</p>
        <ol class="task-timeline">
          <li v-for="task in tasks(selected)" :key="task.id">
            <span class="state-pill" :data-state="task.status">{{
              machineStatusLabels[task.status]
            }}</span>
            <div>
              <strong
                >{{ task.machineName }} ·
                {{ machineActionLabels[task.action] || task.action }}</strong
              >
              <p>{{ task.message || '等待机器执行' }}</p>
            </div>
            <a :href="'#/machines?machine=' + task.machineId + '&tab=tasks'">机器任务 →</a>
          </li>
        </ol>
      </section>
    </template>
    <template v-else>
      <header class="page-header">
        <div>
          <h1>中转线路</h1>
          <p class="muted">查看入口、落地和执行状态，集中调整流量路径。</p>
        </div>
        <div class="actions">
          <button :disabled="busy || loading" @click="act(refresh)">刷新线路</button
          ><button
            class="primary"
            aria-label="添加线路"
            @click="writeLocation(queryFor({ create: '1' }))"
          >
            ＋ 添加线路
          </button>
        </div>
      </header>
      <p v-if="message" class="notice" :class="{ 'is-error': failed }" role="status">
        {{ message }}
      </p>
      <p v-if="draft" class="notice">
        有未完成的线路配置。<button @click="resumeDraft">继续编辑</button
        ><button class="linkish" @click="draft = null">丢弃草稿</button>
      </p>
      <div class="route-filters">
        <input
          v-model="search"
          aria-label="搜索线路"
          placeholder="搜索线路、机器或入口地址"
          @input="filterLocation"
        /><select v-model="status" aria-label="线路状态" @change="filterLocation">
          <option value="">全部未删除线路</option>
          <option v-for="(label, value) in statuses" :key="value" :value="value">
            {{ label }}
          </option>
        </select>
      </div>
      <div class="panel route-list" aria-label="中转线路列表">
        <p v-if="!filtered.length" class="empty-state">
          {{
            routes.length
              ? '没有符合条件的线路。'
              : '尚未创建线路，选择入口机器和落地节点即可开始。'
          }}
        </p>
        <article v-for="route in filtered" :key="route.id" class="relay-route">
          <div class="route-main">
            <button class="route-title" @click="showRoute(route)">{{ route.name }}</button>
            <p class="muted">
              {{ kinds[route.kind] }} · {{ endpoint(route.address, route.listenPort) }}
            </p>
            <p class="route-path">{{ path(route) }}</p>
          </div>
          <div class="route-state">
            <span class="state-pill" :data-state="route.status">{{ statuses[route.status] }}</span
            ><small>{{ healthLabels[route.health] }}</small>
          </div>
          <div class="actions">
            <button @click="showRoute(route)">详情</button
            ><button
              :disabled="busy || !editable(route)"
              @click="writeLocation(queryFor({ edit: route.id }))"
            >
              编辑
            </button>
          </div>
        </article>
      </div>
      <p class="muted">共 {{ filtered.length }} 条线路</p>
    </template>
    <ModalDialog v-if="deleting" label="删除中转线路" :dismissible="!busy" @close="deleting = null"
      ><h2>删除 {{ deleting.name }}</h2>
      <p>将按步骤撤销此线路创建的转发、关联与隧道，仅清理本线路资源。仍被引用的节点会受到保护。</p>
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
  gap: var(--space-5);
  max-width: 1500px;
  margin: 0 auto;
}
.page-header {
  margin-bottom: 0;
  align-items: center;
}
.page-header h1 {
  font-size: var(--text-title);
}
.page-header p {
  margin-top: var(--space-2);
}
.actions,
.breadcrumb,
.status-line {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
}
.actions a {
  color: var(--text);
  font-size: var(--text-sm);
}
.breadcrumb button {
  color: var(--primary);
  font-size: var(--text-sm);
}
.breadcrumb {
  font-size: var(--text-sm);
  color: var(--muted);
}
.breadcrumb button {
  border: 0;
  padding: 0;
  background: none;
}
.wizard-steps {
  display: flex;
  padding: 0;
  margin: 0;
  list-style: none;
  gap: var(--space-5);
}
.wizard-steps li {
  flex: 1;
  border-bottom: var(--focus-width) solid var(--border);
  padding-bottom: var(--space-3);
}
.wizard-steps button {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  border: 0;
  padding: var(--space-1) 0;
  background: none;
  color: var(--muted);
}
.wizard-steps button span {
  display: grid;
  place-items: center;
  border-radius: var(--radius-pill);
  width: 30px;
  height: 30px;
  background: var(--border);
}
.wizard-steps .current,
.wizard-steps .complete {
  border-color: var(--primary);
}
.wizard-steps .current button,
.wizard-steps .complete button {
  color: var(--primary);
}
.wizard-steps .current span,
.wizard-steps .complete span {
  background: var(--primary);
  color: var(--on-primary);
}
.wizard-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.42fr);
  gap: var(--space-5);
  align-items: start;
}
.wizard-form {
  display: grid;
  gap: var(--space-6);
  padding: var(--space-6);
}
.wizard-form h2 {
  font-size: var(--text-md);
  margin-bottom: var(--space-4);
}
.wizard-form > h2 {
  margin: 0;
}
.wizard-form section {
  display: grid;
  gap: var(--space-3);
}
.wizard-form section > h2 {
  margin-bottom: 0;
}
.endpoint-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg);
  border-radius: var(--radius);
  align-items: center;
  font-size: var(--text-sm);
}
.endpoint-summary button {
  margin-left: auto;
}
.kind-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}
.kind-options button {
  text-align: left;
  color: var(--text);
  padding: var(--space-4) var(--space-3);
  display: grid;
  gap: var(--space-3);
}
.kind-options button > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.kind-options b {
  font-size: var(--text-md);
  color: var(--muted);
}
.kind-options .selected {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.kind-options .selected b {
  color: var(--primary);
}
small {
  color: var(--muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-normal);
  line-height: var(--line-height);
}
.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(100px, 0.32fr);
  gap: var(--space-4);
}
.form-grid input[readonly] {
  background: var(--bg);
  color: var(--muted);
}
.hop-fields {
  display: grid;
  gap: var(--space-3);
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  margin: 0;
  min-width: 0;
}
.hop-fields legend {
  color: var(--primary);
  padding-inline: var(--space-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
}
.hop-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}
.hop-menu {
  position: relative;
  justify-self: end;
}
.hop-menu > summary {
  list-style: none;
  padding: var(--space-2);
  font-size: var(--text-xl);
  line-height: var(--line-tight);
}
.hop-menu > summary::-webkit-details-marker {
  display: none;
}
.hop-menu .hop-actions {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: var(--z-popover);
  display: grid;
  min-width: 110px;
  gap: var(--space-1);
  padding: var(--space-2);
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-popover);
}
@media (min-width: 1200px) {
  .hop-fields {
    grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.1fr) 28px;
    align-items: end;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-3) var(--space-4);
  }
  .hop-fields .form-grid {
    grid-template-columns: minmax(0, 1fr) 78px;
    gap: var(--space-3);
  }
}
.hop-actions button {
  font-size: var(--text-xs);
}
summary {
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
  padding-block: var(--space-3);
}
summary small {
  margin-left: var(--space-3);
}
.path-preview {
  position: sticky;
  top: 0;
  padding: var(--space-5);
  display: grid;
  gap: var(--space-5);
}
.topology {
  display: grid;
  justify-items: center;
  background: var(--bg);
  padding: var(--space-4);
  border-radius: var(--radius);
}
.path-node {
  width: 100%;
  background: var(--surface);
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-1);
  overflow-wrap: anywhere;
}
.path-node > div {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  justify-content: space-between;
}
.path-node strong {
  font-size: var(--text-sm);
}
.path-node.client {
  width: auto;
  padding: var(--space-3) var(--space-8);
  font-size: var(--text-base);
}
.role-label {
  color: var(--primary);
  background: var(--row-active);
  border-radius: var(--radius-xs);
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.arrow {
  color: var(--primary);
  font-size: var(--text-title);
  padding: var(--space-2);
}
.preview-note {
  background: var(--bg);
  border-radius: var(--radius);
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--muted);
}
.preview-note p {
  margin: var(--space-2) 0 0;
  line-height: var(--line-height);
}
.wizard-footer {
  position: sticky;
  bottom: calc(-1 * var(--space-8));
  z-index: var(--z-sticky);
  background: var(--surface);
  border-top: var(--border-width) solid var(--border);
  padding: var(--space-4) var(--space-6);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  box-shadow: var(--shadow-footer);
}
.wizard-footer > span {
  color: var(--muted);
  font-size: var(--text-xs);
}
.review-fields {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: var(--space-5);
  margin: 0;
  font-size: var(--text-base);
}
.review-fields dt {
  color: var(--muted);
}
.review-fields dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.change-list {
  padding: var(--space-4);
  border: var(--border-width) solid var(--warn-border);
  background: var(--warn-bg);
  border-radius: var(--radius);
  display: grid;
  gap: var(--space-3);
}
.change-list > div {
  display: grid;
  gap: var(--space-1);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.change-list span {
  color: var(--muted);
}
.is-warning {
  background: var(--warn-bg);
  color: var(--warn-text);
  border-color: var(--warn-border);
}
.route-filters {
  display: flex;
  gap: var(--space-3);
}
.route-filters input {
  flex: 1;
}
.route-filters select {
  width: 200px;
}
.route-list {
  padding: 0 var(--space-5);
}
.relay-route {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px auto;
  gap: var(--space-5);
  padding: var(--space-5) 0;
  align-items: center;
  border-bottom: var(--border-width) solid var(--border);
}
.relay-route:last-child {
  border: 0;
}
.route-title {
  border: 0;
  background: none;
  padding: 0;
  color: var(--primary);
  font-size: var(--text-md);
  text-align: left;
  overflow-wrap: anywhere;
}
.route-main .muted {
  margin-top: var(--space-2);
}
.route-path {
  font-size: var(--text-sm);
  line-height: var(--line-height);
  overflow-wrap: anywhere;
  color: var(--text);
  margin: var(--space-2) 0 0;
}
.route-state {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
}
.state-pill {
  display: inline-flex;
  width: fit-content;
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  background: var(--neutral-bg);
  color: var(--muted);
}
.state-pill[data-state='active'],
.state-pill[data-state='applied'] {
  color: var(--ok-text);
  background: var(--ok-bg);
}
.state-pill[data-state='pending'],
.state-pill[data-state='pending_restart'],
.state-pill[data-state='applying'],
.state-pill[data-state='stale'] {
  color: var(--warn-text);
  background: var(--warn-bg);
}
.state-pill[data-state='failed'],
.state-pill[data-state='conflict'],
.state-pill[data-state='unknown'] {
  color: var(--danger);
  background: var(--danger-bg);
}
.route-overview {
  display: grid;
  gap: var(--space-4);
  font-size: var(--text-sm);
}
.route-overview p {
  margin: 0;
}
.route-overview .route-path {
  background: var(--bg);
  padding: var(--space-5);
  border-radius: var(--radius);
  font-size: var(--text-md);
}
.task-timeline {
  list-style: none;
  padding: 0;
  margin: var(--space-4) 0 0;
}
.task-timeline li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding-block: var(--space-4);
  border-bottom: var(--border-width) solid var(--border);
  font-size: var(--text-sm);
}
.task-timeline li > div {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.task-timeline p {
  margin: var(--space-2) 0 0;
  color: var(--muted);
  line-height: var(--line-height);
}
.task-timeline a {
  white-space: nowrap;
  color: var(--primary);
}
.empty-state {
  padding: var(--space-8) var(--space-3);
  text-align: center;
  color: var(--muted);
  font-size: var(--text-base);
}
@media (max-width: 1150px) {
  .wizard-layout {
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: var(--space-3);
  }
  .wizard-form {
    padding: var(--space-5);
  }
  .kind-options {
    grid-template-columns: 1fr;
  }
  .kind-options button {
    gap: var(--space-1);
    padding: var(--space-3);
  }
  .relay-route {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .route-state {
    grid-column: 1;
    grid-row: 2;
  }
  .relay-route > .actions {
    grid-column: 2;
    grid-row: 1 / 3;
  }
}
@media (max-width: 800px) {
  .wizard-layout {
    grid-template-columns: 1fr;
  }
  .path-preview {
    position: static;
  }
  .wizard-steps {
    gap: var(--space-2);
  }
  .wizard-steps button {
    flex-direction: column;
    font-size: var(--text-xs);
    align-items: flex-start;
    line-height: var(--line-height);
  }
  .wizard-footer {
    bottom: calc(-1 * var(--space-4));
    padding: var(--space-3) 0;
  }
  .wizard-footer > span {
    display: none;
  }
  .wizard-footer .actions {
    width: 100%;
    justify-content: flex-end;
  }
  .route-filters {
    flex-wrap: wrap;
  }
  .route-filters input,
  .route-filters select {
    width: 100%;
    flex-basis: 100%;
  }
  .relay-route {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }
  .route-state {
    display: flex;
    align-items: center;
  }
  .relay-route > .actions {
    justify-content: flex-end;
  }
  .task-timeline li {
    flex-wrap: wrap;
  }
  .task-timeline li > div {
    min-width: 150px;
  }
  .review-fields {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }
  .review-fields dd {
    margin-bottom: var(--space-3);
  }
}
</style>
