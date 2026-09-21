import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

test('offline shell works; API and non-public paths bypass the Service Worker cache', async () => {
  const code = await readFile('dist/sw.js', 'utf8');
  const handlers = {};
  const stores = new Map([['other-app', new Map()], ['tasks-shell-old', new Map()]]);
  let publicAssets = [];
  const initialCacheMessages = [];
  let activationRequests = 0;
  let windows = [
    { id: 'current', postMessage: message => initialCacheMessages.push(message) },
    { id: 'draft-tab', postMessage: message => initialCacheMessages.push(message) },
  ];
  const notifications=[];let opened,focused=0,closed=0,navigated;
  const cacheApi = {
    async open(key) {
      if (!stores.has(key)) stores.set(key, new Map());
      const entries = stores.get(key);
      return {
        async addAll(paths) {
          publicAssets = paths;
          for (const path of paths) { await access('dist' + path); entries.set(path, 'cached:' + path); }
        },
        async match(path) { return entries.get(path); },
        async put(path) {
          await access('dist' + path);
          if (!publicAssets.includes(path)) publicAssets.push(path);
          entries.set(path, 'cached:' + path);
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { stores.delete(key); },
  };
  vm.runInNewContext(code, {
    URL, caches: cacheApi,
    fetch: async path => ({ ok: true, path, clone() { return this; } }),
    self: { location: { origin: 'http://localhost:3100' }, registration:{showNotification:async(...args)=>notifications.push(args)},
      clients: { claim: async () => {}, matchAll: async () => windows,openWindow:async path=>{opened=path;} },
      addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: async () => { activationRequests++; } },
  });
  let pending;
  handlers.install({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert.equal(initialCacheMessages[0].type, 'INITIAL_CACHE_PROGRESS');
  assert.equal(initialCacheMessages[0].loaded, 0);
  assert.equal(initialCacheMessages.at(-1).type, 'INITIAL_CACHE_READY');
  assert.equal(initialCacheMessages.at(-1).loaded, initialCacheMessages.at(-1).total);
  assert(publicAssets.includes('/index.html'));
  assert(publicAssets.some(path => path.endsWith('.js')));
  assert(publicAssets.some(path => /^\/assets\/.+\.css$/.test(path)));
  assert(publicAssets.includes('/manifest.webmanifest'));
  assert(!publicAssets.some(path => /\.(?:ts|map)$/.test(path) || path.startsWith('/src/')));
  assert(!publicAssets.some(path => path.startsWith('/api/') || path.includes('sqlite')));
  assert(!publicAssets.some(path => path.startsWith('/ocr-models/')),
    'OCR manifests and model weights must not be precached in the shell');
  assert(!publicAssets.some(path => path.startsWith('/ocr-runtime/')),
    'OCR runtime files must not be precached in the shell');
  assert.equal(activationRequests, 0, 'installation must wait for user action');
  handlers.message({ data: { type: 'IGNORED' }, waitUntil(promise) { pending = promise; } });
  assert.equal(activationRequests, 0);
  let reply;
  const update = { data: { type: 'SKIP_WAITING' }, source: { id: 'current' },
    ports: [{ postMessage(value) { reply = value; } }], waitUntil(promise) { pending = promise; } };
  handlers.message(update);
  await pending;
  assert.equal(activationRequests, 0, 'other tabs may contain unsaved drafts');
  assert.equal(reply.ok, false);
  windows = [{ id: 'current' }];
  handlers.message(update);
  await pending;
  assert.equal(reply.ok, true);
  assert.equal(activationRequests, 1);
  handlers.activate({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert(stores.has('other-app'));
  assert(!stores.has('tasks-shell-old'));
  function request(path, mode = 'cors', method = 'GET') {
    let handled = false;
    let result;
    handlers.fetch({ request: { url: 'http://localhost:3100' + path, mode, method },
      respondWith(promise) { handled = true; result = promise; } });
    return { handled, result };
  }
  assert.equal(await request('/', 'navigate').result, 'cached:/index.html');
  for (const path of publicAssets) assert.equal(await request(path).result, 'cached:' + path);
  for (const path of ['/api/health', '/api/notes', '/data/tasks.sqlite', '/private.txt']) {
    assert.equal(request(path).handled, false);
  }
  assert.equal(request('/index.html', 'cors', 'POST').handled, false);
  handlers.push({data:{json:()=>({type:'tasks-test',id:'a'.repeat(36),body:'private text',url:'https://evil.test'})},waitUntil(promise){pending=promise;}});
  await pending;assert.equal(notifications.length,1);assert.ok(!JSON.stringify(notifications).includes('private text'));assert.ok(!JSON.stringify(notifications).includes('evil.test'));
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
  handlers.push({data:{json:()=>({type:'tasks-reminder',accountId:ids[0],vaultId:ids[1],objectId:ids[2],configId:ids[3],occurrenceId:ids[4],body:'Разрешённый текст'})},waitUntil(promise){pending=promise;}});
  await pending;assert.equal(notifications.length,2);assert.equal(notifications[1][1].body,'Разрешённый текст');
  handlers.push({data:{json:()=>({type:'tasks-collaboration',id:ids[4],accountId:ids[0],eventType:'comment',vaultId:ids[1],objectId:ids[2],body:'PRIVATE COMMENT'})},waitUntil(promise){pending=promise;}});
  await pending;assert.equal(notifications.length,3);assert.equal(notifications[2][1].body,'Новый комментарий');assert.ok(!JSON.stringify(notifications[2]).includes('PRIVATE COMMENT'));
  windows=[{url:'http://localhost:3100/',navigate:async path=>{navigated=path;},focus:async()=>{focused++;}}];
  const reminderClick={notification:{close(){closed++;},data:notifications[1][1].data},waitUntil(promise){pending=promise;}};
  handlers.notificationclick(reminderClick);await pending;assert.equal(navigated,'/#reminder='+ids.join('.'));assert.equal(focused,1);
  const click={notification:{close(){closed++;},data:{url:'https://evil.test'}},waitUntil(promise){pending=promise;}};
  handlers.notificationclick(click);await pending;assert.equal(focused,2);assert.equal(opened,undefined);
  windows=[];handlers.notificationclick(click);await pending;assert.equal(opened,'/');assert.equal(closed,3);
});

test('PWA update downloads its shell only after confirmation and reports progress', async () => {
  const code = await readFile('dist/sw.js', 'utf8');
  const handlers = {}, stores = new Map([['tasks-shell-current', new Map([['/index.html', 'old shell']])]]);
  let pending, addAllCalls = 0, activationRequests = 0, downloaded = 0;
  const cacheApi = {
    async open(key) {
      if (!stores.has(key)) stores.set(key, new Map());
      const entries = stores.get(key);
      return {
        async addAll() { addAllCalls++; },
        async match(path) { return entries.get(path); },
        async put(path, response) { entries.set(path, response); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); },
  };
  vm.runInNewContext(code, {
    URL, caches: cacheApi,
    fetch: async path => { downloaded++; return { ok: true, path, clone() { return this; } }; },
    self: {
      location: { origin: 'http://localhost:3100' },
      registration: { active: {}, showNotification: async () => {} },
      clients: { claim: async () => {}, matchAll: async () => [{ id: 'current' }], openWindow: async () => {} },
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: async () => { activationRequests++; },
    },
  });
  handlers.install({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert.equal(addAllCalls, 0, 'an update must not download the application shell during install');
  assert.equal(downloaded, 0);

  const messages = [];
  handlers.message({
    data: { type: 'DOWNLOAD_UPDATE' },
    ports: [{ postMessage(value) { messages.push(value); } }],
    waitUntil(promise) { pending = promise; },
  });
  await pending;
  assert(downloaded > 0);
  assert.equal(messages[0].type, 'UPDATE_PROGRESS');
  assert.equal(messages[0].loaded, 0);
  assert.equal(messages.at(-1).type, 'UPDATE_READY');
  assert.equal(messages.at(-1).loaded, messages.at(-1).total);

  let reply;
  handlers.message({
    data: { type: 'SKIP_WAITING' }, source: { id: 'current' },
    ports: [{ postMessage(value) { reply = value; } }],
    waitUntil(promise) { pending = promise; },
  });
  await pending;
  assert.equal(reply.ok, true);
  assert.equal(activationRequests, 1);
});


test('broken OCR shell auto-activates the fixed Service Worker once', async () => {
  const code = await readFile('dist/sw.js', 'utf8');
  const handlers = {};
  const stores = new Map([
    ['tasks-shell-broken', new Map([
      ['/ocr-runtime/paddle/ort-wasm-simd-threaded.jsep.mjs', 'stale-runtime'],
    ])],
  ]);
  let activationRequests = 0;
  const cacheApi = {
    async open(key) {
      if (!stores.has(key)) stores.set(key, new Map());
      const entries = stores.get(key);
      return {
        async addAll(paths) {
          for (const path of paths) entries.set(path, 'cached:' + path);
        },
        async match(path) { return entries.get(path); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); },
  };
  vm.runInNewContext(code, {
    URL,
    Response,
    caches: cacheApi,
    fetch: async () => { throw new Error('offline'); },
    self: {
      location: { origin: 'http://localhost:3100' },
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { showNotification: async () => {} },
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: async () => { activationRequests++; },
    },
  });

  let pending;
  handlers.install({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert.equal(activationRequests, 1);
});


test('installed OCR runtime is served from its dedicated cache while fully offline', async () => {
  const code = await readFile('dist/sw.js', 'utf8');
  const manifest = JSON.parse(await readFile('dist/ocr-models/manifest.json', 'utf8'));
  assert.equal(manifest.runtimeComplete, true);

  const printed = manifest.packages['printed-ru-en-v1'];
  const runtimeAsset = printed.assets.find(
    asset => asset.url.startsWith('/ocr-runtime/paddle/') && asset.url.endsWith('.mjs'),
  );
  const workerAsset = printed.assets.find(
    asset => /^\/assets\/worker-entry-.*\.js$/.test(asset.url),
  );
  const dynamicBundle = printed.assets.find(
    asset => /^\/assets\/dist-.*\.js$/.test(asset.url),
  );
  assert(runtimeAsset, 'printed OCR package includes Paddle ORT runtime');
  assert(workerAsset, 'printed OCR package includes Paddle worker');
  assert(dynamicBundle, 'printed OCR package includes the dynamically imported Paddle bundle');

  const handlers = {};
  const ocrEntries = new Map([
    ['/ocr-models/manifest.json', 'cached:manifest'],
    [runtimeAsset.url, 'cached:runtime'],
    [workerAsset.url, 'cached:worker'],
    [dynamicBundle.url, 'cached:bundle'],
  ]);
  const stores = new Map([['tasks-ocr-models-v1', ocrEntries]]);
  let modelDownloads = 0;
  const cacheApi = {
    async open(key) {
      if (!stores.has(key)) stores.set(key, new Map());
      const entries = stores.get(key);
      return {
        async match(path) { return entries.get(path); },
        async put(path, response) { entries.set(path, response); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); },
  };

  vm.runInNewContext(code, {
    URL,
    Response,
    caches: cacheApi,
    fetch: async request => {
      if (new URL(request.url).searchParams.has('ocr-download')) {
        modelDownloads++;
        return 'network:verified-update';
      }
      throw new Error('offline');
    },
    self: {
      location: { origin: 'http://localhost:3100' },
      registration: { showNotification: async () => {} },
      clients: { claim: async () => {}, matchAll: async () => [] },
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: async () => {},
    },
  });

  function request(path) {
    let handled = false;
    let result;
    handlers.fetch({
      request: { url: 'http://localhost:3100' + path, mode: 'cors', method: 'GET' },
      respondWith(promise) { handled = true; result = promise; },
    });
    return { handled, result };
  }

  assert.equal(await request(runtimeAsset.url).result, 'cached:runtime');
  assert.equal(await request(workerAsset.url).result, 'cached:worker');
  assert.equal(await request(dynamicBundle.url).result, 'cached:bundle');
  assert.equal(await request('/ocr-models/manifest.json').result, 'cached:manifest');
  assert.equal(
    await request(runtimeAsset.url + '?ocr-download=integrity').result,
    'network:verified-update',
  );
  assert.equal(modelDownloads, 1);
});
