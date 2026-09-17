import { computed, inject, reactive, onBeforeUnmount, ref, watch, type InjectionKey } from 'vue';
import {
  subjectKey,
  testResultsSchema,
  type TestResult,
  type TestSubject,
} from '../server/shared/node-tests';
export type TestActions = {
  start: (subjects: TestSubject[]) => Promise<void>;
  show: (subjects?: TestSubject[]) => void;
};
export const testActionsKey: InjectionKey<TestActions> = Symbol('node-tests');
export function useNodeTests(
  subjects: () => TestSubject[],
  api: (path: string, body?: unknown) => Promise<unknown>,
) {
  const actions = inject(testActionsKey);
  const results = ref<TestResult[]>([]),
    error = ref(''),
    starting = ref(false);
  let alive = true,
    epoch = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const selection = computed(() => JSON.stringify(subjects()));
  async function refresh(ticket: number) {
    const values = subjects();
    try {
      const value = values.length
        ? testResultsSchema.parse(await api('/api/node-tests/results/query', { subjects: values }))
            .results
        : [];
      if (alive && epoch === ticket) {
        results.value = value;
        error.value = '';
      }
    } catch (failure) {
      if (alive && epoch === ticket)
        error.value = failure instanceof Error ? failure.message : '测试结果读取失败。';
    } finally {
      if (alive && epoch === ticket)
        timer = setTimeout(() => {
          void refresh(ticket);
        }, 2000);
    }
  }
  watch(
    selection,
    () => {
      clearTimeout(timer);
      results.value = [];
      void refresh(++epoch);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    alive = false;
    epoch++;
    clearTimeout(timer);
  });
  return reactive({
    error,
    starting,
    forSubject: (subject: TestSubject) =>
      results.value.filter((result) => subjectKey(result.subject) === subjectKey(subject)),
    show: (selected: TestSubject[]) => actions?.show(selected),
    async start(selected: TestSubject[]) {
      if (!actions || starting.value) return;
      starting.value = true;
      error.value = '';
      try {
        await actions.start(selected);
      } catch (failure) {
        if (alive) error.value = failure instanceof Error ? failure.message : '无法开始测试。';
      } finally {
        if (alive) starting.value = false;
      }
    },
  });
}
