<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { z } from 'zod';
import {
  subscriptionListSchema,
  subscriptionDetailSchema,
  subscriptionConfigSchema,
  newSubscription,
  outputFormats,
  outputLabels,
  targetGroups,
  inputKey,
  artifactSchema,
  type Subscription,
  type SubscriptionDetail,
  type SubscriptionConfig,
  type InputRef,
  type OutputFormat,
  type SubscriptionValidation,
} from '../server/shared/subscriptions';
import { resourceSchema, type Resource } from '../server/shared/resources';
import { ApiError } from './api';
import type { Diagnostic } from '../server/shared/contracts';
import NodePicker from './NodePicker.vue';
import ModalDialog from './ui/ModalDialog.vue';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const rows = ref<Subscription[]>([]),
  page = ref(0),
  total = ref(0),
  busy = ref(false),
  message = ref(''),
  form = ref<SubscriptionConfig | null>(null),
  baseline = ref<SubscriptionDetail | null>(null);
const resources = ref<Resource[]>([]),
  preview = ref(''),
  previewFormat = ref<OutputFormat>('mihomo'),
  confirming = ref<'delete' | 'revoke' | null>(null);
const groupLabels = { uri: 'URI / Base64', mihomo: 'Mihomo', singbox: 'sing-box', xray: 'Xray' };
const diagnostics = ref<Diagnostic[]>([]);
const validation = ref<SubscriptionValidation>([]);
const validationConfig = ref('');
const savedConfig = ref('');
const checking = ref<'save' | 'share' | null>(null);
const validationPanel = ref<HTMLElement | null>(null);
const shareAddresses = ref<HTMLElement | null>(null);
const formConfig = computed(() => JSON.stringify(form.value));
const dirty = computed(() => formConfig.value !== savedConfig.value);
const currentValidation = computed(() =>
  formConfig.value === validationConfig.value ? validation.value : [],
);
const hasProblems = computed(() => currentValidation.value.some((result) => result.state !== 'ok'));
const hasShares = computed(
  () => baseline.value && Object.values(baseline.value.urls).some((urls) => urls.length > 0),
);
const validationLabels = { ok: '可生成', failed: '生成失败', unverified: '无法确认' };
function diagnosticLocation(detail: Diagnostic) {
  if (detail.location) {
    const location = detail.location;
    return ['输入第 ' + (location.inputIndex + 1) + ' 项', location.resourceName, location.nodeName]
      .filter(Boolean)
      .join(' · ');
  }
  return detail.nodeIndex >= 0 ? '第 ' + (detail.nodeIndex + 1) + ' 个节点' : '';
}
async function showValidation(result: SubscriptionValidation, focus = true) {
  validation.value = result;
  validationConfig.value = formConfig.value;
  await nextTick();
  if (focus) validationPanel.value?.focus();
}
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  diagnostics.value = [];
  try {
    await fn();
  } catch (e) {
    message.value = e instanceof Error ? e.message : '操作失败。';
    if (e instanceof ApiError) {
      diagnostics.value = e.diagnostics;
      if (e.subscriptionValidation) await showValidation(e.subscriptionValidation);
    }
  } finally {
    busy.value = false;
  }
}
async function load() {
  const value = subscriptionListSchema.parse(
    await props.api('/api/subscriptions?page=' + page.value),
  );
  rows.value = value.subscriptions;
  total.value = value.total;
}
async function candidates() {
  resources.value = z
    .object({ resources: z.array(resourceSchema) })
    .parse(await props.api('/api/nodes/resources')).resources;
}
function label(input: InputRef) {
  return input.kind === 'node'
    ? input.nodeName +
        ' · ' +
        (resources.value.find((r) => r.id === input.resourceId)?.name ?? '引用失效')
    : (resources.value.find((r) => r.id === input.id)?.name ?? '引用失效');
}
async function create() {
  await candidates();
  baseline.value = null;
  form.value = newSubscription();
  savedConfig.value = '';
  validation.value = [];
  preview.value = '';
}
async function edit(row: Subscription) {
  const detail = subscriptionDetailSchema.parse(await props.api('/api/subscriptions/' + row.id));
  await candidates();
  baseline.value = detail;
  form.value = subscriptionConfigSchema.strip().parse(baseline.value);
  savedConfig.value = formConfig.value;
  validation.value = [];
  preview.value = '';
  previewFormat.value = baseline.value.formats[0]!;
}
function addInputs(inputs: InputRef[]) {
  form.value?.inputs.push(...inputs);
}
function move(index: number, delta: number) {
  if (!form.value) return;
  const next = index + delta;
  if (next < 0 || next >= form.value.inputs.length) return;
  const item = form.value.inputs.splice(index, 1)[0]!;
  form.value.inputs.splice(next, 0, item);
}
async function save() {
  const parsed = subscriptionConfigSchema.safeParse(form.value);
  if (!parsed.success) throw new Error('请填写名称，添加输入，并至少选择一种输出。');
  validationConfig.value = '';
  checking.value = 'save';
  try {
    baseline.value = subscriptionDetailSchema.parse(
      await props.api(
        '/api/subscriptions' + (baseline.value ? '/' + baseline.value.id : ''),
        { ...parsed.data, ...(baseline.value ? { revision: baseline.value.revision } : {}) },
        baseline.value ? 'PATCH' : 'POST',
      ),
    );
    form.value = subscriptionConfigSchema.strip().parse(baseline.value);
    savedConfig.value = formConfig.value;
    preview.value = '';
    previewFormat.value = baseline.value.formats[0]!;
    const result = baseline.value.validation ?? [];
    const problems = result.filter((item) => item.state !== 'ok');
    message.value = problems.length
      ? '方案已保存，' + problems.length + ' 种格式有生成问题，请查看检查结果。'
      : '方案与输出文件已保存到 Sub-Store。';
    await showValidation(result);
    await load();
  } finally {
    checking.value = null;
  }
}
async function showPreview(force = false) {
  if (!baseline.value || dirty.value) return;
  preview.value = '';
  const result = artifactSchema.parse(
    await props.api(
      '/api/subscriptions/' +
        baseline.value.id +
        '/artifacts/' +
        previewFormat.value +
        (force ? '?refresh=1' : ''),
    ),
  );
  preview.value = result.content;
  message.value = force ? '已刷新上游并重新生成。' : '已由 Sub-Store 生成。';
}
async function share() {
  if (!baseline.value || dirty.value) return;
  validationConfig.value = '';
  checking.value = 'share';
  try {
    baseline.value = subscriptionDetailSchema.parse(
      await props.api('/api/subscriptions/' + baseline.value.id + '/share', {
        revision: baseline.value.revision,
      }),
    );
    message.value = '已检查所选格式，分享地址已就绪。';
    await showValidation(baseline.value.validation ?? [], false);
    shareAddresses.value?.querySelector('input')?.focus();
  } finally {
    checking.value = null;
  }
}
async function confirm() {
  if (!baseline.value) return;
  const path = '/api/subscriptions/' + baseline.value.id;
  const revision = baseline.value.revision;
  if (confirming.value === 'delete') {
    await props.api(path, { revision }, 'DELETE');
    form.value = null;
    baseline.value = null;
    await load();
  } else
    baseline.value = subscriptionDetailSchema.parse(
      await props.api(path + '/revoke', { revision }),
    );
  confirming.value = null;
}
function protocols(group: (typeof targetGroups)[number], event: Event) {
  if (form.value)
    form.value.protocols[group] = (event.target as HTMLInputElement).value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
}
async function copy(url: string, event: Event) {
  const input = (event.currentTarget as HTMLElement).closest('.share-row')?.querySelector('input');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      message.value = '已复制分享地址。';
      return;
    }
  } catch {
    // The browser may deny Clipboard API access even on HTTPS.
  }
  if (input) {
    input.focus();
    input.select();
    try {
      if (document.execCommand('copy')) {
        message.value = '已复制分享地址。';
        return;
      }
    } catch {
      // Keep the visible link selected for manual copying.
    }
  }
  message.value = '无法自动复制，请从分享地址输入框手动复制。';
}
onMounted(() => void act(load));
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>输出方案</h1>
        <p>选择订阅或节点，由 Sub-Store 按需生成和分享。</p>
      </div>
      <button class="primary" :disabled="busy" @click="act(create)">添加输出方案</button>
    </header>
    <p v-if="message && !form" role="status" class="notice">{{ message }}</p>
    <div class="panel">
      <p v-if="!rows.length">尚未创建输出方案。</p>
      <article v-for="row in rows" :key="row.id" class="plan-row">
        <div>
          <h2>{{ row.name }}</h2>
          <p>{{ row.formats.map((f) => outputLabels[f]).join(' · ') }}</p>
        </div>
        <button :disabled="busy" @click="act(() => edit(row))">管理方案</button>
      </article>
    </div>
    <div class="pagination">
      <button
        :disabled="busy || page === 0"
        @click="
          page--;
          act(load);
        "
      >
        上一页</button
      ><span>{{ page + 1 }}</span
      ><button
        :disabled="busy || (page + 1) * 25 >= total"
        @click="
          page++;
          act(load);
        "
      >
        下一页
      </button>
    </div>
    <ModalDialog
      v-if="form"
      label="管理输出方案"
      wide
      :dismissible="!busy"
      @close="
        form = null;
        baseline = null;
      "
      ><h2>管理输出方案</h2>
      <form id="plan-form" class="plan-form" @submit.prevent="act(save)">
        <fieldset class="plan-controls" :disabled="busy">
          <label class="plan-name"
            >方案名称<input v-model="form.name" required maxlength="512"
          /></label>
          <label class="enable-plan"
            ><input v-model="form.enabled" type="checkbox" />启用方案</label
          >
          <NodePicker
            :api="api"
            :inputs="form.inputs"
            :resources="resources"
            :disabled="busy"
            @add="addInputs"
            @resources="resources = $event"
          />
          <section aria-label="已加入的方案输入">
            <h3>已加入 {{ form.inputs.length }} 项输入</h3>
            <p v-if="!form.inputs.length" class="muted">选择节点、订阅或组合后加入方案。</p>
            <ol v-else class="input-list">
              <li v-for="(input, index) in form.inputs" :key="inputKey(input)">
                <span>{{ label(input) }}</span>
                <div>
                  <button
                    type="button"
                    :disabled="index === 0"
                    :aria-label="'上移 ' + label(input)"
                    @click="move(index, -1)"
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    :disabled="index === form.inputs.length - 1"
                    :aria-label="'下移 ' + label(input)"
                    @click="move(index, 1)"
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    :aria-label="'移除 ' + label(input)"
                    @click="form.inputs.splice(index, 1)"
                  >
                    移除
                  </button>
                </div>
              </li>
            </ol>
          </section>
          <fieldset>
            <legend>输出格式</legend>
            <div class="formats">
              <label v-for="format in outputFormats" :key="format"
                ><input v-model="form.formats" type="checkbox" :value="format" />{{
                  outputLabels[format]
                }}</label
              >
            </div>
          </fieldset>
          <details>
            <summary>筛选与完整配置设置</summary>
            <div class="settings-grid">
              <label>名称包含<input v-model="form.includeName" /></label
              ><label>名称排除<input v-model="form.excludeName" /></label
              ><label>名称前缀<input v-model="form.prefix" /></label
              ><label>名称后缀<input v-model="form.suffix" /></label
              ><label
                >本机监听端口<input
                  v-model.number="form.listenPort"
                  type="number"
                  min="1"
                  max="65535" /></label
              ><label v-for="group in targetGroups" :key="group"
                >{{ groupLabels[group] }} 协议筛选<input
                  :value="form.protocols[group].join(',')"
                  placeholder="留空表示全部"
                  @input="protocols(group, $event)"
              /></label>
            </div>
            <p>协议用英文逗号分隔，例如 ss,vless。未筛选且无法完整转换的节点会明确报错。</p>
          </details>
        </fieldset>
      </form>
      <p v-if="message" role="status" aria-label="方案操作结果" class="notice">{{ message }}</p>
      <p v-if="checking" role="status" class="notice">正在检查所选格式，读取上游节点与模板…</p>
      <section
        v-if="currentValidation.length"
        ref="validationPanel"
        class="validation-section"
        aria-label="输出检查结果"
        tabindex="-1"
      >
        <h3>输出检查结果</h3>
        <p v-if="!form.enabled" class="muted">以下按启用后的配置试生成。</p>
        <p v-if="hasProblems && hasShares" class="share-warning" role="alert">
          已有分享地址会读取保存后的方案，生成问题可能影响这些地址的使用。
        </p>
        <article
          v-for="result in currentValidation"
          :key="result.format"
          class="validation-row"
          :data-state="result.state"
        >
          <h4>
            {{ outputLabels[result.format] }}<span>{{ validationLabels[result.state] }}</span>
          </h4>
          <template v-if="result.state !== 'ok'">
            <p>{{ result.message }}</p>
            <ul v-if="result.diagnostics?.length">
              <li v-for="(detail, index) in result.diagnostics" :key="index">
                <strong v-if="diagnosticLocation(detail)">{{ diagnosticLocation(detail) }}</strong>
                <span>{{ detail.message }}</span>
              </li>
            </ul>
          </template>
        </article>
      </section>
      <section v-if="baseline" class="output-section">
        <h3>生成与分享</h3>
        <p>客户端每次拉取时由 Sub-Store 按自身缓存规则生成。上游停机时链接不可用。</p>
        <p v-for="error in baseline.errors" :key="error" role="alert">{{ error }}</p>
        <p v-if="dirty" class="share-warning">保存当前修改后可预览输出或创建分享地址。</p>
        <p v-else-if="!form.enabled" class="muted">启用并保存方案后可创建分享地址。</p>
        <div class="actions">
          <label
            >预览格式<select v-model="previewFormat" :disabled="busy" @change="preview = ''">
              <option v-for="format in baseline.formats" :key="format" :value="format">
                {{ outputLabels[format] }}
              </option>
            </select></label
          ><button :disabled="busy || dirty || !form.enabled" @click="act(() => showPreview())">
            预览输出</button
          ><button :disabled="busy || dirty || !form.enabled" @click="act(() => showPreview(true))">
            刷新并生成</button
          ><button :disabled="busy || dirty || !form.enabled" @click="act(share)">
            创建分享地址</button
          ><button :disabled="busy" class="danger" @click="confirming = 'revoke'">撤销分享</button>
        </div>
        <div ref="shareAddresses">
          <div v-for="(urls, format) in baseline.urls" :key="format">
            <div v-for="url in urls" :key="url" class="share-row">
              <label
                >{{ outputLabels[format]
                }}<input
                  :value="url"
                  readonly
                  :aria-label="outputLabels[format] + ' 分享地址'" /></label
              ><button :disabled="busy" @click="act(() => copy(url, $event))">复制</button>
            </div>
          </div>
        </div>
        <textarea
          v-if="preview && !dirty"
          :value="preview"
          readonly
          rows="12"
          aria-label="生成结果"
        />
        <p v-if="previewFormat.startsWith('singbox')">
          sing-box 1.14 会自动取得 HY2
          证书并核验原指纹，再固定服务器公钥；同一公钥续签的证书仍可通过。首次生成需要节点可达，已验证的证书可复用。
        </p>
      </section>
      <div v-if="diagnostics.some((d) => d.level === 'error')" role="alert" class="diagnostics">
        <strong>生成错误</strong>
        <ul>
          <li v-for="(d, i) in diagnostics.filter((d) => d.level === 'error')" :key="i">
            <strong v-if="diagnosticLocation(d)">{{ diagnosticLocation(d) }}</strong>
            {{ d.message }}
          </li>
        </ul>
      </div>
      <details v-if="diagnostics.some((d) => d.level === 'warning')" class="diagnostics">
        <summary>提示（不导致生成失败）</summary>
        <ul>
          <li v-for="(d, i) in diagnostics.filter((d) => d.level === 'warning')" :key="i">
            <strong v-if="diagnosticLocation(d)">{{ diagnosticLocation(d) }}</strong>
            {{ d.message }}
          </li>
        </ul>
      </details>
      <template #footer
        ><button v-if="baseline" class="danger" :disabled="busy" @click="confirming = 'delete'">
          删除方案</button
        ><button
          :disabled="busy"
          @click="
            form = null;
            baseline = null;
          "
        >
          关闭</button
        ><button form="plan-form" type="submit" class="primary" :disabled="busy">
          {{ checking === 'save' ? '正在检查并保存…' : '检查并保存' }}
        </button></template
      ></ModalDialog
    >
    <ModalDialog
      v-if="confirming"
      :label="confirming === 'delete' ? '删除输出方案' : '撤销分享'"
      elevated
      :dismissible="!busy"
      @close="confirming = null"
      ><h2>{{ confirming === 'delete' ? '删除输出方案' : '撤销全部分享地址' }}</h2>
      <p>
        已有客户端地址将失效。{{
          confirming === 'delete' ? '上游节点会保留。' : '重新创建分享将获得新的地址。'
        }}
      </p>
      <template #footer
        ><button :disabled="busy" @click="confirming = null">取消</button
        ><button class="danger" :disabled="busy" @click="act(confirm)">
          确认{{ confirming === 'delete' ? '删除' : '撤销' }}
        </button></template
      ></ModalDialog
    >
  </section>
</template>
<style scoped>
.plan-row {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) 0;
  border-bottom: var(--border-width) solid var(--border);
}
.plan-row h2 {
  font-size: var(--text-lg);
}
.plan-row p {
  overflow-wrap: anywhere;
}
.plan-controls {
  display: grid;
  gap: var(--space-5);
  border: 0;
  padding: 0;
  margin: 0;
}
.enable-plan {
  display: flex;
  flex-direction: row;
  gap: var(--space-2);
  align-items: center;
}
.plan-name {
  display: grid;
  gap: var(--space-2);
}
.plan-controls h3 {
  font-size: var(--text-base);
  margin-bottom: var(--space-2);
}
.plan-form input:not([type='checkbox']) {
  min-width: 0;
  flex: 1;
}
fieldset {
  min-width: 0;
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
}
.formats,
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.formats label {
  display: flex;
  flex-direction: row;
  gap: var(--space-2);
  align-items: center;
}
.settings-grid label {
  display: grid;
  gap: var(--space-1);
  margin-top: var(--space-3);
}
.actions,
.pagination {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
}
.input-list {
  padding-left: var(--space-6);
}
.input-list li {
  padding: var(--space-2) 0;
  overflow-wrap: anywhere;
}
.input-list li div {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.validation-section {
  margin-top: var(--space-5);
  scroll-margin-block: var(--space-4);
}
.validation-section h3 {
  font-size: var(--text-lg);
}
.validation-row {
  padding-block: var(--space-3);
  border-bottom: var(--border-width) solid var(--border);
  overflow-wrap: anywhere;
}
.validation-row h4 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
  font-size: var(--text-base);
}
.validation-row h4 span {
  font-size: var(--text-xs);
  color: var(--ok-text);
}
.validation-row[data-state='failed'] h4 span {
  color: var(--danger);
}
.validation-row[data-state='unverified'] h4 span,
.share-warning {
  color: var(--warn-text);
}
.validation-row li {
  margin-top: var(--space-2);
}
.validation-row li strong {
  display: block;
  font-weight: var(--weight-medium);
}
.output-section {
  margin-top: var(--space-6);
  border-top: var(--border-width) solid var(--border);
  padding-top: var(--space-5);
}
.output-section > textarea {
  width: 100%;
  font-family: var(--mono);
  margin-top: var(--space-3);
}
.share-row {
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
  margin-top: var(--space-3);
}
.share-row label {
  display: grid;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}
.share-row input {
  width: 100%;
  min-width: 0;
}
.pagination {
  justify-content: flex-end;
  margin-top: var(--space-5);
}
@media (max-width: 650px) {
  .formats,
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .plan-row {
    flex-wrap: wrap;
  }
  .actions label {
    width: 100%;
    display: grid;
    gap: var(--space-2);
  }
}
</style>
