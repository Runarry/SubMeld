import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import {
  executionCore,
  measurementText,
  speedCoreLabels,
  type Measurement,
  type SpeedReport,
  type SpeedRow,
} from './shared/miaospeed.js';
import { reportColumns, reportTitle } from './shared/report-export.js';

const WIDTH = 1500,
  HEADER_HEIGHT = 448,
  FOOTER_HEIGHT = 64,
  CARD_HEIGHT = 118,
  CARD_GAP = 10,
  CARD_WIDTH = 466,
  COLUMNS_PER_GROUP = 6,
  ROWS_PER_PAGE = 8,
  MAX_PHOTO_BYTES = 10_000_000;
const FONT =
  '"Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const rowLabels: Record<SpeedRow['state'], string> = {
  pending: '待测',
  running: '测试中',
  completed: '已完成',
  partial: '部分未知',
  failed: '失败',
  unsupported: '不支持',
  cancelled: '已取消',
  stale: '内容已变化',
};
const reportLabels: Record<SpeedReport['state'], string> = {
  running: '测试中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  interrupted: '已中断',
};
const measurementLabels: Record<Measurement['status'], string> = {
  measured: '已测量',
  unknown: '未知',
  failed: '失败',
  unsupported: '不支持',
  target_error: '目标异常',
};
type Column = ReturnType<typeof reportColumns>[number];
type Group = { label: string; columns: Column[] };

function font(ctx: SKRSContext2D, size: number, bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
}

function text(
  ctx: SKRSContext2D,
  input: string,
  x: number,
  y: number,
  width: number,
  maxLines = 1,
  lineHeight = 22,
) {
  const lines = [''];
  for (const { segment } of segmenter.segment(input.replace(/\s+/gu, ' ').replace(/\0/g, ''))) {
    const last = lines.length - 1;
    if (ctx.measureText(lines[last] + segment).width <= width) lines[last] += segment;
    else if (lines.length < maxLines) lines.push(segment);
    else {
      const tail = Array.from(segmenter.segment(lines[last]), (part) => part.segment);
      while (tail.length && ctx.measureText(tail.join('') + '…').width > width) tail.pop();
      lines[last] = tail.join('') + '…';
      break;
    }
  }
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
}

function groups(report: SpeedReport): Group[] {
  const columns = reportColumns(report),
    result: Group[] = [];
  for (const [label, selected] of [
    ['综合指标', columns.filter((column) => !column.id.startsWith('script:'))],
    ['检测脚本', columns.filter((column) => column.id.startsWith('script:'))],
  ] as const)
    for (let offset = 0; offset < selected.length; offset += COLUMNS_PER_GROUP)
      result.push({ label, columns: selected.slice(offset, offset + COLUMNS_PER_GROUP) });
  return result.length ? result : [{ label: '报告概览', columns: [] }];
}

function background(metric: Measurement | undefined) {
  if (metric?.status === 'measured') return metric.color ?? '#e4f3e9';
  if (metric?.status === 'target_error') return '#fff0cf';
  if (metric?.status === 'failed') return '#fbe0da';
  return '#edf0f4';
}

function foreground(color: string) {
  const rgb = color
    .slice(1)
    .match(/.{2}/g)!
    .map((part) => Number.parseInt(part, 16));
  return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 140 ? '#ffffff' : '#18232c';
}

function cards(ctx: SKRSContext2D, columns: Column[], top: number, row?: SpeedRow) {
  columns.forEach((column, index) => {
    const metric = row?.measurements.find((measurement) => measurement.id === column.id),
      x = 36 + (index % 3) * 480,
      y = top + Math.floor(index / 3) * (CARD_HEIGHT + CARD_GAP),
      color = background(metric);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, CARD_WIDTH, CARD_HEIGHT);
    ctx.fillStyle = foreground(color);
    font(ctx, 16, true);
    text(ctx, column.label, x + 12, y + 10, CARD_WIDTH - 24, 2, 20);
    font(ctx, 18);
    text(
      ctx,
      metric
        ? `${measurementLabels[metric.status]} · ${measurementText(metric)}`
        : `未知 · ${row?.message || (row ? '没有返回此项结果' : '没有节点结果')}`,
      x + 12,
      y + 60,
      CARD_WIDTH - 24,
      2,
    );
  });
}

function header(
  ctx: SKRSContext2D,
  report: SpeedReport,
  group: Group,
  groupIndex: number,
  groupCount: number,
  offset: number,
  count: number,
  page: number,
) {
  ctx.fillStyle = '#16222f';
  font(ctx, 28, true);
  text(ctx, report.name, 30, 24, WIDTH - 60, 2, 32);
  font(ctx, 17);
  text(ctx, reportTitle(report).slice(report.name.length + 3), 30, 96, WIDTH - 60, 2);
  font(ctx, 19, true);
  text(
    ctx,
    `报告状态：${reportLabels[report.state]} · ${report.completed} / ${report.total} 项已结束 · 已记录 ${report.results.length} 个节点`,
    30,
    148,
    WIDTH - 60,
  );
  ctx.fillStyle = '#a4382a';
  font(ctx, 17);
  text(ctx, report.error ?? '', 30, 178, WIDTH - 60, 2);
  ctx.fillStyle = '#364555';
  const settings = report.settings,
    parameters = [
      `下行 ${settings.downloadSeconds}s × ${settings.downloadThreads} 线程 · 上行 ${settings.uploadSeconds}s × ${settings.uploadThreads} 线程 · Ping ${settings.pingCount} 次`,
      `重试 ${settings.retries} · 请求超时 ${settings.requestTimeoutMs}ms · 任务上限 ${settings.timeoutSeconds}s`,
      'HTTPS 目标：' + settings.pingUrl,
      '下载目标：' + settings.downloadUrl,
      '上传目标：' + settings.uploadUrl,
      'STUN：' + settings.stunAddress,
    ];
  font(ctx, 16);
  parameters.forEach((line, index) => text(ctx, line, 30, 224 + index * 25, WIDTH - 60));
  font(ctx, 19, true);
  ctx.fillStyle = '#16222f';
  text(
    ctx,
    `${group.label} · 第 ${groupIndex + 1} / ${groupCount} 组 · ${group.columns.length} 列 · 节点 ${count ? offset + 1 : 0}–${offset + count} / ${report.results.length} · 图 ${page}`,
    30,
    392,
    WIDTH - 60,
  );
}

async function imagePage(
  report: SpeedReport,
  group: Group,
  groupIndex: number,
  groupCount: number,
  offset: number,
  count: number,
  page: number,
): Promise<Uint8Array> {
  const rowHeight = 166 + Math.ceil(group.columns.length / 3) * (CARD_HEIGHT + CARD_GAP),
    height = Math.max(900, HEADER_HEIGHT + count * rowHeight + FOOTER_HEIGHT),
    canvas = createCanvas(WIDTH, height);
  try {
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(0, 0, WIDTH, height);
    header(ctx, report, group, groupIndex, groupCount, offset, count, page);
    for (let index = 0; index < count; index++) {
      const row = report.results[offset + index],
        top = HEADER_HEIGHT + index * rowHeight;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(20, top, WIDTH - 40, rowHeight - 14);
      ctx.fillStyle = '#16222f';
      font(ctx, 22, true);
      text(ctx, `#${row.index + 1} ${row.name}`, 36, top + 12, WIDTH - 72, 2, 26);
      font(ctx, 18);
      text(
        ctx,
        `协议 ${row.protocol || '未知'} · 状态 ${rowLabels[row.state]}${row.stale ? ' · 快照已过期' : ''} · 执行内核 ${speedCoreLabels[executionCore(report.settings)]}`,
        36,
        top + 72,
        WIDTH - 72,
      );
      text(ctx, '内核版本：' + (row.coreVersion || '未知'), 36, top + 98, WIDTH - 72);
      font(ctx, 16);
      ctx.fillStyle = '#596879';
      text(ctx, row.message, 36, top + 124, WIDTH - 72);
      cards(ctx, group.columns, top + 148, row);
    }
    if (!count) {
      ctx.fillStyle = '#16222f';
      font(ctx, 22, true);
      text(ctx, '没有记录节点结果，请查看报告状态和错误信息。', 36, HEADER_HEIGHT + 20, WIDTH - 72);
      cards(ctx, group.columns, HEADER_HEIGHT + 94);
    }
    ctx.fillStyle = '#596879';
    font(ctx, 16);
    text(
      ctx,
      '完整参数、原始单位、采样及 IP/ASN 拓扑见同批次 CSV。图中过长文本以省略号结尾。',
      30,
      height - 34,
      WIDTH - 60,
    );
    return await canvas.encode('png');
  } finally {
    // Release the page's native pixel allocation before the consumer sends it.
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function* reportImages(
  report: SpeedReport,
): AsyncGenerator<{ name: string; data: Uint8Array; contentType: 'image/png' }> {
  const selected = groups(report);
  let page = 1;
  for (const [groupIndex, group] of selected.entries()) {
    let offset = 0;
    do {
      let count = Math.min(ROWS_PER_PAGE, report.results.length - offset),
        data: Uint8Array;
      for (;;) {
        data = await imagePage(report, group, groupIndex, selected.length, offset, count, page);
        if (data.byteLength <= MAX_PHOTO_BYTES) break;
        if (count <= 1) throw new Error('单个节点的 PNG 报告超过 Telegram 10 MB 图片限制。');
        count = Math.max(1, Math.floor(count / 2));
      }
      yield {
        name: `submeld-${report.id}-${page}-g${groupIndex + 1}-rows${count ? offset + 1 : 0}-${offset + count}.png`,
        data,
        contentType: 'image/png',
      };
      offset += count;
      page++;
    } while (offset < report.results.length);
  }
}
