<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import NodeEditor from './NodeEditor.vue';
import {
  blankDraft,
  errorSchema,
  MAX_BYTES,
  MAX_NODES,
  parseResultSchema,
  produceResultSchema,
  protocols,
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
const target = ref<'uri' | 'base64'>('uri');
const decodePreview = ref(false);
const busy = ref('');
const message = ref('');
const inputDirty = ref(false);
const page = ref(0);
let version = 0;
watch(
  [text, format],
  () => {
    version++;
    output.value = null;
    inputDirty.value = true;
  },
  { flush: 'sync' },
);
watch(
  items,
  () => {
    version++;
    output.value = null;
  },
  { deep: true, flush: 'sync' },
);
const selected = computed(() => items.value[selectedIndex.value]);
const visible = computed(() => items.value.slice(page.value * 25, page.value * 25 + 25));
const pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / 25)));
const excludedCount = computed(() => items.value.filter((i) => i.excluded).length);
const preview = computed(() =>
  target.value === 'base64' && !decodePreview.value
    ? (output.value?.base64 ?? '')
    : (output.value?.uri ?? ''),
);
const downloadable = computed(() =>
  target.value === 'uri' ? output.value?.uri : output.value?.base64,
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
}
class ApiError extends Error {
  constructor(
    message: string,
    public diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers:
      body === undefined ? {} : { 'Content-Type': 'application/json', 'X-SubMeld-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') lockWorkspace();
    const error = errorSchema.safeParse(value);
    throw new ApiError(
      error.success ? error.data.message : '服务响应无效。',
      error.success ? error.data.diagnostics : [],
    );
  }
  return value;
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
  output.value = null;
  const current = version;
  try {
    const response = await api('/api/convert/produce', { items: items.value });
    if (current !== version) {
      message.value = '节点已修改，已忽略旧生成结果。';
      return;
    }
    const result = produceResultSchema.parse(response);
    items.value.forEach((item) => {
      item.diagnostics = result.diagnostics.filter((d) => d.nodeIndex === item.nodeIndex);
    });
    output.value = result;
    message.value = '已生成。预览、复制与下载使用同一批结果。';
  } catch (error) {
    if (current === version && error instanceof ApiError && error.diagnostics.length) {
      items.value.forEach((item) => {
        item.diagnostics = error.diagnostics.filter((d) => d.nodeIndex === item.nodeIndex);
      });
    }
    message.value = error instanceof ApiError ? error.message : '生成失败，请检查服务连接。';
  } finally {
    busy.value = '';
  }
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
  a.download = 'submeld-' + target.value + '.txt';
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
        ><span class="version">0.1.0</span>
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
      <div class="workspace-heading">
        <div>
          <p class="eyebrow">P1 · 临时转换工作台</p>
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
        <p v-if="inputDirty && items.length" class="warning-note">输入已更改，请重新解析后生成。</p>
        <p v-for="(d, index) in diagnostics" :key="index" class="warning-note">
          提示：{{ d.message }}
        </p>
      </section>
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
              <button
                v-for="item in visible"
                :key="item.nodeIndex"
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
              <div v-if="pageCount > 1" class="pagination">
                <button :disabled="page === 0" @click="page--">上一页</button
                ><span>{{ page + 1 }}/{{ pageCount }}</span
                ><button :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
              </div>
            </div>
            <div v-if="selected" class="editor">
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
            {{ busy === 'produce' ? '正在生成…' : '生成 URI 与 Base64' }}
          </button>
          <p v-if="errorCount && !output" class="muted">
            有 {{ errorCount }} 项待检查；修正后可再次生成，也可明确排除。
          </p>
          <div class="output-tabs" role="group" aria-label="输出格式">
            <button :class="{ active: target === 'uri' }" @click="target = 'uri'">URI</button
            ><button :class="{ active: target === 'base64' }" @click="target = 'base64'">
              Base64
            </button>
          </div>
          <label v-if="target === 'base64' && output?.base64" class="check-label"
            ><input v-model="decodePreview" type="checkbox" />查看同批解码内容</label
          >
          <template v-if="output">
            <p class="result-summary">
              输入 {{ output.counts.input }} · 排除 {{ output.counts.filtered }} · 生成
              {{ output.counts.output }}
            </p>
            <p v-for="(d, index) in output.diagnostics" :key="index" class="warning-note">
              {{ d.nodeIndex >= 0 ? '节点 ' + (d.nodeIndex + 1) + '：' : '' }}{{ d.message }}
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
              复制 {{ target === 'uri' ? 'URI' : 'Base64' }}</button
            ><button :disabled="!downloadable" @click="download">下载 .txt</button>
          </div>
        </section>
      </div>
    </main>
    <footer>
      <span>SubMeld · 订融 · <a href="/source.tar.gz">对应版本源码（AGPL）</a></span
      ><span>本阶段支持临时转换；节点保存和订阅发布尚未开放。</span>
    </footer>
  </div>
</template>
