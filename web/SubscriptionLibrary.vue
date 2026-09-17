<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { ApiError } from './api';
import { formatTime } from './format';
import ListPagination from './ui/ListPagination.vue';
import ModalDialog from './ui/ModalDialog.vue';
import StatusBadge from './ui/StatusBadge.vue';
import { chainListSchema } from '../server/shared/chains';
import { nodeListSchema, protocols } from '../server/shared/contracts';
import {
  sourceListSchema,
  subscriptionListSchema,
  subscriptionDetailSchema,
  issuedSubscriptionSchema,
  artifactSchema,
  subscriptionConfigSchema,
  newSubscription,
  outputFormats,
  outputLabels,
  targetGroups,
  type Artifact,
  type InputRef,
  type OutputFormat,
  type SubscriptionConfig,
  type SubscriptionDetail,
  type SubscriptionSummary,
} from '../server/shared/subscriptions';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const rows = ref<SubscriptionSummary[]>([]),
  page = ref(0),
  total = ref(0),
  busy = ref(false),
  message = ref(''),
  conflict = ref(false);
const form = ref<SubscriptionConfig | null>(null),
  baseline = ref<SubscriptionDetail | null>(null),
  status = ref<SubscriptionDetail | null>(null);
const urls = ref<Partial<Record<OutputFormat, string>>>({}),
  preview = ref<Artifact | null>(null);
const pane = ref<'settings' | 'publish'>('settings');
const urlOrder: OutputFormat[] = [
  'uri',
  'mihomo',
  'base64',
  'mihomo-proxies',
  'singbox',
  'singbox-outbounds',
  'xray',
  'xray-outbounds',
];
const urlEntries = computed(() =>
  urlOrder
    .filter((format) => urls.value[format])
    .map((format) => [format, urls.value[format] ?? ''] as const),
);
const inputKind = ref<'source' | 'node' | 'chain'>('source'),
  inputPage = ref(0),
  inputTotal = ref(0),
  candidateId = ref('');
const candidates = ref<{ id: string; name: string; enabled: boolean; available: boolean }[]>([]),
  labels = ref<Record<string, string>>({});
const groupLabels = { uri: 'URI / Base64', mihomo: 'Mihomo', singbox: 'sing-box', xray: 'Xray' };
const selectedKeys = computed(() => new Set(form.value?.inputs.map((i) => i.kind + i.id)));
let alive = true,
  epoch = 0,
  previewTicket = 0,
  inputTicket = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
function clearTransient() {
  urls.value = {};
  preview.value = null;
  previewTicket++;
  clearTimeout(timer);
}
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  inputTicket++;
  clearTransient();
  form.value = null;
  baseline.value = null;
  status.value = null;
});
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await fn();
  } catch (e) {
    if (alive) {
      message.value = e instanceof Error ? e.message : '操作失败。';
      if (e instanceof ApiError && e.status === 409) conflict.value = true;
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function refresh() {
  const result = subscriptionListSchema.parse(
    await props.api('/api/subscriptions?page=' + page.value),
  );
  if (!alive) return;
  rows.value = result.subscriptions;
  total.value = result.total;
  if (!rows.value.length && page.value) {
    page.value--;
    await refresh();
  }
}
function remember(value: SubscriptionDetail) {
  for (const input of value.inputLabels)
    labels.value[input.kind + input.id] = input.name + (input.enabled ? '' : '（已停用）');
}
function apply(value: SubscriptionDetail) {
  baseline.value = value;
  status.value = value;
  form.value = subscriptionConfigSchema.strip().parse(value);
  conflict.value = false;
  remember(value);
}
function pollLater() {
  clearTimeout(timer);
  if (!alive || !status.value || status.value.generation === 'idle') return;
  const id = status.value.id,
    current = epoch;
  timer = setTimeout(
    () =>
      void refreshStatus(id, current).catch(() => {
        if (alive && current === epoch) message.value = '状态刷新失败，可点击刷新发布状态。';
      }),
    1000,
  );
}
async function refreshStatus(id: string, current = epoch) {
  const result = subscriptionDetailSchema.parse(await props.api('/api/subscriptions/' + id));
  if (!alive || current !== epoch || baseline.value?.id !== id) return;
  status.value = result;
  remember(result);
  if (preview.value) {
    const fresh = result.artifacts.find((a) => a.format === preview.value?.format);
    if (
      !fresh?.readable ||
      fresh.builtRevision !== preview.value.builtRevision ||
      fresh.engineVersion !== preview.value.engineVersion
    ) {
      preview.value = null;
      previewTicket++;
    }
  }
  pollLater();
}
async function refreshSelectedStatus() {
  const id = baseline.value?.id;
  if (id) await refreshStatus(id);
}
async function loadCandidates() {
  const ticket = ++inputTicket,
    kind = inputKind.value,
    p = inputPage.value;
  const raw = await props.api(
    (kind === 'source' ? '/api/sources' : kind === 'chain' ? '/api/chains' : '/api/nodes') +
      '?page=' +
      p,
  );
  const result =
    kind === 'source'
      ? sourceListSchema.parse(raw)
      : kind === 'chain'
        ? chainListSchema.parse(raw)
        : nodeListSchema.parse(raw);
  if (!alive || ticket !== inputTicket) return;
  const list =
    'sources' in result ? result.sources : 'chains' in result ? result.chains : result.nodes;
  candidates.value = list.map((item) => ({
    ...item,
    available: !('savedAt' in item) || item.savedAt !== null,
  }));
  inputTotal.value = result.total;
  candidateId.value = candidates.value.find((item) => item.available)?.id ?? '';
  for (const item of list)
    labels.value[kind + item.id] = item.name + (item.enabled ? '' : '（已停用）');
}
watch(inputKind, () => {
  inputPage.value = 0;
  void act(loadCandidates);
});
function closeForm() {
  epoch++;
  clearTransient();
  form.value = null;
  baseline.value = null;
  status.value = null;
}
function startNew() {
  epoch++;
  clearTransient();
  form.value = newSubscription();
  baseline.value = null;
  status.value = null;
  conflict.value = false;
  message.value = '';
  pane.value = 'settings';
  void act(loadCandidates);
}
async function edit(id: string, nextPane: 'settings' | 'publish' = 'publish') {
  const current = ++epoch;
  clearTransient();
  await act(async () => {
    const value = subscriptionDetailSchema.parse(await props.api('/api/subscriptions/' + id));
    if (!alive || current !== epoch) return;
    apply(value);
    pane.value = nextPane;
    await loadCandidates();
    if (alive) pollLater();
  });
}
async function save() {
  const current = epoch;
  await act(async () => {
    if (!form.value) return;
    if (baseline.value) {
      const value = subscriptionDetailSchema.parse(
        await props.api(
          '/api/subscriptions/' + baseline.value.id,
          { ...form.value, revision: baseline.value.revision },
          'PATCH',
        ),
      );
      if (!alive || current !== epoch) return;
      preview.value = null;
      previewTicket++;
      apply(value);
    } else {
      const value = issuedSubscriptionSchema.parse(
        await props.api('/api/subscriptions', form.value),
      );
      if (!alive || current !== epoch) return;
      apply(value.subscription);
      urls.value = value.urls;
      pane.value = 'publish';
    }
    pollLater();
    await refresh();
    if (alive) message.value = '方案已保存，已安排生成。';
  });
}
function addInput() {
  if (
    !form.value ||
    !candidateId.value ||
    selectedKeys.value.has(inputKind.value + candidateId.value)
  )
    return;
  form.value.inputs.push({ kind: inputKind.value, id: candidateId.value });
}
function move(index: number, delta: number) {
  if (!form.value) return;
  const [item] = form.value.inputs.splice(index, 1);
  if (item) form.value.inputs.splice(index + delta, 0, item);
}
function inputName(input: InputRef) {
  return labels.value[input.kind + input.id] ?? '引用已更改，请刷新或重新载入';
}
async function toggle(row: SubscriptionSummary) {
  await act(async () => {
    const value = subscriptionDetailSchema.parse(
      await props.api(
        '/api/subscriptions/' + row.id,
        { revision: row.revision, enabled: !row.enabled },
        'PATCH',
      ),
    );
    if (!alive) return;
    if (baseline.value?.id === row.id) {
      status.value = value;
      preview.value = null;
      previewTicket++;
      if (baseline.value.revision === row.revision && form.value) {
        baseline.value = value;
        form.value.enabled = value.enabled;
      } else conflict.value = true;
      pollLater();
    }
    await refresh();
    if (alive)
      message.value = row.enabled ? '方案已停用，订阅地址立即失效。' : '方案已启用，已安排生成。';
  });
}
async function remove(row: SubscriptionSummary) {
  if (!window.confirm('删除此方案？订阅地址将立即失效。')) return;
  await act(async () => {
    await props.api('/api/subscriptions/' + row.id, { revision: row.revision }, 'DELETE');
    if (!alive) return;
    if (baseline.value?.id === row.id) closeForm();
    await refresh();
  });
}
async function generate() {
  const before = baseline.value,
    current = epoch;
  if (!before) return;
  await act(async () => {
    const value = subscriptionDetailSchema.parse(
      await props.api('/api/subscriptions/' + before.id + '/generate', {
        revision: before.revision,
      }),
    );
    if (!alive || current !== epoch) return;
    status.value = value;
    pollLater();
    message.value = '已安排重新生成当前保存的设置。';
  });
}
async function resetToken() {
  const before = baseline.value,
    current = epoch;
  if (!before || !window.confirm('重置私人地址？旧地址会立即失效，所有设备都需要更新。')) return;
  await act(async () => {
    const value = issuedSubscriptionSchema.parse(
      await props.api('/api/subscriptions/' + before.id + '/reset-token', {
        revision: before.revision,
      }),
    );
    if (!alive || current !== epoch) return;
    baseline.value = value.subscription;
    status.value = value.subscription;
    urls.value = value.urls;
    pane.value = 'publish';
    pollLater();
    await refresh();
  });
}
async function showArtifact(format: OutputFormat) {
  const id = baseline.value?.id,
    current = epoch,
    ticket = ++previewTicket;
  if (!id) return;
  await act(async () => {
    const result = artifactSchema.parse(
      await props.api('/api/subscriptions/' + id + '/artifacts/' + format),
    );
    if (alive && current === epoch && ticket === previewTicket) preview.value = result;
  });
}
async function copy(value: string) {
  await act(async () => {
    await navigator.clipboard.writeText(value);
    if (alive) message.value = '已复制。';
  });
}
function download() {
  if (!preview.value) return;
  const f = preview.value.format;
  const extension = f.startsWith('mihomo')
    ? 'yaml'
    : ['uri', 'base64'].includes(f)
      ? 'txt'
      : 'json';
  const url = URL.createObjectURL(
    new Blob([preview.value.content], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'submeld-' + f + '.' + extension;
  link.click();
  URL.revokeObjectURL(url);
}
onMounted(() => void act(refresh));
</script>
<template>
  <section class="library" aria-label="订阅方案">
    <div class="page-header">
      <div>
        <h1>订阅方案</h1>
        <p class="muted">组合已保存的节点与来源。保存后自动生成；客户端读取已发布内容。</p>
      </div>
      <div class="toolbar">
        <button type="button" :disabled="busy" @click="act(refresh)">刷新方案列表</button>
        <button type="button" class="primary" :disabled="busy" @click="startNew">
          新建订阅方案
        </button>
      </div>
    </div>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <div class="library-main">
      <ul v-if="rows.length" class="library-list">
        <li v-for="row in rows" :key="row.id" @click="edit(row.id)">
          <span class="node-name"
            >{{ row.name
            }}<small class="list-meta">
              <StatusBadge
                :tone="row.enabled ? 'ok' : 'off'"
                :label="row.enabled ? '启用' : '停用'"
              />
              <span v-for="f in row.formats" :key="f" class="format-chip">{{
                outputLabels[f]
              }}</span>
            </small></span
          >
          <div class="toolbar" @click.stop>
            <button type="button" :disabled="busy" @click="edit(row.id)">编辑方案</button
            ><button type="button" :disabled="busy" @click="toggle(row)">
              {{ row.enabled ? '停用方案' : '启用方案' }}</button
            ><button type="button" class="danger linkish" :disabled="busy" @click="remove(row)">
              删除方案
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="empty-state">尚无订阅方案。先添加来源或本地节点，再在这里组合发布。</p>
      <ListPagination
        :page="page"
        :total="total"
        :disabled="busy"
        @turn="
          (delta) =>
            act(async () => {
              page += delta;
              await refresh();
            })
        "
      />
    </div>
    <ModalDialog
      v-if="form"
      :label="baseline ? '编辑订阅方案' : '新建订阅方案'"
      wide
      :dismissible="!busy"
      @close="closeForm"
    >
      <template v-if="message" #banner>
        <p class="notice" role="status">{{ message }}</p>
      </template>
      <template #tabs>
        <button
          v-if="baseline"
          type="button"
          :class="{ active: pane === 'publish' }"
          @click="pane = 'publish'"
        >
          发布与地址
        </button>
        <button type="button" :class="{ active: pane === 'settings' }" @click="pane = 'settings'">
          方案设置
        </button>
      </template>
      <div class="subscription-detail">
        <div v-show="pane === 'publish'">
          <section
            v-if="urlEntries.length"
            class="node-import-panel editor-fields token-banner"
            aria-label="一次性私人地址"
          >
            <h2>请保存私人地址</h2>
            <p class="warning-note">
              只在创建或重置时展示。离开本页后无法再次查看；丢失可重置，旧地址会失效。持有地址即可读取对应方案。
            </p>
            <div v-for="[f, url] in urlEntries" :key="f" class="address-row">
              <span>{{ outputLabels[f] }}</span>
              <textarea
                :value="url"
                readonly
                rows="2"
                :aria-label="outputLabels[f] + ' 订阅地址'"
                spellcheck="false"
              ></textarea>
              <button type="button" :disabled="busy" @click="copy(url)">
                复制 {{ outputLabels[f] }} 地址
              </button>
            </div>
            <button type="button" @click="urls = {}">已保存，隐藏地址</button>
          </section>
          <section
            v-if="status && baseline"
            class="node-import-panel editor-fields"
            aria-label="发布状态"
          >
            <div class="section-title">
              <h2>已保存方案的发布状态</h2>
              <span role="status">{{
                status.generation === 'running'
                  ? '正在生成'
                  : status.generation === 'queued'
                    ? '等待生成'
                    : '生成任务已结束'
              }}</span>
            </div>
            <p class="muted">下列内容来自已保存设置；未提交的编辑尚未发布。</p>
            <div class="toolbar">
              <button type="button" :disabled="busy" @click="act(refreshSelectedStatus)">
                刷新发布状态</button
              ><button
                type="button"
                :disabled="busy || !status.enabled || status.generation !== 'idle'"
                @click="generate"
              >
                更新订阅</button
              ><button type="button" :disabled="busy" @click="resetToken">重置私人地址</button>
            </div>
            <article
              v-for="artifact in status.artifacts"
              :key="artifact.format"
              class="artifact-status"
            >
              <h3>
                {{ outputLabels[artifact.format] }} ·
                {{ artifact.readable ? '可读取' : '不可读取' }}
              </h3>
              <p class="muted">
                最近成功：{{ artifact.generatedAt ? formatTime(artifact.generatedAt) : '尚无'
                }}<template v-if="artifact.counts">
                  · 输入 {{ artifact.counts.input }} / 输出 {{ artifact.counts.output }} / 过滤
                  {{ artifact.counts.filtered }}</template
                >
              </p>
              <p v-if="artifact.error" class="error-note">
                {{ artifact.error.message
                }}{{ artifact.readable ? ' 当前仍提供最近成功结果。' : '' }}
              </p>
              <p
                v-for="(d, i) in [...artifact.diagnostics, ...(artifact.error?.diagnostics ?? [])]"
                :key="i"
                :class="d.level === 'error' ? 'error-note' : 'warning-note'"
              >
                {{ d.nodeIndex < 0 ? '输入' : '节点 ' + (d.nodeIndex + 1) }}：{{ d.message }}
              </p>
              <button
                type="button"
                :disabled="busy || !artifact.readable"
                @click="showArtifact(artifact.format)"
              >
                预览 {{ outputLabels[artifact.format] }}
              </button>
            </article>
            <template v-if="preview"
              ><h3>已发布内容：{{ outputLabels[preview.format] }}</h3>
              <textarea
                class="output-text"
                readonly
                :value="preview.content"
                aria-label="已发布订阅内容"
              ></textarea>
              <div class="toolbar">
                <button type="button" :disabled="busy" @click="copy(preview.content)">
                  复制订阅内容</button
                ><button type="button" @click="download">下载订阅内容</button>
              </div></template
            >
          </section>
        </div>
        <fieldset
          v-show="pane === 'settings'"
          :disabled="busy"
          class="library-editor editor-fields"
        >
          <legend>{{ baseline ? '编辑订阅方案' : '新建订阅方案' }}</legend>
          <p v-if="conflict" class="warning-note">
            服务器已有更新，当前编辑已保留。重新载入会替换未保存内容。
          </p>
          <button v-if="conflict && baseline" type="button" @click="edit(baseline.id, 'settings')">
            重新载入方案版本
          </button>
          <label>方案名称<input v-model="form.name" maxlength="512" /></label
          ><label class="check-label"
            ><input v-model="form.enabled" type="checkbox" />启用方案</label
          >
          <h2>输入与顺序</h2>
          <p class="muted">先按以下顺序展开，再筛选和改名；每个目标以保留的第一项为默认节点。</p>
          <div class="field-pair">
            <label
              >输入类型<select v-model="inputKind" aria-label="输入类型">
                <option value="source">来源</option>
                <option value="node">本地节点</option>
                <option value="chain">链式代理</option>
              </select></label
            ><label
              >可选输入<select v-model="candidateId" aria-label="可选输入">
                <option
                  v-for="item in candidates"
                  :key="item.id"
                  :value="item.id"
                  :disabled="!item.available"
                >
                  {{ item.name
                  }}{{ item.available ? (item.enabled ? '' : '（已停用）') : '（尚无成功快照）' }}
                </option>
              </select></label
            >
          </div>
          <div class="toolbar">
            <button
              type="button"
              :disabled="!candidateId || selectedKeys.has(inputKind + candidateId)"
              @click="addInput"
            >
              添加输入</button
            ><button type="button" @click="act(loadCandidates)">刷新可选输入</button>
          </div>
          <div class="pagination">
            <button
              type="button"
              :disabled="!inputPage"
              @click="
                act(async () => {
                  inputPage--;
                  await loadCandidates();
                })
              "
            >
              上一页输入</button
            ><span>{{ inputPage + 1 }} / {{ Math.max(1, Math.ceil(inputTotal / 25)) }}</span
            ><button
              type="button"
              :disabled="(inputPage + 1) * 25 >= inputTotal"
              @click="
                act(async () => {
                  inputPage++;
                  await loadCandidates();
                })
              "
            >
              下一页输入
            </button>
          </div>
          <ol class="subscription-inputs">
            <li v-for="(input, i) in form.inputs" :key="input.kind + input.id">
              <span
                >{{ i + 1 }}.
                {{
                  input.kind === 'source' ? '来源' : input.kind === 'chain' ? '链式代理' : '节点'
                }}
                · {{ inputName(input) }}</span
              >
              <div class="toolbar">
                <button type="button" :disabled="i === 0" @click="move(i, -1)">上移输入</button
                ><button type="button" :disabled="i === form.inputs.length - 1" @click="move(i, 1)">
                  下移输入</button
                ><button type="button" @click="form.inputs.splice(i, 1)">移除输入</button>
              </div>
            </li>
          </ol>
          <h2>名称筛选与改名</h2>
          <p class="muted">按原名称做区分大小写的字面匹配，空值不限制；筛选后添加前后缀。</p>
          <div class="field-pair">
            <label>名称包含<input v-model="form.includeName" maxlength="512" /></label
            ><label>名称排除<input v-model="form.excludeName" maxlength="512" /></label>
          </div>
          <div class="field-pair">
            <label>名称前缀<input v-model="form.prefix" maxlength="512" /></label
            ><label>名称后缀<input v-model="form.suffix" maxlength="512" /></label>
          </div>
          <h2>输出格式</h2>
          <p v-if="form.inputs.some((input) => input.kind === 'chain')" class="warning-note">
            URI／Base64 仅发布普通节点，明确排除链式代理；只有链时这两种格式会报无可输出节点。
            内核配置中的链需两跳协议都被选中；名称筛选和前后缀作用于链名称。
          </p>
          <div class="toolbar">
            <label v-for="f in outputFormats" :key="f" class="check-label"
              ><input v-model="form.formats" type="checkbox" :value="f" />{{
                outputLabels[f]
              }}</label
            >
          </div>
          <label
            >完整配置监听端口<input
              v-model.number="form.listenPort"
              type="number"
              min="1"
              max="65535"
          /></label>
          <fieldset v-for="group in targetGroups" :key="group" class="target-filter">
            <legend>{{ groupLabels[group] }} 协议筛选</legend>
            <div class="toolbar">
              <label v-for="protocol in protocols" :key="protocol" class="check-label"
                ><input v-model="form.protocols[group]" type="checkbox" :value="protocol" />{{
                  protocol.toUpperCase()
                }}</label
              >
            </div>
          </fieldset>
          <p class="muted">
            URI 与 Base64 共用筛选；同一内核完整配置和片段共用筛选。Xray
            不支持的协议或参数会明确报错，请按需调整。
          </p>
        </fieldset>
      </div>
      <template #footer>
        <button type="button" class="primary" :disabled="busy" @click="save">保存订阅方案</button>
        <button type="button" :disabled="busy" @click="closeForm">关闭方案编辑</button>
      </template>
    </ModalDialog>
  </section>
</template>
