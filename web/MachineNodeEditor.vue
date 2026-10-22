<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MachineTask } from '../server/shared/machines';
import { ApiError } from './api';
import {
  nodeChanges,
  nodeEditorFields,
  nodeEditorValues,
  nodeEditParams,
  nodeProtocol,
  type MachineNode,
} from './machineEditor';
import { machineStatusLabels } from './machineActions';
import SideDrawer from './ui/SideDrawer.vue';
const props = defineProps<{
  node: MachineNode;
  machineName: string;
  revision: string;
  tasks: MachineTask[];
  enabled: boolean;
  available: boolean;
  returnFocusTo?: HTMLElement | null;
  submit: (
    params: Record<string, string | number | string[] | boolean>,
    revision: string,
  ) => Promise<MachineTask>;
}>();
const emit = defineEmits<{ close: []; showTasks: [] }>();
const baseline = ref(nodeEditorValues(props.node));
const values = ref({ ...baseline.value });
const baselineRevision = ref(props.revision);
const busy = ref(false),
  message = ref(''),
  installDeps = ref(true),
  submitted = ref<MachineTask | null>(null);
const fields = computed(() => nodeEditorFields(props.node, values.value));
const changes = computed(() => nodeChanges(props.node, baseline.value, values.value));
const conflicted = computed(() => baselineRevision.value !== props.revision);
const task = computed(
  () => props.tasks.find((item) => item.id === submitted.value?.id) || submitted.value,
);
const sections = [
  { id: 'basic', label: '基本信息' },
  { id: 'tls', label: 'TLS 设置' },
  { id: 'transport', label: '传输设置' },
  { id: 'advanced', label: '高级选项' },
];
function display(value: string, key: string) {
  if (!value) return '未上报 / 保留';
  return (
    fields.value
      .find((field) => field.key === key)
      ?.options?.find((option) => option.value === value)?.label || value
  );
}
function adopt() {
  if (busy.value || !props.available || (task.value && task.value.status !== 'conflict')) return;
  const dirty = new Map(changes.value.map((change) => [change.field.key, change.after]));
  baseline.value = nodeEditorValues(props.node);
  values.value = { ...baseline.value, ...Object.fromEntries(dirty) };
  baselineRevision.value = props.revision;
  if (task.value?.status === 'conflict') submitted.value = null;
  message.value = '';
}
async function save() {
  if (busy.value || submitted.value) return;
  message.value = '';
  if (!props.available) {
    message.value = '该节点已不在最新快照中，请关闭后重新选择；输入已保留。';
    return;
  }
  if (conflicted.value) {
    message.value = '机器版本已变化，请先核对最新快照并采用最新版本。';
    return;
  }
  busy.value = true;
  try {
    const params = nodeEditParams(props.node, baseline.value, values.value);
    if (installDeps.value) params['install-deps'] = true;
    submitted.value = await props.submit(params, baselineRevision.value);
  } catch (error) {
    message.value =
      error instanceof ApiError && error.status === 409
        ? '提交冲突：' + error.message
        : error instanceof Error
          ? error.message
          : '保存失败。';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <SideDrawer
    label="编辑机器节点"
    :dismissible="!busy"
    :return-focus-to="returnFocusTo"
    @close="emit('close')"
  >
    <template #subtitle
      ><p class="editor-subtitle">{{ machineName }} / {{ node.name }}</p></template
    >
    <div class="editor-context">
      <span>{{ nodeProtocol(node) }}</span
      ><span>{{ node.core }}</span
      ><small>当前配置 · {{ node.profile }}</small>
    </div>
    <p v-if="(!available || conflicted) && !submitted" class="editor-warning" role="alert">
      {{
        available
          ? '机器版本已变化，输入仍已保留。核对当前配置后再继续。'
          : '节点已不在最新快照中，输入仍已保留。请关闭后重新选择节点。'
      }}<button v-if="available" type="button" :disabled="busy" @click="adopt">采用最新版本</button>
    </p>
    <form id="machine-node-editor" @submit.prevent="save">
      <template v-for="section in sections" :key="section.id">
        <component
          :is="section.id === 'basic' ? 'section' : 'details'"
          v-if="fields.some((field) => field.section === section.id)"
          class="editor-section"
          :open="section.id === 'tls' || section.id === 'transport'"
        >
          <h3 v-if="section.id === 'basic'">{{ section.label }}</h3>
          <summary v-else>
            {{ section.label }}<span v-if="section.id === 'advanced'">协议选项与出站策略</span>
          </summary>
          <div class="editor-fields">
            <label
              v-for="field in fields.filter((field) => field.section === section.id)"
              :key="field.key"
              :class="{ full: ['name', 'address'].includes(field.key) }"
              >{{ field.label }}
              <select
                v-if="field.options"
                v-model="values[field.key]"
                :aria-label="field.label"
                :disabled="busy || !!submitted"
              >
                <option value="">未上报 / 保留原值</option>
                <option
                  v-if="
                    values[field.key] &&
                    !field.options.some((option) => option.value === values[field.key])
                  "
                  :value="values[field.key]"
                >
                  当前值：{{ values[field.key] }}
                </option>
                <option v-for="option in field.options" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <input
                v-else
                v-model="values[field.key]"
                :aria-label="field.label"
                :type="field.kind === 'number' ? 'number' : 'text'"
                :min="field.kind === 'number' ? 1 : undefined"
                :max="field.key === 'port' ? 65535 : undefined"
                :disabled="busy || !!submitted"
                :data-drawer-initial-focus="field.key === 'name' ? '' : undefined"
                autocomplete="off"
              />
              <small v-if="changes.some((change) => change.field.key === field.key)" class="changed"
                >已修改 · 原值 {{ display(baseline[field.key] || '', field.key) }}</small
              ><small v-else-if="field.hint">{{ field.hint }}</small>
              <small v-if="field.key === 'cert-mode'"
                >现有认证凭据保持不变。导入路径留空保留现有证书；切换模式或修改导入证书 SNI
                时需提供新路径。</small
              >
            </label>
          </div>
        </component>
      </template>
      <label class="editor-checkbox"
        ><input
          v-model="installDeps"
          type="checkbox"
          :disabled="busy || !!submitted"
        />自动安装必要系统工具</label
      >
      <p class="editor-help">只安装必要系统工具，不包含代理内核。未修改、未知和敏感字段不回写。</p>
      <div class="change-summary" role="region" aria-label="节点变更摘要">
        <strong>{{ changes.length }} 项修改</strong>
        <p v-if="!changes.length">修改字段后在这里核对变更。</p>
        <ul v-else>
          <li v-for="change in changes" :key="change.field.key">
            {{ change.field.label }} {{ display(change.before, change.field.key) }} →
            {{ display(change.after, change.field.key) }}
          </li>
        </ul>
        <small>保存后如需重启，将在节点与任务中显示提示。</small>
      </div>
      <p v-if="message" class="editor-warning" role="alert">{{ message }}</p>
      <div v-if="task" class="submitted-task" role="status">
        <strong>{{ machineStatusLabels[task.status] }}</strong>
        <p>{{ task.message }}</p>
        <p v-if="task.status === 'unknown'">结果未知，请核对当前配置；不会自动重试。</p>
        <p v-if="task.status === 'conflict'">
          机器版本冲突，本次任务未应用；输入已保留。{{
            available
              ? '核对当前配置后，可采用最新版本再提交。'
              : '节点已不在最新快照中，请关闭后重新选择节点。'
          }}
        </p>
        <button
          v-if="task.status === 'conflict' && available"
          type="button"
          :disabled="busy"
          @click="adopt"
        >
          采用最新版本
        </button>
        <button type="button" @click="emit('showTasks')">查看任务记录</button>
      </div>
    </form>
    <template #footer
      ><button :disabled="busy" @click="emit('close')">{{ submitted ? '返回节点' : '取消' }}</button
      ><button
        v-if="!submitted"
        form="machine-node-editor"
        class="primary"
        :disabled="busy || !enabled || !available || conflicted || !changes.length"
      >
        {{ busy ? '正在提交…' : '保存修改' }}
      </button></template
    >
  </SideDrawer>
</template>
<style scoped>
.editor-subtitle {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.editor-context {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 18px 0;
}
.editor-context span {
  padding: 5px 12px;
  background: #f0f3f1;
  border-radius: 20px;
  font-size: 12px;
}
.editor-context small,
.editor-help,
small {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
}
.editor-section {
  border-top: 1px solid var(--border);
  padding: 20px 0;
}
.editor-section h3,
summary {
  font-size: 15px;
  font-weight: 650;
  margin: 0 0 16px;
}
summary {
  cursor: pointer;
}
summary span {
  float: right;
  font-size: 11px;
  color: var(--muted);
  font-weight: 400;
  margin-right: 8px;
}
.editor-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.full {
  grid-column: 1 / -1;
}
.changed {
  color: var(--warn-text);
}
.editor-checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.editor-help {
  margin: 8px 0 18px;
}
.change-summary {
  padding: 16px;
  background: #f1f6f3;
  border-radius: 10px;
  overflow-wrap: anywhere;
}
.change-summary strong {
  color: var(--primary);
}
.change-summary p,
.change-summary ul {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.7;
}
.change-summary ul {
  padding-left: 18px;
}
.editor-warning {
  background: var(--warn-bg);
  color: var(--warn-text);
  border: 1px solid #e7d5a8;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.7;
}
.editor-warning button {
  margin: 8px 0 0;
  display: block;
}
.submitted-task {
  padding: 16px;
  background: var(--ok-bg);
  color: var(--ok-text);
  border-radius: 8px;
  margin-top: 16px;
}
.submitted-task p {
  margin: 8px 0;
  font-size: 13px;
}
@media (max-width: 420px) {
  .editor-fields {
    grid-template-columns: 1fr;
  }
  summary span {
    float: none;
    display: block;
    margin-top: 4px;
  }
}
</style>
