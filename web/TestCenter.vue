<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { z } from 'zod';
import NodeTestsPage from './NodeTestsPage.vue';
import TestReport from './TestReport.vue';
import TestScripts from './TestScripts.vue';
import TelegramSettings from './TelegramSettings.vue';
import ListPagination from './ui/ListPagination.vue';
import { formatTime } from './format';
import { nodeListSchema, type NodeView, type Resource } from '../server/shared/resources';
import { type TestSubject } from '../server/shared/node-tests';
import {
  metricDefinitions,
  metricIds,
  scriptsSchema,
  speedSettingsSchema,
  speedCoreLabels,
  speedPreviewSchema,
  speedReportSchema,
  reportListSchema,
  speedStatusSchema,
  type TestScript,
  type SpeedPreview,
  type SpeedReport,
  type SpeedSubject,
} from '../server/shared/miaospeed';
const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  subjects: TestSubject[];
  initialTab?: 'comprehensive' | 'cores';
}>();
const tab = ref<string>(props.initialTab ?? 'comprehensive');
const saved = ref<TestSubject[]>([...props.subjects]),
  sourceMode = ref<'saved' | 'temporary'>('saved');
const settings = ref(speedSettingsSchema.parse({})),
  scripts = ref<TestScript[]>([]),
  metrics = ref<string[]>([...metricIds]),
  selectedScripts = ref<string[]>([]);
const status = ref<z.infer<typeof speedStatusSchema> | null>(null),
  report = ref<SpeedReport | null>(null);
const busy = ref(false),
  message = ref(''),
  name = ref('综合测试');
const inputKind = ref<'text' | 'url' | 'file'>('text'),
  content = ref(''),
  url = ref(''),
  fileName = ref('临时节点'),
  preview = ref<SpeedPreview | null>(null),
  temporaryIndices = ref<number[]>([]);
const picker = ref(false),
  pickerPage = ref(0),
  pickerTotal = ref(0),
  search = ref(''),
  resource = ref(''),
  resources = ref<Resource[]>([]),
  nodes = ref<NodeView[]>([]);
const historyPage = ref(0),
  history = ref<z.infer<typeof reportListSchema>>({ reports: [], total: 0 });
type ReportSelection = { kind: 'latest' } | { kind: 'pinned'; id: string };
let alive = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  pollEpoch = 0,
  reportRequest = 0,
  reportLoading = false;
let reportSelection: ReportSelection = { kind: 'latest' };
function selectReport(selection: ReportSelection) {
  reportSelection = selection;
  reportLoading = true;
  report.value = null;
  return ++reportRequest;
}
function currentReportRead(selection: ReportSelection, request: number) {
  return alive && reportSelection === selection && reportRequest === request;
}
const subject = (node: NodeView): TestSubject => ({
  kind: 'node',
  resourceId: node.resourceId,
  revision: node.revision,
  snapshotHash: node.snapshotHash,
  nodeIndex: node.nodeIndex,
});
const key = (value: TestSubject) => value.resourceId + ':' + value.nodeIndex;
function chosen(value: TestSubject) {
  return saved.value.some((v) => key(v) === key(value));
}
function toggle(value: TestSubject) {
  saved.value = chosen(value)
    ? saved.value.filter((v) => key(v) !== key(value))
    : [...saved.value, value];
}
const selectedSubjects = computed<SpeedSubject[]>(() =>
  sourceMode.value === 'saved'
    ? saved.value
    : preview.value
      ? temporaryIndices.value.map((nodeIndex) => ({
          kind: 'temporary',
          previewId: preview.value!.id,
          nodeIndex,
        }))
      : [],
);
const enabledScripts = computed(() => scripts.value.filter((script) => script.enabled));
const numericFields = [
  ['downloadSeconds', '下行时长（秒）', 1, undefined],
  ['uploadSeconds', '上行时长（秒）', 2, undefined],
  ['downloadThreads', '下行线程', 1, 32],
  ['uploadThreads', '上行线程', 1, 32],
  ['pingCount', 'Ping 次数', 1, 16],
  ['retries', '尝试次数', 1, 10],
  ['requestTimeoutMs', '单次请求超时（毫秒）', 10, 10000],
  ['timeoutSeconds', '每项任务等待上限（秒）', 10, 10000],
] as const;
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await action();
  } catch (error) {
    if (alive) message.value = error instanceof Error ? error.message : '操作失败。';
  } finally {
    if (alive) busy.value = false;
  }
}
async function loadPicker() {
  const data = nodeListSchema.parse(
    await props.api(
      '/api/nodes?page=' +
        pickerPage.value +
        '&resourceId=' +
        encodeURIComponent(resource.value) +
        '&search=' +
        encodeURIComponent(search.value),
    ),
  );
  if (alive) {
    nodes.value = data.nodes;
    resources.value = data.resources;
    pickerTotal.value = data.total;
    if (data.errors.length) message.value = data.errors.map((e) => e.message).join(' ');
  }
}
async function choose() {
  picker.value = true;
  pickerPage.value = 0;
  sourceMode.value = 'saved';
  await act(loadPicker);
}
async function previewInput() {
  await act(async () => {
    const data = speedPreviewSchema.parse(
      await props.api('/api/miaospeed/preview', {
        kind: inputKind.value,
        name: fileName.value,
        content: content.value,
        url: url.value,
      }),
    );
    if (alive) {
      preview.value = data;
      temporaryIndices.value = data.nodes.map((node) => node.index);
    }
  });
}
async function file(event: Event) {
  const element = event.target as HTMLInputElement;
  const selected = element.files?.[0];
  if (!selected) return;
  if (selected.size > 4 * 1024 * 1024) {
    message.value = '配置文件不能超过 4 MiB。';
    return;
  }
  content.value = await selected.text();
  fileName.value = selected.name;
  preview.value = null;
  element.value = '';
}
async function start() {
  await act(async () => {
    const selection: ReportSelection = { kind: 'latest' };
    const request = selectReport(selection);
    try {
      const result = speedReportSchema.parse(
        await props.api('/api/miaospeed/tests', {
          name: name.value,
          subjects: selectedSubjects.value,
          metrics: metrics.value,
          scripts: enabledScripts.value
            .filter((s) => selectedScripts.value.includes(s.id))
            .map(({ id, revision }) => ({ id, revision })),
          settings: settings.value,
        }),
      );
      if (!currentReportRead(selection, request)) return;
      report.value = result;
      content.value = '';
      url.value = '';
      preview.value = null;
      temporaryIndices.value = [];
      message.value = '已开始综合测试，离开页面后继续运行。';
    } catch (error) {
      if (currentReportRead(selection, request)) throw error;
    } finally {
      if (currentReportRead(selection, request)) reportLoading = false;
    }
    if (currentReportRead(selection, request)) await refresh();
  });
}
async function coreTest() {
  await act(async () => {
    await props.api('/api/node-tests', { subjects: saved.value });
    message.value = '三内核连通性检查已开始。';
    await refresh();
  });
}
async function readReport(selection: ReportSelection, historyLookup = false) {
  const request = ++reportRequest;
  try {
    if (historyLookup && selection.kind === 'pinned') {
      const value = speedReportSchema.parse(
        await props.api('/api/miaospeed/reports/' + selection.id),
      );
      if (currentReportRead(selection, request) && value.id === selection.id) report.value = value;
      return;
    }
    const current = z
      .object({ report: speedReportSchema.nullable() })
      .parse(await props.api('/api/miaospeed/tests/current')).report;
    if (!currentReportRead(selection, request)) return;
    if (selection.kind === 'latest' || current?.id === selection.id) report.value = current;
    else {
      reportLoading = true;
      const value = speedReportSchema.parse(
        await props.api('/api/miaospeed/reports/' + selection.id),
      );
      if (currentReportRead(selection, request) && value.id === selection.id) report.value = value;
    }
  } catch (error) {
    if (currentReportRead(selection, request))
      message.value = error instanceof Error ? error.message : '报告读取失败。';
  } finally {
    if (currentReportRead(selection, request)) reportLoading = false;
  }
}
async function refresh() {
  const epoch = ++pollEpoch;
  const selection = reportSelection;
  try {
    const [state] = await Promise.all([
      props.api('/api/miaospeed/status'),
      !reportLoading && (selection.kind === 'latest' || report.value?.state === 'running')
        ? readReport(selection)
        : Promise.resolve(),
    ]);
    if (alive && epoch === pollEpoch && reportSelection === selection)
      status.value = speedStatusSchema.parse(state);
  } catch (error) {
    if (alive && epoch === pollEpoch && reportSelection === selection)
      message.value = error instanceof Error ? error.message : '状态读取失败。';
  }
}
async function poll() {
  await refresh();
  if (alive) timer = setTimeout(poll, 2000);
}
async function loadHistory() {
  history.value = reportListSchema.parse(
    await props.api('/api/miaospeed/reports?page=' + historyPage.value),
  );
}
async function viewReport(id: string) {
  await act(async () => {
    const selection: ReportSelection = { kind: 'pinned', id };
    selectReport(selection);
    await readReport(selection, true);
  });
}
function repeatReport() {
  const previous = report.value;
  if (!previous) return;
  tab.value = 'comprehensive';
  settings.value = { ...previous.settings };
  metrics.value = [...previous.metrics];
  selectedScripts.value = previous.scripts
    .filter((ref) =>
      scripts.value.some((s) => s.id === ref.id && s.revision === ref.revision && s.enabled),
    )
    .map((s) => s.id);
  name.value = previous.name.slice(0, 115) + ' · 重测';
  const temporary = previous.results.some((row) => row.subject.kind === 'temporary');
  const stale = previous.results.some((row) => row.stale);
  if (temporary) {
    sourceMode.value = 'temporary';
    preview.value = null;
    content.value = '';
    url.value = '';
    temporaryIndices.value = [];
  } else {
    sourceMode.value = 'saved';
    saved.value = stale
      ? []
      : previous.results.flatMap((row) => (row.subject.kind === 'temporary' ? [] : [row.subject]));
  }
  message.value = temporary
    ? '已载入报告参数，请重新提供临时节点输入并预览。'
    : stale
      ? '已载入报告参数，请重新选择内容已变化的测试对象。'
      : '已载入报告参数和对象，请核对后开始测试。';
  if (selectedScripts.value.length !== previous.scripts.length)
    message.value += ' 部分脚本已更新或停用，请重新勾选。';
}
function preset(kind: string) {
  metrics.value =
    kind === 'all'
      ? [...metricIds]
      : kind === 'speed'
        ? metricIds.filter((id) => id.includes('SPEED') || id === 'TEST_PING_RTT')
        : kind === 'topology'
          ? ['GEOIP_INBOUND', 'GEOIP_OUTBOUND', 'UDP_TYPE']
          : ['TEST_PING_RTT', 'TEST_PING_CONN'];
  selectedScripts.value =
    kind === 'all' || kind === 'scripts' ? enabledScripts.value.map((s) => s.id) : [];
}
watch(
  () => props.subjects,
  (values) => {
    saved.value = [...values];
    sourceMode.value = 'saved';
  },
);
watch(tab, (value) => {
  if (value === 'history') void act(loadHistory);
  if (value === 'cores') sourceMode.value = 'saved';
});
onMounted(() => {
  void act(async () => {
    const [configuration, catalog] = await Promise.all([
      props.api('/api/miaospeed/settings'),
      props.api('/api/miaospeed/scripts'),
    ]);
    if (!alive) return;
    settings.value = speedSettingsSchema.parse(configuration);
    scripts.value = scriptsSchema.parse(catalog).scripts;
    if (!scripts.value.length)
      scripts.value = scriptsSchema.parse(
        await props.api('/api/miaospeed/scripts/initialize', {}),
      ).scripts;
    if (alive) {
      selectedScripts.value = scripts.value.filter((s) => s.enabled).map((s) => s.id);
      void poll();
    }
  });
});
onBeforeUnmount(() => {
  alive = false;
  pollEpoch++;
  reportRequest++;
  clearTimeout(timer);
  content.value = '';
  url.value = '';
});
</script>
<template>
  <section class="test-center library" aria-label="测试中心">
    <header class="page-header">
      <div>
        <h1>测试中心</h1>
        <p class="muted">从当前部署位置测试节点的速度、稳定性、解锁和拓扑。</p>
      </div>
      <span class="report-state">{{
        status?.active ? '有任务运行中' : status?.configured ? '后端已配置' : '等待后端配置'
      }}</span>
    </header>
    <nav class="test-tabs" aria-label="测试中心栏目">
      <button
        v-for="item in [
          ['comprehensive', '综合测试'],
          ['cores', '三内核检查'],
          ['history', '历史报告'],
          ['scripts', '检测脚本'],
          ['telegram', 'Telegram'],
          ['backend', '后端状态'],
        ]"
        :key="item[0]"
        type="button"
        :class="{ primary: tab === item[0] }"
        @click="tab = item[0]!"
      >
        {{ item[1] }}
      </button>
    </nav>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <template v-if="tab === 'comprehensive' || tab === 'cores'">
      <section class="test-card" aria-label="选择测试对象">
        <div class="page-header">
          <h2>测试对象</h2>
          <span>{{ selectedSubjects.length }} 项已选</span>
        </div>
        <div class="toolbar">
          <button
            type="button"
            :class="{ primary: sourceMode === 'saved' }"
            @click="sourceMode = 'saved'"
          >
            已保存节点</button
          ><button
            v-if="tab === 'comprehensive'"
            type="button"
            :class="{ primary: sourceMode === 'temporary' }"
            @click="sourceMode = 'temporary'"
          >
            临时节点
          </button>
        </div>
        <template v-if="sourceMode === 'saved'"
          ><p>已选 {{ saved.length }} 项；可从节点页面选择，或在这里添加。</p>
          <div class="toolbar">
            <button type="button" :disabled="busy" @click="choose">选择节点</button
            ><button type="button" :disabled="!saved.length" @click="saved = []">清空所选</button>
          </div>
          <div v-if="picker" class="test-picker">
            <div class="toolbar">
              <select
                v-model="resource"
                aria-label="选择订阅"
                @change="
                  pickerPage = 0;
                  act(loadPicker);
                "
              >
                <option value="">全部订阅</option>
                <option v-for="item in resources" :key="item.id" :value="item.id">
                  {{ item.name }}
                </option></select
              ><input v-model="search" placeholder="搜索节点" aria-label="搜索测试节点" /><button
                type="button"
                @click="
                  pickerPage = 0;
                  act(loadPicker);
                "
              >
                搜索</button
              ><button type="button" @click="picker = false">收起选择</button>
            </div>
            <div class="test-options">
              <label v-for="node in nodes" :key="key(subject(node))"
                ><input
                  type="checkbox"
                  :checked="chosen(subject(node))"
                  @change="toggle(subject(node))"
                />{{ node.name }} · {{ node.protocol }}</label
              >
            </div>
            <ListPagination
              :page="pickerPage"
              :total="pickerTotal"
              :disabled="busy"
              @turn="
                (delta) => {
                  pickerPage += delta;
                  act(loadPicker);
                }
              "
            />
          </div>
        </template>
        <template v-else
          ><p class="muted">
            仅在内存中预览；30 分钟闲置后过期，测试开始后清除输入，历史报告不会保留节点凭据。
          </p>
          <label
            >输入方式<select v-model="inputKind" @change="preview = null">
              <option value="text">粘贴节点 / 配置</option>
              <option value="url">临时订阅 URL</option>
              <option value="file">上传配置文件</option>
            </select></label
          ><label v-if="inputKind === 'url'"
            >订阅 URL<input v-model="url" type="url" autocomplete="off" /></label
          ><label v-else-if="inputKind === 'file'"
            >配置文件<input
              aria-label="配置文件"
              type="file"
              accept=".yaml,.yml,.json,.txt,.conf"
              @change="file"
            /><small>{{ fileName }}</small></label
          ><label v-else
            >节点或配置文本<textarea
              v-model="content"
              rows="6"
              spellcheck="false"
              autocomplete="off"
            /></label
          ><button type="button" :disabled="busy" @click="previewInput">预览临时节点</button>
          <div v-if="preview" class="test-preview">
            <div class="toolbar">
              <span>{{ preview.nodes.length }} 项 · {{ formatTime(preview.expiresAt) }} 到期</span
              ><button type="button" @click="temporaryIndices = preview.nodes.map((n) => n.index)">
                全选临时节点</button
              ><button type="button" @click="temporaryIndices = []">清空选择</button>
            </div>
            <label v-for="node in preview.nodes" :key="node.index"
              ><input v-model="temporaryIndices" type="checkbox" :value="node.index" />{{
                node.name
              }}
              · {{ node.protocol
              }}<small v-if="node.error" class="error-note">{{ node.error }}</small></label
            >
          </div></template
        >
      </section>
      <template v-if="tab === 'comprehensive'"
        ><section class="test-card">
          <div class="page-header">
            <h2>检测项目</h2>
            <div class="toolbar">
              <button type="button" @click="preset('all')">综合</button
              ><button type="button" @click="preset('speed')">速度</button
              ><button type="button" @click="preset('scripts')">解锁 / 地区</button
              ><button type="button" @click="preset('topology')">拓扑</button>
            </div>
          </div>
          <div class="test-options">
            <label v-for="[id, label] in metricDefinitions" :key="id"
              ><input v-model="metrics" type="checkbox" :value="id" />{{ label }}</label
            >
          </div>
          <h3>脚本检测</h3>
          <div class="test-options">
            <label v-for="script in enabledScripts" :key="script.id"
              ><input v-model="selectedScripts" type="checkbox" :value="script.id" />{{
                script.name
              }}</label
            >
          </div>
        </section>
        <section class="test-card">
          <details>
            <summary>测试参数</summary>
            <div class="test-settings-grid">
              <label>HTTPS 连通性目标<input v-model="settings.pingUrl" type="url" /></label
              ><label>下载目标<input v-model="settings.downloadUrl" /></label
              ><label>上传目标<input v-model="settings.uploadUrl" type="url" /></label
              ><label>STUN 地址<input v-model="settings.stunAddress" /></label
              ><label v-for="[field, label, min, max] in numericFields" :key="field"
                >{{ label
                }}<input v-model.number="settings[field]" type="number" :min="min" :max="max"
              /></label>
            </div>
            <button
              type="button"
              :disabled="busy"
              @click="
                act(async () => {
                  settings = speedSettingsSchema.parse(
                    await api('/api/miaospeed/settings', settings, 'PATCH'),
                  );
                  message = '默认测试参数已保存。';
                })
              "
            >
              保存为默认参数
            </button>
          </details>
          <div class="test-launch">
            <label>报告名称<input v-model="name" maxlength="120" /></label
            ><label
              >节点执行内核<select v-model="settings.nodeCore">
                <option v-for="(label, core) in speedCoreLabels" :key="core" :value="core">
                  {{ label }}
                </option>
              </select></label
            ><button
              type="button"
              class="primary"
              :disabled="
                busy ||
                !selectedSubjects.length ||
                (!metrics.length && !selectedScripts.length) ||
                !!status?.active
              "
              @click="start"
            >
              开始综合测试
            </button>
          </div>
          <p class="muted">
            节点执行内核适用于已保存节点和临时节点；REALITY 节点可选择 Xray。 每个节点的下行
            {{ settings.downloadSeconds }} 秒、上行
            {{ settings.uploadSeconds }} 秒（仅执行勾选项）。取消后保留已完成结果。
          </p>
        </section></template
      >
      <template v-else
        ><button
          type="button"
          class="primary"
          :disabled="busy || !saved.length || !!status?.active"
          @click="coreTest"
        >
          开始三内核检查</button
        ><NodeTestsPage :api="api" :subjects="saved"
      /></template>
    </template>
    <section v-if="tab === 'history'" class="test-card" aria-label="历史报告">
      <h2>历史报告</h2>
      <ul class="test-history">
        <li v-for="item in history.reports" :key="item.id">
          <div>
            <strong>{{ item.name }}</strong>
            <p>
              {{ formatTime(item.createdAt) }} · {{ item.completed }}/{{ item.total }} ·
              {{ item.state }} · {{ item.origin === 'telegram' ? 'Telegram' : '网页' }}
            </p>
          </div>
          <div class="toolbar">
            <button type="button" :disabled="busy" @click="viewReport(item.id)">查看报告</button
            ><button
              type="button"
              :disabled="busy || item.state === 'running'"
              @click="
                act(async () => {
                  await api('/api/miaospeed/reports/' + item.id, {}, 'DELETE');
                  if (report?.id === item.id) {
                    reportRequest++;
                    report = null;
                  }
                  await loadHistory();
                })
              "
            >
              删除报告
            </button>
          </div>
        </li>
      </ul>
      <p v-if="!history.reports.length" class="muted">暂无历史报告。</p>
      <ListPagination
        :page="historyPage"
        :total="history.total"
        :disabled="busy"
        @turn="
          (delta) => {
            historyPage += delta;
            act(loadHistory);
          }
        "
      />
    </section>
    <TestScripts
      v-if="tab === 'scripts'"
      :api="api"
      :scripts="scripts"
      @updated="
        (values) => {
          scripts = values;
          selectedScripts = selectedScripts.filter((id) =>
            values.some((s) => s.id === id && s.enabled),
          );
        }
      "
    />
    <TelegramSettings
      v-if="tab === 'telegram'"
      :api="api"
      :scripts="scripts"
      @report="
        async (id) => {
          await viewReport(id);
          tab = 'history';
        }
      "
    />
    <section v-if="tab === 'backend'" class="test-card">
      <h2>miaospeed 后端</h2>
      <p>API v3 · 上传测速已在配套容器配置中启用</p>
      <p>
        连接：{{ status?.connected ? '可用' : '尚未确认' }} · 实际版本：{{
          status?.version || '未检查'
        }}
      </p>
      <p v-if="status?.checkedAt">检查时间：{{ formatTime(status.checkedAt) }}</p>
      <p v-if="status?.error" class="error-note">{{ status.error }}</p>
      <button
        type="button"
        :disabled="busy"
        @click="
          act(async () => {
            status = speedStatusSchema.parse(await api('/api/miaospeed/status/check', {}));
          })
        "
      >
        检查后端连接
      </button>
      <p class="muted">
        后端连接与 Token 由部署环境配置。更新官方镜像后手动重建后端容器，页面会记录实际返回的版本。
      </p>
    </section>
    <button
      v-if="report && report.state !== 'running' && (tab === 'comprehensive' || tab === 'history')"
      type="button"
      :disabled="busy || !!status?.active"
      @click="repeatReport"
    >
      使用此报告配置重测
    </button>
    <TestReport
      v-if="report && (tab === 'comprehensive' || tab === 'history')"
      :report="report"
      @cancel="
        act(async () => {
          if (report) {
            await api('/api/miaospeed/tests/' + report.id + '/cancel', {});
            message = '正在取消；已发出的后端单节点探测结束前不会启动新批次。';
            await refresh();
          }
        })
      "
    />
  </section>
</template>
