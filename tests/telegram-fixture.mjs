import { createServer } from 'node:http';
import { once } from 'node:events';

// A local Bot API peer: exercises HTTP/JSON/multipart without contacting Telegram.
export async function telegramFixture() {
  const calls = [],
    uploads = [],
    updates = [],
    responses = [],
    files = new Map(),
    failures = new Map();
  let botId = 90001,
    messageId = 1000,
    tail = 0,
    subscription = '';
  const server = createServer(async (req, res) => {
    if (req.url === '/subscription') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(subscription);
      return;
    }
    if (req.url.startsWith('/file/bot')) {
      const file = files.get(decodeURIComponent(req.url.split('/').at(-1)));
      if (file?.hang) return;
      res.writeHead(file ? 200 : 404);
      res.end(file?.data ?? 'missing');
      return;
    }
    const method = req.url.split('/').at(-1);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    const multipart = req.headers['content-type']?.startsWith('multipart/');
    const body = multipart ? null : JSON.parse(data.toString('utf8') || '{}');
    calls.push({ method, body });
    const failure = failures.get(method)?.shift();
    res.setHeader('content-type', 'application/json');
    if (failure) {
      res.end(JSON.stringify({ ok: false, ...failure }));
      return;
    }
    let result;
    if (method === 'getMe') result = { id: botId, is_bot: true, username: 'submeld_test_bot' };
    else if (method === 'getWebhookInfo') result = { url: '' };
    else if (method === 'getUpdates') {
      if (responses.length) result = responses.shift();
      else {
        let offset = body.offset ?? 0;
        // TQueue rejects offsets beyond tail + 10; Bot API retries from the queue head.
        if (updates.length && (offset <= 0 || offset > tail + 10)) offset = updates[0].update_id;
        while (updates.length && updates[0].update_id < offset) updates.shift();
        // Reading does not acknowledge updates. A later offset does.
        result = updates.slice(0, body.limit ?? 100);
      }
    } else if (method === 'getFile') {
      const file = files.get(body.file_id);
      result = {
        file_path: 'fixture/' + body.file_id,
        file_size: file?.size ?? file?.data.length ?? 0,
      };
    } else {
      if (multipart) {
        const boundary = req.headers['content-type'].match(/boundary=(.+)$/)[1];
        const start = data.indexOf(Buffer.from('filename="'));
        const nameEnd = data.indexOf(Buffer.from('"'), start + 10);
        const payloadStart = data.indexOf(Buffer.from('\r\n\r\n'), nameEnd) + 4;
        const payloadEnd = data.indexOf(Buffer.from('\r\n--' + boundary), payloadStart);
        uploads.push({
          method,
          name: data.subarray(start + 10, nameEnd).toString(),
          data: data.subarray(payloadStart, payloadEnd),
        });
      }
      result = { message_id: ++messageId };
    }
    res.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    origin: 'http://127.0.0.1:' + port,
    subscriptionUrl: 'http://host.docker.internal:' + port + '/subscription',
    calls,
    uploads,
    files,
    push: (...items) => {
      updates.push(...items);
      for (const item of items) tail = Math.max(tail, item.update_id + 1);
    },
    resetQueue: (...items) => {
      updates.splice(0, updates.length, ...items);
      tail = items.length ? Math.max(...items.map((item) => item.update_id)) + 1 : 0;
    },
    // Explicit malformed/repeated responses exercise client-side guards independently of the queue.
    respond: (...items) => responses.push(items),
    setBotId: (value) => {
      botId = value;
    },
    setSubscription: (value) => {
      subscription = value;
    },
    fail: (method, failure) => {
      if (!failures.has(method)) failures.set(method, []);
      failures.get(method).push(failure);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function telegramMessage(updateId, value, userId = 101, chat = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: 'private', ...chat },
      ...(typeof value === 'string' ? { text: value } : { document: value }),
    },
  };
}
