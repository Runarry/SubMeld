<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { z } from 'zod';
import NodeEditor from './NodeEditor.vue';
import { ApiError } from './api';
import {
  MAX_BYTES,
  MAX_NODES,
  formatSchema,
  parseResultSchema,
  nodeSummarySchema,
  type Diagnostic,
  type WorkbenchItem,
} from '../server/shared/contracts';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  disabled: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [count: number]; saving: [active: boolean] }>();
const text = ref(''),
  format = ref<z.infer<typeof formatSchema>>('auto');
const items = ref<WorkbenchItem[]>([]),
  selected = ref<number[]>([]);
const diagnostics = ref<Diagnostic[]>([]),
  message = ref('');
const busy = ref<'' | 'parse' | 'file' | 'save'>('');
const parsed = ref(false),
  page = ref(0),
  activeIndex = ref(0);
const visible = computed(() => items.value.slice(page.value * 25, page.value * 25 + 25));
const pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / 25)));
const active = computed(() => items.value.find((item) => item.nodeIndex === activeIndex.value));
const chosen = computed(() =>
  items.value.filter((item) => selected.value.includes(item.nodeIndex)),
);
const locked = computed(() => props.disabled || busy.value === 'save');
const createdSchema = z.strictObject({ nodes: z.array(nodeSummarySchema).min(1).max(MAX_NODES) });
let version = 0;
function invalidate() {
  version++;
  items.value = [];
  selected.value = [];
  diagnostics.value = [];
  parsed.value = false;
  page.value = 0;
  activeIndex.value = 0;
  message.value = '';
}
watch([text, format], invalidate, { flush: 'sync' });
onBeforeUnmount(() => {
  version++;
});
async function parse() {
  if (busy.value || props.disabled) return;
  invalidate();
  if (new TextEncoder().encode(text.value).byteLength > MAX_BYTES) {
    message.value = '输入超过 4 MiB。';
    return;
  }
  busy.value = 'parse';
  const current = version;
  try {
    const result = parseResultSchema.parse(
      await props.api('/api/convert/parse', { text: text.value, format: format.value }),
    );
    if (current !== version) return;
    items.value = result.items;
    selected.value = result.items.map((item) => item.nodeIndex);
    diagnostics.value = result.diagnostics;
    activeIndex.value = result.items[0]?.nodeIndex ?? 0;
    parsed.value = true;
    message.value = '已解析 ' + result.counts.input + ' 项。检查或编辑后，点击添加所选节点。';
  } catch (error) {
    if (current === version)
      message.value = error instanceof ApiError ? error.message : '解析失败，请检查服务连接。';
  } finally {
    busy.value = '';
  }
}
async function upload(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  input.value = '';
  if (!file || busy.value || props.disabled) return;
  invalidate();
  if (file.size > MAX_BYTES) {
    message.value = '文件超过 4 MiB。';
    return;
  }
  const current = version;
  busy.value = 'file';
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (current !== version) return;
    text.value = content;
    message.value = '文件已读取，请点击解析导入内容。';
  } catch {
    if (current === version) message.value = '文件不是有效的 UTF-8 文本。';
  } finally {
    busy.value = '';
  }
}
async function save() {
  if (busy.value || props.disabled || !parsed.value || !chosen.value.length) return;
  const selection = [...chosen.value];
  if (selection.some((item) => !item.draft)) {
    message.value = '所选条目尚未解析成功，请修正原文重新解析，或取消选择该项。';
    return;
  }
  busy.value = 'save';
  emit('saving', true);
  message.value = '';
  const current = version;
  try {
    const result = createdSchema.parse(
      await props.api('/api/nodes', { drafts: selection.map((item) => item.draft) }),
    );
    if (current !== version) return;
    text.value = '';
    format.value = 'auto';
    invalidate();
    message.value = '已添加 ' + result.nodes.length + ' 个本地节点。';
    emit('saved', result.nodes.length);
  } catch (error) {
    if (current !== version) return;
    if (error instanceof ApiError) {
      message.value = error.message;
      for (const item of selection)
        item.diagnostics = item.diagnostics.filter((d) => d.level === 'warning');
      for (const d of error.diagnostics) {
        const item = selection[d.nodeIndex];
        if (item) item.diagnostics.push({ ...d, nodeIndex: item.nodeIndex });
        else if (d.nodeIndex === -1) diagnostics.value.push(d);
      }
    } else message.value = '未能确认保存结果，请刷新节点库核对后再操作。';
  } finally {
    busy.value = '';
    emit('saving', false);
  }
}
</script>
<template>
  <section class="node-import-panel" aria-label="本地节点导入">
    <div class="section-title">
      <h2>导入节点</h2>
      <button type="button" :disabled="locked" @click="emit('close')">关闭导入</button>
    </div>
    <p class="muted">
      粘贴或上传节点信息，解析并检查后批量添加。支持 URI、Base64 和内联节点 YAML；不访问远端 URL。
    </p>
    <fieldset class="import-fields" :disabled="locked">
      <label
        >导入内容<textarea
          v-model="text"
          rows="5"
          spellcheck="false"
          aria-label="本地节点导入内容"
          placeholder="粘贴一个或多个节点的 URI、Base64，或含 proxies 的 YAML"
        />
      </label>
      <div class="toolbar">
        <label
          >导入格式<select v-model="format" aria-label="本地节点导入格式">
            <option value="auto">自动识别</option>
            <option value="uri">URI 列表</option>
            <option value="base64">Base64</option>
            <option value="yaml">Clash / Mihomo YAML</option>
          </select></label
        >
        <label class="file-button"
          >上传导入文本<input
            type="file"
            accept=".txt,.yaml,.yml,.conf,text/plain"
            :disabled="!!busy"
            @change="upload"
        /></label>
        <button type="button" class="primary" :disabled="!!busy || !text.trim()" @click="parse">
          {{ busy === 'parse' ? '正在解析…' : '解析导入内容' }}</button
        ><span class="muted">4 MiB · 最多 2,000 节点</span>
      </div>
      <p v-if="message" role="status" class="notice">{{ message }}</p>
      <p
        v-for="(d, index) in diagnostics"
        :key="index"
        :class="d.level === 'error' ? 'error-note' : 'warning-note'"
      >
        {{ d.message }}
      </p>
      <template v-if="parsed">
        <div class="toolbar">
          <p>共 {{ items.length }} 项 · 已选 {{ selected.length }} 项</p>
          <button type="button" @click="selected = items.map((item) => item.nodeIndex)">
            选择全部导入项</button
          ><button type="button" @click="selected = []">取消全部选择</button>
        </div>
        <p class="muted">
          失败项仍保留在列表中；修正或取消选择后添加。警告不会阻止添加，同名节点会作为新节点保存。
        </p>
        <div class="nodes-layout">
          <div>
            <div class="node-list">
              <div v-for="item in visible" :key="item.nodeIndex" class="selectable-node">
                <input
                  v-model="selected"
                  type="checkbox"
                  :value="item.nodeIndex"
                  :aria-label="'导入选择第 ' + (item.nodeIndex + 1) + ' 项'"
                />
                <button
                  type="button"
                  class="node-row"
                  :class="{ selected: item.nodeIndex === activeIndex }"
                  :aria-pressed="item.nodeIndex === activeIndex"
                  @click="activeIndex = item.nodeIndex"
                >
                  <span class="node-number">{{ item.nodeIndex + 1 }}</span
                  ><span class="node-name"
                    >{{ item.draft ? item.draft.name || '未命名节点' : '无法解析的输入项'
                    }}<small
                      >{{ item.draft?.protocol.toUpperCase() || '待修正'
                      }}{{
                        item.diagnostics.some((d) => d.level === 'error') ? ' · 有错误' : ''
                      }}</small
                    ></span
                  >
                </button>
              </div>
            </div>
            <div v-if="pageCount > 1" class="pagination">
              <button type="button" :disabled="page === 0" @click="page--">导入上一页</button
              ><span>{{ page + 1 }} / {{ pageCount }}</span
              ><button type="button" :disabled="page + 1 >= pageCount" @click="page++">
                导入下一页
              </button>
            </div>
          </div>
          <div v-if="active" class="editor">
            <NodeEditor v-if="active.draft" :key="active.nodeIndex" v-model="active.draft" />
            <p v-else class="muted">此项无法编辑，请修正原文重新解析，或取消选择后添加其余节点。</p>
            <div v-if="active.diagnostics.length" class="diagnostics">
              <h3>此项诊断</h3>
              <p
                v-for="(d, index) in active.diagnostics"
                :key="index"
                :class="d.level === 'error' ? 'error-note' : 'warning-note'"
              >
                {{ d.field ? d.field + '：' : '' }}{{ d.message }}
              </p>
              <p class="muted">添加时会重新校验编辑后的节点。</p>
            </div>
          </div>
        </div>
      </template>
      <div class="toolbar import-submit">
        <button
          type="button"
          class="primary"
          :disabled="!!busy || !parsed || !selected.length"
          @click="save"
        >
          {{ busy === 'save' ? '正在添加…' : '添加所选节点' }}
        </button>
      </div>
    </fieldset>
  </section>
</template>
