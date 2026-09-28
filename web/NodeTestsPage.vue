<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ListPagination from './ui/ListPagination.vue';
import StatusBadge from './ui/StatusBadge.vue';
import { formatTime } from './format';
import {
  coreLabels,
  testStatuses,
  currentTestSchema,
  kernelsSchema,
  testSettingsSchema,
  testResultsSchema,
  type TestSubject,
  type TestResult,
  type TestBatch,
  type KernelStatus,
  DEFAULT_PROBE_URL,
} from '../server/shared/node-tests';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  subjects: TestSubject[];
}>();
const batch = ref<TestBatch | null>(null),
  kernels = ref<KernelStatus[]>([]),
  savedResults = ref<TestResult[]>([]);
const url = ref(''),
  savedUrl = ref(''),
  busy = ref(false),
  message = ref(''),
  pollError = ref('');
const page = ref(0),
  mode = ref<'batch' | 'saved'>(props.subjects.length ? 'saved' : 'batch');
const coreBusy = computed(() => kernels.value.some((kernel) => kernel.state !== 'idle'));
const results = computed(() =>
  mode.value === 'saved'
    ? savedResults.value.slice(page.value * 25, page.value * 25 + 25)
    : (batch.value?.results ?? []),
);
const total = computed(() =>
  mode.value === 'saved' ? savedResults.value.length : (batch.value?.completed ?? 0),
);
let alive = true,
  ticket = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  const current = ++ticket,
    currentPage = page.value;
  try {
    const [job, versions, saved] = await Promise.all([
      props.api('/api/node-tests/current?page=' + currentPage),
      props.api('/api/kernels'),
      props.subjects.length
        ? props.api('/api/node-tests/results/query', { subjects: props.subjects })
        : Promise.resolve({ results: [] }),
    ]);
    if (!alive || current !== ticket) return;
    batch.value = currentTestSchema.parse(job).batch;
    kernels.value = kernelsSchema.parse(versions).kernels;
    savedResults.value = testResultsSchema.parse(saved).results;
    pollError.value = '';
  } catch (error) {
    if (alive && current === ticket)
      pollError.value = error instanceof Error ? error.message : '测试状态读取失败。';
  }
}
async function poll() {
  await refresh();
  if (alive) timer = setTimeout(poll, 2000);
}
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await action();
    await refresh();
  } catch (error) {
    if (alive) message.value = error instanceof Error ? error.message : '操作失败。';
  } finally {
    if (alive) busy.value = false;
  }
}
async function saveUrl() {
  await act(async () => {
    const value = testSettingsSchema.parse(
      await props.api('/api/node-tests/settings', { url: url.value }, 'PATCH'),
    );
    if (alive) {
      url.value = value.url;
      savedUrl.value = value.url;
      message.value = '已保存测试地址，正在运行的批次继续使用原地址。';
    }
  });
}
async function update(target: KernelStatus['target']) {
  await act(async () => {
    await props.api('/api/kernels/' + target + '/update', {});
    if (alive) message.value = '已开始安装官方最新正式版，完成前继续使用当前版本。';
  });
}
watch(
  () => props.subjects,
  () => {
    page.value = 0;
    mode.value = props.subjects.length ? 'saved' : 'batch';
    void refresh();
  },
);
watch(mode, () => {
  page.value = 0;
  void refresh();
});
onMounted(() => {
  void act(async () => {
    const value = testSettingsSchema.parse(await props.api('/api/node-tests/settings'));
    if (alive) {
      url.value = value.url;
      savedUrl.value = value.url;
    }
  });
  void poll();
});
onBeforeUnmount(() => {
  alive = false;
  ticket++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="library node-tests-page" aria-label="节点测试">
    <div class="page-header">
      <div>
        <h1>节点测试</h1>
        <p class="muted">
          从部署 SubMeld 的主机，经真实内核访问 HTTPS 地址。请在节点或两跳链列表中选择测试对象。
        </p>
      </div>
    </div>
    <p v-if="message || pollError" role="status" class="notice">{{ message || pollError }}</p>
    <form class="test-settings" @submit.prevent="saveUrl">
      <label
        >HTTPS 测试地址<input v-model="url" type="url" maxlength="2048" :disabled="busy" required
      /></label>
      <button type="submit" :disabled="busy || url === savedUrl">保存测试地址</button>
      <button
        type="button"
        :disabled="busy || url === DEFAULT_PROBE_URL"
        @click="
          url = DEFAULT_PROBE_URL;
          message = '';
        "
      >
        使用默认测试地址
      </button>
      <p class="muted">
        每个内核请求一次；HTTPS 耗时包含代理连接、TLS 握手和响应头，不包含内核启动。不跟随重定向。
      </p>
    </form>
    <section aria-label="内核管理">
      <div class="page-header">
        <h2>内核管理</h2>
        <button
          type="button"
          :disabled="busy || coreBusy"
          @click="
            act(async () => {
              await api('/api/kernels/check', {});
            })
          "
        >
          检查最新正式版
        </button>
      </div>
      <div class="kernel-grid">
        <article v-for="kernel in kernels" :key="kernel.target" class="kernel-card">
          <h3>{{ coreLabels[kernel.target] }}</h3>
          <p>已安装：{{ kernel.currentVersion || '未安装' }}</p>
          <p>最新正式版：{{ kernel.latestVersion || '尚未检查' }}</p>
          <small>检查时间：{{ kernel.checkedAt ? formatTime(kernel.checkedAt) : '—' }}</small>
          <p v-if="kernel.state !== 'idle'" role="status">
            {{ kernel.state === 'checking' ? '正在检查…' : '正在下载、校验和自检…' }}
          </p>
          <p v-if="kernel.error" class="error-note">{{ kernel.error }}</p>
          <button type="button" :disabled="busy || coreBusy" @click="update(kernel.target)">
            {{ kernel.currentVersion ? '更新' : '安装' }} {{ coreLabels[kernel.target] }}
          </button>
        </article>
      </div>
    </section>
    <section aria-label="测试进度">
      <div class="page-header">
        <h2>测试结果</h2>
        <div class="toolbar">
          <button type="button" :class="{ primary: mode === 'batch' }" @click="mode = 'batch'">
            当前批次
          </button>
          <button
            v-if="subjects.length"
            type="button"
            :class="{ primary: mode === 'saved' }"
            @click="mode = 'saved'"
          >
            所选对象最近结果
          </button>
        </div>
      </div>
      <template v-if="batch">
        <p role="status">
          {{
            batch.state === 'running'
              ? '测试中'
              : batch.state === 'completed'
                ? '测试完成'
                : batch.state === 'failed'
                  ? '测试失败'
                  : '测试已取消'
          }}
          · {{ batch.completed }} / {{ batch.total }}
          <span v-if="batch.current">
            · {{ batch.current.name }} / {{ coreLabels[batch.current.core] }}</span
          >
        </p>
        <p v-if="batch.error" class="error-note">{{ batch.error }}</p>
        <progress :value="batch.completed" :max="batch.total" aria-label="测试进度"></progress>
        <button
          v-if="batch.state === 'running'"
          type="button"
          :disabled="busy"
          @click="
            act(async () => {
              if (batch) await api('/api/node-tests/' + batch.id + '/cancel', {});
            })
          "
        >
          取消测试
        </button>
      </template>
      <p v-else class="muted">当前没有测试批次。已保存的最近结果可从各节点列表查看。</p>
      <ul class="test-results">
        <li
          v-for="result in results"
          :key="
            result.subject.kind +
            (result.subject.kind === 'node' ? result.subject.resourceId : result.subject.id) +
            ('nodeIndex' in result.subject ? result.subject.nodeIndex : '') +
            result.core
          "
        >
          <div class="toolbar">
            <strong>{{ result.name }}</strong
            ><span>{{ coreLabels[result.core] }} {{ result.coreVersion || '未安装' }}</span>
            <StatusBadge
              :tone="
                result.stale || result.status === 'unsupported'
                  ? 'off'
                  : result.status === 'passed'
                    ? 'ok'
                    : 'error'
              "
              :label="testStatuses[result.status]"
            />
            <span v-if="result.latencyMs !== null">HTTPS {{ result.latencyMs }} ms</span>
          </div>
          <p v-if="result.stale" class="warning-note">
            内容、测试地址或内核版本已变化，此结果需要重新测试。
          </p>
          <p>{{ result.message }}</p>
          <small>{{ formatTime(result.testedAt) }} · {{ result.url }}</small>
        </li>
      </ul>
      <p v-if="!results.length" class="empty-state">暂无已完成的测试结果。</p>
      <ListPagination
        :page="page"
        :total="total"
        :disabled="busy"
        prev-label="上一页测试"
        next-label="下一页测试"
        @turn="
          (delta) => {
            page += delta;
            void refresh();
          }
        "
      />
    </section>
  </section>
</template>
