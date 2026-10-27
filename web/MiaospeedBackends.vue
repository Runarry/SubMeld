<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import { z } from 'zod';
import { backendListSchema, type BackendView } from '../server/shared/miaospeed-backends';
import { speedStatusSchema } from '../server/shared/miaospeed';
import { formatTime } from './format';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  value: z.infer<typeof backendListSchema>;
}>();
const emit = defineEmits<{ change: [value: z.infer<typeof backendListSchema>] }>();
const editing = ref<string | null>(null),
  showForm = ref(false),
  name = ref(''),
  url = ref(''),
  token = ref('');
const busy = ref(false),
  message = ref('');
const statuses = ref<Record<string, z.infer<typeof speedStatusSchema>>>({});
async function act(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await operation();
  } catch (error) {
    message.value = error instanceof Error ? error.message : '测速服务操作失败。';
  } finally {
    busy.value = false;
  }
}
function edit(backend?: BackendView) {
  editing.value = backend?.id ?? null;
  name.value = backend?.name ?? '';
  url.value = backend?.url ?? '';
  token.value = '';
  showForm.value = true;
}
function cancel() {
  showForm.value = false;
  token.value = '';
}
async function save() {
  await act(async () => {
    const id = editing.value;
    const value = backendListSchema.parse(
      await props.api(
        '/api/miaospeed/backends' + (id ? '/' + id : ''),
        {
          name: name.value,
          url: url.value,
          ...(token.value.trim() ? { token: token.value.trim() } : {}),
        },
        id ? 'PATCH' : 'POST',
      ),
    );
    if (id) delete statuses.value[id];
    emit('change', value);
    cancel();
    message.value = '测速服务已保存；已提交任务继续使用原配置。';
  });
}
async function setDefault(id: string) {
  await act(async () => {
    emit(
      'change',
      backendListSchema.parse(
        await props.api('/api/miaospeed/backends/default', { backendId: id }, 'PATCH'),
      ),
    );
    message.value = '默认测速服务已设置。';
  });
}
async function remove(backend: BackendView) {
  await act(async () => {
    emit(
      'change',
      backendListSchema.parse(
        await props.api('/api/miaospeed/backends/' + backend.id, {}, 'DELETE'),
      ),
    );
    delete statuses.value[backend.id];
    if (editing.value === backend.id) cancel();
    message.value =
      '测速服务已删除；已提交任务和历史报告保留。Telegram 预设若引用此服务，需要重新选择。';
  });
}
async function check(id: string) {
  await act(async () => {
    statuses.value[id] = speedStatusSchema.parse(
      await props.api('/api/miaospeed/status/check', { backendId: id }),
    );
  });
}
onBeforeUnmount(() => {
  token.value = '';
});
</script>
<template>
  <section class="test-card" aria-label="测速服务管理">
    <div class="page-header">
      <h2>测速服务</h2>
      <button type="button" :disabled="busy" @click="edit()">添加测速服务</button>
    </div>
    <p class="muted">
      远端服务使用 miaospeed 内置 Mihomo。连接检查验证鉴权和 API 响应，各项能力以实际测试结果为准。
    </p>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <form v-if="showForm" class="test-card" @submit.prevent="save">
      <h3>{{ editing ? '编辑测速服务' : '添加测速服务' }}</h3>
      <div class="test-settings-grid">
        <label>服务名称<input v-model="name" maxlength="100" required /></label>
        <label
          >WebSocket 地址<input
            v-model="url"
            placeholder="wss://speed.example.com/miaospeed"
            maxlength="2048"
            required
        /></label>
        <label
          >服务 Token<input
            v-model="token"
            aria-label="服务 Token"
            type="password"
            autocomplete="new-password"
            maxlength="4096"
            :required="!editing"
          /><small>{{
            editing ? '留空保留已保存 Token。' : '与测速容器配置保持一致。'
          }}</small></label
        >
      </div>
      <div class="toolbar">
        <button type="submit" class="primary" :disabled="busy">保存测速服务</button
        ><button type="button" :disabled="busy" @click="cancel">取消编辑</button>
      </div>
    </form>
    <ul class="test-history">
      <li v-for="backend in value.backends" :key="backend.id">
        <div class="backend-description">
          <strong
            >{{ backend.name }}{{ value.defaultBackendId === backend.id ? ' · 默认' : '' }}</strong
          >
          <p>{{ backend.url || '未配置地址' }}</p>
          <p class="muted">
            {{ backend.readOnly ? '环境变量管理 · 支持本机独立内核桥接' : '内置综合测速' }} · Token
            {{ backend.tokenConfigured ? '已配置' : '未配置' }}
          </p>
          <template v-if="statuses[backend.id]">
            <p>
              连接：{{ statuses[backend.id]!.connected ? '可用' : '未确认' }} · 实际版本：{{
                statuses[backend.id]!.version || '未知'
              }}
              · {{ formatTime(statuses[backend.id]!.checkedAt) }}
            </p>
            <p v-if="statuses[backend.id]!.error" class="error-note">
              {{ statuses[backend.id]!.error }}
            </p>
          </template>
        </div>
        <div class="toolbar">
          <button
            type="button"
            :disabled="busy || !backend.tokenConfigured"
            @click="check(backend.id)"
          >
            检查连接 {{ backend.name }}
          </button>
          <button
            type="button"
            :disabled="busy || !backend.tokenConfigured || value.defaultBackendId === backend.id"
            @click="setDefault(backend.id)"
          >
            设为默认 {{ backend.name }}
          </button>
          <template v-if="!backend.readOnly"
            ><button type="button" :disabled="busy" @click="edit(backend)">
              编辑 {{ backend.name }}</button
            ><button type="button" :disabled="busy" @click="remove(backend)">
              删除 {{ backend.name }}
            </button></template
          >
        </div>
      </li>
    </ul>
    <p class="muted">
      主站解析订阅并预检目标，测速流量从所选服务发出。公网接入可使用 WSS；内网可使用 WS。Token
      不会在读取配置或报告中返回。
    </p>
  </section>
</template>
<style scoped>
.backend-description {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
