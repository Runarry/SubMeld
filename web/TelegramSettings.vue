<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  metricDefinitions,
  metricIds,
  speedCoreLabels,
  speedSettingsSchema,
  type TestScript,
} from '../server/shared/miaospeed';
import {
  telegramDeliveryLabels,
  telegramProfileSchema,
  telegramSettingsPatchSchema,
  telegramSettingsViewSchema,
  telegramStatusSchema,
  telegramTaskLabels,
  telegramTaskListSchema,
  telegramTaskSchema,
  telegramUserIdSchema,
  type TelegramSettingsView,
  type TelegramStatus,
  type TelegramTask,
} from '../server/shared/telegram';
import { formatTime } from './format';
import ListPagination from './ui/ListPagination.vue';
import type { BackendView } from '../server/shared/miaospeed-backends';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  scripts: TestScript[];
  backends: BackendView[];
}>();
const emit = defineEmits<{ report: [id: string] }>();
const configuration = ref<TelegramSettingsView | null>(null),
  enabled = ref(false),
  allowedUsers = ref(''),
  token = ref(''),
  proxyUrl = ref(''),
  clearToken = ref(false),
  clearProxy = ref(false);
const profile = ref(
  telegramProfileSchema.parse({
    settings: speedSettingsSchema.parse({}),
    metrics: [...metricIds],
    scriptIds: [],
  }),
);
const status = ref<TelegramStatus | null>(null),
  tasks = ref<TelegramTask[]>([]),
  total = ref(0),
  page = ref(0),
  busy = ref(false),
  message = ref(''),
  failed = ref(false),
  pollError = ref('');
const enabledScripts = computed(() => props.scripts.filter((script) => script.enabled));
const selectedBackend = computed(() =>
  props.backends.find((backend) => backend.id === profile.value.backendId),
);
const unavailableScripts = computed(
  () =>
    profile.value.scriptIds.filter((id) => !enabledScripts.value.some((s) => s.id === id)).length,
);
const statusLabels: Record<TelegramStatus['state'], string> = {
  disabled: '已停用',
  connecting: '连接中',
  connected: '已连接',
  error: '连接失败',
};
const numericFields = [
  ['downloadSeconds', '下行时长（秒）', 1, undefined],
  ['uploadSeconds', '上行时长（秒）', 2, undefined],
  ['downloadThreads', '下行线程', 1, 32],
  ['uploadThreads', '上行线程', 1, 32],
  ['pingCount', 'Ping 次数', 1, 16],
  ['retries', '尝试次数', 1, 10],
  ['requestTimeoutMs', '单次请求超时（毫秒）', 10, 10000],
  ['timeoutSeconds', '每项任务等待上限（秒）', 10, 10000],
] as const;
let alive = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  pollEpoch = 0;

function applySettings(value: TelegramSettingsView) {
  configuration.value = value;
  enabled.value = value.enabled;
  allowedUsers.value = value.allowedUserIds.join('\n');
  profile.value = telegramProfileSchema.parse(value.profile);
  token.value = '';
  proxyUrl.value = '';
  clearToken.value = false;
  clearProxy.value = false;
}
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  failed.value = false;
  try {
    await action();
  } catch (error) {
    if (alive) {
      failed.value = true;
      message.value = error instanceof Error ? error.message : '操作失败。';
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function loadSettings() {
  await act(async () => {
    const value = telegramSettingsViewSchema.parse(await props.api('/api/telegram/settings'));
    if (alive) applySettings(value);
  });
}
async function save() {
  await act(async () => {
    const previous = configuration.value;
    if (!previous) return;
    const allowedUserIds = [...new Set(allowedUsers.value.split(/[\s,，;；]+/).filter(Boolean))];
    if (allowedUserIds.some((id) => !telegramUserIdSchema.safeParse(id).success))
      throw new Error('请填写有效的 Telegram 数字用户 ID，每行一个。');
    if (enabled.value && !allowedUserIds.length)
      throw new Error('启用 Telegram 前请至少填写一个允许的用户 ID。');
    if (enabled.value && (clearToken.value || (!token.value.trim() && !previous.tokenConfigured)))
      throw new Error('启用 Telegram 前请设置 Bot Token。');
    const checkedProfile = telegramProfileSchema.safeParse(profile.value);
    if (enabled.value && !selectedBackend.value?.tokenConfigured)
      throw new Error('请选择可用的 Telegram 测速服务。');
    if (selectedBackend.value?.kind === 'remote' && profile.value.settings.nodeCore !== 'native')
      throw new Error('远端测速服务仅支持 miaospeed 内置 Mihomo，请修改执行内核。');
    if (!checkedProfile.success)
      throw new Error(
        !profile.value.metrics.length && !profile.value.scriptIds.length
          ? '至少选择一个检测项或启用脚本。'
          : '请核对 Telegram 测试参数与取值范围。',
      );
    const patch = {
      ...(enabled.value !== previous.enabled ? { enabled: enabled.value } : {}),
      ...(JSON.stringify(allowedUserIds) !== JSON.stringify(previous.allowedUserIds)
        ? { allowedUserIds }
        : {}),
      ...(JSON.stringify(checkedProfile.data) !== JSON.stringify(previous.profile)
        ? { profile: checkedProfile.data }
        : {}),
      ...(clearToken.value
        ? { token: null }
        : token.value.trim()
          ? { token: token.value.trim() }
          : {}),
      ...(clearProxy.value
        ? { proxyUrl: null }
        : proxyUrl.value.trim()
          ? { proxyUrl: proxyUrl.value.trim() }
          : {}),
    };
    if (!telegramSettingsPatchSchema.safeParse(patch).success)
      throw new Error('请核对 Bot Token 格式、代理地址和允许的用户 ID。');
    const value = telegramSettingsViewSchema.parse(
      await props.api('/api/telegram/settings', patch, 'PATCH'),
    );
    if (alive) {
      applySettings(value);
      message.value = 'Telegram 设置已保存。';
      await refresh();
    }
  });
}
async function check() {
  await act(async () => {
    const value = telegramStatusSchema.parse(await props.api('/api/telegram/check', {}));
    if (alive) {
      status.value = value;
      message.value = '已检查保存的 Telegram 连接设置。';
    }
  });
}
async function refresh() {
  const epoch = ++pollEpoch;
  try {
    const [connection, jobs] = await Promise.all([
      props.api('/api/telegram/status'),
      props.api('/api/telegram/tasks?page=' + page.value),
    ]);
    const state = telegramStatusSchema.parse(connection);
    const list = telegramTaskListSchema.parse(jobs);
    if (!alive || epoch !== pollEpoch) return;
    status.value = state;
    tasks.value = list.tasks;
    total.value = list.total;
    pollError.value = '';
  } catch (error) {
    if (alive && epoch === pollEpoch)
      pollError.value = error instanceof Error ? error.message : 'Telegram 状态读取失败。';
  }
}
async function poll() {
  await refresh();
  if (alive) timer = setTimeout(poll, 3000);
}
function cancellable(task: TelegramTask) {
  return ['queued', 'preparing', 'running'].includes(task.state);
}
function resendable(task: TelegramTask) {
  return !cancellable(task) && !['sending', 'suppressed'].includes(task.deliveryState);
}
async function taskAction(task: TelegramTask, action: 'cancel' | 'resend') {
  await act(async () => {
    const value = telegramTaskSchema.parse(
      await props.api('/api/telegram/tasks/' + task.id + '/' + action, {}),
    );
    if (alive) {
      tasks.value = tasks.value.map((item) => (item.id === value.id ? value : item));
      message.value =
        action === 'cancel'
          ? '已请求取消 Telegram 任务。'
          : task.reportId
            ? '已请求重新回传报告。'
            : '已请求重新回传任务状态。';
      await refresh();
    }
  });
}
onMounted(() => {
  void loadSettings();
  void poll();
});
onBeforeUnmount(() => {
  alive = false;
  pollEpoch++;
  clearTimeout(timer);
  token.value = '';
  proxyUrl.value = '';
});
</script>
<template>
  <section aria-label="Telegram 测试">
    <p
      v-if="message"
      class="notice"
      :class="{ 'is-error': failed }"
      :role="failed ? 'alert' : 'status'"
    >
      {{ message }}
    </p>
    <form v-if="configuration" aria-label="Telegram 设置" @submit.prevent="save">
      <section class="test-card">
        <div class="page-header">
          <h2>Telegram Bot</h2>
          <span class="report-state">{{ configuration.enabled ? '已启用' : '已停用' }}</span>
        </div>
        <p class="muted">允许的用户可私聊 Bot 提交节点文本、订阅 URL 或配置文件进行综合测试。</p>
        <div class="test-options">
          <label><input v-model="enabled" type="checkbox" />启用 Telegram 测试</label>
        </div>
        <label
          >允许的 Telegram 用户 ID<textarea
            v-model="allowedUsers"
            rows="4"
            placeholder="每行一个数字用户 ID"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <p class="muted">启用时至少填写一个用户 ID；停用或移除用户会取消其 Telegram 任务。</p>
        <div class="test-settings-grid">
          <div>
            <label
              >新的 Bot Token<input
                v-model="token"
                type="password"
                autocomplete="new-password"
                maxlength="256"
                :disabled="clearToken"
                placeholder="留空保留现值"
            /></label>
            <p class="muted">
              Bot Token：{{ configuration.tokenConfigured ? '已配置' : '未配置' }}
            </p>
            <div class="test-options">
              <label><input v-model="clearToken" type="checkbox" />清除已保存的 Bot Token</label>
            </div>
          </div>
          <div>
            <label
              >新的 Telegram 代理地址<input
                v-model="proxyUrl"
                type="password"
                autocomplete="new-password"
                maxlength="2048"
                :disabled="clearProxy"
                placeholder="留空保留现值"
            /></label>
            <p class="muted telegram-proxy">
              当前代理：{{
                configuration.proxyConfigured ? configuration.proxyDisplay || '已配置' : '未配置'
              }}
            </p>
            <div class="test-options">
              <label><input v-model="clearProxy" type="checkbox" />清除已保存的代理</label>
            </div>
          </div>
        </div>
      </section>
      <section class="test-card" aria-label="Telegram 测试预设">
        <h2>Telegram 测试预设</h2>
        <p class="muted">首次从网页默认参数初始化，之后独立保存；每个新任务使用此预设。</p>
        <div class="test-settings-grid">
          <label
            >Telegram 测速服务<select v-model="profile.backendId">
              <option :value="null">请选择测速服务</option>
              <option
                v-if="profile.backendId && !selectedBackend"
                :value="profile.backendId"
                disabled
              >
                原服务已删除，请重新选择
              </option>
              <option
                v-for="backend in backends"
                :key="backend.id"
                :value="backend.id"
                :disabled="!backend.tokenConfigured"
              >
                {{ backend.name }}
              </option>
            </select></label
          >
          <label
            >节点执行内核<select v-model="profile.settings.nodeCore">
              <option
                v-for="(label, core) in speedCoreLabels"
                :key="core"
                :value="core"
                :disabled="selectedBackend?.kind === 'remote' && core !== 'native'"
              >
                {{ label }}
              </option>
            </select></label
          ><label
            >HTTPS 连通性目标<input v-model="profile.settings.pingUrl" type="url" required /></label
          ><label>下载目标<input v-model="profile.settings.downloadUrl" required /></label
          ><label>上传目标<input v-model="profile.settings.uploadUrl" type="url" required /></label
          ><label>STUN 地址<input v-model="profile.settings.stunAddress" required /></label
          ><label v-for="[field, label, min, max] in numericFields" :key="field"
            >{{ label
            }}<input
              v-model.number="profile.settings[field]"
              type="number"
              :min="min"
              :max="max"
              required
          /></label>
        </div>
        <h3>检测项目</h3>
        <div class="test-options">
          <label v-for="[id, label] in metricDefinitions" :key="id"
            ><input v-model="profile.metrics" type="checkbox" :value="id" />{{ label }}</label
          >
        </div>
        <h3>脚本检测</h3>
        <div class="test-options">
          <label v-for="script in enabledScripts" :key="script.id"
            ><input v-model="profile.scriptIds" type="checkbox" :value="script.id" />{{
              script.name
            }}</label
          >
        </div>
        <p v-if="!enabledScripts.length" class="muted">暂无启用脚本，可在“检测脚本”栏目管理。</p>
        <div v-if="unavailableScripts">
          <p class="warning-note">{{ unavailableScripts }} 个已选脚本已停用或不可用。</p>
          <button
            type="button"
            :disabled="busy"
            @click="
              profile.scriptIds = profile.scriptIds.filter((id) =>
                enabledScripts.some((script) => script.id === id),
              )
            "
          >
            移除不可用脚本
          </button>
        </div>
      </section>
      <button type="submit" class="primary" :disabled="busy">保存 Telegram 设置</button>
    </form>
    <button v-else type="button" :disabled="busy" @click="loadSettings">
      重新加载 Telegram 设置
    </button>
    <section class="test-card" aria-label="Telegram 连接状态">
      <div class="page-header">
        <h2>连接状态</h2>
        <button type="button" :disabled="busy || !configuration" @click="check">
          检查已保存连接
        </button>
      </div>
      <p>{{ status ? statusLabels[status.state] : '等待状态' }}</p>
      <p v-if="status?.botId">Bot：{{ status.username ? '@' + status.username : status.botId }}</p>
      <p v-if="status?.checkedAt">检查时间：{{ formatTime(status.checkedAt) }}</p>
      <p v-if="status?.error" class="error-note" role="alert">{{ status.error }}</p>
      <p v-if="status">
        排队 {{ status.queued }} 项 · {{ status.activeTaskId ? '有任务运行中' : '无运行任务' }}
      </p>
      <p class="muted">连接检查使用已保存的设置，不发送测试消息。</p>
    </section>
    <section class="test-card" aria-label="Telegram 任务">
      <div class="page-header">
        <h2>Telegram 任务</h2>
        <button type="button" :disabled="busy" @click="refresh">刷新任务与状态</button>
      </div>
      <p v-if="pollError" class="error-note" role="alert">{{ pollError }}</p>
      <ul class="test-history">
        <li v-for="task in tasks" :key="task.id" :aria-label="'Telegram 任务 ' + task.id">
          <div>
            <strong>用户 {{ task.userId }} · {{ telegramTaskLabels[task.state] }}</strong>
            <p>{{ formatTime(task.createdAt) }} · {{ task.completed }}/{{ task.total }} 项</p>
            <p>
              {{ telegramDeliveryLabels[task.deliveryState] }} · 已回传文件
              {{ task.deliveredParts.length }} 项 · 回传尝试 {{ task.deliveryAttempts }} 次
            </p>
            <p v-if="task.nextDeliveryAt">下次回传：{{ formatTime(task.nextDeliveryAt) }}</p>
            <p v-if="task.error" class="error-note">{{ task.error }}</p>
            <p v-if="task.deliveryError" class="error-note">{{ task.deliveryError }}</p>
          </div>
          <div class="toolbar">
            <button
              v-if="cancellable(task)"
              type="button"
              :disabled="busy"
              @click="taskAction(task, 'cancel')"
            >
              取消任务
            </button>
            <button
              v-if="task.reportId"
              type="button"
              :disabled="busy"
              @click="emit('report', task.reportId)"
            >
              查看报告
            </button>
            <button
              v-if="resendable(task)"
              type="button"
              :disabled="busy"
              @click="taskAction(task, 'resend')"
            >
              {{ task.reportId ? '重新回传报告' : '重新回传任务状态' }}
            </button>
          </div>
        </li>
      </ul>
      <p v-if="!tasks.length" class="muted">暂无 Telegram 任务。</p>
      <ListPagination
        :page="page"
        :total="total"
        :disabled="busy"
        @turn="
          (delta) => {
            page += delta;
            refresh();
          }
        "
      />
    </section>
  </section>
</template>
<style scoped>
.telegram-proxy {
  overflow-wrap: anywhere;
}
</style>
