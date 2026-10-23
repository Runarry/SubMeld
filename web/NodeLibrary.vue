<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  nodeListSchema,
  nodeDetailsSchema,
  nodeRefSchema,
  resourceSchema,
  type NodeView,
  type Resource,
} from '../server/shared/resources';
import type { TestSubject } from '../server/shared/node-tests';
import { useNodeTests } from './nodeTests';
import NodeTestSummary from './NodeTestSummary.vue';
import ModalDialog from './ui/ModalDialog.vue';
import NodeReportingSettings from './NodeReportingSettings.vue';
import { machineViewSchema, type MachineView } from '../server/shared/machines';
import { z } from 'zod';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const nodes = ref<NodeView[]>([]),
  resources = ref<Resource[]>([]),
  selected = ref<string[]>([]),
  page = ref(0),
  total = ref(0),
  resourceId = ref(''),
  search = ref(''),
  busy = ref(false),
  message = ref(''),
  errors = ref<string[]>([]);
const form = ref<{ name: string; source: 'local' | 'remote'; content: string; url: string } | null>(
  null,
);
const detail = ref<ReturnType<typeof nodeDetailsSchema.parse> | null>(null),
  deleting = ref<NodeView[] | null>(null);
const reporting = ref(false);
const machines = ref<MachineView[]>([]);
const owner = (id: string) => machines.value.find((machine) => machine.resourceId === id);
const machineLink = (id: string) => '#/machines?machine=' + encodeURIComponent(id) + '&tab=nodes';
function readLocation() {
  const query = new URLSearchParams(location.hash.split('?')[1]);
  resourceId.value = query.get('resource') ?? '';
  search.value = query.get('search') ?? '';
  const value = Number(query.get('page') ?? 0);
  page.value = Number.isInteger(value) && value >= 0 ? value : 0;
}
readLocation();
function locationChanged() {
  if (!/^#\/?nodes(?:\?|$)/.test(location.hash)) return;
  ticket++;
  readLocation();
  selected.value = [];
  message.value = '';
  errors.value = [];
  if (busy.value) {
    reloadPending = true;
    return;
  }
  void act(() => load());
}
const native = '/?api=' + encodeURIComponent(location.origin + '/upstream/sub-store');
const key = (node: NodeView) => node.resourceId + ':' + node.nodeIndex;
const nodeRef = (node: NodeView) =>
  nodeRefSchema.parse({
    resourceId: node.resourceId,
    revision: node.revision,
    snapshotHash: node.snapshotHash,
    nodeIndex: node.nodeIndex,
  });
const subject = (node: NodeView): TestSubject => ({ kind: 'node', ...nodeRef(node) });
const testing = useNodeTests(() => nodes.value.filter((n) => n.testable).map(subject), props.api);
const chosen = computed(() => nodes.value.filter((n) => selected.value.includes(key(n))));
let alive = true,
  ticket = 0,
  reloadPending = false;
onBeforeUnmount(() => {
  alive = false;
  ticket++;
  window.removeEventListener('hashchange', locationChanged);
});
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await action();
  } catch (e) {
    if (alive && !reloadPending) message.value = e instanceof Error ? e.message : '操作失败。';
  } finally {
    if (alive) {
      busy.value = false;
      if (reloadPending) {
        reloadPending = false;
        void act(() => load());
      }
    }
  }
}
async function load(force = false) {
  const current = ++ticket;
  const requested = { page: page.value, resourceId: resourceId.value, search: search.value };
  const result = nodeListSchema.parse(
    await props.api(
      '/api/nodes?page=' +
        requested.page +
        '&resourceId=' +
        encodeURIComponent(requested.resourceId) +
        '&search=' +
        encodeURIComponent(requested.search) +
        (force ? '&refresh=1' : ''),
    ),
  );
  if (!alive || current !== ticket) return;
  nodes.value = result.nodes;
  resources.value = result.resources;
  total.value = result.total;
  errors.value = result.errors.map((e) => e.message);
  selected.value = [];
  const query = new URLSearchParams();
  if (requested.resourceId) query.set('resource', requested.resourceId);
  if (requested.search) query.set('search', requested.search);
  if (requested.page) query.set('page', String(requested.page));
  history.replaceState(null, '', '#/nodes' + (query.size ? '?' + query : ''));
  if (!nodes.value.length && requested.page) {
    page.value = requested.page - 1;
    await load(force);
  }
}
async function save() {
  if (!form.value) return;
  const saved = resourceSchema.parse(await props.api('/api/nodes', form.value));
  if (!alive) return;
  form.value = null;
  if (reloadPending) return;
  resourceId.value = saved.id;
  page.value = 0;
  search.value = '';
  await load();
  if (alive && !reloadPending) message.value = '已保存到 Sub-Store。';
}
async function remove() {
  if (!deleting.value) return;
  await props.api('/api/nodes/delete', { nodes: deleting.value.map(nodeRef) });
  if (!alive) return;
  deleting.value = null;
  if (reloadPending) return;
  await load();
  if (alive && !reloadPending) message.value = '删除操作已保存到 Sub-Store。';
}
onMounted(() => {
  window.addEventListener('hashchange', locationChanged);
  void act(() => load());
  void props
    .api('/api/machines')
    .then((value) => {
      if (alive)
        machines.value = z.object({ machines: machineViewSchema.array() }).parse(value).machines;
    })
    .catch(() => {
      /* Node viewing remains available when machine summaries cannot load. */
    });
});
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>节点</h1>
        <p>查看 Sub-Store 中的全部订阅节点，直接添加、删除或测试。</p>
      </div>
      <div class="actions">
        <button :disabled="busy" @click="reporting = true">上报设置</button>
        <a :href="native">在 Sub-Store 中编辑</a
        ><button
          class="primary"
          :disabled="busy"
          @click="form = { name: '', source: 'local', content: '', url: '' }"
        >
          添加节点或订阅
        </button>
      </div>
    </header>
    <div class="panel filters">
      <label
        >所属订阅
        <select
          v-model="resourceId"
          :disabled="busy"
          @change="
            page = 0;
            act(() => load());
          "
        >
          <option value="">全部订阅（不重复计入组合）</option>
          <option v-for="r in resources" :key="r.id" :value="r.id">
            {{ r.name }}{{ r.type === 'collection' ? '（组合预览）' : '' }}
          </option>
        </select></label
      ><input
        v-model="search"
        aria-label="搜索节点"
        placeholder="搜索名称、协议、订阅"
        :disabled="busy"
        @keydown.enter.prevent="
          page = 0;
          act(() => load());
        "
      /><button
        :disabled="busy"
        @click="
          page = 0;
          act(() => load());
        "
      >
        搜索</button
      ><button :disabled="busy" @click="act(() => load(true))">刷新上游</button>
    </div>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <p v-for="(error, i) in errors" :key="i" role="alert">{{ error }}</p>
    <p v-if="testing.error" role="alert">{{ testing.error }}</p>
    <div class="selection-bar">
      <span>{{ total }} 个节点 · 已选 {{ chosen.length }}</span
      ><button
        :disabled="!chosen.length || testing.starting"
        @click="testing.start(chosen.map(subject))"
      >
        测试所选</button
      ><button
        :disabled="!chosen.length || busy || chosen.some((n) => n.deletion === 'unavailable')"
        class="danger"
        @click="deleting = chosen"
      >
        删除所选
      </button>
    </div>
    <div class="panel node-list">
      <p v-if="busy && !nodes.length" role="status">正在读取 Sub-Store…</p>
      <p v-else-if="!nodes.length">当前没有节点。可添加订阅地址或粘贴节点文本。</p>
      <article v-for="node in nodes" :key="key(node)" class="node-row">
        <input
          v-model="selected"
          type="checkbox"
          :value="key(node)"
          :aria-label="'选择 ' + node.name"
        />
        <div class="node-main">
          <strong>{{ node.name }}</strong>
          <p class="muted">
            {{ node.protocol }} · {{ node.resourceName
            }}{{ node.available ? '' : ' · 已被处理规则排除' }}
          </p>
          <a
            v-if="owner(node.resourceId)"
            class="machine-origin"
            :href="machineLink(owner(node.resourceId)!.id)"
            >管理机器 · {{ owner(node.resourceId)!.name }} ↗</a
          >
          <p v-if="!node.testable" class="muted">
            三内核检查：{{ node.testReason }} 综合测试将按 miaospeed 能力检查。
          </p>
          <NodeTestSummary
            :results="testing.forSubject(subject(node))"
            @show="testing.show([subject(node)])"
          />
        </div>
        <div class="row-actions">
          <button
            :disabled="busy"
            @click="
              act(async () => {
                const result = nodeDetailsSchema.parse(
                  await api('/api/nodes/detail', nodeRef(node)),
                );
                if (alive && !reloadPending) detail = result;
              })
            "
          >
            查看</button
          ><button :disabled="testing.starting" @click="testing.start([subject(node)])">测试</button
          ><button
            :disabled="busy || node.deletion === 'unavailable'"
            class="danger"
            @click="deleting = [node]"
          >
            删除
          </button>
        </div>
      </article>
    </div>
    <div class="pagination">
      <button
        :disabled="busy || page === 0"
        @click="
          page--;
          act(() => load());
        "
      >
        上一页</button
      ><span>第 {{ page + 1 }} 页</span
      ><button
        :disabled="busy || (page + 1) * 25 >= total"
        @click="
          page++;
          act(() => load());
        "
      >
        下一页
      </button>
    </div>
    <NodeReportingSettings v-if="reporting" :api="api" @close="reporting = false" />
    <ModalDialog v-if="form" label="添加节点或订阅" :dismissible="!busy" @close="form = null"
      ><h2>添加节点或订阅</h2>
      <form id="add-resource" class="node-form" @submit.prevent="act(save)">
        <label>订阅名称<input v-model="form.name" required maxlength="512" /></label
        ><label
          >添加方式<select v-model="form.source">
            <option value="local">粘贴节点文本</option>
            <option value="remote">订阅地址</option>
          </select></label
        ><label v-if="form.source === 'local'"
          >节点文本<textarea
            v-model="form.content"
            rows="10"
            required
            placeholder="粘贴一个或多个 URI、JSON 或 YAML 节点"
          /></label
        ><label v-else
          >订阅地址<textarea
            v-model="form.url"
            rows="5"
            required
            placeholder="每行一个 HTTP(S) 订阅地址"
          />
        </label>
        <p>保存后可在 Sub-Store 原生页面编辑内容和处理规则。</p>
        <p v-if="message" role="alert">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="form = null">取消</button
        ><button form="add-resource" type="submit" class="primary" :disabled="busy">
          保存到 Sub-Store
        </button></template
      ></ModalDialog
    >
    <ModalDialog v-if="detail" label="节点详情" wide @close="detail = null"
      ><h2>{{ detail.name }}</h2>
      <p>{{ detail.resourceName }} · {{ detail.protocol }}</p>
      <dl class="connection-summary">
        <template
          v-for="[field, label] in [
            ['server', '连接地址'],
            ['port', '端口'],
            ['sni', '服务器名称 SNI'],
            ['network', '传输方式'],
            ['cipher', '加密方式'],
          ]"
          :key="field"
        >
          <template v-if="field && detail.processed?.[field] !== undefined"
            ><dt>{{ label }}</dt>
            <dd>{{ detail.processed?.[field] }}</dd></template
          >
        </template>
      </dl>
      <p v-if="owner(detail.resourceId)">
        <a :href="machineLink(owner(detail.resourceId)!.id)"
          >前往 {{ owner(detail.resourceId)!.name }} 查看和编辑机器节点 →</a
        >
      </p>
      <details>
        <summary>处理后完整配置</summary>
        <pre>{{ JSON.stringify(detail.processed, null, 2) }}</pre>
      </details>
      <details>
        <summary>原始节点配置</summary>
        <pre>{{ JSON.stringify(detail.original, null, 2) }}</pre>
      </details>
      <template #footer
        ><a :href="native">打开 Sub-Store 编辑</a
        ><button @click="detail = null">关闭</button></template
      ></ModalDialog
    >
    <ModalDialog v-if="deleting" label="删除节点" :dismissible="!busy" @close="deleting = null"
      ><h2>删除 {{ deleting.length }} 个节点</h2>
      <p>
        手动导入的节点会从保存内容中实际移除；远程或脚本生成的节点会通过精确名称规则排除。远程节点改名后需要重新设置排除规则。
      </p>
      <p v-if="resourceId && resources.find((r) => r.id === resourceId)?.type === 'collection'">
        此次排除只影响当前组合订阅。
      </p>
      <p v-if="message" role="alert">{{ message }}</p>
      <template #footer
        ><button :disabled="busy" @click="deleting = null">取消</button
        ><button class="danger" :disabled="busy" @click="act(remove)">确认删除</button></template
      ></ModalDialog
    >
  </section>
</template>
<style scoped>
.machine-origin {
  font-size: var(--text-xs);
  color: var(--primary);
}
.connection-summary {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--bg);
  border-radius: var(--radius);
  overflow-wrap: anywhere;
}
.connection-summary dd {
  margin: 0;
}
details {
  margin-block: var(--space-4);
}
summary {
  cursor: pointer;
  color: var(--muted);
}
.filters,
.selection-bar,
.row-actions,
.actions,
.pagination {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
}
.filters {
  flex-direction: row;
  align-items: flex-end;
  margin-bottom: var(--space-4);
}
.filters label {
  display: grid;
  flex: 0 1 240px;
  gap: var(--space-2);
  text-align: left;
  max-width: 100%;
}
.filters > input {
  flex: 1 1 260px;
  min-width: 0;
  width: auto;
}
.filters select {
  max-width: 100%;
}
.selection-bar {
  margin: var(--space-4) 0;
}
.node-list {
  padding: 0 var(--space-4);
  max-height: none;
}
.node-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-4) 0;
  border: 0;
  border-bottom: var(--border-width) solid var(--border);
  border-radius: 0;
  margin: 0;
}
.node-row:last-child {
  border: 0;
}
.node-main {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.node-main p {
  margin: var(--space-1) 0;
}
.node-form {
  display: grid;
  gap: var(--space-4);
}
.node-form label {
  display: grid;
  gap: var(--space-2);
}
.node-form textarea,
.node-form input,
.node-form select {
  width: 100%;
  min-width: 0;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
.pagination {
  justify-content: flex-end;
  margin-top: var(--space-5);
}
@media (max-width: 650px) {
  .node-row {
    flex-wrap: wrap;
  }
  .node-main {
    flex-basis: 80%;
  }
  .row-actions {
    margin-left: var(--space-7);
  }
  .filters label {
    display: grid;
    flex-basis: 100%;
    width: 100%;
  }
  .filters input {
    flex-basis: 100%;
    width: 100%;
  }
}
</style>
