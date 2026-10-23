<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { supportFilesSchema, type SupportFile } from '../server/shared/support-files';
import ModalDialog from './ui/ModalDialog.vue';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const files = ref<SupportFile[]>([]),
  selected = ref<SupportFile | null>(null),
  busy = ref(false),
  message = ref('');
async function load() {
  files.value = supportFilesSchema.parse(await props.api('/api/integrations/files')).files;
}
async function update() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await props.api(
      '/api/integrations/files/' + selected.value.id,
      { revision: selected.value.revision },
      'PATCH',
    );
    selected.value = null;
    await load();
    message.value = '已将当前内置版本写入 Sub-Store。';
  } catch (e) {
    message.value = e instanceof Error ? e.message : '更新失败。';
  } finally {
    busy.value = false;
  }
}
onMounted(
  () =>
    void load().catch((e) => {
      message.value = e instanceof Error ? e.message : '读取失败。';
    }),
);
</script>
<template>
  <section class="page">
    <header class="page-header"><h1>配套脚本与模板</h1></header>
    <section class="panel support-files" aria-label="配套文件管理">
      <p>文件保存在 Sub-Store。启动不会覆盖自定义内容；可在这里手动写入当前内置版本。</p>
      <p v-if="!files.length">创建第一个输出方案后，这里将显示配套文件。</p>
      <article v-for="file in files" :key="file.id">
        <div>
          <strong>{{ file.name }}</strong>
          <p>
            {{ file.matchesBuiltin ? '与当前内置版本一致' : '与内置版本不同，可能包含自定义修改' }}
          </p>
        </div>
        <button :disabled="busy || file.matchesBuiltin" @click="selected = file">
          使用当前内置版本
        </button>
      </article>
      <p v-if="message" role="status">{{ message }}</p>
    </section>
    <ModalDialog v-if="selected" label="更新配套文件" :dismissible="!busy" @close="selected = null"
      ><h2>更新 {{ selected.name }}</h2>
      <p>
        将此文件恢复为内置本地内容，清除该文件的来源和处理操作。引用此文件的输出会立即使用新内容。
      </p>
      <p v-if="message" role="alert">{{ message }}</p>
      <template #footer
        ><button :disabled="busy" @click="selected = null">取消</button
        ><button :disabled="busy" @click="update">确认更新</button></template
      ></ModalDialog
    >
  </section>
</template>
<style scoped>
.support-files > p {
  margin: var(--space-3) 0;
}
.support-files article {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) 0;
  border-top: var(--border-width) solid var(--border);
}
.support-files article div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.support-files article p {
  font-size: var(--text-sm);
  color: var(--muted);
}
@media (max-width: 650px) {
  .support-files article {
    display: block;
  }
  .support-files article button {
    margin-top: var(--space-2);
  }
}
</style>
