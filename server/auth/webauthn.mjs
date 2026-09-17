import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions as defaultGenerateRegistrationOptions,
  verifyRegistrationResponse as defaultVerifyRegistrationResponse,
  generateAuthenticationOptions as defaultGenerateAuthenticationOptions,
  verifyAuthenticationResponse as defaultVerifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { AccountError, publicUser, requireUser } from './accounts.mjs';
import { createSession, revokeSession, sessionByAccess } from './sessions.mjs';

export const WEBAUTHN_CHALLENGE_MS = 5 * 60 * 1000;
const credentialPattern = /^[A-Za-z0-9_-]{16,1024}$/;
const nameField = { type: 'string', minLength: 1, maxLength: 80 };
const objectBody = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});

function transports(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.length <= 32).slice(0, 8);
}

function rowToPublic(row) {
  return {
    id: row.id, credentialId: row.credential_id, displayName: row.display_name,
    createdAt: row.created_at, lastUsed: row.last_used, deviceType: row.device_type,
    backedUp: Boolean(row.backed_up), transports: JSON.parse(row.transports),
  };
}
function consumeChallenge(db, id, purpose, now, userId = null, sessionId = null) {
  const clauses = ['id=?', 'purpose=?', 'expires>?'];
  const args = [id, purpose, now];
  if (purpose === 'register') {
    clauses.push('user_id=?', 'session_id=?');
    args.push(userId, sessionId);
  }
  return db.prepare(`DELETE FROM webauthn_challenges WHERE ${clauses.join(' AND ')} RETURNING *`).get(...args);
}

function storeChallenge(db, options, purpose, now, userId = null, sessionId = null) {
  db.prepare('DELETE FROM webauthn_challenges WHERE expires<=?').run(now);
  const id = randomUUID();
  db.prepare(`INSERT INTO webauthn_challenges(id,challenge,purpose,user_id,session_id,expires)
    VALUES(?,?,?,?,?,?)`).run(id, options.challenge, purpose, userId, sessionId, now + WEBAUTHN_CHALLENGE_MS);
  return id;
}

function invalidPasskey(reply, code = 'invalid_passkey', status = 400) {
  return reply.code(status).send({ error: code });
}

export function registerWebAuthn(app, db, context) {
  const { guard, accessOf, clock, config, writeCookies } = context;
  const rpId = config.rpId ?? new URL(config.origin).hostname;
  const impl = {
    generateRegistrationOptions: defaultGenerateRegistrationOptions,
    verifyRegistrationResponse: defaultVerifyRegistrationResponse,
    generateAuthenticationOptions: defaultGenerateAuthenticationOptions,
    verifyAuthenticationResponse: defaultVerifyAuthenticationResponse,
    ...context.implementations,
  };
  app.get('/api/auth/passkeys', async (request, reply) => {
    try {
      const user = requireUser(db, accessOf(request), clock());
      const rows = db.prepare(`SELECT * FROM webauthn_credentials WHERE user_id=? ORDER BY created_at DESC`).all(user.id);
      return { passkeys: rows.map(rowToPublic) };
    } catch (error) {
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });

  app.post('/api/auth/passkeys/register/options', {
    preHandler: guard, schema: { body: objectBody({}) },
  }, async (request, reply) => {
    try {
      const user = requireUser(db, accessOf(request), clock());
      const session = sessionByAccess(db, accessOf(request));
      if (!session || session.user_id !== user.id) throw new AccountError('unauthorized', 401);
      const existing = db.prepare('SELECT credential_id,transports FROM webauthn_credentials WHERE user_id=?').all(user.id);
      const options = await impl.generateRegistrationOptions({
        rpName: 'Tasks', rpID: rpId, userName: user.login,
        userID: new TextEncoder().encode(user.id), userDisplayName: user.login,
        attestationType: 'none', timeout: 120_000,
        excludeCredentials: existing.map(row => ({ id: row.credential_id, transports: JSON.parse(row.transports) })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: {} },
      });
      return { challengeId: storeChallenge(db, options, 'register', clock(), user.id, session.id), options };
    } catch (error) {
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post('/api/auth/passkeys/register/finish', {
    preHandler: guard, bodyLimit: 32768,
    schema: { body: objectBody({
      challengeId: { type: 'string', minLength: 1, maxLength: 64 },
      displayName: nameField, response: { type: 'object' },
    }) },
  }, async (request, reply) => {
    try {
      const user = requireUser(db, accessOf(request), clock());
      const session = sessionByAccess(db, accessOf(request));
      if (!session || session.user_id !== user.id) throw new AccountError('unauthorized', 401);
      const challenge = consumeChallenge(db, request.body.challengeId, 'register', clock(), user.id, session.id);
      if (!challenge) return invalidPasskey(reply, 'invalid_challenge', 403);
      const verification = await impl.verifyRegistrationResponse({
        response: request.body.response, expectedChallenge: challenge.challenge,
        expectedOrigin: config.origin, expectedRPID: rpId, requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo?.userVerified) return invalidPasskey(reply);
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
      if (!credentialPattern.test(credential.id)) return invalidPasskey(reply);
      const now = clock(), id = randomUUID(), passkeyTransports = transports(request.body.response?.response?.transports);
      try {
        db.prepare(`INSERT INTO webauthn_credentials
          (id,user_id,credential_id,public_key,counter,transports,device_type,backed_up,display_name,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, credential.id, Buffer.from(credential.publicKey), credential.counter,
            JSON.stringify(passkeyTransports), credentialDeviceType, credentialBackedUp ? 1 : 0,
            request.body.displayName.trim(), now);
      } catch (error) {
        if (String(error?.message ?? '').includes('UNIQUE')) return invalidPasskey(reply, 'credential_exists', 409);
        throw error;
      }
      return { passkey: rowToPublic(db.prepare('SELECT * FROM webauthn_credentials WHERE id=?').get(id)) };
    } catch (error) {
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.code });
      return invalidPasskey(reply);
    }
  });
  app.post('/api/auth/passkeys/delete', {
    preHandler: guard, schema: { body: objectBody({ id: { type: 'string', minLength: 1, maxLength: 64 } }) },
  }, async (request, reply) => {
    try {
      const user = requireUser(db, accessOf(request), clock());
      const result = db.prepare('DELETE FROM webauthn_credentials WHERE id=? AND user_id=?').run(request.body.id, user.id);
      if (!result.changes) throw new AccountError('passkey_not_found', 404);
      return { ok: true };
    } catch (error) {
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });

  app.post('/api/auth/passkeys/login/options', {
    preHandler: guard, schema: { body: objectBody({}) },
  }, async (_request, reply) => {
    try {
      const options = await impl.generateAuthenticationOptions({
        rpID: rpId, timeout: 120_000, userVerification: 'required',
      });
      return { challengeId: storeChallenge(db, options, 'authenticate', clock()), options };
    } catch {
      return invalidPasskey(reply, 'passkey_unavailable', 400);
    }
  });

  app.post('/api/auth/passkeys/login/finish', {
    preHandler: guard, bodyLimit: 16384,
    schema: { body: objectBody({
      challengeId: { type: 'string', minLength: 1, maxLength: 64 }, response: { type: 'object' },
    }) },
  }, async (request, reply) => {
    const challenge = consumeChallenge(db, request.body.challengeId, 'authenticate', clock());
    if (!challenge) return invalidPasskey(reply, 'invalid_credentials', 401);
    const credentialId = request.body.response?.id;
    if (typeof credentialId !== 'string' || !credentialPattern.test(credentialId)) return invalidPasskey(reply, 'invalid_credentials', 401);
    const row = db.prepare(`SELECT c.*,u.login,u.role,u.must_change_password,u.temporary_expires
      FROM webauthn_credentials c JOIN users u ON u.id=c.user_id WHERE c.credential_id=?`).get(credentialId);
    if (!row) return invalidPasskey(reply, 'invalid_credentials', 401);
    const now = clock();
    if (row.must_change_password && !(row.temporary_expires > now)) return invalidPasskey(reply, 'temporary_expired', 401);
    try {
      const verification = await impl.verifyAuthenticationResponse({
        response: request.body.response, expectedChallenge: challenge.challenge,
        expectedOrigin: config.origin, expectedRPID: rpId, requireUserVerification: true,
        credential: {
          id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter,
          transports: JSON.parse(row.transports),
        },
      });
      if (!verification.verified || !verification.authenticationInfo.userVerified) {
        return invalidPasskey(reply, 'invalid_credentials', 401);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT * FROM webauthn_credentials WHERE id=? AND user_id=?').get(row.id, row.user_id);
        if (!current || current.counter !== row.counter) {
          db.exec('ROLLBACK'); return invalidPasskey(reply, 'invalid_credentials', 401);
        }
        db.prepare('UPDATE webauthn_credentials SET counter=?,backed_up=?,last_used=? WHERE id=?')
          .run(verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp ? 1 : 0, now, row.id);
        revokeSession(db, request.cookies[context.cookieNames.access], request.cookies[context.cookieNames.refresh]);
        const pair = createSession(db, row.user_id, now);
        db.exec('COMMIT'); writeCookies(reply, pair);
        return { user: publicUser(row) };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch {
      return invalidPasskey(reply, 'invalid_credentials', 401);
    }
  });
}
