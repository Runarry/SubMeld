import {
  measurementText,
  executionCore,
  speedCoreLabels,
  type SpeedReport,
  type SpeedRow,
} from '../server/shared/miaospeed';
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const title = (report: SpeedReport) =>
  `${report.name} · ${report.createdAt} · miaospeed ${report.backendVersion ?? '未知'} · 节点内核 ${speedCoreLabels[report.settings.nodeCore]} · 链内核 ${speedCoreLabels[report.settings.chainCore]}`;
function cell(input: unknown) {
  let value = String(input ?? '').replace(/\0/g, '');
  if (/^[\s]*[=+@-]/.test(value)) value = "'" + value;
  return '"' + value.replaceAll('"', '""') + '"';
}
export function exportCsv(
  report: SpeedReport,
  rows: SpeedRow[],
  columns: { id: string; label: string }[],
) {
  const records: unknown[][] = [
    [title(report)],
    ['测试参数', JSON.stringify(report.settings)],
    [
      '节点',
      '协议',
      '状态',
      '过期',
      '执行内核',
      '内核版本',
      ...columns.map((c) => c.label),
      '测量明细（JSON，含原始值、单位、采样及拓扑）',
    ],
  ];
  for (const row of rows)
    records.push([
      row.name,
      row.protocol,
      row.state,
      row.stale ? '是' : '否',
      speedCoreLabels[executionCore(report.settings, row.subject)],
      row.coreVersion,
      ...columns.map((column) => {
        const metric = row.measurements.find((m) => m.id === column.id);
        return metric ? measurementText(metric) : row.message;
      }),
      JSON.stringify(row.measurements),
    ]);
  download(
    new Blob(['\uFEFF' + records.map((record) => record.map(cell).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    }),
    'submeld-' + report.id + '.csv',
  );
}
export async function exportPng(
  report: SpeedReport,
  rows: SpeedRow[],
  columns: { id: string; label: string }[],
  page: number,
) {
  const parameters = [
    `下行 ${report.settings.downloadSeconds}s × ${report.settings.downloadThreads} · 上行 ${report.settings.uploadSeconds}s × ${report.settings.uploadThreads} · Ping ${report.settings.pingCount} 次 · 第 ${page + 1} 页`,
    `重试 ${report.settings.retries} · 请求超时 ${report.settings.requestTimeoutMs}ms · 任务上限 ${report.settings.timeoutSeconds}s`,
    'HTTPS 目标：' + report.settings.pingUrl,
    '下载目标：' + report.settings.downloadUrl,
    '上传目标：' + report.settings.uploadUrl,
    'STUN：' + report.settings.stunAddress,
  ].flatMap((line) => line.match(/.{1,130}/gu) ?? []);
  const headerHeight = 105 + parameters.length * 24;
  const rowHeight = 58 + Math.ceil(columns.length / 3) * 44,
    height = headerHeight + 30 + rows.length * rowHeight;
  if (height > 16000)
    throw new Error('所选列超过单张图片尺寸，请减少展示列后导出。CSV 可导出全部结果。');
  const canvas = document.createElement('canvas');
  canvas.width = 1500;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建报告图片。');
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, canvas.width, height);
  ctx.fillStyle = '#16222f';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(report.name, 30, 40);
  ctx.font = '16px sans-serif';
  ctx.fillText(title(report).slice(0, 150), 30, 72);
  parameters.forEach((line, i) => ctx.fillText(line, 30, 102 + i * 24));
  rows.forEach((row, index) => {
    const top = headerHeight + index * rowHeight;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(20, top, 1460, rowHeight - 8);
    ctx.fillStyle = '#16222f';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillText(
      `${row.name} · ${row.protocol} · ${row.stale ? '内容已变化' : row.state} · ${speedCoreLabels[executionCore(report.settings, row.subject)]} ${row.coreVersion ?? ''}`.slice(
        0,
        140,
      ),
      35,
      top + 28,
    );
    ctx.font = '15px sans-serif';
    columns.forEach((column, i) => {
      const metric = row.measurements.find((m) => m.id === column.id),
        x = 35 + (i % 3) * 480,
        y = top + 42 + Math.floor(i / 3) * 44;
      ctx.fillStyle = metric?.color ?? (metric?.status === 'measured' ? '#e4f3e9' : '#edf0f4');
      ctx.fillRect(x, y, 465, 38);
      ctx.fillStyle = '#18232c';
      ctx.fillText(
        (column.label + ': ' + (metric ? measurementText(metric) : row.message || '待测'))
          .replace(/\s+/g, ' ')
          .slice(0, 46),
        x + 7,
        y + 24,
      );
    });
  });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('PNG 生成失败。'))),
      'image/png',
    ),
  );
  download(blob, `submeld-${report.id}-${page + 1}.png`);
}
