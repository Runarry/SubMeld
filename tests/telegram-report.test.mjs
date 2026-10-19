import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { reportImages } from '../dist/server/telegram-report.js';
import { reportColumns, reportCsv, reportTitle } from '../dist/server/shared/report-export.js';
import {
  measurementSchema,
  metricDefinitions,
  speedReportSchema,
} from '../dist/server/shared/miaospeed.js';

const id = '5cc5c34d-cc51-4f9c-bcfe-81341273be69',
  revision = 'a'.repeat(64),
  metrics = [
    'TEST_PING_RTT',
    'SPEED_AVERAGE',
    'SPEED_PER_SECOND',
    'GEOIP_OUTBOUND',
    'TEST_HTTP_CODE',
    'UDP_TYPE',
    'TEST_PING_TOTAL_RTT',
  ];
function measurement(metric, values = {}) {
  const definition = metricDefinitions.find(([key]) => key === metric);
  return measurementSchema.parse({
    id: metric,
    label: definition?.[1] ?? metric,
    unit: definition?.[2] ?? '',
    status: 'measured',
    value: 12.34,
    ...values,
  });
}
function fixture(count = 17) {
  const scripts = Array.from({ length: 7 }, (_, index) => ({
    id: `${id.slice(0, -2)}${String(index).padStart(2, '0')}`,
    name: index === 6 ? '超长脚本名称 🌐'.repeat(8) : `脚本-${index + 1} 🎬`,
    revision,
    source: '受控测试',
  }));
  const node = {
    resourceId: id,
    revision,
    snapshotHash: 'b'.repeat(64),
    nodeIndex: 0,
  };
  return speedReportSchema.parse({
    id,
    name: '中文报告 🇸🇬 🚀',
    state: 'cancelled',
    createdAt: '2026-10-01T03:04:05.000Z',
    finishedAt: '2026-10-01T03:05:05.000Z',
    backendVersion: '4.7.6',
    settings: { nodeCore: 'xray' },
    metrics,
    scripts,
    total: count + 2,
    completed: count,
    current: null,
    error: null,
    results: Array.from({ length: count }, (_, index) => {
      const values = [
        measurement('TEST_PING_RTT'),
        measurement('SPEED_AVERAGE', { value: 2097152 }),
        measurement('SPEED_PER_SECOND', {
          value: 1048576,
          samples: [0, 1048576, 2097152],
        }),
        measurement('GEOIP_OUTBOUND', {
          value: '203.0.113.9 · 新加坡 · AS64501',
          geo: [
            {
              ip: '203.0.113.9',
              country: '新加坡',
              countryCode: 'SG',
              asn: 64501,
              organization: '受控组织, "完整拓扑"',
              isp: '受控 ISP',
            },
            {
              ip: '2001:db8::9',
              country: '新加坡',
              countryCode: 'SG',
              asn: 64502,
              organization: 'IPv6 受控组织',
              isp: 'IPv6 ISP',
            },
          ],
        }),
        measurement('TEST_HTTP_CODE', { value: '204, 204', samples: [204, 204] }),
        measurement('UDP_TYPE', { value: 'FullCone' }),
        measurement('TEST_PING_TOTAL_RTT', {
          value: '12.34, 0, 14.56',
          samples: [12.34, 0, 14.56],
        }),
        ...scripts.map((script) =>
          measurement('script:' + script.id, {
            label: script.name,
            value: '未知 · 平台未返回有效响应',
            status: 'unknown',
            color: '#0c2238',
          }),
        ),
      ];
      if (index % 5 === 1)
        values[0] = measurement('TEST_PING_RTT', {
          status: 'unknown',
          value: null,
          message: '没有有效采样',
        });
      if (index % 5 === 2)
        values[4] = measurement('TEST_HTTP_CODE', {
          status: 'failed',
          value: null,
          message: '连接失败',
        });
      if (index % 5 === 3)
        values[7] = measurement('script:' + scripts[0].id, {
          status: 'unsupported',
          value: null,
          message: '该协议不支持此检查',
        });
      if (index % 5 === 4)
        values[1] = measurement('SPEED_AVERAGE', {
          status: 'target_error',
          value: null,
          message: '测试目标 DNS 失败，不是节点连接失败',
        });
      return {
        index,
        subject:
          index === 1
            ? { kind: 'node', ...node }
            : { kind: 'temporary', previewId: id, nodeIndex: index },
        name: `节点-${index + 1} 🇸🇬 👨‍👩‍👧‍👦 中文${index === 0 ? '长名称 🌐'.repeat(100) : ''}`,
        protocol: 'vless',
        state: ['completed', 'partial', 'failed', 'unsupported', 'cancelled'][index % 5],
        stale: index === 1,
        message: index % 5 === 2 ? '没有完成本节点测试' : '',
        testedAt: '2026-10-01T03:05:00.000Z',
        coreVersion: index === 2 ? null : 'Xray 26.9.27',
        measurements: values,
      };
    }),
  });
}
function csvRecords(input) {
  assert.equal(input[0], '\uFEFF');
  const records = [];
  let record = [],
    field = '',
    quoted = false;
  for (let index = 1; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && char === ',') {
      record.push(field);
      field = '';
    } else if (!quoted && char === '\r' && input[index + 1] === '\n') {
      records.push([...record, field]);
      record = [];
      field = '';
      index++;
    } else field += char;
  }
  records.push([...record, field]);
  return records;
}
function captureText(t) {
  const context = createCanvas(1, 1).getContext('2d'),
    prototype = Object.getPrototypeOf(context),
    original = prototype.fillText,
    drawn = [];
  t.mock.method(prototype, 'fillText', function (value, ...args) {
    drawn.push({ value, color: this.fillStyle });
    return original.call(this, value, ...args);
  });
  return drawn;
}

test('shared CSV keeps all rows, chosen metrics/scripts, units, raw samples and full topology', () => {
  const report = fixture(),
    columns = reportColumns(report),
    records = csvRecords(reportCsv(report));
  assert.deepEqual(
    columns.map((column) => column.id),
    [...metrics, ...report.scripts.map((script) => 'script:' + script.id)],
  );
  assert.equal(records[0][0], reportTitle(report));
  assert.deepEqual(JSON.parse(records[1][1]), report.settings);
  assert.deepEqual(
    records[2].slice(6, -1),
    columns.map((column) => column.label),
  );
  assert.equal(records.length, report.results.length + 3);
  for (const [index, row] of report.results.entries()) {
    assert.equal(records[index + 3][0], row.name);
    assert.equal(records[index + 3][2], row.state);
    assert.deepEqual(JSON.parse(records[index + 3].at(-1)), row.measurements);
  }
  assert.equal(records[3][7], '2.00 MiB/s');
  assert.equal(records[4][3], '是');
  assert.equal(records[4][4], 'Xray');
  assert.equal(records[3][4], 'Xray');
  assert.equal(records[3][5], 'Xray 26.9.27');
  assert.match(reportCsv(report), /2001:db8::9/);
  assert.deepEqual(JSON.parse(records[3].at(-1))[2].samples, [0, 1048576, 2097152]);
});

test('CSV preserves filtered order/columns and protects formula cells, quoting and NUL removal', () => {
  const report = fixture(6),
    names = ['=2+2', '\t+SUM(A1:A2)', ' @command', '-1', '逗号,引号"\n下一行', '\0=TRIM(A1)'];
  report.results.forEach((row, index) => {
    row.name = names[index];
    row.protocol = '@protocol';
    row.coreVersion = '-version';
    row.message = '=fallback';
    row.measurements[7].value = '+script-value';
  });
  const chosen = [reportColumns(report)[7], { id: 'missing', label: '=formula heading' }],
    ordered = [...report.results].reverse(),
    records = csvRecords(reportCsv(report, ordered, chosen));
  assert.deepEqual(records[2].slice(6, -1), ['脚本-1 🎬', "'=formula heading"]);
  assert.equal(records[3][0], "'=TRIM(A1)");
  assert.equal(records[4][0], names[4]);
  for (const record of records.slice(3)) {
    assert.equal(record[1], "'@protocol");
    assert.equal(record[5], "'-version");
    assert.equal(record[6], "'+script-value");
    assert.equal(record[7], "'=fallback");
    assert.deepEqual(JSON.parse(record.at(-1)), ordered[records.indexOf(record) - 3].measurements);
  }
  assert.equal(reportCsv(report).includes('\0'), false);
  assert.deepEqual(csvRecords(reportCsv(report, [], [])).slice(3), []);
});

test('PNG pages decode and cover every node and selected column with Chinese, emoji and true states', async (t) => {
  assert.ok(
    ['Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei'].some((family) =>
      GlobalFonts.has(family),
    ),
    'A Chinese system font is required for readable reports',
  );
  assert.ok(['Noto Color Emoji', 'Segoe UI Emoji'].some((family) => GlobalFonts.has(family)));
  const report = fixture(),
    drawn = captureText(t),
    allText = [],
    covered = new Map(),
    selected = reportColumns(report),
    columnGroups = [
      selected.slice(0, 6),
      selected.slice(6, 7),
      selected.slice(7, 13),
      selected.slice(13),
    ];
  let count = 0;
  for await (const page of reportImages(report)) {
    count++;
    assert.equal(page.contentType, 'image/png');
    assert.ok(page.data.byteLength <= 10_000_000);
    const png = Buffer.from(page.data);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20),
      decoded = await loadImage(png);
    assert.equal(width, 1500);
    assert.ok(width + height <= 10000);
    assert.ok(Math.max(width, height) / Math.min(width, height) <= 20);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    const match = page.name.match(/-g(\d+)-rows(\d+)-(\d+)\.png$/);
    assert.ok(match);
    const [group, start, end] = match.slice(1).map(Number),
      lines = drawn.splice(0).map((item) => item.value);
    for (let index = start; index <= end; index++) {
      assert.ok(lines.some((line) => line.startsWith(`#${index} 节点-${index} `)));
      covered.set(`${group}:${index}`, (covered.get(`${group}:${index}`) ?? 0) + 1);
    }
    for (const column of columnGroups[group - 1])
      assert.ok(
        lines.some((line) => line.startsWith(column.label.slice(0, 8))),
        column.label,
      );
    allText.push(...lines);
  }
  assert.equal(count, 12);
  for (let group = 1; group <= columnGroups.length; group++)
    for (let index = 1; index <= report.results.length; index++)
      assert.equal(covered.get(`${group}:${index}`), 1);
  const contents = allText.join('\n');
  for (const value of [
    '中文报告 🇸🇬 🚀',
    '👨‍👩‍👧‍👦',
    '部分未知',
    '失败',
    '不支持',
    '目标异常',
    '未知',
    '已取消',
    '快照已过期',
    'Xray 26.9.27',
    '2.00 MiB/s',
    '完整参数、原始单位、采样及 IP/ASN 拓扑',
  ])
    assert.ok(contents.includes(value), value);
  assert.ok(contents.includes('…'), 'Long names and labels must wrap and explicitly truncate');
  assert.equal(contents.includes('�'), false);
});

test('a failed report with zero results still produces readable error and chosen-column pages', async (t) => {
  const report = fixture(0),
    drawn = captureText(t);
  report.state = 'failed';
  report.error = '后端断线，未产生有效结果。';
  let count = 0;
  for await (const page of reportImages(report)) {
    count++;
    assert.match(page.name, /-rows0-0\.png$/);
    const decoded = await loadImage(Buffer.from(page.data));
    assert.equal(decoded.width, 1500);
    const contents = drawn
      .splice(0)
      .map((item) => item.value)
      .join('\n');
    assert.match(contents, /报告状态：失败/);
    assert.match(contents, /后端断线，未产生有效结果/);
    assert.match(contents, /没有记录节点结果/);
    assert.equal(contents.includes('已测量'), false);
  }
  assert.equal(count, 4);
  assert.equal(csvRecords(reportCsv(report)).length, 3);
});

test('an oversized encoded page reduces its row count without losing nodes and releases the canvas', async (t) => {
  const report = fixture(9),
    prototype = Object.getPrototypeOf(createCanvas(1, 1)),
    original = prototype.encode,
    ranges = [];
  report.metrics = ['TEST_PING_RTT'];
  report.scripts = [];
  let first = true,
    encodedSize;
  t.mock.method(prototype, 'encode', function (format) {
    encodedSize = () => [this.width, this.height];
    if (first) {
      first = false;
      return Promise.resolve(Buffer.alloc(10_000_001));
    }
    return original.call(this, format);
  });
  for await (const page of reportImages(report)) {
    assert.deepEqual(encodedSize(), [1, 1]);
    assert.ok(page.data.byteLength <= 10_000_000);
    ranges.push(
      page.name
        .match(/-rows(\d+)-(\d+)\.png$/)
        .slice(1)
        .map(Number),
    );
  }
  assert.deepEqual(ranges, [
    [1, 4],
    [5, 9],
  ]);
});

test('browser CSV download uses the shared serializer with the same filtered rows and columns', async (t) => {
  const source = await readFile(new URL('../web/reportExport.ts', import.meta.url), 'utf8'),
    rewritten = source
      .replaceAll(
        "'../server/shared/miaospeed'",
        JSON.stringify(new URL('../dist/server/shared/miaospeed.js', import.meta.url).href),
      )
      .replaceAll(
        "'../server/shared/report-export'",
        JSON.stringify(new URL('../dist/server/shared/report-export.js', import.meta.url).href),
      ),
    code = transpileModule(rewritten, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText,
    { exportCsv } = await import(
      'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
    ),
    report = fixture(3),
    rows = [report.results[2], report.results[0]],
    columns = [reportColumns(report)[1]];
  let blob,
    clicked = false;
  const link = { href: '', download: '', click: () => (clicked = true) };
  t.mock.method(URL, 'createObjectURL', (value) => {
    blob = value;
    return 'blob:report-test';
  });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(globalThis, 'setTimeout', (callback) => callback());
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag) => {
        assert.equal(tag, 'a');
        return link;
      },
    },
  });
  try {
    exportCsv(report, rows, columns);
    assert.equal(clicked, true);
    assert.equal(link.download, 'submeld-' + report.id + '.csv');
    assert.equal(link.href, 'blob:report-test');
    assert.equal(blob.type, 'text/csv;charset=utf-8');
    assert.equal(
      Buffer.from(await blob.arrayBuffer()).toString('utf8'),
      reportCsv(report, rows, columns),
    );
  } finally {
    delete globalThis.document;
  }
});
