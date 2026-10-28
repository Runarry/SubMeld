<script setup lang="ts">
import { reportBackend } from '../server/shared/report-export';
import { computed, ref, watch } from 'vue';
import {
  metricDefinitions,
  measurementText,
  executionCore,
  speedCoreLabels,
  type SpeedReport,
  type SpeedRow,
} from '../server/shared/miaospeed';
import { exportCsv, exportPng, measurementColors } from './reportExport';
import { formatTime } from './format';
import ListPagination from './ui/ListPagination.vue';
const props = defineProps<{ report: SpeedReport }>();
const emit = defineEmits<{ cancel: [] }>();
const search = ref(''),
  sort = ref('index'),
  page = ref(0),
  detail = ref<number | null>(null),
  error = ref('');
const visible = ref<string[]>([]);
const columns = computed(() => [
  ...props.report.metrics.map((id) => ({
    id,
    label: metricDefinitions.find((m) => m[0] === id)![1],
  })),
  ...props.report.scripts.map((s) => ({ id: 'script:' + s.id, label: s.name })),
]);
watch(
  () => props.report.id,
  () => {
    visible.value = columns.value.map((c) => c.id);
    page.value = 0;
    detail.value = null;
  },
  { immediate: true },
);
const shown = computed(() => columns.value.filter((c) => visible.value.includes(c.id)));
const filtered = computed(() => {
  const list = props.report.results.filter((row) =>
    (row.name + ' ' + row.protocol + ' ' + row.state)
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  );
  const number = (row: SpeedRow) => {
    const value = row.measurements.find((m) => m.id === sort.value)?.value;
    return typeof value === 'number' ? value : null;
  };
  return list.sort((a, b) =>
    sort.value === 'name'
      ? a.name.localeCompare(b.name)
      : sort.value === 'index'
        ? a.index - b.index
        : number(a) === null && number(b) === null
          ? a.index - b.index
          : number(a) === null
            ? 1
            : number(b) === null
              ? -1
              : sort.value.startsWith('SPEED') || sort.value.startsWith('USPEED')
                ? number(b)! - number(a)!
                : number(a)! - number(b)!,
  );
});
watch([search, sort], () => {
  page.value = 0;
});
const rows = computed(() => filtered.value.slice(page.value * 25, page.value * 25 + 25));
const selected = computed(() => props.report.results.find((row) => row.index === detail.value));
const labels: Record<string, string> = {
  running: '测试中',
  pending: '待测',
  completed: '已完成',
  partial: '部分未知',
  failed: '未完成',
  unsupported: '不支持',
  cancelled: '已取消',
  stale: '内容已变化',
  interrupted: '已中断',
};
function points(values: number[]) {
  const max = Math.max(1, ...values);
  return values
    .map((v, i) => `${10 + (i * 580) / Math.max(1, values.length - 1)},${120 - (v / max) * 105}`)
    .join(' ');
}
async function png() {
  error.value = '';
  try {
    await exportPng(props.report, rows.value, shown.value, page.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '导出失败。';
  }
}
</script>
<template>
  <section class="report-panel" aria-label="综合测试报告">
    <div class="page-header">
      <div>
        <h2>{{ report.name }}</h2>
        <p class="muted">
          {{ formatTime(report.createdAt) }} ·
          {{ report.origin === 'telegram' ? 'Telegram' : '网页' }} · miaospeed
          {{ report.backendVersion || '待返回' }} · 节点内核
          {{ speedCoreLabels[report.settings.nodeCore] }}
        </p>
        <p class="muted" style="overflow-wrap: anywhere">{{ reportBackend(report) }}</p>
      </div>
      <span class="report-state">{{ labels[report.state] }}</span>
    </div>
    <p role="status">
      {{ report.completed }} / {{ report.total }} 项已结束<span v-if="report.current">
        · {{ report.current }}</span
      >
    </p>
    <progress
      v-if="report.state === 'running'"
      :max="report.total"
      :value="report.completed"
      aria-label="综合测试进度"
    ></progress>
    <button v-if="report.state === 'running'" type="button" @click="emit('cancel')">
      取消综合测试
    </button>
    <p v-if="report.error" class="warning-note">{{ report.error }}</p>
    <details>
      <summary>测试参数与脚本版本</summary>
      <p>
        下行 {{ report.settings.downloadSeconds }} 秒 /
        {{ report.settings.downloadThreads }} 线程；上行 {{ report.settings.uploadSeconds }} 秒 /
        {{ report.settings.uploadThreads }} 线程；Ping {{ report.settings.pingCount }} 次。
      </p>
      <p class="muted">{{ report.settings.pingUrl }}</p>
      <p v-for="script in report.scripts" :key="script.id">
        {{ script.name }} · {{ script.revision.slice(0, 12) }} · {{ script.source }}
      </p>
    </details>
    <div class="toolbar report-toolbar">
      <label>筛选结果<input v-model="search" placeholder="节点名称或协议" /></label
      ><label
        >排序<select v-model="sort">
          <option value="index">输入顺序</option>
          <option value="name">节点名称</option>
          <option value="TEST_PING_RTT">RTT 从低到高</option>
          <option value="SPEED_AVERAGE">下行从高到低</option>
          <option value="USPEED_AVERAGE">上行从高到低</option>
        </select></label
      ><button type="button" @click="png">导出本页 PNG</button
      ><button type="button" @click="exportCsv(report, filtered, shown)">导出筛选结果 CSV</button>
    </div>
    <details>
      <summary>展示列（{{ shown.length }}）</summary>
      <div class="test-options">
        <label v-for="column in columns" :key="column.id"
          ><input v-model="visible" type="checkbox" :value="column.id" />{{ column.label }}</label
        >
      </div>
    </details>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="report-scroll">
      <table>
        <thead>
          <tr>
            <th>节点 / 状态</th>
            <th v-for="column in shown" :key="column.id">{{ column.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.index">
            <th>
              <button type="button" class="text-button" @click="detail = row.index">
                {{ row.name }}</button
              ><small>{{ row.protocol }} · {{ labels[row.state] }}</small
              ><small v-if="row.stale">快照已过期</small>
            </th>
            <td
              v-for="column in shown"
              :key="column.id"
              :class="
                'measurement-' +
                (row.measurements.find((m) => m.id === column.id)?.status || 'unknown')
              "
              :style="measurementColors(row.measurements.find((m) => m.id === column.id))"
              :title="row.measurements.find((m) => m.id === column.id)?.message || row.message"
            >
              <span>{{
                row.measurements.find((m) => m.id === column.id)
                  ? measurementText(row.measurements.find((m) => m.id === column.id)!)
                  : labels[row.state]
              }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ListPagination
      :page="page"
      :total="filtered.length"
      :disabled="false"
      @turn="(delta) => (page += delta)"
    />
    <section v-if="selected" class="test-detail" aria-label="节点检测详情">
      <div class="page-header">
        <h3>{{ selected.name }} · 检测详情</h3>
        <button type="button" @click="detail = null">关闭详情</button>
      </div>
      <p>{{ selected.message }}</p>
      <p>
        执行内核：{{ speedCoreLabels[executionCore(report.settings)] }}
        {{ selected.coreVersion }}
      </p>
      <p v-if="selected.stale" class="warning-note">对象内容已变化，此报告仅代表当时的测试快照。</p>
      <div class="measurement-grid">
        <article v-for="metric in selected.measurements" :key="metric.id">
          <h4>{{ metric.label }}</h4>
          <p>{{ measurementText(metric) }}</p>
          <small>{{ metric.message }}</small
          ><template v-if="metric.samples.length"
            ><svg viewBox="0 0 600 135" role="img" :aria-label="metric.label + '曲线'">
              <polyline
                :points="points(metric.samples)"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              />
            </svg>
            <p class="sample-values">
              {{
                metric.unit === 'B/s'
                  ? metric.samples.map((value) => measurementText({ ...metric, value })).join(' / ')
                  : metric.samples.join(' / ') + ' ' + metric.unit
              }}
            </p></template
          >
          <ul v-if="metric.geo.length">
            <li v-for="geo in metric.geo" :key="geo.ip">
              {{ geo.ip }} · {{ geo.country }} · AS{{ geo.asn }} · {{ geo.organization || geo.isp }}
            </li>
          </ul>
        </article>
      </div>
    </section>
  </section>
</template>
