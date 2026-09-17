<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import NodeEditor from './NodeEditor.vue';
import ChainLibrary from './ChainLibrary.vue';
import NodeImport from './NodeImport.vue';
import ListPagination from './ui/ListPagination.vue';
import ModalDialog from './ui/ModalDialog.vue';
import StatusBadge from './ui/StatusBadge.vue';
import { ApiError } from './api';
import {
  blankDraft,
  protocols,
  nodeListSchema,
  storedNodeSchema,
  loadedNodesSchema,
  updateNodeSchema,
  type NodeSummary,
  type StoredNode,
  type NodeDraft,
  type Protocol,
  type WorkbenchItem,
} from '../server/shared/contracts';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const emit = defineEmits<{ load: [items: WorkbenchItem[]] }>();
const rows = ref<NodeSummary[]>([]),
  total = ref(0),
  page = ref(0),
  selected = ref<string[]>([]);
const busy = ref(false),
  message = ref(''),
  conflict = ref(false);
const draft = ref<NodeDraft | null>(null),
  baseline = ref<StoredNode | null>(null),
  newProtocol = ref<Protocol>('vless');
const chainRefresh = ref(0);
const importing = ref(false),
  importSaving = ref(false);
const locked = computed(() => busy.value || importSaving.value);
const cleared = new Set<string>();
async function imported(count: number) {
  busy.value = true;
  selected.value = [];
  try {
    page.value = 0;
    await refresh();
    page.value = Math.max(0, Math.ceil(total.value / 25) - 1);
    if (page.value) await refresh();
    message.value = '已添加 ' + count + ' 个本地节点，已定位到最后一页。';
  } catch {
    message.value = '已添加 ' + count + ' 个本地节点，但列表刷新失败，请点击刷新列表。';
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  const result = nodeListSchema.parse(await props.api('/api/nodes?page=' + page.value));
  rows.value = result.nodes;
  total.value = result.total;
  chainRefresh.value++;
  selected.value = selected.value.filter((id) => rows.value.some((n) => n.id === id && n.enabled));
}
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await action();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) conflict.value = true;
    message.value = error instanceof Error ? error.message : '操作失败，请重试。';
  } finally {
    busy.value = false;
  }
}
function startNew() {
  baseline.value = null;
  draft.value = blankDraft(newProtocol.value);
  cleared.clear();
  conflict.value = false;
  message.value = '';
}
async function edit(id: string) {
  await act(async () => {
    const node = storedNodeSchema.parse(await props.api('/api/nodes/' + id));
    baseline.value = node;
    draft.value = JSON.parse(JSON.stringify(node.draft));
    cleared.clear();
    conflict.value = false;
  });
}
function differences(current: object, original: object) {
  const previous = new Map(Object.entries(original));
  return Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(previous.get(key)),
    ),
  );
}
async function save() {
  await act(async () => {
    if (!draft.value) return;
    if (!baseline.value) {
      await props.api('/api/nodes', { drafts: [draft.value] });
      draft.value = null;
    } else {
      const before = baseline.value.draft,
        current = draft.value;
      const changes: Record<string, unknown> = {};
      for (const key of ['name', 'server', 'port'] as const)
        if (current[key] !== before[key]) changes[key] = current[key];
      for (const key of ['tls', 'transport', 'auth', 'protocolOptions'] as const) {
        const diff = differences(current[key], before[key]);
        for (const field of key === 'auth'
          ? ['uuid', 'password']
          : key === 'protocolOptions'
            ? ['obfsPassword']
            : []) {
          if (diff[field] === '') {
            if (!cleared.has(key + '.' + field))
              throw new Error('清空认证信息请使用字段旁的“清空”按钮。');
            diff[field] = null;
          }
        }
        if (Object.keys(diff).length) changes[key] = diff;
      }
      const input = updateNodeSchema.parse({ revision: baseline.value.revision, changes });
      const result = storedNodeSchema.parse(
        await props.api('/api/nodes/' + baseline.value.id, input, 'PATCH'),
      );
      baseline.value = result;
      draft.value = JSON.parse(JSON.stringify(result.draft));
      cleared.clear();
      conflict.value = false;
    }
    await refresh();
    message.value = '节点已保存，相关订阅已安排更新。';
  });
}
async function toggle(node: NodeSummary) {
  await act(async () => {
    await props.api(
      '/api/nodes/' + node.id,
      { revision: node.revision, enabled: !node.enabled },
      'PATCH',
    );
    await refresh();
    message.value = node.enabled
      ? '节点已禁用，相关订阅旧产物已失效。工作台中的独立副本不受影响。'
      : '节点已启用。';
  });
}
async function remove(node: NodeSummary) {
  if (
    !window.confirm(
      '删除这个本地节点？被链式代理引用的节点须先解除引用；关联方案会移除此输入并重新生成。',
    )
  )
    return;
  await act(async () => {
    await props.api('/api/nodes/' + node.id, { revision: node.revision }, 'DELETE');
    if (baseline.value?.id === node.id) {
      baseline.value = null;
      draft.value = null;
    }
    if (rows.value.length === 1 && page.value > 0) page.value--;
    await refresh();
    message.value = '节点已删除。';
  });
}
async function load() {
  await act(async () => {
    const result = loadedNodesSchema.parse(
      await props.api('/api/nodes/load', {
        ids: rows.value.filter((n) => selected.value.includes(n.id)).map((n) => n.id),
      }),
    );
    emit('load', result.items);
    message.value = '已请求将所选节点追加到工作台。';
  });
}
async function turnPage(delta: number) {
  await act(async () => {
    page.value += delta;
    selected.value = [];
    await refresh();
  });
}
onMounted(() => void act(refresh));
</script>
<template>
  <section class="library" aria-label="本地节点库">
    <div class="page-header">
      <div>
        <h1>本地节点</h1>
        <p class="muted">明确保存的节点会在重启后保留。载入工作台后作为独立副本编辑。</p>
      </div>
      <button type="button" :disabled="locked" @click="act(refresh)">刷新列表</button>
    </div>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <div class="toolbar">
      <label
        >新建协议<select v-model="newProtocol" :disabled="locked">
          <option v-for="p in protocols" :key="p" :value="p">{{ p.toUpperCase() }}</option>
        </select></label
      >
      <button type="button" class="primary" :disabled="locked" @click="startNew">
        新建本地节点
      </button>
      <button
        type="button"
        :disabled="locked"
        :aria-expanded="importing"
        @click="importing = !importing"
      >
        导入节点
      </button>
      <button type="button" :disabled="locked || !selected.length" @click="load">
        载入所选到工作台
      </button>
    </div>
    <div class="library-main">
      <p v-if="!rows.length" class="empty-state">
        还没有本地节点。可直接导入、手动新建，或从工作台选择后另存。
      </p>
      <ul v-else class="library-list">
        <li v-for="node in rows" :key="node.id" @click="edit(node.id)">
          <label class="check-label" @click.stop
            ><input
              v-model="selected"
              type="checkbox"
              :value="node.id"
              :disabled="locked || !node.enabled"
              :aria-label="'选择本地节点 ' + node.name"
            />
            <span class="node-name"
              >{{ node.name
              }}<small
                >{{ node.protocol.toUpperCase() }} · 版本 {{ node.revision }}
                <StatusBadge
                  :tone="node.enabled ? 'ok' : 'off'"
                  :label="node.enabled ? '启用' : '禁用'" /></small
            ></span>
          </label>
          <div class="toolbar" @click.stop>
            <button type="button" :disabled="locked" @click="edit(node.id)">编辑</button
            ><button type="button" :disabled="locked" @click="toggle(node)">
              {{ node.enabled ? '禁用' : '启用' }}</button
            ><button type="button" class="danger linkish" :disabled="locked" @click="remove(node)">
              删除
            </button>
          </div>
        </li>
      </ul>
      <ListPagination :page="page" :total="total" :disabled="locked" @turn="turnPage" />
    </div>
    <ChainLibrary :api="api" :refresh-key="chainRefresh" :disabled="locked" />
    <ModalDialog
      v-if="draft"
      :label="baseline ? '编辑本地节点' : '新建本地节点'"
      :dismissible="!locked"
      @close="
        draft = null;
        baseline = null;
      "
    >
      <fieldset :disabled="locked" class="library-editor">
        <legend>{{ baseline ? '编辑本地节点' : '新建本地节点' }}</legend>
        <p v-if="conflict" class="warning-note">
          服务器已有更新。当前编辑已保留；重新载入会替换这些未保存内容。
        </p>
        <button v-if="conflict && baseline" type="button" @click="edit(baseline.id)">
          重新载入服务器版本
        </button>
        <NodeEditor v-model="draft" :persisted="!!baseline" @clear-secret="cleared.add($event)" />
      </fieldset>
      <template #footer>
        <button type="button" class="primary" :disabled="locked" @click="save">保存本地节点</button>
        <button
          type="button"
          :disabled="locked"
          @click="
            draft = null;
            baseline = null;
          "
        >
          关闭编辑
        </button>
      </template>
    </ModalDialog>
    <ModalDialog
      v-if="importing"
      label="导入节点"
      wide
      elevated
      :dismissible="!importSaving && !busy"
      @close="importing = false"
    >
      <NodeImport
        :api="api"
        :disabled="busy"
        @close="importing = false"
        @saving="importSaving = $event"
        @saved="imported"
      />
    </ModalDialog>
  </section>
</template>
