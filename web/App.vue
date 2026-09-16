<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

const connection = ref<'checking' | 'online' | 'offline'>('checking');
let request: AbortController | undefined;

const connectionLabel = computed(() => {
  if (connection.value === 'online') return '服务已连接';
  if (connection.value === 'offline') return '暂时无法连接服务';
  return '正在检查连接';
});

async function checkConnection() {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  connection.value = 'checking';
  const timeout = window.setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch('/healthz', { cache: 'no-store', signal: controller.signal });
    const result: unknown = await response.json();
    if (!response.ok || typeof result !== 'object' || result === null || !('status' in result)) {
      throw new Error('Invalid health response');
    }
    connection.value = result.status === 'ok' ? 'online' : 'offline';
  } catch {
    connection.value = 'offline';
  } finally {
    window.clearTimeout(timeout);
  }
}

onMounted(checkConnection);
onUnmounted(() => request?.abort());
</script>

<template>
  <div class="page">
    <header class="brand">
      <span class="brand-mark" aria-hidden="true">S</span>
      <span>SubMeld <span class="brand-divider">/</span> 订融</span>
    </header>

    <main>
      <p class="eyebrow">私人节点转换与订阅工具</p>
      <h1>把节点整理清楚，<br />把转换结果交代清楚。</h1>
      <p class="intro">SubMeld · 订融的起点。工程骨架已建立，转换工作台将在第一阶段开放。</p>

      <section class="status-card" aria-labelledby="status-heading">
        <div class="card-heading">
          <h2 id="status-heading">项目状态</h2>
          <span class="stage">初始化</span>
        </div>

        <div class="status-row">
          <div>
            <p class="status-label">工程骨架</p>
            <p class="status-description">页面与服务已接入同一应用</p>
          </div>
          <span class="ready-label">已建立</span>
        </div>

        <div class="status-row">
          <div>
            <p class="status-label">服务连接</p>
            <p class="connection" :class="connection" role="status" aria-live="polite">
              <span class="status-dot" aria-hidden="true"></span>
              {{ connectionLabel }}
            </p>
          </div>
          <button type="button" :disabled="connection === 'checking'" @click="checkConnection">
            重新检查
          </button>
        </div>

        <p class="next-step">下一阶段 <span>P1 · URI / Base64 转换工作台</span></p>
      </section>
    </main>

    <footer>当前为开发骨架，尚未开放登录、节点转换和订阅发布。</footer>
  </div>
</template>
