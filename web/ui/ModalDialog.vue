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
      <div v-if="$slots.banner" class="modal-banner">
        <slot name="banner" />
      </div>
      <div v-if="$slots.tabs" class="modal-tabs">
        <slot name="tabs" />
      </div>
      <div class="modal-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="modal-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
