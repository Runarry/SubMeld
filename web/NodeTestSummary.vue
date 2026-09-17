<script setup lang="ts">
import { coreLabels, testStatuses, type TestResult } from '../server/shared/node-tests';
defineProps<{ results: TestResult[] }>();
defineEmits<{ show: [] }>();
</script>
<template>
  <small class="node-test-summary">
    <span v-if="!results.length">尚未测试</span>
    <template v-else>
      <span v-for="result in results" :key="result.core" :title="result.message">
        {{ coreLabels[result.core] }}：{{ result.stale ? '需重测' : testStatuses[result.status]
        }}<template v-if="!result.stale && result.latencyMs !== null">
          {{ result.latencyMs }} ms</template
        >
      </span>
      <button type="button" class="linkish" @click.stop="$emit('show')">查看测试结果</button>
    </template>
  </small>
</template>
