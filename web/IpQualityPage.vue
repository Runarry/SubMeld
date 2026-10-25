<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  ipQualityQuerySchema,
  ipQualityReportSchema,
  ipQualityFactorLabels,
  ipQualityInfoLabels,
  type IpQualityReport,
  type IpQualitySource,
  type IpQualityDnsbl,
} from '../server/shared/ip-quality';
import { formatTime } from './format';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<unknown>;
}>();
const input = ref(''),
  message = ref(''),
  running = ref(false);
const report = ref<IpQualityReport | null>(null);
let controller: AbortController | undefined,
  generation = 0;
const statusLabels: Record<IpQualitySource['status'] | IpQualityDnsbl['status'], string> = {
  success: '已取得资料',
  unavailable: '不可用',
  invalid: '响应无效',
  timeout: '超时',
  rate_limited: '来源限流',
  unsupported: '不支持',
  listed: '命中',
  not_listed: '未命中',
  unknown: '未知',
};
const overallLabels = { complete: '查询完成', partial: '部分来源可用', failed: '未取得有效结果' };
const infoSources = computed(
  () =>
    report.value?.sources.filter(
      (source) => source.data && Object.values(source.data.info).some((value) => value !== null),
    ) ?? [],
);
const infoKeys = Object.keys(ipQualityInfoLabels) as (keyof typeof ipQualityInfoLabels)[];
const factorKeys = Object.keys(ipQualityFactorLabels) as (keyof typeof ipQualityFactorLabels)[];
function stop(showMessage = true) {
  generation++;
  controller?.abort();
  controller = undefined;
  running.value = false;
  if (showMessage) message.value = '本次查询已停止。';
}
async function query(refresh = false) {
  if (running.value) return;
  const parsed = ipQualityQuerySchema.safeParse({ ip: input.value, refresh });
  if (!parsed.success) {
    message.value = '请输入单个有效的公网 IPv4 或 IPv6，不包含端口、网段或网址。';
    return;
  }
  const current = ++generation;
  const active = new AbortController();
  controller = active;
  running.value = true;
  message.value = '';
  report.value = null;
  try {
    const value = await props.api('/api/ip-quality/query', parsed.data, 'POST', active.signal);
    if (current !== generation || active.signal.aborted) return;
    report.value = ipQualityReportSchema.parse(value);
  } catch (error) {
    if (current === generation && !active.signal.aborted)
      message.value = error instanceof Error ? error.message : '查询失败，请稍后重试。';
  } finally {
    if (current === generation) {
      running.value = false;
      controller = undefined;
    }
  }
}
onBeforeUnmount(() => stop(false));
</script>

<template>
  <section class="ip-quality-page library" aria-label="IP 质量查询">
    <header class="page-header">
      <div>
        <h1>IP 质量</h1>
        <p class="muted">输入公网 IP，查询归属、网络类型、风险资料与黑名单。</p>
      </div>
    </header>
    <form class="test-card query-form" @submit.prevent="query()">
      <label class="query-input"
        >公网 IP
        <input
          v-model="input"
          name="ip"
          autocomplete="off"
          spellcheck="false"
          :disabled="running"
          placeholder="例如 1.1.1.1 或 2606:4700:4700::1111"
        />
      </label>
      <div class="toolbar">
        <button class="primary" type="submit" :disabled="running">查询</button>
        <button type="button" :disabled="running || !input.trim()" @click="query(true)">
          重新查询
        </button>
        <button v-if="running" type="button" @click="stop()">停止</button>
      </div>
      <p class="muted">结果仅保留在当前页面；普通查询可使用十分钟内的缓存，重新查询刷新数据。</p>
    </form>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <p v-if="running" class="notice" role="status">正在查询各来源，最多等待 35 秒…</p>
    <p class="muted">数据库评价不代表平台解锁或链路可用性。未知、受限及缺失字段均保留原状态。</p>

    <template v-if="report">
      <section class="test-card report-overview" aria-label="查询结果">
        <div class="page-header">
          <div>
            <h2 class="ip-value">{{ report.ip }}</h2>
            <span class="muted">IPv{{ report.family }}</span>
          </div>
          <span class="quality-state" :data-state="report.status">{{
            overallLabels[report.status]
          }}</span>
        </div>
        <p class="muted">
          查询时间：<time>{{ formatTime(report.startedAt) }}</time> · 适配版本：{{ report.version }}
        </p>
      </section>

      <section class="test-card" aria-label="基础资料">
        <h2>基础资料</h2>
        <p v-if="!infoSources.length" class="muted">未取得可用的基础资料，请查看下方来源状态。</p>
        <div class="quality-grid">
          <article v-for="source in infoSources" :key="source.id" class="quality-card">
            <h3>{{ source.name }} <span v-if="source.cached" class="muted">缓存</span></h3>
            <dl>
              <template v-for="key in infoKeys" :key="key">
                <dt>{{ ipQualityInfoLabels[key] }}</dt>
                <dd>{{ source.data?.info[key] ?? '未知' }}</dd>
              </template>
            </dl>
          </article>
        </div>
      </section>

      <section class="test-card" aria-label="多源风险">
        <h2>多源风险</h2>
        <p class="muted">各来源独立展示；网段滥用比例不等于当前 IP 的风险概率。</p>
        <div class="quality-grid">
          <article
            v-for="source in report.sources"
            :key="source.id"
            class="quality-card"
            :data-source="source.id"
          >
            <div class="page-header">
              <h3>{{ source.name }}</h3>
              <span class="quality-state" :data-state="source.status">{{
                statusLabels[source.status]
              }}</span>
            </div>
            <p class="muted">
              <time>{{ formatTime(source.checkedAt) }}</time
              ><span v-if="source.cached"> · 缓存</span>
            </p>
            <p>{{ source.message }}</p>
            <p v-if="source.retryAt" class="muted">可重试时间：{{ formatTime(source.retryAt) }}</p>
            <template v-if="source.data">
              <dl>
                <dt>网络类型</dt>
                <dd>{{ source.data.networkType ?? '未知' }}</dd>
                <dt>机构类型</dt>
                <dd>{{ source.data.companyType ?? '未知' }}</dd>
              </dl>
              <ul v-if="source.data.scores.length" class="quality-scores">
                <li v-for="score in source.data.scores" :key="score.label">
                  <span>{{ score.label }}</span>
                  <strong
                    >{{ Number(score.value.toFixed(2))
                    }}{{ score.unit === 'percent' ? '%' : ' / 100' }}</strong
                  >
                  <span class="muted"
                    >{{ score.scope === 'network' ? '网段统计' : '单 IP 评价'
                    }}<template v-if="score.level"> · {{ score.level }}</template></span
                  >
                </li>
              </ul>
              <p v-else class="muted">评分：未知／来源未提供</p>
              <dl>
                <template v-for="key in factorKeys" :key="key">
                  <dt>{{ ipQualityFactorLabels[key] }}</dt>
                  <dd :class="{ 'flag-present': source.data.factors[key] === true }">
                    {{
                      source.data.factors[key] === null
                        ? '未知'
                        : source.data.factors[key]
                          ? '是'
                          : '否'
                    }}
                  </dd>
                </template>
                <template v-if="source.id === 'abuseipdb'">
                  <dt>举报次数</dt>
                  <dd>{{ source.data.totalReports ?? '未知' }}</dd>
                  <dt>最近举报</dt>
                  <dd>
                    {{
                      source.data.lastReportedAt ? formatTime(source.data.lastReportedAt) : '未知'
                    }}
                  </dd>
                </template>
              </dl>
            </template>
          </article>
        </div>
      </section>

      <section class="test-card" aria-label="DNSBL 黑名单">
        <h2>DNSBL 黑名单</h2>
        <p>
          参与查询 {{ report.blacklist.queried }} 项 · 有效结果 {{ report.blacklist.valid }} 项 ·
          命中 {{ report.blacklist.listed }} 项
        </p>
        <p class="muted">仅核验明确支持该地址类型的名单；未命中不代表其他名单或平台没有风险。</p>
        <div class="quality-grid">
          <article
            v-for="item in report.dnsbl"
            :key="item.id"
            class="quality-card"
            :data-dnsbl="item.id"
          >
            <div class="page-header">
              <h3>{{ item.name }}</h3>
              <span class="quality-state" :data-state="item.status">{{
                statusLabels[item.status]
              }}</span>
            </div>
            <p class="muted ip-value">{{ item.zone }} · IPv{{ item.family }}</p>
            <p>{{ item.message }}</p>
            <p v-if="item.answers.length" class="ip-value">返回码：{{ item.answers.join('、') }}</p>
            <p class="muted">
              <time>{{ formatTime(item.checkedAt) }}</time
              ><span v-if="item.cached"> · 缓存</span>
            </p>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.ip-quality-page {
  display: grid;
  gap: var(--space-4);
}
.query-form {
  display: grid;
  gap: var(--space-3);
}
.query-input {
  display: grid;
  gap: var(--space-2);
}
.query-input input {
  width: 100%;
  font-family: var(--mono);
}
.quality-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: var(--space-4);
}
.quality-card {
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  min-width: 0;
}
.quality-card h3 {
  font-size: var(--text-md);
  margin: 0;
}
.quality-card p {
  margin-block: var(--space-2);
  overflow-wrap: anywhere;
}
.quality-card .page-header {
  align-items: flex-start;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.quality-card dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin-block: var(--space-3);
}
.quality-card dt {
  color: var(--muted);
}
.quality-card dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}
.quality-state {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--neutral-bg);
  color: var(--neutral-text);
  font-size: var(--text-xs);
}
.quality-state[data-state='listed'] {
  background: var(--danger-bg);
  color: var(--danger);
}
.quality-state[data-state='partial'],
.quality-state[data-state='timeout'],
.quality-state[data-state='rate_limited'] {
  background: var(--warn-bg);
  color: var(--warn-text);
}
.quality-state[data-state='success'],
.quality-state[data-state='complete'] {
  background: var(--info-bg);
  color: var(--info-text);
}
.quality-scores {
  list-style: none;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}
.quality-scores li {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2);
  background: var(--surface-subtle);
  border-radius: var(--radius-sm);
}
.flag-present {
  font-weight: var(--weight-strong);
}
.ip-value {
  font-family: var(--mono);
  overflow-wrap: anywhere;
}
.report-overview {
  min-width: 0;
}
</style>
