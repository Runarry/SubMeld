<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { ApiError } from './api';
import NodeTestSummary from './NodeTestSummary.vue';
import { useNodeTests } from './nodeTests';
import type { TestSubject } from '../server/shared/node-tests';
import { formatTime } from './format';
import ListPagination from './ui/ListPagination.vue';
import ModalDialog from './ui/ModalDialog.vue';
import StatusBadge from './ui/StatusBadge.vue';
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
const emit = defineEmits<{ 'open-nodes': [] }>();
const rows = ref<SourceSummary[]>([]),
  page = ref(0),
  total = ref(0),
  busy = ref(false),
  message = ref(''),
  conflict = ref(false);
const editing = ref(false),
  saved = ref<Source | null>(null),
  published = ref<Source | null>(null),
  name = ref(''),
  text = ref(''),
  format = ref<'auto' | 'uri' | 'base64' | 'yaml'>('auto'),
  enabled = ref(true),
  kind = ref<'text' | 'remote'>('text'),
  url = ref(''),
  userAgent = ref('SubMeld/1.0.0'),
  accept = ref('*/*'),
  authorization = ref(''),
  showUrl = ref(false),
  showAuthorization = ref(false);
const selected = ref<number[]>([]),
  nodePage = ref(0),
  diagnostics = ref<Diagnostic[]>([]);
function subject(source: Source, nodeIndex: number): TestSubject {
  return {
    kind: 'source',
    id: source.id,
    revision: source.revision,
    snapshotVersion: source.snapshotVersion,
    nodeIndex,
  };
}
const testing = useNodeTests(() => {
  const source = published.value;
  return source
    ? source.items
        .slice(nodePage.value * 25, nodePage.value * 25 + 25)
        .map((item) => subject(source, item.nodeIndex))
    : [];
}, props.api);
const selectedSubjects = () => {
  const source = published.value;
  return source
    ? source.items
        .filter((item) => selected.value.includes(item.nodeIndex))
        .map((item) => subject(source, item.nodeIndex))
    : [];
};
let alive = true,
  epoch = 0,
  listTicket = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
function clearEditor() {
  epoch++;
  editing.value = false;
  saved.value = null;
  published.value = null;
  text.value = '';
  url.value = '';
  authorization.value = '';
  userAgent.value = 'SubMeld/1.0.0';
  accept.value = '*/*';
  showUrl.value = false;
  showAuthorization.value = false;
  selected.value = [];
}
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(timer);
  clearEditor();
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
  const ticket = ++listTicket,
    currentPage = page.value;
  const result = sourceListSchema.parse(await props.api('/api/sources?page=' + currentPage));
  if (!alive || ticket !== listTicket || page.value !== currentPage) return;
  rows.value = result.sources;
  total.value = result.total;
  if (!rows.value.length && page.value) {
    page.value--;
    await refresh();
  }
}
function updatePublished(source: Source) {
  if (
    published.value?.snapshotVersion !== source.snapshotVersion ||
    published.value?.savedAt !== source.savedAt ||
    published.value?.revision !== source.revision
  ) {
    selected.value = [];
    nodePage.value = 0;
  }
  published.value = source;
  if (saved.value && source.revision !== saved.value.revision) conflict.value = true;
}
function fill(source: Source) {
  saved.value = source;
  published.value = source;
  name.value = source.name;
  text.value = source.kind === 'text' ? source.text : '';
  format.value = source.format;
  enabled.value = source.enabled;
  kind.value = source.kind;
  url.value = source.url ?? '';
  userAgent.value = source.headers?.userAgent ?? 'SubMeld/1.0.0';
  accept.value = source.headers?.accept ?? '*/*';
  authorization.value = source.headers?.authorization ?? '';
  showUrl.value = false;
  showAuthorization.value = false;
  editing.value = true;
  conflict.value = false;
  selected.value = [];
  nodePage.value = 0;
}
function startNew(sourceKind: 'text' | 'remote') {
  clearEditor();
  editing.value = true;
  kind.value = sourceKind;
  name.value = '';
  format.value = 'auto';
  enabled.value = true;
  conflict.value = false;
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
    const before = saved.value;
    let input: Record<string, unknown>;
    if (!before) {
      input = {
        name: name.value,
        format: format.value,
        enabled: enabled.value,
        kind: kind.value,
        ...(kind.value === 'text'
          ? { text: text.value }
          : {
              url: url.value,
              headers: {
                userAgent: userAgent.value,
                accept: accept.value,
                authorization: authorization.value,
              },
            }),
      };
    } else {
      input = { revision: before.revision };
      if (name.value !== before.name) input.name = name.value;
      if (format.value !== before.format) input.format = format.value;
      if (enabled.value !== before.enabled) input.enabled = enabled.value;
      if (kind.value === 'text') {
        if (text.value !== before.text) input.text = text.value;
      } else {
        if (url.value !== before.url) input.url = url.value;
        const headers: Record<string, string | null> = {};
        for (const [key, value] of Object.entries({
          userAgent: userAgent.value,
          accept: accept.value,
          authorization: authorization.value,
        })) {
          if (value !== before.headers?.[key as keyof NonNullable<Source['headers']>])
            headers[key] = value || null;
        }
        if (Object.keys(headers).length) input.headers = headers;
      }
      if (Object.keys(input).length === 1) {
        message.value = '来源设置未更改。';
        return;
      }
    }
    const value = sourceSchema.parse(
      await props.api(
        before ? '/api/sources/' + before.id : '/api/sources',
        input,
        before ? 'PATCH' : 'POST',
      ),
    );
    if (!alive || current !== epoch) return;
    epoch++;
    fill(value);
    await refresh();
    if (alive)
      message.value =
        value.kind === 'text'
          ? '文本来源已保存，相关订阅已安排更新。'
          : '远端来源设置已保存；刷新状态和最近成功内容见下方。';
  });
}
async function fetchSource(row: SourceSummary) {
  const current = epoch;
  await act(async () => {
    const value = sourceSchema.parse(
      await props.api('/api/sources/' + row.id + '/refresh', { revision: row.revision }),
    );
    if (!alive) return;
    if (current === epoch && saved.value?.id === row.id) updatePublished(value);
    await refresh();
    if (alive) message.value = '已安排刷新已保存的来源；未提交编辑不参与本次刷新。';
  });
}
async function toggle(row: SourceSummary) {
  const current = epoch;
  await act(async () => {
    const value = sourceSchema.parse(
      await props.api(
        '/api/sources/' + row.id,
        { revision: row.revision, enabled: !row.enabled },
        'PATCH',
      ),
    );
    if (!alive) return;
    if (current === epoch && saved.value?.id === row.id) {
      if (saved.value.revision === row.revision) {
        saved.value = { ...saved.value, revision: value.revision, enabled: value.enabled };
        enabled.value = value.enabled;
      }
      epoch++;
      updatePublished(value);
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
    if (saved.value?.id === row.id) clearEditor();
    await refresh();
  });
}
async function copy() {
  const source = published.value;
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
async function poll() {
  try {
    if (!busy.value) {
      await refresh();
      const id = saved.value?.id,
        current = epoch;
      if (id && saved.value?.kind === 'remote') {
        const value = sourceSchema.parse(await props.api('/api/sources/' + id));
        if (alive && current === epoch && saved.value?.id === id) updatePublished(value);
      }
    }
  } catch (error) {
    if (alive) {
      message.value =
        error instanceof Error
          ? '来源状态更新失败：' + error.message
          : '来源状态更新失败，请刷新列表重试。';
      if (error instanceof ApiError && error.status === 404) {
        published.value = null;
        selected.value = [];
        conflict.value = true;
      }
    }
  } finally {
    if (alive) timer = setTimeout(poll, 2000);
  }
}
onMounted(() => {
  void act(refresh);
  timer = setTimeout(poll, 2000);
});
const statusLabel = (value: Source['refresh']) =>
  value === 'running' ? '刷新中' : value === 'queued' ? '等待刷新' : '空闲';
</script>
<template>
  <section class="library" aria-label="来源管理">
    <div class="page-header">
      <div>
        <h1>来源管理</h1>
        <p class="muted">
          文本来源保存粘贴内容；远端来源仅抓取公网 HTTPS，每 6
          小时顺序刷新。来源节点只读，复制成本地节点后可独立编辑。
        </p>
      </div>
      <div class="toolbar">
        <button type="button" :disabled="busy" @click="act(refresh)">刷新来源列表</button>
        <button type="button" :disabled="busy" @click="startNew('text')">新建文本来源</button>
        <button type="button" class="primary" :disabled="busy" @click="startNew('remote')">
          新建远端来源
        </button>
      </div>
    </div>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <div class="library-main">
      <ul v-if="rows.length" class="library-list">
        <li v-for="row in rows" :key="row.id" @click="edit(row.id)">
          <span class="node-name"
            >{{ row.name }}
            <small class="list-meta">
              {{ row.kind === 'text' ? '文本' : '远端 HTTPS' }} · {{ row.nodeCount }} 节点
              <StatusBadge
                :tone="row.enabled ? 'ok' : 'off'"
                :label="row.enabled ? '启用' : '停用'"
              />
              <StatusBadge
                v-if="row.kind === 'remote'"
                :tone="row.refresh === 'idle' ? 'off' : 'busy'"
                :label="statusLabel(row.refresh)"
              />
            </small>
            <small>最近成功：{{ row.savedAt ? formatTime(row.savedAt) : '尚无成功快照' }}</small>
            <small v-if="row.kind === 'remote'"
              >最近尝试：{{
                row.lastAttemptAt ? formatTime(row.lastAttemptAt) : '尚未完成尝试'
              }}</small
            >
            <p v-if="row.error" class="error-note row-error">
              {{ row.error.message }}<span v-if="row.savedAt"> 继续使用上述最近成功内容。</span>
            </p>
          </span>
          <div class="toolbar" @click.stop>
            <button
              v-if="row.kind === 'remote'"
              type="button"
              :disabled="busy || !row.enabled || row.refresh !== 'idle'"
              @click="fetchSource(row)"
            >
              刷新远端来源
            </button>
            <button type="button" :disabled="busy" @click="edit(row.id)">编辑来源</button>
            <button type="button" :disabled="busy" @click="toggle(row)">
              {{ row.enabled ? '停用来源' : '启用来源' }}
            </button>
            <button type="button" class="danger linkish" :disabled="busy" @click="remove(row)">
              删除来源
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="empty-state">尚无来源。可新建文本来源或远端 HTTPS 来源。</p>
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
      v-if="editing"
      :label="(saved ? '编辑' : '新建') + (kind === 'text' ? '文本来源' : '远端来源')"
      :wide="kind === 'remote'"
      :dismissible="!busy"
      @close="clearEditor"
    >
      <template v-if="message" #banner>
        <p class="notice" role="status">{{ message }}</p>
      </template>
      <fieldset :disabled="busy" class="library-editor editor-fields">
        <legend>{{ saved ? '编辑' : '新建' }}{{ kind === 'text' ? '文本' : '远端' }}来源</legend>
        <p v-if="conflict" class="warning-note">
          服务器已有更新，当前编辑已保留。重新载入会替换未保存内容。
        </p>
        <button v-if="conflict && saved" type="button" @click="edit(saved.id)">
          重新载入来源版本
        </button>
        <label>来源名称<input v-model="name" maxlength="512" /></label>
        <label
          >来源格式<select v-model="format" aria-label="来源格式">
            <option value="auto">自动识别</option>
            <option value="uri">URI</option>
            <option value="base64">Base64</option>
            <option value="yaml">Clash / Mihomo YAML</option>
          </select></label
        >
        <label v-if="kind === 'text'"
          >来源正文<textarea v-model="text" rows="8" spellcheck="false"></textarea>
        </label>
        <template v-else>
          <label
            >来源 URL<input
              v-model="url"
              :type="showUrl ? 'text' : 'password'"
              maxlength="8192"
              autocomplete="off"
              spellcheck="false"
          /></label>
          <button type="button" @click="showUrl = !showUrl">
            {{ showUrl ? '隐藏来源 URL' : '显示来源 URL' }}
          </button>
          <label>User-Agent<input v-model="userAgent" maxlength="8192" /></label>
          <button type="button" @click="userAgent = ''">清空 User-Agent</button>
          <label>Accept<input v-model="accept" maxlength="8192" /></label>
          <button type="button" @click="accept = ''">清空 Accept</button>
          <label
            >Authorization<input
              v-model="authorization"
              :type="showAuthorization ? 'text' : 'password'"
              maxlength="8192"
              autocomplete="off"
              spellcheck="false"
          /></label>
          <div class="toolbar">
            <button type="button" @click="showAuthorization = !showAuthorization">
              {{ showAuthorization ? '隐藏 Authorization' : '显示 Authorization' }}</button
            ><button type="button" @click="authorization = ''">清空 Authorization</button>
          </div>
          <p class="muted">
            地址和认证未修改时不提交。修改地址、请求头或格式会清除旧快照与相关订阅产物，成功刷新后重新生成。
          </p>
        </template>
        <label class="check-label"><input v-model="enabled" type="checkbox" />启用来源</label>
        <div
          v-for="(d, i) in diagnostics"
          :key="i"
          :class="d.level === 'error' ? 'error-note' : 'warning-note'"
        >
          {{ d.nodeIndex < 0 ? '输入' : '节点 ' + (d.nodeIndex + 1) }}：{{ d.message }}
        </div>
        <div v-if="saved?.kind === 'remote'" class="toolbar">
          <button
            type="button"
            :disabled="!saved.enabled || published?.refresh !== 'idle'"
            @click="fetchSource(saved)"
          >
            刷新远端来源
          </button>
        </div>
        <template v-if="published">
          <h2>已保存的只读节点</h2>
          <p v-if="testing.error" class="error-note">{{ testing.error }}</p>
          <p class="muted">
            最近成功：{{
              published.savedAt ? formatTime(published.savedAt) : '尚无成功快照'
            }}；未提交编辑不改变以下内容。
          </p>
          <p v-if="published.kind === 'remote'" role="status">
            {{ statusLabel(published.refresh) }} · 最近尝试：{{
              published.lastAttemptAt ? formatTime(published.lastAttemptAt) : '尚未完成尝试'
            }}
          </p>
          <p v-if="published.error" class="error-note">
            {{ published.error.message
            }}<span v-if="published.savedAt"> 继续使用最近成功快照。</span>
          </p>
          <p v-for="(d, i) in published.diagnostics" :key="i" class="warning-note">
            {{ d.message }}
          </p>
          <ul class="library-list">
            <li
              v-for="item in published.items.slice(nodePage * 25, nodePage * 25 + 25)"
              :key="item.nodeIndex"
            >
              <label class="check-label"
                ><input
                  v-model="selected"
                  type="checkbox"
                  :value="item.nodeIndex"
                  :aria-label="'选择来源节点 ' + item.draft?.name"
                />
                <span class="node-name"
                  >{{ item.draft?.name
                  }}<small
                    >{{ item.draft?.protocol.toUpperCase() }} · {{ item.draft?.server }}:{{
                      item.draft?.port
                    }}</small
                  ><small v-for="(d, i) in item.diagnostics" :key="i">{{ d.message }}</small
                  ><NodeTestSummary
                    :results="testing.forSubject(subject(published, item.nodeIndex))"
                    @show="testing.show([subject(published, item.nodeIndex)])"
                /></span>
              </label>
              <button
                type="button"
                :disabled="testing.starting"
                @click="testing.start([subject(published, item.nodeIndex)])"
              >
                测试来源节点
              </button>
            </li>
          </ul>
          <div class="pagination">
            <button type="button" :disabled="!nodePage" @click="nodePage--">上一页节点</button
            ><span
              >{{ nodePage + 1 }} / {{ Math.max(1, Math.ceil(published.items.length / 25)) }}</span
            >
            <button
              type="button"
              :disabled="(nodePage + 1) * 25 >= published.items.length"
              @click="nodePage++"
            >
              下一页节点
            </button>
          </div>
          <div class="toolbar">
            <button
              type="button"
              :disabled="testing.starting || !selected.length"
              @click="testing.start(selectedSubjects())"
            >
              测试所选来源节点
            </button>
            <button type="button" :disabled="!selected.length" @click="copy">
              复制所选为本地节点
            </button>
            <button type="button" @click="emit('open-nodes')">打开本地节点</button>
          </div>
        </template>
      </fieldset>
      <template #footer>
        <button type="button" class="primary" :disabled="busy" @click="save">
          {{ kind === 'text' ? '解析并保存来源' : '保存远端来源' }}
        </button>
        <button type="button" :disabled="busy" @click="clearEditor">关闭来源编辑</button>
      </template>
    </ModalDialog>
  </section>
</template>
