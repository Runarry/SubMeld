<script setup lang="ts">
defineProps<{ busy: boolean; message: string }>();
const password = defineModel<string>('password', { required: true });
const emit = defineEmits<{ login: [] }>();
</script>
<template>
  <main class="login-shell">
    <div class="login-brand">
      <span class="brand-mark" aria-hidden="true">S</span>
      <span>SubMeld <span class="muted">· 订融</span></span>
    </div>
    <section class="panel login-panel">
      <h1>管理员登录</h1>
      <p class="intro">统一管理节点、机器中转、输出方案与测试。</p>
      <form class="login-card" @submit.prevent="emit('login')">
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
        <p v-if="message" class="notice is-error" role="alert">{{ message }}</p>
      </form>
    </section>
  </main>
</template>
