<script setup lang="ts">
import { ref } from 'vue';
import { scriptConfigSchema, scriptsSchema, type TestScript } from '../server/shared/miaospeed';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  scripts: TestScript[];
}>();
const emit = defineEmits<{ updated: [scripts: TestScript[]] }>();
const selected = ref<TestScript | null>(null),
  editing = ref(false),
  busy = ref(false),
  message = ref('');
const form = ref(
  scriptConfigSchema.parse({
    name: '新的检测脚本',
    content:
      "function handler() {\n  return { text: '请实现检测逻辑', background: '142,140,142' };\n}",
  }),
);
function edit(script?: TestScript) {
  selected.value = script ?? null;
  form.value = script
    ? scriptConfigSchema.strip().parse(script)
    : scriptConfigSchema.parse({
        name: '新的检测脚本',
        content:
          "function handler() {\n  return { text: '未知：尚未实现', background: '142,140,142' };\n}",
      });
  editing.value = true;
  message.value = '';
}
async function act(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    emit('updated', scriptsSchema.parse(await action()).scripts);
    editing.value = false;
    message.value = '检测脚本已保存。';
  } catch (error) {
    message.value = error instanceof Error ? error.message : '操作失败。';
  } finally {
    busy.value = false;
  }
}
async function save() {
  await act(() =>
    props.api(
      '/api/miaospeed/scripts' + (selected.value ? '/' + selected.value.id : ''),
      { ...form.value, ...(selected.value ? { revision: selected.value.revision } : {}) },
      selected.value ? 'PATCH' : 'POST',
    ),
  );
}
</script>
<template>
  <section aria-label="检测脚本管理">
    <div class="page-header">
      <div>
        <h2>检测脚本</h2>
        <p class="muted">
          脚本保存在 Sub-Store 原生文件中，由 miaospeed 执行 JavaScript handler()。返回 text 和
          background；未知结果请明确标记。
        </p>
      </div>
      <div class="toolbar">
        <button type="button" :disabled="busy" @click="edit()">添加脚本</button
        ><button
          type="button"
          :disabled="busy"
          @click="act(() => api('/api/miaospeed/scripts/initialize', {}))"
        >
          补齐缺失内置脚本
        </button>
      </div>
    </div>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <form v-if="editing" class="test-editor" @submit.prevent="save">
      <label>脚本名称<input v-model="form.name" maxlength="100" required /></label
      ><label>说明<input v-model="form.description" maxlength="1000" /></label
      ><label>来源<input v-model="form.source" maxlength="2048" /></label
      ><label
        >超时（毫秒）<input
          v-model.number="form.timeoutMs"
          type="number"
          min="1000"
          max="60000"
          required /></label
      ><label><input v-model="form.enabled" type="checkbox" />启用</label
      ><label
        >JavaScript 脚本<textarea v-model="form.content" rows="18" spellcheck="false" required />
      </label>
      <div class="toolbar">
        <button type="submit" :disabled="busy">保存脚本</button
        ><button type="button" @click="editing = false">取消编辑</button>
      </div>
    </form>
    <ul class="test-script-list">
      <li v-for="script in scripts" :key="script.id">
        <div>
          <strong>{{ script.name }}</strong
          ><span class="muted">
            · {{ script.enabled ? '已启用' : '已停用' }} ·
            {{ script.modified ? '自定义内容' : '内置版本' }}</span
          >
          <p>{{ script.description }}</p>
          <small>{{ script.source }}</small>
        </div>
        <div class="toolbar">
          <button type="button" :disabled="busy" @click="edit(script)">
            编辑 {{ script.name }}</button
          ><button
            v-if="script.builtinId"
            type="button"
            :disabled="busy"
            @click="
              act(() =>
                api('/api/miaospeed/scripts/' + script.id + '/restore', {
                  revision: script.revision,
                }),
              )
            "
          >
            用内置版本覆盖</button
          ><button
            v-else
            type="button"
            :disabled="busy"
            @click="
              act(() =>
                api('/api/miaospeed/scripts/' + script.id, { revision: script.revision }, 'DELETE'),
              )
            "
          >
            删除脚本
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
