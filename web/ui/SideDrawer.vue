<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUnmounted, ref } from 'vue';
const props = withDefaults(
  defineProps<{
    label: string;
    dismissible?: boolean;
    returnFocusTo?: HTMLElement | null;
    wide?: boolean;
  }>(),
  {
    dismissible: true,
    returnFocusTo: null,
    wide: false,
  },
);
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
const returnFocusTo = props.returnFocusTo ?? null;
let previousOverflow = '';
function focusable() {
  return Array.from(
    panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
    ) || [],
  ).filter(
    (element) =>
      element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}
function close() {
  if (props.dismissible) emit('close');
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  if (event.key !== 'Tab') return;
  const elements = focusable(),
    first = elements[0],
    last = elements.at(-1);
  if (!first) {
    event.preventDefault();
    panel.value?.focus();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === panel.value)
  ) {
    event.preventDefault();
    last?.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !panel.value?.contains(document.activeElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}
function onFocus(event: FocusEvent) {
  if (event.target instanceof Node && !panel.value?.contains(event.target))
    (focusable()[0] || panel.value)?.focus();
}
onMounted(async () => {
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocus);
  await nextTick();
  (
    panel.value?.querySelector<HTMLElement>('[data-drawer-initial-focus]') ||
    focusable()[0] ||
    panel.value
  )?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('focusin', onFocus);
  document.body.style.overflow = previousOverflow;
});
onUnmounted(async () => {
  await nextTick();
  if (
    !returnFocusTo?.isConnected ||
    !returnFocusTo.getClientRects().length ||
    returnFocusTo.matches(':disabled, [aria-disabled="true"]') ||
    getComputedStyle(returnFocusTo).visibility === 'hidden'
  )
    return;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active !== returnFocusTo &&
    active.isConnected
  )
    return;
  returnFocusTo.focus({ preventScroll: true });
});
</script>
<template>
  <Teleport to="body">
    <div class="drawer-overlay" @mousedown.self="close">
      <section
        ref="panel"
        class="side-drawer"
        :class="{ wide }"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        tabindex="-1"
      >
        <header class="drawer-header">
          <div>
            <h2>{{ label }}</h2>
            <slot name="subtitle" />
          </div>
          <button
            type="button"
            class="drawer-close"
            :aria-label="'关闭' + label"
            :disabled="!dismissible"
            @click="close"
          >
            ×
          </button>
        </header>
        <div class="drawer-body"><slot /></div>
        <footer v-if="$slots.footer" class="drawer-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
  display: flex;
  justify-content: flex-end;
  background: var(--overlay);
}
.side-drawer {
  width: min(var(--drawer-width), 100vw);
  height: 100dvh;
  background: var(--surface);
  box-shadow: var(--shadow-drawer);
  display: flex;
  flex-direction: column;
  min-width: 0;
  outline: none;
  border-radius: var(--radius-dialog) 0 0 var(--radius-dialog);
}
.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-5);
  padding: var(--space-6) var(--space-7) var(--space-5);
  border-bottom: var(--border-width) solid var(--border);
}
.side-drawer.wide {
  width: min(var(--drawer-wide), 100vw);
}
.drawer-header h2 {
  font-size: var(--text-xl);
  margin: 0;
}
.drawer-header > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.drawer-close {
  flex-shrink: 0;
  font-size: var(--text-title);
  border: 0;
  padding: 0 var(--space-1);
  line-height: 1;
  min-width: var(--control-height);
}
.drawer-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  scroll-padding-block: var(--space-4);
  padding: 0 var(--space-7) var(--space-6);
}
.drawer-footer {
  padding: var(--space-5) var(--space-7);
  border-top: var(--border-width) solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
  background: var(--surface);
}
@media (max-width: 650px) {
  .side-drawer {
    width: 100vw;
    border-radius: 0;
  }
  .drawer-header {
    padding: var(--space-5);
  }
  .drawer-body {
    padding-inline: var(--space-5);
  }
  .drawer-footer {
    padding: var(--space-4) var(--space-5);
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
  }
}
</style>
