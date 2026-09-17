<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import NodeEditor from './NodeEditor.vue';
import NodeLibrary from './NodeLibrary.vue';
import SourceLibrary from './SourceLibrary.vue';
import SubscriptionLibrary from './SubscriptionLibrary.vue';
import { ApiError, request } from './api';
import {
  blankDraft,
  MAX_BYTES,
  MAX_NODES,
  parseResultSchema,
  produceResultSchema,
  protocols,
  renderResultSchema,
  type RenderTarget,
  type RenderResult,
  type Diagnostic,
  type ProduceResult,
  type Protocol,
  type WorkbenchItem,
} from '../server/shared/contracts';

const authenticated = ref(false);
const checking = ref(true);
const password = ref('');
const text = ref('');
const format = ref<'auto' | 'uri' | 'base64' | 'yaml'>('auto');
const items = ref<WorkbenchItem[]>([]);
const diagnostics = ref<Diagnostic[]>([]);
const output = ref<ProduceResult | null>(null);
const selectedIndex = ref(0);
const newProtocol = ref<Protocol>('vless');
const target = ref<'uri' | 'base64' | RenderTarget>('uri');
const view = ref<'workbench' | 'library' | 'sources' | 'subscriptions'>('workbench');
const selectedForSave = ref<number[]>([]);
const rendered = ref<Partial<Record<RenderTarget, RenderResult>>>({});
const outputErrors = ref<Partial<Record<'uri' | 'base64' | RenderTarget, string>>>({});
const listenPort = ref(1080),
  outputMode = ref<'full' | 'nodes'>('full');
const renderTargets: RenderTarget[] = ['mihomo', 'singbox', 'xray'];
const targetLabels = {
  uri: 'URI',
  base64: 'Base64',
  mihomo: 'Mihomo',
  singbox: 'sing-box',
  xray: 'Xray',
};
function invalidateOutput() {
  version++;
  output.value = null;
  rendered.value = {};
  outputErrors.value = {};
}
watch(listenPort, invalidateOutput, { flush: 'sync' });
const decodePreview = ref(false);
const busy = ref('');
const message = ref('');
const inputDirty = ref(false);
const page = ref(0);
let version = 0;
watch(
  [text, format],
  () => {
    invalidateOutput();
    inputDirty.value = true;
  },
  { flush: 'sync' },
);
watch(
  () => items.value.map(({ nodeIndex, draft, excluded }) => ({ nodeIndex, draft, excluded })),
  () => {
    invalidateOutput();
  },
  { deep: true, flush: 'sync' },
);
const selected = computed(() => items.value.find((item) => item.nodeIndex === selectedIndex.value));
const visible = computed(() => items.value.slice(page.value * 25, page.value * 25 + 25));
const pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / 25)));
const excludedCount = computed(() => items.value.filter((i) => i.excluded).length);
const activeResult = computed(() =>
  target.value === 'uri' || target.value === 'base64' ? output.value : rendered.value[target.value],
);
const downloadable = computed(() =>
  target.value === 'uri'
    ? output.value?.uri
    : target.value === 'base64'
      ? output.value?.base64
      : rendered.value[target.value]?.[outputMode.value],
);
const preview = computed(() =>
  target.value === 'base64' && decodePreview.value ? output.value?.uri : downloadable.value,
);
const extension = computed(() =>
  target.value === 'mihomo' ? 'yaml' : ['singbox', 'xray'].includes(target.value) ? 'json' : 'txt',
);
const errorCount = computed(
  () =>
    items.value.filter((i) => !i.excluded && i.diagnostics.some((d) => d.level === 'error')).length,
);
function lockWorkspace() {
  authenticated.value = false;
  password.value = '';
  text.value = '';
  items.value = [];
  output.value = null;
  diagnostics.value = [];
  inputDirty.value = false;
  rendered.value = {};
  outputErrors.value = {};
  selectedForSave.value = [];
  view.value = 'workbench';
}
async function api(path: string, body?: unknown, method?: string): Promise<unknown> {
  try {
    return await request(path, body, method);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && path !== '/api/auth/login')
      lockWorkspace();
    throw error;
  }
}
async function login() {
  busy.value = 'login';
  message.value = '';
  try {
    await api('/api/auth/login', { password: password.value });
    authenticated.value = true;
    password.value = '';
  } catch (error) {
    message.value = error instanceof ApiError ? error.message : '无法连接服务。';
  } finally {
    busy.value = '';
  }
}
async function logout() {
  busy.value = 'logout';
  try {
    await api('/api/auth/logout', {});
    lockWorkspace();
    message.value = '';
  } catch (error) {
    message.value = error instanceof ApiError ? error.message : '退出失败，请重试。';
  } finally {
    busy.value = '';
  }
}
async function parse() {
  busy.value = 'parse';
  message.value = '';
  output.value = null;
  const current = version;
  try {
    const response = await api('/api/convert/parse', { text: text.value, format: format.value });
    if (current !== version) {
      message.value = '输入已修改，已忽略旧解析结果。';
      return;
    }
    const result = parseResultSchema.parse(response);
    items.value = result.items;
    selectedForSave.value = [];
    diagnostics.value = result.diagnostics;
    selectedIndex.value = 0;
    page.value = 0;
    inputDirty.value = false;
    message.value = '解析完成。请检查节点及诊断，再生成输出。';
  } catch (error) {
    message.value = error instanceof ApiError ? error.message : '解析失败，请检查服务连接。';
  } finally {
    busy.value = '';
  }
}
async function produce() {
  busy.value = 'produce';
  message.value = '';
  const current = version,
    requested = target.value;
  outputErrors.value[requested] = '';
  if (requested === 'uri' || requested === 'base64') output.value = null;
  else delete rendered.value[requested];
  try {
    const raw = await api(
      requested === 'uri' || requested === 'base64'
        ? '/api/convert/produce'
        : '/api/convert/render',
      requested === 'uri' || requested === 'base64'
        ? { items: items.value }
        : { items: items.value, target: requested, listenPort: listenPort.value },
    );
    if (current !== version) {
      message.value = '节点已修改，已忽略旧生成结果。';
      return;
    }
    const result =
      requested === 'uri' || requested === 'base64'
        ? produceResultSchema.parse(raw)
        : renderResultSchema.parse(raw);
    items.value.forEach((item) => {
      item.diagnostics = result.diagnostics.filter((d) => d.nodeIndex === item.nodeIndex);
    });
    if ('target' in result) rendered.value[result.target] = result;
    else output.value = result;
    message.value = '已生成。预览、复制与下载使用同一批结果。';
  } catch (error) {
    if (current === version) {
      if (error instanceof ApiError && error.diagnostics.length)
        items.value.forEach((item) => {
          item.diagnostics = error.diagnostics.filter((d) => d.nodeIndex === item.nodeIndex);
        });
      const text = error instanceof ApiError ? error.message : '生成失败，请检查服务连接。';
      outputErrors.value[requested] = text;
      message.value = text;
    }
  } finally {
    busy.value = '';
  }
}
async function saveSelected() {
  busy.value = 'save';
  message.value = '';
  const chosen = items.value.filter((item) => selectedForSave.value.includes(item.nodeIndex));
  try {
    if (chosen.some((item) => !item.draft))
      throw new Error('所选节点尚未解析成功，请修正或取消选择。');
    await api('/api/nodes', { drafts: chosen.map((item) => item.draft) });
    message.value = '所选节点已另存到本地节点库。';
    selectedForSave.value = [];
  } catch (error) {
    message.value = error instanceof Error ? error.message : '保存失败。';
    if (error instanceof ApiError)
      for (const d of error.diagnostics) {
        const item = chosen[d.nodeIndex];
        if (item) item.diagnostics = [{ ...d, nodeIndex: item.nodeIndex }];
      }
  } finally {
    busy.value = '';
  }
}
function appendNodes(loaded: WorkbenchItem[]) {
  view.value = 'workbench';
  if (items.value.length + loaded.length > MAX_NODES) {
    message.value = '追加后超过 2,000 个节点，请先整理工作台。';
    return;
  }
  if (inputDirty.value) {
    message.value = '原始输入尚未解析，请先解析后再载入节点。';
    return;
  }
  const start = items.value.length;
  items.value.push(
    ...loaded.map((item, i) => ({
      ...item,
      nodeIndex: start + i,
      diagnostics: item.diagnostics.map((d) => ({ ...d, nodeIndex: start + i })),
    })),
  );
  selectedIndex.value = start;
  page.value = Math.floor(start / 25);
  message.value = '已将本地节点追加为独立副本。';
}
function moveNode(delta: number) {
  const index = items.value.findIndex((item) => item.nodeIndex === selectedIndex.value),
    next = index + delta;
  if (index < 0 || next < 0 || next >= items.value.length) return;
  const [item] = items.value.splice(index, 1);
  if (item) items.value.splice(next, 0, item);
  page.value = Math.floor(next / 25);
}
function addNode() {
  if (items.value.length >= MAX_NODES) {
    message.value = '最多支持 2,000 个节点。';
    return;
  }
  const nodeIndex = items.value.length;
  items.value.push({
    nodeIndex,
    excluded: false,
    draft: blankDraft(newProtocol.value),
    diagnostics: [],
  });
  selectedIndex.value = nodeIndex;
  page.value = Math.floor(nodeIndex / 25);
  message.value = '';
}
async function upload(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > MAX_BYTES) {
    message.value = '文件超过 4 MiB。';
    return;
  }
  const current = version;
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (current !== version) {
      message.value = '输入已修改，已忽略此前选择的文件。';
      return;
    }
    text.value = content;
    message.value = '文件已读取，请点击解析节点。';
  } catch {
    message.value = '文件不是有效的 UTF-8 文本。';
  }
}
async function copy() {
  if (!downloadable.value) return;
  try {
    await navigator.clipboard.writeText(downloadable.value);
    message.value = '已复制。';
  } catch {
    message.value = '浏览器未允许复制，请手动选择预览内容或下载。';
  }
}
function download() {
  if (!downloadable.value) return;
  const url = URL.createObjectURL(
    new Blob([downloadable.value], { type: 'text/plain;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download =
    'submeld-' +
    target.value +
    (extension.value === 'txt' ? '' : '-' + outputMode.value) +
    '.' +
    extension.value;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(async () => {
  try {
    await api('/api/auth/me');
    authenticated.value = true;
  } catch {
    /* Login remains available without a session. */
  } finally {
    checking.value = false;
  }
});
</script>

<template>
  <div class="page">
    <header class="brand">
      <div class="brand-identity">
        <span class="brand-mark" aria-hidden="true">S</span
        ><span>SubMeld <span class="brand-divider">/</span> 订融</span
        ><span class="version">0.3.0</span>
      </div>
      <button v-if="authenticated" :disabled="!!busy" @click="logout">退出登录</button>
    </header>
    <main v-if="checking" class="login-shell"><p role="status">正在检查登录状态…</p></main>
    <main v-else-if="!authenticated" class="login-shell">
      <p class="eyebrow">私人节点转换工作台</p>
      <h1>整理节点，<br />明确每一次转换。</h1>
      <p class="intro">导入链接或 YAML，编辑连接参数，生成 URI 与 Base64。</p>
      <form class="panel login-card" @submit.prevent="login">
        <h2>管理员登录</h2>
        <label
          >管理员密码<input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            maxlength="1024"
        /></label>
        <button class="primary" :disabled="!!busy || !password">
          {{ busy === 'login' ? '正在登录…' : '登录工作台' }}
        </button>
        <p class="muted">首次使用请先在主机上运行本地初始化命令。没有默认密码。</p>
      </form>
      <p v-if="message" class="notice" role="alert">{{ message }}</p>
    </main>
    <main v-else class="workspace">
      <nav class="toolbar" aria-label="管理页面">
        <button :class="{ primary: view === 'workbench' }" @click="view = 'workbench'">
          转换工作台
        </button>
        <button :class="{ primary: view === 'library' }" @click="view = 'library'">本地节点</button>
        <button :class="{ primary: view === 'sources' }" @click="view = 'sources'">来源管理</button>
        <button :class="{ primary: view === 'subscriptions' }" @click="view = 'subscriptions'">
          订阅方案
        </button>
      </nav>
      <NodeLibrary v-if="view === 'library'" :api="api" @load="appendNodes" />
      <SourceLibrary v-if="view === 'sources'" :api="api" />
      <SubscriptionLibrary v-if="view === 'subscriptions'" :api="api" />
      <div v-show="view === 'workbench'">
        <div class="workspace-heading">
          <div>
            <p class="eyebrow">P3 · 节点与私人订阅</p>
            <h1>从输入到可用链接。</h1>
          </div>
          <p class="muted">内容仅在本次页面中保留<br />刷新或退出后清空</p>
        </div>
        <p v-if="message" class="notice" role="status" aria-live="polite">{{ message }}</p>
        <section class="panel input-panel" aria-labelledby="input-heading">
          <div class="section-title">
            <h2 id="input-heading"><span class="step">01</span> 输入节点</h2>
            <label class="file-button"
              >上传文本<input
                type="file"
                accept=".txt,.yaml,.yml,.conf,text/plain"
                :disabled="!!busy"
                @change="upload"
            /></label>
          </div>
          <textarea
            v-model="text"
            aria-label="节点输入"
            rows="5"
            spellcheck="false"
            placeholder="粘贴 URI、Base64，或包含 proxies 的 Clash / Mihomo YAML。此入口不会访问远端 URL。"
          />
          <div class="toolbar">
            <label class="inline-label"
              >输入格式<select v-model="format">
                <option value="auto">自动识别</option>
                <option value="uri">URI 列表</option>
                <option value="base64">Base64 订阅正文</option>
                <option value="yaml">Clash / Mihomo YAML</option>
              </select></label
            ><span class="muted">4 MiB · 最多 2,000 节点</span
            ><button class="primary" :disabled="!!busy || !text.trim()" @click="parse">
              {{ busy === 'parse' ? '正在解析…' : '解析节点' }}
            </button>
          </div>
          <p v-if="inputDirty && items.length" class="warning-note">
            输入已更改，请重新解析后生成。
          </p>
          <p v-for="(d, index) in diagnostics" :key="index" class="warning-note">
            提示：{{ d.message }}
          </p>
        </section>
        <div class="toolbar">
          <button :disabled="!!busy || inputDirty || !selectedForSave.length" @click="saveSelected">
            另存为本地节点（{{ selectedForSave.length }}）
          </button>
          <span class="muted">勾选要保存的节点；只影响明确保存的副本。</span>
        </div>
        <div class="work-grid">
          <section class="panel nodes-panel" aria-labelledby="nodes-heading">
            <div class="section-title">
              <h2 id="nodes-heading"><span class="step">02</span> 编辑节点</h2>
              <span class="muted">{{ items.length }} 项 · 排除 {{ excludedCount }} 项</span>
            </div>
            <div class="toolbar">
              <label class="inline-label"
                >新建<select v-model="newProtocol">
                  <option v-for="protocol in protocols" :key="protocol" :value="protocol">
                    {{ protocol.toUpperCase() }}
                  </option>
                </select></label
              ><button :disabled="!!busy || inputDirty" @click="addNode">添加节点</button>
            </div>
            <div v-if="!items.length" class="empty-state">
              <strong>从一条节点开始</strong>
              <p>解析已有内容，或从协议表单新建节点。</p>
            </div>
            <div v-else class="nodes-layout">
              <div class="node-list">
                <div v-for="item in visible" :key="item.nodeIndex" class="selectable-node">
                  <input
                    v-model="selectedForSave"
                    type="checkbox"
                    :value="item.nodeIndex"
                    :aria-label="'保存选择 ' + (item.draft?.name || item.nodeIndex + 1)"
                    :disabled="!!busy"
                  />
                  <button
                    class="node-row"
                    :class="{ selected: item.nodeIndex === selectedIndex, excluded: item.excluded }"
                    :aria-pressed="item.nodeIndex === selectedIndex"
                    @click="selectedIndex = item.nodeIndex"
                  >
                    <span class="node-number">{{ item.nodeIndex + 1 }}</span
                    ><span class="node-name"
                      >{{ item.draft?.name || (item.draft ? '未命名节点' : '无法解析的输入项')
                      }}<small
                        >{{ item.draft?.protocol.toUpperCase() || '待修正'
                        }}{{
                          item.excluded
                            ? ' · 已排除'
                            : item.diagnostics.some((d) => d.level === 'error')
                              ? ' · 有错误'
                              : ''
                        }}</small
                      ></span
                    >
                  </button>
                </div>
                <div v-if="pageCount > 1" class="pagination">
                  <button :disabled="page === 0" @click="page--">上一页</button
                  ><span>{{ page + 1 }}/{{ pageCount }}</span
                  ><button :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
                </div>
              </div>
              <div v-if="selected" class="editor">
                <div class="toolbar">
                  <button :disabled="items[0] === selected" @click="moveNode(-1)">上移</button
                  ><button :disabled="items[items.length - 1] === selected" @click="moveNode(1)">
                    下移
                  </button>
                </div>
                <label class="check-label exclude-control"
                  ><input
                    v-model="selected.excluded"
                    type="checkbox"
                  />明确排除此项，不参与导出</label
                >
                <NodeEditor
                  v-if="selected.draft"
                  :key="selected.nodeIndex"
                  v-model="selected.draft"
                />
                <p v-else class="muted">请回到原始输入修正并重新解析，或明确排除此项。</p>
                <div v-if="selected.diagnostics.length" class="diagnostics">
                  <h3>本项最近诊断</h3>
                  <p
                    v-for="(d, index) in selected.diagnostics"
                    :key="index"
                    :class="d.level === 'error' ? 'error-note' : 'warning-note'"
                  >
                    {{ d.level === 'error' ? '错误' : '警告'
                    }}{{ d.field ? ' · ' + d.field : '' }}：{{ d.message }}
                  </p>
                  <p class="muted">编辑后再次生成会重新校验。</p>
                </div>
              </div>
            </div>
          </section>
          <section class="panel output-panel" aria-labelledby="output-heading">
            <div class="section-title">
              <h2 id="output-heading"><span class="step">03</span> 生成与导出</h2>
            </div>
            <p class="muted">输出从编辑后的节点重新生成。任何修改都会使旧结果失效。</p>
            <button
              class="primary generate-button"
              :disabled="!!busy || !items.length || inputDirty"
              @click="produce"
            >
              {{
                busy === 'produce'
                  ? '正在生成…'
                  : target === 'uri' || target === 'base64'
                    ? '生成 URI 与 Base64'
                    : '生成 ' + targetLabels[target]
              }}
            </button>
            <p v-if="errorCount && !activeResult" class="muted">
              有 {{ errorCount }} 项待检查；修正后可再次生成，也可明确排除。
            </p>
            <div class="output-tabs" role="group" aria-label="输出格式">
              <button :class="{ active: target === 'uri' }" @click="target = 'uri'">URI</button
              ><button :class="{ active: target === 'base64' }" @click="target = 'base64'">
                Base64
              </button>
              <button
                v-for="t in renderTargets"
                :key="t"
                :class="{ active: target === t }"
                @click="target = t"
              >
                {{ targetLabels[t] }}
              </button>
            </div>
            <div v-if="target !== 'uri' && target !== 'base64'" class="toolbar">
              <label
                >配置内容<select v-model="outputMode">
                  <option value="full">基础完整配置</option>
                  <option value="nodes">仅节点</option>
                </select></label
              >
              <label
                >本地监听端口<input v-model.number="listenPort" type="number" min="1" max="65535"
              /></label>
              <p class="muted">完整配置监听 127.0.0.1，默认使用排序第一项；采用系统／基础 DNS。</p>
            </div>
            <p v-if="outputErrors[target]" class="error-note">{{ outputErrors[target] }}</p>
            <label v-if="target === 'base64' && output?.base64" class="check-label"
              ><input v-model="decodePreview" type="checkbox" />查看同批解码内容</label
            >
            <template v-if="activeResult">
              <p class="result-summary">
                输入 {{ activeResult.counts.input }} · 排除 {{ activeResult.counts.filtered }} ·
                生成
                {{ activeResult.counts.output }}
              </p>
              <p v-for="(d, index) in activeResult.diagnostics" :key="index" class="warning-note">
                {{
                  d.nodeIndex >= 0
                    ? '节点 ' +
                      (items.findIndex((item) => item.nodeIndex === d.nodeIndex) + 1) +
                      '：'
                    : ''
                }}{{ d.message }}
              </p>
              <details v-if="preview" open>
                <summary>预览（含节点认证信息）</summary>
                <textarea
                  class="output-text"
                  :value="preview"
                  readonly
                  rows="14"
                  aria-label="输出预览"
                  spellcheck="false"
                />
              </details>
            </template>
            <div v-else class="empty-state output-empty">
              <span aria-hidden="true">↗</span>
              <p>生成后在这里查看结果</p>
            </div>
            <div class="toolbar export-actions">
              <button :disabled="!downloadable" @click="copy">
                复制 {{ targetLabels[target] }}</button
              ><button :disabled="!downloadable" @click="download">下载 .{{ extension }}</button>
            </div>
          </section>
        </div>
      </div>
    </main>
    <footer>
      <span>SubMeld · 订融 · <a href="/source.tar.gz">对应版本源码（AGPL）</a></span
      ><span>本地节点与来源明确保存；临时工作台刷新即清空。私人地址仅创建或重置时展示。</span>
    </footer>
  </div>
</template>
