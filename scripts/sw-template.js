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
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let id='test',body='Тестовое уведомление. Уведомления на этом устройстве работают.',data={type:'tasks-test'};
  try {
    const value=event.data?.json();
    if(value?.type==='tasks-test'&&uuid.test(value.id))id=value.id;
    else if(value?.type==='tasks-reminder'&&uuid.test(value.accountId)&&uuid.test(value.vaultId)&&uuid.test(value.objectId)&&uuid.test(value.configId)
      &&typeof value.body==='string'&&value.body.trim()&&Array.from(value.body).length<=200){
      id=value.configId;body=value.body;data={type:'tasks-reminder',accountId:value.accountId,vaultId:value.vaultId,objectId:value.objectId,configId:value.configId};
    }
  } catch {}
  event.waitUntil(self.registration.showNotification('Tasks', {
    body,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:'tasks-'+id,renotify:data.type==='tasks-reminder',data,
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async()=>{
    const d=event.notification.data;
    const target=d?.type==='tasks-reminder'?'#reminder='+encodeURIComponent([d.accountId,d.vaultId,d.objectId,d.configId].join('.')):'';
    const path='/'+target;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>new URL(client.url).origin===self.location.origin&&new URL(client.url).pathname==='/');
    if(existing){if(target&&existing.navigate)await existing.navigate(path);return existing.focus();}
    return self.clients.openWindow(path);
  })());
});
