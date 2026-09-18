import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, normalizeLogin, validPassword } from './password.mjs';
import { createSession, currentUser, digest } from './sessions.mjs';

export const TEMPORARY_MS = 48 * 60 * 60 * 1000;
export class AccountError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const fail = (code, status) => { throw new AccountError(code, status); };
export const publicUser = row => ({ id: row.id, login: row.login, role: row.role,
  mustChangePassword: Boolean(row.must_change_password), temporaryExpires: row.temporary_expires });
export const accountRow = row => ({ ...publicUser(row), createdAt: row.created_at, credentialVersion: row.credential_version });
export function requireUser(db, access, now, { admin = false, allowTemporary = false } = {}) {
  const user = currentUser(db, access, now);
  if (!user) fail('unauthorized', 401);
  if (user.mustChangePassword && !allowTemporary) fail('password_change_required', 403);
  if (admin && user.role !== 'admin') fail('admin_required', 403);
  return user;
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function ready(db) {
  if (!db.prepare('SELECT setup_complete FROM auth_state WHERE id=1').get()?.setup_complete
    || !db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) fail('setup_required', 409);
}
// authorize() is checked again inside the transaction, after asynchronous hashing.
// CLI callers possess server access; HTTP callers supply a live admin-session check.
export async function createAccount(db, { login, password }, authorize = () => {}, clock = Date.now) {
  authorize(); ready(db);
  const normalized = normalizeLogin(login);
  if (!normalized || !validPassword(password)) fail('invalid_credentials');
  if (db.prepare('SELECT 1 FROM users WHERE login=?').get(normalized)) fail('login_exists', 409);
  const hash = await hashPassword(password);
  return transaction(db, () => {
    authorize(); ready(db);
    if (db.prepare('SELECT 1 FROM users WHERE login=?').get(normalized)) fail('login_exists', 409);
    const now = clock(), id = randomUUID();
    db.prepare(`INSERT INTO users (id,login,password_hash,role,created_at,must_change_password,temporary_expires)
      VALUES (?,?,?,'user',?,1,?)`).run(id, normalized, hash, now, now + TEMPORARY_MS);
    return accountRow(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  });
}
export async function resetAccount(db, { id, password, expectedVersion, role = 'user' }, authorize = () => {}, clock = Date.now) {
  authorize(); ready(db);
  if (!validPassword(password)) fail('invalid_credentials');
  const previous = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!previous || previous.role !== role) fail('account_not_found', 404);
  if (previous.credential_version !== expectedVersion) fail('account_changed', 409);
  const hash = await hashPassword(password);
  return transaction(db, () => {
    authorize(); ready(db);
    const now = clock();
    const result = db.prepare(`UPDATE users SET password_hash=?,must_change_password=1,temporary_expires=?,
      credential_version=credential_version+1 WHERE id=? AND role=? AND credential_version=?`)
      .run(hash, now + TEMPORARY_MS, id, role, expectedVersion);
    if (!result.changes) fail('account_changed', 409);
    db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=?').run(id);
    // Admin reset intentionally leaves the E2EE collaboration identity untouched. The administrator
    // cannot rewrap it because the collaboration root is unavailable server-side. A trusted device
    // may later unlock the same identity via local PRF and rewrap it to the new password; otherwise
    // the user must explicitly replace the collaboration identity and request regrant from vault owners.
    return accountRow(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  });
}
export async function changePassword(db, access, { currentPassword, password, repeatPassword, revokeOthers, collaborationRewrap }, clock = Date.now) {
  const user = requireUser(db, access, clock(), { allowTemporary: true });
  const previous = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  if (!validPassword(password) || password !== repeatPassword) fail('invalid_new_password');
  if (!await verifyPassword(previous.password_hash, currentPassword)) fail('wrong_password');
  if (password === currentPassword) fail('same_password');
  const identity = db.prepare('SELECT version FROM collaboration_identities WHERE user_id=?').get(user.id);
  if (identity && !user.mustChangePassword && (!collaborationRewrap || collaborationRewrap.identityVersion !== identity.version)) fail('collaboration_rewrap_required', 409);
  if (identity && collaborationRewrap && collaborationRewrap.identityVersion !== identity.version) fail('identity_changed', 409);
  if (!identity && collaborationRewrap) fail('identity_changed', 409);
  const hash = await hashPassword(password);
  return transaction(db, () => {
    const now = clock();
    requireUser(db, access, now, { allowTemporary: true });
    const result = db.prepare(`UPDATE users SET password_hash=?,must_change_password=0,temporary_expires=NULL,
      credential_version=credential_version+1 WHERE id=? AND credential_version=?`)
      .run(hash, user.id, previous.credential_version);
    if (!result.changes) fail('account_changed', 409);
    if (identity && collaborationRewrap) {
      const rewrapped = db.prepare('UPDATE collaboration_identities SET password_wrapper=?,updated_at=? WHERE user_id=? AND version=?')
        .run(JSON.stringify(collaborationRewrap.passwordWrapper), now, user.id, identity.version);
      if (!rewrapped.changes) fail('identity_changed', 409);
    }
    if (user.mustChangePassword || revokeOthers) db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=?').run(user.id);
    else db.prepare('UPDATE sessions SET revoked=1 WHERE access_hash=?').run(digest(access));
    const pair = createSession(db, user.id, now);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)), pair };
  });
}
