import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fixture } from './upstream-fixture.mjs';
import { openSettings } from '../dist/server/database.js';
const publicSettings = (value) => ({
  revision: value.revision,
  botUsername: 'ExampleKoipyBot',
  adminIds: [123456789],
  backend: value.backend,
});
test('Koipy settings write native config, retain other fields and never return saved credentials', async (t) => {
  const f = await fixture(t, { publish: false });
  mkdirSync(dirname(f.koipy.path), { recursive: true });
  writeFileSync(
    f.koipy.path,
    JSON.stringify({
      image: { title: 'custom' },
      slaveConfig: { slaves: [{ id: 'remote', type: 'miaospeed', address: 'remote.test:8765' }] },
    }),
  );
  const before = await (await f.request('/api/integrations/koipy')).json();
  const secrets = {
    license: 'test-license-private',
    botToken: '123456:test_token_private',
    miaospeedToken: 'backend-test-private',
    botProxy: 'socks5://user:secret@proxy.test:1080',
  };
  const response = await f.request(
    '/api/integrations/koipy',
    { ...publicSettings(before), ...secrets },
    'PATCH',
  );
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.configured, true);
  assert.ok(Object.values(secrets).every((secret) => !JSON.stringify(saved).includes(secret)));
  const file = JSON.parse(readFileSync(f.koipy.path, 'utf8'));
  assert.equal(file.license, secrets.license);
  assert.equal(file.bot['bot-token'], secrets.botToken);
  assert.equal(file.bot.proxy, secrets.botProxy);
  assert.deepEqual(file.admin, [123456789]);
  assert.equal(file.image.title, 'custom');
  assert.equal(file.slaveConfig.slaves.length, 2);
  assert.equal(file.slaveConfig.slaves[1].token, secrets.miaospeedToken);
  assert.equal(
    (await (await f.request('/api/integrations')).json()).telegram,
    'https://t.me/ExampleKoipyBot',
  );
  const edited = await f.request(
    '/api/integrations/koipy',
    { ...publicSettings(saved), botUsername: '@ChangedKoipyBot', botProxy: null },
    'PATCH',
  );
  assert.equal(edited.status, 200);
  const retained = JSON.parse(readFileSync(f.koipy.path, 'utf8'));
  assert.equal(retained.bot['bot-token'], secrets.botToken);
  assert.equal(retained.bot.proxy, undefined);
  f.close();
  const reopened = openSettings(f.directory, true, f.client);
  try {
    assert.equal(reopened.koipy.get().botUsername, 'ChangedKoipyBot');
    assert.equal(reopened.koipy.get().hasLicense, true);
  } finally {
    reopened.close();
  }
});

test('Koipy configuration enforces login, origin, validation and external edit conflicts', async (t) => {
  const f = await fixture(t, { publish: false });
  assert.equal((await f.app.request('/api/integrations/koipy')).status, 401);
  assert.equal(
    (
      await f.app.request('/api/integrations/koipy', {
        method: 'PATCH',
        headers: { Cookie: f.cookie, Origin: 'https://other.test' },
        body: '{}',
      })
    ).status,
    403,
  );
  const initial = f.koipy.get();
  assert.equal(
    (
      await f.request(
        '/api/integrations/koipy',
        { ...publicSettings(initial), botToken: 'invalid' },
        'PATCH',
      )
    ).status,
    400,
  );
  assert.equal(f.koipy.get().revision, initial.revision);
  const saved = f.koipy.update(publicSettings(initial));
  writeFileSync(f.koipy.path, JSON.stringify({ image: { title: 'externally edited' } }));
  assert.equal(
    (await f.request('/api/integrations/koipy', publicSettings(saved), 'PATCH')).status,
    409,
  );
  assert.equal(JSON.parse(readFileSync(f.koipy.path, 'utf8')).image.title, 'externally edited');
});
