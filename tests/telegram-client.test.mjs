import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import { Request, getGlobalDispatcher } from 'undici';
import { TelegramApiError, TelegramClient } from '../dist/server/telegram-client.js';
import { AppError, publicError } from '../dist/server/errors.js';
import { MAX_BYTES } from '../dist/server/shared/contracts.js';

const token = '123456:local_telegram_fixture';
const privateDescription =
  'https://api.telegram.org/bot' + token + '/getMe proxy-user:proxy-password private-content';

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function assertRedacted(error) {
  const text = JSON.stringify({ ...error, public: publicError(error), stack: error.stack });
  for (const secret of [token, 'proxy-user', 'proxy-password', 'private-content', 'https://'])
    assert.equal(text.includes(secret), false, text);
  assert.equal(error.cause, undefined);
}

async function fixture(t, handler) {
  const failures = [];
  const clients = [];
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      failures.push(error);
      response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return {
    origin,
    client(proxyUrl = null) {
      const client = new TelegramClient(token, proxyUrl, { apiOrigin: origin });
      clients.push(client);
      return client;
    },
  };
}

test('JSON calls and multipart uploads preserve fields and select the correct file field', async (t) => {
  const received = [];
  const f = await fixture(t, async (request, response) => {
    const payload = await buffer(request);
    const method = request.url.split('/').at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/bot' + token + '/' + method);
    if (method === 'sendMessage') {
      assert.equal(request.headers['content-type'], 'application/json');
      received.push(JSON.parse(payload));
    } else {
      assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
      const form = await new Request(f.origin, {
        method: 'POST',
        headers: request.headers,
        body: payload,
      }).formData();
      const field = method === 'sendPhoto' ? 'photo' : 'document';
      const file = form.get(field);
      received.push({
        chat: form.get('chat_id'),
        silent: form.get('disable_notification'),
        markup: JSON.parse(form.get('reply_markup')),
        missing: form.has('omitted'),
        otherFile: form.has(field === 'photo' ? 'document' : 'photo'),
        name: file.name,
        type: file.type,
        data: Buffer.from(await file.arrayBuffer()).toString(),
      });
    }
    json(response, { ok: true, result: { message_id: received.length } });
  });
  const client = f.client();
  const body = { chat_id: -9001, text: '本地消息', reply_markup: { inline_keyboard: [] } };
  assert.deepEqual(await client.call('sendMessage', body), { message_id: 1 });
  assert.deepEqual(received[0], body);
  for (const method of ['sendPhoto', 'sendDocument']) {
    await client.upload(
      method,
      {
        chat_id: -9001,
        disable_notification: true,
        reply_markup: { inline_keyboard: [] },
        omitted: undefined,
      },
      { name: 'report.txt', data: Buffer.from('文件内容'), contentType: 'text/plain' },
    );
    assert.deepEqual(received.at(-1), {
      chat: '-9001',
      silent: 'true',
      markup: { inline_keyboard: [] },
      missing: false,
      otherFile: false,
      name: 'report.txt',
      type: 'text/plain',
      data: '文件内容',
    });
  }
});

test('unknown, incomplete, malformed and HTTP-inconsistent envelopes fail safely', async (t) => {
  const cases = [
    { value: null },
    { value: { ok: 'true', result: 1 } },
    { value: { ok: true } },
    { value: { ok: false, error_code: '401', description: privateDescription } },
    {
      value: {
        ok: false,
        error_code: 429,
        description: privateDescription,
        parameters: { retry_after: -1 },
      },
    },
    { value: { ok: true, result: 1 }, status: 401 },
    { raw: privateDescription },
  ];
  let index = 0;
  const f = await fixture(t, (request, response) => {
    request.resume();
    const item = cases[index++];
    if (item.raw) response.end(item.raw);
    else json(response, item.value, item.status);
  });
  const client = f.client();
  for (const item of cases) {
    await assert.rejects(client.call('getMe'), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'TELEGRAM_PROTOCOL', JSON.stringify(item));
      assertRedacted(error);
      return true;
    });
  }
  assert.equal(index, cases.length);
});

test('401, 403, 409 and 429 retain only safe error codes and retry timing; no automatic retry', async (t) => {
  let requests = 0;
  const f = await fixture(t, async (request, response) => {
    const { code } = JSON.parse(await buffer(request));
    requests++;
    json(
      response,
      {
        ok: false,
        error_code: code,
        description: privateDescription,
        ...(code === 429 ? { parameters: { retry_after: 3 } } : {}),
      },
      code,
    );
  });
  const client = f.client();
  for (const [code, name] of [
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
  ]) {
    await assert.rejects(client.call('sendMessage', { code }), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.telegramCode, code);
      assert.equal(error.status, code);
      assert.equal(error.code, 'TELEGRAM_' + name);
      assert.equal(error.retryAfterMs, code === 429 ? 3000 : null);
      assert.equal(error.notModified, false);
      assertRedacted(error);
      return true;
    });
  }
  assert.equal(requests, 4);
});

test('unchanged-message errors are marked harmless only for edit methods', async (t) => {
  const f = await fixture(t, (request, response) => {
    request.resume();
    json(response, {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message is not modified: ' + privateDescription,
    });
  });
  const client = f.client();
  for (const method of ['editMessageText', 'editMessageReplyMarkup', 'sendMessage']) {
    await assert.rejects(client.call(method, {}), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.notModified, method.startsWith('editMessage'));
      assert.equal(
        error.code,
        method.startsWith('editMessage') ? 'TELEGRAM_NOT_MODIFIED' : 'TELEGRAM_REJECTED',
      );
      assertRedacted(error);
      return true;
    });
  }
});

test('download uses getFile, preserves UTF-8 and accepts exactly the 4 MiB limit', async (t) => {
  let fileId = '';
  const downloaded = [];
  const text = Buffer.from('本地节点文件\n');
  const f = await fixture(t, async (request, response) => {
    if (request.method === 'POST') {
      assert.equal(request.url, '/bot' + token + '/getFile');
      fileId = JSON.parse(await buffer(request)).file_id;
      json(response, {
        ok: true,
        result: {
          file_path: fileId === 'exact-limit' ? 'documents/large.txt' : 'documents/临时 node.txt',
          file_size: fileId === 'exact-limit' ? MAX_BYTES : text.length,
        },
      });
    } else {
      downloaded.push(request.url);
      if (fileId === 'exact-limit') response.end(Buffer.alloc(MAX_BYTES, 'a'));
      else {
        response.write(text.subarray(0, 2));
        response.end(text.subarray(2));
      }
    }
  });
  const client = f.client();
  assert.equal(await client.download('fixture-file'), text.toString());
  assert.equal(
    downloaded[0],
    '/file/bot' + token + '/documents/' + encodeURIComponent('临时 node.txt'),
  );
  assert.equal((await client.download('exact-limit')).length, MAX_BYTES);
});

test('download rejects oversized metadata, advertised HTTP length and oversized actual streams', async (t) => {
  let fileId = '';
  let downloads = 0;
  const f = await fixture(t, async (request, response) => {
    if (request.method === 'POST') {
      fileId = JSON.parse(await buffer(request)).file_id;
      json(response, {
        ok: true,
        result: {
          file_path: 'documents/' + fileId + '.txt',
          file_size: fileId === 'metadata' ? MAX_BYTES + 1 : 1,
        },
      });
    } else {
      downloads++;
      if (fileId === 'header') {
        response.writeHead(200, { 'content-length': MAX_BYTES + 1 });
        response.flushHeaders();
        response.end('a');
      } else {
        response.write(Buffer.alloc(MAX_BYTES, 'a'));
        response.end('b');
      }
    }
  });
  const client = f.client();
  await assert.rejects(client.download('metadata'), { code: 'TELEGRAM_FILE_LIMIT', status: 413 });
  assert.equal(downloads, 0);
  for (const id of ['header', 'stream'])
    await assert.rejects(client.download(id), { code: 'TELEGRAM_FILE_LIMIT', status: 413 });
  assert.equal(downloads, 2);
});

test('download rejects malformed UTF-8 and invalid file metadata without exposing content', async (t) => {
  let fileId = '';
  let downloads = 0;
  const f = await fixture(t, async (request, response) => {
    if (request.method === 'POST') {
      fileId = JSON.parse(await buffer(request)).file_id;
      json(response, {
        ok: true,
        result:
          fileId === 'utf8'
            ? { file_path: 'documents/invalid.txt', file_size: 2 }
            : fileId === 'size'
              ? { file_path: 'documents/file.txt', file_size: '2' }
              : { file_path: fileId },
      });
    } else {
      downloads++;
      response.end(Buffer.from([0xc3, 0x28]));
    }
  });
  const client = f.client();
  await assert.rejects(client.download('utf8'), (error) => {
    assert.equal(error.code, 'TELEGRAM_FILE_ENCODING');
    assert.equal(error.status, 415);
    assertRedacted(error);
    return true;
  });
  for (const fileId of [
    'size',
    '../private-content',
    '/absolute',
    'a//b',
    'a\\b',
    'a?token=secret',
    'a\nfile',
    '\ud800',
  ])
    await assert.rejects(client.download(fileId), { code: 'TELEGRAM_PROTOCOL' });
  assert.equal(downloads, 1);
});

test('abort reasons and network failures are redacted, and close aborts in-flight polling', async (t) => {
  let started;
  let requests = 0;
  const f = await fixture(t, (request, response) => {
    request.resume();
    requests++;
    if (request.url.endsWith('/sendMessage')) response.destroy();
    else started?.();
  });
  const client = f.client();
  const assertCancelled = (error) => {
    assert.equal(error.code, 'TELEGRAM_CANCELLED');
    assertRedacted(error);
    return true;
  };
  const abort = new AbortController();
  const ready = new Promise((resolve) => (started = resolve));
  const pending = client.call('getUpdates', { timeout: 30 }, abort.signal);
  const cancelled = assert.rejects(pending, assertCancelled);
  await ready;
  abort.abort(new Error(privateDescription));
  await cancelled;
  await assert.rejects(client.call('getMe', undefined, abort.signal), assertCancelled);
  assert.equal(requests, 1);
  await assert.rejects(client.call('sendMessage', { text: 'fixture' }), (error) => {
    assert.equal(error.code, 'TELEGRAM_UNAVAILABLE');
    assertRedacted(error);
    return true;
  });
  assert.equal(requests, 2);
  const polling = new Promise((resolve) => (started = resolve));
  const closingPoll = assert.rejects(client.call('getUpdates', { timeout: 30 }), assertCancelled);
  await polling;
  const closing = client.close();
  assert.equal(client.close(), closing);
  await closing;
  await closingPoll;
  await assert.rejects(client.call('getMe'), { code: 'TELEGRAM_CLOSED' });
});

test('ordinary calls, 30-second polling and file downloads have finite independent timeouts', async (t) => {
  const f = await fixture(t, (request, response) => {
    request.resume();
    if (request.url.endsWith('/getFile'))
      json(response, { ok: true, result: { file_path: 'documents/timeout.txt' } });
  });
  const timeout = AbortSignal.timeout;
  const limits = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    limits.push(milliseconds);
    return timeout(80);
  });
  const client = f.client();
  for (const request of [
    () => client.call('getUpdates', { timeout: 30 }),
    () => client.call('getMe'),
    () => client.download('timeout'),
  ])
    await assert.rejects(request(), { code: 'TELEGRAM_TIMEOUT', status: 504 });
  assert.deepEqual(limits, [40_000, 20_000, 20_000, 30_000]);
});

test('only the configured Telegram client uses its local proxy and optional authentication', async (t) => {
  let directRequests = 0;
  const direct = await fixture(t, (request, response) => {
    request.resume();
    directRequests++;
    json(response, { ok: true, result: { via: 'direct' } });
  });
  const proxied = [];
  const proxy = await fixture(t, (request, response) => {
    request.resume();
    proxied.push({ url: request.url, auth: request.headers['proxy-authorization'] });
    json(response, { ok: true, result: { via: 'proxy' } });
  });
  const previous = new Map(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].map((key) => [key, process.env[key]]),
  );
  for (const key of previous.keys()) process.env[key] = key === 'NO_PROXY' ? '' : proxy.origin;
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const dispatcher = getGlobalDispatcher();
  const proxyUrl = new URL(proxy.origin);
  proxyUrl.username = 'fixture-user';
  proxyUrl.password = 'fixture p@ss:word';
  assert.deepEqual(await direct.client(proxyUrl.href).call('getMe'), { via: 'proxy' });
  assert.deepEqual(await direct.client().call('getMe'), { via: 'direct' });
  await fetch(direct.origin + '/unrelated');
  assert.equal(directRequests, 2);
  assert.equal(getGlobalDispatcher(), dispatcher);
  assert.deepEqual(proxied, [
    {
      url: direct.origin + '/bot' + token + '/getMe',
      auth: 'Basic ' + Buffer.from('fixture-user:fixture p@ss:word').toString('base64'),
    },
  ]);
});

test('redirects, path injection and invalid configuration cannot follow or expose credential URLs', async (t) => {
  let requests = 0;
  const f = await fixture(t, (request, response) => {
    request.resume();
    requests++;
    response.writeHead(302, { location: f.origin + '/private-content' });
    response.end(privateDescription);
  });
  const client = f.client();
  await assert.rejects(client.call('getMe'), { code: 'TELEGRAM_PROTOCOL' });
  await assert.rejects(client.call('../private-content'), { code: 'TELEGRAM_CONFIG' });
  assert.equal(requests, 1);
  for (const create of [
    () => new TelegramClient(token, 'ftp://proxy-user:proxy-password@localhost'),
    () => new TelegramClient(token, 'http://proxy-user:proxy-password@%'),
    () => new TelegramClient(token, null, { apiOrigin: 'http://nonlocal.example' }),
    () => new TelegramClient(token, null, { apiOrigin: f.origin + '/private-content' }),
    () => new TelegramClient('private-content/../' + token),
  ])
    assert.throws(create, (error) => {
      assert.equal(error.code, 'TELEGRAM_CONFIG');
      assertRedacted(error);
      return true;
    });
});
