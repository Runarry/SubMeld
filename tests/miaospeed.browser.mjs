import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { speedReportSchema } from '../dist/server/shared/miaospeed.js';
import { login, api, noOverflow } from './browser-helpers.mjs';

test('temporary text, URL and file, script editing, reports and PNG/CSV exports', async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole('button', { name: '测试中心', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始综合测试', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '检测脚本', exact: true }).click();
  await page.getByRole('button', { name: '添加脚本', exact: true }).click();
  const scriptName = 'browser-script-' + info.project.name;
  await page.getByLabel('脚本名称', { exact: true }).fill(scriptName);
  await page
    .getByLabel('JavaScript 脚本', { exact: true })
    .fill('function handler(){ return {text:"受控 VM 检测完成",background:"186,230,126"}; }');
  await page.getByRole('button', { name: '保存脚本', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '检测脚本已保存' })).toBeVisible();
  await page.getByRole('button', { name: '编辑 ' + scriptName, exact: true }).click();
  await page.getByLabel('说明', { exact: true }).fill('受控真实 miaospeed VM 验证');
  await page.getByRole('button', { name: '保存脚本', exact: true }).click();
  await expect(page.getByText('受控真实 miaospeed VM 验证', { exact: true })).toBeVisible();
  const before = await api(page, '/upstream/sub-store/api/subs');
  const raw = {
    name: '临时测试-' + info.project.name,
    type: 'ss',
    server: 'example.com',
    port: 1080,
    cipher: 'aes-128-gcm',
    password: 'browser-secret-never-in-report',
    udp: true,
  };
  const text = JSON.stringify({ proxies: [raw, { name: '无效节点', type: 'not-supported' }] });
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end(text);
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  try {
    await page.getByRole('button', { name: '综合测试', exact: true }).click();
    await page.getByRole('button', { name: '临时节点', exact: true }).click();
    await page.getByLabel('节点或配置文本', { exact: true }).fill(text);
    await page.getByRole('button', { name: '预览临时节点', exact: true }).click();
    await expect(page.locator('.test-preview')).toContainText('2 项');
    for (const box of await page.locator('.test-card .test-options input[type=checkbox]').all())
      await box.uncheck();
    await page.getByRole('checkbox', { name: scriptName, exact: true }).check();
    await page.getByLabel('报告名称', { exact: true }).fill('浏览器验收-' + info.project.name);
    await page.getByRole('combobox', { name: '节点执行内核', exact: true }).selectOption('xray');
    await page.getByText('测试参数', { exact: true }).click();
    await page.getByLabel('下行时长（秒）', { exact: true }).fill('60');
    await page.getByLabel('上行时长（秒）', { exact: true }).fill('90');
    await page.getByText('测试参数', { exact: true }).click();
    await page.getByRole('button', { name: '开始综合测试', exact: true }).click();
    await expect
      .poll(async () => (await api(page, '/api/miaospeed/tests/current')).report?.state)
      .toBe('completed');
    const report = (await api(page, '/api/miaospeed/tests/current')).report;
    expect(report.results).toHaveLength(2);
    expect(report.settings.nodeCore).toBe('xray');
    expect(report.settings.downloadSeconds).toBe(60);
    expect(report.settings.uploadSeconds).toBe(90);
    expect(report.results[0].coreVersion).toBeTruthy();
    expect(report.results[0].measurements[0].value).toBe('受控 VM 检测完成');
    expect(report.results[1].state).toBe('unsupported');
    expect(JSON.stringify(report)).not.toContain(raw.password);
    await expect(page.getByRole('region', { name: '综合测试报告', exact: true })).toContainText(
      '不支持',
    );
    await page
      .getByRole('region', { name: '综合测试报告', exact: true })
      .getByRole('button', { name: raw.name, exact: true })
      .click();
    await expect(page.getByRole('region', { name: '节点检测详情', exact: true })).toContainText(
      '受控 VM 检测完成',
    );
    await expect(page.getByRole('region', { name: '节点检测详情', exact: true })).toContainText(
      '执行内核：Xray',
    );
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('comprehensive-report.png'), fullPage: true });
    await page.getByLabel('筛选结果', { exact: true }).fill(raw.name);
    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出筛选结果 CSV', exact: true }).click();
    const csv = await csvDownload;
    await csv.saveAs(info.outputPath('report.csv'));
    const contents = await readFile(info.outputPath('report.csv'), 'utf8');
    expect(contents).toContain(raw.name);
    expect(contents).toContain('4.7.6');
    expect(contents).toContain('Xray');
    expect(contents).toContain(report.results[0].coreVersion);
    expect(contents).not.toContain(raw.password);
    expect(contents).not.toContain('无效节点');
    const pngDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出本页 PNG', exact: true }).click();
    const png = await pngDownload;
    await png.saveAs(info.outputPath('export.png'));
    expect((await readFile(info.outputPath('export.png'))).subarray(1, 4).toString()).toBe('PNG');
    await page.getByRole('button', { name: '历史报告', exact: true }).click();
    const historyRow = page.locator('.test-history li').filter({ hasText: report.name });
    await historyRow.getByRole('button', { name: '查看报告', exact: true }).click();
    await expect(page.getByRole('region', { name: '综合测试报告', exact: true })).toContainText(
      report.name,
    );
    await page.getByRole('button', { name: '使用此报告配置重测', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '节点执行内核', exact: true })).toHaveValue(
      'xray',
    );
    await page.getByText('测试参数', { exact: true }).click();
    await page.getByRole('button', { name: '保存为默认参数', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '默认测试参数已保存' })).toBeVisible();
    expect(await api(page, '/api/miaospeed/settings')).toMatchObject({
      nodeCore: 'xray',
      downloadSeconds: 60,
      uploadSeconds: 90,
    });
    await page.getByRole('button', { name: '历史报告', exact: true }).click();
    await historyRow.getByRole('button', { name: '删除报告', exact: true }).click();
    await expect(historyRow).toHaveCount(0);
    expect((await api(page, '/api/miaospeed/tests/current')).report?.id).not.toBe(report.id);

    await page.getByRole('button', { name: '综合测试', exact: true }).click();
    await page.getByRole('combobox', { name: '输入方式', exact: true }).selectOption('url');
    await page
      .getByLabel('订阅 URL', { exact: true })
      .fill('http://host.docker.internal:' + server.address().port + '/nodes');
    await page.getByRole('button', { name: '预览临时节点', exact: true }).click();
    await expect(page.locator('.test-preview')).toContainText(raw.name);
    await page.getByRole('combobox', { name: '输入方式', exact: true }).selectOption('file');
    await page.getByLabel('配置文件', { exact: true }).setInputFiles({
      name: 'nodes.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
    await page.getByRole('button', { name: '预览临时节点', exact: true }).click();
    await expect(page.locator('.test-preview')).toContainText('2 项');
    expect(await api(page, '/upstream/sub-store/api/subs')).toEqual(before);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('temporary-file.png'), fullPage: true });
    await page.getByRole('button', { name: '检测脚本', exact: true }).click();
    await page
      .locator('.test-script-list li')
      .filter({ hasText: scriptName })
      .getByRole('button', { name: '删除脚本', exact: true })
      .click();
    await expect(page.getByRole('button', { name: '编辑 ' + scriptName, exact: true })).toHaveCount(
      0,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function reportFixture(name, values = {}) {
  const state = values.state ?? 'completed';
  const createdAt = '2026-10-22T00:00:00.000Z';
  return speedReportSchema.parse({
    id: randomUUID(),
    name,
    state,
    createdAt,
    finishedAt: state === 'running' ? null : createdAt,
    backendVersion: '4.7.6',
    settings: {},
    metrics: ['TEST_PING_RTT'],
    scripts: [],
    total: 1,
    completed: state === 'running' ? 0 : 1,
    current: state === 'running' ? name + ' 节点' : null,
    error: null,
    results: [
      {
        index: 0,
        subject: {
          kind: 'node',
          resourceId: randomUUID(),
          revision: 'a'.repeat(64),
          snapshotHash: 'b'.repeat(64),
          nodeIndex: 0,
        },
        name: name + ' 节点',
        protocol: 'ss',
        state,
        stale: false,
        message: '',
        testedAt: state === 'running' ? null : createdAt,
        coreVersion: null,
        measurements: [],
      },
    ],
    ...values,
  });
}

async function openControlledReports(page, reports) {
  await page.clock.install({ time: '2026-10-22T00:00:00.000Z' });
  await login(page);
  await page.clock.pauseAt('2026-10-22T01:00:00.000Z');
  const fixture = {
    reports,
    current: reports[0],
    currentReads: 0,
    reportReads: [],
    statusReads: 0,
    onCurrent: null,
    onReport: null,
  };
  // Control report timing only; login, settings, scripts and the page use the existing server fixture.
  await page.route('**/api/miaospeed/status', (route) => {
    fixture.statusReads++;
    return route.fulfill({
      json: {
        configured: true,
        connected: true,
        version: '4.7.6',
        apiVersion: 3,
        uploadEnabled: true,
        checkedAt: reports[0].createdAt,
        error: null,
        active: fixture.current?.state === 'running' ? fixture.current.id : null,
      },
    });
  });
  await page.route('**/api/miaospeed/tests/current', (route) => {
    fixture.currentReads++;
    return fixture.onCurrent
      ? fixture.onCurrent(route)
      : route.fulfill({ json: { report: fixture.current } });
  });
  await page.route('**/api/miaospeed/reports?*', (route) =>
    route.fulfill({
      json: {
        reports: fixture.reports.map((report) => {
          const summary = { ...report };
          delete summary.results;
          return summary;
        }),
        total: fixture.reports.length,
      },
    }),
  );
  await page.route('**/api/miaospeed/reports/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const report = fixture.reports.find((item) => item.id === id);
    expect(report).toBeDefined();
    fixture.reportReads.push(id);
    return fixture.onReport ? fixture.onReport(route, report) : route.fulfill({ json: report });
  });
  await page.getByRole('button', { name: '测试中心', exact: true }).click();
  await expect(page.getByRole('region', { name: '综合测试报告', exact: true })).toContainText(
    reports[0].name,
  );
  await expect(page.locator('.test-center > header .report-state')).toHaveText(
    fixture.current.state === 'running' ? '有任务运行中' : '后端已配置',
  );
  return fixture;
}

for (const delayedFailure of [false, true]) {
  test(`history selection ignores a delayed current ${delayedFailure ? 'error' : 'response'} and keeps exports and retest selected`, async ({
    page,
  }, info) => {
    const latest = reportFixture('当前报告 A');
    const selected = reportFixture('历史报告 B', {
      settings: { nodeCore: 'xray', downloadSeconds: 17, uploadSeconds: 19 },
    });
    const fixture = await openControlledReports(page, [latest, selected]);
    const currentStarted = Promise.withResolvers();
    const releaseCurrent = Promise.withResolvers();
    const historyStarted = Promise.withResolvers();
    const releaseHistory = Promise.withResolvers();
    fixture.onCurrent = async (route) => {
      fixture.onCurrent = null;
      currentStarted.resolve();
      await releaseCurrent.promise;
      return route.fulfill(
        delayedFailure
          ? { status: 503, json: { code: 'DELAYED_CURRENT', message: '旧报告读取失败。' } }
          : { json: { report: latest } },
      );
    };
    fixture.onReport = async (route, report) => {
      historyStarted.resolve();
      await releaseHistory.promise;
      return route.fulfill({ json: report });
    };
    try {
      await page.clock.fastForward(2000);
      await currentStarted.promise;
      await page.getByRole('button', { name: '历史报告', exact: true }).click();
      await page
        .locator('.test-history li')
        .filter({ hasText: selected.name })
        .getByRole('button', { name: '查看报告', exact: true })
        .click();
      await historyStarted.promise;
      const panel = page.getByRole('region', { name: '综合测试报告', exact: true });
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole('button', { name: '导出筛选结果 CSV', exact: true })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole('button', { name: '使用此报告配置重测', exact: true }),
      ).toHaveCount(0);
      releaseHistory.resolve();
      await expect(panel.getByRole('heading', { name: selected.name, exact: true })).toBeVisible();
      const delayedResponse = page.waitForResponse('**/api/miaospeed/tests/current');
      releaseCurrent.resolve();
      await (await delayedResponse).finished();
      await page.clock.fastForward(2000);
      await expect(panel.getByRole('heading', { name: selected.name, exact: true })).toBeVisible();
      await expect(page.getByText('旧报告读取失败。', { exact: true })).toHaveCount(0);
      const download = page.waitForEvent('download');
      await panel.getByRole('button', { name: '导出筛选结果 CSV', exact: true }).click();
      const csv = await download;
      expect(csv.suggestedFilename()).toBe('submeld-' + selected.id + '.csv');
      await csv.saveAs(info.outputPath('selected-report.csv'));
      const text = await readFile(info.outputPath('selected-report.csv'), 'utf8');
      expect(text).toContain(selected.results[0].name);
      expect(text).not.toContain(latest.results[0].name);
      await page.getByRole('button', { name: '使用此报告配置重测', exact: true }).click();
      await expect(page.getByLabel('报告名称', { exact: true })).toHaveValue(
        selected.name + ' · 重测',
      );
      await expect(page.getByRole('combobox', { name: '节点执行内核', exact: true })).toHaveValue(
        'xray',
      );
      await page.getByText('测试参数', { exact: true }).click();
      await expect(page.getByLabel('下行时长（秒）', { exact: true })).toHaveValue('17');
      await expect(page.getByLabel('上行时长（秒）', { exact: true })).toHaveValue('19');
      await noOverflow(page);
    } finally {
      releaseHistory.resolve();
      releaseCurrent.resolve();
    }
  });
}

test('a pinned running history report follows current progress to completion without repeated history lookups', async ({
  page,
}) => {
  const running = reportFixture('历史运行报告', { state: 'running' });
  const fixture = await openControlledReports(page, [running]);
  await page.getByRole('button', { name: '历史报告', exact: true }).click();
  await page.getByRole('button', { name: '查看报告', exact: true }).click();
  const panel = page.getByRole('region', { name: '综合测试报告', exact: true });
  await expect(panel.getByRole('progressbar', { name: '综合测试进度', exact: true })).toBeVisible();
  expect(fixture.reportReads).toEqual([running.id]);
  const currentReads = fixture.currentReads;
  fixture.current = reportFixture(running.name, { id: running.id });
  await page.clock.fastForward(2000);
  await expect(panel.locator('.page-header .report-state')).toHaveText('已完成');
  await expect(panel.getByRole('status')).toContainText('1 / 1 项已结束');
  expect(fixture.currentReads).toBe(currentReads + 1);
  expect(fixture.reportReads).toEqual([running.id]);
  const statusReads = fixture.statusReads;
  await page.clock.fastForward(6000);
  await expect.poll(() => fixture.statusReads).toBe(statusReads + 1);
  expect(fixture.currentReads).toBe(currentReads + 1);
  expect(fixture.reportReads).toEqual([running.id]);
  await noOverflow(page);
});

test('a pinned report reads its final state once when a different batch becomes current', async ({
  page,
}) => {
  const running = reportFixture('固定报告 A', { state: 'running' });
  const next = reportFixture('新批次 B', { state: 'running' });
  const fixture = await openControlledReports(page, [running, next]);
  await page.getByRole('button', { name: '历史报告', exact: true }).click();
  const selected = page.locator('.test-history li').filter({ hasText: running.name });
  await selected.getByRole('button', { name: '查看报告', exact: true }).click();
  const panel = page.getByRole('region', { name: '综合测试报告', exact: true });
  await expect(panel.getByRole('button', { name: '取消综合测试', exact: true })).toBeVisible();
  fixture.reports[0] = reportFixture(running.name, { id: running.id });
  fixture.current = next;
  await page.clock.fastForward(2000);
  await expect(panel.getByRole('heading', { name: running.name, exact: true })).toBeVisible();
  await expect(panel.locator('.page-header .report-state')).toHaveText('已完成');
  expect(fixture.reportReads).toEqual([running.id, running.id]);
  const currentReads = fixture.currentReads;
  const statusReads = fixture.statusReads;
  await page.clock.fastForward(6000);
  await expect.poll(() => fixture.statusReads).toBe(statusReads + 1);
  expect(fixture.currentReads).toBe(currentReads);
  expect(fixture.reportReads).toEqual([running.id, running.id]);
  await selected.getByRole('button', { name: '查看报告', exact: true }).click();
  await expect(panel.locator('.page-header .report-state')).toHaveText('已完成');
  expect(fixture.reportReads).toEqual([running.id, running.id, running.id]);
  await noOverflow(page);
});

test('canceling a pinned report preserves its identity and ignores an older progress response', async ({
  page,
}) => {
  const running = reportFixture('待取消报告 A', { state: 'running' });
  const next = reportFixture('后续报告 B');
  const fixture = await openControlledReports(page, [running, next]);
  await page.getByRole('button', { name: '历史报告', exact: true }).click();
  await page
    .locator('.test-history li')
    .filter({ hasText: running.name })
    .getByRole('button', { name: '查看报告', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '综合测试报告', exact: true });
  await expect(panel.getByRole('button', { name: '取消综合测试', exact: true })).toBeVisible();
  const currentStarted = Promise.withResolvers();
  const releaseCurrent = Promise.withResolvers();
  fixture.onCurrent = async (route) => {
    fixture.onCurrent = null;
    currentStarted.resolve();
    await releaseCurrent.promise;
    return route.fulfill({ json: { report: running } });
  };
  const cancelled = reportFixture(running.name, { id: running.id, state: 'cancelled' });
  let cancellations = 0;
  await page.route('**/api/miaospeed/tests/' + running.id + '/cancel', (route) => {
    expect(route.request().method()).toBe('POST');
    cancellations++;
    fixture.reports[0] = cancelled;
    fixture.current = next;
    return route.fulfill({ json: cancelled });
  });
  try {
    await page.clock.fastForward(2000);
    await currentStarted.promise;
    await panel.getByRole('button', { name: '取消综合测试', exact: true }).click();
    await expect(panel.getByRole('heading', { name: running.name, exact: true })).toBeVisible();
    await expect(panel.locator('.page-header .report-state')).toHaveText('已取消');
    expect(cancellations).toBe(1);
    expect(fixture.reportReads).toEqual([running.id, running.id]);
    const delayedResponse = page.waitForResponse('**/api/miaospeed/tests/current');
    releaseCurrent.resolve();
    await (await delayedResponse).finished();
    await page.clock.fastForward(2000);
    await expect(panel.locator('.page-header .report-state')).toHaveText('已取消');
    await expect(panel.getByRole('button', { name: '取消综合测试', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: next.name, exact: true })).toHaveCount(0);
    expect(fixture.reportReads).toEqual([running.id, running.id]);
    await noOverflow(page);
  } finally {
    releaseCurrent.resolve();
  }
});

test('a pinned report retries a failed final lookup and stops after recovering its terminal state', async ({
  page,
}) => {
  const running = reportFixture('终态重试报告 A', { state: 'running' });
  const next = reportFixture('后续运行批次 B', { state: 'running' });
  const fixture = await openControlledReports(page, [running, next]);
  await page.getByRole('button', { name: '历史报告', exact: true }).click();
  await page
    .locator('.test-history li')
    .filter({ hasText: running.name })
    .getByRole('button', { name: '查看报告', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '综合测试报告', exact: true });
  await expect(panel.getByRole('button', { name: '取消综合测试', exact: true })).toBeVisible();
  fixture.reports[0] = reportFixture(running.name, { id: running.id });
  fixture.current = next;
  fixture.onReport = (route) => {
    fixture.onReport = null;
    return route.fulfill({
      status: 503,
      json: { code: 'FINAL_LOOKUP_UNAVAILABLE', message: '终态报告暂时无法读取。' },
    });
  };
  await page.clock.fastForward(2000);
  await expect(
    page.getByRole('status').filter({ hasText: '终态报告暂时无法读取。' }),
  ).toBeVisible();
  await expect(panel.locator('.page-header .report-state')).toHaveText('测试中');
  expect(fixture.reportReads).toEqual([running.id, running.id]);
  await page.clock.fastForward(2000);
  await expect(panel.getByRole('heading', { name: running.name, exact: true })).toBeVisible();
  await expect(panel.locator('.page-header .report-state')).toHaveText('已完成');
  expect(fixture.reportReads).toEqual([running.id, running.id, running.id]);
  const currentReads = fixture.currentReads;
  const statusReads = fixture.statusReads;
  await page.clock.fastForward(6000);
  await expect.poll(() => fixture.statusReads).toBe(statusReads + 1);
  expect(fixture.currentReads).toBe(currentReads);
  expect(fixture.reportReads).toEqual([running.id, running.id, running.id]);
  await noOverflow(page);
});
