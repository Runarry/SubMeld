<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { ApiError } from './api';
import {
  sourceListSchema,
  sourceSchema,
  type Source,
  type SourceSummary,
} from '../server/shared/subscriptions';
import { type Diagnostic } from '../server/shared/contracts';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const rows = ref<SourceSummary[]>([]),
  page = ref(0),
  total = ref(0),
  busy = ref(false),
  message = ref(''),
  conflict = ref(false);
const editing = ref(false),
  saved = ref<Source | null>(null),
  name = ref(''),
  text = ref(''),
  format = ref<'auto' | 'uri' | 'base64' | 'yaml'>('auto'),
  enabled = ref(true);
const selected = ref<number[]>([]),
  nodePage = ref(0),
  diagnostics = ref<Diagnostic[]>([]);
let alive = true,
  epoch = 0;
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  text.value = '';
  saved.value = null;
});
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  diagnostics.value = [];
  try {
    await fn();
  } catch (e) {
    if (alive) {
      message.value = e instanceof Error ? e.message : '操作失败。';
      if (e instanceof ApiError) {
        conflict.value = e.status === 409;
        diagnostics.value = e.diagnostics;
      }
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function refresh() {
  const result = sourceListSchema.parse(await props.api('/api/sources?page=' + page.value));
  if (!alive) return;
  rows.value = result.sources;
  total.value = result.total;
  if (!rows.value.length && page.value) {
    page.value--;
    await refresh();
  }
}
function fill(source: Source) {
  saved.value = source;
  name.value = source.name;
  text.value = source.text;
  format.value = source.format;
  enabled.value = source.enabled;
  editing.value = true;
  conflict.value = false;
  selected.value = [];
  nodePage.value = 0;
}
function startNew() {
  epoch++;
  editing.value = true;
  saved.value = null;
  name.value = '';
  text.value = '';
  format.value = 'auto';
  enabled.value = true;
  conflict.value = false;
  selected.value = [];
  diagnostics.value = [];
  message.value = '';
}
async function edit(id: string) {
  const current = ++epoch;
  await act(async () => {
    const value = sourceSchema.parse(await props.api('/api/sources/' + id));
    if (alive && current === epoch) fill(value);
  });
}
async function save() {
  const current = epoch;
  await act(async () => {
    const input = {
      name: name.value,
      text: text.value,
      format: format.value,
      enabled: enabled.value,
    };
    const value = sourceSchema.parse(
      await props.api(
        saved.value ? '/api/sources/' + saved.value.id : '/api/sources',
        saved.value ? { ...input, revision: saved.value.revision } : input,
        saved.value ? 'PATCH' : 'POST',
      ),
    );
    if (!alive || current !== epoch) return;
    fill(value);
    await refresh();
    if (alive) message.value = '文本来源已保存，相关订阅已安排更新。';
  });
}
async function toggle(row: SourceSummary) {
  await act(async () => {
    const value = sourceSchema.parse(
      await props.api(
        '/api/sources/' + row.id,
        { revision: row.revision, enabled: !row.enabled },
        'PATCH',
      ),
    );
    if (!alive) return;
    if (saved.value?.id === row.id) {
      if (saved.value.revision === row.revision) {
        saved.value = value;
        enabled.value = value.enabled;
      } else conflict.value = true;
    }
    await refresh();
    if (alive) message.value = row.enabled ? '来源已停用，相关旧产物已失效。' : '来源已启用。';
  });
}
async function remove(row: SourceSummary) {
  if (!window.confirm('删除此来源？相关方案会移除它并重新生成。')) return;
  await act(async () => {
    await props.api('/api/sources/' + row.id, { revision: row.revision }, 'DELETE');
    if (!alive) return;
    if (saved.value?.id === row.id) {
      editing.value = false;
      saved.value = null;
      text.value = '';
      epoch++;
    }
    await refresh();
  });
}
async function copy() {
  const source = saved.value;
  if (!source) return;
  await act(async () => {
    await props.api('/api/nodes', {
      drafts: source.items.filter((i) => selected.value.includes(i.nodeIndex)).map((i) => i.draft),
    });
    if (alive) {
      selected.value = [];
      message.value = '已复制为独立本地节点，可前往本地节点页编辑。';
    }
  });
}
onMounted(() => void act(refresh));
</script>
<template>
  <section class="panel library" aria-label="文本来源">
    <div class="section-title">
      <h1>文本来源</h1>
      <div class="toolbar">
        <button :disabled="busy" @click="act(refresh)">刷新来源列表</button
        ><button :disabled="busy" @click="startNew">新建文本来源</button>
      </div>
    </div>
    <p class="muted">
      保存粘贴文本供方案引用。来源节点只读；复制成本地节点后可独立编辑。URL 和 provider
      不会触发网络请求。
    </p>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <ul class="library-list">
      <li v-for="row in rows" :key="row.id">
        <span class="node-name"
          >{{ row.name
          }}<small
            >{{ row.nodeCount }} 节点 · {{ row.enabled ? '启用' : '停用' }} ·
            {{ row.savedAt }}</small
          ></span
        >
        <div class="toolbar">
          <button :disabled="busy" @click="edit(row.id)">编辑来源</button
          ><button :disabled="busy" @click="toggle(row)">
            {{ row.enabled ? '停用来源' : '启用来源' }}</button
          ><button :disabled="busy" @click="remove(row)">删除来源</button>
        </div>
      </li>
    </ul>
    <p v-if="!rows.length" class="muted">尚无文本来源。</p>
    <div class="pagination">
      <button
        :disabled="busy || !page"
        @click="
          act(async () => {
            page--;
            await refresh();
          })
        "
      >
        上一页</button
      ><span>第 {{ page + 1 }} 页 · 共 {{ total }} 项</span
      ><button
        :disabled="busy || (page + 1) * 25 >= total"
        @click="
          act(async () => {
            page++;
            await refresh();
          })
        "
      >
        下一页
      </button>
    </div>
    <fieldset v-if="editing" :disabled="busy" class="library-editor editor-fields">
      <legend>{{ saved ? '编辑文本来源' : '新建文本来源' }}</legend>
      <p v-if="conflict" class="warning-note">
        服务器已有更新，当前编辑已保留。重新载入会替换未保存内容。
      </p>
      <button v-if="conflict && saved" @click="edit(saved.id)">重新载入来源版本</button>
      <label>来源名称<input v-model="name" maxlength="512" /></label>
      <label
        >来源格式<select v-model="format" aria-label="来源格式">
          <option value="auto">自动识别</option>
          <option value="uri">URI</option>
          <option value="base64">Base64</option>
          <option value="yaml">Clash / Mihomo YAML</option>
        </select></label
      >
      <label>来源正文<textarea v-model="text" rows="8" spellcheck="false"></textarea></label>
      <label class="check-label"><input v-model="enabled" type="checkbox" />启用来源</label>
      <div
        v-for="(d, i) in diagnostics"
        :key="i"
        :class="d.level === 'error' ? 'error-note' : 'warning-note'"
      >
        {{ d.nodeIndex < 0 ? '输入' : '节点 ' + (d.nodeIndex + 1) }}：{{ d.message }}
      </div>
      <div class="toolbar">
        <button class="primary" @click="save">解析并保存来源</button
        ><button
          @click="
            editing = false;
            saved = null;
            text = '';
            epoch++;
          "
        >
          关闭来源编辑
        </button>
      </div>
      <template v-if="saved">
        <h2>已保存的只读节点</h2>
        <p class="muted">以下为 {{ saved.savedAt }} 保存的版本；未提交的正文编辑不改变它。</p>
        <p v-for="(d, i) in saved.diagnostics" :key="i" class="warning-note">{{ d.message }}</p>
        <ul class="library-list">
          <li
            v-for="item in saved.items.slice(nodePage * 25, nodePage * 25 + 25)"
            :key="item.nodeIndex"
          >
            <label class="check-label"
              ><input
                v-model="selected"
                type="checkbox"
                :value="item.nodeIndex"
                :aria-label="'选择来源节点 ' + item.draft?.name"
              /><span class="node-name"
                >{{ item.draft?.name
                }}<small
                  >{{ item.draft?.protocol.toUpperCase() }} · {{ item.draft?.server }}:{{
                    item.draft?.port
                  }}</small
                ><small v-for="(d, i) in item.diagnostics" :key="i">{{ d.message }}</small></span
              ></label
            >
          </li>
        </ul>
        <div class="pagination">
          <button :disabled="!nodePage" @click="nodePage--">上一页节点</button
          ><span>{{ nodePage + 1 }} / {{ Math.max(1, Math.ceil(saved.items.length / 25)) }}</span
          ><button :disabled="(nodePage + 1) * 25 >= saved.items.length" @click="nodePage++">
            下一页节点
          </button>
        </div>
        <button :disabled="!selected.length" @click="copy">复制所选为本地节点</button>
      </template>
    </fieldset>
  </section>
</template>
