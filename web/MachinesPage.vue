<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { z } from 'zod';
import {
  machineDetailSchema,
  machineTaskSchema,
  machineViewSchema,
  relayRouteSchema,
  type MachineAction,
  type MachineDetail,
  type MachineTask,
  type MachineView,
  type RelayRoute,
} from '../server/shared/machines';
import { ApiError } from './api';
import ModalDialog from './ui/ModalDialog.vue';
import MachineNodeEditor from './MachineNodeEditor.vue';
import MachineNodeCreator from './MachineNodeCreator.vue';
import { nodeProtocol, type MachineNode } from './machineEditor';
import {
  fieldOptions,
  machineActions,
  machineActionLabels,
  machineParams,
  machineStatusLabels,
  type MachineActionDefinition,
  type MachineField,
} from './machineActions';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
type MachineTab = 'nodes' | 'relays' | 'cores' | 'tasks' | 'settings';
type MachineStatus = 'all' | 'online' | 'offline' | 'pending' | 'disabled';
const tabs: { id: MachineTab; label: string }[] = [
  { id: 'nodes', label: '节点' },
  { id: 'relays', label: '中转' },
  { id: 'cores', label: '内核与 DNS' },
  { id: 'tasks', label: '任务记录' },
  { id: 'settings', label: '机器设置' },
];
const machines = ref<MachineView[]>([]),
  selectedId = ref(''),
  detail = ref<MachineDetail | null>(null);
const tab = ref<MachineTab>('nodes'),
  query = ref(''),
  status = ref<MachineStatus>('all');
const nodeQuery = ref(''),
  nodeCore = ref(''),
  nodeProfile = ref(''),
  editingId = ref(''),
  focusedNodeId = ref('');
const editingFallback = ref<MachineNode | null>(null);
const editorTrigger = shallowRef<{ nodeId: string; element: HTMLElement } | null>(null);
const addingNode = ref(false),
  creatorHidden = ref(false),
  preparingNodeCore = ref(false),
  preparationTask = ref<MachineTask | null>(null);
const creatorTrigger = shallowRef<HTMLElement | null>(null);
const routes = ref<RelayRoute[]>([]),
  relayError = ref('');
const busy = ref(false),
  loading = ref(false),
  message = ref('');
const creating = ref(false),
  machineName = ref(''),
  renaming = ref(false),
  renameValue = ref('');
const token = ref<{ machine: MachineView; token: string } | null>(null),
  copyMessage = ref('');
const tokenInput = ref<HTMLInputElement | null>(null),
  commandInput = ref<HTMLTextAreaElement | null>(null);
const advanced = ref(false),
  submittedTask = ref<MachineTask | null>(null);
const actionForm = ref<{
  definition: MachineActionDefinition;
  revision: string;
  installDeps: boolean;
  values: Record<string, string | string[] | boolean>;
} | null>(null);
let alive = true;
let timer: ReturnType<typeof setInterval> | undefined;
let detailRequest = 0;
const snapshot = computed(() => detail.value?.snapshot);
const reportedAddresses = computed(() => [
  ...new Set(
    (snapshot.value?.nodes || []).flatMap((node) =>
      typeof node.address === 'string' && node.address.trim() && node.address !== '[已隐藏]'
        ? [node.address.trim()]
        : [],
    ),
  ),
]);
const canCommand = computed(
  () => !!detail.value?.machine.enabled && !!detail.value.machine.revision && !!snapshot.value,
);
const availableActions = computed(() =>
  machineActions.filter((item) => snapshot.value?.capabilities.actions.includes(item.action)),
);
const formChanged = computed(
  () => !!actionForm.value && actionForm.value.revision !== detail.value?.machine.revision,
);
const editorNode = computed(
  () =>
    snapshot.value?.nodes.find((node) => node.id === editingId.value) ||
    (editingFallback.value?.id === editingId.value ? editingFallback.value : undefined),
);
const editorReturnFocus = computed(() =>
  editorTrigger.value?.nodeId === editingId.value ? (editorTrigger.value?.element ?? null) : null,
);
const recentTask = computed(
  () =>
    detail.value?.tasks.find((task) => task.id === submittedTask.value?.id) ||
    submittedTask.value ||
    detail.value?.tasks[0],
);
const relatedRoutes = computed(() =>
  routes.value.filter(
    (route) =>
      route.status !== 'deleted' &&
      [
        route.entryMachineId,
        route.targetMachineId,
        ...route.hops.map((hop) => hop.machineId),
      ].includes(selectedId.value),
  ),
);
const protocolOptions = computed(() => [...new Set(snapshot.value?.nodes.map(nodeProtocol) || [])]);
const filteredNodes = computed(() =>
  (snapshot.value?.nodes || []).filter((node) => {
    const needle = nodeQuery.value.trim().toLocaleLowerCase();
    return (
      (!nodeCore.value || node.core === nodeCore.value) &&
      (!nodeProfile.value || nodeProtocol(node) === nodeProfile.value) &&
      (!needle ||
        [node.name, node.profile, node.address, node.id].some(
          (value) => typeof value === 'string' && value.toLocaleLowerCase().includes(needle),
        ))
    );
  }),
);
const needsAttention = (machine: MachineView) =>
  !!machine.syncError ||
  !!machine.summary?.pendingCores.length ||
  (machine.enabled && !machine.online);
const matchesStatus = (machine: MachineView, value: MachineStatus) =>
  value === 'all' ||
  (value === 'disabled'
    ? !machine.enabled
    : value === 'pending'
      ? needsAttention(machine)
      : machine.enabled && (value === 'online' ? machine.online : !machine.online));
const counts = computed(() => ({
  all: machines.value.length,
  online: machines.value.filter((machine) => matchesStatus(machine, 'online')).length,
  offline: machines.value.filter((machine) => matchesStatus(machine, 'offline')).length,
  pending: machines.value.filter(needsAttention).length,
}));
const filteredMachines = computed(() =>
  machines.value.filter((machine) => {
    const needle = query.value.trim().toLocaleLowerCase();
    return (
      matchesStatus(machine, status.value) &&
      (!needle ||
        [machine.name, ...(machine.summary?.addresses || [])].some((value) =>
          value.toLocaleLowerCase().includes(needle),
        ))
    );
  }),
);
const statusChoices: { id: MachineStatus; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'online', label: '在线' },
  { id: 'offline', label: '离线' },
  { id: 'pending', label: '待处理' },
];
const machineStatus = (machine: MachineView) =>
  !machine.enabled ? '已禁用' : machine.online ? '在线' : '离线';
const errorText = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && /REVISION|CONFLICT/.test(error.code)
    ? '版本冲突：状态已变化，请核对最新快照。' + error.message
    : error instanceof Error
      ? error.message
      : '操作失败。';
const when = (value: number | null) =>
  value === null ? '尚未上报' : new Date(value).toLocaleString();
function since(value: number | null) {
  if (value === null) return '尚未上报';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  return seconds < 60
    ? seconds + ' 秒前'
    : seconds < 3600
      ? Math.floor(seconds / 60) + ' 分钟前'
      : seconds < 86400
        ? Math.floor(seconds / 3600) + ' 小时前'
        : Math.floor(seconds / 86400) + ' 天前';
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const installCommand = computed(() =>
  token.value
    ? [
        'curl --fail --show-error --silent ' +
          shellQuote(location.origin + '/agent/install.sh') +
          ' | bash -s --',
        '--server ' + shellQuote(location.origin),
        '--machine-id ' + shellQuote(token.value.machine.id),
        '--token ' + shellQuote(token.value.token),
        ...(location.protocol === 'http:' ? ['--allow-http'] : []),
      ].join(' ')
    : '',
);
const recordId = (record: Record<string, unknown>) =>
  typeof record.id === 'string' ? record.id : '';
const labelOf = (record: Record<string, unknown>) => String(record.name || record.id || '未命名');
function visibleFields(record: Record<string, unknown>) {
  return Object.entries(record)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        !/password|credential|secret|token|private|uri|uuid|(?:^|_)key(?:$|_)/i.test(key),
    )
    .map(([key, value]) => [key, typeof value === 'object' ? safeSummary(value) : String(value)]);
}
function safeSummary(value: unknown): string {
  if (Array.isArray(value)) return value.map(safeSummary).join('、');
  if (value && typeof value === 'object')
    return visibleFields(value as Record<string, unknown>)
      .map(([key, item]) => key + '：' + item)
      .join(' · ');
  return String(value ?? '');
}
function endpoint(node: MachineNode) {
  const address = typeof node.address === 'string' ? node.address : '未知';
  return (
    (address.includes(':') ? '[' + address + ']' : address) +
    ':' +
    (typeof node.port === 'number' ? node.port : '未知')
  );
}
function nodeState(node: MachineNode) {
  const core = snapshot.value?.cores.find((core) => core.core === node.core);
  if (snapshot.value?.pendingCores.includes(node.core) || core?.pending_restart) return '待重启';
  return !core ? '状态未知' : !core.running ? '未运行' : '已应用';
}
function routesForNode(node: MachineNode) {
  return relatedRoutes.value.filter(
    (route) =>
      (route.targetMachineId === selectedId.value && route.targetNodeId === node.id) ||
      (route.entryMachineId === selectedId.value && route.entryNodeId === node.id),
  );
}
function routeParams() {
  return new URLSearchParams(location.hash.split('?')[1] || '');
}
function machineHash(id = selectedId.value, nextTab = tab.value, node = '', edit = false) {
  const params = new URLSearchParams();
  if (id) {
    params.set('machine', id);
    params.set('tab', nextTab);
    if (node) params.set('node', node);
    if (edit) params.set('edit', '1');
  } else {
    if (query.value) params.set('q', query.value);
    if (status.value !== 'all') params.set('status', status.value);
  }
  return '#/machines' + (params.size ? '?' + params.toString() : '');
}
function navigateMachine(id = '', nextTab: MachineTab = 'nodes') {
  location.hash = machineHash(id, nextTab);
}
function navigateTab(nextTab: MachineTab) {
  location.hash = machineHash(selectedId.value, nextTab);
}
function updateOverviewQuery() {
  history.replaceState(null, '', machineHash(''));
}
function chooseStatus(value: MachineStatus) {
  status.value = value;
  updateOverviewQuery();
}
function openEditor(node: MachineNode, trigger?: EventTarget | null) {
  editorTrigger.value =
    trigger instanceof HTMLElement ? { nodeId: node.id, element: trigger } : null;
  editingFallback.value = node;
  location.hash = machineHash(selectedId.value, 'nodes', node.id, true);
}
function closeEditor() {
  location.hash = machineHash(selectedId.value, tab.value);
}
function createRelay(node: MachineNode) {
  location.hash =
    '#/relays?' +
    new URLSearchParams({
      targetMachine: selectedId.value,
      targetNode: node.id,
      create: '1',
    }).toString();
}
function showGenerated() {
  if (detail.value)
    location.hash = '#/nodes?resource=' + encodeURIComponent(detail.value.machine.resourceId);
}
async function loadDetail(id: string) {
  if (!id) return;
  const request = ++detailRequest;
  const value = machineDetailSchema.parse(await props.api('/api/machines/' + id));
  if (alive && selectedId.value === id && request === detailRequest) {
    detail.value = value;
    const node = value.snapshot?.nodes.find((node) => node.id === editingId.value);
    if (node) editingFallback.value = node;
  }
}
async function loadRoutes() {
  try {
    const value = z
      .object({ routes: z.array(relayRouteSchema) })
      .parse(await props.api('/api/relays'));
    if (alive) {
      routes.value = value.routes;
      relayError.value = '';
    }
  } catch (error) {
    if (alive) relayError.value = '关联线路暂不可用：' + errorText(error);
  }
}
async function syncRoute(load = true) {
  if (location.hash.replace(/^#\/?/, '').split('?')[0] !== 'machines') return;
  const params = routeParams(),
    id = params.get('machine') || '';
  const valid = !id || z.string().uuid().safeParse(id).success;
  if (!valid) {
    message.value = '机器链接无效。';
    return;
  }
  const changed = selectedId.value !== id;
  if (changed) {
    message.value = '';
    selectedId.value = id;
    detail.value = null;
    actionForm.value = null;
    addingNode.value = false;
    creatorHidden.value = false;
    preparingNodeCore.value = false;
    preparationTask.value = null;
    creatorTrigger.value = null;
    submittedTask.value = null;
    editingFallback.value = null;
    editorTrigger.value = null;
    nodeQuery.value = '';
    nodeCore.value = '';
    nodeProfile.value = '';
  }
  const requestedTab = params.get('tab');
  tab.value = tabs.some((item) => item.id === requestedTab)
    ? (requestedTab as MachineTab)
    : 'nodes';
  focusedNodeId.value = params.get('node') || '';
  editingId.value = params.get('edit') === '1' ? focusedNodeId.value : '';
  if (editingFallback.value?.id !== editingId.value) editingFallback.value = null;
  const editingNode = snapshot.value?.nodes.find((node) => node.id === editingId.value);
  if (editingNode) editingFallback.value = editingNode;
  if (!id) {
    query.value = params.get('q') || '';
    const requestedStatus = params.get('status');
    status.value = ['all', 'online', 'offline', 'pending', 'disabled'].includes(
      requestedStatus || '',
    )
      ? (requestedStatus as MachineStatus)
      : 'all';
  }
  if (load && changed && id) {
    try {
      await Promise.all([loadDetail(id), loadRoutes()]);
    } catch (error) {
      if (alive) message.value = errorText(error);
    }
  }
}
async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    const value = z
      .object({ machines: z.array(machineViewSchema) })
      .parse(await props.api('/api/machines'));
    if (!alive) return;
    machines.value = value.machines;
    const id = selectedId.value;
    if (id) await Promise.all([loadDetail(id), loadRoutes()]);
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
async function createMachine() {
  const value = z
    .object({ machine: machineViewSchema, token: z.string().min(1) })
    .parse(await props.api('/api/machines', { name: machineName.value }));
  if (!alive) return;
  creating.value = false;
  machineName.value = '';
  token.value = value;
  copyMessage.value = '';
  navigateMachine(value.machine.id);
  await syncRoute();
  await refresh();
}
async function rotateToken() {
  if (!detail.value) return;
  const value = z
    .object({ machine: machineViewSchema, token: z.string().min(1) })
    .parse(await props.api('/api/machines/' + detail.value.machine.id + '/token', {}));
  if (!alive) return;
  token.value = value;
  copyMessage.value = '';
  await refresh();
}
async function updateMachine(body: { name?: string; enabled?: boolean }) {
  if (!detail.value) return;
  await props.api('/api/machines/' + detail.value.machine.id, body, 'PATCH');
  renaming.value = false;
  await refresh();
}
async function copy(value: string, input: HTMLInputElement | HTMLTextAreaElement | null) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      if (alive) copyMessage.value = '已复制。';
      return;
    }
  } catch {
    /* The selectable field remains available. */
  }
  input?.focus();
  input?.select();
  try {
    if (document.execCommand('copy')) {
      copyMessage.value = '已复制。';
      return;
    }
  } catch {
    /* Leave the field selected for manual copying. */
  }
  copyMessage.value = '无法自动复制，请从已选中的字段手动复制。';
}
function options(field: MachineField) {
  return snapshot.value && actionForm.value
    ? fieldOptions(
        field,
        snapshot.value,
        actionForm.value.definition.action,
        actionForm.value.values,
      )
    : [];
}
function normalizeChoices(changed = '') {
  if (!actionForm.value) return;
  const { values, definition } = actionForm.value;
  if (changed === 'profile' || (changed === 'id' && definition.action === 'node.switch'))
    values.core = '';
  if (changed === 'core' && definition.action === 'node.ip-policy') {
    values.id = [];
    values.profile = '';
  }
  for (const field of definition.fields) {
    if (!field.kind || field.kind === 'number' || field.kind === 'flag') continue;
    const available = options(field),
      current = values[field.key];
    if (Array.isArray(current))
      values[field.key] = current.filter((item) =>
        available.some((option) => option.value === item),
      );
    else if (current && !available.some((option) => option.value === current))
      values[field.key] = '';
    if (field.required && !field.multiple && !values[field.key] && available.length === 1)
      values[field.key] = available[0]!.value;
  }
}
function openAction(action: MachineAction, initial: Record<string, string | boolean> = {}) {
  if (action === 'node.add') {
    openNodeCreator();
    return;
  }
  if (action === 'node.edit' && typeof initial.id === 'string') {
    const node = snapshot.value?.nodes.find((node) => node.id === initial.id);
    if (node) openEditor(node);
    return;
  }
  const definition = availableActions.value.find((item) => item.action === action);
  if (!definition || !detail.value?.machine.revision) return;
  message.value = '';
  advanced.value = false;
  const values: Record<string, string | string[] | boolean> = { ...initial };
  for (const field of definition.fields)
    if (values[field.key] === undefined)
      values[field.key] = field.kind === 'flag' ? false : field.multiple ? [] : '';
  actionForm.value = {
    definition,
    revision: detail.value.machine.revision,
    installDeps: true,
    values,
  };
  normalizeChoices();
}
function openNodeCreator(trigger?: EventTarget | null) {
  if (!canCommand.value || !availableActions.value.some((item) => item.action === 'node.add'))
    return;
  creatorTrigger.value = trigger instanceof HTMLElement ? trigger : null;
  if (!addingNode.value) preparationTask.value = null;
  creatorHidden.value = false;
  addingNode.value = true;
}
function prepareNodeCore(core: 'sing-box' | 'xray', action: 'core.install' | 'core.update') {
  openAction(action, { core, 'release-channel': 'stable' });
  preparingNodeCore.value = !!actionForm.value;
}
function closeAction() {
  actionForm.value = null;
  preparingNodeCore.value = false;
}
function showCreatorTasks() {
  creatorHidden.value = true;
  navigateTab('tasks');
}
function resumeNodeCreator(trigger: EventTarget | null) {
  creatorTrigger.value = trigger instanceof HTMLElement ? trigger : null;
  creatorHidden.value = false;
}
async function queue(
  action: MachineAction,
  params: Record<string, string | string[] | number | boolean>,
  revision: string,
) {
  if (!detail.value) throw new Error('请先选择机器。');
  const id = detail.value.machine.id;
  const value = z.object({ task: machineTaskSchema }).parse(
    await props.api('/api/machines/' + id + '/commands', {
      action,
      params,
      expectedRevision: revision,
    }),
  );
  if (alive && selectedId.value === id) {
    submittedTask.value = value.task;
    detail.value.tasks = [
      value.task,
      ...detail.value.tasks.filter((task) => task.id !== value.task.id),
    ];
    try {
      await refresh();
    } catch {
      message.value = '任务已接收，最新状态暂时读取失败，请稍后刷新。';
    }
  }
  return value.task;
}
async function submitNodeEdit(
  params: Record<string, string | string[] | number | boolean>,
  revision: string,
) {
  return queue('node.edit', params, revision);
}
async function submitNodeAdd(
  params: Record<string, string | string[] | number | boolean>,
  revision: string,
) {
  try {
    return await queue('node.add', params, revision);
  } catch (error) {
    // A conflict may arrive before the next polling snapshot. Refresh without losing the draft.
    if (error instanceof ApiError && error.status === 409) await refresh().catch(() => {});
    throw error;
  }
}
async function submitAction() {
  if (!actionForm.value || !detail.value || !snapshot.value) return;
  const { definition, values, revision } = actionForm.value;
  if (formChanged.value) throw new Error('机器版本已变化。核对最新快照并采用最新版本后继续。');
  const params = machineParams(definition, values);
  if (actionForm.value.installDeps) params['install-deps'] = true;
  for (const field of definition.fields) {
    if (!params[field.key] || !field.kind || ['number', 'flag'].includes(field.kind)) continue;
    const selected = Array.isArray(params[field.key])
      ? (params[field.key] as string[])
      : [String(params[field.key])];
    if (selected.some((value) => !options(field).some((option) => option.value === value)))
      throw new Error(field.label + '已不可用，请重新选择。');
  }
  const task = await queue(definition.action, params, revision);
  if (preparingNodeCore.value) preparationTask.value = task;
  closeAction();
}
function coreActions(core: string) {
  return availableActions.value.filter(
    (item) =>
      item.group === '内核' &&
      snapshot.value &&
      fieldOptions(item.fields[0]!, snapshot.value, item.action, {}).some(
        (option) => option.value === core,
      ),
  );
}
function pendingAction(core: string): 'core.start' | 'core.restart' {
  return snapshot.value?.cores.find((item) => item.core === core)?.running
    ? 'core.restart'
    : 'core.start';
}
async function cancelTask(task: MachineTask) {
  await props.api('/api/machines/' + task.machineId + '/commands/' + task.id + '/cancel', {});
  await refresh();
}
function poll() {
  if (document.visibilityState === 'visible')
    void refresh().catch((error) => {
      if (alive) message.value = errorText(error);
    });
}
function onHashChange() {
  void syncRoute();
}
onMounted(async () => {
  await syncRoute(false);
  await act(refresh);
  if (!alive) return;
  timer = setInterval(poll, 5000);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('hashchange', onHashChange);
});
onBeforeUnmount(() => {
  alive = false;
  detailRequest++;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', poll);
  window.removeEventListener('hashchange', onHashChange);
  token.value = null;
  actionForm.value = null;
});
</script>

<template>
  <section class="page machines-page">
    <template v-if="!selectedId">
      <header class="page-header overview-header">
        <div>
          <h1>机器</h1>
          <p>集中查看机器状态与待处理事项</p>
        </div>
        <div class="actions">
          <button aria-label="刷新机器" :disabled="busy || loading" @click="act(refresh)">
            ↻ 刷新机器</button
          ><button
            class="primary"
            aria-label="添加机器"
            @click="
              creating = true;
              message = '';
            "
          >
            ＋ 添加机器
          </button>
        </div>
      </header>
      <div class="status-filters" aria-label="机器快捷筛选">
        <button
          v-for="choice in statusChoices"
          :key="choice.id"
          :class="{ active: status === choice.id }"
          :aria-pressed="status === choice.id"
          @click="chooseStatus(choice.id)"
        >
          {{ choice.label }} <span>{{ counts[choice.id as keyof typeof counts] }}</span>
        </button>
      </div>
      <div class="overview-toolbar">
        <label class="search-field"
          ><span aria-hidden="true">⌕</span
          ><input
            v-model="query"
            type="search"
            aria-label="搜索机器名称或连接地址"
            placeholder="搜索机器名称或连接地址"
            @input="updateOverviewQuery" /></label
        ><select v-model="status" aria-label="机器状态筛选" @change="updateOverviewQuery">
          <option value="all">全部状态</option>
          <option value="online">在线</option>
          <option value="offline">离线</option>
          <option value="pending">待处理</option>
          <option value="disabled">已禁用</option>
        </select>
      </div>
      <div v-if="counts.pending" class="attention-banner" role="status">
        <strong>! {{ counts.pending }} 台机器需要处理</strong
        ><button class="linkish" @click="chooseStatus('pending')">查看待处理 →</button
        ><button v-if="counts.offline" class="linkish" @click="chooseStatus('offline')">
          查看离线 →
        </button>
      </div>
      <p v-if="message" class="notice" role="status">{{ message }}</p>
      <div class="machine-list table-panel" aria-label="机器列表">
        <table class="data-table machine-table">
          <thead>
            <tr>
              <th>机器名称</th>
              <th>连接地址</th>
              <th>状态</th>
              <th>节点</th>
              <th>内核</th>
              <th>最近上报</th>
              <th class="right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="machine in filteredMachines" :key="machine.id" class="machine-row">
              <td data-label="机器名称" class="machine-name">
                <svg viewBox="0 0 20 26" aria-hidden="true">
                  <rect x="2" y="1" width="16" height="24" rx="3" />
                  <path d="M2 9h16M2 17h16M6 5h1M6 13h1M6 21h1" /></svg
                ><button class="name-link" @click="navigateMachine(machine.id)">
                  {{ machine.name }}
                </button>
              </td>
              <td data-label="连接地址">
                {{
                  machine.summary ? machine.summary.addresses.join('、') || '未上报地址' : '未知'
                }}
              </td>
              <td data-label="状态">
                <span
                  class="state-badge"
                  :class="machine.enabled && machine.online ? 'is-online' : 'is-neutral'"
                  ><i />{{ machineStatus(machine) }}</span
                ><span v-if="machine.summary?.pendingCores.length" class="state-badge is-pending"
                  >待重启</span
                ><span
                  v-if="machine.syncError"
                  class="state-badge is-pending"
                  :title="machine.syncError"
                  >同步异常</span
                >
              </td>
              <td data-label="节点">{{ machine.summary?.nodeCount ?? '未知' }}</td>
              <td data-label="内核">
                {{
                  machine.summary
                    ? machine.summary.cores
                        .filter((core) => core.installed)
                        .map((core) => core.core)
                        .join(' · ') || '未安装'
                    : '未知'
                }}
              </td>
              <td data-label="最近上报" :title="when(machine.lastSeen)">
                {{ since(machine.lastSeen) }}
              </td>
              <td class="row-actions">
                <button
                  class="linkish"
                  :aria-label="'管理 ' + machine.name"
                  @click="navigateMachine(machine.id)"
                >
                  查看 →
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!filteredMachines.length" class="empty-state">
          {{
            machines.length
              ? '没有符合条件的机器。'
              : '尚未添加机器。添加后将显示一次 Token 和安装命令。'
          }}
        </p>
      </div>
      <p class="list-count">
        共 {{ machines.length }} 台机器<span v-if="filteredMachines.length !== machines.length"
          >，当前显示 {{ filteredMachines.length }} 台</span
        >
      </p>
    </template>
    <template v-else>
      <nav class="breadcrumb" aria-label="机器位置">
        <button class="linkish" @click="navigateMachine()">机器</button><span>/</span
        ><span>{{ detail?.machine.name || '正在读取…' }}</span>
      </nav>
      <p v-if="!detail && !message" role="status">正在读取机器详情…</p>
      <section v-if="detail" class="machine-detail" aria-label="机器详情">
        <header class="page-header detail-header">
          <div>
            <div class="machine-title">
              <h1>{{ detail.machine.name }}</h1>
              <span
                class="state-badge"
                :class="
                  detail.machine.enabled && detail.machine.online ? 'is-online' : 'is-neutral'
                "
                ><i />{{ machineStatus(detail.machine) }}</span
              >
            </div>
            <p>
              {{
                detail.machine.summary?.addresses.join(' · ') ||
                snapshot?.nodes
                  .map((node) => node.address)
                  .filter(
                    (address, index, addresses) =>
                      typeof address === 'string' && addresses.indexOf(address) === index,
                  )
                  .join(' · ') ||
                '连接地址未知'
              }}
              <span>· 最近上报 {{ since(detail.machine.lastSeen) }}</span>
            </p>
          </div>
          <div class="actions">
            <select
              :value="selectedId"
              aria-label="切换机器"
              @change="navigateMachine(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="machine in machines" :key="machine.id" :value="machine.id">
                {{ machine.name }}
              </option>
            </select>
            <details class="action-menu">
              <summary aria-label="机器更多操作">⋯</summary>
              <div class="menu-items">
                <button @click="act(refresh)">刷新机器</button
                ><button @click="showGenerated">查看生成节点 / 测试</button
                ><button @click="navigateTab('settings')">机器设置</button>
              </div>
            </details>
          </div>
        </header>
        <p v-if="message" class="notice" role="status">{{ message }}</p>
        <div v-if="addingNode && creatorHidden" class="attention-banner">
          <span>添加节点的草稿与提交状态已保留。</span>
          <button type="button" @click="resumeNodeCreator($event.currentTarget)">
            返回添加节点
          </button>
        </div>
        <div v-if="snapshot?.pendingCores.length" class="attention-banner">
          <strong>! {{ snapshot.pendingCores.join('、') }} 有配置待应用</strong>
          <div class="actions">
            <button class="linkish" @click="navigateTab('tasks')">查看变更</button
            ><button
              v-for="core in snapshot.pendingCores"
              :key="core"
              :disabled="
                !canCommand || !availableActions.some((item) => item.action === pendingAction(core))
              "
              class="primary"
              @click="openAction(pendingAction(core), { core })"
            >
              {{ pendingAction(core) === 'core.restart' ? '重启并应用' : '启动并应用' }} {{ core }}
            </button>
          </div>
        </div>
        <p v-if="!detail.machine.enabled" class="notice">机器已禁用，启用后可继续下发任务。</p>
        <p v-else-if="!detail.machine.online" class="notice">
          机器离线，显示最近上报快照；新任务会排队等待 Agent 连接。
        </p>
        <div
          v-if="recentTask"
          class="inline-task"
          :class="{ 'task-warning': ['failed', 'conflict', 'unknown'].includes(recentTask.status) }"
          role="status"
        >
          <div>
            <strong
              >{{ machineActionLabels[recentTask.action] || recentTask.action }} ·
              {{ machineStatusLabels[recentTask.status] }}</strong
            ><span>{{ recentTask.message }}</span>
          </div>
          <button class="linkish" @click="navigateTab('tasks')">查看任务 →</button
          ><button
            v-if="recentTask.status === 'queued'"
            :disabled="busy"
            @click="act(() => cancelTask(recentTask!))"
          >
            取消排队
          </button>
        </div>
        <div class="detail-workspace">
          <div class="detail-tabs" role="tablist" aria-label="机器详情栏目">
            <button
              v-for="item in tabs"
              :id="'machine-tab-' + item.id"
              :key="item.id"
              type="button"
              role="tab"
              :aria-selected="tab === item.id"
              :aria-controls="'machine-panel-' + item.id"
              :class="{ active: tab === item.id }"
              @click="navigateTab(item.id)"
            >
              {{ item.label
              }}<span v-if="snapshot && item.id === 'nodes'">{{ snapshot.nodes.length }}</span
              ><span v-if="item.id === 'relays'">{{ relatedRoutes.length }}</span>
            </button>
          </div>
          <section
            :id="'machine-panel-' + tab"
            class="tab-panel"
            role="tabpanel"
            :aria-labelledby="'machine-tab-' + tab"
          >
            <p v-if="!snapshot" class="empty-state">
              等待 Agent 首次上报。连接机器后即可管理内核和节点。
            </p>
            <template v-if="snapshot && tab === 'nodes'">
              <div class="node-toolbar">
                <label class="search-field"
                  ><span aria-hidden="true">⌕</span
                  ><input
                    v-model="nodeQuery"
                    type="search"
                    aria-label="搜索机器节点"
                    placeholder="搜索节点名称、地址或协议" /></label
                ><select v-model="nodeProfile" aria-label="节点协议筛选">
                  <option value="">全部协议</option>
                  <option v-for="protocol in protocolOptions" :key="protocol" :value="protocol">
                    {{ protocol }}
                  </option></select
                ><select v-model="nodeCore" aria-label="节点内核筛选">
                  <option value="">全部内核</option>
                  <option v-for="core in snapshot.cores" :key="core.core" :value="core.core">
                    {{ core.core }}
                  </option>
                </select>
                <div class="actions toolbar-end">
                  <button
                    v-if="availableActions.some((item) => item.action === 'node.add')"
                    class="primary"
                    aria-label="添加机器节点"
                    :disabled="busy || !canCommand"
                    @click="openNodeCreator($event.currentTarget)"
                  >
                    ＋ 添加机器节点
                  </button>
                  <details class="action-menu">
                    <summary aria-label="更多节点操作">⋯</summary>
                    <div class="menu-items">
                      <button
                        v-if="availableActions.some((item) => item.action === 'node.ip-policy')"
                        :disabled="!canCommand"
                        @click="openAction('node.ip-policy')"
                      >
                        设置节点 IP 策略</button
                      ><button @click="showGenerated">查看生成节点 / 测试</button>
                    </div>
                  </details>
                </div>
              </div>
              <p v-if="relayError" class="muted">{{ relayError }}</p>
              <div class="table-panel node-list-panel">
                <table class="data-table node-table">
                  <thead>
                    <tr>
                      <th>节点名称</th>
                      <th>协议</th>
                      <th>连接地址</th>
                      <th>内核</th>
                      <th>配置状态</th>
                      <th>关联线路</th>
                      <th class="right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="node in filteredNodes"
                      :key="node.id"
                      class="machine-node-row"
                      :class="{ highlighted: node.id === focusedNodeId }"
                    >
                      <td data-label="节点名称" class="node-name">{{ node.name }}</td>
                      <td data-label="协议">
                        <span
                          class="protocol-badge"
                          :class="'protocol-' + nodeProtocol(node).toLowerCase()"
                          >{{ nodeProtocol(node) }}</span
                        >
                      </td>
                      <td data-label="连接地址" class="endpoint-cell">{{ endpoint(node) }}</td>
                      <td data-label="内核">{{ node.core }}</td>
                      <td data-label="配置状态">
                        <span
                          class="state-badge"
                          :class="
                            nodeState(node) === '待重启'
                              ? 'is-pending'
                              : nodeState(node) === '已应用'
                                ? 'is-online'
                                : 'is-neutral'
                          "
                          ><i />{{ nodeState(node) }}</span
                        >
                      </td>
                      <td data-label="关联线路">
                        <template v-if="routesForNode(node).length"
                          ><a
                            v-for="route in routesForNode(node)"
                            :key="route.id"
                            class="route-link"
                            :href="'#/relays?route=' + route.id"
                            >{{ route.name }}</a
                          ></template
                        ><span v-else class="muted">{{ relayError ? '未知' : '—' }}</span>
                      </td>
                      <td class="row-actions">
                        <button
                          v-if="availableActions.some((item) => item.action === 'node.edit')"
                          class="linkish"
                          aria-label="编辑机器节点"
                          :disabled="!canCommand"
                          @click="openEditor(node, $event.currentTarget)"
                        >
                          编辑
                        </button>
                        <details class="action-menu">
                          <summary :aria-label="node.name + '更多操作'">⋯</summary>
                          <div class="menu-items">
                            <button @click="createRelay(node)">创建中转</button
                            ><button @click="showGenerated">查看生成节点 / 测试</button
                            ><button
                              v-if="availableActions.some((item) => item.action === 'node.switch')"
                              :disabled="!canCommand"
                              @click="openAction('node.switch', { id: node.id })"
                            >
                              切换节点内核</button
                            ><button
                              v-if="availableActions.some((item) => item.action === 'node.delete')"
                              class="danger"
                              :disabled="!canCommand"
                              @click="openAction('node.delete', { id: node.id })"
                            >
                              删除机器节点
                            </button>
                          </div>
                        </details>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="!filteredNodes.length" class="empty-state">
                  {{ snapshot.nodes.length ? '没有符合条件的节点。' : '此机器尚无节点。' }}
                </p>
              </div>
              <p class="list-count">
                共 {{ snapshot.nodes.length }} 个节点<span
                  v-if="filteredNodes.length !== snapshot.nodes.length"
                  >，当前显示 {{ filteredNodes.length }} 个</span
                >
              </p>
            </template>
            <template v-if="snapshot && tab === 'relays'">
              <header class="section-heading">
                <div>
                  <h2>关联线路</h2>
                  <p>跨机器路径由中转线路页编排。</p>
                </div>
                <a class="text-link" href="#/relays">管理中转线路 →</a>
              </header>
              <p v-if="relayError" class="notice">{{ relayError }}</p>
              <p v-else-if="!relatedRoutes.length" class="muted">暂无关联线路。</p>
              <div v-for="route in relatedRoutes" :key="route.id" class="setting-row">
                <a :href="'#/relays?route=' + route.id">{{ route.name }}</a
                ><span>{{ route.kind }} · {{ route.status }}</span>
              </div>
              <header class="section-heading native-heading">
                <div>
                  <h2>原生中转</h2>
                  <p>保留单机出口、节点关联与端口转发的完整操作。</p>
                </div>
                <details class="action-menu">
                  <summary>原生中转操作 ▾</summary>
                  <div class="menu-items">
                    <button
                      v-for="item in availableActions.filter((item) => item.group === '原生中转')"
                      :key="item.action"
                      :disabled="!canCommand"
                      @click="openAction(item.action)"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </details>
              </header>
              <section
                v-for="collection in [
                  {
                    key: 'exits',
                    label: '出口',
                    add: 'exit.add',
                    edit: 'exit.edit',
                    remove: 'exit.delete',
                  },
                  {
                    key: 'bindings',
                    label: '节点关联',
                    add: 'binding.add',
                    edit: '',
                    remove: 'binding.delete',
                  },
                  {
                    key: 'forwards',
                    label: '端口转发',
                    add: 'forward.add',
                    edit: 'forward.edit',
                    remove: 'forward.delete',
                  },
                ] as const"
                :key="collection.key"
                class="native-section"
              >
                <header class="section-heading">
                  <h3>
                    {{ collection.label }}
                    <span class="count">{{ snapshot.relay[collection.key].length }}</span>
                  </h3>
                  <button
                    v-if="availableActions.some((item) => item.action === collection.add)"
                    :disabled="!canCommand"
                    @click="openAction(collection.add)"
                  >
                    添加{{ collection.label }}
                  </button>
                </header>
                <p v-if="!snapshot.relay[collection.key].length" class="muted">
                  暂无{{ collection.label }}。
                </p>
                <article
                  v-for="(record, index) in snapshot.relay[collection.key]"
                  :key="recordId(record) || index"
                  class="native-row"
                >
                  <div>
                    <strong>{{ labelOf(record) }}</strong>
                    <details>
                      <summary>查看参数</summary>
                      <dl>
                        <template v-for="[key, value] in visibleFields(record)" :key="key"
                          ><dt>{{ key }}</dt>
                          <dd>{{ value }}</dd></template
                        >
                      </dl>
                    </details>
                  </div>
                  <div class="actions">
                    <button
                      v-if="
                        collection.edit &&
                        availableActions.some((item) => item.action === collection.edit)
                      "
                      :disabled="!canCommand || !recordId(record)"
                      @click="openAction(collection.edit, { id: recordId(record) })"
                    >
                      编辑
                    </button>
                    <details class="action-menu">
                      <summary :aria-label="'更多' + collection.label + '操作'">⋯</summary>
                      <div class="menu-items">
                        <button
                          v-if="availableActions.some((item) => item.action === collection.remove)"
                          class="danger"
                          :disabled="!canCommand || !recordId(record)"
                          @click="openAction(collection.remove, { id: recordId(record) })"
                        >
                          删除{{ collection.label }}
                        </button>
                      </div>
                    </details>
                  </div>
                </article>
              </section>
            </template>
            <template v-if="snapshot && tab === 'cores'">
              <header class="section-heading">
                <div>
                  <h2>代理内核</h2>
                  <p>版本与运行状态来自最近一次 Agent 上报。</p>
                </div>
                <details class="action-menu">
                  <summary>全部内核操作 ▾</summary>
                  <div class="menu-items">
                    <button
                      v-for="item in availableActions.filter((item) => item.group === '内核')"
                      :key="item.action"
                      :disabled="!canCommand"
                      @click="openAction(item.action)"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </details>
              </header>
              <div class="core-grid">
                <article v-for="core in snapshot.cores" :key="core.core" class="core-card">
                  <header>
                    <h3>{{ core.core }}</h3>
                    <span class="state-badge" :class="core.running ? 'is-online' : 'is-neutral'">{{
                      core.running ? '运行中' : '未运行'
                    }}</span>
                  </header>
                  <p>{{ core.installed ? core.version : '未安装' }}</p>
                  <p class="muted">{{ core.enabled ? '已启用开机启动' : '未启用开机启动' }}</p>
                  <p v-if="core.pending_restart" class="state-badge is-pending">配置待重启</p>
                  <div class="actions">
                    <button
                      v-for="item in coreActions(core.core).filter(
                        (item) => !['core.stop', 'core.uninstall'].includes(item.action),
                      )"
                      :key="item.action"
                      :disabled="!canCommand"
                      @click="openAction(item.action, { core: core.core })"
                    >
                      {{ item.label }}
                    </button>
                    <details v-if="core.installed" class="action-menu">
                      <summary :aria-label="core.core + '更多操作'">⋯</summary>
                      <div class="menu-items">
                        <button
                          v-for="item in coreActions(core.core).filter((item) =>
                            ['core.stop', 'core.uninstall'].includes(item.action),
                          )"
                          :key="item.action"
                          class="danger"
                          :disabled="!canCommand"
                          @click="openAction(item.action, { core: core.core })"
                        >
                          {{ item.label }}
                        </button>
                      </div>
                    </details>
                  </div>
                </article>
              </div>
              <section class="dns-card">
                <header class="section-heading">
                  <div>
                    <h2>sing-box DNS</h2>
                    <p>仅修改 sing-box 的解析器，其他内核保持原生行为。</p>
                  </div>
                  <div class="actions">
                    <button
                      v-for="item in availableActions.filter((item) => item.group === 'DNS')"
                      :key="item.action"
                      :disabled="!canCommand"
                      @click="openAction(item.action)"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </header>
                <p class="muted">
                  {{
                    snapshot.settings
                      ? safeSummary(snapshot.settings) || '当前 DNS 设置未上报。'
                      : '当前 DNS 设置未上报。'
                  }}
                </p>
              </section>
            </template>
            <template v-if="tab === 'tasks'"
              ><header class="section-heading">
                <div>
                  <h2>任务与结果</h2>
                  <p>已投递的操作不能取消；结果未知时请核对当前配置，不会自动重试。</p>
                </div>
              </header>
              <p v-if="!detail.tasks.length" class="empty-state">暂无任务。</p>
              <article v-for="task in detail.tasks" :key="task.id" class="task-row native-row">
                <div>
                  <strong
                    >{{ machineActionLabels[task.action] || task.action }} ·
                    {{ machineStatusLabels[task.status] }}</strong
                  >
                  <p>{{ task.message }}</p>
                  <small>{{ when(task.createdAt) }} · {{ task.id }}</small>
                  <p v-if="task.resultRevision" class="muted">
                    结果版本：{{ task.resultRevision }}
                  </p>
                </div>
                <button
                  v-if="task.status === 'queued'"
                  :disabled="busy"
                  @click="act(() => cancelTask(task))"
                >
                  取消排队
                </button>
              </article></template
            >
            <template v-if="tab === 'settings'"
              ><header class="section-heading">
                <div>
                  <h2>机器设置</h2>
                  <p>{{ detail.machine.id }}</p>
                </div>
              </header>
              <div class="setting-row">
                <div>
                  <strong>机器名称</strong>
                  <p>{{ detail.machine.name }}</p>
                </div>
                <button
                  @click="
                    renameValue = detail.machine.name;
                    renaming = true;
                  "
                >
                  重命名
                </button>
              </div>
              <div class="setting-row">
                <div>
                  <strong>连接凭据</strong>
                  <p>轮换后旧 Token 立即失效，仅本次显示新凭据。</p>
                </div>
                <button :disabled="busy" @click="act(rotateToken)">轮换机器 Token</button>
              </div>
              <div class="setting-row">
                <div>
                  <strong>机器管理</strong>
                  <p>
                    {{
                      detail.machine.enabled
                        ? '已启用，可接收管理任务。'
                        : '已禁用，保留现有快照和记录。'
                    }}
                  </p>
                </div>
                <button
                  :disabled="busy"
                  @click="act(() => updateMachine({ enabled: !detail!.machine.enabled }))"
                >
                  {{ detail.machine.enabled ? '禁用机器' : '启用机器' }}
                </button>
              </div>
              <div class="setting-row">
                <div>
                  <strong>Agent 与 vpsctl</strong>
                  <p>
                    Agent {{ detail.machine.agentVersion || '未上报' }} · vpsctl
                    {{ snapshot?.vpsctlVersion || '未上报' }}
                  </p>
                </div>
                <button
                  v-if="availableActions.some((item) => item.action === 'time.sync')"
                  :disabled="!canCommand"
                  @click="openAction('time.sync')"
                >
                  同步系统时间
                </button>
              </div>
              <p v-if="detail.machine.syncError" class="notice" role="alert">
                {{ detail.machine.syncError }}
              </p></template
            >
          </section>
        </div>
      </section>
      <p v-if="!detail && message" class="notice" role="alert">{{ message }}</p>
    </template>
    <ModalDialog v-if="creating" label="添加机器" :dismissible="!busy" @close="creating = false"
      ><h2>添加机器</h2>
      <form id="create-machine" @submit.prevent="act(createMachine)">
        <label
          >机器名称<input v-model="machineName" required maxlength="128" autocomplete="off"
        /></label>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="creating = false">取消</button
        ><button form="create-machine" class="primary" :disabled="busy">
          创建并获取安装命令
        </button></template
      ></ModalDialog
    >
    <ModalDialog
      v-if="token"
      label="机器安装凭据"
      wide
      @close="
        token = null;
        copyMessage = '';
      "
      ><h2>{{ token.machine.name }} · 安装 Agent</h2>
      <p>在已安装兼容 vpsctl 的 Linux 机器上，以 root 执行安装命令。</p>
      <p>Token 仅本次显示，关闭后无法重新查看。轮换后旧 Token 立即失效，需要重新配置该机器。</p>
      <label
        >机器 Token<input
          ref="tokenInput"
          :value="token.token"
          readonly
          autocomplete="off" /></label
      ><button @click="copy(token!.token, tokenInput)">复制机器 Token</button
      ><label
        >Agent 安装命令<textarea
          ref="commandInput"
          :value="installCommand"
          readonly
          rows="6"
        /></label
      ><button @click="copy(installCommand, commandInput)">复制安装命令</button>
      <p v-if="copyMessage" role="status">{{ copyMessage }}</p>
      <template #footer
        ><button
          @click="
            token = null;
            copyMessage = '';
          "
        >
          关闭
        </button></template
      ></ModalDialog
    >
    <ModalDialog v-if="renaming" label="重命名机器" :dismissible="!busy" @close="renaming = false"
      ><h2>重命名机器</h2>
      <form id="rename-machine" @submit.prevent="act(() => updateMachine({ name: renameValue }))">
        <label>机器名称<input v-model="renameValue" required maxlength="128" /></label>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="renaming = false">取消</button
        ><button form="rename-machine" class="primary" :disabled="busy">保存名称</button></template
      ></ModalDialog
    >
    <MachineNodeCreator
      v-if="addingNode && snapshot && detail?.machine.revision"
      :key="selectedId"
      :snapshot="snapshot"
      :addresses="reportedAddresses"
      :machine-name="detail.machine.name"
      :revision="detail.machine.revision"
      :tasks="detail.tasks"
      :enabled="canCommand && !busy"
      :active="!preparingNodeCore && !creatorHidden"
      :preparation-task="preparationTask"
      :submit="submitNodeAdd"
      :return-focus-to="creatorTrigger"
      @close="addingNode = false"
      @show-tasks="showCreatorTasks"
      @prepare-core="prepareNodeCore"
    />
    <MachineNodeEditor
      v-if="editorNode && detail?.machine.revision"
      :key="selectedId + '/' + editorNode.id"
      :node="editorNode"
      :machine-name="detail.machine.name"
      :revision="detail.machine.revision"
      :tasks="detail.tasks"
      :enabled="canCommand"
      :available="!!snapshot?.nodes.some((node) => node.id === editorNode?.id)"
      :submit="submitNodeEdit"
      :return-focus-to="editorReturnFocus"
      @close="closeEditor"
      @show-tasks="navigateTab('tasks')"
    />
    <ModalDialog
      v-if="actionForm"
      :label="actionForm.definition.label"
      wide
      :dismissible="!busy"
      @close="closeAction"
      ><h2>{{ actionForm.definition.label }}</h2>
      <p v-if="preparingNodeCore" class="notice">
        添加节点的草稿已保留。完成内核操作后返回核对，不会自动创建节点。
      </p>
      <p v-if="actionForm.definition.warning">{{ actionForm.definition.warning }}</p>
      <p>未填写的字段不会发送。编辑时留空保留原值；使用 off / default 明确关闭或恢复默认。</p>
      <p v-if="formChanged" class="notice" role="alert">
        机器版本已变化，输入仍已保留。<button
          :disabled="!detail?.machine.revision"
          @click="
            actionForm.revision = detail!.machine.revision!;
            normalizeChoices();
          "
        >
          采用最新版本
        </button>
      </p>
      <form id="machine-action" @submit.prevent="act(submitAction)">
        <div class="form-grid">
          <label
            v-for="field in actionForm.definition.fields"
            v-show="!field.advanced || advanced"
            :key="field.key"
            :class="{ checkbox: field.kind === 'flag' }"
            ><template v-if="field.kind === 'flag'"
              ><input v-model="actionForm.values[field.key]" type="checkbox" :disabled="busy" />{{
                field.label
              }}</template
            ><template v-else
              >{{ field.label }}{{ field.required ? ' *' : ''
              }}<select
                v-if="field.kind && field.kind !== 'number'"
                v-model="actionForm.values[field.key]"
                :aria-label="field.label + (field.required ? ' *' : '')"
                :multiple="field.multiple"
                :required="field.required"
                :disabled="busy"
                @change="normalizeChoices(field.key)"
              >
                <option v-if="!field.multiple" value="">
                  {{ field.required ? '请选择' : '不修改 / 使用默认' }}
                </option>
                <option v-for="option in options(field)" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option></select
              ><input
                v-else
                v-model="actionForm.values[field.key]"
                :aria-label="field.label + (field.required ? ' *' : '')"
                :type="field.kind === 'number' ? 'number' : 'text'"
                :required="field.required"
                :min="field.kind === 'number' ? 1 : undefined"
                :max="field.key === 'port' || field.key === 'target-port' ? 65535 : undefined"
                :disabled="busy"
                autocomplete="off"
              /><small v-if="field.hint">{{ field.hint }}</small></template
            ></label
          >
        </div>
        <button
          v-if="actionForm.definition.fields.some((field) => field.advanced)"
          type="button"
          :aria-expanded="advanced"
          @click="advanced = !advanced"
        >
          {{ advanced ? '收起高级选项' : '高级选项' }}</button
        ><label class="checkbox"
          ><input
            v-model="actionForm.installDeps"
            type="checkbox"
            :disabled="busy"
          />自动安装必要系统工具</label
        >
        <p class="muted">
          此选项只安装必要系统工具，不包含代理内核；内核由安装或升级操作单独管理。
        </p>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="closeAction">
          {{ preparingNodeCore ? '返回添加节点' : '取消' }}</button
        ><button
          form="machine-action"
          class="primary"
          :disabled="busy || !canCommand || formChanged"
        >
          提交任务
        </button></template
      ></ModalDialog
    >
  </section>
</template>

<style scoped>
.machines-page {
  display: grid;
  gap: 20px;
}
.page-header {
  margin: 0;
  align-items: center;
}
.page-header h1 {
  font-size: 28px;
  letter-spacing: -0.03em;
}
.page-header p {
  margin: 9px 0 0;
  color: var(--muted);
  line-height: 1.6;
  font-size: 14px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.overview-header .primary {
  padding: 11px 18px;
}
.status-filters {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.status-filters button {
  min-width: 104px;
  padding: 12px 18px;
  background: #f7f9f8;
  font-size: 14px;
  color: var(--text);
}
.status-filters button.active {
  background: #d8ebe2;
  color: var(--primary);
  border-color: #c4dfd2;
}
.status-filters span,
.count,
.detail-tabs span {
  background: rgb(89 115 101 / 8%);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 6px;
}
.overview-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 12px;
}
.search-field {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding-left: 14px;
  min-width: 0;
}
.search-field > span {
  font-size: 23px;
  font-weight: 400;
  color: var(--muted);
}
.search-field input {
  border: 0;
  background: transparent;
  padding: 12px 8px;
}
.attention-banner {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 18px;
  color: #78501a;
  background: #fff6e5;
  border: 1px solid #ecd4a5;
  border-radius: 10px;
}
.attention-banner .actions {
  margin-left: auto;
}
.attention-banner strong {
  font-size: 14px;
}
.table-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 11px;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  text-align: left;
  font-size: 13px;
}
.data-table th {
  padding: 15px 14px;
  background: #f6f8f7;
  color: #4e6057;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.data-table th:first-child {
  border-top-left-radius: 11px;
}
.data-table th:last-child {
  border-top-right-radius: 11px;
}
.data-table td {
  padding: 18px 14px;
  border-bottom: 1px solid #e2e9e5;
  vertical-align: middle;
  overflow-wrap: anywhere;
}
.data-table tr:last-child td {
  border-bottom: 0;
}
.machine-table th:first-child {
  width: 20%;
}
.machine-table th:nth-child(2) {
  width: 19%;
}
.machine-table th:nth-child(3) {
  width: 17%;
}
.machine-table th:nth-child(4) {
  width: 6%;
}
.machine-table th:nth-child(5) {
  width: 17%;
}
.machine-table th:nth-child(6) {
  width: 12%;
}
.machine-table th:last-child {
  width: 9%;
}
.machine-name {
  color: var(--primary);
  font-weight: 650;
}
.machine-name svg {
  width: 19px;
  height: 25px;
  stroke: #637268;
  fill: none;
  stroke-width: 1.6;
  display: inline-block;
  vertical-align: middle;
  margin-right: 9px;
}
.name-link {
  padding: 0;
  text-align: left;
  border: 0;
  background: none;
  font-size: inherit;
  font-weight: inherit;
}
.state-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  margin: 2px 4px 2px 0;
  line-height: 1.3;
}
.state-badge i {
  height: 7px;
  width: 7px;
  border-radius: 50%;
  background: currentColor;
}
.is-online {
  color: #197353;
  background: #e7f5ed;
}
.is-neutral {
  color: #68746f;
  background: #edf0ee;
}
.is-pending {
  color: #9a6115;
  background: #fff0cf;
}
.right {
  text-align: right;
}
.row-actions {
  text-align: right;
  white-space: nowrap;
}
.row-actions > button {
  padding-inline: 6px;
}
.list-count {
  color: var(--muted);
  font-size: 13px;
  margin: 0;
}
.empty-state {
  padding: 32px 20px;
  margin: 0;
  text-align: center;
  color: var(--muted);
  line-height: 1.7;
}
.breadcrumb {
  display: flex;
  gap: 12px;
  align-items: center;
  color: var(--muted);
  font-size: 13px;
}
.breadcrumb button {
  padding: 0;
}
.machine-detail {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.machine-title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.detail-header > div {
  min-width: 0;
}
.detail-header select {
  width: auto;
  max-width: 220px;
}
.detail-header p {
  overflow-wrap: anywhere;
}
.detail-header p span {
  color: var(--muted);
  font-size: 12px;
  margin-left: 8px;
}
.detail-workspace {
  background: var(--surface);
  border-radius: 11px;
  border: 1px solid var(--border);
  min-width: 0;
}
.detail-tabs {
  display: flex;
  gap: 6px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.detail-tabs button {
  border: 0;
  border-radius: 0;
  border-bottom: 3px solid transparent;
  padding: 18px 14px 15px;
  color: #43564c;
  font-size: 14px;
  white-space: nowrap;
  background: transparent;
}
.detail-tabs button.active {
  border-bottom-color: var(--primary);
  color: var(--primary);
}
.tab-panel {
  padding: 20px;
  min-width: 0;
}
.node-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.node-toolbar .search-field {
  flex: 1 1 240px;
}
.node-toolbar > select {
  width: auto;
  max-width: 150px;
}
.toolbar-end {
  margin-left: auto;
}
.node-table th:first-child {
  width: 17%;
}
.node-table th:nth-child(2) {
  width: 12%;
}
.node-table th:nth-child(3) {
  width: 23%;
}
.node-table th:nth-child(4) {
  width: 10%;
}
.node-table th:nth-child(5) {
  width: 12%;
}
.node-table th:nth-child(6) {
  width: 15%;
}
.node-table th:last-child {
  width: 11%;
}
.node-name {
  color: var(--primary);
  font-weight: 650;
}
.endpoint-cell {
  font-size: 12px;
}
.protocol-badge {
  padding: 4px 9px;
  font-size: 11px;
  border-radius: 20px;
  background: #e5f0fc;
  color: #285e90;
  white-space: nowrap;
}
.protocol-vless,
.protocol-anytls {
  background: #eee6fb;
  color: #604194;
}
.protocol-trojan {
  background: #fce5ee;
  color: #a43c67;
}
.protocol-tuic {
  background: #e5f6e9;
  color: #3e744e;
}
.route-link {
  display: block;
  color: var(--primary);
  text-decoration: none;
  font-size: 12px;
  line-height: 1.7;
}
.node-list-panel {
  margin-bottom: 16px;
}
.highlighted {
  background: #f1f7f2;
}
.action-menu {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  color: var(--primary);
  text-align: left;
}
.action-menu > summary {
  cursor: pointer;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
}
.action-menu > summary::-webkit-details-marker {
  display: none;
}
.row-actions .action-menu > summary {
  border-color: transparent;
  padding: 6px 8px;
  font-size: 18px;
  line-height: 1;
}
.menu-items {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 40;
  min-width: 190px;
  max-width: min(280px, calc(100vw - 48px));
  display: grid;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 6px;
  box-shadow: 0 10px 28px rgb(16 43 29 / 15%);
}
.menu-items button {
  text-align: left;
  padding: 10px 12px;
  border-color: transparent;
  background: transparent;
  white-space: normal;
}
.inline-task {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 12px 16px;
  background: #eef5f0;
  border: 1px solid #d3e3d9;
  border-radius: 9px;
}
.inline-task > div {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 5px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.inline-task strong {
  font-size: 13px;
  color: var(--primary);
}
.task-warning {
  background: #fff6ed;
  border-color: #ead7c2;
}
.section-heading {
  display: flex;
  gap: 14px;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.section-heading p {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.native-heading {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}
.native-section {
  padding-block: 18px;
  border-top: 1px solid var(--border);
}
.native-row,
.setting-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 16px 0;
  border-bottom: 1px solid #e2e9e5;
}
.native-row > div,
.setting-row > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.native-row p,
.setting-row p {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.7;
}
.native-row small {
  color: var(--muted);
  font-size: 11px;
}
.native-row summary {
  margin-top: 8px;
  cursor: pointer;
  font-size: 12px;
}
.native-row .action-menu summary {
  margin: 0;
}
.core-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.core-card {
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  display: grid;
  gap: 10px;
}
.core-card header {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  align-items: center;
}
.core-card h3 {
  font-size: 16px;
}
.core-card p {
  margin: 0;
}
.dns-card {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}
.text-link,
.setting-row > a {
  color: var(--primary);
  font-size: 13px;
  text-decoration: none;
}
dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px 14px;
  font-size: 12px;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
form {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
small {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}
@media (max-width: 1050px) {
  .data-table td,
  .data-table th {
    padding-inline: 9px;
  }
  .machine-table th:nth-child(5) {
    width: 14%;
  }
  .node-table th:nth-child(6) {
    width: 12%;
  }
  .tab-panel {
    padding: 16px;
  }
}
@media (max-width: 700px) {
  .machines-page {
    gap: 16px;
  }
  .page-header h1 {
    font-size: 24px;
  }
  .page-header p {
    font-size: 13px;
  }
  .status-filters {
    gap: 7px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  .status-filters button {
    min-width: 0;
    padding: 10px 5px;
    font-size: 12px;
  }
  .status-filters span {
    margin-left: 2px;
    padding-inline: 4px;
  }
  .overview-toolbar {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .attention-banner {
    padding: 12px;
    gap: 8px;
  }
  .attention-banner .actions {
    margin-left: 0;
  }
  .attention-banner strong {
    font-size: 13px;
  }
  .data-table,
  .data-table tbody {
    display: block;
  }
  .data-table thead {
    display: none;
  }
  .data-table tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 12px;
    gap: 12px;
    border-bottom: 1px solid var(--border);
  }
  .data-table tr:last-child {
    border-bottom: 0;
  }
  .data-table td {
    display: block;
    border: 0;
    padding: 0;
    min-width: 0;
  }
  .data-table td::before {
    display: block;
    content: attr(data-label);
    color: var(--muted);
    font-size: 10px;
    font-weight: 400;
    margin-bottom: 5px;
  }
  .data-table .machine-name,
  .data-table .node-name {
    grid-column: 1 / -1;
    font-size: 15px;
  }
  .data-table .machine-name::before,
  .data-table .node-name::before,
  .data-table .row-actions::before {
    display: none;
  }
  .data-table .row-actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }
  .machine-name svg {
    width: 17px;
    height: 22px;
  }
  .detail-header {
    gap: 14px;
  }
  .detail-header > .actions {
    width: 100%;
    justify-content: flex-end;
  }
  .detail-header select {
    flex: 1;
    max-width: none;
  }
  .detail-header p span {
    display: block;
    margin-left: 0;
  }
  .detail-tabs {
    padding-inline: 8px;
    gap: 2px;
  }
  .detail-tabs button {
    padding: 14px 9px 12px;
    font-size: 12px;
  }
  .detail-tabs span {
    padding-inline: 4px;
    margin-left: 4px;
  }
  .tab-panel {
    padding: 14px;
  }
  .node-toolbar {
    gap: 8px;
  }
  .node-toolbar .search-field {
    flex-basis: 100%;
  }
  .node-toolbar > select {
    max-width: none;
    flex: 1;
    width: 0;
    font-size: 12px;
  }
  .toolbar-end {
    width: 100%;
    justify-content: flex-end;
  }
  .core-grid,
  .form-grid {
    grid-template-columns: 1fr;
  }
  .setting-row,
  .native-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .setting-row > button {
    margin-left: auto;
  }
  .inline-task {
    align-items: flex-start;
  }
  .inline-task > div {
    flex-basis: 100%;
  }
}
</style>
