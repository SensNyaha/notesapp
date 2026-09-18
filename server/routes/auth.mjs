import cookie from '@fastify/cookie';
import { diskUsage } from '../diagnostics.mjs';
import { registerVaults } from './vaults.mjs';
import { registerPush } from './push.mjs';
import { registerCollaboration } from './collaboration.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, normalizeLogin, validPassword } from '../auth/password.mjs';
import { bootstrapFromEnvironment, insertFirstAdmin, needsSetup } from '../auth/users.mjs';
import { createSession, currentUser, rotateSession, revokeSession, sessionByAccess, token, validToken } from '../auth/sessions.mjs';
import { AccountError, publicUser, accountRow, requireUser, createAccount, resetAccount, changePassword } from '../auth/accounts.mjs';
import { registerWebAuthn } from '../auth/webauthn.mjs';

export async function registerAuth(app, db, config, clock = Date.now, push = {}, dataDir, webauthn = {}) {
  await bootstrapFromEnvironment(db, config.bootstrap, clock());
  const dummyHash = await hashPassword('Aa1' + randomBytes(32).toString('base64url'));
  await app.register(cookie);
  const prefix = config.secure ? '__Host-tasks_' : 'tasks_';
  const names = { access: prefix + 'access', refresh: prefix + 'refresh', csrf: prefix + 'csrf' };
  const options = { httpOnly: true, secure: config.secure, sameSite: 'strict', path: '/' };
  const counters = new Map();
  let hashesInFlight = 0;

  function limited(key, max, duration) {
    const now = clock();
    for (const [k, v] of counters) if (v.until <= now) counters.delete(k);
    const entry = counters.get(key);
    if (!entry && counters.size >= 10_000) return true;
    const value = entry ?? { count: 0, until: now + duration };
    value.count++;
    counters.set(key, value);
    return value.count > max;
  }
  function writeCookies(reply, pair) {
    const now = clock();
    reply.setCookie(names.access, pair.access, { ...options, maxAge: Math.max(0, Math.floor((pair.accessExpires - now) / 1000)) });
    reply.setCookie(names.refresh, pair.refresh, { ...options, maxAge: Math.max(0, Math.floor((pair.refreshExpires - now) / 1000)) });
  }
  function clearCookies(reply) {
    reply.clearCookie(names.access, options);
    reply.clearCookie(names.refresh, options);
  }
  function rateError(reply) { return reply.header('Retry-After', '60').code(429).send({ error: 'rate_limited' }); }
  function sameOrigin(request) {
    return request.headers.origin === config.origin && request.headers['sec-fetch-site'] !== 'cross-site';
  }
  async function guard(request, reply) {
    const contentType=request.headers['content-type']?.split(';')[0].trim();
    if (!sameOrigin(request) || !['application/json','application/octet-stream'].includes(contentType)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const provided = request.headers['x-csrf-token'];
    const saved = request.cookies[names.csrf];
    if (!validToken(provided) || !validToken(saved) || !timingSafeEqual(Buffer.from(provided), Buffer.from(saved))) {
      return reply.code(403).send({ error: 'csrf' });
    }
    if (!(request.method==='PUT'&&request.url.startsWith('/api/files/'))&&limited('requests:' + request.ip, 120, 60_000)) return rateError(reply);
  }

  app.get('/api/auth/csrf', async (request, reply) => {
    if (request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin && request.headers.origin !== config.origin)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const csrf = validToken(request.cookies[names.csrf]) ? request.cookies[names.csrf] : token();
    reply.setCookie(names.csrf, csrf, { ...options, maxAge: 90 * 86400 });
    return { csrf };
  });
  app.get('/api/auth/setup-status', async () => ({ setupRequired: needsSetup(db) }));
  app.get('/api/auth/session', async (request, reply) => {
    const user = currentUser(db, request.cookies[names.access], clock());
    return user ? { user } : reply.code(401).send({ error: 'unauthorized' });
  });
  const loginSchema = {
    type: 'object', additionalProperties: false, required: ['login', 'password'],
    properties: { login: { type: 'string', maxLength: 32 }, password: { type: 'string', maxLength: 256 } },
  };
  const bootstrapSchema = { ...loginSchema, required: ['login', 'password', 'repeatPassword'],
    properties: { ...loginSchema.properties, repeatPassword: { type: 'string', maxLength: 256 } } };

  for (const bootstrap of [false, true]) {
    app.post('/api/auth/' + (bootstrap ? 'bootstrap' : 'login'), {
      preHandler: guard, schema: { body: bootstrap ? bootstrapSchema : loginSchema },
    }, async (request, reply) => {
      if (bootstrap && !needsSetup(db)) return reply.code(409).send({ error: 'setup_complete' });
      if (!bootstrap && needsSetup(db)) return reply.code(409).send({ error: 'setup_required' });
      const { login, password, repeatPassword } = request.body;
      const normalized = normalizeLogin(login);
      if (limited('login-ip:' + request.ip, 10, 15 * 60_000)
        || (normalized && limited('login-name:' + normalized, 10, 15 * 60_000)) || hashesInFlight >= 2) return rateError(reply);
      if (bootstrap && (!normalized || !validPassword(password) || password !== repeatPassword)) {
        return reply.code(400).send({ error: 'invalid_credentials' });
      }
      hashesInFlight++;
      try {
        let user, verifiedVersion = 0;
        if (bootstrap) {
          user = insertFirstAdmin(db, normalized, await hashPassword(password), clock());
          if (!user) return reply.code(409).send({ error: 'setup_complete' });
        } else {
          const row = normalized && db.prepare('SELECT * FROM users WHERE login = ?').get(normalized);
          const valid = await verifyPassword(row ? row.password_hash : dummyHash, password);
          if (!row || !valid) return reply.code(401).send({ error: 'invalid_credentials' });
          // A reset/change may have committed while Argon2 was running.
          const latest = db.prepare('SELECT * FROM users WHERE id=?').get(row.id);
          if (!latest || latest.credential_version !== row.credential_version) return reply.code(401).send({ error: 'invalid_credentials' });
          if (latest.must_change_password && !(latest.temporary_expires > clock())) return reply.code(401).send({ error: 'temporary_expired' });
          user = publicUser(latest);
          verifiedVersion = latest.credential_version;
        }
        // Lock the final credential check and session insertion together: CLI is a separate process.
        db.exec('BEGIN IMMEDIATE');
        let pair;
        try {
          const finalRow = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
          if (!finalRow || finalRow.credential_version !== verifiedVersion) {
            db.exec('ROLLBACK'); return reply.code(401).send({ error: 'invalid_credentials' });
          }
          const now = clock();
          if (finalRow.must_change_password && !(finalRow.temporary_expires > now)) {
            db.exec('ROLLBACK'); return reply.code(401).send({ error: 'temporary_expired' });
          }
          user = publicUser(finalRow);
          revokeSession(db, request.cookies[names.access], request.cookies[names.refresh]);
          pair = createSession(db, user.id, now);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        writeCookies(reply, pair);
        return { user };
      } finally { hashesInFlight--; }
    });
  }
  const passwordField = { type: 'string', maxLength: 256 };
  const uuidField = { type:'string', pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
  const deviceNameField = { type:'string', minLength:1, maxLength:80 };
  const b64Field=(min,max=min)=>({type:'string',pattern:'^[A-Za-z0-9_-]+$',minLength:min,maxLength:max});
  const objectBody = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const collaborationPasswordWrapper=objectBody({
    v:{const:1},purpose:{const:'collaboration-password'},alg:{const:'A256GCM'},iv:b64Field(16),ciphertext:b64Field(64),
    kdf:objectBody({name:{const:'PBKDF2-SHA256'},iterations:{type:'integer',minimum:600000,maximum:2000000},salt:b64Field(22)})
  });
  const collaborationRewrap=objectBody({identityVersion:{type:'integer',minimum:1},passwordWrapper:collaborationPasswordWrapper});
  function accessOf(request) { return request.cookies[names.access]; }
  registerWebAuthn(app, db, { guard, accessOf, clock, config, writeCookies, cookieNames: names, implementations: webauthn });
  const vaultAccess=registerVaults(app, db, { guard, accessOf, clock, dataDir });
  registerCollaboration(app,db,{guard,accessOf,clock,vaultAccess});
  registerPush(app, db, { guard, accessOf, clock, config, ...push });
  function accountAction(action, { hash = true, passwordChange = false, admin = !passwordChange } = {}) {
    return async (request, reply) => {
      try {
        // Check authorization before spending hash capacity or disclosing account existence.
        const actor = requireUser(db, accessOf(request), clock(), { admin, allowTemporary: passwordChange });
        if (hash && (hashesInFlight >= 2 || limited('account:' + request.ip, 20, 60_000))) return rateError(reply);
        if (passwordChange && limited('password:' + actor.id, 10, 15 * 60_000)) return rateError(reply);
        if (hash) hashesInFlight++;
        try { return await action(request, reply); }
        finally { if (hash) hashesInFlight--; }
      } catch (error) {
        if (error instanceof AccountError) return reply.code(error.status).send({ error: error.code });
        throw error;
      }
    };
  }
  const authorizeAdmin = request => () => requireUser(db, accessOf(request), clock(), { admin: true });
  app.get('/api/auth/devices', accountAction(async request => {
    const actor=requireUser(db,accessOf(request),clock());const current=sessionByAccess(db,accessOf(request));
    const devices=db.prepare(`SELECT id,device_id,device_name,client_kind,created_at,last_seen,revoked,absolute_expires,refresh_expires
      FROM sessions WHERE user_id=? ORDER BY revoked ASC,last_seen DESC`).all(actor.id).map(row=>({
      id:row.id,deviceId:row.device_id,deviceName:row.device_name??'Неизвестное устройство',clientKind:row.client_kind??'browser',
      createdAt:row.created_at,lastSeen:row.last_seen,revoked:Boolean(row.revoked),expiresAt:Math.min(row.absolute_expires,row.refresh_expires),current:row.id===current?.id,
      pushActive:Boolean(db.prepare('SELECT 1 FROM push_subscriptions WHERE session_id=? LIMIT 1').get(row.id))
    }));return{devices};
  },{hash:false,admin:false}));
  app.post('/api/auth/devices/register',{preHandler:guard,schema:{body:objectBody({deviceId:uuidField,deviceName:deviceNameField,clientKind:{type:'string',enum:['pwa','browser']},rename:{type:'boolean'}},['deviceId','deviceName','clientKind'])}},accountAction(async request=>{
    const actor=requireUser(db,accessOf(request),clock());const current=sessionByAccess(db,accessOf(request));if(!current||current.user_id!==actor.id)throw new AccountError('unauthorized',401);
    const deviceName=request.body.rename||!current.device_name?request.body.deviceName.trim():current.device_name;
    db.prepare('UPDATE sessions SET device_id=?,device_name=?,client_kind=?,last_seen=? WHERE id=?').run(request.body.deviceId,deviceName,request.body.clientKind,clock(),current.id);return{ok:true,deviceName};
  },{hash:false,admin:false}));
  app.post('/api/auth/devices/rename',{preHandler:guard,schema:{body:objectBody({id:{type:'string',maxLength:64},deviceName:deviceNameField})}},accountAction(async request=>{
    const actor=requireUser(db,accessOf(request),clock());const row=db.prepare('SELECT user_id FROM sessions WHERE id=?').get(request.body.id);if(!row||row.user_id!==actor.id)throw new AccountError('device_not_found',404);
    db.prepare('UPDATE sessions SET device_name=? WHERE id=?').run(request.body.deviceName.trim(),request.body.id);return{ok:true};
  },{hash:false,admin:false}));
  app.post('/api/auth/devices/revoke',{preHandler:guard,schema:{body:objectBody({id:{type:'string',maxLength:64}})}},accountAction(async request=>{
    const actor=requireUser(db,accessOf(request),clock());const current=sessionByAccess(db,accessOf(request));if(request.body.id===current?.id)throw new AccountError('current_session',409);
    const result=db.prepare('UPDATE sessions SET revoked=1 WHERE id=? AND user_id=?').run(request.body.id,actor.id);if(!result.changes)throw new AccountError('device_not_found',404);return{ok:true};
  },{hash:false,admin:false}));
  app.post('/api/auth/devices/revoke-others',{preHandler:guard,schema:{body:{type:'object',additionalProperties:false}}},accountAction(async request=>{
    const actor=requireUser(db,accessOf(request),clock());const current=sessionByAccess(db,accessOf(request));if(!current)throw new AccountError('unauthorized',401);
    const result=db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=? AND id<>? AND revoked=0').run(actor.id,current.id);return{revoked:result.changes};
  },{hash:false,admin:false}));
  app.get('/api/auth/diagnostics',accountAction(async()=>({disk:diskUsage(dataDir)}),{hash:false}));
  app.get('/api/auth/users', accountAction(async () => ({ users: db.prepare('SELECT * FROM users ORDER BY login').all().map(accountRow) }), { hash: false }));
  app.post('/api/auth/users/create', { preHandler: guard, schema: { body: loginSchema } }, accountAction(async request =>
    ({ user: await createAccount(db, request.body, authorizeAdmin(request), clock) })));
  app.post('/api/auth/users/reset', { preHandler: guard, schema: { body: objectBody({
    id: { type: 'string', maxLength: 64 }, password: passwordField,
    expectedVersion: { type: 'integer', minimum: 0 }, confirmed: { const: true },
  }) } }, accountAction(async request => ({ user: await resetAccount(db, request.body, authorizeAdmin(request), clock) })));
  app.post('/api/auth/change-password', { preHandler: guard, schema: { body: objectBody({
    currentPassword: passwordField, password: passwordField, repeatPassword: passwordField, revokeOthers: { type: 'boolean' },
    collaborationRewrap,
  }, ['currentPassword','password','repeatPassword','revokeOthers']) } }, accountAction(async (request, reply) => {
    const result = await changePassword(db, accessOf(request), request.body, clock);
    writeCookies(reply, result.pair);
    return { user: result.user };
  }, { passwordChange: true }));
  app.post('/api/auth/refresh', { preHandler: guard, schema: { body: { type: 'object', additionalProperties: false } } }, async (request, reply) => {
    const pair = rotateSession(db, request.cookies[names.refresh], clock());
    if (pair.error) {
      if (pair.error !== 'refresh_conflict') clearCookies(reply);
      return reply.code(pair.error === 'refresh_conflict' ? 409 : 401).send({ error: pair.error });
    }
    writeCookies(reply, pair);
    return { ok: true };
  });
  app.post('/api/auth/logout', { preHandler: guard, schema: { body: { type: 'object', additionalProperties: false } } }, async (request, reply) => {
    revokeSession(db, request.cookies[names.access], request.cookies[names.refresh]);
    clearCookies(reply);
    return { ok: true };
  });
}
