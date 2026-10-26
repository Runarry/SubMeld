import { createServer } from 'node:tls';
import { once } from 'node:events';
import { scannerCertificate, scannerKey } from './reality-tls-fixture.mjs';

export async function scannerTlsFixture(options = {}) {
  const sockets = new Set();
  const names = [];
  const server = createServer(
    {
      cert: scannerCertificate,
      key: scannerKey,
      minVersion: 'TLSv1.3',
      ALPNProtocols: ['h2'],
      ...options,
    },
    (socket) => {
      socket.on('error', () => {});
      names.push(socket.servername || '');
      socket.end();
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  server.listen(0, options.host || '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    sockets,
    names,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
