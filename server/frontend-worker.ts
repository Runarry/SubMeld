// Run before the unmodified upstream worker so its root-scoped navigation/cache
// handlers never substitute Sub-Store for SubMeld pages or published artifacts.
export const frontendWorkerBoundary = String.raw`
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin &&
      (/^\/(submeld|api|s)(\/|$)/.test(url.pathname) ||
       url.pathname === '/healthz' || url.pathname === '/source.tar.gz')) {
    event.stopImmediatePropagation();
    event.respondWith(fetch(event.request));
  }
});
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;
