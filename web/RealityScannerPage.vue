<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SideDrawer from './ui/SideDrawer.vue';
import StatusBadge from './ui/StatusBadge.vue';
import ListPagination from './ui/ListPagination.vue';
import { formatTime } from './format';
import {
  SCAN_MAX_BYTES,
  normalizeScanTargets,
  scanParametersSchema,
  scanPreviewSchema,
  scannerStatusSchema,
  scanSummarySchema,
  scanListSchema,
  scanResultsSchema,
  scanActive,
  scanStateLabels,
  scanResultLabels,
  scanDomain,
  scanEndpoint,
  type ScanPreview,
  type ScanSummary,
  type ScanResult,
} from '../server/shared/reality-scanner';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const base = '/api/reality-scanner';
const tab = ref<'scan' | 'history'>('scan');
const mode = ref<'text' | 'file' | 'url'>('text');
const text = ref(''),
  url = ref(''),
  extracted = ref(false),
  fileName = ref('');
const parameters = ref(scanParametersSchema.parse({}));
const preview = ref<ScanPreview>(normalizeScanTargets(''));
const parsing = ref(false),
  busy = ref(false),
  loading = ref(true),
  message = ref(''),
  copied = ref('');
const status = ref<ReturnType<typeof scannerStatusSchema.parse> | null>(null);
const selectedId = ref(''),
  selected = ref<ScanSummary | null>(null);
const resultPage = ref(0),
  search = ref(''),
  filter = ref<'all' | ScanResult['state']>('matched');
const rows = ref<ScanResult[]>([]),
  resultTotal = ref(0),
  resultsLoading = ref(false);
const historyPage = ref(0),
  scans = ref<ScanSummary[]>([]),
  historyTotal = ref(0);
const detail = ref<ScanResult | null>(null),
  detailTrigger = ref<HTMLElement | null>(null);
const now = ref(Date.now());
let alive = true,
  resultEpoch = 0,
  historyEpoch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let parseTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const canStart = computed(
  () =>
    status.value?.available &&
    !status.value.active &&
    !busy.value &&
    !parsing.value &&
    !preview.value.invalidCount &&
    preview.value.count > 0 &&
    scanParametersSchema.safeParse(parameters.value).success,
);
const elapsed = computed(() => {
  if (!selected.value) return '0 秒';
  const end = selected.value.finishedAt ? Date.parse(selected.value.finishedAt) : now.value;
  const seconds = Math.max(0, Math.floor((end - Date.parse(selected.value.createdAt)) / 1000));
  return seconds < 60
    ? seconds + ' 秒'
    : Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
});
const geoLabel = computed(() =>
  status.value?.geoip === 'available'
    ? 'GeoIP 可用'
    : status.value?.geoip === 'unknown'
      ? 'GeoIP 待检查'
      : 'GeoIP 不可用，地区显示未知',
);
const query = () => new URLSearchParams({ state: filter.value, search: search.value });
const exportUrl = (format: 'csv' | 'ips' | 'domains', id = selectedId.value, all = false) =>
  base +
  '/scans/' +
  id +
  '/export?' +
  (all ? 'state=all' : query().toString()) +
  '&format=' +
  format;
function route() {
  const params = new URLSearchParams();
  if (selectedId.value) params.set('scan', selectedId.value);
  if (tab.value === 'history') params.set('tab', 'history');
  history.replaceState(
    null,
    '',
    '#/reality-scanner' + (params.size ? '?' + params.toString() : ''),
  );
}
function showTab(value: 'scan' | 'history') {
  tab.value = value;
  route();
  if (value === 'history') void loadHistory().catch(showError);
}
function showError(error: unknown) {
  if (alive) message.value = error instanceof Error ? error.message : '操作失败，请重试。';
}
watch([text, () => parameters.value.enableIpv6], () => {
  parsing.value = true;
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => {
    preview.value = normalizeScanTargets(text.value, parameters.value.enableIpv6);
    parsing.value = false;
  }, 180);
});
watch(url, () => {
  if (mode.value === 'url') {
    extracted.value = false;
    text.value = '';
  }
});
async function loadFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy.value = true;
  message.value = '';
  try {
    if (file.size > SCAN_MAX_BYTES) throw new Error('文件超过 4 MiB。');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (alive) {
      text.value = content;
      fileName.value = file.name;
    }
  } catch {
    text.value = '';
    fileName.value = '';
    message.value = '文件需为不超过 4 MiB 的 UTF-8 文本。';
  } finally {
    busy.value = false;
  }
}
async function extract() {
  busy.value = true;
  message.value = '';
  try {
    const value = scanPreviewSchema.parse(
      await props.api(base + '/preview', {
        kind: 'url',
        url: url.value,
        enableIpv6: parameters.value.enableIpv6,
      }),
    );
    if (!alive) return;
    text.value = value.targets.join('\n');
    extracted.value = true;
    if (value.invalidCount) message.value = value.errors.map((error) => error.message).join('\n');
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}
async function loadResults() {
  const id = selectedId.value;
  const epoch = ++resultEpoch;
  if (!id) {
    rows.value = [];
    resultTotal.value = 0;
    return;
  }
  resultsLoading.value = true;
  try {
    const value = scanResultsSchema.parse(
      await props.api(
        base + '/scans/' + id + '/results?' + query().toString() + '&page=' + resultPage.value,
      ),
    );
    if (alive && epoch === resultEpoch && id === selectedId.value) {
      rows.value = value.results;
      resultTotal.value = value.total;
    }
  } finally {
    if (alive && epoch === resultEpoch) resultsLoading.value = false;
  }
}
async function loadHistory() {
  const epoch = ++historyEpoch;
  const value = scanListSchema.parse(await props.api(base + '/scans?page=' + historyPage.value));
  if (alive && epoch === historyEpoch) {
    scans.value = value.scans;
    historyTotal.value = value.total;
    if (!value.scans.length && historyPage.value > 0) {
      historyPage.value--;
      await loadHistory();
    }
  }
}
async function selectScan(id: string) {
  selectedId.value = id;
  selected.value = null;
  rows.value = [];
  resultTotal.value = 0;
  resultPage.value = 0;
  detail.value = null;
  tab.value = 'scan';
  route();
  try {
    const value = scanSummarySchema.parse(await props.api(base + '/scans/' + id));
    if (!alive || selectedId.value !== id) return;
    selected.value = value;
    await loadResults();
  } catch (error) {
    showError(error);
  }
}
async function start() {
  if (!canStart.value) return;
  busy.value = true;
  message.value = '';
  try {
    const scan = scanSummarySchema.parse(
      await props.api(base + '/scans', {
        targets: preview.value.targets,
        parameters: scanParametersSchema.parse(parameters.value),
      }),
    );
    if (!alive) return;
    if (status.value) status.value.active = scan;
    filter.value = 'matched';
    search.value = '';
    await selectScan(scan.id);
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (!selected.value) return;
  busy.value = true;
  message.value = '';
  try {
    const id = selected.value.id;
    const value = scanSummarySchema.parse(await props.api(base + '/scans/' + id + '/cancel', {}));
    if (alive && selectedId.value === id) selected.value = value;
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}
async function remove(scan: ScanSummary) {
  busy.value = true;
  message.value = '';
  try {
    await props.api(base + '/scans/' + scan.id, {}, 'DELETE');
    if (!alive) return;
    if (selectedId.value === scan.id) {
      selectedId.value = '';
      selected.value = null;
      rows.value = [];
      resultTotal.value = 0;
      resultEpoch++;
      route();
    }
    await loadHistory();
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = '已复制';
  } catch {
    copied.value = '复制失败，可选中文字手动复制。';
  }
}
function showDetail(row: ScanResult, event: MouseEvent) {
  detail.value = row;
  copied.value = '';
  detailTrigger.value = event.currentTarget as HTMLElement;
}
watch([filter, resultPage], () => {
  void loadResults().catch(showError);
});
watch(search, () => {
  resultEpoch++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    resultPage.value = 0;
    void loadResults().catch(showError);
  }, 200);
});
function setFilter() {
  resultPage.value = 0;
}
async function poll() {
  try {
    const value = scannerStatusSchema.parse(await props.api(base + '/status'));
    if (!alive) return;
    status.value = value;
    now.value = Date.now();
    if (selectedId.value) {
      const id = selectedId.value;
      const summary =
        value.active?.id === id
          ? value.active
          : scanSummarySchema.parse(await props.api(base + '/scans/' + id));
      if (alive && selectedId.value === id) {
        const changed =
          selected.value?.completed !== summary.completed ||
          selected.value?.state !== summary.state;
        selected.value = summary;
        if (changed) await loadResults();
      }
    }
    if (tab.value === 'history') await loadHistory();
  } catch (error) {
    showError(error);
  } finally {
    if (alive) timer = setTimeout(poll, status.value?.active ? 1000 : 4000);
  }
}
onMounted(async () => {
  try {
    status.value = scannerStatusSchema.parse(await props.api(base + '/status'));
    await loadHistory();
    if (!alive) return;
    const params = new URLSearchParams(location.hash.split('?')[1]);
    const id = params.get('scan') || status.value.active?.id || scans.value[0]?.id;
    const initialTab = params.get('tab') === 'history' ? 'history' : 'scan';
    if (id) await selectScan(id);
    if (alive) {
      tab.value = initialTab;
      route();
    }
  } catch (error) {
    showError(error);
  } finally {
    loading.value = false;
    if (alive) timer = setTimeout(poll, 1000);
  }
});
onBeforeUnmount(() => {
  alive = false;
  resultEpoch++;
  historyEpoch++;
  clearTimeout(timer);
  clearTimeout(parseTimer);
  clearTimeout(searchTimer);
});
</script>

<template>
  <section class="page reality-scanner">
    <header class="page-header">
      <div>
        <h1>REALITY 扫描</h1>
        <p>发现符合上游筛选条件的 TLS 候选站点。</p>
        <p class="muted">
          执行位置：SubMeld 服务器 · RealiTLScanner {{ status?.version || '0.2.3' }} ·
          {{ geoLabel }}
        </p>
      </div>
    </header>
    <p class="notice">
      候选不代表 REALITY 实际部署可用；扫描器不验证证书信任链。结果反映面板服务器所在网络。
    </p>
    <p v-if="message" class="notice is-error" role="alert">{{ message }}</p>
    <p v-if="status?.message" class="notice is-error" role="alert">{{ status.message }}</p>
    <div class="output-tabs" aria-label="扫描页面">
      <button
        :class="{ active: tab === 'scan' }"
        :aria-pressed="tab === 'scan'"
        @click="showTab('scan')"
      >
        扫描</button
      ><button
        :class="{ active: tab === 'history' }"
        :aria-pressed="tab === 'history'"
        @click="showTab('history')"
      >
        历史记录
      </button>
    </div>
    <p v-if="loading" role="status">正在读取扫描状态…</p>
    <template v-if="tab === 'scan'">
      <form class="panel scan-form" @submit.prevent="start">
        <div class="scan-input-grid">
          <div class="scan-input">
            <label
              >输入方式<select v-model="mode" :disabled="busy">
                <option value="text">IP / 域名 / CIDR / 批量文本</option>
                <option value="file">TXT 文件</option>
                <option value="url">网页 URL</option>
              </select></label
            >
            <label v-if="mode === 'file'"
              >目标文件<input
                type="file"
                accept=".txt,text/plain"
                :disabled="busy"
                @change="loadFile"
              /><small>{{ fileName || 'UTF-8 文本，最多 4 MiB' }}</small></label
            >
            <div v-if="mode === 'url'" class="url-input">
              <label
                >网页 URL<input
                  v-model="url"
                  type="url"
                  placeholder="https://example.com/mirrors"
                  :disabled="busy" /></label
              ><button type="button" :disabled="busy || !url.trim()" @click="extract">
                {{ extracted ? '重新提取域名' : '提取域名' }}</button
              ><small class="muted">仅提取指定网页中的绝对 HTTP(S) 链接域名，不递归抓取。</small>
            </div>
            <label
              >扫描目标<textarea
                v-model="text"
                rows="6"
                spellcheck="false"
                :disabled="busy"
                placeholder="example.com&#10;203.0.113.0/24&#10;每行一个目标，单个 IP 或域名只扫描一次"
              />
            </label>
            <p class="muted" role="status">
              {{
                parsing
                  ? '正在计算目标…'
                  : preview.count > 65536
                    ? '目标数量超过 65,536'
                    : '去重后 ' + preview.count.toLocaleString() + ' 个目标'
              }}
              · 单次最多 65,536 个
            </p>
            <ul
              v-if="text.trim() && preview.invalidCount && !parsing"
              class="input-errors"
              role="alert"
            >
              <li v-for="(error, i) in preview.errors" :key="i">
                {{ error.line ? '第 ' + error.line + ' 行：' : '' }}{{ error.message }}
              </li>
              <li v-if="preview.invalidCount > preview.errors.length">
                另有 {{ preview.invalidCount - preview.errors.length }} 项错误，请检查输入。
              </li>
            </ul>
          </div>
          <div class="scan-options">
            <label
              >目标端口<input
                v-model.number="parameters.port"
                type="number"
                min="1"
                max="65535"
                required
                :disabled="busy"
            /></label>
            <details>
              <summary>高级设置</summary>
              <div class="advanced-fields">
                <label
                  >并发数<input
                    v-model.number="parameters.concurrency"
                    type="number"
                    min="1"
                    max="32"
                    required
                    :disabled="busy"
                /></label>
                <label
                  >超时（秒）<input
                    v-model.number="parameters.timeoutSeconds"
                    type="number"
                    min="1"
                    max="60"
                    required
                    aria-describedby="scanner-timeout-help"
                    :disabled="busy"
                /></label>
                <small id="scanner-timeout-help">连接与 TLS 握手分别使用此超时。</small>
                <label class="check-row"
                  ><input v-model="parameters.enableIpv6" type="checkbox" :disabled="busy" />允许
                  IPv6</label
                ><small class="muted"
                  >域名按上游选择一个允许的地址，不代表同时检查全部 IPv4 和 IPv6 地址。</small
                >
              </div>
            </details>
            <p class="muted">扫完即停。关闭页面不影响任务，可稍后回来查看。</p>
          </div>
        </div>
        <div class="scan-actions">
          <button class="primary" :disabled="!canStart" type="submit">开始扫描</button
          ><span v-if="status?.active" class="muted">已有扫描正在执行</span
          ><button
            v-if="status?.active && status.active.id !== selectedId"
            type="button"
            @click="selectScan(status.active.id)"
          >
            查看当前任务
          </button>
        </div>
      </form>
      <section v-if="selected" class="panel scan-progress" aria-label="扫描进度">
        <div class="scan-actions">
          <StatusBadge
            :label="scanStateLabels[selected.state]"
            :tone="
              selected.state === 'failed' ? 'error' : scanActive(selected.state) ? 'busy' : 'off'
            "
          /><span
            >{{ formatTime(selected.createdAt) }} · 端口 {{ selected.parameters.port }} · 耗时
            {{ elapsed }}</span
          ><button
            v-if="scanActive(selected.state)"
            :disabled="busy || selected.state === 'cancelling'"
            @click="cancel"
          >
            停止扫描
          </button>
        </div>
        <progress :value="selected.completed" :max="selected.total" aria-label="扫描完成进度" />
        <div class="scan-counts" role="status">
          <strong>已处理 {{ selected.completed }} / {{ selected.total }}</strong
          ><span>候选 {{ selected.matched }}</span
          ><span>不符合 {{ selected.unmatched }}</span
          ><span>失败 {{ selected.failed }}</span>
        </div>
        <p v-if="selected.message" :class="{ 'scan-error': selected.state === 'failed' }">
          {{ selected.message }}
        </p>
      </section>
      <section v-if="selected" class="panel scan-results" aria-label="扫描结果">
        <div class="result-toolbar">
          <label
            >结果筛选<select v-model="filter" @change="setFilter">
              <option value="matched">候选</option>
              <option value="all">全部</option>
              <option value="unmatched">不符合</option>
              <option value="failed">失败</option>
            </select></label
          ><label
            >搜索结果<input v-model="search" type="search" placeholder="IP、域名、颁发者、地区"
          /></label>
          <div class="export-actions">
            <span class="muted">导出当前筛选</span><a :href="exportUrl('csv')">CSV</a
            ><a :href="exportUrl('ips')">IP TXT</a><a :href="exportUrl('domains')">来源域名 TXT</a>
          </div>
        </div>
        <div class="scan-table">
          <table aria-label="REALITY 扫描结果">
            <thead>
              <tr>
                <th>IP / 来源</th>
                <th>证书域名</th>
                <th>TLS / ALPN</th>
                <th>地区</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.position">
                <td>
                  <span class="mono">{{ row.ip || '未知' }}</span
                  ><small>{{ row.origin || '来源未知' }}</small>
                </td>
                <td>{{ row.certDomain || '—' }}</td>
                <td>
                  {{ row.tls || '—' }}<small>{{ row.alpn || '—' }}</small>
                </td>
                <td>{{ row.countryCode || '未知' }}</td>
                <td>
                  <StatusBadge
                    :label="scanResultLabels[row.state]"
                    :tone="
                      row.state === 'matched' ? 'ok' : row.state === 'failed' ? 'error' : 'warn'
                    "
                  />
                </td>
                <td><button @click="showDetail(row, $event)">详情</button></td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="6" class="empty-state">
                  {{
                    resultsLoading
                      ? '正在读取结果…'
                      : scanActive(selected.state)
                        ? '当前筛选下尚无结果，扫描仍在进行。'
                        : '当前筛选下没有结果。'
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ListPagination
          :page="resultPage"
          :total="resultTotal"
          :disabled="resultsLoading"
          @turn="resultPage += $event"
        />
      </section>
      <div v-else-if="!loading" class="panel empty-state">
        <strong>开始一次有限扫描</strong>
        <p>输入目标后点击“开始扫描”，结果将在这里实时显示。</p>
      </div>
    </template>
    <section v-else class="panel scan-history" aria-label="扫描历史">
      <div class="scan-table">
        <table aria-label="扫描历史记录">
          <thead>
            <tr>
              <th>时间 / 参数</th>
              <th>进度</th>
              <th>候选</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="scan in scans" :key="scan.id">
              <td>
                {{ formatTime(scan.createdAt)
                }}<small
                  >端口 {{ scan.parameters.port }} · 并发 {{ scan.parameters.concurrency }} · v{{
                    scan.version
                  }}</small
                >
              </td>
              <td>{{ scan.completed }} / {{ scan.total }}</td>
              <td>{{ scan.matched }}</td>
              <td>{{ scanStateLabels[scan.state] }}</td>
              <td>
                <div class="scan-actions">
                  <button @click="selectScan(scan.id)">查看</button
                  ><a :href="exportUrl('csv', scan.id, true)">导出 CSV</a
                  ><button
                    class="danger"
                    :disabled="busy || scanActive(scan.state)"
                    @click="remove(scan)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!scans.length">
              <td colspan="5" class="empty-state">暂无扫描历史。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ListPagination
        :page="historyPage"
        :total="historyTotal"
        :disabled="busy"
        @turn="
          historyPage += $event;
          loadHistory().catch(showError);
        "
      />
    </section>
    <SideDrawer
      v-if="detail"
      label="扫描结果详情"
      :return-focus-to="detailTrigger"
      @close="detail = null"
    >
      <p>{{ detail.message }}</p>
      <dl class="scan-detail">
        <template
          v-for="entry in [
            ['IP', detail.ip],
            ['来源', detail.origin],
            ['端口', String(detail.port)],
            ['证书域名', detail.certDomain],
            ['TLS', detail.tls],
            ['ALPN', detail.alpn],
            ['曲线', detail.curve],
            ['证书链长度', detail.certLength],
            ['签名算法', detail.certSignature],
            ['密钥算法', detail.certPublicKey],
            ['颁发者', detail.certIssuer],
            ['地区', detail.countryCode],
          ]"
          :key="entry[0]"
          ><dt>{{ entry[0] }}</dt>
          <dd>{{ entry[1] || '未知' }}</dd></template
        >
      </dl>
      <p class="muted">通配符证书域名按原样展示，不能据此推导可用 SNI。</p>
      <div class="scan-actions">
        <button :disabled="!detail.ip" @click="copy(detail.ip)">复制 IP</button
        ><button :disabled="!scanDomain(detail.origin)" @click="copy(detail.origin)">
          复制来源域名</button
        ><button :disabled="!detail.certDomain" @click="copy(detail.certDomain)">
          复制证书域名</button
        ><button :disabled="!detail.ip" @click="copy(scanEndpoint(detail))">复制目标地址</button>
      </div>
      <p role="status">{{ copied }}</p>
    </SideDrawer>
  </section>
</template>

<style scoped>
.reality-scanner {
  min-width: 0;
}
.scan-form,
.scan-progress,
.scan-results,
.scan-history,
.output-tabs {
  margin-bottom: var(--space-4);
}
.scan-results,
.scan-history {
  padding: 0;
}
.scan-form,
.scan-progress {
  padding: var(--space-6);
}
.scan-input-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
  gap: var(--space-6);
}
.scan-input,
.scan-options,
.advanced-fields,
.url-input {
  display: grid;
  gap: var(--space-3);
  align-content: start;
  min-width: 0;
}
label {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}
label small,
small {
  color: var(--muted);
}
textarea {
  min-height: 150px;
  resize: vertical;
  font-family: var(--mono);
}
.check-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.check-row input {
  width: auto;
}
.advanced-fields {
  margin-top: var(--space-3);
}
summary {
  cursor: pointer;
  padding-block: var(--space-2);
}
.scan-actions,
.scan-counts,
.export-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
}
.scan-form > .scan-actions {
  margin-top: var(--space-4);
}
.scan-progress progress {
  width: 100%;
  margin-block: var(--space-4);
  accent-color: var(--primary);
}
.scan-error,
.input-errors {
  color: var(--danger);
}
.input-errors {
  max-height: 180px;
  overflow: auto;
  padding-left: var(--space-5);
  margin: 0;
}
.result-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-4);
  padding: var(--space-4);
}
.result-toolbar > label {
  flex: 1 1 160px;
}
.export-actions {
  flex: 1 1 250px;
  padding-block: var(--space-2);
}
.scan-table {
  overflow-x: auto;
  max-width: 100%;
}
table {
  width: 100%;
  min-width: 680px;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width) solid var(--border);
}
th {
  background: var(--surface-subtle);
  font-weight: var(--weight-strong);
}
tbody tr:hover {
  background: var(--row-hover);
}
td {
  max-width: 300px;
  overflow-wrap: anywhere;
}
td small {
  display: block;
}
.mono {
  font-family: var(--mono);
}
.scan-detail {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: var(--space-3);
}
.scan-detail dt {
  color: var(--muted);
}
.scan-detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.pagination {
  padding: var(--space-4);
}
@media (max-width: 800px) {
  .scan-input-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .scan-form,
  .scan-progress {
    padding: var(--space-4);
  }
  .result-toolbar {
    align-items: stretch;
  }
  .scan-actions > span {
    width: 100%;
  }
}
</style>
