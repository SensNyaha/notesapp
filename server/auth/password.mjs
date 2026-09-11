import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

export const PASSWORD_OPTIONS = Object.freeze({ type: argon2.argon2id, version: 0x13,
  memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 });

export function normalizeLogin(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._-]{2,31}$/.test(value)) return null;
  return value.toLowerCase();
}

export function validPassword(value) {
  return typeof value === 'string' && value.length <= 256 && [...value].length >= 6
    && [...value].length <= 128 && /[0-9]/.test(value) && /\p{Lu}/u.test(value) && /\p{Ll}/u.test(value);
}

export function hashPassword(value) {
  if (!validPassword(value)) throw new Error('Password policy not satisfied');
  return argon2.hash(value, { ...PASSWORD_OPTIONS, salt: randomBytes(16) });
}

export async function verifyPassword(hash, value) {
  if (typeof value !== 'string' || value.length > 256 || typeof hash !== 'string') return false;
  try { return await argon2.verify(hash, value); } catch { return false; }
}
