<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: 'ok' | 'off' | 'busy' | 'error' | 'warn';
    label: string;
  }>(),
  { tone: 'off' },
);
</script>
<template>
  <span class="status-badge" :class="tone">{{ label }}</span>
</template>
