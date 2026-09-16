import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const isDevelopment = process.argv.includes('--dev');
const webRoot = isDevelopment ? undefined : fileURLToPath(new URL('../web/', import.meta.url));
const app = createApp(webRoot);

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3000 }, (address) =>
  console.info(`SubMeld listening on http://127.0.0.1:${address.port}`),
);

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error('SubMeld could not close the HTTP server.');
      process.exitCode = 1;
    }
  });
  if ('closeAllConnections' in server) server.closeAllConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
