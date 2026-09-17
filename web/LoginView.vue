<script setup lang="ts">
defineProps<{ busy: boolean; message: string }>();
const password = defineModel<string>('password', { required: true });
const emit = defineEmits<{ login: [] }>();
</script>
<template>
  <main class="login-shell">
    <p class="eyebrow">SubMeld · 订融</p>
    <h1>管理员登录</h1>
    <p class="intro">管理来源、订阅方案和本地节点。即时转换仍在工作台，刷新后清空。</p>
    <form class="panel login-card" @submit.prevent="emit('login')">
      <label
        >管理员密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="1024"
      /></label>
      <button class="primary" :disabled="busy || !password">
        {{ busy ? '正在登录…' : '登录' }}
      </button>
      <p class="muted">首次使用请先在主机上运行本地初始化命令。没有默认密码。</p>
    </form>
    <p v-if="message" class="notice is-error" role="alert">{{ message }}</p>
  </main>
</template>
