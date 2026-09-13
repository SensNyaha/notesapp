import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

test('offline shell works; API and non-public paths bypass the Service Worker cache', async () => {
  const code = await readFile('dist/sw.js', 'utf8');
  const handlers = {};
  const stores = new Map([['other-app', new Map()], ['tasks-shell-old', new Map()]]);
  let publicAssets = [];
  let activationRequests = 0;
  let windows = [{ id: 'current' }, { id: 'draft-tab' }];
  const notifications=[];let opened,focused=0,closed=0;
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
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { stores.delete(key); },
  };
  vm.runInNewContext(code, {
    URL, caches: cacheApi,
    fetch: async () => { throw new Error('offline'); },
    self: { location: { origin: 'http://localhost:3100' }, registration:{showNotification:async(...args)=>notifications.push(args)},
      clients: { claim: async () => {}, matchAll: async () => windows,openWindow:async path=>{opened=path;} },
      addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: async () => { activationRequests++; } },
  });
  let pending;
  handlers.install({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert(publicAssets.includes('/index.html'));
  assert(publicAssets.some(path => path.endsWith('.js')));
  assert(publicAssets.some(path => /^\/assets\/.+\.css$/.test(path)));
  assert(publicAssets.includes('/manifest.webmanifest'));
  assert(!publicAssets.some(path => /\.(?:ts|map)$/.test(path) || path.startsWith('/src/')));
  assert(!publicAssets.some(path => path.startsWith('/api/') || path.includes('sqlite')));
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
  windows=[{url:'http://localhost:3100/',focus:async()=>{focused++;}}];
  const click={notification:{close(){closed++;},data:{url:'https://evil.test'}},waitUntil(promise){pending=promise;}};
  handlers.notificationclick(click);await pending;assert.equal(focused,1);assert.equal(opened,undefined);
  windows=[];handlers.notificationclick(click);await pending;assert.equal(opened,'/');assert.equal(closed,2);
});
