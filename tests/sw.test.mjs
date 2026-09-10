import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

test('offline shell works; API and non-public paths bypass the Service Worker cache', async () => {
  const code = await readFile('dist/sw.js', 'utf8');
  const handlers = {};
  const stores = new Map([['other-app', new Map()], ['tasks-shell-old', new Map()]]);
  let publicAssets = [];
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
    self: { location: { origin: 'http://localhost:3100' }, clients: { claim: async () => {} },
      addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: async () => {} },
  });
  let pending;
  handlers.install({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert(publicAssets.includes('/index.html'));
  assert(publicAssets.some(path => path.endsWith('.js')));
  assert(!publicAssets.some(path => path.startsWith('/api/') || path.includes('sqlite')));
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
  for (const path of ['/api/health', '/api/notes', '/data/tasks.sqlite', '/private.txt']) {
    assert.equal(request(path).handled, false);
  }
  assert.equal(request('/index.html', 'cors', 'POST').handled, false);
});
