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
self.addEventListener('push', event => {
  // Never render arbitrary payload text or URLs. Even malformed/late pushes remain neutral.
  let id = 'test';
  try { const data=event.data?.json();if(data?.type==='tasks-test'&&/^[0-9a-f-]{36}$/.test(data.id))id=data.id; } catch {}
  event.waitUntil(self.registration.showNotification('Tasks', {
    body:'Тестовое уведомление. Уведомления на этом устройстве работают.',
    icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:'tasks-test-'+id,
    data:{type:'tasks-test'},
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>new URL(client.url).origin===self.location.origin&&new URL(client.url).pathname==='/');
    if(existing)return existing.focus();
    return self.clients.openWindow('/');
  })());
});
