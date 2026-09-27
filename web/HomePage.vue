<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { z } from 'zod';
const props = defineProps<{ api: (path: string) => Promise<unknown> }>();
const links = ref<{ subStore: string; telegram: string | null }>({ subStore: '/', telegram: null });
const error = ref('');
onMounted(async () => {
  try {
    links.value = z
      .object({ subStore: z.string(), telegram: z.string().nullable() })
      .parse(await props.api('/api/integrations'));
  } catch {
    error.value = '入口信息暂不可用。';
  }
});
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>订阅与测试</h1>
        <p>用 Sub-Store 管理订阅，用 Koipy 在 Telegram 测速。</p>
      </div>
    </header>
    <div class="panel">
      <h2>Sub-Store</h2>
      <p>节点、来源、普通组合订阅和分享统一在这里管理。</p>
      <a :href="links.subStore">打开 Sub-Store</a>
    </div>
    <div class="panel">
      <h2>Koipy</h2>
      <p>将普通节点的 Mihomo 分享链接发给自己的机器人，按 Koipy 指令测试并查看结果。</p>
      <a v-if="links.telegram" :href="links.telegram" target="_blank" rel="noreferrer"
        >打开 Telegram 机器人</a
      >
      <p v-else>机器人入口尚未配置。</p>
    </div>
    <div class="panel">
      <h2>增强工具</h2>
      <p>
        通过左侧页面进行结构化节点编辑、两跳链组合、八种格式发布，以及 Mihomo、sing-box、Xray
        分别实测。Telegram 测速结果留在 Koipy。
      </p>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.panel + .panel {
  margin-top: 16px;
}
</style>
