<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  websiteRoutingOrigin,
  websiteRoutingPresets,
  websiteRoutingSitesSchema,
  type WebsiteRoutingResult,
  type WebsiteRoutingSite,
  type WebsiteRoutingState,
} from '../server/shared/website-routing';
import { probeWebsite, WEBSITE_ROUTING_CONCURRENCY } from './websiteRouting';
import ModalDialog from './ui/ModalDialog.vue';

const props = defineProps<{
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}>();
const sites = ref<WebsiteRoutingSite[]>([]);
const results = ref<Record<string, WebsiteRoutingResult>>({});
const loading = ref(true),
  running = ref(false),
  saving = ref(false);
const message = ref(''),
  formMessage = ref('');
const adding = ref(false),
  addMode = ref<'preset' | 'custom'>('custom');
const presetId = ref(''),
  domain = ref(''),
  name = ref('');
const batchIds = ref<string[]>([]);
const controllers = new Map<string, AbortController>();
let generation = 0,
  disposed = false;
const labels: Record<WebsiteRoutingState, string> = {
  idle: '未测试',
  queued: '等待检测',
  running: '检测中',
  success: '已取得 IP',
  unavailable: '无法获取',
  invalid: '无有效 IP',
  timeout: '已超时',
  cancelled: '已停止',
};
const countries = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
function host(url: string) {
  return new URL(url).host;
}
function origin(url: string) {
  return new URL(url).origin;
}
const presentOrigins = computed(() => new Set(sites.value.map((site) => new URL(site.url).origin)));
const previewDomain = computed(() => {
  try {
    return new URL(websiteRoutingOrigin(domain.value)).host;
  } catch {
    return '';
  }
});
const groups = computed(() => {
  const grouped = new Map<string, { ip: string; family: number; names: string[] }>();
  for (const site of sites.value) {
    const result = results.value[site.id];
    if (result?.state !== 'success' || !result.ip || !result.family) continue;
    let group = grouped.get(result.ip);
    if (!group) {
      group = { ip: result.ip, family: result.family, names: [] };
      grouped.set(result.ip, group);
    }
    group.names.push(site.name);
  }
  return [...grouped.values()];
});
const progress = computed(() => {
  const ids = batchIds.value.filter((id) => sites.value.some((site) => site.id === id));
  return {
    total: ids.length,
    completed: ids.filter(
      (id) => !['queued', 'running'].includes(results.value[id]?.state ?? 'queued'),
    ).length,
  };
});
function result(site: WebsiteRoutingSite): WebsiteRoutingResult {
  return results.value[site.id] ?? { state: 'idle' };
}
function country(code?: string) {
  return code ? (countries.of(code) ?? code) : '未知';
}
function checkedAt(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}
async function load() {
  const value = websiteRoutingSitesSchema.parse(await props.api('/api/website-routing/sites'));
  if (disposed) return;
  const ids = new Set(value.sites.map((site) => site.id));
  for (const [id, controller] of controllers) {
    if (!ids.has(id)) {
      controller.abort();
      controllers.delete(id);
    }
  }
  for (const id of Object.keys(results.value)) if (!ids.has(id)) delete results.value[id];
  sites.value = value.sites;
}
function stop() {
  generation++;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  for (const [id, value] of Object.entries(results.value)) {
    if (value.state === 'running' || value.state === 'queued')
      results.value[id] = { state: 'cancelled', message: '已停止本次检测。' };
  }
  running.value = false;
}
async function run(onlyId?: string) {
  if (running.value || loading.value || saving.value) return;
  const current = ++generation;
  running.value = true;
  message.value = '';
  try {
    await load();
    if (disposed || current !== generation) return;
    const selected = sites.value.filter((site) => !onlyId || site.id === onlyId);
    batchIds.value = selected.map((site) => site.id);
    for (const site of selected) results.value[site.id] = { state: 'queued' };
    let cursor = 0;
    async function worker() {
      while (!disposed && current === generation && cursor < selected.length) {
        const site = selected[cursor++];
        if (!sites.value.some((item) => item.id === site.id)) continue;
        const controller = new AbortController();
        controllers.set(site.id, controller);
        results.value[site.id] = { state: 'running' };
        const value = await probeWebsite(site, controller.signal);
        if (controllers.get(site.id) === controller) controllers.delete(site.id);
        if (
          !disposed &&
          current === generation &&
          !controller.signal.aborted &&
          sites.value.some((item) => item.id === site.id)
        )
          results.value[site.id] = value;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(WEBSITE_ROUTING_CONCURRENCY, selected.length) }, worker),
    );
  } catch (error) {
    if (!disposed && current === generation)
      message.value = error instanceof Error ? error.message : '读取网站列表失败。';
  } finally {
    if (!disposed && current === generation) running.value = false;
  }
}
function openAdd() {
  presetId.value =
    websiteRoutingPresets.find((item) => !presentOrigins.value.has(new URL(item.url).origin))
      ?.key ?? '';
  addMode.value = presetId.value ? 'preset' : 'custom';
  domain.value = '';
  name.value = '';
  formMessage.value = '';
  adding.value = true;
}
async function add() {
  if (saving.value) return;
  saving.value = true;
  formMessage.value = '';
  try {
    await props.api(
      '/api/website-routing/sites',
      addMode.value === 'preset'
        ? { presetId: presetId.value }
        : { domain: domain.value, ...(name.value.trim() ? { name: name.value.trim() } : {}) },
    );
    adding.value = false;
    await load();
  } catch (error) {
    const text = error instanceof Error ? error.message : '添加网站失败。';
    if (adding.value) formMessage.value = text;
    else message.value = text;
  } finally {
    saving.value = false;
  }
}
async function remove(site: WebsiteRoutingSite) {
  if (saving.value) return;
  saving.value = true;
  message.value = '';
  try {
    await props.api('/api/website-routing/sites/' + site.id, {}, 'DELETE');
    controllers.get(site.id)?.abort();
    controllers.delete(site.id);
    delete results.value[site.id];
    sites.value = sites.value.filter((item) => item.id !== site.id);
  } catch (error) {
    message.value = error instanceof Error ? error.message : '移除网站失败。';
  } finally {
    saving.value = false;
  }
}
onMounted(async () => {
  try {
    await load();
  } catch (error) {
    message.value = error instanceof Error ? error.message : '读取网站列表失败。';
  } finally {
    loading.value = false;
  }
});
onBeforeUnmount(() => {
  disposed = true;
  stop();
});
</script>

<template>
  <section class="page website-routing">
    <header class="page-header">
      <div>
        <h1>网站分流测试</h1>
        <p>检测当前浏览器访问不同网站时使用的出口 IP。</p>
        <p class="muted">网站列表在账号内共享，检测结果仅在本页保留。</p>
      </div>
      <div class="routing-actions">
        <button :disabled="loading || saving" @click="openAdd">添加网站</button>
        <button v-if="running" @click="stop">停止</button>
        <button
          v-else
          class="primary"
          :disabled="loading || saving || !sites.length"
          @click="run()"
        >
          {{ Object.keys(results).length ? '全部重测' : '开始测试' }}
        </button>
      </div>
    </header>
    <p v-if="message" class="notice is-error" role="alert">{{ message }}</p>
    <p v-if="loading" role="status">正在读取网站列表…</p>
    <section class="panel routing-summary" aria-label="出口 IP 汇总">
      <div class="summary-heading">
        <h2>
          出口 IP 汇总 <span class="muted">{{ groups.length }} 个出口</span>
        </h2>
        <p v-if="running" role="status">
          正在检测：已完成 {{ progress.completed }} / {{ progress.total }} 项
        </p>
      </div>
      <p v-if="!groups.length" class="muted">
        {{
          running
            ? '正在等待有效的出口 IP。'
            : Object.keys(results).length
              ? '本页暂未取得有效出口 IP，可查看各网站状态后重试。'
              : '点击“开始测试”，查看各网站使用的出口 IP。'
        }}
      </p>
      <div v-else class="ip-groups">
        <article v-for="group in groups" :key="group.ip" class="ip-group">
          <strong class="ip-value">{{ group.ip }}</strong>
          <span class="muted">IPv{{ group.family }} · {{ group.names.length }} 个网站</span>
          <p>{{ group.names.join('、') }}</p>
        </article>
      </div>
    </section>
    <div v-if="!loading && !sites.length" class="panel empty-state">
      <strong>尚未添加网站</strong>
      <p>选择预置网站，或输入想要检测的域名。</p>
      <button @click="openAdd">添加网站</button>
    </div>
    <div v-else class="panel website-table">
      <table aria-label="网站分流结果">
        <thead>
          <tr>
            <th>网站 / 检测域名</th>
            <th>出口 IP</th>
            <th>国家或地区</th>
            <th>请求耗时</th>
            <th>状态 / 检测时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="site in sites" :key="site.id" :data-site-id="site.id">
            <td data-label="网站">
              <strong>{{ site.name }}</strong
              ><span class="muted site-domain" :title="site.url">{{ host(site.url) }}</span>
            </td>
            <td data-label="出口 IP">
              <span class="ip-value">{{ result(site).ip ?? '—' }}</span
              ><span v-if="result(site).family" class="muted">IPv{{ result(site).family }}</span>
            </td>
            <td data-label="国家或地区">
              {{ result(site).state === 'success' ? country(result(site).countryCode) : '—' }}
            </td>
            <td data-label="请求耗时">
              {{ result(site).elapsedMs === undefined ? '—' : result(site).elapsedMs + ' ms' }}
            </td>
            <td data-label="检测状态">
              <span class="routing-state" :data-state="result(site).state">{{
                labels[result(site).state]
              }}</span>
              <small v-if="result(site).message" class="result-message">{{
                result(site).message
              }}</small>
              <time class="muted" :datetime="result(site).checkedAt">{{
                checkedAt(result(site).checkedAt)
              }}</time>
            </td>
            <td data-label="操作">
              <div class="routing-actions">
                <button :disabled="running || saving || loading" @click="run(site.id)">
                  单项重测
                </button>
                <button class="danger" :disabled="saving || loading" @click="remove(site)">
                  移除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted routing-help">
      结果来自表中检测域名。无法获取 IP 不代表网站不可用；请求耗时包含浏览器请求过程，不是 Ping
      延迟。国家或地区由检测接口提供，缺失时显示未知。
    </p>
    <ModalDialog v-if="adding" label="添加网站" :dismissible="!saving" @close="adding = false">
      <h2>添加网站</h2>
      <form id="website-routing-add" class="routing-form" @submit.prevent="add">
        <label
          >添加方式<select v-model="addMode" :disabled="saving">
            <option value="preset">预置网站</option>
            <option value="custom">自定义域名</option>
          </select></label
        >
        <label v-if="addMode === 'preset'"
          >预置网站<select v-model="presetId" required :disabled="saving">
            <option value="" disabled>请选择网站</option>
            <option
              v-for="preset in websiteRoutingPresets"
              :key="preset.key"
              :value="preset.key"
              :disabled="presentOrigins.has(origin(preset.url))"
            >
              {{ preset.name }}{{ presentOrigins.has(origin(preset.url)) ? '（已添加）' : '' }}
            </option>
          </select></label
        >
        <template v-else>
          <label
            >网站域名或网址<input
              v-model="domain"
              required
              maxlength="2048"
              placeholder="example.com 或 https://example.com/path"
              :disabled="saving"
          /></label>
          <label
            >网站名称（可选）<input
              v-model="name"
              maxlength="80"
              placeholder="默认使用网站域名"
              :disabled="saving"
          /></label>
          <p class="muted">将使用 HTTPS 检测域名的出口 IP；网站不支持时会显示无法获取。</p>
          <p v-if="previewDomain" class="domain-preview">
            实际检测域名：<strong>{{ previewDomain }}</strong>
          </p>
        </template>
        <p v-if="formMessage" class="notice is-error" role="alert">{{ formMessage }}</p>
      </form>
      <template #footer
        ><button :disabled="saving" @click="adding = false">取消</button
        ><button class="primary" type="submit" form="website-routing-add" :disabled="saving">
          {{ saving ? '正在添加…' : '添加' }}
        </button></template
      >
    </ModalDialog>
  </section>
</template>

<style scoped>
.routing-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.routing-summary {
  margin-bottom: var(--space-4);
}
.summary-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.summary-heading h2 {
  font-size: var(--text-lg);
  margin-bottom: var(--space-3);
}
.summary-heading p {
  font-size: var(--text-sm);
  color: var(--muted);
}
.ip-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: var(--space-3);
}
.ip-group {
  min-width: 0;
  padding: var(--space-3);
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-subtle);
}
.ip-group > span {
  display: block;
  margin-top: var(--space-1);
}
.ip-group p {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.ip-value {
  font-family: var(--mono);
  overflow-wrap: anywhere;
}
.website-table {
  overflow-x: auto;
  padding: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
th,
td {
  padding: var(--space-3);
  border-bottom: var(--border-width) solid var(--border);
  vertical-align: top;
}
th {
  background: var(--surface-subtle);
  color: var(--muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}
td {
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
td:first-child {
  max-width: 220px;
}
td:nth-child(2) {
  max-width: 210px;
}
td:nth-child(5) {
  max-width: 240px;
}
td > .muted,
.result-message,
td > .ip-value {
  display: block;
}
tr:last-child td {
  border-bottom: 0;
}
.result-message {
  margin-top: var(--space-1);
  color: var(--muted);
}
.routing-state {
  display: inline-block;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-xs);
  color: var(--neutral-text);
  background: var(--neutral-bg);
  font-size: var(--text-xs);
}
.routing-state[data-state='success'] {
  color: var(--ok-text);
  background: var(--ok-bg);
}
.routing-state[data-state='running'] {
  color: var(--info-text);
  background: var(--info-bg);
}
.routing-state[data-state='unavailable'],
.routing-state[data-state='invalid'],
.routing-state[data-state='timeout'] {
  color: var(--warn-text);
  background: var(--warn-bg);
}
.routing-help {
  margin-top: var(--space-3);
}
.routing-form {
  display: grid;
  gap: var(--space-4);
}
.routing-form p {
  margin-bottom: 0;
}
.domain-preview {
  overflow-wrap: anywhere;
}
@media (max-width: 800px) {
  table,
  tbody,
  tr {
    display: block;
  }
  thead {
    display: none;
  }
  tr {
    padding: var(--space-3);
    border-bottom: var(--border-width) solid var(--border);
  }
  tr:last-child {
    border-bottom: 0;
  }
  td {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: var(--space-1) var(--space-2);
    padding: var(--space-2) 0;
    border: 0;
  }
  td:first-child,
  td:nth-child(2),
  td:nth-child(5) {
    max-width: none;
  }
  td::before {
    content: attr(data-label);
    color: var(--muted);
    grid-column: 1;
    grid-row: 1 / span 4;
  }
  td > * {
    grid-column: 2;
  }
  .routing-state {
    justify-self: start;
  }
}
</style>
