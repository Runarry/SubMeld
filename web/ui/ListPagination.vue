<script setup lang="ts">
withDefaults(
  defineProps<{
    page: number;
    total: number;
    pageSize?: number;
    disabled?: boolean;
    prevLabel?: string;
    nextLabel?: string;
  }>(),
  { pageSize: 25, prevLabel: '上一页', nextLabel: '下一页' },
);
const emit = defineEmits<{ turn: [delta: number] }>();
</script>
<template>
  <div class="pagination">
    <button type="button" :disabled="disabled || !page" @click="emit('turn', -1)">
      {{ prevLabel }}
    </button>
    <span>第 {{ page + 1 }} 页 · 共 {{ total }} 项</span>
    <button
      type="button"
      :disabled="disabled || (page + 1) * pageSize >= total"
      @click="emit('turn', 1)"
    >
      {{ nextLabel }}
    </button>
  </div>
</template>
