<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { koipySettingsSchema, type KoipySettings } from '../server/shared/integrations';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const settings = ref<KoipySettings | null>(null),
  busy = ref(false),
  message = ref('');
const form = reactive({
  botUsername: '',
  adminIds: '',
  address: 'miaospeed:8765',
  path: '/miaospeed',
  tls: false,
  skipCertVerify: false,
});
const secrets = reactive({ license: '', botToken: '', miaospeedToken: '', botProxy: '' });
const clear = reactive({ license: false, botToken: false, miaospeedToken: false, botProxy: false });
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
function loaded(value: unknown) {
  const saved = koipySettingsSchema.parse(value);
  if (!alive) return;
  settings.value = saved;
  Object.assign(form, {
    botUsername: saved.botUsername,
    adminIds: saved.adminIds.join(', '),
    ...saved.backend,
  });
  for (const key of Object.keys(secrets) as (keyof typeof secrets)[]) {
    secrets[key] = '';
    clear[key] = false;
  }
}
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await action();
  } catch (error) {
    if (alive) message.value = error instanceof Error ? error.message : '配置操作失败。';
  } finally {
    if (alive) busy.value = false;
  }
}
const load = () =>
  act(async () => {
    loaded(await props.api('/api/integrations/koipy'));
  });
async function save() {
  if (!settings.value) return;
  await act(async () => {
    const adminIds = form.adminIds
      .split(/[\s,，]+/)
      .filter(Boolean)
      .map(Number);
    const secretChanges = Object.fromEntries(
      (Object.keys(secrets) as (keyof typeof secrets)[])
        .filter((key) => clear[key] || secrets[key])
        .map((key) => [key, clear[key] ? null : secrets[key]]),
    );
    loaded(
      await props.api(
        '/api/integrations/koipy',
        {
          revision: settings.value?.revision,
          botUsername: form.botUsername,
          adminIds,
          backend: {
            address: form.address,
            path: form.path,
            tls: form.tls,
            skipCertVerify: form.skipCertVerify,
          },
          ...secretChanges,
        },
        'PATCH',
      ),
    );
    if (alive)
      message.value =
        '已写入 Koipy 配置文件。机器人入口立即更新；Koipy 运行配置请按下方命令重启后生效。';
  });
}
onMounted(() => {
  void load();
});
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>Koipy 管理</h1>
        <p>配置机器人身份、管理员和 miaospeed 连接。测试任务与结果在 Telegram 中管理。</p>
      </div>
      <button type="button" :disabled="busy" @click="load">重新载入配置</button>
    </header>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <template v-if="settings">
      <p class="notice">
        {{
          settings.configured
            ? '必需配置已填写。实际运行状态请重启后在 Telegram 确认。'
            : '尚未完成配置：请填写激活码、Bot Token、管理员 ID 和 miaospeed Token。'
        }}
      </p>
      <form class="panel" @submit.prevent="save">
        <fieldset :disabled="busy">
          <legend>Telegram 机器人</legend>
          <div class="form-grid">
            <label
              >机器人用户名<input
                v-model="form.botUsername"
                placeholder="例如 MyKoipyBot，可带 @"
                maxlength="33"
            /></label>
            <label
              >管理员 Telegram ID<input
                v-model="form.adminIds"
                placeholder="数字 ID，多个用逗号分隔"
            /></label>
            <label
              >Koipy 激活码<input
                v-model="secrets.license"
                type="password"
                autocomplete="new-password"
                :placeholder="settings.hasLicense ? '已配置，留空保留' : '请输入激活码'"
                :disabled="clear.license"
            /></label>
            <label
              >Bot Token<input
                v-model="secrets.botToken"
                type="password"
                autocomplete="new-password"
                :placeholder="
                  settings.hasBotToken ? '已配置，留空保留' : '请输入 BotFather 提供的 Token'
                "
                :disabled="clear.botToken"
            /></label>
            <label
              >机器人代理（可选）<input
                v-model="secrets.botProxy"
                type="password"
                autocomplete="new-password"
                :placeholder="settings.hasBotProxy ? '已配置，留空保留' : 'http:// 或 socks5://'"
                :disabled="clear.botProxy"
            /></label>
          </div>
          <div class="checks">
            <label v-if="settings.hasLicense"
              ><input v-model="clear.license" type="checkbox" />清除激活码</label
            >
            <label v-if="settings.hasBotToken"
              ><input v-model="clear.botToken" type="checkbox" />清除 Bot Token</label
            >
            <label v-if="settings.hasBotProxy"
              ><input v-model="clear.botProxy" type="checkbox" />清除机器人代理</label
            >
          </div>
        </fieldset>
        <fieldset :disabled="busy">
          <legend>miaospeed 后端 · local</legend>
          <div class="form-grid">
            <label
              >后端地址<input v-model="form.address" placeholder="miaospeed:8765" required
            /></label>
            <label
              >WebSocket 路径<input v-model="form.path" placeholder="/miaospeed" required
            /></label>
            <label
              >miaospeed Token<input
                v-model="secrets.miaospeedToken"
                type="password"
                autocomplete="new-password"
                :placeholder="
                  settings.hasMiaospeedToken ? '已配置，留空保留' : '与 miaospeed 服务的 Token 一致'
                "
                :disabled="clear.miaospeedToken"
            /></label>
          </div>
          <div class="checks">
            <label><input v-model="form.tls" type="checkbox" />使用 TLS</label>
            <label
              ><input
                v-model="form.skipCertVerify"
                type="checkbox"
                :disabled="!form.tls"
              />跳过后端证书验证</label
            >
            <label v-if="settings.hasMiaospeedToken"
              ><input v-model="clear.miaospeedToken" type="checkbox" />清除 miaospeed Token</label
            >
          </div>
          <p class="muted">
            地址从 Koipy 容器访问；同一 Compose 使用 miaospeed:8765。Token 需与服务端
            MIAOSPEED_TOKEN 一致。其他后端和自定义配置会保留。
          </p>
        </fieldset>
        <button type="submit" class="primary" :disabled="busy">
          {{ busy ? '正在保存…' : '保存 Koipy 配置' }}
        </button>
      </form>
      <section class="panel instructions">
        <h2>应用配置</h2>
        <p>
          配置文件：<code>{{ settings.configPath }}</code>
        </p>
        <p>已有容器在项目目录运行：</p>
        <pre>docker compose restart koipy</pre>
        <p>首次启动运行：</p>
        <pre>docker compose up -d miaospeed koipy</pre>
        <p>
          机器人还需要可用激活码、Telegram 网络和可访问的 Mihomo
          分享地址。配置保存成功不代表已通过实际测速。
        </p>
        <a
          v-if="settings.botUsername"
          :href="'https://t.me/' + settings.botUsername"
          target="_blank"
          rel="noreferrer"
          >打开 Telegram 机器人</a
        >
        <a href="https://koipy.gitbook.io/koipy/kuai-su-kai-shi" target="_blank" rel="noreferrer"
          >Koipy 配置说明</a
        >
      </section>
    </template>
  </section>
</template>
<style scoped>
fieldset {
  border: 0;
  padding: 0;
  margin: 0 0 24px;
  min-width: 0;
}
legend {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 14px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 16px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 16px 0;
}
.checks label {
  flex-direction: row;
  align-items: center;
}
input[type='checkbox'] {
  width: auto;
}
.instructions {
  margin-top: 20px;
  overflow-wrap: anywhere;
}
.instructions p {
  margin: 12px 0;
}
.instructions a {
  display: inline-block;
  margin: 8px 16px 0 0;
}
pre {
  overflow-x: auto;
  padding: 12px;
  background: var(--bg);
  border-radius: 8px;
}
</style>
