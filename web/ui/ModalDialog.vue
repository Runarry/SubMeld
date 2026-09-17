<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
const props = withDefaults(
  defineProps<{
    label: string;
    wide?: boolean;
    elevated?: boolean;
    dismissible?: boolean;
  }>(),
  { dismissible: true },
);
const emit = defineEmits<{ close: [] }>();
function tryClose() {
  if (props.dismissible) emit('close');
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') tryClose();
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>
<template>
  <div class="modal-overlay" :class="{ elevated, wide }" @mousedown.self="tryClose">
    <div class="modal-dialog" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="label">
      <slot />
    </div>
  </div>
</template>
