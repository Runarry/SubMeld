<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, provide } from 'vue';
import TestCenter from './TestCenter.vue';
import SupportFiles from './SupportFiles.vue';
import LoginView from './LoginView.vue';
import NodeLibrary from './NodeLibrary.vue';
import { testActionsKey } from './nodeTests';
import { type TestSubject } from '../server/shared/node-tests';
import SubscriptionLibrary from './SubscriptionLibrary.vue';
import MachinesPage from './MachinesPage.vue';
import RelaysPage from './RelaysPage.vue';
import WebsiteRoutingPage from './WebsiteRoutingPage.vue';

import { ApiError, request } from './api';

type View =
  'library' | 'subscriptions' | 'tests' | 'supportFiles' | 'machines' | 'relays' | 'websiteRouting';
const nav = [
  { view: 'machines' as const, hash: 'machines', label: '机器' },
  { view: 'library' as const, hash: 'nodes', label: '节点' },
  { view: 'relays' as const, hash: 'relays', label: '中转线路' },
  { view: 'subscriptions' as const, hash: 'subscriptions', label: '输出方案' },
  { view: 'tests' as const, hash: 'tests', label: '测试中心' },
  { view: 'websiteRouting' as const, hash: 'website-routing', label: '网站分流测试' },
  { view: 'supportFiles' as const, hash: 'support-files', label: '配套文件' },
];
const mobileMore = ref(false);
const primaryViews: View[] = ['machines', 'library', 'relays', 'tests'];
const lastRoutes = new Map<View, string>();
const authenticated = ref(false);
const checking = ref(true);
const password = ref('');
const view = ref<View | null>('library');
const busy = ref('');
const message = ref('');
const testMessage = ref('');
const testSubjects = ref<TestSubject[]>([]);
const testInitialTab = ref<'comprehensive' | 'cores'>('comprehensive');
provide(testActionsKey, {
  async start(subjects) {
    testInitialTab.value = 'comprehensive';
    testSubjects.value = subjects;
    testMessage.value = '';
    setView('tests');
  },
  show(subjects = []) {
    testInitialTab.value = 'cores';
    testSubjects.value = subjects;
    testMessage.value = '';
    setView('tests');
  },
});

function parseHash(): View | null {
  const key = location.hash.replace(/^#\/?/, '').split('?')[0];
  if (key === 'koipy') return 'tests';
  if (key === 'support-files' || key === 'tools') return 'supportFiles';
  if (key === 'tests') return 'tests';
  if (key === 'website-routing') return 'websiteRouting';
  if (key === 'chains') return 'relays';
  if (key === 'machines') return 'machines';
  if (key === 'relays') return 'relays';
  if (key === 'sources' || key === 'workbench') return 'library';
  if (key === 'nodes' || key === 'library') return 'library';

  return key === 'subscriptions' ? 'subscriptions' : null;
}
function setView(next: View) {
  const current = parseHash();
  if (current) lastRoutes.set(current, location.hash);
  const item = nav.find((entry) => entry.view === next);
  const hash = lastRoutes.get(next) ?? '#/' + (item?.hash ?? 'nodes');
  mobileMore.value = false;
  if (location.hash !== hash) location.hash = hash;
  view.value = next;
}
function onHashChange() {
  if (authenticated.value) {
    const route = parseHash();
    const next = route ?? 'library';
    const canonical = nav.find((item) => item.view === next)!.hash;
    const key = location.hash.replace(/^#\/?/, '').split('?')[0];
    if (key !== canonical) {
      const query = route && key !== 'chains' ? location.hash.split('?')[1] : undefined;
      history.replaceState(null, '', '#/' + canonical + (query ? '?' + query : ''));
    }
    lastRoutes.set(next, location.hash);
    view.value = next;
    mobileMore.value = false;
  }
}
function lockWorkspace() {
  authenticated.value = false;
  testSubjects.value = [];
  testMessage.value = '';
  password.value = '';
  message.value = '';
  view.value = 'library';
}
async function api(path: string, body?: unknown, method?: string): Promise<unknown> {
  try {
    return await request(path, body, method);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && path !== '/api/auth/login')
      lockWorkspace();
    throw error;
  }
}
async function login() {
  busy.value = 'login';
  message.value = '';
  try {
    await api('/api/auth/login', { password: password.value });
    authenticated.value = true;
    password.value = '';
    onHashChange();
  } catch (error) {
    message.value = error instanceof ApiError ? error.message : '无法连接服务。';
  } finally {
    busy.value = '';
  }
}
async function logout() {
  busy.value = 'logout';
  try {
    await api('/api/auth/logout', {});
    lockWorkspace();
  } catch (error) {
    message.value = error instanceof Error ? error.message : '退出失败，请重试。';
  } finally {
    busy.value = '';
  }
}
onMounted(async () => {
  window.addEventListener('hashchange', onHashChange);
  try {
    await api('/api/auth/me');
    authenticated.value = true;
    onHashChange();
  } catch {
    /* Login remains available without a session. */
  } finally {
    checking.value = false;
  }
});
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange));
</script>

<template>
  <div v-if="checking" class="checking"><p role="status">正在检查登录状态…</p></div>
  <LoginView
    v-else-if="!authenticated"
    v-model:password="password"
    :busy="busy === 'login'"
    :message="message"
    @login="login"
  />
  <div v-else class="shell">
    <div class="rail-brand">
      <span class="brand-mark" aria-hidden="true">S</span>
      <span>SubMeld</span>
      <span class="version">2.0.0</span>
    </div>
    <nav class="app-nav" aria-label="管理页面">
      <span class="nav-caption">管理</span>
      <button
        v-for="item in nav"
        :key="item.view"
        type="button"
        :class="{ active: view === item.view, 'nav-secondary': !primaryViews.includes(item.view) }"
        :aria-current="view === item.view ? 'page' : undefined"
        @click="setView(item.view)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="item.view === 'machines'">
            <rect x="4" y="3" width="16" height="18" rx="3" />
            <path d="M4 12h16M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4" />
          </template>
          <template v-else-if="item.view === 'library'">
            <circle cx="12" cy="5" r="2.5" />
            <circle cx="5" cy="18" r="2.5" />
            <circle cx="19" cy="18" r="2.5" />
            <path d="m10.8 7.2-4.6 8.6m7-8.6 4.6 8.6M7.5 18h9" />
          </template>
          <path v-else-if="item.view === 'relays'" d="M4 7h15l-4-4M20 17H5l4 4" />
          <template v-else-if="item.view === 'subscriptions'">
            <path
              d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"
            />
          </template>
          <template v-else-if="item.view === 'tests'">
            <path d="M3 12h4l3-7 4 14 3-7h4M3 21h18" />
          </template>
          <template v-else-if="item.view === 'websiteRouting'">
            <circle cx="12" cy="12" r="9" />
            <ellipse cx="12" cy="12" rx="4" ry="9" />
            <path d="M3 12h18" />
          </template>
          <template v-else>
            <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-12-2 16" />
          </template>
        </svg>
        {{ item.label }}
      </button>
      <button
        class="nav-more-trigger"
        :class="{ active: !primaryViews.includes(view ?? 'library') }"
        :aria-expanded="mobileMore"
        @click="mobileMore = !mobileMore"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="19" cy="12" r="1.5" /></svg
        >更多
      </button>
      <div v-if="mobileMore" class="nav-more-panel" aria-label="更多页面">
        <button
          v-for="item in nav.filter((item) => !primaryViews.includes(item.view))"
          :key="item.view"
          :class="{ active: view === item.view }"
          @click="setView(item.view)"
        >
          {{ item.label }}
        </button>
      </div>
    </nav>
    <div class="rail-foot">
      <button type="button" :disabled="!!busy" @click="logout">退出登录</button>
      <a class="source-link" href="/source.tar.gz">对应版本源码（AGPL）</a>
    </div>
    <main class="content">
      <p v-if="testMessage" class="notice" role="status">
        {{ testMessage }}
        <button
          type="button"
          @click="
            testSubjects = [];
            testMessage = '';
            setView('tests');
          "
        >
          查看测试进度
        </button>
      </p>
      <SupportFiles v-if="view === 'supportFiles'" :api="api" />
      <TestCenter
        v-if="view === 'tests'"
        :key="testInitialTab"
        :api="api"
        :subjects="testSubjects"
        :initial-tab="testInitialTab"
      />
      <NodeLibrary v-if="view === 'library'" :api="api" />
      <SubscriptionLibrary v-if="view === 'subscriptions'" :api="api" />
      <MachinesPage v-if="view === 'machines'" :api="api" />
      <RelaysPage v-if="view === 'relays'" :api="api" />
      <WebsiteRoutingPage v-if="view === 'websiteRouting'" :api="api" />
    </main>
  </div>
</template>
