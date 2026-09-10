import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.mjs';

test('API reads SQLite; reopening preserves identity and increments boot count', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tasks-test-'));
  let app;
  try {
    app = await createApp({ dataDir, staticDir: resolve('dist'), logger: false });
    const first = await app.inject('/api/health');
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    const before = first.json();
    assert.equal(before.database, 'ok');
    assert.equal(before.bootCount, 1);
    assert.match(before.installationId, /^[0-9a-f-]{36}$/);
    await app.close();
    app = await createApp({ dataDir, staticDir: resolve('dist'), logger: false });
    const after = (await app.inject('/api/health')).json();
    assert.equal(after.installationId, before.installationId);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.bootCount, 2);
    const html = await app.inject('/');
    assert.equal(html.statusCode, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.match(html.headers['content-security-policy'], /script-src 'self'/);
    assert.equal((await app.inject('/index.html')).statusCode, 200);
    assert.equal((await app.inject('/sw.js')).headers['cache-control'], 'no-cache');
    assert.match((await app.inject('/manifest.webmanifest')).headers['content-type'], /application\/manifest\+json/);
    for (const url of ['/api/missing', '/server/app.mjs', '/data/tasks.sqlite', '/package.json']) {
      assert.equal((await app.inject(url)).statusCode, 404);
    }
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
