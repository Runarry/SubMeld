<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { z } from 'zod';
const props = defineProps<{ api: (path: string) => Promise<unknown> }>();
const emit = defineEmits<{ navigate: [view: 'library' | 'tests'] }>();
const links = ref<{ subStore: string }>({ subStore: '/' });
const error = ref('');
onMounted(async () => {
  try {
    links.value = z.object({ subStore: z.string() }).parse(await props.api('/api/integrations'));
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
        <p>用 Sub-Store 管理订阅，在测试中心检查节点与两跳链的质量。</p>
      </div>
    </header>
    <div class="panel">
      <h2>Sub-Store</h2>
      <p>节点、来源、普通组合订阅和分享统一在这里管理。</p>
      <a :href="links.subStore">打开 Sub-Store</a>
      <button type="button" @click="emit('navigate', 'library')">查看 Sub-Store 节点</button>
    </div>
    <div class="panel">
      <h2>综合测试</h2>
      <p>
        查看上下行速度、延迟、丢包、解锁与入口/出口拓扑。也可临时粘贴节点或上传配置，无需保存为订阅。
      </p>
      <button type="button" @click="emit('navigate', 'tests')">打开测试中心</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.panel + .panel {
  margin-top: 16px;
}
.panel > button {
  margin: 10px 0 0 12px;
}
</style>
