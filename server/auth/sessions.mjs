import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';

export const ACCESS_MS = 15 * 60 * 1000;
export const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const RETRY_MS = 10_000;
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const validToken = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const successor = (old, nonce, kind) => createHmac('sha256', old).update(`tasks:${kind}:${nonce}`).digest('base64url');
const alive = (s, now) => s && !s.revoked && s.absolute_expires > now && s.refresh_expires > now;

export function createSession(db, userId, now) {
  // Tokens from expired families are no longer useful for reuse detection.
  db.prepare('DELETE FROM sessions WHERE absolute_expires <= ? OR refresh_expires <= ?').run(now, now);
  const access = token();
  const refresh = token();
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions
    (id, user_id, access_hash, access_expires, refresh_hash, refresh_expires, absolute_expires)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, digest(access), now + ACCESS_MS, digest(refresh), now + REFRESH_MS, now + ABSOLUTE_MS);
  return { access, refresh, accessExpires: now + ACCESS_MS, refreshExpires: now + REFRESH_MS };
}

export function currentUser(db, access, now) {
  if (!validToken(access)) return null;
  return db.prepare(`SELECT u.id, u.login, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.access_hash = ? AND s.revoked = 0 AND s.access_expires > ? AND s.absolute_expires > ? AND s.refresh_expires > ?`)
    .get(digest(access), now, now, now) ?? null;
}

export function rotateSession(db, refresh, now) {
  if (!validToken(refresh)) return { error: 'unauthorized' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const hash = digest(refresh);
    let s = db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(hash);
    let result;
    if (alive(s, now)) {
      const nonce = token();
      const access = successor(refresh, nonce, 'access');
      const next = successor(refresh, nonce, 'refresh');
      const accessExpires = Math.min(now + ACCESS_MS, s.absolute_expires);
      const refreshExpires = Math.min(now + REFRESH_MS, s.absolute_expires);
      db.prepare('INSERT INTO used_refresh_tokens (token_hash, session_id, used_at, nonce) VALUES (?, ?, ?, ?)')
        .run(hash, s.id, now, nonce);
      db.prepare('UPDATE sessions SET access_hash = ?, access_expires = ?, refresh_hash = ?, refresh_expires = ? WHERE id = ?')
        .run(digest(access), accessExpires, digest(next), refreshExpires, s.id);
      result = { access, refresh: next, accessExpires, refreshExpires };
    } else {
      const used = db.prepare('SELECT * FROM used_refresh_tokens WHERE token_hash = ?').get(hash);
      s = used && db.prepare('SELECT * FROM sessions WHERE id = ?').get(used.session_id);
      if (used && alive(s, now) && now - used.used_at <= RETRY_MS) {
        const next = successor(refresh, used.nonce, 'refresh');
        // Bounded idempotency for a lost response or simultaneous tabs. Never advance twice.
        result = digest(next) === s.refresh_hash
          ? { access: successor(refresh, used.nonce, 'access'), refresh: next,
            accessExpires: s.access_expires, refreshExpires: s.refresh_expires }
          : { error: 'refresh_conflict' };
      } else {
        if (s) db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(s.id);
        result = { error: 'unauthorized' };
      }
    }
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function revokeSession(db, access, refresh) {
  if (validToken(access)) db.prepare('UPDATE sessions SET revoked = 1 WHERE access_hash = ?').run(digest(access));
  if (validToken(refresh)) {
    const hash = digest(refresh);
    db.prepare(`UPDATE sessions SET revoked = 1 WHERE refresh_hash = ? OR id IN
      (SELECT session_id FROM used_refresh_tokens WHERE token_hash = ?)`).run(hash, hash);
  }
}
