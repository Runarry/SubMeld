<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import {
  sourceListSchema,
  sourceSchema,
  type Source,
  type SourceSummary,
} from '../server/shared/subscriptions';
import type { TestSubject } from '../server/shared/node-tests';
import { useNodeTests } from './nodeTests';
import NodeTestSummary from './NodeTestSummary.vue';
import ListPagination from './ui/ListPagination.vue';
import { formatTime } from './format';
import { ApiError } from './api';
import type { Diagnostic } from '../server/shared/contracts';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const emit = defineEmits<{ 'open-nodes': [] }>();
const rows = ref<SourceSummary[]>([]),
  total = ref(0),
  page = ref(0),
  nodePage = ref(0);
const source = ref<Source | null>(null),
  selected = ref<number[]>([]),
  busy = ref(false),
  message = ref('');
const diagnostics = ref<Diagnostic[]>([]);
let alive = true,
  ticket = 0;
onBeforeUnmount(() => {
  alive = false;
  ticket++;
});
function subject(index: number): TestSubject[] {
  return source.value
    ? [
        {
          kind: 'source',
          id: source.value.id,
          revision: source.value.revision,
          snapshotHash: source.value.snapshotHash,
          nodeIndex: index,
        },
      ]
    : [];
}
const testing = useNodeTests(
  () =>
    source.value?.items
      .slice(nodePage.value * 25, nodePage.value * 25 + 25)
      .flatMap((i) => subject(i.nodeIndex)) ?? [],
  props.api,
);
async function act(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  diagnostics.value = [];
  try {
    await task();
  } catch (error) {
    if (alive) {
      message.value = error instanceof Error ? error.message : '操作失败。';
      diagnostics.value = error instanceof ApiError ? error.diagnostics : [];
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function load() {
  const epoch = ++ticket;
  const result = sourceListSchema.parse(await props.api('/api/sources?page=' + page.value));
  if (alive && epoch === ticket) {
    rows.value = result.sources;
    total.value = result.total;
    const current = rows.value.find((row) => row.id === source.value?.id) ?? rows.value[0];
    if (current) await open(current.id);
    else {
      source.value = null;
      selected.value = [];
    }
  }
}
async function open(id: string, refresh = false) {
  const epoch = ++ticket;
  const before = source.value;
  let result = sourceSchema.parse(await props.api('/api/sources/' + id));
  if (refresh)
    result = sourceSchema.parse(
      await props.api('/api/sources/' + id + '/refresh', { revision: result.revision }),
    );
  if (!alive || ticket !== epoch) return;
  if (
    before?.id !== id ||
    before.snapshotHash !== result.snapshotHash ||
    before.revision !== result.revision
  ) {
    selected.value = [];
    nodePage.value = 0;
  }
  source.value = result;
  rows.value = rows.value.map((row) => (row.id === id ? { ...row, ...result } : row));
}
async function copy() {
  const drafts =
    source.value?.items
      .filter((i) => selected.value.includes(i.nodeIndex))
      .map((i) => i.draft)
      .filter((d) => d !== null) ?? [];
  if (!drafts.length) return;
  await props.api('/api/nodes', { drafts });
  if (alive) {
    selected.value = [];
    message.value = '已保存为 Sub-Store 中独立的本地节点。';
  }
}
onMounted(() => {
  void act(load);
});
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>上游节点预览</h1>
        <p>
          来源与普通组合订阅在 Sub-Store 管理。这里可选择节点进行三内核测试，或复制成独立本地节点。
        </p>
      </div>
      <a href="/">打开 Sub-Store</a>
    </header>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <ul v-if="diagnostics.length" class="diagnostics" role="alert">
      <li v-for="(item, index) in diagnostics" :key="index">
        {{ item.nodeIndex >= 0 ? `第 ${item.nodeIndex + 1} 项：` : '' }}{{ item.message }}
      </li>
    </ul>
    <button type="button" :disabled="busy" @click="act(load)">刷新列表</button>
    <p v-if="!busy && !rows.length" class="empty-state">
      还没有上游订阅。请先在 Sub-Store 保存订阅，再刷新这里的列表。
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>来源</th>
            <th>节点</th>
            <th>最近读取</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>{{ row.name }}</td>
            <td>{{ row.savedAt ? row.nodeCount : '尚未读取' }}</td>
            <td>{{ formatTime(row.savedAt) }}</td>
            <td>
              <button type="button" :disabled="busy" @click="act(() => open(row.id))">
                查看节点
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ListPagination
      :page="page"
      :total="total"
      :disabled="busy"
      @turn="
        (delta) => {
          page += delta;
          act(load);
        }
      "
    />
    <section v-if="source" class="panel">
      <h2>{{ source.name }}</h2>
      <p>
        {{ source.upstreamType === 'collection' ? '组合订阅' : '单条订阅' }} ·
        {{ source.nodeCount }} 个节点
      </p>
      <div class="toolbar">
        <button type="button" :disabled="busy" @click="act(() => open(source!.id, true))">
          更新上游快照
        </button>
        <button type="button" :disabled="busy || !selected.length" @click="act(copy)">
          复制所选为本地节点
        </button>
        <button
          type="button"
          :disabled="busy || !selected.length || testing.starting"
          @click="testing.start(selected.flatMap(subject))"
        >
          测试所选节点
        </button>
        <button type="button" @click="emit('open-nodes')">打开本地节点</button>
      </div>
      <p v-if="testing.error" role="alert">{{ testing.error }}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="选择全部来源节点"
                  :checked="selected.length === source.items.length"
                  @change="
                    selected =
                      selected.length === source.items.length
                        ? []
                        : source.items.map((i) => i.nodeIndex)
                  "
                />
              </th>
              <th>节点</th>
              <th>协议</th>
              <th>测试</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in source.items.slice(nodePage * 25, nodePage * 25 + 25)"
              :key="item.nodeIndex"
            >
              <td>
                <input
                  v-model="selected"
                  type="checkbox"
                  :value="item.nodeIndex"
                  :aria-label="'选择 ' + item.draft?.name"
                />
              </td>
              <td>{{ item.draft?.name }}</td>
              <td>{{ item.draft?.protocol }}</td>
              <td>
                <button
                  type="button"
                  :disabled="testing.starting"
                  @click="testing.start(subject(item.nodeIndex))"
                >
                  测试</button
                ><NodeTestSummary
                  :results="testing.forSubject(subject(item.nodeIndex)[0]!)"
                  @show="testing.show(subject(item.nodeIndex))"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ListPagination
        :page="nodePage"
        :total="source.items.length"
        @turn="(delta) => (nodePage += delta)"
      />
    </section>
  </section>
</template>
<style scoped>
.table-wrap {
  overflow-x: auto;
  width: 100%;
  margin: 14px 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  padding: 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.table-wrap input[type='checkbox'] {
  width: auto;
}
.page > .panel {
  margin-top: 20px;
}
@media (max-width: 600px) {
  table {
    min-width: 520px;
  }
}
</style>
