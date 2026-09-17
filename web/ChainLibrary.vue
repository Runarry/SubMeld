<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError } from './api';
import ModalDialog from './ui/ModalDialog.vue';
import ListPagination from './ui/ListPagination.vue';
import StatusBadge from './ui/StatusBadge.vue';
import {
  chainConfigSchema,
  chainListSchema,
  chainSchema,
  type Chain,
  type ChainConfig,
} from '../server/shared/chains';
import { nodeListSchema, type NodeSummary } from '../server/shared/contracts';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  refreshKey: number;
  disabled: boolean;
}>();
const rows = ref<Chain[]>([]),
  page = ref(0),
  total = ref(0),
  busy = ref(false),
  message = ref('');
const form = ref<ChainConfig | null>(null),
  baseline = ref<Chain | null>(null),
  conflict = ref(false);
const nodePage = ref(0),
  nodeTotal = ref(0),
  candidates = ref<NodeSummary[]>([]);
const known = ref<Record<string, NodeSummary>>({});
const locked = computed(() => busy.value || props.disabled);
const options = computed(() => {
  const values = new Map(candidates.value.map((node) => [node.id, node]));
  for (const id of [form.value?.entryNodeId, form.value?.exitNodeId])
    if (id && known.value[id]) values.set(id, known.value[id]);
  return [...values.values()];
});
const pathText = computed(
  () =>
    '本机 → ' +
    (known.value[form.value?.entryNodeId ?? '']?.name ?? '前置代理') +
    ' → ' +
    (known.value[form.value?.exitNodeId ?? '']?.name ?? '出口代理') +
    ' → 目标',
);
let alive = true,
  epoch = 0,
  listTicket = 0;
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  listTicket++;
});
async function act(action: () => Promise<void>) {
  if (locked.value) return;
  busy.value = true;
  message.value = '';
  try {
    await action();
  } catch (error) {
    if (!alive) return;
    message.value = error instanceof Error ? error.message : '操作失败。';
    if (error instanceof ApiError && error.status === 409) conflict.value = true;
  } finally {
    if (alive) busy.value = false;
  }
}
async function refresh() {
  const ticket = ++listTicket;
  const result = chainListSchema.parse(await props.api('/api/chains?page=' + page.value));
  if (!alive || ticket !== listTicket) return;
  rows.value = result.chains;
  total.value = result.total;
  if (!rows.value.length && page.value) {
    page.value--;
    await refresh();
  }
}
async function loadCandidates() {
  const current = epoch;
  const result = nodeListSchema.parse(await props.api('/api/nodes?page=' + nodePage.value));
  if (!alive || current !== epoch) return;
  candidates.value = result.nodes;
  nodeTotal.value = result.total;
  for (const node of result.nodes) known.value[node.id] = node;
}
function close() {
  epoch++;
  form.value = null;
  baseline.value = null;
  conflict.value = false;
}
async function startNew() {
  await act(async () => {
    epoch++;
    baseline.value = null;
    conflict.value = false;
    form.value = { name: '', enabled: true, entryNodeId: '', exitNodeId: '' };
    nodePage.value = 0;
    await loadCandidates();
  });
}
async function edit(id: string) {
  await act(async () => {
    const current = ++epoch;
    const chain = chainSchema.parse(await props.api('/api/chains/' + id));
    if (!alive || current !== epoch) return;
    baseline.value = chain;
    form.value = chainConfigSchema.strip().parse(chain);
    known.value[chain.entry.id] = chain.entry;
    known.value[chain.exit.id] = chain.exit;
    conflict.value = false;
    nodePage.value = 0;
    await loadCandidates();
  });
}
async function save() {
  await act(async () => {
    if (!form.value) return;
    if (!form.value.name.trim() || !form.value.entryNodeId || !form.value.exitNodeId)
      throw new Error('请填写链名称，并选择前置代理和出口代理。');
    if (form.value.entryNodeId === form.value.exitNodeId)
      throw new Error('前置代理和出口代理必须是不同的本地节点。');
    const current = epoch;
    const result = chainSchema.parse(
      await props.api(
        baseline.value ? '/api/chains/' + baseline.value.id : '/api/chains',
        baseline.value ? { ...form.value, revision: baseline.value.revision } : form.value,
        baseline.value ? 'PATCH' : 'POST',
      ),
    );
    if (!alive || current !== epoch) return;
    baseline.value = result;
    form.value = chainConfigSchema.strip().parse(result);
    known.value[result.entry.id] = result.entry;
    known.value[result.exit.id] = result.exit;
    conflict.value = false;
    await refresh();
    message.value = '链式代理已保存，可在订阅方案中添加；关联订阅已安排更新。';
  });
}
async function toggle(chain: Chain) {
  await act(async () => {
    await props.api(
      '/api/chains/' + chain.id,
      { revision: chain.revision, enabled: !chain.enabled },
      'PATCH',
    );
    if (!alive) return;
    await refresh();
    message.value = '启用状态已更新，关联订阅旧产物已失效。';
  });
}
async function remove(chain: Chain) {
  if (!window.confirm('删除此链式代理？关联方案将移除此链，两条本地节点会保留。')) return;
  await act(async () => {
    await props.api('/api/chains/' + chain.id, { revision: chain.revision }, 'DELETE');
    if (!alive) return;
    await refresh();
    message.value = '链式代理已删除。';
  });
}
function swap() {
  if (form.value)
    [form.value.entryNodeId, form.value.exitNodeId] = [
      form.value.exitNodeId,
      form.value.entryNodeId,
    ];
}
watch(
  () => props.refreshKey,
  () => {
    void refresh().catch(() => {
      if (alive) message.value = '链式代理列表刷新失败，请重试。';
    });
  },
);
onMounted(() => {
  void refresh().catch(() => {
    if (alive) message.value = '链式代理列表加载失败，请重试。';
  });
});
</script>

<template>
  <section class="chain-library" aria-label="链式代理管理">
    <div class="page-header">
      <div>
        <h2>链式代理</h2>
        <p class="muted">将两个本地节点组合为一条两跳链，再加入订阅方案。原节点修改会同步生效。</p>
      </div>
      <div class="toolbar">
        <button type="button" :disabled="locked" @click="act(refresh)">刷新链式代理</button>
        <button type="button" class="primary" :disabled="locked" @click="startNew">
          新建链式代理
        </button>
      </div>
    </div>
    <p v-if="message && !form" role="status" class="notice">{{ message }}</p>
    <p v-if="!rows.length" class="empty-state">还没有链式代理。</p>
    <ul v-else class="library-list">
      <li v-for="chain in rows" :key="chain.id">
        <span class="node-name"
          >{{ chain.name }}
          <small>本机 → {{ chain.entry.name }} → {{ chain.exit.name }} → 目标</small>
          <small
            >版本 {{ chain.revision }}
            <StatusBadge
              :tone="!chain.enabled ? 'off' : chain.available ? 'ok' : 'error'"
              :label="!chain.enabled ? '禁用' : chain.available ? '启用' : '成员已停用'"
            />
          </small>
        </span>
        <div class="toolbar">
          <button type="button" :disabled="locked" @click="edit(chain.id)">编辑链</button>
          <button type="button" :disabled="locked" @click="toggle(chain)">
            {{ chain.enabled ? '禁用链' : '启用链' }}
          </button>
          <button type="button" class="danger linkish" :disabled="locked" @click="remove(chain)">
            删除链
          </button>
        </div>
      </li>
    </ul>
    <ListPagination
      :page="page"
      :total="total"
      :disabled="locked"
      prev-label="上一页链"
      next-label="下一页链"
      @turn="
        (delta) =>
          act(async () => {
            page += delta;
            await refresh();
          })
      "
    />
    <ModalDialog
      v-if="form"
      :label="baseline ? '编辑链式代理' : '新建链式代理'"
      :dismissible="!locked"
      @close="close"
    >
      <fieldset :disabled="locked" class="library-editor">
        <legend>{{ baseline ? '编辑链式代理' : '新建链式代理' }}</legend>
        <p v-if="message" role="status" class="notice">{{ message }}</p>
        <p v-if="conflict" class="warning-note">
          服务器已有更新，当前编辑已保留。重新载入会替换未保存内容。
        </p>
        <button v-if="conflict && baseline" type="button" @click="edit(baseline.id)">
          重新载入链版本
        </button>
        <label>链名称<input v-model="form.name" maxlength="512" /></label>
        <label class="check-label"
          ><input v-model="form.enabled" type="checkbox" />启用链式代理</label
        >
        <div class="field-pair">
          <label
            >前置代理<select v-model="form.entryNodeId" aria-label="前置代理">
              <option value="">请选择前置节点</option>
              <option v-for="node in options" :key="node.id" :value="node.id">
                {{ node.name }} · {{ node.protocol.toUpperCase()
                }}{{ node.enabled ? '' : '（已停用）' }}
              </option>
            </select></label
          >
          <label
            >出口代理<select v-model="form.exitNodeId" aria-label="出口代理">
              <option value="">请选择出口节点</option>
              <option v-for="node in options" :key="node.id" :value="node.id">
                {{ node.name }} · {{ node.protocol.toUpperCase()
                }}{{ node.enabled ? '' : '（已停用）' }}
              </option>
            </select></label
          >
        </div>
        <ListPagination
          :page="nodePage"
          :total="nodeTotal"
          :disabled="locked"
          prev-label="上一页候选节点"
          next-label="下一页候选节点"
          @turn="
            (delta) =>
              act(async () => {
                nodePage += delta;
                await loadCandidates();
              })
          "
        />
        <div class="toolbar">
          <button type="button" @click="swap">交换两跳顺序</button>
          <button type="button" @click="act(loadCandidates)">刷新候选节点</button>
        </div>
        <p class="chain-path">{{ pathText }}</p>
        <p v-if="!nodeTotal" class="warning-note">
          请先保存两个本地节点。来源中的节点可先复制到本地。
        </p>
        <p
          v-if="
            (form.entryNodeId && !known[form.entryNodeId]?.enabled) ||
            (form.exitNodeId && !known[form.exitNodeId]?.enabled)
          "
          class="warning-note"
        >
          所选成员已停用，启用该成员后链才能生成。
        </p>
        <p class="muted">链式代理只提供 Mihomo、sing-box、Xray 配置；URI／Base64 明确排除此链。</p>
      </fieldset>
      <template #footer>
        <button type="button" class="primary" :disabled="locked" @click="save">保存链式代理</button>
        <button type="button" :disabled="locked" @click="close">关闭链编辑</button>
      </template>
    </ModalDialog>
  </section>
</template>
