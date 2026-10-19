import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { login, api, cleanup, navigate, noOverflow } from './browser-helpers.mjs';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
import { newSubscription } from '../dist/server/shared/subscriptions.js';

test('retired chain bookmarks open relay routes and chain controls are absent', async ({
  page,
}, info) => {
  const chainRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/chains'))
      chainRequests.push(request.url());
  });
  await login(page);
  await expect(
    page.getByRole('navigation', { name: '管理页面' }).getByRole('button', { name: '两跳链' }),
  ).toHaveCount(0);
  await page.goto('/submeld/#/chains?chain=retired&route=retired&tab=edit');
  await expect(page).toHaveURL(/#\/relays$/);
  await expect(page.getByRole('heading', { name: '中转线路', exact: true })).toBeVisible();
  await expect(page.getByLabel('中转线路列表', { exact: true })).toBeVisible();
  await navigate(page, '节点');
  await expect(page.getByRole('heading', { name: '节点', exact: true })).toBeVisible();
  await navigate(page, '中转线路');
  await expect(page).toHaveURL(/#\/relays$/);
  await navigate(page, '输出方案');
  await page.getByRole('button', { name: '添加输出方案', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理输出方案', exact: true });
  await expect(
    dialog.getByRole('combobox', { name: '输入类型', exact: true }).locator('option'),
  ).toHaveText(['订阅或组合', '单个节点']);
  await expect(dialog).not.toContainText('两跳链');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await navigate(page, '测试中心');
  await expect(page.getByRole('button', { name: '已保存节点', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择两跳链', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '链执行内核', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '节点执行内核', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '选择节点', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择订阅', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '三内核检查', exact: true }).click();
  await expect(page.getByRole('region', { name: '内核管理', exact: true })).toBeVisible();
  expect(chainRequests).toEqual([]);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('retired-chain-navigation.png'), fullPage: true });
});

test('legacy chain files stay untouched while normal nodes and mixed output plans remain usable', async ({
  page,
}, info) => {
  await login(page);
  const before = await api(page, '/api/subscriptions');
  const a = node('ss'),
    b = node('ss');
  a.name = 'legacy-A-' + info.project.name;
  b.name = 'legacy-B-' + info.project.name;
  b.port = 444;
  const resource = await api(page, '/api/nodes', {
    name: 'legacy-source-' + info.project.name,
    source: 'local',
    content: JSON.stringify({ proxies: [a, b].map(toUpstream) }),
  });
  const chainId = randomUUID(),
    purePlanId = randomUUID();
  const chainName = 'sm-chain-' + chainId,
    purePlanName = 'sm-plan-' + purePlanId;
  const chainConfig = {
    name: 'legacy-chain-' + info.project.name,
    enabled: true,
    entry: { resourceId: resource.id, nodeName: a.name },
    exit: { resourceId: resource.id, nodeName: b.name },
  };
  const purePlan = {
    ...newSubscription(),
    name: 'legacy-only-' + info.project.name,
    inputs: [{ kind: 'chain', id: chainId }],
  };
  let mixedPlan;
  try {
    for (const [name, id, role, config] of [
      [chainName, chainId, 'chain', chainConfig],
      [purePlanName, purePlanId, 'plan', purePlan],
    ])
      await api(page, '/upstream/sub-store/api/files', {
        name,
        displayName: config.name,
        source: 'local',
        type: 'file',
        content: JSON.stringify(config),
        process: [],
        _submeld: { id, role, version: 1 },
      });
    mixedPlan = await api(page, '/api/subscriptions', {
      ...newSubscription(),
      name: 'legacy-mixed-' + info.project.name,
      inputs: [{ kind: 'resource', id: resource.id }],
    });
    const mixedName = 'sm-plan-' + mixedPlan.id;
    const mixedRecord = (await api(page, '/upstream/sub-store/api/wholeFiles')).data.find(
      (file) => file.name === mixedName,
    );
    const mixedContent = JSON.stringify({
      ...JSON.parse(mixedRecord.content),
      inputs: [{ kind: 'chain', id: chainId }, ...mixedPlan.inputs],
    });
    await api(
      page,
      '/upstream/sub-store/api/file/' + mixedName,
      { content: mixedContent },
      'PATCH',
    );
    const visible = await api(page, '/api/subscriptions');
    expect(visible.total).toBe(before.total + 1);
    expect(visible.subscriptions.some((plan) => plan.id === purePlanId)).toBe(false);
    expect(visible.subscriptions.find((plan) => plan.id === mixedPlan.id).inputs).toEqual([
      { kind: 'resource', id: resource.id },
    ]);
    await navigate(page, '输出方案');
    await expect(page.getByRole('heading', { name: purePlan.name, exact: true })).toHaveCount(0);
    await page
      .locator('.plan-row')
      .filter({ hasText: mixedPlan.name })
      .getByRole('button', { name: '管理方案', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '管理输出方案', exact: true });
    await expect(dialog.locator('.input-list li > span')).toHaveText(resource.name);
    await expect(dialog).not.toContainText(chainConfig.name);
    await dialog.getByRole('combobox', { name: '预览格式', exact: true }).selectOption('uri');
    await dialog.getByRole('button', { name: '预览输出', exact: true }).click();
    await expect(dialog.getByLabel('生成结果', { exact: true })).toHaveValue(/legacy-A-/);
    await expect(dialog.getByLabel('生成结果', { exact: true })).toHaveValue(/legacy-B-/);
    await expect(dialog.getByRole('status')).toHaveText('已由 Sub-Store 生成。');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await navigate(page, '节点');
    await page.getByRole('combobox', { name: '所属订阅', exact: true }).selectOption(resource.id);
    const row = page.locator('.node-row').filter({ hasText: a.name });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('.node-row').filter({ hasText: b.name })).toBeVisible();
    const preservedFiles = (await api(page, '/upstream/sub-store/api/wholeFiles')).data;
    expect(preservedFiles.find((file) => file.name === chainName).content).toBe(
      JSON.stringify(chainConfig),
    );
    expect(preservedFiles.find((file) => file.name === purePlanName).content).toBe(
      JSON.stringify(purePlan),
    );
    expect(preservedFiles.find((file) => file.name === mixedName).content).toBe(mixedContent);
    await noOverflow(page);
  } finally {
    await cleanup(page, { resource, plan: mixedPlan?.id });
    const files = (await api(page, '/upstream/sub-store/api/wholeFiles')).data;
    for (const name of [purePlanName, chainName])
      if (files.some((file) => file.name === name))
        await api(page, '/upstream/sub-store/api/file/' + name, undefined, 'DELETE');
  }
});
