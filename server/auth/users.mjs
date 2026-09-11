import { randomUUID } from 'node:crypto';
import { hashPassword, normalizeLogin, validPassword } from './password.mjs';

export function needsSetup(db) {
  return db.prepare('SELECT setup_complete FROM auth_state WHERE id = 1').get().setup_complete === 0
    && !db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

export function insertFirstAdmin(db, login, passwordHash, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!needsSetup(db)) { db.exec('ROLLBACK'); return null; }
    const id = randomUUID();
    db.prepare("INSERT INTO users (id, login, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
      .run(id, login, passwordHash, now);
    db.prepare('UPDATE auth_state SET setup_complete = 1 WHERE id = 1').run();
    db.exec('COMMIT');
    return { id, login, role: 'admin' };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function bootstrapFromEnvironment(db, { login, password } = {}, now = Date.now()) {
  if (!needsSetup(db)) return;
  // Compose supplies empty defaults when neither setting is configured.
  if ((login === undefined || login === '') && (password === undefined || password === '')) return;
  const normalized = normalizeLogin(login);
  if (!normalized || !validPassword(password)) {
    throw new Error('Invalid bootstrap configuration: provide both a valid BOOTSTRAP_ADMIN_LOGIN and BOOTSTRAP_ADMIN_PASSWORD');
  }
  insertFirstAdmin(db, normalized, await hashPassword(password), now);
}
