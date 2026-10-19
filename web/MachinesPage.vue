<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { z } from 'zod';
import {
  machineDetailSchema,
  machineTaskSchema,
  machineViewSchema,
  type MachineAction,
  type MachineDetail,
  type MachineView,
} from '../server/shared/machines';
import { ApiError } from './api';
import ModalDialog from './ui/ModalDialog.vue';
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
const machines = ref<MachineView[]>([]);
const selectedId = ref('');
const detail = ref<MachineDetail | null>(null);
const busy = ref(false);
const loading = ref(false);
const message = ref('');
const creating = ref(false);
const machineName = ref('');
const renaming = ref(false);
const renameValue = ref('');
const token = ref<{ machine: MachineView; token: string } | null>(null);
const copyMessage = ref('');
const tokenInput = ref<HTMLInputElement | null>(null);
const commandInput = ref<HTMLTextAreaElement | null>(null);
const advanced = ref(false);
const actionForm = ref<{
  definition: MachineActionDefinition;
  revision: string;
  installDeps: boolean;
  values: Record<string, string | string[] | boolean>;
} | null>(null);
let alive = true;
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = computed(() => detail.value?.snapshot);
const canCommand = computed(
  () => !!detail.value?.machine.enabled && !!detail.value.machine.revision && !!snapshot.value,
);
const availableActions = computed(() =>
  machineActions.filter((item) => snapshot.value?.capabilities.actions.includes(item.action)),
);
const groups = computed(() => [...new Set(availableActions.value.map((item) => item.group))]);
const formChanged = computed(
  () => !!actionForm.value && actionForm.value.revision !== detail.value?.machine.revision,
);
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
const errorText = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && /REVISION|CONFLICT/.test(error.code)
    ? '版本冲突：机器状态已变化。请核对最新快照后重新提交。' + error.message
    : error instanceof Error
      ? error.message
      : '操作失败。';
const when = (value: number | null) =>
  value === null ? '尚未上报' : new Date(value).toLocaleString();
const labelOf = (record: Record<string, unknown>) => String(record.name || record.id || '未命名');
const recordId = (record: Record<string, unknown>) =>
  typeof record.id === 'string' ? record.id : '';
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
  if (Array.isArray(value)) return value.map(safeSummary).join(', ');
  if (value && typeof value === 'object')
    return visibleFields(value as Record<string, unknown>)
      .map(([key, item]) => key + ': ' + item)
      .join(' · ');
  return String(value ?? '');
}
async function refresh() {
  if (loading.value) return;
  loading.value = true;
  const id = selectedId.value;
  try {
    const list = z
      .object({ machines: z.array(machineViewSchema) })
      .parse(await props.api('/api/machines'));
    if (!alive) return;
    machines.value = list.machines;
    if (id) {
      const value = machineDetailSchema.parse(await props.api('/api/machines/' + id));
      if (alive && selectedId.value === id) detail.value = value;
    }
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
async function selectMachine(machine: MachineView) {
  const value = machineDetailSchema.parse(await props.api('/api/machines/' + machine.id));
  if (!alive) return;
  selectedId.value = machine.id;
  detail.value = value;
  actionForm.value = null;
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
  await selectMachine(value.machine);
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
    /* A selected field remains usable on HTTP deployments. */
  }
  input?.focus();
  input?.select();
  try {
    if (document.execCommand('copy')) {
      copyMessage.value = '已复制。';
      return;
    }
  } catch {
    /* Leave the text selected for manual copying. */
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
    const available = options(field);
    const current = values[field.key];
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
async function submitAction() {
  if (!actionForm.value || !detail.value || !snapshot.value) return;
  const { definition, values, revision } = actionForm.value;
  if (formChanged.value)
    throw new Error('版本冲突：请先核对最新快照，再点击“采用最新版本”保留输入继续。');
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
  const value = z.object({ task: machineTaskSchema }).parse(
    await props.api('/api/machines/' + detail.value.machine.id + '/commands', {
      action: definition.action,
      params,
      expectedRevision: revision,
    }),
  );
  if (!alive) return;
  actionForm.value = null;
  await refresh();
  message.value = definition.label + '已排队，任务 ' + value.task.id + '。';
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
  token.value = null;
  actionForm.value = null;
});
</script>

<template>
  <section class="page machines-page">
    <header class="page-header">
      <div>
        <h1>机器</h1>
        <p>管理已安装 Agent 的机器、内核、节点和原生中转。可见页面每 5 秒刷新。</p>
      </div>
      <div class="actions">
        <button :disabled="busy || loading" @click="act(refresh)">刷新机器</button
        ><button
          class="primary"
          @click="
            creating = true;
            message = '';
          "
        >
          添加机器
        </button>
      </div>
    </header>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <div class="panel machine-list" aria-label="机器列表">
      <p v-if="!machines.length">尚未添加机器。添加后将显示一次 Token 和安装命令。</p>
      <article
        v-for="machine in machines"
        :key="machine.id"
        class="machine-row"
        :class="{ selected: machine.id === selectedId }"
      >
        <div>
          <h2>{{ machine.name }}</h2>
          <p>
            {{ !machine.enabled ? '已禁用' : machine.online ? '在线' : '离线' }} · Agent
            {{ machine.agentVersion || '未上报' }} · 最后上报 {{ when(machine.lastSeen) }}
          </p>
          <p v-if="machine.syncError" role="alert">同步失败：{{ machine.syncError }}</p>
        </div>
        <button
          :disabled="busy"
          :aria-label="'管理 ' + machine.name"
          @click="act(() => selectMachine(machine))"
        >
          管理
        </button>
      </article>
    </div>
    <section v-if="detail" class="panel machine-detail" aria-label="机器详情">
      <header class="detail-header">
        <div>
          <h2>{{ detail.machine.name }}</h2>
          <p class="muted">
            {{ detail.machine.id }} · vpsctl {{ snapshot?.vpsctlVersion || '未上报' }}
          </p>
        </div>
        <div class="actions">
          <button
            :disabled="busy"
            @click="
              renameValue = detail.machine.name;
              renaming = true;
              message = '';
            "
          >
            重命名
          </button>
          <button :disabled="busy" @click="act(rotateToken)">轮换机器 Token</button>
          <button
            :disabled="busy"
            @click="act(() => updateMachine({ enabled: !detail!.machine.enabled }))"
          >
            {{ detail.machine.enabled ? '禁用机器' : '启用机器' }}
          </button>
        </div>
      </header>
      <p v-if="!snapshot">等待 Agent 首次上报。使用安装命令连接此机器后即可管理。</p>
      <template v-else>
        <p v-if="!detail.machine.enabled" class="notice">机器已禁用，启用后可继续下发任务。</p>
        <p v-else-if="!detail.machine.online" class="notice">
          机器离线，新任务会排队等待 Agent 连接。
        </p>
        <p v-if="snapshot.pendingCores.length" class="notice">
          待重启内核：{{ snapshot.pendingCores.join('、') }}。请查看任务结果并显式重启。
        </p>
        <div class="core-grid">
          <article v-for="core in snapshot.cores" :key="core.core" class="core-card">
            <h3>{{ core.core }}</h3>
            <p>
              {{ core.installed ? core.version : '未安装' }} ·
              {{ core.running ? '运行中' : '未运行' }} ·
              {{ core.enabled ? '开机启动' : '未设开机启动' }}
            </p>
            <p v-if="core.pending_restart" class="pending">配置待重启</p>
            <div class="actions">
              <button
                v-for="item in availableActions.filter(
                  (item) =>
                    item.group === '内核' &&
                    fieldOptions(item.fields[0]!, snapshot!, item.action, {}).some(
                      (option) => option.value === core.core,
                    ),
                )"
                :key="item.action"
                :disabled="busy || !canCommand"
                @click="openAction(item.action, { core: core.core })"
              >
                {{ item.label }}
              </button>
            </div>
          </article>
        </div>
        <div class="operation-groups" aria-label="机器操作">
          <div v-for="group in groups" :key="group">
            <h3>{{ group }}</h3>
            <div class="actions">
              <button
                v-for="item in availableActions.filter((item) => item.group === group)"
                :key="item.action"
                :disabled="busy || !canCommand"
                @click="openAction(item.action)"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
        </div>
        <h3>机器节点（{{ snapshot.nodes.length }}）</h3>
        <p class="muted">密码、密钥和分享链接不在此页显示；凭据由机器自动生成。</p>
        <p v-if="!snapshot.nodes.length">此机器尚无节点。</p>
        <article v-for="node in snapshot.nodes" :key="node.id" class="resource-row">
          <div>
            <strong>{{ node.name }}</strong>
            <p>
              {{ node.core }} ·
              {{
                snapshot.capabilities.profiles.find((profile) => profile.id === node.profile)
                  ?.label || node.profile
              }}
              · {{ node.id }}
            </p>
            <details>
              <summary>节点参数</summary>
              <dl>
                <template v-for="[key, value] in visibleFields(node)" :key="key"
                  ><dt>{{ key }}</dt>
                  <dd>{{ value }}</dd></template
                >
              </dl>
            </details>
          </div>
          <div class="actions">
            <button
              v-for="action in ['node.edit', 'node.switch', 'node.delete'] as const"
              v-show="availableActions.some((item) => item.action === action)"
              :key="action"
              :disabled="busy || !canCommand"
              :class="{ danger: action === 'node.delete' }"
              @click="openAction(action, { id: node.id })"
            >
              {{ machineActionLabels[action] }}
            </button>
          </div>
        </article>
        <h3>原生中转</h3>
        <p class="muted">单台机器的出口、节点关联和端口转发。跨机器编排请使用“中转线路”页。</p>
        <div
          v-for="collection in [
            { key: 'exits', label: '出口', edit: 'exit.edit', remove: 'exit.delete' },
            { key: 'bindings', label: '节点关联', edit: '', remove: 'binding.delete' },
            { key: 'forwards', label: '端口转发', edit: 'forward.edit', remove: 'forward.delete' },
          ] as const"
          :key="collection.key"
        >
          <h3>{{ collection.label }}（{{ snapshot.relay[collection.key].length }}）</h3>
          <article
            v-for="(record, index) in snapshot.relay[collection.key]"
            :key="recordId(record) || index"
            class="resource-row"
          >
            <div>
              <strong>{{ labelOf(record) }}</strong>
              <details>
                <summary>查看{{ collection.label }}参数</summary>
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
                :disabled="busy || !canCommand || !recordId(record)"
                @click="openAction(collection.edit, { id: recordId(record) })"
              >
                编辑</button
              ><button
                v-if="availableActions.some((item) => item.action === collection.remove)"
                class="danger"
                :disabled="busy || !canCommand || !recordId(record)"
                @click="openAction(collection.remove, { id: recordId(record) })"
              >
                删除
              </button>
            </div>
          </article>
        </div>
      </template>
      <h3>任务与结果</h3>
      <p v-if="!detail.tasks.length">暂无任务。</p>
      <article v-for="task in detail.tasks" :key="task.id" class="resource-row task-row">
        <div>
          <strong
            >{{ machineActionLabels[task.action] || task.action }} ·
            {{ machineStatusLabels[task.status] || task.status }}</strong
          >
          <p>{{ when(task.createdAt) }} · {{ task.id }}</p>
          <p
            v-if="task.message"
            :class="{ pending: ['conflict', 'failed', 'unknown'].includes(task.status) }"
          >
            {{ task.message }}
          </p>
          <p v-if="task.resultRevision" class="muted">结果版本：{{ task.resultRevision }}</p>
        </div>
        <button
          v-if="task.status === 'queued'"
          :disabled="busy"
          @click="
            act(async () => {
              await api(
                '/api/machines/' + detail!.machine.id + '/commands/' + task.id + '/cancel',
                {},
              );
              await refresh();
            })
          "
        >
          取消排队
        </button>
      </article>
    </section>
    <ModalDialog v-if="creating" label="添加机器" :dismissible="!busy" @close="creating = false">
      <h2>添加机器</h2>
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
      >
    </ModalDialog>
    <ModalDialog
      v-if="token"
      label="机器安装凭据"
      wide
      @close="
        token = null;
        copyMessage = '';
      "
    >
      <h2>{{ token.machine.name }} · 安装 Agent</h2>
      <p>在已安装兼容 vpsctl 的 Linux 机器上，以 root 执行安装命令。</p>
      <p>Token 仅本次显示，关闭后无法重新查看。轮换后旧 Token 立即失效，需要重新配置该机器。</p>
      <label
        >机器 Token<input
          ref="tokenInput"
          :value="token.token"
          readonly
          autocomplete="off" /></label
      ><button @click="copy(token!.token, tokenInput)">复制机器 Token</button>
      <label
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
      >
    </ModalDialog>
    <ModalDialog v-if="renaming" label="重命名机器" :dismissible="!busy" @close="renaming = false">
      <h2>重命名机器</h2>
      <form id="rename-machine" @submit.prevent="act(() => updateMachine({ name: renameValue }))">
        <label>机器名称<input v-model="renameValue" required maxlength="128" /></label>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="renaming = false">取消</button
        ><button form="rename-machine" class="primary" :disabled="busy">保存名称</button></template
      >
    </ModalDialog>
    <ModalDialog
      v-if="actionForm"
      :label="actionForm.definition.label"
      wide
      :dismissible="!busy"
      @close="actionForm = null"
    >
      <h2>{{ actionForm.definition.label }}</h2>
      <p v-if="actionForm.definition.warning">{{ actionForm.definition.warning }}</p>
      <p>未填写的字段不会发送。编辑时留空保留原值；使用 off / default 明确关闭或恢复默认。</p>
      <p v-if="formChanged" class="notice" role="alert">
        机器版本已变化。核对最新快照后，可保留输入采用最新版本。<button
          type="button"
          :disabled="busy || !detail?.machine.revision"
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
          >
            <template v-if="field.kind === 'flag'"
              ><input v-model="actionForm.values[field.key]" type="checkbox" :disabled="busy" />{{
                field.label
              }}</template
            >
            <template v-else
              >{{ field.label }}{{ field.required ? ' *' : '' }}
              <select
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
                </option>
              </select>
              <input
                v-else
                v-model="actionForm.values[field.key]"
                :aria-label="field.label + (field.required ? ' *' : '')"
                :type="field.kind === 'number' ? 'number' : 'text'"
                :required="field.required"
                :min="field.kind === 'number' ? 1 : undefined"
                :max="field.key === 'port' || field.key === 'target-port' ? 65535 : undefined"
                :disabled="busy"
                autocomplete="off"
              />
              <small v-if="field.hint">{{ field.hint }}</small>
            </template>
          </label>
        </div>
        <button
          v-if="actionForm.definition.fields.some((field) => field.advanced)"
          type="button"
          :aria-expanded="advanced"
          @click="advanced = !advanced"
        >
          {{ advanced ? '收起高级选项' : '高级选项' }}
        </button>
        <label class="checkbox">
          <input v-model="actionForm.installDeps" type="checkbox" :disabled="busy" />
          自动安装所需依赖
        </label>
        <p class="muted">只安装当前操作所必需的系统工具。</p>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="actionForm = null">取消</button
        ><button
          form="machine-action"
          class="primary"
          :disabled="busy || !canCommand || formChanged"
        >
          提交任务
        </button></template
      >
    </ModalDialog>
  </section>
</template>

<style scoped>
.machines-page {
  display: grid;
  gap: 18px;
}
.page-header p {
  margin: 8px 0 0;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.machine-row,
.resource-row,
.detail-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}
.machine-row,
.resource-row {
  border-bottom: 1px solid var(--border);
  padding: 16px 0;
}
.machine-row:last-child,
.resource-row:last-child {
  border-bottom: 0;
}
.machine-row.selected {
  background: var(--row-active);
}
.machine-row p,
.resource-row p {
  margin: 7px 0 0;
}
.machine-row > div,
.resource-row > div,
.detail-header > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.machine-detail {
  display: grid;
  gap: 16px;
}
.machine-detail h3 {
  margin-top: 6px;
}
.machine-detail p {
  margin-bottom: 0;
  overflow-wrap: anywhere;
}
.muted,
small {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}
.pending {
  color: var(--error-text);
}
.core-grid,
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.core-card {
  border: 1px solid var(--border);
  padding: 14px;
  border-radius: var(--radius);
  display: grid;
  gap: 12px;
}
.operation-groups {
  display: grid;
  gap: 14px;
  border-block: 1px solid var(--border);
  padding: 14px 0;
}
.operation-groups h3 {
  margin-bottom: 8px;
}
dl {
  display: grid;
  grid-template-columns: minmax(90px, auto) 1fr;
  gap: 6px 14px;
  font-size: 12px;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  margin-top: 8px;
  font-size: 13px;
}
form {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}
.checkbox {
  flex-direction: row;
  align-items: center;
}
.modal-body label {
  margin-block: 12px;
}
.notice {
  overflow-wrap: anywhere;
}
@media (max-width: 650px) {
  .machine-row,
  .resource-row,
  .detail-header {
    align-items: stretch;
    flex-direction: column;
  }
  .core-grid,
  .form-grid {
    grid-template-columns: 1fr;
  }
  dl {
    grid-template-columns: 1fr;
  }
  .actions > button {
    flex-grow: 1;
  }
}
</style>
