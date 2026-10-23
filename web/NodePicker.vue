<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { z } from 'zod';
import {
  nodeListSchema,
  resourceSchema,
  type NodeSelector,
  type Resource,
  type NodeView,
} from '../server/shared/resources';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  label: string;
  modelValue: NodeSelector | null;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: NodeSelector] }>();
const resources = ref<Resource[]>([]),
  nodes = ref<NodeView[]>([]),
  resource = ref(props.modelValue?.resourceId ?? ''),
  search = ref(''),
  page = ref(0),
  total = ref(0),
  error = ref('');
let ticket = 0;
async function load() {
  const current = ++ticket;
  try {
    const result = nodeListSchema.parse(
      await props.api(
        '/api/nodes?resourceId=' +
          encodeURIComponent(resource.value) +
          '&search=' +
          encodeURIComponent(search.value) +
          '&page=' +
          page.value,
      ),
    );
    if (current !== ticket) return;
    nodes.value = result.nodes.filter((n) => n.available);
    total.value = result.total;
    error.value = result.errors.map((e) => e.message).join(' ');
  } catch (e) {
    if (current === ticket) error.value = e instanceof Error ? e.message : '读取失败。';
  }
}
onMounted(async () => {
  try {
    resources.value = z
      .object({ resources: z.array(resourceSchema) })
      .parse(await props.api('/api/nodes/resources')).resources;
    if (resource.value) await load();
    else
      resource.value =
        resources.value.find((r) => r.type === 'sub')?.id ?? resources.value[0]?.id ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取失败。';
  }
});
watch(resource, () => {
  page.value = 0;
  if (resource.value) void load();
});
function choose(event: Event) {
  const node = nodes.value.find(
    (n) => n.nodeIndex === Number((event.target as HTMLSelectElement).value),
  );
  if (node) emit('update:modelValue', { resourceId: node.resourceId, nodeName: node.name });
}
</script>
<template>
  <fieldset class="picker">
    <legend>{{ label }}</legend>
    <label
      >所属订阅
      <select v-model="resource">
        <option value="" disabled>选择订阅</option>
        <option v-for="r in resources" :key="r.id" :value="r.id">
          {{ r.name }}{{ r.type === 'collection' ? '（组合）' : '' }}
        </option>
      </select></label
    >
    <div class="picker-search">
      <input
        v-model="search"
        :aria-label="label + '搜索'"
        placeholder="搜索节点"
        @keydown.enter.prevent="
          page = 0;
          load();
        "
      /><button
        type="button"
        @click="
          page = 0;
          load();
        "
      >
        搜索
      </button>
    </div>
    <label
      >{{ label }}节点
      <select
        :value="
          nodes.find(
            (n) => n.resourceId === modelValue?.resourceId && n.name === modelValue?.nodeName,
          )?.nodeIndex ?? ''
        "
        @change="choose"
      >
        <option value="" disabled>选择节点</option>
        <option v-for="node in nodes" :key="node.nodeIndex" :value="node.nodeIndex">
          {{ node.name }} · {{ node.protocol }}
        </option>
      </select></label
    >
    <p v-if="modelValue" class="muted">已选择：{{ modelValue.nodeName }}</p>
    <div v-if="total > 25">
      <button
        type="button"
        :disabled="page === 0"
        @click="
          page--;
          load();
        "
      >
        上一页</button
      ><button
        type="button"
        :disabled="(page + 1) * 25 >= total"
        @click="
          page++;
          load();
        "
      >
        下一页
      </button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </fieldset>
</template>
<style scoped>
.picker {
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
  min-width: 0;
}
.picker label {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}
.picker select,
.picker input {
  width: 100%;
  min-width: 0;
}
.picker-search {
  display: flex;
  gap: var(--space-2);
}
.muted {
  overflow-wrap: anywhere;
}
</style>
