/* Generated at build time. Only the public application shell is cached. */
const CACHE = __CACHE__;
const OCR_MODEL_CACHE = 'tasks-ocr-models-v1';
const OCR_MANIFEST = '/ocr-models/manifest.json';
const ASSETS = __ASSETS__;
const OCR_ASSETS = __OCR_ASSETS__;
async function shellReady() {
  const cache = await caches.open(CACHE);
  return (await Promise.all(ASSETS.map(path => cache.match(path)))).every(Boolean);
}
async function downloadShell(report) {
  await caches.delete(CACHE);
  const cache = await caches.open(CACHE);
  report?.({ type: 'UPDATE_PROGRESS', loaded: 0, total: ASSETS.length });
  try {
    for (let index = 0; index < ASSETS.length; index++) {
      const path = ASSETS[index];
      const response = await fetch(path, { cache: 'no-store' });
      if (!response || response.ok === false) throw new Error(`Unable to download ${path}`);
      await cache.put(path, response.clone ? response.clone() : response);
      report?.({ type: 'UPDATE_PROGRESS', loaded: index + 1, total: ASSETS.length });
    }
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
}
async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage?.(message);
}
async function downloadMissingInitialShell() {
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const path of ASSETS) if (!await cache.match(path)) missing.push(path);
  if (!missing.length) return;
  await broadcast({ type: 'INITIAL_CACHE_PROGRESS', loaded: 0, total: missing.length });
  try {
    for (let index = 0; index < missing.length; index++) {
      const path = missing[index];
      const response = await fetch(path, { cache: 'no-store' });
      if (!response || response.ok === false) throw new Error(`Unable to download ${path}`);
      await cache.put(path, response.clone ? response.clone() : response);
      await broadcast({ type: 'INITIAL_CACHE_PROGRESS', loaded: index + 1, total: missing.length });
    }
    await broadcast({ type: 'INITIAL_CACHE_READY', loaded: missing.length, total: missing.length });
  } catch (error) {
    await caches.delete(CACHE);
    await broadcast({ type: 'INITIAL_CACHE_ERROR' });
    throw error;
  }
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // One-time migration from the broken OCR shell that precached ORT runtime
    // responses with stale MIME headers. It must remain automatic because that
    // worker cannot display the new deferred-download interface.
    const keys = await caches.keys();
    let migrateLegacyOcrShell = false;
    for (const key of keys) {
      if (!key.startsWith('tasks-shell-') || key === CACHE) continue;
      const legacy = await caches.open(key);
      if (await legacy.match('/ocr-runtime/paddle/ort-wasm-simd-threaded.jsep.mjs')) {
        migrateLegacyOcrShell = true;
        break;
      }
    }
    // On a normal update only this small worker is installed. The application
    // shell is downloaded later, after the user presses the update button.
    if (migrateLegacyOcrShell) {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
    } else if (!self.registration.active) {
      await downloadMissingInitialShell();
    }
    if (migrateLegacyOcrShell) await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('tasks-shell-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'DOWNLOAD_UPDATE') {
    event.waitUntil((async () => {
      const port = event.ports?.[0];
      try {
        await downloadShell(message => port?.postMessage(message));
        port?.postMessage({ type: 'UPDATE_READY', loaded: ASSETS.length, total: ASSETS.length });
      } catch {
        port?.postMessage({ type: 'UPDATE_ERROR' });
      }
    })());
    return;
  }
  if (event.data?.type !== 'SKIP_WAITING') return;
  event.waitUntil((async () => {
    if (!await shellReady()) {
      // Compatibility with the previously released UI, whose update button
      // sends SKIP_WAITING directly. Its click still counts as confirmation.
      try { await downloadShell(); }
      catch {
        event.ports?.[0]?.postMessage({ ok: false, reason: 'download_failed' });
        return;
      }
    }
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
  if (event.request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('/index.html');
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put('/index.html', response.clone());
        return response;
      } catch {
        return await cache.match('/index.html') || Response.error();
      }
    })());
    return;
  }
  const path = url.pathname;
  if (path === OCR_MANIFEST) {
    event.respondWith((async () => {
      const modelCache = await caches.open(OCR_MODEL_CACHE);
      try {
        const response = await fetch(event.request);
        if (response.ok) await modelCache.put(OCR_MANIFEST, response.clone());
        return response;
      } catch {
        return await modelCache.match(OCR_MANIFEST) || Response.error();
      }
    })());
    return;
  }
  if (OCR_ASSETS.includes(path)) {
    event.respondWith((async () => {
      if (url.searchParams.has('ocr-download')) return fetch(event.request);
      const modelCache = await caches.open(OCR_MODEL_CACHE);
      return await modelCache.match(path) || fetch(event.request);
    })());
    return;
  }
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
    else if(value?.type==='tasks-reminder'&&uuid.test(value.accountId)&&uuid.test(value.vaultId)&&uuid.test(value.objectId)&&uuid.test(value.configId)&&uuid.test(value.occurrenceId)
      &&typeof value.body==='string'&&value.body.trim()&&Array.from(value.body).length<=200){
      id=value.occurrenceId;body=value.body;data={type:'tasks-reminder',accountId:value.accountId,vaultId:value.vaultId,objectId:value.objectId,configId:value.configId,occurrenceId:value.occurrenceId};
    } else if(value?.type==='tasks-collaboration'&&uuid.test(value.id)&&uuid.test(value.accountId)
      &&['friend_request','vault_invite','comment','role_changed','member_removed','key_changed'].includes(value.eventType)
      &&(value.vaultId===undefined||uuid.test(value.vaultId))&&(value.objectId===undefined||uuid.test(value.objectId))){
      const bodies={friend_request:'Новая заявка в контакты',vault_invite:'Приглашение в хранилище',comment:'Новый комментарий',
        role_changed:'Изменены права доступа',member_removed:'Изменён доступ к хранилищу',key_changed:'Изменился E2EE-ключ совместной работы'};
      id=value.id;body=bodies[value.eventType];data={type:'tasks-collaboration',accountId:value.accountId,eventType:value.eventType,
        ...(value.vaultId?{vaultId:value.vaultId}:{}),...(value.objectId?{objectId:value.objectId}:{})};
    }
  } catch {}
  event.waitUntil(self.registration.showNotification('Tasks', {
    body,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:'tasks-'+id,renotify:data.type!=='tasks-test',data,
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async()=>{
    const d=event.notification.data;
    const target=d?.type==='tasks-reminder'?'#reminder='+encodeURIComponent([d.accountId,d.vaultId,d.objectId,d.configId,d.occurrenceId].join('.')):'';
    const path='/'+target;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>new URL(client.url).origin===self.location.origin&&new URL(client.url).pathname==='/');
    if(existing){if(target&&existing.navigate)await existing.navigate(path);return existing.focus();}
    return self.clients.openWindow(path);
  })());
});
