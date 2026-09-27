<script setup lang="ts">
import NodeTestsPage from './NodeTestsPage.vue';
defineProps<{ api: (path: string, body?: unknown, method?: string) => Promise<unknown> }>();
const emit = defineEmits<{
  navigate: [view: 'sources' | 'library' | 'subscriptions' | 'workbench' | 'tests'];
}>();
const tools = [
  {
    view: 'sources' as const,
    title: '上游节点预览',
    detail: '读取 Sub-Store 订阅，选择节点测试或复制为独立节点。',
  },
  {
    view: 'library' as const,
    title: '本地节点与两跳链',
    detail: '编辑独立节点、设置启停，并组合前置和出口。',
  },
  {
    view: 'subscriptions' as const,
    title: '增强订阅',
    detail: '管理来源、顺序、八种输出、私人地址和产物更新。',
  },
  {
    view: 'workbench' as const,
    title: '转换工作台',
    detail: '临时解析、编辑和导出节点，不自动保存到节点库。',
  },
  {
    view: 'tests' as const,
    title: '测试任务与结果',
    detail: '查看三内核测试进度、取消批次和查看最近结果。',
  },
];
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>增强工具</h1>
        <p>管理增强流程，并设置三内核测试地址和版本。</p>
      </div>
    </header>
    <div class="tools-grid">
      <article v-for="tool in tools" :key="tool.view" class="panel">
        <h2>{{ tool.title }}</h2>
        <p>{{ tool.detail }}</p>
        <button type="button" @click="emit('navigate', tool.view)">管理{{ tool.title }}</button>
      </article>
    </div>
    <NodeTestsPage :api="api" :subjects="[]" settings-only />
  </section>
</template>
<style scoped>
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 16px;
  margin-bottom: 28px;
}
.tools-grid h2 {
  font-size: 17px;
}
.tools-grid p {
  margin: 12px 0;
}
</style>
