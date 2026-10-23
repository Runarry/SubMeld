<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
type Option = { value: string; label: string; hint?: string; disabled?: boolean };
const props = defineProps<{
  modelValue: string;
  options: Option[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const id = useId();
const open = ref(false),
  query = ref(''),
  index = ref(-1);
const selected = computed(() => props.options.find((option) => option.value === props.modelValue));
const filtered = computed(() =>
  props.options.filter((option) =>
    (option.label + ' ' + (option.hint ?? '')).toLowerCase().includes(query.value.toLowerCase()),
  ),
);
function show() {
  if (!props.disabled) {
    query.value = '';
    index.value = -1;
    open.value = true;
  }
}
function choose(option: Option) {
  if (!option.disabled) {
    emit('update:modelValue', option.value);
    open.value = false;
    input.value?.focus();
  }
}
function key(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    open.value = false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open.value) show();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    for (let n = 0; n < filtered.value.length; n++) {
      index.value = (index.value + direction + filtered.value.length) % filtered.value.length;
      if (!filtered.value[index.value]?.disabled) break;
    }
    document.getElementById(id + '-' + index.value)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && open.value) {
    event.preventDefault();
    const option = filtered.value[index.value] ?? filtered.value.find((item) => !item.disabled);
    if (option) choose(option);
  }
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>

<template>
  <div ref="root" class="search-select">
    <label :for="id">{{ label }}</label>
    <div class="select-input">
      <input
        :id="id"
        ref="input"
        role="combobox"
        :aria-label="label"
        :aria-controls="id + '-list'"
        :aria-expanded="open"
        aria-autocomplete="list"
        :aria-activedescendant="open && index >= 0 ? id + '-' + index : undefined"
        :value="open ? query : (selected?.label ?? '')"
        :placeholder="placeholder ?? '搜索并选择'"
        :disabled="disabled"
        autocomplete="off"
        @click="!open && show()"
        @focus="show"
        @input="
          query = ($event.target as HTMLInputElement).value;
          index = -1;
          open = true;
        "
        @keydown="key"
      />
      <span aria-hidden="true">⌄</span>
    </div>
    <div v-if="open" :id="id + '-list'" role="listbox" :aria-label="label" class="select-options">
      <p v-if="!filtered.length">没有匹配的选项</p>
      <button
        v-for="(option, i) in filtered"
        :id="id + '-' + i"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        :aria-disabled="option.disabled || undefined"
        :class="{ highlighted: i === index, unavailable: option.disabled }"
        tabindex="-1"
        @mousedown.prevent
        @click="choose(option)"
      >
        <span>{{ option.label }}</span
        ><small v-if="option.hint">{{ option.hint }}</small>
      </button>
    </div>
  </div>
</template>

<style scoped>
.search-select {
  position: relative;
  min-width: 0;
}
label {
  margin-bottom: var(--space-2);
}
.select-input {
  position: relative;
}
.select-input input {
  padding-right: var(--space-8);
}
.select-input > span {
  position: absolute;
  right: var(--space-3);
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--muted);
}
.select-options {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  right: 0;
  z-index: var(--z-popover);
  max-height: 250px;
  overflow: auto;
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-1);
  background: var(--surface);
  box-shadow: var(--shadow-popover);
}
.select-options button {
  display: grid;
  justify-content: stretch;
  text-align: left;
  width: 100%;
  border: 0;
  padding: var(--space-3);
  gap: var(--space-1);
  color: var(--text);
  overflow-wrap: anywhere;
}
.select-options button.highlighted,
.select-options button[aria-selected='true'] {
  background: var(--row-active);
}
.select-options small,
.select-options p {
  font-size: var(--text-xs);
  color: var(--muted);
  font-weight: var(--weight-normal);
}
.select-options p {
  padding: var(--space-2);
  margin: 0;
}
.select-options .unavailable {
  opacity: var(--disabled-opacity);
  cursor: not-allowed;
}
</style>
