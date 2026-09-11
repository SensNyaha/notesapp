// Format v1. Persistence, multi-device usage accounting and vault UX belong to later stages.
export const MAX_RECORD_BYTES = 1024 * 1024;
export const PBKDF2_ITERATIONS = 600_000;
export const MAX_ENCRYPTIONS = 2 ** 20;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class VaultCryptoError extends Error {
  constructor(message: 'invalid_format' | 'authentication_failed' | 'usage_limit' | 'unavailable') { super(message); }
}
function invalid(): never { throw new VaultCryptoError('invalid_format'); }
function subtle() { if (!globalThis.crypto?.subtle) throw new VaultCryptoError('unavailable'); return crypto.subtle; }
function random(length: number) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return bytes; }

export interface Context { accountId: string; vaultId: string; keyId: string; objectId: string; revisionId: string }
export interface Envelope { v: 1; alg: 'A256GCM'; iv: string; ciphertext: string }
export interface WrappedKey extends Envelope {
  purpose: 'phrase' | 'recovery';
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string } | null;
}
// The caller must reserve durably across devices before encryption of real records.
// This in-memory implementation is for diagnostics/tests, never a global lifetime guarantee.
export interface EncryptionBudget { reserve(keyId: string): Promise<void> }
export class MemoryEncryptionBudget implements EncryptionBudget {
  private counts = new Map<string, number>();
  constructor(initial: ReadonlyArray<readonly [string, number]> = []) {
    for (const [id, count] of initial) {
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ENCRYPTIONS || this.counts.has(id)) invalid();
      this.counts.set(id, count);
    }
  }
  async reserve(keyId: string) {
    const count = this.counts.get(keyId) ?? 0;
    if (count >= MAX_ENCRYPTIONS) throw new VaultCryptoError('usage_limit');
    this.counts.set(keyId, count + 1);
  }
}
export function encode64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode64(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  let text: string;
  try { text = atob(value.replace(/-/g, '+').replace(/_/g, '/')); } catch { return invalid(); }
  const result = Uint8Array.from(text, c => c.charCodeAt(0));
  if (result.length < min || result.length > max || encode64(result) !== value) invalid();
  return result;
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))) invalid();
  return row;
}
function contextValues(context: Context): string[] {
  const row = object(context, ['accountId', 'vaultId', 'keyId', 'objectId', 'revisionId']);
  return ['accountId', 'vaultId', 'keyId', 'objectId', 'revisionId'].map(field => {
    const value = row[field]; if (typeof value !== 'string' || !uuid.test(value)) invalid(); return value;
  });
}
export function additionalData(context: Context, purpose: 'record' | 'phrase' | 'recovery', kdf: WrappedKey['kdf'] = null) {
  if (!['record', 'phrase', 'recovery'].includes(purpose)) invalid();
  // Key wrappers use objectId=keyId; revisionId identifies the wrapper version.
  if (purpose !== 'record' && context.objectId !== context.keyId) invalid();
  return encoder.encode(JSON.stringify(['tasks', 1, 'A256GCM', purpose, ...contextValues(context),
    kdf ? [kdf.name, kdf.iterations, kdf.salt] : null]));
}
function validKey(key: CryptoKey) {
  if (!key || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256) invalid();
}
export async function generateVaultKey(): Promise<CryptoKey> {
  // Extractability is required for re-wrapping after phrase changes; never persist/export plaintext.
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
export function generateRecoveryCode(): string { subtle(); return 'tasks-recovery-v1.' + encode64(random(32)); }
function recoveryBytes(code: string) {
  if (typeof code !== 'string' || !code.startsWith('tasks-recovery-v1.')) invalid();
  return decode64(code.slice('tasks-recovery-v1.'.length), 32, 32);
}
async function recoveryKey(code: string) {
  const raw = recoveryBytes(code);
  try { return await subtle().importKey('raw', raw, 'AES-GCM', false, ['wrapKey', 'unwrapKey']); }
  finally { raw.fill(0); }
}
async function phraseKey(phrase: string, kdf: NonNullable<WrappedKey['kdf']>) {
  // Product phrase policy is deferred. This is only a bounded, lossless UTF-8 input contract.
  if (typeof phrase !== 'string' || !phrase.length || phrase.length > 4096 || /[\uD800-\uDFFF]/u.test(phrase)) invalid();
  const bytes = encoder.encode(phrase);
  if (bytes.length > 4096) invalid();
  try {
    const material = await subtle().importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations,
      salt: decode64(kdf.salt, 16, 16) }, material, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  } finally { bytes.fill(0); }
}
function inspect(value: unknown, wrapped: boolean) {
  const row = object(value, wrapped ? ['v', 'alg', 'iv', 'ciphertext', 'purpose', 'kdf'] : ['v', 'alg', 'iv', 'ciphertext']);
  if (row.v !== 1 || row.alg !== 'A256GCM') invalid();
  const iv = decode64(row.iv, 12, 12);
  const ciphertext = decode64(row.ciphertext, wrapped ? 48 : 16, wrapped ? 48 : MAX_RECORD_BYTES + 16);
  if (wrapped) {
    if (row.purpose === 'phrase') {
      const kdf = object(row.kdf, ['name', 'iterations', 'salt']);
      if (kdf.name !== 'PBKDF2-SHA256' || !Number.isSafeInteger(kdf.iterations)
        || (kdf.iterations as number) < PBKDF2_ITERATIONS || (kdf.iterations as number) > 2_000_000) invalid();
      decode64(kdf.salt, 16, 16);
    } else if (row.purpose !== 'recovery' || row.kdf !== null) invalid();
  }
  return { iv, ciphertext };
}
export async function encryptRecord(key: CryptoKey, context: Context, plaintext: Uint8Array, budget: EncryptionBudget): Promise<Envelope> {
  validKey(key);
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_RECORD_BYTES) invalid();
  const aad = additionalData(context, 'record');
  const keyId = context.keyId;
  const bytes = Uint8Array.from(plaintext); // Snapshot caller data before the first await.
  try {
    await budget.reserve(keyId); // Failed attempts also consume budget; reservation must not be rolled back.
    const iv = random(12);
    const encrypted = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, bytes);
    return { v: 1, alg: 'A256GCM', iv: encode64(iv), ciphertext: encode64(new Uint8Array(encrypted)) };
  } finally { bytes.fill(0); }
}
export async function decryptRecord(key: CryptoKey, context: Context, envelope: unknown): Promise<Uint8Array<ArrayBuffer>> {
  validKey(key);
  const { iv, ciphertext } = inspect(envelope, false), aad = additionalData(context, 'record');
  try { return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext)); }
  catch { throw new VaultCryptoError('authentication_failed'); }
}
async function wrap(key: CryptoKey, wrappingKey: CryptoKey, aad: Uint8Array<ArrayBuffer>, purpose: WrappedKey['purpose'], kdf: WrappedKey['kdf']): Promise<WrappedKey> {
  validKey(key); if (!key.extractable) invalid();
  const iv = random(12);
  const encrypted = await subtle().wrapKey('raw', key, wrappingKey, { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 });
  return { v: 1, alg: 'A256GCM', iv: encode64(iv), ciphertext: encode64(new Uint8Array(encrypted)), purpose, kdf };
}
async function unwrap(wrappingKey: CryptoKey, aad: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  try { return await subtle().unwrapKey('raw', ciphertext, wrappingKey, { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
  catch { throw new VaultCryptoError('authentication_failed'); }
}
export async function wrapWithPhrase(key: CryptoKey, context: Context, phrase: string): Promise<WrappedKey> {
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: PBKDF2_ITERATIONS, salt: encode64(random(16)) };
  const aad = additionalData(context, 'phrase', kdf);
  // A fresh random salt derives a fresh wrapping key for every operation.
  return wrap(key, await phraseKey(phrase, kdf), aad, 'phrase', kdf);
}
export async function unwrapWithPhrase(context: Context, phrase: string, envelope: unknown): Promise<CryptoKey> {
  const { iv, ciphertext } = inspect(envelope, true);
  const row = envelope as WrappedKey;
  if (row.purpose !== 'phrase' || !row.kdf) invalid();
  const kdf = { ...row.kdf }, aad = additionalData(context, 'phrase', kdf);
  return unwrap(await phraseKey(phrase, kdf), aad, iv, ciphertext);
}
export async function wrapWithRecovery(key: CryptoKey, context: Context, code: string, budget: EncryptionBudget): Promise<WrappedKey> {
  const aad = additionalData(context, 'recovery');
  const wrappingKey = await recoveryKey(code);
  // A fingerprint counts reuse of the same recovery key even across vaults. It is not persisted by this module.
  const raw = recoveryBytes(code);
  let fingerprint: string;
  try { fingerprint = encode64(new Uint8Array(await subtle().digest('SHA-256', raw))); }
  finally { raw.fill(0); }
  await budget.reserve('recovery:' + fingerprint);
  return wrap(key, wrappingKey, aad, 'recovery', null);
}
export async function unwrapWithRecovery(context: Context, code: string, envelope: unknown): Promise<CryptoKey> {
  const { iv, ciphertext } = inspect(envelope, true);
  if ((envelope as WrappedKey).purpose !== 'recovery') invalid();
  const aad = additionalData(context, 'recovery');
  return unwrap(await recoveryKey(code), aad, iv, ciphertext);
}
// Canonical wire representation rejects duplicate fields, extra fields and oversized inputs.
export function serializeEnvelope(envelope: Envelope | WrappedKey): string {
  const wrapped = Object.hasOwn(envelope, 'purpose'); inspect(envelope, wrapped);
  const base: Envelope = { v: 1, alg: 'A256GCM', iv: envelope.iv, ciphertext: envelope.ciphertext };
  if (!wrapped) return JSON.stringify(base);
  const row = envelope as WrappedKey;
  return JSON.stringify({ ...base, purpose: row.purpose, kdf: row.kdf ? { name: row.kdf.name, iterations: row.kdf.iterations, salt: row.kdf.salt } : null });
}
export function parseEnvelope(text: string): Envelope | WrappedKey {
  if (typeof text !== 'string' || text.length > Math.ceil((MAX_RECORD_BYTES + 16) * 4 / 3) + 512) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  if (!parsed || typeof parsed !== 'object') invalid();
  const envelope = parsed as Envelope | WrappedKey;
  if (serializeEnvelope(envelope) !== text) invalid();
  return envelope;
}
