import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.mjs';
import { isHealthResponse } from '../src/types/api.ts';

test('API reads SQLite; reopening preserves identity and increments boot count', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tasks-test-'));
  let app;
  try {
    app = await createApp({ dataDir, staticDir: resolve('dist'), logger: false });
    const first = await app.inject('/api/health');
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    const before = first.json();
    assert(isHealthResponse(before), 'real API response satisfies the client contract');
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
    assert.match(html.headers['content-security-policy'], /img-src 'self' blob:/);
    const assets = [...html.body.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
    assert(assets.some(path => /-[\w-]+\.js$/.test(path)));
    assert(assets.some(path => /-[\w-]+\.css$/.test(path)));
    for (const path of assets) {
      const asset = await app.inject(path);
      assert.equal(asset.statusCode, 200, path);
      assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.match(asset.headers['content-type'], path.endsWith('.css') ? /text\/css/ : /text\/javascript/);
      assert.equal((await app.inject(path + '.map')).statusCode, 404);
    }
    assert(!html.body.includes('/vendor/') && !html.body.includes('/src/'));
    assert.equal((await app.inject('/index.html')).statusCode, 200);
    assert.equal((await app.inject('/sw.js')).headers['cache-control'], 'no-cache');
    assert.match((await app.inject('/manifest.webmanifest')).headers['content-type'], /application\/manifest\+json/);
    for (const url of ['/api/missing', '/server/app.mjs', '/data/tasks.sqlite', '/package.json', '/src/main.ts', '/vite.config.ts', '/tsconfig.json']) {
      assert.equal((await app.inject(url)).statusCode, 404);
    }
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('health contract rejects malformed or incomplete responses', () => {
  const valid = { status: 'ok', database: 'ok', version: '0.1.1', installationId: 'test',
    createdAt: '2026-09-10T00:00:00.000Z', serverTime: '2026-09-10T01:00:00.000Z', bootCount: 1 };
  for (const value of [null, [], 'ok', {}, { ...valid, bootCount: '1' },
    { ...valid, bootCount: -1 }, { ...valid, serverTime: 'invalid' }, { ...valid, version: undefined }]) {
    assert.equal(isHealthResponse(value), false);
  }
});
