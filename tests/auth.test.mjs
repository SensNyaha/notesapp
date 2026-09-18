import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { createApp } from '../server/app.mjs';
import { authConfiguration } from '../server/auth/config.mjs';
import { ACCESS_MS, REFRESH_MS, ABSOLUTE_MS, RETRY_MS } from '../server/auth/sessions.mjs';
import { createBackup } from '../server/cli/backup.mjs';

// Synthetic test credentials only. Never use production accounts in this suite.
const credentials = { login: 'TestAdmin', password: 'Example9Pass', repeatPassword: 'Example9Pass' };
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-auth-'));
  let now = Date.now();
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, cb) { logs += chunk.toString(); cb(); } });
  const auth = { origin: 'http://localhost:3100', secure: false, ...options };
  let app = await createApp({ dataDir: dir, auth, clock: () => now, logger: { level: 'error', stream } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const jar = new Map();
  const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  function absorb(response) {
    for (const cookie of response.cookies) {
      if (!cookie.value) jar.delete(cookie.name); else jar.set(cookie.name, cookie.value);
    }
    return response;
  }
  async function get(path) { return absorb(await app.inject({ url: '/api/auth/' + path, headers: { cookie: cookies() } })); }
  async function post(path, body = {}, extra = {}) {
    const csrf = (await get('csrf')).json().csrf;
    return absorb(await app.inject({ method: 'POST', url: '/api/auth/' + path,
      payload: body, headers: { origin: auth.origin, cookie: cookies(), 'x-csrf-token': csrf, ...extra } }));
  }
  return { dir, jar, get, post, cookies, absorb, logs: () => logs,
    app: () => app, now: () => now, advance: ms => { now += ms; },
    async reopen() { await app.close(); app = await createApp({ dataDir: dir, auth, clock: () => now, logger: false }); },
  };
}

test('first login confirms administrator; server enforces input, CSRF and one-time setup', async t => {
  const f = await fixture(t);
  assert.equal((await f.get('setup-status')).json().setupRequired, true);
  assert.equal((await f.post('login', { login: credentials.login, password: credentials.password })).json().error, 'setup_required');
  assert.equal((await f.post('bootstrap', { ...credentials, repeatPassword: 'Other9Pass' })).statusCode, 400);
  assert.equal((await f.get('setup-status')).json().setupRequired, true);
  assert.equal((await f.post('bootstrap', credentials, { origin: 'https://evil.invalid' })).statusCode, 403);
  assert.equal((await f.post('bootstrap', credentials, { 'x-csrf-token': 'bad' })).statusCode, 403);
  assert.equal((await f.post('bootstrap', { ...credentials, role: 'admin' })).statusCode, 400);
  const created = await f.post('bootstrap', credentials);
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().user.login, 'testadmin');
  assert.equal(created.json().user.role, 'admin');
  assert(!('password_hash' in created.json().user));
  assert.equal(created.headers['cache-control'], 'no-store');
  for (const cookie of created.cookies) { assert(cookie.httpOnly); assert.equal(cookie.sameSite, 'Strict'); }
  assert.equal((await f.get('setup-status')).json().setupRequired, false);
  assert.equal((await f.post('bootstrap', credentials)).statusCode, 409);
  assert.equal((await f.get('session')).statusCode, 200);
  const captured = f.cookies();
  await f.reopen();
  assert.equal((await f.get('session')).statusCode, 200, 'session survives restart');
  assert.equal((await f.post('logout')).statusCode, 200);
  assert.equal((await f.app().inject({ url: '/api/auth/session', headers: { cookie: captured } })).statusCode, 401);
  assert.equal((await f.post('login', { login: 'TESTADMIN', password: credentials.password })).statusCode, 200);
  assert.equal((await f.post('login', { login: 'testadmin', password: 'Incorrect1' })).statusCode, 401);
});

test('device sessions are listed, renamed and revoked without ending the current session', async t => {
  const f=await fixture(t);await f.post('bootstrap',credentials);
  assert.equal((await f.post('devices/register',{deviceId:'11111111-1111-4111-8111-111111111111',deviceName:'Windows · браузер',clientKind:'browser'})).statusCode,200);
  const other=new Map(),cookie=()=>[...other].map(([k,v])=>`${k}=${v}`).join('; '),absorb=r=>{for(const c of r.cookies){if(c.value)other.set(c.name,c.value);else other.delete(c.name);}return r;};
  const otherPost=async(path,body={})=>{const csrf=absorb(await f.app().inject({url:'/api/auth/csrf',headers:{cookie:cookie()}})).json().csrf;
    return absorb(await f.app().inject({method:'POST',url:'/api/auth/'+path,payload:body,headers:{origin:'http://localhost:3100',cookie:cookie(),'x-csrf-token':csrf}}));};
  assert.equal((await otherPost('login',{login:credentials.login,password:credentials.password})).statusCode,200);
  assert.equal((await otherPost('devices/register',{deviceId:'22222222-2222-4222-8222-222222222222',deviceName:'iPhone · PWA',clientKind:'pwa'})).statusCode,200);
  let list=(await f.get('devices')).json().devices;assert.equal(list.filter(x=>!x.revoked).length,2);assert.equal(list.filter(x=>x.current).length,1);
  const second=list.find(x=>!x.current&&!x.revoked);assert(second);assert.equal(second.deviceName,'iPhone · PWA');
  assert.equal((await f.post('devices/rename',{id:second.id,deviceName:'Мой iPhone'})).statusCode,200);
  assert.equal((await otherPost('devices/register',{deviceId:'22222222-2222-4222-8222-222222222222',deviceName:'старое имя',clientKind:'pwa'})).json().deviceName,'Мой iPhone');
  assert.equal((await f.post('devices/revoke',{id:second.id})).statusCode,200);
  assert.equal((await f.app().inject({url:'/api/auth/session',headers:{cookie:cookie()}})).statusCode,401);assert.equal((await f.get('session')).statusCode,200);
  assert.equal((await f.post('devices/revoke-others',{})).statusCode,200);list=(await f.get('devices')).json().devices;assert.equal(list.filter(x=>x.current&&!x.revoked).length,1);
});

test('concurrent initial requests create exactly one administrator', async t => {
  const f = await fixture(t);
  const csrf = (await f.get('csrf')).json().csrf;
  const results = await Promise.all(['One', 'Two'].map(name => f.app().inject({ method: 'POST', url: '/api/auth/bootstrap',
    headers: { origin: 'http://localhost:3100', cookie: f.cookies(), 'x-csrf-token': csrf },
    payload: { ...credentials, login: 'Admin' + name } })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  const db = new DatabaseSync(join(f.dir, 'tasks.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  // Even removal of every account must not reopen setup.
  db.exec('PRAGMA foreign_keys = ON; DELETE FROM sessions; DELETE FROM users;');
  db.close();
  assert.equal((await f.get('setup-status')).json().setupRequired, false);
});

test('ENV bootstrap is one-time, preserves password and validates partial configuration', async t => {
  const f = await fixture(t, { bootstrap: { login: credentials.login, password: credentials.password } });
  assert.equal((await f.get('setup-status')).json().setupRequired, false);
  assert.equal((await f.post('login', { login: credentials.login, password: credentials.password })).statusCode, 200);
  const existing = await createApp({ dataDir: f.dir, auth: { origin: 'http://localhost:3100', secure: false,
    bootstrap: { login: 'other', password: 'Changed9Password' } }, logger: false });
  await existing.close();
  assert.equal((await f.post('login', { login: credentials.login, password: credentials.password })).statusCode, 200);
  for (const bootstrap of [{ login: 'admin' }, { password: credentials.password }, { login: 'admin', password: 'short' }]) {
    const dir = await mkdtemp(join(tmpdir(), 'tasks-bad-env-'));
    try {
      await assert.rejects(createApp({ dataDir: dir, auth: { bootstrap }, logger: false }), /Invalid bootstrap configuration/);
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
});

test('access expiration refreshes without password; parallel/lost replies are idempotent, late reuse revokes family', async t => {
  const f = await fixture(t);
  await f.post('bootstrap', credentials);
  f.advance(ACCESS_MS + 1);
  assert.equal((await f.get('session')).statusCode, 401);
  const csrf = (await f.get('csrf')).json().csrf;
  const old = f.cookies();
  const refresh = () => f.app().inject({ method: 'POST', url: '/api/auth/refresh', payload: {},
    headers: { origin: 'http://localhost:3100', cookie: old, 'x-csrf-token': csrf } });
  const [a, b] = await Promise.all([refresh(), refresh()]);
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
  assert.deepEqual(a.cookies.map(c => c.value), b.cookies.map(c => c.value));
  f.absorb(b);
  assert.equal((await f.get('session')).statusCode, 200);
  f.advance(RETRY_MS + 1);
  assert.equal((await refresh()).statusCode, 401);
  assert.equal((await f.get('session')).statusCode, 401, 'even new access is revoked on reuse');
});

test('refresh expires after 30 days idle and never extends beyond 90 days from login', async t => {
  const f = await fixture(t);
  await f.post('bootstrap', credentials);
  f.advance(REFRESH_MS + 1);
  assert.equal((await f.post('refresh')).statusCode, 401);
  await f.post('login', { login: credentials.login, password: credentials.password });
  const start = f.now();
  for (let i = 0; i < 4; i++) { f.advance(20 * 86400_000); assert.equal((await f.post('refresh')).statusCode, 200); }
  f.advance(ABSOLUTE_MS - (f.now() - start) + 1);
  assert.equal((await f.post('refresh')).statusCode, 401);
});

test('HTTPS cookies, origin checks, input limits, throttling and non-disclosure', async t => {
  const f = await fixture(t, { origin: 'https://tasks.example', secure: true });
  const created = await f.post('bootstrap', credentials);
  assert.equal(created.statusCode, 200);
  for (const cookie of created.cookies) {
    assert(cookie.name.startsWith('__Host-')); assert(cookie.secure); assert(cookie.httpOnly); assert.equal(cookie.path, '/');
  }
  const secrets = [credentials.password, ...created.cookies.map(c => c.value)];
  const backup = join(f.dir, 'snapshot.sqlite');
  await createBackup(join(f.dir, 'tasks.sqlite'), backup);
  const bytes = await readFile(backup);
  for (const secret of secrets) { assert(!bytes.includes(Buffer.from(secret))); assert(!f.logs().includes(secret)); }
  assert.equal((await f.post('login', { login: 'none', password: 'bad' }, { origin: 'https://attacker.example' })).statusCode, 403);
  assert.equal((await f.app().inject({ url: '/api/auth/csrf', headers: { origin: 'https://attacker.example' } })).statusCode, 403);
  const csrf = (await f.get('csrf')).json().csrf;
  const malformed = await f.app().inject({ method: 'POST', url: '/api/auth/login', payload: '{"password":',
    headers: { origin: 'https://tasks.example', cookie: f.cookies(), 'x-csrf-token': csrf, 'content-type': 'application/json' } });
  assert.equal(malformed.statusCode, 400);
  const oversized = await f.app().inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'none', password: 'x'.repeat(5000) },
    headers: { origin: 'https://tasks.example', cookie: f.cookies(), 'x-csrf-token': csrf } });
  assert.equal(oversized.statusCode, 413);
  for (let i = 0; i < 9; i++) assert.equal((await f.post('login', { login: 'none', password: 'Wrong1Pass' })).statusCode, 401);
  assert.equal((await f.post('login', { login: 'none', password: 'Wrong1Pass' })).statusCode, 429);
  f.advance(15 * 60_000 + 1);
  assert.equal((await f.post('login', { login: credentials.login, password: credentials.password })).statusCode, 200);
});

test('production cookie configuration cannot silently downgrade to HTTP', () => {
  assert.throws(() => authConfiguration({ APP_ORIGIN: 'http://tasks.example' }), /HTTPS/);
  assert.throws(() => authConfiguration({ APP_ORIGIN: 'http://tasks.example', AUTH_COOKIE_MODE: 'localhost' }), /loopback/);
  assert.throws(() => authConfiguration({ APP_ORIGIN: 'https://tasks.example/path' }), /origin|scheme/);
  assert.equal(authConfiguration({ APP_ORIGIN: 'https://tasks.example' }).secure, true);
});
