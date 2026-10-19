<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, provide } from 'vue';
import HomePage from './HomePage.vue';
import TestCenter from './TestCenter.vue';
import SupportFiles from './SupportFiles.vue';
import LoginView from './LoginView.vue';
import NodeLibrary from './NodeLibrary.vue';
import { testActionsKey } from './nodeTests';
import { type TestSubject } from '../server/shared/node-tests';
import ChainLibrary from './ChainLibrary.vue';
import SubscriptionLibrary from './SubscriptionLibrary.vue';
import MachinesPage from './MachinesPage.vue';
import RelaysPage from './RelaysPage.vue';

import { ApiError, request } from './api';

type View =
  | 'home'
  | 'library'
  | 'chains'
  | 'subscriptions'
  | 'tests'
  | 'supportFiles'
  | 'machines'
  | 'relays';
const nav = [
  { view: 'machines' as const, hash: 'machines', label: '机器' },
  { view: 'library' as const, hash: 'nodes', label: '节点' },
  { view: 'relays' as const, hash: 'relays', label: '中转线路' },
  { view: 'chains' as const, hash: 'chains', label: '两跳链' },
  { view: 'subscriptions' as const, hash: 'subscriptions', label: '输出方案' },
  { view: 'tests' as const, hash: 'tests', label: '测试中心' },
  { view: 'supportFiles' as const, hash: 'support-files', label: '配套文件' },
  { view: 'home' as const, hash: 'home', label: '服务入口' },
];
const mobileMore = ref(false);
const primaryViews: View[] = ['machines', 'library', 'relays', 'tests'];
const lastRoutes = new Map<View, string>();
const authenticated = ref(false);
const checking = ref(true);
const password = ref('');
const view = ref<View | null>('home');
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

function parseHash(): View {
  const key = location.hash.replace(/^#\/?/, '').split('?')[0];
  if (key === 'koipy') return 'tests';
  if (key === 'support-files' || key === 'tools') return 'supportFiles';
  if (key === 'tests') return 'tests';
  if (key === 'chains') return 'chains';
  if (key === 'machines') return 'machines';
  if (key === 'relays') return 'relays';
  if (key === 'sources' || key === 'workbench') return 'library';
  if (key === 'nodes' || key === 'library') return 'library';

  return key === 'subscriptions' ? 'subscriptions' : 'home';
}
function setView(next: View) {
  if (location.hash) lastRoutes.set(parseHash(), location.hash);
  const item = nav.find((entry) => entry.view === next);
  const hash = lastRoutes.get(next) ?? '#/' + (item?.hash ?? 'home');
  mobileMore.value = false;
  if (location.hash !== hash) location.hash = hash;
  view.value = next;
}
function onHashChange() {
  if (authenticated.value) {
    const next = parseHash();
    const canonical = nav.find((item) => item.view === next)!.hash;
    if (location.hash.replace(/^#\/?/, '').split('?')[0] !== canonical) {
      const query = location.hash.split('?')[1];
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
  view.value = 'home';
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
        @click="setView(item.view)"
      >
        <svg
          v-if="item.view === 'machines'"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <rect x="2" y="1.5" width="12" height="13" rx="2" />
          <path d="M2 8h12M5 5h1M5 11h1M9 5h3M9 11h3" />
        </svg>
        <svg
          v-else-if="item.view === 'relays'"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d="M2 5h11l-3-3M14 11H3l3 3" />
        </svg>
        <svg v-else-if="item.view === 'subscriptions'" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5zM4 5h8v1.5H4zm0 3h5v1.5H4z"
          />
        </svg>
        <svg v-else-if="item.view === 'chains'" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 1.5a4 4 0 0 0-3.46 6H3a2.5 2.5 0 0 0 0 5h10a2.5 2.5 0 0 0 0-5h-1.54A4 4 0 0 0 8 1.5"
          />
        </svg>
        <svg v-else-if="item.view === 'library'" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5V14l-5-2-5 2z"
          />
        </svg>
        <svg v-else viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M2 3h12v2H2zm0 4h8v2H2zm0 4h12v2H2z" />
        </svg>
        {{ item.label }}
      </button>
      <button
        class="nav-more-trigger"
        :class="{ active: !primaryViews.includes(view ?? 'home') }"
        :aria-expanded="mobileMore"
        @click="mobileMore = !mobileMore"
      >
        <span aria-hidden="true">•••</span>更多
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
      <HomePage v-if="view === 'home'" :api="api" @navigate="setView" />
      <SupportFiles v-if="view === 'supportFiles'" :api="api" />
      <TestCenter
        v-if="view === 'tests'"
        :key="testInitialTab"
        :api="api"
        :subjects="testSubjects"
        :initial-tab="testInitialTab"
      />
      <NodeLibrary v-if="view === 'library'" :api="api" />
      <ChainLibrary v-if="view === 'chains'" :api="api" />
      <SubscriptionLibrary v-if="view === 'subscriptions'" :api="api" />
      <MachinesPage v-if="view === 'machines'" :api="api" />
      <RelaysPage v-if="view === 'relays'" :api="api" />
    </main>
  </div>
</template>
