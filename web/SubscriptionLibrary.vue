<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
} from '../server/shared/subscriptions';
import { resourceSchema, type Resource, type NodeSelector } from '../server/shared/resources';
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
  inputKind = ref<'resource' | 'node'>('resource'),
  candidate = ref(''),
  node = ref<NodeSelector | null>(null),
  preview = ref(''),
  previewFormat = ref<OutputFormat>('mihomo'),
  confirming = ref<'delete' | 'revoke' | null>(null);
const groupLabels = { uri: 'URI / Base64', mihomo: 'Mihomo', singbox: 'sing-box', xray: 'Xray' };
const diagnostics = ref<Diagnostic[]>([]);
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  diagnostics.value = [];
  try {
    await fn();
  } catch (e) {
    message.value = e instanceof Error ? e.message : '操作失败。';
    if (e instanceof ApiError) diagnostics.value = e.diagnostics;
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
  baseline.value = null;
  form.value = newSubscription();
  preview.value = '';
  await candidates();
}
async function edit(row: Subscription) {
  baseline.value = subscriptionDetailSchema.parse(await props.api('/api/subscriptions/' + row.id));
  form.value = subscriptionConfigSchema.strip().parse(baseline.value);
  preview.value = '';
  previewFormat.value = baseline.value.formats[0]!;
  await candidates();
}
function add() {
  if (!form.value) return;
  const input: InputRef | null =
    inputKind.value === 'node'
      ? node.value
        ? { kind: 'node', ...node.value }
        : null
      : candidate.value
        ? { kind: inputKind.value, id: candidate.value }
        : null;
  if (input && !form.value.inputs.some((v) => inputKey(v) === inputKey(input)))
    form.value.inputs.push(input);
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
  baseline.value = subscriptionDetailSchema.parse(
    await props.api(
      '/api/subscriptions' + (baseline.value ? '/' + baseline.value.id : ''),
      { ...parsed.data, ...(baseline.value ? { revision: baseline.value.revision } : {}) },
      baseline.value ? 'PATCH' : 'POST',
    ),
  );
  form.value = subscriptionConfigSchema.strip().parse(baseline.value);
  preview.value = '';
  previewFormat.value = baseline.value.formats[0]!;
  await load();
  message.value = '方案与输出文件已保存到 Sub-Store。';
}
async function showPreview(force = false) {
  if (!baseline.value) return;
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
  if (baseline.value)
    baseline.value = subscriptionDetailSchema.parse(
      await props.api('/api/subscriptions/' + baseline.value.id + '/share', {
        revision: baseline.value.revision,
      }),
    );
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
    <p v-if="message" role="status" class="notice">{{ message }}</p>
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
        <label>方案名称<input v-model="form.name" required maxlength="512" /></label
        ><label><input v-model="form.enabled" type="checkbox" />启用方案</label>
        <fieldset>
          <legend>输入与顺序</legend>
          <div class="add-input">
            <label
              >输入类型<select v-model="inputKind" @change="candidate = ''">
                <option value="resource">订阅或组合</option>
                <option value="node">单个节点</option>
              </select></label
            ><label v-if="inputKind !== 'node'"
              >选择输入<select v-model="candidate">
                <option value="">请选择</option>
                <option v-for="r in resources" :key="r.id" :value="r.id">
                  {{ r.name }}{{ r.type === 'collection' ? '（组合）' : '' }}
                </option>
              </select></label
            ><button v-if="inputKind !== 'node'" type="button" @click="add">加入输入</button>
          </div>
          <template v-if="inputKind === 'node'"
            ><NodePicker v-model="node" label="单个节点" :api="api" /><button
              type="button"
              @click="add"
            >
              加入输入
            </button></template
          >
          <ol class="input-list">
            <li v-for="(input, index) in form.inputs" :key="inputKey(input)">
              <span>{{ label(input) }}</span>
              <div>
                <button type="button" :disabled="index === 0" @click="move(index, -1)">上移</button
                ><button
                  type="button"
                  :disabled="index === form.inputs.length - 1"
                  @click="move(index, 1)"
                >
                  下移</button
                ><button type="button" @click="form.inputs.splice(index, 1)">移除</button>
              </div>
            </li>
          </ol>
        </fieldset>
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
      </form>
      <section v-if="baseline" class="output-section">
        <h3>生成与分享</h3>
        <p>客户端每次拉取时由 Sub-Store 按自身缓存规则生成。上游停机时链接不可用。</p>
        <p v-for="error in baseline.errors" :key="error" role="alert">{{ error }}</p>
        <div class="actions">
          <label
            >预览格式<select v-model="previewFormat">
              <option v-for="format in baseline.formats" :key="format" :value="format">
                {{ outputLabels[format] }}
              </option>
            </select></label
          ><button :disabled="busy" @click="act(() => showPreview())">预览输出</button
          ><button :disabled="busy" @click="act(() => showPreview(true))">刷新并生成</button
          ><button :disabled="busy" @click="act(share)">创建分享地址</button
          ><button :disabled="busy" class="danger" @click="confirming = 'revoke'">撤销分享</button>
        </div>
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
        <textarea v-if="preview" :value="preview" readonly rows="12" aria-label="生成结果" />
        <p v-if="previewFormat.startsWith('singbox')">
          sing-box 1.14 会自动取得 HY2
          证书并核验原指纹，再固定服务器公钥；同一公钥续签的证书仍可通过。首次生成需要节点可达，已验证的证书可复用。
        </p>
      </section>
      <p v-if="message" role="status" class="notice">{{ message }}</p>
      <div v-if="diagnostics.some((d) => d.level === 'error')" role="alert" class="diagnostics">
        <strong>生成错误</strong>
        <ul>
          <li v-for="(d, i) in diagnostics.filter((d) => d.level === 'error')" :key="i">
            第 {{ d.nodeIndex + 1 }} 项：{{ d.message }}
          </li>
        </ul>
      </div>
      <details v-if="diagnostics.some((d) => d.level === 'warning')" class="diagnostics">
        <summary>提示（不导致生成失败）</summary>
        <ul>
          <li v-for="(d, i) in diagnostics.filter((d) => d.level === 'warning')" :key="i">
            第 {{ d.nodeIndex + 1 }} 项：{{ d.message }}
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
          保存方案
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
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.plan-row h2 {
  font-size: 18px;
}
.plan-row p {
  overflow-wrap: anywhere;
}
.plan-form {
  display: grid;
  gap: 18px;
}
.plan-form > label {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
}
.plan-form input:not([type='checkbox']) {
  min-width: 0;
  flex: 1;
}
fieldset {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
}
.formats,
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.formats label {
  display: flex;
  flex-direction: row;
  gap: 7px;
  align-items: center;
}
.settings-grid label {
  display: grid;
  gap: 5px;
  margin-top: 10px;
}
.add-input,
.actions,
.pagination {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.add-input label {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.add-input select {
  max-width: 100%;
}
.input-list {
  padding-left: 22px;
}
.input-list li {
  padding: 8px 0;
  overflow-wrap: anywhere;
}
.input-list li div {
  display: flex;
  gap: 6px;
  margin-top: 5px;
}
.output-section {
  margin-top: 24px;
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
.output-section > textarea {
  width: 100%;
  font-family: var(--mono);
  margin-top: 12px;
}
.share-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  margin-top: 12px;
}
.share-row label {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.share-row input {
  width: 100%;
  min-width: 0;
}
.pagination {
  justify-content: flex-end;
  margin-top: 18px;
}
@media (max-width: 650px) {
  .formats,
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .plan-row {
    flex-wrap: wrap;
  }
  .add-input {
    display: grid;
  }
  .add-input label,
  .actions label {
    width: 100%;
    display: grid;
    gap: 6px;
  }
}
</style>
