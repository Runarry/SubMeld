<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { nodeListSchema, type NodeView, type Resource } from '../server/shared/resources';
import { inputKey, type InputRef } from '../server/shared/subscriptions';
import { MAX_NODES } from '../server/shared/contracts';
import ListPagination from './ui/ListPagination.vue';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  inputs: InputRef[];
  resources: Resource[];
  disabled: boolean;
}>();
const emit = defineEmits<{ add: [inputs: InputRef[]]; resources: [resources: Resource[]] }>();
const open = ref(props.inputs.length === 0);
const tab = ref<'node' | 'resource'>('node');
const search = ref('');
const appliedSearch = ref('');
const resourceId = ref('');
const nodePage = ref(0);
const resourcePage = ref(0);
const nodes = ref<NodeView[]>([]);
const total = ref(0);
const pending = ref<InputRef[]>([]);
const loading = ref(false);
const fresh = ref(false);
const errors = ref<string[]>([]);
const message = ref('');
const existing = computed(() => new Set(props.inputs.map(inputKey)));
const selection = computed(() =>
  pending.value.filter((input) => !existing.value.has(inputKey(input))),
);
const selected = computed(() => new Set(selection.value.map(inputKey)));
const matchingResources = computed(() =>
  props.resources.filter((resource) =>
    resource.name.toLowerCase().includes(search.value.trim().toLowerCase()),
  ),
);
const resourceRows = computed(() =>
  matchingResources.value.slice(resourcePage.value * 25, (resourcePage.value + 1) * 25),
);
const options = computed(() => {
  if (tab.value === 'node')
    return nodes.value.map((node) => ({
      key: node.resourceId + ':' + node.nodeIndex,
      input: { kind: 'node', resourceId: node.resourceId, nodeName: node.name } satisfies InputRef,
      name: node.name,
      description: node.protocol + ' · ' + node.resourceName,
      label: '选择节点 ' + node.name + ' · ' + node.resourceName,
      error: node.referenceError,
    }));
  return resourceRows.value.map((resource) => ({
    key: resource.id,
    input: { kind: 'resource', id: resource.id } satisfies InputRef,
    name: resource.name,
    description: (resource.type === 'collection' ? '组合' : '订阅') + ' · 全部处理后节点',
    label: '选择来源 ' + resource.name,
    error: '',
  }));
});
const availableInputs = computed(() =>
  options.value
    .filter((row) => !row.error && !existing.value.has(inputKey(row.input)))
    .map((row) => row.input),
);
const pageSelected = computed(
  () =>
    availableInputs.value.length > 0 &&
    availableInputs.value.every((input) => selected.value.has(inputKey(input))),
);
const overLimit = computed(() => props.inputs.length + selection.value.length > MAX_NODES);

let alive = true;
let ticket = 0;
let queued = false;
let reading = false;
let timer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  if (reading) return;
  reading = true;
  loading.value = true;
  try {
    while (queued && alive) {
      queued = false;
      const current = ticket;
      const query = new URLSearchParams({
        resourceId: resourceId.value,
        search: appliedSearch.value,
        page: String(nodePage.value),
      });
      try {
        const result = nodeListSchema.parse(await props.api('/api/nodes?' + query));
        if (!alive || current !== ticket) continue;
        nodes.value = result.nodes;
        total.value = result.total;
        fresh.value = true;
        errors.value = result.errors.map(
          (error) =>
            (result.resources.find((resource) => resource.id === error.resourceId)?.name ??
              '订阅') +
            ' · ' +
            error.message,
        );
        emit('resources', result.resources);
      } catch (error) {
        if (alive && current === ticket) {
          fresh.value = false;
          errors.value = [error instanceof Error ? error.message : '无法读取节点。'];
        }
      }
    }
  } finally {
    reading = false;
    if (alive) loading.value = false;
  }
}
function requestNodes() {
  ticket++;
  fresh.value = false;
  if (!open.value || tab.value !== 'node' || appliedSearch.value !== search.value.trim()) {
    queued = false;
    return;
  }
  queued = true;
  void load();
}
function applySearch() {
  clearTimeout(timer);
  const unchanged = appliedSearch.value === search.value.trim() && nodePage.value === 0;
  appliedSearch.value = search.value.trim();
  nodePage.value = 0;
  resourcePage.value = 0;
  if (unchanged) requestNodes();
}
watch(search, () => {
  ticket++;
  fresh.value = false;
  clearTimeout(timer);
  timer = setTimeout(applySearch, 300);
});
watch([open, tab, appliedSearch, resourceId, nodePage], requestNodes, { immediate: true });
function changeResource() {
  nodePage.value = 0;
}
function toggle(input: InputRef) {
  if (props.disabled || existing.value.has(inputKey(input))) return;
  message.value = '';
  if (selected.value.has(inputKey(input)))
    pending.value = pending.value.filter((item) => inputKey(item) !== inputKey(input));
  else pending.value.push(input);
}
function togglePage() {
  if (pageSelected.value) {
    const pageKeys = new Set(availableInputs.value.map(inputKey));
    pending.value = pending.value.filter((input) => !pageKeys.has(inputKey(input)));
  } else {
    pending.value.push(
      ...availableInputs.value.filter((input) => !selected.value.has(inputKey(input))),
    );
  }
}
function add() {
  if (props.disabled || overLimit.value || !selection.value.length) return;
  const inputs = [...selection.value];
  emit('add', inputs);
  pending.value = [];
  message.value = '已加入 ' + inputs.length + ' 项。';
}
onBeforeUnmount(() => {
  alive = false;
  ticket++;
  clearTimeout(timer);
});
</script>

<template>
  <section class="picker" aria-label="添加方案输入">
    <div class="picker-header">
      <h3 v-if="open">添加输入</h3>
      <button type="button" :disabled="disabled" :aria-expanded="open" @click="open = !open">
        {{ open ? '收起选择' : '添加输入' }}
      </button>
    </div>
    <template v-if="open">
      <div class="picker-tabs" role="tablist" aria-label="输入类型">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'node'"
          :disabled="disabled"
          @click="tab = 'node'"
        >
          节点
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'resource'"
          :disabled="disabled"
          @click="tab = 'resource'"
        >
          订阅与组合
        </button>
      </div>
      <div class="picker-filters">
        <input
          v-model="search"
          :disabled="disabled"
          aria-label="搜索方案输入"
          :placeholder="tab === 'node' ? '搜索节点名称、协议或来源' : '搜索订阅或组合名称'"
          @keydown.enter.prevent="applySearch"
        />
        <label v-if="tab === 'node'"
          >节点来源
          <select v-model="resourceId" :disabled="disabled" @change="changeResource">
            <option value="">全部订阅</option>
            <option v-for="resource in resources" :key="resource.id" :value="resource.id">
              {{ resource.name }}{{ resource.type === 'collection' ? '（组合）' : '' }}
            </option>
          </select>
        </label>
      </div>
      <div class="picker-selection">
        <label
          ><input
            type="checkbox"
            :checked="pageSelected"
            :disabled="disabled || !availableInputs.length || (tab === 'node' && !fresh)"
            @change="togglePage"
          />全选本页</label
        >
        <span>已选 {{ selection.length }} 项</span>
        <button v-if="selection.length" type="button" :disabled="disabled" @click="pending = []">
          清除选择
        </button>
      </div>
      <div class="picker-options" :aria-busy="tab === 'node' && loading">
        <p v-if="tab === 'node' && (loading || (!fresh && !errors.length))" class="muted">
          正在读取节点…
        </p>
        <p v-else-if="!options.length && (tab === 'resource' || fresh)" class="muted">
          {{ tab === 'node' ? '没有匹配的节点。' : '没有匹配的订阅或组合。' }}
        </p>
        <label v-for="row in options" :key="row.key" class="picker-row">
          <input
            type="checkbox"
            :aria-label="row.label"
            :checked="existing.has(inputKey(row.input)) || selected.has(inputKey(row.input))"
            :disabled="
              disabled ||
              (tab === 'node' && !fresh) ||
              !!row.error ||
              existing.has(inputKey(row.input))
            "
            @change="toggle(row.input)"
          />
          <span class="picker-main"
            ><strong>{{ row.name }}</strong
            ><span class="muted">{{ row.description }}</span
            ><span v-if="row.error" class="picker-reason">{{ row.error }}</span></span
          >
          <span v-if="existing.has(inputKey(row.input))" class="muted">已加入</span>
        </label>
      </div>
      <p
        v-for="(error, index) in errors"
        v-show="tab === 'node'"
        :key="index"
        role="alert"
        class="picker-reason"
      >
        {{ error }}
      </p>
      <button
        v-if="tab === 'node' && errors.length"
        type="button"
        :disabled="disabled || loading"
        @click="requestNodes"
      >
        重新读取节点
      </button>
      <ListPagination
        :page="tab === 'node' ? nodePage : resourcePage"
        :total="tab === 'node' ? total : matchingResources.length"
        :disabled="disabled || (tab === 'node' && loading)"
        @turn="
          (delta) => {
            if (tab === 'node') nodePage += delta;
            else resourcePage += delta;
          }
        "
      />
      <p v-if="overLimit" role="alert" class="picker-reason">
        本方案最多添加 {{ MAX_NODES }} 项输入，还可加入
        {{ Math.max(0, MAX_NODES - inputs.length) }} 项。
      </p>
      <div class="picker-actions">
        <p v-if="message" role="status" class="muted">{{ message }}</p>
        <button type="button" :disabled="disabled || !selection.length || overLimit" @click="add">
          加入 {{ selection.length }} 项
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.picker {
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  min-width: 0;
}
.picker-header,
.picker-selection,
.picker-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.picker-header,
.picker-actions {
  justify-content: space-between;
}
.picker-header h3 {
  font-size: var(--text-base);
  margin: 0;
}
.picker-tabs {
  display: flex;
  gap: var(--space-2);
  margin-block: var(--space-3);
}
.picker-tabs [aria-selected='true'] {
  color: var(--primary-hover);
  background: var(--row-active);
  border-color: var(--primary-border);
}
.picker-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: end;
}
.picker-filters label {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.picker-filters input,
.picker-filters select {
  width: 100%;
  min-width: 0;
}
.picker-selection {
  margin-block: var(--space-3);
  font-size: var(--text-xs);
}
.picker-selection label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}
.picker-options {
  max-height: 280px;
  overflow-y: auto;
  padding: var(--space-1);
}
.picker-row {
  display: flex;
  flex-direction: row;
  align-items: start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-2);
  border-bottom: var(--border-width) solid var(--border);
  cursor: pointer;
}
.picker-row > input {
  margin-top: var(--space-1);
}
.picker-main {
  display: grid;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.picker-main strong {
  font-weight: var(--weight-medium);
}
.picker-main .muted,
.picker-row > .muted {
  font-size: var(--text-xs);
}
.picker-reason {
  color: var(--warn-text);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
.picker-actions {
  justify-content: flex-end;
  margin-top: var(--space-3);
}
.picker-actions p {
  margin-right: auto;
}
@media (max-width: 650px) {
  .picker-filters {
    grid-template-columns: minmax(0, 1fr);
  }
  .picker {
    padding: var(--space-3);
  }
}
</style>
