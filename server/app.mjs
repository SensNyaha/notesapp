import Fastify, { LogController } from 'fastify';
import { resolve } from 'node:path';
import { extname, relative, sep } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { openDatabase } from './db.mjs';
import { registerAuth } from './routes/auth.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

function listPublicFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listPublicFiles(root, path) : [{ path, name: relative(root, path).split(sep).join('/') }];
  });
}

export async function createApp({ dataDir = resolve('data'), staticDir = resolve('dist'), logger = true,
  auth = { origin: 'http://localhost:3100', secure: false }, clock = Date.now, push = {} } = {}) {
  const db = openDatabase(dataDir);
  const app = Fastify({ logger, bodyLimit: 4096, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    logController: new LogController({ disableRequestLogging: true }) });
  app.addHook('onClose', async () => db.close());
  app.setErrorHandler((error, request, reply) => {
    const status = error.validation ? 400
      : Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    // Never log payloads, cookies, configuration values or raw error messages.
    if (status === 500) app.log.error({ requestId: request.id }, 'Request failed');
    reply.code(status).send({ error: status === 500 ? 'server_error' : 'invalid_request' });
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    // Only public, content-hashed bundles can use a long HTTP cache.
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const row = db.prepare('SELECT installation_id, created_at, boot_count FROM installation WHERE id = 1').get();
    return {
      status: 'ok', version, database: 'ok',
      installationId: row.installation_id,
      createdAt: row.created_at, bootCount: row.boot_count,
      serverTime: new Date().toISOString(),
    };
  });
  try { await registerAuth(app, db, auth, clock, push, dataDir); }
  catch (error) { await app.close(); throw error; }
  for (const file of listPublicFiles(staticDir)) {
    const body = readFileSync(file.path);
    const urls = file.name === 'index.html' ? ['/', '/index.html'] : [`/${file.name}`];
    const handler = async (_request, reply) => {
      reply.type(contentTypes.get(extname(file.name)) ?? 'application/octet-stream');
      reply.header('Cache-Control', file.name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      return body;
    };
    for (const url of urls) app.get(url, handler);
  }
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  return app;
}
