/* global document, window, getComputedStyle */
import { test, expect } from '@playwright/test';
import { login, api, cleanup, noOverflow, navigate } from './browser-helpers.mjs';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';

test('light UI keeps pages, checkbox labels and modal actions usable across viewport sizes', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const widths = info.project.name === 'desktop' ? [1440, 768] : [390, 360];
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: widths[0], height: 900 });
  await page.goto('/submeld/');
  await expect(page.getByRole('heading', { name: '管理员登录', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('login.png'), fullPage: true });
  await login(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, heading] of [
      ['机器', '机器'],
      ['节点', '节点'],
      ['中转线路', '中转线路'],
      ['输出方案', '输出方案'],
      ['测试中心', '测试中心'],
      ['网站分流测试', '网站分流测试'],
      ['配套文件', '配套脚本与模板'],
    ]) {
      await navigate(page, name);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await noOverflow(page);
      expect(
        await page.locator('.content').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      ).toBe('light');
      await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`${width}-${name}.png`), fullPage: true });
    }
    await navigate(page, '测试中心');
    const option = page.locator('.test-options label').first();
    await expect(option).toBeVisible();
    const placement = await option.evaluate((label) => {
      const checkbox = label.querySelector('input').getBoundingClientRect();
      const text = Array.from(label.childNodes).find(
        (node) => node.nodeType === 3 && node.textContent.trim(),
      );
      const range = document.createRange();
      range.selectNodeContents(text);
      const caption = range.getBoundingClientRect();
      return {
        afterCheckbox: caption.left >= checkbox.right,
        sameLine:
          Math.abs(caption.top + caption.height / 2 - checkbox.top - checkbox.height / 2) < 4,
      };
    });
    expect(placement).toEqual({ afterCheckbox: true, sameLine: true });
    await navigate(page, '节点');
    await page.getByRole('button', { name: '添加节点或订阅', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加节点或订阅', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('订阅名称', { exact: true }).focus();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
      }),
    ).toBe(true);
    const save = dialog.getByRole('button', { name: '保存到 Sub-Store', exact: true });
    expect(
      await save.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight &&
          el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        );
      }),
    ).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${width}-node-dialog.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});
test('unified nodes import a batch, show raw data, delete a single original node and logout', async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole('button', { name: '节点', exact: true }).click();
  const name = 'batch-' + info.project.name;
  const a = node('ss'),
    b = node('ss');
  a.name = name + '-A';
  b.name = name + '-B';
  b.port = 444;
  await page.getByRole('button', { name: '添加节点或订阅', exact: true }).click();
  await page.getByLabel('订阅名称', { exact: true }).fill(name);
  await page
    .getByLabel('节点文本', { exact: true })
    .fill(JSON.stringify({ proxies: [a, b].map(toUpstream) }));
  await page.getByRole('button', { name: '保存到 Sub-Store', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加节点或订阅' })).toHaveCount(0);
  const resource = (await api(page, '/api/nodes/resources')).resources.find((r) => r.name === name);
  try {
    const row = page.locator('.node-row').filter({ hasText: a.name });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '查看', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '节点详情' })).toContainText(a.server);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('.node-row').filter({ hasText: b.name })).toBeVisible();
    const record = (await api(page, '/upstream/sub-store/api/sub/' + resource.upstreamName)).data;
    expect(JSON.parse(record.content).proxies.map((n) => n.name)).toEqual([b.name]);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('unified-nodes.png'), fullPage: true });
  } finally {
    await cleanup(page, { resource });
  }
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理员登录', exact: true })).toBeVisible();
});
test('output form selects a single native node and keeps its selection after editing', async ({
  page,
}, info) => {
  await login(page);
  const a = node('ss'),
    b = node('ss');
  a.name = 'single-A-' + info.project.name;
  b.name = 'single-B-' + info.project.name;
  b.port = 444;
  const resource = await api(page, '/api/nodes', {
    name: 'single-source-' + info.project.name,
    source: 'local',
    content: JSON.stringify({ proxies: [a, b].map(toUpstream) }),
  });
  let plan;
  try {
    await navigate(page, '输出方案');
    await page.getByRole('button', { name: '添加输出方案', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '管理输出方案', exact: true });
    await dialog.getByLabel('方案名称', { exact: true }).fill('single-' + info.project.name);
    await dialog.getByRole('combobox', { name: '节点来源', exact: true }).selectOption(resource.id);
    await dialog
      .getByRole('checkbox', { name: '选择节点 ' + b.name + ' · ' + resource.name, exact: true })
      .check();
    await dialog.getByRole('button', { name: '加入 1 项', exact: true }).click();
    await dialog.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '方案与输出文件已保存到 Sub-Store。',
    );
    plan = (await api(page, '/api/subscriptions')).subscriptions.find(
      (p) => p.name === 'single-' + info.project.name,
    ).id;
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page
      .locator('.plan-row')
      .filter({ hasText: 'single-' + info.project.name })
      .getByRole('button', { name: '管理方案', exact: true })
      .click();
    await expect(dialog.locator('.input-list li > span')).toHaveText(
      b.name + ' · ' + resource.name,
    );
    const updatedName = 'single-edited-' + info.project.name;
    await dialog.getByLabel('方案名称', { exact: true }).fill(updatedName);
    await dialog.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '方案与输出文件已保存到 Sub-Store。',
    );
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await page
      .locator('.plan-row')
      .filter({ hasText: updatedName })
      .getByRole('button', { name: '管理方案', exact: true })
      .click();
    await expect(dialog.getByLabel('方案名称', { exact: true })).toHaveValue(updatedName);
    const updatedPlan = await api(page, '/api/subscriptions/' + plan);
    expect(updatedPlan.inputs).toEqual([
      { kind: 'node', resourceId: resource.id, nodeName: b.name },
    ]);
    await dialog.getByRole('combobox', { name: '预览格式', exact: true }).selectOption('uri');
    await dialog.getByRole('button', { name: '预览输出', exact: true }).click();
    await expect(dialog.getByLabel('生成结果', { exact: true })).toHaveValue(/single-B-/);
    await expect(dialog.getByLabel('生成结果', { exact: true })).not.toHaveValue(/single-A-/);
    await page.screenshot({ path: info.outputPath('native-single-output.png'), fullPage: true });
    await noOverflow(page);
  } finally {
    await cleanup(page, { resource, plan });
  }
});
test('output form produces native files, shares immediate updates and revokes addresses', async ({
  page,
}, info) => {
  await login(page);
  const a = node('ss');
  a.name = 'publish-' + info.project.name;
  const resource = await api(page, '/api/nodes', {
    name: a.name,
    source: 'local',
    content: JSON.stringify({ proxies: [toUpstream(a)] }),
  });
  let plan;
  try {
    await navigate(page, '输出方案');
    await page.getByRole('button', { name: '添加输出方案', exact: true }).click();
    await page.getByLabel('方案名称', { exact: true }).fill(a.name);
    await page.getByRole('tab', { name: '订阅与组合', exact: true }).click();
    await page.getByRole('checkbox', { name: '选择来源 ' + resource.name, exact: true }).check();
    await page.getByRole('button', { name: '加入 1 项', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Xray 完整配置', exact: true }).check();
    await page.getByRole('checkbox', { name: 'sing-box 完整配置', exact: true }).check();
    await page.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: '生成与分享', exact: true })).toBeVisible();
    plan = (await api(page, '/api/subscriptions')).subscriptions.find((p) => p.name === a.name).id;
    const dialog = page.getByRole('dialog', { name: '管理输出方案', exact: true });
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '方案与输出文件已保存到 Sub-Store。',
    );
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const planRow = page.locator('.plan-row').filter({ hasText: a.name });
    await expect(planRow).toBeVisible();
    await planRow.getByRole('button', { name: '管理方案', exact: true }).click();
    await expect(dialog.getByLabel('方案名称', { exact: true })).toHaveValue(a.name);
    const updatedName = a.name + '-edited';
    await dialog.getByLabel('方案名称', { exact: true }).fill(updatedName);
    await dialog.getByRole('checkbox', { name: 'Base64', exact: true }).check();
    await dialog.getByText('筛选与完整配置设置', { exact: true }).click();
    await dialog.getByLabel('名称前缀', { exact: true }).fill('edited-');
    await dialog.getByLabel('本机监听端口', { exact: true }).fill('12080');
    await dialog.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '方案与输出文件已保存到 Sub-Store。',
    );
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await page
      .locator('.plan-row')
      .filter({ hasText: updatedName })
      .getByRole('button', { name: '管理方案', exact: true })
      .click();
    await expect(dialog.getByLabel('方案名称', { exact: true })).toHaveValue(updatedName);
    await expect(dialog.getByRole('checkbox', { name: 'Base64', exact: true })).toBeChecked();
    await expect(dialog.locator('.input-list')).toContainText(resource.name);
    await dialog.getByText('筛选与完整配置设置', { exact: true }).click();
    await expect(dialog.getByLabel('名称前缀', { exact: true })).toHaveValue('edited-');
    await expect(dialog.getByLabel('本机监听端口', { exact: true })).toHaveValue('12080');
    await dialog.getByText('筛选与完整配置设置', { exact: true }).click();
    await page.getByRole('combobox', { name: '预览格式', exact: true }).selectOption('xray');
    await page.getByRole('button', { name: '预览输出', exact: true }).click();
    await expect(page.getByLabel('生成结果', { exact: true })).toHaveValue(/outbounds/);
    await page.getByRole('button', { name: '创建分享地址', exact: true }).click();
    const input = page.getByLabel('Mihomo 完整配置 分享地址', { exact: true });
    await expect(input).toBeVisible();
    const url = await input.inputValue();
    expect(url).toContain('/share/file/');
    expect((await page.request.get(url)).status()).toBe(200);
    await api(
      page,
      '/upstream/sub-store/api/sub/' + resource.upstreamName,
      {
        content: JSON.stringify({ proxies: [{ ...toUpstream(a), server: 'updated.example.com' }] }),
      },
      'PATCH',
    );
    expect(await (await page.request.get(url)).text()).toContain('updated.example.com');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('native-output-share.png'), fullPage: true });
    await page.getByRole('button', { name: '撤销分享', exact: true }).click();
    await page.getByRole('button', { name: '确认撤销', exact: true }).click();
    await expect(input).toHaveCount(0);
    expect((await page.request.get(url)).status()).not.toBe(200);
  } finally {
    await cleanup(page, { resource, plan });
  }
});

test('output picker keeps cross-page and cross-source selections, explains ambiguous names and preserves order', async ({
  page,
}, info) => {
  await login(page);
  const drafts = Array.from({ length: 27 }, (_, index) => ({
    ...node('ss'),
    name: 'batch-' + String(index).padStart(2, '0'),
  }));
  const duplicate = { ...node('ss'), name: 'ambiguous' };
  const first = await api(page, '/api/nodes', {
    name: 'batch-source-A-' + info.project.name,
    source: 'local',
    content: JSON.stringify({ proxies: [...drafts, duplicate, duplicate].map(toUpstream) }),
  });
  const second = await api(page, '/api/nodes', {
    name: 'batch-source-B-' + info.project.name,
    source: 'local',
    content: JSON.stringify({ proxies: [toUpstream(drafts[1])] }),
  });
  const collectionName = 'batch-collection-' + info.project.name;
  let plan;
  let collection;
  try {
    await api(page, '/upstream/sub-store/api/collections', {
      name: collectionName,
      subscriptions: [second.upstreamName],
    });
    collection = (await api(page, '/api/nodes/resources')).resources.find(
      (resource) => resource.upstreamName === collectionName,
    );
    await navigate(page, '输出方案');
    await page.getByRole('button', { name: '添加输出方案', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '管理输出方案' });
    const picker = dialog.getByRole('region', { name: '添加方案输入' });
    const sourceFilter = picker.getByRole('combobox', { name: '节点来源', exact: true });
    const choose = (name, resource) =>
      picker.getByRole('checkbox', {
        name: '选择节点 ' + name + ' · ' + resource.name,
        exact: true,
      });
    await dialog.getByLabel('方案名称', { exact: true }).fill('batch-plan-' + info.project.name);
    await sourceFilter.selectOption(first.id);
    await choose('batch-01', first).check();
    await choose('batch-00', first).check();
    await picker.getByRole('button', { name: '下一页', exact: true }).click();
    await choose('batch-26', first).check();
    await sourceFilter.selectOption(second.id);
    await expect(choose('batch-01', second)).toBeEnabled();
    await picker.getByRole('checkbox', { name: '全选本页', exact: true }).check();
    await sourceFilter.selectOption('');
    await picker.getByLabel('搜索方案输入', { exact: true }).fill('batch-01');
    await expect(choose('batch-01', first)).toBeEnabled();
    await expect(choose('batch-01', first)).toBeChecked();
    await expect(choose('batch-01', second)).toBeChecked();
    await sourceFilter.selectOption(first.id);
    await picker.getByLabel('搜索方案输入', { exact: true }).fill('ambiguous');
    await expect(picker.getByText('同一来源内名称重复，请先改名', { exact: true })).toHaveCount(2);
    await expect(
      picker.getByRole('checkbox', { name: '选择节点 ambiguous · ' + first.name, exact: true }),
    ).toHaveCount(2);
    for (const checkbox of await picker
      .getByRole('checkbox', { name: '选择节点 ambiguous · ' + first.name, exact: true })
      .all())
      await expect(checkbox).toBeDisabled();
    await picker.getByRole('tab', { name: '订阅与组合', exact: true }).click();
    await picker.getByLabel('搜索方案输入', { exact: true }).fill('');
    await picker.getByRole('checkbox', { name: '选择来源 ' + second.name, exact: true }).check();
    const collectionOption = picker.getByRole('checkbox', {
      name: '选择来源 ' + collectionName,
      exact: true,
    });
    await collectionOption.check();
    await picker.getByRole('button', { name: '加入 6 项', exact: true }).click();
    await expect(collectionOption).toBeDisabled();
    const inputs = dialog.locator('.input-list li');
    await expect(inputs.locator(':scope > span')).toHaveText([
      'batch-01 · ' + first.name,
      'batch-00 · ' + first.name,
      'batch-26 · ' + first.name,
      'batch-01 · ' + second.name,
      second.name,
      collectionName,
    ]);
    await page.screenshot({ path: info.outputPath('batch-output-picker.png'), fullPage: true });
    await inputs.first().getByRole('button', { name: /^下移/ }).click();
    await dialog.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '方案与输出文件已保存到 Sub-Store。',
    );
    plan = (await api(page, '/api/subscriptions')).subscriptions.find(
      (item) => item.name === 'batch-plan-' + info.project.name,
    ).id;
    const saved = await api(page, '/api/subscriptions/' + plan);
    expect(saved.inputs).toEqual([
      { kind: 'node', resourceId: first.id, nodeName: 'batch-00' },
      { kind: 'node', resourceId: first.id, nodeName: 'batch-01' },
      { kind: 'node', resourceId: first.id, nodeName: 'batch-26' },
      { kind: 'node', resourceId: second.id, nodeName: 'batch-01' },
      { kind: 'resource', id: second.id },
      { kind: 'resource', id: collection.id },
    ]);
    const footer = await dialog.locator('.modal-footer').boundingBox();
    expect(footer.y + footer.height).toBeLessThanOrEqual(page.viewportSize().height);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('batch-output-inputs.png'), fullPage: true });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await page
      .locator('.plan-row')
      .filter({ hasText: saved.name })
      .getByRole('button', { name: '管理方案', exact: true })
      .click();
    await expect(dialog.locator('.input-list li > span')).toHaveText([
      'batch-00 · ' + first.name,
      'batch-01 · ' + first.name,
      'batch-26 · ' + first.name,
      'batch-01 · ' + second.name,
      second.name,
      collectionName,
    ]);
  } finally {
    await cleanup(page, { resource: first, plan });
    if (collection)
      await api(
        page,
        '/upstream/sub-store/api/collection/' + collection.upstreamName,
        undefined,
        'DELETE',
      );
    await cleanup(page, { resource: second });
  }
});

test('output confirmation shows generation issues, preserves saved changes and blocks new shares until corrected', async ({
  page,
}, info) => {
  await login(page);
  const draft = node('ss');
  const resource = await api(page, '/api/nodes', {
    name: 'output-issues-' + info.project.name,
    source: 'local',
    content: JSON.stringify({ proxies: [toUpstream(draft)] }),
  });
  let plan;
  try {
    await navigate(page, '输出方案');
    await page.getByRole('button', { name: '添加输出方案', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '管理输出方案' });
    await dialog.getByLabel('方案名称', { exact: true }).fill(resource.name);
    await dialog.getByRole('tab', { name: '订阅与组合', exact: true }).click();
    await dialog.getByRole('checkbox', { name: '选择来源 ' + resource.name, exact: true }).check();
    await dialog.getByRole('button', { name: '加入 1 项', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Xray 完整配置', exact: true }).check();
    await dialog.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '方案与输出文件已保存到 Sub-Store。',
    );
    plan = (await api(page, '/api/subscriptions')).subscriptions.find(
      (item) => item.name === resource.name,
    ).id;
    await dialog.getByRole('button', { name: '创建分享地址', exact: true }).click();
    await expect(dialog.getByLabel('Xray 完整配置 分享地址', { exact: true })).toBeVisible();
    const tokens = (await api(page, '/upstream/sub-store/api/tokens')).data;
    const incompatible = { ...node('vless'), name: 'incompatible node' };
    await api(
      page,
      '/upstream/sub-store/api/sub/' + resource.upstreamName,
      { content: JSON.stringify({ proxies: [toUpstream(incompatible)] }) },
      'PATCH',
    );
    await dialog.getByRole('button', { name: '创建分享地址', exact: true }).click();
    const results = dialog.getByRole('region', { name: '输出检查结果' });
    await expect(results.locator('[data-state="failed"]')).toContainText('Xray 完整配置');
    await expect(results).toContainText('incompatible node');
    await expect(results).toContainText(resource.name);
    expect((await api(page, '/upstream/sub-store/api/tokens')).data).toEqual(tokens);
    await dialog.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toContainText('方案已保存');
    await expect(results).toContainText('已有分享地址会读取保存后的方案');
    await expect(dialog.getByLabel('方案名称', { exact: true })).toHaveValue(resource.name);
    await dialog.getByRole('checkbox', { name: 'Xray 完整配置', exact: true }).uncheck();
    await expect(results).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '创建分享地址', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '检查并保存', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '方案与输出文件已保存到 Sub-Store。',
    );
    await dialog.getByRole('button', { name: '创建分享地址', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '方案操作结果' })).toHaveText(
      '已检查所选格式，分享地址已就绪。',
    );
    await expect(dialog.getByLabel('URI 分享地址', { exact: true })).toBeFocused();
    const url = await dialog.getByLabel('Mihomo 完整配置 分享地址', { exact: true }).inputValue();
    expect((await page.request.get(url)).status()).toBe(200);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('output-validation.png'), fullPage: true });
  } finally {
    await cleanup(page, { resource, plan });
  }
});
