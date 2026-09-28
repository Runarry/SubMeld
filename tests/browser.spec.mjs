import { test, expect } from '@playwright/test';
import { login, api, cleanup, noOverflow } from './browser-helpers.mjs';
import { node } from './fixtures.mjs';
import { toUpstream } from '../dist/server/converter/model.js';
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
test('chain form directly selects native subscription nodes and exposes deletion protection', async ({
  page,
}, info) => {
  await login(page);
  const a = node('ss'),
    b = node('ss');
  a.name = 'entry-' + info.project.name;
  b.name = 'exit-' + info.project.name;
  b.port = 444;
  const resource = await api(page, '/api/nodes', {
    name: 'chain-source-' + info.project.name,
    source: 'local',
    content: JSON.stringify({ proxies: [a, b].map(toUpstream) }),
  });
  let chain;
  try {
    await page.getByRole('button', { name: '两跳链', exact: true }).click();
    await page.getByRole('button', { name: '添加两跳链', exact: true }).click();
    await page.getByLabel('链名称', { exact: true }).fill('chain-' + info.project.name);
    for (const [label, name] of [
      ['前置', a.name],
      ['出口', b.name],
    ]) {
      const field = page.getByRole('group', { name: label, exact: true });
      await field
        .getByRole('combobox', { name: '所属订阅', exact: true })
        .selectOption(resource.id);
      await field
        .getByRole('combobox', { name: label + '节点', exact: true })
        .selectOption({ label: name + ' · ss' });
    }
    await page.getByRole('button', { name: '保存链', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '配置两跳链' })).toHaveCount(0);
    chain = (await api(page, '/api/chains')).chains.find(
      (c) => c.name === 'chain-' + info.project.name,
    ).id;
    const chainRow = page.locator('.chain-row').filter({ hasText: 'chain-' + info.project.name });
    await chainRow.getByRole('button', { name: '配置', exact: true }).click();
    const chainDialog = page.getByRole('dialog', { name: '配置两跳链', exact: true });
    await expect(chainDialog).toBeVisible();
    await expect(chainDialog.getByLabel('链名称', { exact: true })).toHaveValue(
      'chain-' + info.project.name,
    );
    const updatedName = 'chain-edited-' + info.project.name;
    await chainDialog.getByLabel('链名称', { exact: true }).fill(updatedName);
    await chainDialog.getByRole('button', { name: '保存链', exact: true }).click();
    await expect(chainDialog).toHaveCount(0);
    await page.reload();
    await expect(
      page.locator('.chain-row').getByRole('heading', { name: updatedName, exact: true }),
    ).toBeVisible();
    const updatedChain = await api(page, '/api/chains/' + chain);
    expect(updatedChain.entry).toEqual({ resourceId: resource.id, nodeName: a.name });
    expect(updatedChain.exit).toEqual({ resourceId: resource.id, nodeName: b.name });
    await page.screenshot({ path: info.outputPath('native-chain.png'), fullPage: true });
    await noOverflow(page);
    await page.getByRole('button', { name: '节点', exact: true }).click();
    await page.getByRole('combobox', { name: '所属订阅', exact: true }).selectOption(resource.id);
    await page
      .locator('.node-row')
      .filter({ hasText: a.name })
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '删除节点' })).toContainText('正在被两跳链引用');
    await page.getByRole('button', { name: '取消', exact: true }).click();
  } finally {
    await cleanup(page, { resource, chain });
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
    await page.getByRole('button', { name: '输出方案', exact: true }).click();
    await page.getByRole('button', { name: '添加输出方案', exact: true }).click();
    await page.getByLabel('方案名称', { exact: true }).fill(a.name);
    await page.getByRole('combobox', { name: '选择输入', exact: true }).selectOption(resource.id);
    await page.getByRole('button', { name: '加入输入', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Xray 完整配置', exact: true }).check();
    await page.getByRole('checkbox', { name: 'sing-box 完整配置', exact: true }).check();
    await page.getByRole('button', { name: '保存方案', exact: true }).click();
    await expect(page.getByRole('heading', { name: '生成与分享', exact: true })).toBeVisible();
    plan = (await api(page, '/api/subscriptions')).subscriptions.find((p) => p.name === a.name).id;
    const dialog = page.getByRole('dialog', { name: '管理输出方案', exact: true });
    await expect(dialog.getByRole('status')).toHaveText('方案与输出文件已保存到 Sub-Store。');
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
    await dialog.getByRole('button', { name: '保存方案', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('方案与输出文件已保存到 Sub-Store。');
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
