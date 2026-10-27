import {
  measurementText,
  executionCore,
  speedCoreLabels,
  type Measurement,
  type SpeedReport,
  type SpeedRow,
} from '../server/shared/miaospeed';
import { reportBackend, reportCsv, reportTitle } from '../server/shared/report-export';

const measurementTokens: Record<Measurement['status'], string> = {
  measured: 'measured',
  failed: 'failed',
  target_error: 'target-error',
  unknown: 'unknown',
  unsupported: 'unknown',
};
function dataTextToken(background: string) {
  const linearChannel = (start: number) => {
    const channel = parseInt(background.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    ? '--data-on-light'
    : '--data-on-dark';
}
export function measurementColors(
  measurement?: Measurement,
  token = (name: string) => `var(${name})`,
) {
  if (measurement?.color)
    return {
      backgroundColor: measurement.color,
      color: token(dataTextToken(measurement.color)),
    };
  const status = measurementTokens[measurement?.status ?? 'unknown'];
  return {
    backgroundColor: token(`--measurement-${status}-bg`),
    color: token(`--measurement-${status}-text`),
  };
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function exportCsv(
  report: SpeedReport,
  rows: SpeedRow[],
  columns: { id: string; label: string }[],
) {
  download(
    new Blob([reportCsv(report, rows, columns)], {
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
    reportBackend(report),
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
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  ctx.fillStyle = token('--bg');
  ctx.fillRect(0, 0, canvas.width, height);
  ctx.fillStyle = token('--text');
  ctx.font = token('--export-title-font');
  ctx.fillText(report.name, 30, 40);
  ctx.font = token('--export-body-font');
  ctx.fillText(reportTitle(report).slice(0, 150), 30, 72);
  parameters.forEach((line, i) => ctx.fillText(line, 30, 102 + i * 24));
  rows.forEach((row, index) => {
    const top = headerHeight + index * rowHeight;
    ctx.fillStyle = token('--surface');
    ctx.fillRect(20, top, 1460, rowHeight - 8);
    ctx.fillStyle = token('--text');
    ctx.font = token('--export-row-font');
    ctx.fillText(
      `${row.name} · ${row.protocol} · ${row.stale ? '内容已变化' : row.state} · ${speedCoreLabels[executionCore(report.settings)]} ${row.coreVersion ?? ''}`.slice(
        0,
        140,
      ),
      35,
      top + 28,
    );
    ctx.font = token('--export-metric-font');
    columns.forEach((column, i) => {
      const metric = row.measurements.find((m) => m.id === column.id),
        x = 35 + (i % 3) * 480,
        y = top + 42 + Math.floor(i / 3) * 44;
      const colors = measurementColors(metric, token);
      ctx.fillStyle = colors.backgroundColor;
      ctx.fillRect(x, y, 465, 38);
      ctx.fillStyle = colors.color;
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
