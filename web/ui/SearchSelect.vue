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
  margin-bottom: 6px;
}
.select-input {
  position: relative;
}
.select-input input {
  padding-right: 30px;
}
.select-input > span {
  position: absolute;
  right: 12px;
  top: 8px;
  pointer-events: none;
  color: var(--muted);
}
.select-options {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 90;
  max-height: 250px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px;
  background: white;
  box-shadow: 0 8px 24px #14231e20;
}
.select-options button {
  display: grid;
  text-align: left;
  width: 100%;
  border: 0;
  padding: 10px;
  gap: 3px;
  color: var(--text);
  overflow-wrap: anywhere;
}
.select-options button.highlighted,
.select-options button[aria-selected='true'] {
  background: var(--row-active);
}
.select-options small,
.select-options p {
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
}
.select-options p {
  padding: 8px;
  margin: 0;
}
.select-options .unavailable {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
