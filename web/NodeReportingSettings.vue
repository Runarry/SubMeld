<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  nodeReportingSettingsSchema,
  nodeReportingTokenSchema,
  type NodeReportingSettings,
} from '../server/shared/node-reporting';
import ModalDialog from './ui/ModalDialog.vue';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const emit = defineEmits<{ close: [] }>();
const settings = ref<NodeReportingSettings | null>(null),
  enabled = ref(false),
  token = ref(''),
  busy = ref(false),
  message = ref(''),
  tokenInput = ref<HTMLInputElement | null>(null);
const endpoint = location.origin + '/api/node-reports/<machineId>';
const example = computed(() =>
  [
    'curl --fail-with-body --request PUT \\',
    '  "' + location.origin + '/api/node-reports/$MACHINE_ID" \\',
    '  --header "Authorization: Bearer $REPORT_TOKEN" \\',
    '  --header "Content-Type: application/json" \\',
    '  --data-binary @report.json',
  ].join('\n'),
);
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  token.value = '';
});
async function act(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await fn();
  } catch (error) {
    if (alive) message.value = error instanceof Error ? error.message : '操作失败。';
  } finally {
    if (alive) busy.value = false;
  }
}
async function load() {
  const value = nodeReportingSettingsSchema.parse(
    await props.api('/api/integrations/node-reporting'),
  );
  if (!alive) return;
  settings.value = value;
  enabled.value = value.enabled;
}
async function save() {
  const value = nodeReportingSettingsSchema.parse(
    await props.api('/api/integrations/node-reporting', { enabled: enabled.value }, 'PATCH'),
  );
  if (!alive) return;
  settings.value = value;
  enabled.value = value.enabled;
  message.value = value.enabled ? '已启用节点上报。' : '已停用节点上报，现有节点继续保留。';
}
async function rotate() {
  const value = nodeReportingTokenSchema.parse(
    await props.api('/api/integrations/node-reporting/token', {}),
  );
  if (!alive) return;
  settings.value = nodeReportingSettingsSchema.parse(value);
  token.value = value.token;
  message.value = 'Token 仅本次显示，请复制并保存到上报机器。旧 Token 已失效。';
}
async function copyToken() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(token.value);
      if (alive) message.value = '已复制上报 Token。';
      return;
    }
  } catch {
    // Keep a selectable field available when the browser denies clipboard access.
  }
  if (!alive) return;
  tokenInput.value?.focus();
  tokenInput.value?.select();
  try {
    if (document.execCommand('copy')) {
      message.value = '已复制上报 Token。';
      return;
    }
  } catch {
    // HTTP deployments can still copy the selected token manually.
  }
  message.value = '无法自动复制，请从上报 Token 输入框手动复制。';
}
onMounted(() => void act(load));
</script>

<template>
  <ModalDialog label="上报设置" :dismissible="!busy" @close="emit('close')">
    <h2>机器节点上报</h2>
    <p>每台机器保存一个固定 UUID，每次提交完整节点列表。同 ID 覆盖，不同 ID 分别保存。</p>
    <p v-if="!settings && busy" role="status">正在读取上报设置…</p>
    <form v-if="settings" id="node-reporting-settings" @submit.prevent="act(save)">
      <label class="reporting-switch">
        <input v-model="enabled" type="checkbox" :disabled="busy || !settings.tokenConfigured" />
        启用节点上报
      </label>
      <p>{{ settings.tokenConfigured ? '已配置共用 Token。' : '请先生成上报 Token。' }}</p>
      <button type="button" :disabled="busy" @click="act(rotate)">
        {{ settings.tokenConfigured ? '重置上报 Token' : '生成上报 Token' }}
      </button>
      <p v-if="settings.tokenConfigured" class="muted">
        重置后旧 Token 立即失效，所有上报机器需使用新 Token。
      </p>
      <div v-if="token" class="reporting-token">
        <label
          >上报 Token<input ref="tokenInput" :value="token" readonly autocomplete="off"
        /></label>
        <button type="button" :disabled="busy" @click="copyToken">复制 Token</button>
        <p>仅本次显示；关闭后无法重新查看。</p>
      </div>
      <label>上报接口<input :value="endpoint" readonly /></label>
      <h3>调用示例</h3>
      <p>将固定 UUID 和 Token 分别设置为 MACHINE_ID、REPORT_TOKEN，report.json 内容示例：</p>
      <pre>{{ JSON.stringify({ name: '东京服务器', content: 'ss://…\nvless://…' }, null, 2) }}</pre>
      <pre>{{ example }}</pre>
      <p>
        支持节点链接、Base64 和含内联节点的 YAML/JSON，最多 4 MiB、2,000
        个节点。空内容或解析失败保留旧列表。
      </p>
      <p>网页修改的节点内容会被下次有效上报覆盖。</p>
    </form>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <template #footer>
      <button :disabled="busy" @click="emit('close')">关闭</button>
      <button
        form="node-reporting-settings"
        type="submit"
        class="primary"
        :disabled="busy || !settings"
      >
        保存上报设置
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
form,
.reporting-token {
  display: grid;
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
}
.reporting-switch {
  display: flex;
  align-items: center;
}
.reporting-switch input {
  width: auto;
}
input {
  min-width: 0;
  width: 100%;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
