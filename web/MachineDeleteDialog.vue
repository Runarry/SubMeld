<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref } from 'vue';
import { z } from 'zod';
import {
  machineDeletionPreviewSchema,
  type MachineDeletionPreview,
} from '../server/shared/machines';
import { ApiError } from './api';
import { machineActionLabels, machineStatusLabels } from './machineActions';
import ModalDialog from './ui/ModalDialog.vue';

const props = defineProps<{
  machineId: string;
  machineName: string;
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const emit = defineEmits<{ close: []; deleted: [] }>();
const preview = ref<MachineDeletionPreview | null>(null);
const loading = ref(false),
  saving = ref(false),
  confirmed = ref(false);
const message = ref(''),
  loadError = ref(''),
  copyMessage = ref('');
const heading = ref<HTMLElement | null>(null),
  feedback = ref<HTMLElement | null>(null);
const commandInput = ref<HTMLTextAreaElement | null>(null);
const path = '/api/machines/' + encodeURIComponent(props.machineId);
const blocked = computed(() => !!preview.value?.blockers.length);
const mayDelete = computed(
  () => !!preview.value && !loading.value && !saving.value && !blocked.value && confirmed.value,
);
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const uninstallCommand = [
  '(',
  '  set -o pipefail',
  '  curl --fail --show-error --silent ' +
    shellQuote(location.origin + '/agent/install.sh') +
    ' | bash -s -- --uninstall',
  ')',
].join('\n');
const native = '/?api=' + encodeURIComponent(location.origin + '/upstream/sub-store');
const blockerLabels = {
  relay: '中转线路',
  collection: '组合订阅',
  plan: '输出方案',
};
function blockerLink(blocker: MachineDeletionPreview['blockers'][number]) {
  return blocker.kind === 'relay'
    ? '#/relays?route=' + encodeURIComponent(blocker.id)
    : blocker.kind === 'plan'
      ? '#/subscriptions'
      : native;
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : '无法完成请求，请稍后重试。';
}
let alive = true,
  requestId = 0;
let returnFocusTo: HTMLElement | null = null;
async function loadPreview() {
  const current = ++requestId;
  loading.value = true;
  loadError.value = '';
  preview.value = null;
  try {
    const value = z
      .object({ preview: machineDeletionPreviewSchema })
      .parse(await props.api(path + '/deletion-preview'));
    if (alive && current === requestId) preview.value = value.preview;
  } catch (error) {
    if (!alive || current !== requestId) return;
    if (error instanceof ApiError && error.status === 404 && error.code === 'MACHINE_NOT_FOUND')
      emit('deleted');
    else loadError.value = errorText(error);
  } finally {
    if (alive && current === requestId) loading.value = false;
  }
}
async function copyCommand() {
  copyMessage.value = '';
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(uninstallCommand);
      if (alive) copyMessage.value = '卸载命令已复制。';
      return;
    }
  } catch {
    // Keep the command selectable when clipboard permission is unavailable.
  }
  commandInput.value?.focus();
  commandInput.value?.select();
  try {
    if (document.execCommand('copy')) {
      copyMessage.value = '卸载命令已复制。';
      return;
    }
  } catch {
    // The selected command remains available for manual copying.
  }
  copyMessage.value = '请复制已选中的卸载命令。';
}
async function remove() {
  if (!mayDelete.value || !preview.value) return;
  saving.value = true;
  message.value = '';
  try {
    z.object({ deleted: z.literal(true) }).parse(
      await props.api(path, { revision: preview.value.revision, agentUninstalled: true }, 'DELETE'),
    );
    if (alive) emit('deleted');
  } catch (error) {
    if (!alive) return;
    message.value =
      error instanceof ApiError && error.status === 409
        ? '删除信息已变化：' + error.message + ' 已重新读取，请核对后再次确认删除。'
        : errorText(error);
    // A lost success response can leave the record already deleted. A missing preview
    // resolves that case without sending another destructive request.
    await loadPreview();
    if (alive) {
      await nextTick();
      feedback.value?.scrollIntoView({ block: 'nearest' });
      feedback.value?.focus({ preventScroll: true });
    }
  } finally {
    if (alive) saving.value = false;
  }
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const dialog = heading.value?.closest('[role="dialog"]');
  if (!dialog) return;
  const items = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary',
    ),
  ).filter((item) => item.getClientRects().length);
  const first = items[0],
    last = items.at(-1);
  if (!first) {
    event.preventDefault();
    heading.value?.focus();
  } else if (
    event.shiftKey &&
    [first, heading.value].includes(document.activeElement as HTMLElement)
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
onMounted(async () => {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  heading.value?.focus();
  await loadPreview();
});
onBeforeUnmount(() => {
  alive = false;
  requestId++;
});
onUnmounted(async () => {
  await nextTick();
  if (returnFocusTo?.isConnected && returnFocusTo.getClientRects().length)
    returnFocusTo.focus({ preventScroll: true });
});
</script>

<template>
  <ModalDialog
    label="删除机器"
    wide
    :dismissible="!saving"
    @close="emit('close')"
    @keydown="onKeydown"
  >
    <h2 ref="heading" tabindex="-1">删除机器</h2>
    <p class="machine-context">{{ preview?.machine.name || machineName }}</p>
    <p v-if="loading" role="status">正在核对删除范围与关联引用…</p>
    <template v-if="preview">
      <dl class="deletion-counts" aria-label="删除范围">
        <div>
          <dt>上报节点</dt>
          <dd>{{ preview.counts.nodes ?? '未知' }}</dd>
        </div>
        <div>
          <dt>机器订阅</dt>
          <dd>{{ preview.counts.subscriptions }}</dd>
        </div>
        <div>
          <dt>任务记录</dt>
          <dd>{{ preview.counts.tasks }}</dd>
        </div>
        <div>
          <dt>私有文件</dt>
          <dd>{{ preview.counts.files }}</dd>
        </div>
      </dl>
      <section v-if="blocked" class="deletion-section">
        <h3>先解除关联引用</h3>
        <p>请先处理以下引用，再卸载 Agent；卸载后将无法通过它清理机器上的中转资源。</p>
        <ul class="blocker-list">
          <li v-for="blocker in preview.blockers" :key="blocker.kind + '/' + blocker.id">
            <span
              ><small>{{ blockerLabels[blocker.kind] }}</small
              ><strong>{{ blocker.name }}</strong></span
            >
            <a
              :href="blockerLink(blocker)"
              target="_blank"
              rel="noopener"
              :aria-label="'处理' + blockerLabels[blocker.kind] + ' ' + blocker.name"
              >前往处理 ↗</a
            >
          </li>
        </ul>
        <p class="muted">处理完成后，点击“刷新删除预览”重新核对。</p>
      </section>
      <section v-else class="deletion-section">
        <h3>卸载 Agent</h3>
        <p>在这台机器上，以 root 在 Bash 中执行以下命令，确认卸载成功后再删除。</p>
        <label
          >Agent 卸载命令<textarea
            ref="commandInput"
            :value="uninstallCommand"
            aria-label="Agent 卸载命令"
            readonly
            rows="5"
            spellcheck="false"
          />
        </label>
        <button type="button" :disabled="saving" @click="copyCommand">复制卸载命令</button>
        <p v-if="copyMessage" role="status">{{ copyMessage }}</p>
        <p class="uninstall-note">
          卸载保留 vpsctl、代理节点、代理服务和 Agent 私有配置／状态。Agent 托管的隧道会停止。
        </p>
        <h3>确认清理面板数据</h3>
        <p>
          删除机器、生成的节点订阅、任务记录、命令文件及私有快照，并撤销对应分享与机器接入凭据。历史测速报告保留。
        </p>
        <label class="confirm-uninstall"
          ><input
            v-model="confirmed"
            type="checkbox"
            :disabled="saving"
            aria-label="我已卸载此机器的 Agent，或确认尚未安装"
          />我已卸载此机器的 Agent，或确认尚未安装</label
        >
      </section>
      <details v-if="preview.unfinishedTasks.length" class="pending-tasks" open>
        <summary>未完成或结果未知的任务（{{ preview.unfinishedTasks.length }}）</summary>
        <ul>
          <li v-for="task in preview.unfinishedTasks" :key="task.id">
            <strong
              >{{ machineActionLabels[task.action] || task.action }} ·
              {{ machineStatusLabels[task.status] }}</strong
            ><small>{{ task.id }}</small>
          </li>
        </ul>
        <p>确认卸载后，将停止后续下发并清理这些记录，不等待 Agent 回执。请先核对正在进行的操作。</p>
      </details>
    </template>
    <div
      v-if="message || loadError"
      ref="feedback"
      class="notice is-error"
      role="alert"
      tabindex="-1"
    >
      <p v-if="message">{{ message }}</p>
      <p v-if="loadError">{{ loadError }}</p>
    </div>
    <template #footer>
      <button type="button" :disabled="loading || saving" @click="loadPreview">刷新删除预览</button>
      <button type="button" :disabled="saving" @click="emit('close')">取消</button>
      <button type="button" class="danger" :disabled="!mayDelete" @click="remove">
        {{ saving ? '正在删除…' : '确认删除机器' }}
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
h2 {
  margin: 0;
  outline: none;
}
h3 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
}
p {
  font-size: var(--text-sm);
  line-height: var(--line-height);
}
.machine-context {
  margin-top: var(--space-2);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.deletion-counts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin: var(--space-5) 0;
}
.deletion-counts div {
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
}
dt,
small {
  color: var(--muted);
  font-size: var(--text-xs);
}
dd {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-strong);
}
.deletion-section {
  border-top: var(--border-width) solid var(--border);
  padding: var(--space-5) 0 0;
}
.deletion-section h3:not(:first-child) {
  margin-top: var(--space-6);
}
textarea {
  font-family: var(--mono);
  font-size: var(--text-xs);
  line-height: var(--line-height);
  resize: vertical;
  min-height: 110px;
}
.uninstall-note {
  padding: var(--space-3);
  background: var(--warn-bg);
  color: var(--warn-text);
  border-radius: var(--radius);
}
.confirm-uninstall {
  flex-direction: row;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  line-height: var(--line-height);
}
.confirm-uninstall input {
  flex-shrink: 0;
  margin-top: var(--space-1);
}
.blocker-list,
.pending-tasks ul {
  list-style: none;
  padding: 0;
  margin: var(--space-4) 0;
}
.blocker-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: var(--border-width) solid var(--border);
}
.blocker-list span {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  overflow-wrap: anywhere;
}
.blocker-list a {
  flex-shrink: 0;
  font-size: var(--text-sm);
}
.pending-tasks {
  margin: var(--space-5) 0 0;
  padding: var(--space-4);
  background: var(--warn-bg);
  color: var(--warn-text);
  border-radius: var(--radius);
}
.pending-tasks summary {
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
}
.pending-tasks li {
  display: grid;
  gap: var(--space-2);
  font-size: var(--text-sm);
  margin: var(--space-3) 0;
  overflow-wrap: anywhere;
}
.pending-tasks p {
  margin-bottom: 0;
}
@media (max-width: 480px) {
  .deletion-counts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
