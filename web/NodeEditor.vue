<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { NodeDraft } from '../server/shared/contracts';
defineProps<{ persisted?: boolean }>();
const emit = defineEmits<{ clearSecret: [field: string] }>();
const model = defineModel<NodeDraft>({ required: true });
const showSecrets = ref(false);
watch(
  () => model.value,
  () => {
    showSecrets.value = false;
  },
);
const secretType = computed(() => (showSecrets.value ? 'text' : 'password'));
const alpn = computed({
  get: () => model.value.tls.alpn.join(','),
  set: (value: string) => {
    model.value.tls.alpn = value ? value.split(',').map((v) => v.trim()) : [];
  },
});
</script>

<template>
  <div class="editor-fields">
    <div class="section-title">
      <h3>连接参数</h3>
      <span class="protocol-badge">{{ model.protocol.toUpperCase() }}</span>
    </div>
    <label>名称<input v-model="model.name" maxlength="512" autocomplete="off" /></label>
    <div class="field-pair">
      <label
        >服务器<input v-model="model.server" placeholder="example.com 或 IPv6" autocomplete="off"
      /></label>
      <label class="port-field"
        >端口<input v-model.number="model.port" type="number" min="1" max="65535"
      /></label>
    </div>
    <label v-if="'uuid' in model.auth"
      >UUID<input
        v-model="model.auth.uuid"
        :type="secretType"
        autocomplete="off"
        spellcheck="false"
    /></label>
    <label v-if="'password' in model.auth"
      >密码<input
        v-model="model.auth.password"
        :type="secretType"
        autocomplete="new-password"
        spellcheck="false"
    /></label>
    <div v-if="persisted" class="toolbar secret-actions">
      <button
        v-if="'uuid' in model.auth"
        type="button"
        @click="
          model.auth.uuid = '';
          emit('clearSecret', 'auth.uuid');
        "
      >
        清空 UUID
      </button>
      <button
        v-if="'password' in model.auth"
        type="button"
        @click="
          model.auth.password = '';
          emit('clearSecret', 'auth.password');
        "
      >
        清空密码
      </button>
      <button
        v-if="model.protocol === 'hysteria2'"
        type="button"
        @click="
          model.protocolOptions.obfsPassword = '';
          emit('clearSecret', 'protocolOptions.obfsPassword');
        "
      >
        清空混淆密码
      </button>
    </div>
    <label class="check-label"
      ><input v-model="showSecrets" type="checkbox" />显示此节点的认证信息</label
    >
    <label v-if="model.protocol === 'ss'"
      >加密方式<select v-model="model.protocolOptions.method">
        <option>aes-128-gcm</option>
        <option>aes-256-gcm</option>
        <option>chacha20-ietf-poly1305</option>
      </select></label
    >
    <label v-if="model.protocol === 'vmess'"
      >VMess 加密<select v-model="model.protocolOptions.security">
        <option>auto</option>
        <option>aes-128-gcm</option>
        <option>chacha20-poly1305</option>
        <option>none</option>
        <option>zero</option>
      </select></label
    >
    <label v-if="model.protocol === 'vless'"
      >Flow<select v-model="model.protocolOptions.flow">
        <option value="">无</option>
        <option>xtls-rprx-vision</option>
      </select></label
    >
    <template v-if="model.protocol === 'hysteria2'">
      <label
        >混淆<select v-model="model.protocolOptions.obfs">
          <option value="">无</option>
          <option>salamander</option>
        </select></label
      >
      <label v-if="model.protocolOptions.obfs"
        >混淆密码<input
          v-model="model.protocolOptions.obfsPassword"
          :type="secretType"
          autocomplete="new-password"
      /></label>
    </template>
    <template v-if="model.protocol === 'tuic'">
      <label
        >拥塞控制<select v-model="model.protocolOptions.congestionControl">
          <option>cubic</option>
          <option>bbr</option>
          <option>new_reno</option>
        </select></label
      >
      <label
        >UDP 转发<select v-model="model.protocolOptions.udpRelayMode">
          <option>native</option>
          <option>quic</option>
        </select></label
      >
      <label class="check-label"
        ><input v-model="model.protocolOptions.reduceRtt" type="checkbox" />启用 0-RTT（reduce
        RTT）</label
      >
    </template>
    <template v-if="model.protocol !== 'ss'">
      <h3>TLS 与证书</h3>
      <label
        >安全模式<select v-model="model.tls.mode">
          <option v-if="model.protocol === 'vmess' || model.protocol === 'vless'" value="none">
            无 TLS
          </option>
          <option value="tls">TLS</option>
          <option v-if="model.protocol === 'vless'" value="reality">REALITY</option>
        </select></label
      >
      <template v-if="model.tls.mode !== 'none'">
        <label
          >SNI<input
            v-model="model.tls.serverName"
            placeholder="未填写时使用协议默认值"
            autocomplete="off"
        /></label>
        <template v-if="model.protocol !== 'hysteria2'">
          <label
            >ALPN<input v-model="alpn" placeholder="h2,http/1.1（逗号分隔）" autocomplete="off"
          /></label>
          <label v-if="model.protocol !== 'tuic'"
            >客户端指纹<select v-model="model.tls.fingerprint">
              <option value="">默认</option>
              <option
                v-for="fp in [
                  'chrome',
                  'firefox',
                  'safari',
                  'ios',
                  'android',
                  'edge',
                  '360',
                  'qq',
                  'random',
                  'randomized',
                ]"
                :key="fp"
              >
                {{ fp }}
              </option>
            </select></label
          >
        </template>
        <template v-if="model.tls.mode === 'reality'">
          <label
            >REALITY 公钥<input v-model="model.tls.publicKey" autocomplete="off" spellcheck="false"
          /></label>
          <label
            >Short ID<input
              v-model="model.tls.shortId"
              maxlength="16"
              autocomplete="off"
              spellcheck="false"
          /></label>
        </template>
        <label class="check-label"
          ><input v-model="model.tls.insecure" type="checkbox" />跳过此节点的证书验证</label
        >
        <p v-if="model.tls.insecure" class="warning-note">
          警告：此节点不会验证服务端证书；导出时保留这一设置。
        </p>
      </template>
    </template>
    <template v-if="['vmess', 'vless', 'trojan'].includes(model.protocol)">
      <h3>传输</h3>
      <label
        >传输类型<select v-model="model.transport.type">
          <option value="tcp">TCP</option>
          <option value="ws">WebSocket</option>
          <option value="grpc">gRPC</option>
        </select></label
      >
      <template v-if="model.transport.type === 'ws'">
        <label
          >Path<input v-model="model.transport.path" placeholder="/" autocomplete="off"
        /></label>
        <label>Host<input v-model="model.transport.host" autocomplete="off" /></label>
      </template>
      <label v-if="model.transport.type === 'grpc'"
        >Service name<input v-model="model.transport.serviceName" autocomplete="off"
      /></label>
    </template>
  </div>
</template>
