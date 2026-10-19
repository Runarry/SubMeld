import {
  executionCore,
  measurementText,
  metricDefinitions,
  speedCoreLabels,
  type SpeedReport,
  type SpeedRow,
} from './miaospeed.js';

export function reportColumns(report: SpeedReport): { id: string; label: string }[] {
  return [
    ...report.metrics.map((id) => ({
      id,
      label: metricDefinitions.find((metric) => metric[0] === id)![1],
    })),
    ...report.scripts.map((script) => ({ id: 'script:' + script.id, label: script.name })),
  ];
}

export function reportTitle(report: SpeedReport): string {
  return `${report.name} · ${report.createdAt} · miaospeed ${report.backendVersion ?? '未知'} · 节点内核 ${speedCoreLabels[report.settings.nodeCore]}`;
}

function cell(input: unknown) {
  let value = String(input ?? '').replace(/\0/g, '');
  if (/^[\s]*[=+@-]/.test(value)) value = "'" + value;
  return '"' + value.replaceAll('"', '""') + '"';
}

export function reportCsv(
  report: SpeedReport,
  rows: SpeedRow[] = report.results,
  columns: { id: string; label: string }[] = reportColumns(report),
): string {
  const records: unknown[][] = [
    [reportTitle(report)],
    ['测试参数', JSON.stringify(report.settings)],
    [
      '节点',
      '协议',
      '状态',
      '过期',
      '执行内核',
      '内核版本',
      ...columns.map((column) => column.label),
      '测量明细（JSON，含原始值、单位、采样及拓扑）',
    ],
  ];
  for (const row of rows)
    records.push([
      row.name,
      row.protocol,
      row.state,
      row.stale ? '是' : '否',
      speedCoreLabels[executionCore(report.settings)],
      row.coreVersion,
      ...columns.map((column) => {
        const metric = row.measurements.find((measurement) => measurement.id === column.id);
        return metric ? measurementText(metric) : row.message;
      }),
      JSON.stringify(row.measurements),
    ]);
  return '\uFEFF' + records.map((record) => record.map(cell).join(',')).join('\r\n');
}
