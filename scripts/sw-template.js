/* Generated at build time. Only the public application shell is cached. */
const CACHE = __CACHE__;
const ASSETS = __ASSETS__;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('tasks-shell-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'SKIP_WAITING') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Older tabs cannot reliably acknowledge saving their drafts. Defer activation.
    if (clients.length !== 1 || clients[0].id !== event.source?.id) {
      event.ports?.[0]?.postMessage({ ok: false });
      return;
    }
    await self.skipWaiting();
    event.ports?.[0]?.postMessage({ ok: true });
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const path = event.request.mode === 'navigate' && url.pathname === '/' ? '/index.html' : url.pathname;
  if (!ASSETS.includes(path)) return;
  // Serve a coherent shell version, including its matching hashed bundles.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(path) || fetch(event.request);
  })());
});
