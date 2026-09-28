<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  chainListSchema,
  chainSchema,
  chainConfigSchema,
  type Chain,
  type ChainConfig,
} from '../server/shared/chains';
import { nodeRefSchema, type NodeView } from '../server/shared/resources';
import type { TestSubject } from '../server/shared/node-tests';
import NodePicker from './NodePicker.vue';
import ModalDialog from './ui/ModalDialog.vue';
import NodeTestSummary from './NodeTestSummary.vue';
import { useNodeTests } from './nodeTests';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const rows = ref<Chain[]>([]),
  page = ref(0),
  total = ref(0),
  busy = ref(false),
  message = ref(''),
  baseline = ref<Chain | null>(null),
  deleting = ref<Chain | null>(null);
const form = ref<{
  name: string;
  enabled: boolean;
  entry: ChainConfig['entry'] | null;
  exit: ChainConfig['exit'] | null;
} | null>(null);
const refOf = (n: NodeView) =>
  nodeRefSchema.parse({
    resourceId: n.resourceId,
    revision: n.revision,
    snapshotHash: n.snapshotHash,
    nodeIndex: n.nodeIndex,
  });
const subject = (c: Chain): TestSubject => ({
  kind: 'chain',
  id: c.id,
  revision: c.revision,
  entry: refOf(c.entryNode!),
  exit: refOf(c.exitNode!),
});
const testing = useNodeTests(
  () => rows.value.filter((c) => c.entryNode && c.exitNode).map(subject),
  props.api,
);
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await fn();
  } catch (e) {
    message.value = e instanceof Error ? e.message : '操作失败。';
  } finally {
    busy.value = false;
  }
}
async function load() {
  const data = chainListSchema.parse(await props.api('/api/chains?page=' + page.value));
  rows.value = data.chains;
  total.value = data.total;
}
function create() {
  baseline.value = null;
  form.value = { name: '', enabled: true, entry: null, exit: null };
}
async function save() {
  const config = chainConfigSchema.safeParse(form.value);
  if (!config.success) throw new Error('请填写链名称并选择两个节点。');
  await props.api(
    '/api/chains' + (baseline.value ? '/' + baseline.value.id : ''),
    { ...config.data, ...(baseline.value ? { revision: baseline.value.revision } : {}) },
    baseline.value ? 'PATCH' : 'POST',
  );
  form.value = null;
  await load();
}
async function edit(c: Chain) {
  baseline.value = chainSchema.parse(await props.api('/api/chains/' + c.id));
  form.value = chainConfigSchema.strip().parse(baseline.value);
}
onMounted(() => void act(load));
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>两跳链</h1>
        <p>本机 → 前置 → 出口 → 目标。链定义保存到 Sub-Store。</p>
      </div>
      <button class="primary" @click="create">添加两跳链</button>
    </header>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <p v-if="testing.error" role="alert">{{ testing.error }}</p>
    <div class="panel">
      <p v-if="!rows.length">尚未创建两跳链。</p>
      <article v-for="chain in rows" :key="chain.id" class="chain-row">
        <div>
          <h2>{{ chain.name }}</h2>
          <p>{{ chain.entry.nodeName }} → {{ chain.exit.nodeName }}</p>
          <p v-if="chain.error" role="alert">{{ chain.error }}</p>
          <p v-else>{{ chain.enabled ? '已启用' : '已停用' }}</p>
          <NodeTestSummary
            v-if="chain.entryNode && chain.exitNode"
            :results="testing.forSubject(subject(chain))"
            @show="testing.show([subject(chain)])"
          />
        </div>
        <div class="actions">
          <button :disabled="busy" @click="act(() => edit(chain))">配置</button
          ><button
            :disabled="!chain.entryNode || !chain.exitNode || testing.starting"
            @click="testing.start([subject(chain)])"
          >
            测试整链</button
          ><button class="danger" :disabled="busy" @click="deleting = chain">删除</button>
        </div>
      </article>
    </div>
    <div class="pagination">
      <button
        :disabled="page === 0 || busy"
        @click="
          page--;
          act(load);
        "
      >
        上一页</button
      ><span>{{ page + 1 }}</span
      ><button
        :disabled="(page + 1) * 25 >= total || busy"
        @click="
          page++;
          act(load);
        "
      >
        下一页
      </button>
    </div>
    <ModalDialog v-if="form" label="配置两跳链" wide :dismissible="!busy" @close="form = null"
      ><h2>配置两跳链</h2>
      <form id="chain-form" class="chain-form" @submit.prevent="act(save)">
        <label>链名称<input v-model="form.name" required maxlength="512" /></label
        ><label><input v-model="form.enabled" type="checkbox" />启用</label>
        <div class="pickers">
          <NodePicker v-model="form.entry" label="前置" :api="api" /><NodePicker
            v-model="form.exit"
            label="出口"
            :api="api"
          />
        </div>
        <p>成员按所属订阅和精确名称更新；名称消失或重复时生成会报错，需要重新选择。</p>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="form = null">取消</button
        ><button form="chain-form" type="submit" class="primary" :disabled="busy">
          保存链
        </button></template
      ></ModalDialog
    >
    <ModalDialog v-if="deleting" label="删除两跳链" :dismissible="!busy" @close="deleting = null"
      ><h2>删除 {{ deleting.name }}</h2>
      <p>引用此链的输出方案将提示成员缺失，需要重新配置。</p>
      <template #footer
        ><button @click="deleting = null">取消</button
        ><button
          class="danger"
          :disabled="busy"
          @click="
            act(async () => {
              if (deleting) {
                await api('/api/chains/' + deleting.id, { revision: deleting.revision }, 'DELETE');
                deleting = null;
                await load();
              }
            })
          "
        >
          确认删除
        </button></template
      ></ModalDialog
    >
  </section>
</template>
<style scoped>
.chain-row {
  display: flex;
  gap: 20px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding: 18px 0;
}
.chain-row h2 {
  font-size: 17px;
}
.chain-row p {
  overflow-wrap: anywhere;
}
.actions,
.pagination {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.pagination {
  justify-content: flex-end;
  margin-top: 18px;
}
.chain-form {
  display: grid;
  gap: 14px;
}
.chain-form > label {
  display: flex;
  flex-direction: row;
  gap: 10px;
  align-items: center;
}
.chain-form > label input:not([type='checkbox']) {
  flex: 1;
  min-width: 0;
}
.pickers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 650px) {
  .chain-row {
    display: block;
  }
  .pickers {
    grid-template-columns: 1fr;
  }
  .actions {
    margin-top: 12px;
  }
}
</style>
