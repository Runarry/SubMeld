import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelManager, downloadOfficial } from '../dist/server/kernels.js';
import { AppError } from '../dist/server/errors.js';
import { deferred } from './publication-fixtures.mjs';

async function idle(manager) {
  const deadline = Date.now() + 4000;
  while (manager.status().kernels.some((kernel) => kernel.state !== 'idle')) {
    if (Date.now() > deadline) throw new Error('Kernel operation timed out');
    await delay(5);
  }
  await delay(0);
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'submeld-kernels-'));
  const settings = {
    version: '1.2.3',
    corrupt: false,
    failCheck: false,
    prerelease: false,
    gate: null,
  };
  const calls = [];
  const archive = Buffer.from('verified fixture archive'),
    digest = createHash('sha256').update(archive).digest('hex');
  const windows = process.platform === 'win32',
    name = 'Xray-' + (windows ? 'windows' : 'linux') + '-64.zip';
  const manager = new KernelManager(directory, {
    bundledDir: null,
    async transfer(url) {
      calls.push(url);
      if (url.endsWith('/latest'))
        return Buffer.from(
          JSON.stringify({
            tag_name: 'v' + settings.version,
            prerelease: settings.prerelease,
            draft: false,
            assets: [{ name, digest: 'sha256:' + digest }],
          }),
        );
      if (settings.gate) {
        settings.gate.entered.resolve();
        await settings.gate.released.promise;
      }
      return settings.corrupt ? Buffer.from('wrong bytes') : archive;
    },
    async command(binary, args) {
      if (binary === 'tar' || binary === 'unzip') {
        const unpack = args[args.indexOf(binary === 'tar' ? '-C' : '-d') + 1];
        await mkdir(unpack, { recursive: true });
        await writeFile(
          join(unpack, windows ? 'xray.exe' : 'xray'),
          'fake executable ' + settings.version,
        );
      } else if (args[0] === 'version') return 'Xray ' + settings.version;
      else {
        const config = JSON.parse(await readFile(args.at(-1), 'utf8'));
        assert.equal(config.outbounds[0].protocol, 'shadowsocks');
        if (settings.failCheck)
          throw new AppError('KERNEL_COMMAND_FAILED', '内核启动或配置自检失败。');
      }
      return '';
    },
  });
  await manager.initialize();
  t.after(async () => {
    settings.gate?.released.resolve();
    await manager.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + (windows ? '\\' : '/')) &&
        directory.includes('submeld-kernels-'),
    );
    await rm(directory, { recursive: true, force: true });
  });
  return { manager, directory, settings, calls };
}
test('official releases install after checksum/version/config checks; a leased version survives update', async (t) => {
  const f = await fixture(t);
  f.manager.update('xray');
  await idle(f.manager);
  assert.equal(f.manager.versions().get('xray'), '1.2.3');
  const lease = f.manager.snapshot(),
    old = lease.binaries.get('xray');
  f.settings.version = '1.2.4';
  f.settings.gate = { entered: deferred(), released: deferred() };
  f.manager.update('xray');
  await f.settings.gate.entered.promise;
  assert.equal(f.manager.versions().get('xray'), '1.2.3');
  assert.throws(() => f.manager.update('xray'), { code: 'KERNEL_BUSY' });
  f.settings.gate.released.resolve();
  await idle(f.manager);
  assert.equal(f.manager.versions().get('xray'), '1.2.4');
  assert.equal(old.version, '1.2.3');
  await access(old.path);
  await lease.release();
  await assert.rejects(access(old.path));
  const reopened = new KernelManager(f.directory, { bundledDir: null });
  await reopened.initialize();
  assert.equal(reopened.versions().get('xray'), '1.2.4');
  await reopened.close();
  assert.ok(
    f.calls.every(
      (url) =>
        url.startsWith('https://api.github.com/repos/XTLS/Xray-core/') ||
        url.startsWith('https://github.com/XTLS/Xray-core/releases/download/'),
    ),
  );
});
test('bad checksums, rejected configs and prereleases preserve the usable installation and clean staging', async (t) => {
  const f = await fixture(t);
  f.manager.update('xray');
  await idle(f.manager);
  for (const mode of ['corrupt', 'failCheck', 'prerelease']) {
    f.settings.version = '1.2.4';
    f.settings[mode] = true;
    f.manager.update('xray');
    await idle(f.manager);
    assert.equal(f.manager.versions().get('xray'), '1.2.3');
    assert.ok(f.manager.status().kernels.find((kernel) => kernel.target === 'xray').error);
    assert.ok(
      (await readdir(join(f.directory, 'kernels', 'xray'))).every(
        (name) => !name.startsWith('stage-'),
      ),
    );
    f.settings[mode] = false;
  }
});
test('tampered installed binaries are not selected after restart; download origins are fixed', async (t) => {
  const f = await fixture(t);
  f.manager.update('xray');
  await idle(f.manager);
  const lease = f.manager.snapshot();
  await writeFile(lease.binaries.get('xray').path, 'tampered executable');
  await lease.release();
  const reopened = new KernelManager(f.directory, { bundledDir: null });
  await reopened.initialize();
  assert.equal(reopened.versions().get('xray'), null);
  await reopened.close();
  for (const url of [
    'http://github.com/file',
    'https://untrusted.example/file',
    'https://user:pass@github.com/file',
    'https://github.com:8443/file',
  ])
    await assert.rejects(downloadOfficial(url, 1024, new AbortController().signal), {
      code: 'KERNEL_DOWNLOAD_REJECTED',
    });
});
