import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createApp } from '../server/app.mjs';
import { TEMPORARY_MS, createAccount, resetAccount, requireUser } from '../server/auth/accounts.mjs';
import { currentUser, createSession } from '../server/auth/sessions.mjs';
import { migrate } from '../server/migrations.mjs';
import { createBackup } from '../server/cli/backup.mjs';
import { prepareRestore } from '../server/cli/restore.mjs';
import { generatePassword, hiddenPassword } from '../server/cli/user.mjs';
import { validPassword } from '../server/auth/password.mjs';

const admin = { login: 'AdminTest', password: 'Admin9Example' };
const temporary = 'Temporary9Example', permanent = 'Permanent8Example';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-accounts-'));
  let now = Date.now(), logs = '';
  const stream = new Writable({ write(chunk, _, done) { logs += chunk; done(); } });
  const options = { dataDir: dir, auth: { origin: 'http://localhost:3100', secure: false, bootstrap: admin },
    clock: () => now, logger: { level: 'error', stream } };
  let app = await createApp(options);
  const db = new DatabaseSync(join(dir, 'tasks.sqlite'), { enableForeignKeyConstraints: true });
  t.after(async () => { db.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  function browser() {
    const jar = new Map();
    const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = response => { for (const c of response.cookies) { if (c.value) jar.set(c.name, c.value); else jar.delete(c.name); } return response; };
    const get = async path => absorb(await app.inject({ url: '/api/auth/' + path, headers: { cookie: cookies() } }));
    async function post(path, payload, extra = {}) {
      const csrf = (await get('csrf')).json().csrf;
      return absorb(await app.inject({ method: 'POST', url: '/api/auth/' + path, payload,
        headers: { origin: options.auth.origin, cookie: cookies(), 'x-csrf-token': csrf, ...extra } }));
    }
    return { get, post, cookies, jar };
  }
  const a = browser(); assert.equal((await a.post('login', admin)).statusCode, 200);
  return { dir, db, a, browser, now: () => now, advance: ms => { now += ms; }, logs: () => logs,
    reopen: async () => { await app.close(); app = await createApp(options); } };
}
const newPassword = (currentPassword, password = permanent, revokeOthers = true) => ({ currentPassword, password, repeatPassword: password, revokeOthers });

test('HTTP admin creates users; temporary and ordinary users cannot manage accounts; secrets stay out of responses and storage', async t => {
  const f = await fixture(t), b = f.browser();
  assert.equal((await b.get('users')).statusCode, 401);
  assert.equal((await f.a.post('users/create', { login: 'Other', password: temporary, role: 'admin' })).statusCode, 400);
  assert.equal((await f.a.post('users/create', { login: 'Other', password: temporary }, { origin: 'http://evil.invalid' })).statusCode, 403);
  const response = await f.a.post('users/create', { login: 'Other', password: temporary });
  assert.equal(response.statusCode, 200);
  const row = response.json().user;
  assert.equal(row.role, 'user'); assert.equal(row.mustChangePassword, true);
  assert.equal(row.temporaryExpires, f.now() + TEMPORARY_MS);
  assert.equal((await f.a.post('users/create', { login: 'OTHER', password: temporary })).json().error, 'login_exists');
  assert.equal((await b.post('login', { login: 'other', password: temporary })).json().user.mustChangePassword, true);
  assert.equal((await b.get('users')).json().error, 'password_change_required');
  assert.equal((await b.post('users/create', { login: 'Third', password: temporary })).statusCode, 403);
  assert.equal((await b.post('change-password', newPassword(temporary, temporary))).json().error, 'same_password');
  assert.equal((await b.post('change-password', newPassword('Wrong9Password'))).json().error, 'wrong_password');
  assert.equal((await b.post('change-password', { ...newPassword(temporary), repeatPassword: 'Mismatch9' })).statusCode, 400);
  const changed = await b.post('change-password', newPassword(temporary));
  assert.equal(changed.statusCode, 200); assert.equal(changed.json().user.mustChangePassword, false);
  assert.equal((await b.get('users')).json().error, 'admin_required');
  assert.equal((await b.post('users/reset', { id: row.id, expectedVersion: 1, password: temporary, confirmed: true })).statusCode, 403);
  const listing = await f.a.get('users');
  assert.equal(listing.headers['cache-control'], 'no-store');
  assert(!listing.body.includes('password_hash')); assert(!listing.body.includes(temporary));
  await createBackup(join(f.dir, 'tasks.sqlite'), join(f.dir, 'snapshot.sqlite'));
  const bytes = await readFile(join(f.dir, 'snapshot.sqlite'));
  for (const secret of [temporary, permanent, admin.password]) { assert(!bytes.includes(Buffer.from(secret))); assert(!f.logs().includes(secret)); }
  await f.reopen(); assert.equal((await b.get('session')).json().user.mustChangePassword, false);
});

test('48-hour deadline applies after login, refresh, restart and at change-password; reissue starts a fresh deadline', async t => {
  const f = await fixture(t), b = f.browser();
  const row = (await f.a.post('users/create', { login: 'Other', password: temporary })).json().user;
  f.advance(TEMPORARY_MS - 1);
  assert.equal((await b.post('login', { login: 'Other', password: temporary })).statusCode, 200);
  assert.equal((await b.post('refresh', {})).statusCode, 200);
  f.advance(1);
  assert.equal((await b.get('session')).statusCode, 401);
  assert.equal((await b.post('change-password', newPassword(temporary))).statusCode, 401);
  assert.equal((await b.post('refresh', {})).statusCode, 401);
  await f.reopen();
  assert.equal((await b.post('login', { login: 'Other', password: temporary })).json().error, 'temporary_expired');
  assert.equal((await f.a.post('refresh', {})).statusCode, 200);
  const issued = await f.a.post('users/reset', { id: row.id, expectedVersion: row.credentialVersion, password: 'Next9Temporary', confirmed: true });
  assert.equal(issued.statusCode, 200); assert.equal(issued.json().user.temporaryExpires, f.now() + TEMPORARY_MS);
  assert.equal((await b.post('login', { login: 'Other', password: 'Next9Temporary' })).statusCode, 200);
});

test('mandatory change and reset revoke every old session; ordinary change honors the other-device choice', async t => {
  const f = await fixture(t), b = f.browser(), c = f.browser();
  const row = (await f.a.post('users/create', { login: 'Other', password: temporary })).json().user;
  for (const browser of [b, c]) assert.equal((await browser.post('login', { login: 'Other', password: temporary })).statusCode, 200);
  assert.equal((await b.post('change-password', newPassword(temporary, permanent, false))).statusCode, 200);
  assert.equal((await c.get('session')).statusCode, 401);
  assert.equal((await c.post('refresh', {})).statusCode, 401);
  assert.equal((await c.post('login', { login: 'Other', password: permanent })).statusCode, 200);
  assert.equal((await b.post('change-password', newPassword(permanent, 'Next8Permanent', false))).statusCode, 200);
  assert.equal((await c.get('session')).statusCode, 200);
  assert.equal((await b.post('change-password', newPassword('Next8Permanent', 'Final7Permanent', true))).statusCode, 200);
  assert.equal((await c.get('session')).statusCode, 401);
  const latest = (await f.a.get('users')).json().users.find(u => u.id === row.id);
  const reset = { id: row.id, expectedVersion: latest.credentialVersion, password: 'Fresh9Temporary', confirmed: true };
  assert.equal((await f.a.post('users/reset', { ...reset, confirmed: false })).statusCode, 400);
  assert.equal((await f.a.post('users/reset', reset)).statusCode, 200);
  assert.equal((await b.get('session')).statusCode, 401); assert.equal((await b.post('refresh', {})).statusCode, 401);
  // A lost response followed by the same reset must not issue a second password or extend its deadline.
  assert.equal((await f.a.post('users/reset', reset)).json().error, 'account_changed');
  const owner = (await f.a.get('users')).json().users.find(u => u.role === 'admin');
  assert.equal((await f.a.post('users/reset', { ...reset, id: owner.id, expectedVersion: owner.credentialVersion })).statusCode, 404);
});

test('CLI service cannot initialize setup, creates only users, and recovers an existing administrator', async t => {
  const db = new DatabaseSync(':memory:'); migrate(db);
  await assert.rejects(createAccount(db, { login: 'Other', password: temporary }), /setup_required/); db.close();
  const f = await fixture(t);
  const created = await createAccount(f.db, { login: 'CommandUser', password: temporary }, undefined, f.now);
  assert.equal(created.role, 'user'); assert.equal(created.temporaryExpires, f.now() + TEMPORARY_MS);
  const owner = f.db.prepare("SELECT * FROM users WHERE role='admin'").get();
  await resetAccount(f.db, { id: owner.id, role: 'admin', expectedVersion: owner.credential_version, password: temporary }, undefined, f.now);
  assert.equal((await f.a.get('session')).statusCode, 401);
  assert.equal((await f.a.post('login', { login: owner.login, password: temporary })).json().user.mustChangePassword, true);
  assert.equal((await f.a.get('users')).statusCode, 403);
  assert.equal((await f.a.post('change-password', newPassword(temporary))).statusCode, 200);
  assert.equal((await f.a.get('users')).statusCode, 200);
  await f.reopen(); assert.equal((await f.a.post('login', admin)).statusCode, 401, 'ENV did not reset recovered admin');
});

test('concurrent create/reset commits once; revoked actor is rechecked after hashing', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([1, 2].map(() => createAccount(f.db, { login: 'Concurrent', password: temporary })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const row = results.find(r => r.status === 'fulfilled').value;
  const resets = await Promise.allSettled([1, 2].map(() => resetAccount(f.db, { id: row.id, expectedVersion: 0, password: temporary })));
  assert.equal(resets.filter(r => r.status === 'fulfilled').length, 1);
  const access = f.a.jar.get('tasks_access');
  const pending = createAccount(f.db, { login: 'RevokedActor', password: temporary }, () => requireUser(f.db, access, f.now(), { admin: true }));
  f.db.exec('UPDATE sessions SET revoked=1');
  await assert.rejects(pending, /unauthorized/);
  assert.equal(f.db.prepare("SELECT 1 FROM users WHERE login='revokedactor'").get(), undefined);
});

test('schema 2 backup migrates to 3 preserving admin, installation and access; restored copy remains schema 2', async t => {
  const f = await fixture(t);
  const owner = f.db.prepare("SELECT * FROM users WHERE role='admin'").get();
  const pair = createSession(f.db, owner.id, f.now());
  const before = f.db.prepare('SELECT * FROM installation').get();
  f.db.exec('ALTER TABLE users DROP COLUMN must_change_password; ALTER TABLE users DROP COLUMN temporary_expires; ALTER TABLE users DROP COLUMN credential_version; PRAGMA user_version=2;');
  const source = join(f.dir, 'tasks.sqlite'), backup = join(f.dir, 'schema2.sqlite');
  assert.equal((await createBackup(source, backup)).schemaVersion, 2);
  migrate(f.db);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(f.db.prepare('SELECT * FROM installation').get(), before);
  assert.equal(currentUser(f.db, pair.access, f.now()).mustChangePassword, false);
  assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(owner.id).password_hash, owner.password_hash);
  const restored = join(f.dir, 'restored'); await prepareRestore(backup, restored);
  const copy = new DatabaseSync(join(restored, 'tasks.sqlite'), { readOnly: true });
  try { assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 2); } finally { copy.close(); }
});

test('login racing a CLI reset cannot leave a valid old-password session; a lost change response is recoverable with the new password', async t => {
  const f = await fixture(t), b = f.browser();
  const row = await createAccount(f.db, { login: 'RacingUser', password: temporary }, undefined, f.now);
  const results = await Promise.all([
    b.post('login', { login: row.login, password: temporary }),
    resetAccount(f.db, { id: row.id, expectedVersion: 0, password: 'Reissued9Password' }, undefined, f.now),
  ]);
  assert([200, 401].includes(results[0].statusCode));
  assert.equal((await b.get('session')).statusCode, 401);
  assert.equal((await b.post('refresh', {})).statusCode, 401);
  assert.equal((await b.post('login', { login: row.login, password: 'Reissued9Password' })).statusCode, 200);
  const oldJar = new Map(b.jar);
  assert.equal((await b.post('change-password', newPassword('Reissued9Password'))).statusCode, 200);
  // Simulate the response (including replacement cookies) never reaching the client.
  b.jar.clear(); for (const [key, value] of oldJar) b.jar.set(key, value);
  assert.equal((await b.post('change-password', newPassword('Reissued9Password'))).statusCode, 401);
  assert.equal((await b.post('login', { login: row.login, password: permanent })).statusCode, 200);
  assert.equal((await b.get('session')).json().user.mustChangePassword, false);
  assert.equal(f.db.prepare('SELECT credential_version FROM users WHERE id=?').get(row.id).credential_version, 2);
});

test('generated passwords satisfy rules; hidden terminal input is not echoed and cancellation restores terminal', async () => {
  const generated = new Set(Array.from({ length: 30 }, generatePassword));
  assert.equal(generated.size, 30);
  for (const password of generated) { assert.equal(password.length, 16); assert(validPassword(password)); }
  class Input extends EventEmitter { isTTY = true; isRaw = false; setRawMode(value) { this.isRaw = value; } resume() {} pause() {} }
  const input = new Input(); let output = '';
  const terminal = { isTTY: true, write: value => { output += value; } };
  const entered = hiddenPassword('Пароль: ', input, terminal);
  input.emit('keypress', temporary, {}); input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await entered, temporary); assert(!output.includes(temporary)); assert.equal(input.isRaw, false);
  const cancelled = hiddenPassword('Пароль: ', input, terminal);
  input.emit('keypress', '\x03', { ctrl: true, name: 'c' });
  await assert.rejects(cancelled, /cancelled/); assert.equal(input.isRaw, false);
  assert.throws(() => hiddenPassword('', { isTTY: false }, terminal), /tty_required/);
});
