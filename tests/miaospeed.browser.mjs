import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { login, api, noOverflow } from './browser-helpers.mjs';

test('temporary text, URL and file, script editing, reports and PNG/CSV exports', async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole('button', { name: '打开测试中心', exact: true }).click();
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
    await page.getByRole('button', { name: '开始综合测试', exact: true }).click();
    await expect
      .poll(async () => (await api(page, '/api/miaospeed/tests/current')).report?.state)
      .toBe('completed');
    const report = (await api(page, '/api/miaospeed/tests/current')).report;
    expect(report.results).toHaveLength(2);
    expect(report.settings.nodeCore).toBe('xray');
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
    expect((await api(page, '/api/miaospeed/settings')).nodeCore).toBe('xray');
    await page.getByRole('button', { name: '历史报告', exact: true }).click();
    await historyRow.getByRole('button', { name: '删除报告', exact: true }).click();
    await expect(historyRow).toHaveCount(0);

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
