<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from 'vue';
import type { MachineSnapshot, MachineTask } from '../server/shared/machines';
import { ApiError } from './api';
import { machineStatusLabels } from './machineActions';
import {
  adoptNodeDraft,
  carryNodeCommonDraft,
  initialNodeProfile,
  newNodeDraft,
  nodeCoreAvailability,
  nodeCreateFields,
  nodeCreateParams,
  nodeTemplate,
  setNodeDraftValue,
  type CreateField,
  type NodeCore,
  type NodeCreateDraft,
} from './machineNodeTemplates';
import SideDrawer from './ui/SideDrawer.vue';

const props = defineProps<{
  snapshot: MachineSnapshot;
  addresses: string[];
  machineName: string;
  revision: string;
  tasks: MachineTask[];
  enabled: boolean;
  active: boolean;
  preparationTask?: MachineTask | null;
  returnFocusTo?: HTMLElement | null;
  submit: (
    params: Record<string, string | number | string[] | boolean>,
    revision: string,
  ) => Promise<MachineTask>;
}>();
const emit = defineEmits<{
  close: [];
  showTasks: [];
  prepareCore: [core: NodeCore, action: 'core.install' | 'core.update'];
}>();
const profile = ref(initialNodeProfile(props.snapshot));
const drafts = ref<Record<string, NodeCreateDraft>>({
  [profile.value]: newNodeDraft(props.snapshot, props.addresses, profile.value),
});
const draft = computed(() => drafts.value[profile.value]);
const acceptedSnapshot = shallowRef(props.snapshot);
const baselineRevision = ref(props.revision);
// Core installation can change availability without changing the node manifest revision.
const capabilityStamp = (snapshot: MachineSnapshot) =>
  JSON.stringify([
    snapshot.capabilities,
    snapshot.cores.map((core) => [core.core, core.installed, core.version]),
  ]);
const baselineCapabilities = ref(capabilityStamp(props.snapshot));
const busy = ref(false),
  message = ref(''),
  submissionConflict = ref(false);
const uncertain = ref(false),
  reviewed = ref(false),
  submitted = ref<MachineTask | null>(null);
const feedback = ref<HTMLElement | null>(null);
const validationFeedback = ref<HTMLElement | null>(null);
const task = computed(
  () => props.tasks.find((item) => item.id === submitted.value?.id) || submitted.value,
);
const preparation = computed(
  () => props.tasks.find((item) => item.id === props.preparationTask?.id) || props.preparationTask,
);
const preparing = computed(
  () => preparation.value && ['queued', 'running'].includes(preparation.value.status),
);
const conflicted = computed(
  () =>
    submissionConflict.value ||
    baselineRevision.value !== props.revision ||
    baselineCapabilities.value !== capabilityStamp(props.snapshot),
);
const locked = computed(() => busy.value || !!task.value || uncertain.value);
const fields = computed(() => nodeCreateFields(acceptedSnapshot.value, draft.value));
const template = computed(() => nodeTemplate(profile.value));
const capability = computed(() =>
  nodeCoreAvailability(acceptedSnapshot.value, profile.value, draft.value.values.core),
);
const canCreate = computed(
  () =>
    !locked.value &&
    props.enabled &&
    !conflicted.value &&
    !preparing.value &&
    capability.value.available &&
    acceptedSnapshot.value.capabilities.actions.includes('node.add'),
);
const coreState = computed(() =>
  acceptedSnapshot.value.cores.find((core) => core.core === draft.value.values.core),
);
const protocolChoices = computed(() => props.snapshot.capabilities.profiles);
const mainTemplates = [
  {
    id: 'vless-reality-vision',
    label: '通用推荐',
    detail: 'VLESS · REALITY · Vision',
    description: '免自备证书，优先使用已安装的兼容 Xray。',
  },
  {
    id: 'hysteria2',
    label: 'Hysteria2',
    detail: 'QUIC · UDP',
    description: '优先使用 sing-box；默认自签名证书。',
  },
];
const sections: { id: CreateField['section']; label: string }[] = [
  { id: 'basic', label: '基本信息' },
  { id: 'tls', label: 'TLS / REALITY 设置' },
  { id: 'transport', label: '传输设置' },
  { id: 'performance', label: '性能设置' },
  { id: 'network', label: '网络设置' },
];
const credentialLabel = computed(() => {
  if (!template.value.known) return '认证与协议专属参数由机器原生 profile 默认处理。';
  const values = ['认证凭据'];
  if (profile.value.startsWith('vless') || profile.value === 'tuic-v5') values[0] = 'UUID';
  if (profile.value === 'tuic-v5') values.push('密码');
  if (template.value.reality) values.push('REALITY 密钥与短 ID');
  if (profile.value === 'shadowsocks-2022-shadowtls') values.push('ShadowTLS 密码');
  if (profile.value === 'hysteria2' && draft.value.values.obfs !== 'none') values.push('混淆密码');
  return values.join('、') + ' · 创建时自动生成';
});
function chooseProfile(id: string) {
  if (locked.value || !protocolChoices.value.some((item) => item.id === id)) return;
  drafts.value[id] ||= newNodeDraft(acceptedSnapshot.value, props.addresses, id);
  carryNodeCommonDraft(draft.value, drafts.value[id]);
  profile.value = id;
  message.value = '';
}
function updateField(field: CreateField, event: Event) {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  setNodeDraftValue(draft.value, field.key, target.value);
}
function reset() {
  if (locked.value) return;
  drafts.value[profile.value] = newNodeDraft(
    acceptedSnapshot.value,
    props.addresses,
    profile.value,
  );
  message.value = '';
}
function adopt() {
  if (busy.value || (task.value && task.value.status !== 'conflict') || uncertain.value) return;
  if (task.value?.status === 'conflict') submitted.value = null;
  acceptedSnapshot.value = props.snapshot;
  baselineRevision.value = props.revision;
  baselineCapabilities.value = capabilityStamp(props.snapshot);
  for (const value of Object.values(drafts.value)) adoptNodeDraft(value, props.snapshot);
  submissionConflict.value = false;
  message.value = '';
}
function source(field: CreateField): string {
  if (draft.value.explicit[field.key]) return '手动设置';
  if (field.key === 'address') return '沿用机器地址';
  if (['path-mode', 'service-mode'].includes(field.key)) return '创建时自动生成';
  if (field.key === 'address-mode' && draft.value.values['address-mode'] === 'auto')
    return '机器自动探测';
  if (['cert-file', 'key-file', 'cert-id', 'path', 'service-name', 'hop-ports'].includes(field.key))
    return '需要手动填写';
  if (field.key === 'host') return '未指定';
  return '模板默认';
}
function display(key: string): string {
  const value = draft.value.values[key];
  return (
    fields.value
      .find((field) => field.key === key)
      ?.options?.find((option) => option.value === value)?.label || value
  );
}
function sectionSummary(id: CreateField['section']): string {
  const v = draft.value.values;
  if (id === 'transport')
    return (
      template.value.transport.toUpperCase() +
      ' · ' +
      (template.value.transport === 'grpc'
        ? v['service-mode'] === 'auto'
          ? '自动生成服务名称'
          : v['service-name'] || '填写服务名称'
        : v['path-mode'] === 'auto'
          ? '自动生成路径'
          : v.path || '填写路径') +
      (template.value.transport === 'xhttp' ? ` · ${v['xhttp-mode']}` : '')
    );
  if (id === 'performance')
    return profile.value === 'hysteria2'
      ? `${v['up-mbps']} / ${v['down-mbps']} Mbps · ${display('obfs')}`
      : display('congestion-control');
  if (id === 'network')
    return (
      `${v.listen === '::' ? 'IPv4＋IPv6' : v.listen} · ${display('ip-strategy')}` +
      (profile.value === 'hysteria2' ? ` · 跳跃${v['hop-mode'] === 'off' ? '关闭' : '开启'}` : '')
    );
  return '';
}
function unavailableOptions(field: CreateField): string[] {
  return [
    ...new Set(field.options?.flatMap((option) => (option.reason ? [option.reason] : [])) || []),
  ];
}
function prepare(action: 'core.install' | 'core.update') {
  const core = draft.value.values.core;
  if (
    locked.value ||
    !props.enabled ||
    preparing.value ||
    conflicted.value ||
    (core !== 'sing-box' && core !== 'xray') ||
    !acceptedSnapshot.value.capabilities.actions.includes(action)
  )
    return;
  emit('prepareCore', core, action);
}
function resumeAfterReview() {
  if (!reviewed.value || !uncertain.value) return;
  uncertain.value = false;
  reviewed.value = false;
  message.value = '';
  // Reviewing the task list does not silently adopt a changed machine snapshot.
}
async function showFeedback() {
  await nextTick();
  const element = feedback.value || validationFeedback.value;
  element?.scrollIntoView({ block: 'start' });
  element?.focus({ preventScroll: true });
}
async function create() {
  if (!canCreate.value) return;
  message.value = '';
  let params: Record<string, string | number | string[] | boolean>;
  try {
    params = nodeCreateParams(acceptedSnapshot.value, draft.value);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '请检查节点参数。';
    await showFeedback();
    return;
  }
  busy.value = true;
  try {
    submitted.value = await props.submit(params, baselineRevision.value);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '提交响应无效。';
    if (error instanceof ApiError && error.status === 409) {
      submissionConflict.value = true;
      message.value = '提交冲突：' + error.message;
    } else if (
      !(error instanceof ApiError) ||
      error.status < 400 ||
      error.status >= 500 ||
      error.status === 408
    ) {
      uncertain.value = true;
      reviewed.value = false;
    }
  } finally {
    busy.value = false;
    await showFeedback();
  }
}
</script>

<template>
  <SideDrawer
    v-if="active"
    label="添加机器节点"
    wide
    :dismissible="!busy"
    :return-focus-to="returnFocusTo"
    @close="emit('close')"
  >
    <template #subtitle
      ><p class="creator-subtitle">{{ machineName }} · 按机器上报能力创建</p></template
    >
    <div v-if="conflicted && !task && !uncertain" class="creator-warning" role="alert">
      <strong>机器版本或内核能力已变化</strong>
      <p>草稿已保留。核对最新机器信息后，采用最新版本再创建。</p>
      <small>草稿版本 {{ baselineRevision.slice(0, 12) }} → 当前 {{ revision.slice(0, 12) }}</small>
      <button type="button" :disabled="busy" @click="adopt">采用最新版本</button>
    </div>
    <div
      v-if="preparation"
      class="creator-task preparation"
      role="status"
      aria-label="内核准备任务"
    >
      <strong>内核准备 · {{ machineStatusLabels[preparation.status] }}</strong>
      <p>
        {{
          preparation.message ||
          (preparing ? '等待机器完成内核操作。' : '请核对最新内核状态，再手动创建节点。')
        }}
      </p>
      <small>任务 {{ preparation.id }} · 完成后不会自动创建节点。</small>
      <p v-if="preparation.status === 'unknown'">
        内核操作结果未知，请核对机器与任务记录；不会自动重试。
      </p>
      <button type="button" @click="emit('showTasks')">查看任务记录</button>
    </div>
    <form id="machine-node-creator" @submit.prevent="create">
      <section class="creator-section templates">
        <div class="section-heading">
          <h3>选择模板</h3>
          <button type="button" :disabled="locked" @click="reset">恢复模板默认</button>
        </div>
        <div class="template-cards">
          <button
            v-for="item in mainTemplates"
            :key="item.id"
            type="button"
            class="template-card"
            :class="{ selected: profile === item.id }"
            :aria-label="item.label"
            :aria-pressed="profile === item.id"
            :disabled="locked || !protocolChoices.some((choice) => choice.id === item.id)"
            @click="chooseProfile(item.id)"
          >
            <strong>{{ item.label }}</strong
            ><span>{{ item.detail }}</span
            ><small>{{
              protocolChoices.some((choice) => choice.id === item.id)
                ? item.description
                : '机器未上报此协议配置，请查看更多协议。'
            }}</small>
          </button>
        </div>
        <details class="more-protocols" :open="!mainTemplates.some((item) => item.id === profile)">
          <summary>
            更多协议 <span>{{ protocolChoices.length }} 种已上报配置</span>
          </summary>
          <label
            >协议配置<select
              :value="profile"
              aria-label="更多协议"
              :disabled="locked"
              @change="chooseProfile(($event.target as HTMLSelectElement).value)"
            >
              <option v-if="!protocolChoices.some((item) => item.id === profile)" :value="profile">
                {{ profile || '机器尚未上报协议配置' }}
              </option>
              <option v-for="item in protocolChoices" :key="item.id" :value="item.id">
                {{ item.label }} · {{ item.id }}
              </option>
            </select></label
          >
        </details>
        <p v-if="!template.known" class="creator-help">
          此配置由机器上报，界面仅提供通用字段。协议专属参数沿用机器原生 profile
          默认值，并由机器最终校验。
        </p>
        <p v-if="profile.startsWith('anytls-')" class="creator-help">
          原生兼容说明：AnyTLS 使用 sing-box 1.12+；padding 沿用内核默认，创建时由机器校验。
        </p>
        <p v-if="profile === 'trojan-grpc-reality'" class="creator-warning">
          原生兼容说明：Xray 26.3.27、26.6.27、26.9.9 已知连接失败；其他版本需单独验证。
        </p>
      </section>
      <template v-for="section in sections" :key="section.id">
        <component
          :is="['basic', 'tls'].includes(section.id) ? 'section' : 'details'"
          v-if="fields.some((field) => field.section === section.id)"
          class="creator-section"
        >
          <h3 v-if="['basic', 'tls'].includes(section.id)">
            {{ section.label }}<small v-if="section.id === 'basic'"> * 必填</small>
          </h3>
          <summary v-else>
            {{ section.label }}<span>{{ sectionSummary(section.id) }}</span>
          </summary>
          <div class="creator-fields">
            <label
              v-for="field in fields.filter((item) => item.section === section.id)"
              :key="field.key"
              :class="{ full: field.full }"
            >
              <span
                >{{ field.label
                }}<span v-if="field.required" class="required" aria-hidden="true"> *</span></span
              >
              <select
                v-if="field.options"
                :value="draft.values[field.key]"
                :aria-label="field.label"
                :disabled="locked"
                :required="field.required"
                @change="updateField(field, $event)"
              >
                <option
                  v-if="!field.options.some((option) => option.value === draft.values[field.key])"
                  :value="draft.values[field.key]"
                >
                  {{ draft.values[field.key] || '请选择' }}
                </option>
                <option
                  v-for="option in field.options"
                  :key="option.value"
                  :value="option.value"
                  :disabled="!!option.reason"
                >
                  {{ option.label }}{{ option.reason ? '（当前版本不支持）' : '' }}
                </option>
              </select>
              <input
                v-else
                :value="draft.values[field.key]"
                :aria-label="field.label"
                :type="field.number ? 'number' : 'text'"
                :min="field.number ? 1 : undefined"
                :max="field.key === 'port' ? 65535 : undefined"
                :step="field.number ? 1 : undefined"
                :placeholder="field.placeholder"
                :required="field.required"
                :disabled="locked"
                :data-drawer-initial-focus="field.key === 'name' && !locked ? '' : undefined"
                autocomplete="off"
                @input="updateField(field, $event)"
              />
              <small class="field-source">{{ source(field) }}</small>
              <small v-if="field.hint">{{ field.hint }}</small>
              <small
                v-for="reason in unavailableOptions(field)"
                :key="reason"
                class="feature-reason"
                >{{ reason }}</small
              >
            </label>
          </div>
          <div v-if="section.id === 'basic' && !capability.available" class="creator-warning">
            <p>{{ capability.reason }}</p>
            <button
              v-if="capability.action"
              type="button"
              :disabled="locked || !enabled || !!preparing || conflicted"
              @click="prepare(capability.action)"
            >
              {{ capability.action === 'core.install' ? '安装' : '升级' }} {{ draft.values.core }}
            </button>
            <small v-else>请先通过机器支持的方式准备兼容内核，再刷新机器信息。</small>
          </div>
          <div
            v-if="
              section.id === 'performance' &&
              fields.some((field) => unavailableOptions(field).length) &&
              coreState?.installed &&
              acceptedSnapshot.capabilities.actions.includes('core.update')
            "
            class="upgrade-hint"
          >
            <small>升级内核可使用更多受版本限制的功能。</small
            ><button
              type="button"
              :disabled="locked || !enabled || !!preparing || conflicted"
              @click="prepare('core.update')"
            >
              升级 {{ draft.values.core }}
            </button>
          </div>
        </component>
      </template>
      <p class="credentials-note">{{ credentialLabel }}</p>
      <label class="creator-checkbox"
        ><input
          v-model="draft.installDeps"
          type="checkbox"
          :disabled="locked"
        />自动安装必要系统工具</label
      >
      <p class="creator-help">
        只安装本次操作需要的系统工具，不包含代理内核。实际端口占用、证书及内核配置由机器原生校验。
      </p>
      <p v-if="!enabled" class="creator-warning">机器已停用，启用后才能提交创建任务。</p>
      <p v-if="message" ref="validationFeedback" class="creator-warning" role="alert" tabindex="-1">
        {{ message }}
      </p>
      <div
        v-if="uncertain"
        ref="feedback"
        class="creator-warning"
        role="status"
        aria-label="未确认提交结果"
        tabindex="-1"
      >
        <strong>未确认提交结果</strong>
        <p>
          请求可能已被接受。草稿已保留，暂时禁止再次提交；请先核对任务记录和当前节点，避免重复创建。
        </p>
        <button type="button" @click="emit('showTasks')">查看任务记录</button>
        <label class="creator-checkbox"
          ><input v-model="reviewed" type="checkbox" />已核对任务与节点，确认未创建</label
        >
        <button type="button" :disabled="!reviewed" @click="resumeAfterReview">继续编辑</button>
      </div>
      <div
        v-if="task"
        ref="feedback"
        class="creator-task"
        :class="{ warning: ['conflict', 'failed', 'unknown'].includes(task.status) }"
        role="status"
        aria-label="创建节点任务"
        tabindex="-1"
      >
        <strong>{{ machineStatusLabels[task.status] }}</strong>
        <p>{{ task.message || '任务已提交，等待机器回执。' }}</p>
        <p v-if="task.status === 'applied'">节点配置已应用；实际连通性需另行测试。</p>
        <p v-if="task.status === 'pending_restart'">
          配置已保存，等待对应内核重启生效；尚不代表节点已运行。
        </p>
        <p v-if="task.status === 'unknown'">结果未知，请核对当前节点与任务记录；不会自动重试。</p>
        <p v-if="task.status === 'conflict'">机器版本冲突，本次任务未应用；输入已保留。</p>
        <button v-if="task.status === 'conflict'" type="button" @click="adopt">采用最新版本</button>
        <small>任务 {{ task.id }}</small
        ><button type="button" @click="emit('showTasks')">查看任务记录</button>
      </div>
    </form>
    <template #footer>
      <div class="creator-summary" aria-label="创建节点摘要">
        <strong>{{ draft.values.name || '待填写节点名称' }}</strong>
        <span
          >{{ profile || '尚无可用协议' }} · {{ draft.values.core || '未选择内核' }} ·
          {{ draft.values.port ? '端口 ' + draft.values.port : '待填写端口' }}</span
        >
        <small>{{
          draft.values['address-mode'] === 'auto'
            ? '客户端连接地址：机器自动探测'
            : '客户端连接地址：' + draft.values.address
        }}</small>
      </div>
      <small class="footer-help">{{
        task ? '以机器回执为准' : conflicted ? '请先采用最新版本' : '创建后在此查看任务结果'
      }}</small>
      <button type="button" :disabled="busy" @click="emit('close')">
        {{ task ? '返回节点' : '取消' }}
      </button>
      <button v-if="!task" form="machine-node-creator" class="primary" :disabled="!canCreate">
        {{ busy ? '正在提交…' : '创建节点' }}
      </button>
    </template>
  </SideDrawer>
</template>

<style scoped>
.creator-subtitle {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.creator-summary {
  flex-basis: 100%;
  min-width: 0;
  display: grid;
  gap: 5px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.creator-summary strong {
  color: var(--primary);
}
.creator-summary span {
  font-size: 12px;
}
.creator-section {
  padding: 22px 0;
  border-bottom: 1px solid var(--border);
}
h3,
summary {
  font-size: 15px;
  font-weight: 650;
  margin: 0 0 16px;
}
summary {
  cursor: pointer;
}
summary span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
details:not([open]) > summary {
  margin-bottom: 0;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.section-heading h3 {
  margin: 0;
}
.section-heading button {
  font-size: 12px;
}
.template-cards,
.creator-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.template-card {
  display: grid;
  gap: 8px;
  text-align: left;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  white-space: normal;
}
.template-card strong {
  font-size: 16px;
}
.template-card span {
  font-size: 12px;
}
.template-card.selected {
  border-color: var(--primary);
  background: var(--ok-bg);
  box-shadow: inset 0 0 0 1px var(--primary);
}
.template-card:disabled {
  opacity: 0.65;
}
.more-protocols {
  margin-top: 18px;
}
.full {
  grid-column: 1 / -1;
}
.creator-fields label {
  min-width: 0;
}
.creator-fields input,
.creator-fields select,
.more-protocols select {
  min-width: 0;
  width: 100%;
}
.required {
  color: var(--warn-text);
}
small,
.creator-help {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
}
.field-source {
  color: var(--primary);
}
.feature-reason {
  color: var(--warn-text);
}
.creator-checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
.creator-checkbox input {
  flex-shrink: 0;
}
.credentials-note {
  padding: 12px 16px;
  background: var(--ok-bg);
  border-radius: 8px;
  font-size: 13px;
}
.creator-warning {
  padding: 14px;
  margin-top: 16px;
  background: var(--warn-bg);
  color: var(--warn-text);
  border: 1px solid #e7d5a8;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.creator-warning p {
  margin: 0 0 8px;
}
.creator-warning small {
  display: block;
}
.creator-warning button,
.creator-task button {
  margin-top: 10px;
}
.creator-task {
  margin-top: 16px;
  padding: 16px;
  border-radius: 8px;
  background: var(--ok-bg);
  color: var(--ok-text);
  overflow-wrap: anywhere;
}
.creator-task.warning {
  background: var(--warn-bg);
  color: var(--warn-text);
}
.creator-task p {
  font-size: 13px;
  line-height: 1.7;
  margin: 8px 0;
}
.creator-task small {
  display: block;
}
.upgrade-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 16px;
}
.footer-help {
  margin-right: auto;
  align-self: center;
}
@media (max-width: 460px) {
  .creator-fields {
    grid-template-columns: 1fr;
  }
  .template-cards {
    gap: 10px;
  }
  .template-card {
    padding: 12px;
  }
  .template-card span {
    overflow-wrap: anywhere;
  }
  .footer-help {
    flex-basis: 100%;
  }
}
</style>
