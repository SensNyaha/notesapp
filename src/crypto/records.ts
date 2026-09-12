// Record v2: one fresh AES-GCM key per encryption, protected by AES-KW (RFC 3394).
// No long-lived GCM key/nonce counter; phrase wrappers remain v1.
import { encode64, MAX_RECORD_BYTES, additionalData, type Context } from './vault.ts';
export interface Sealed { v: 2; key: string; iv: string; ciphertext: string }
const enc = new TextEncoder();
function bytes(s: string, min: number, max = min): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || s.length > Math.ceil(max * 4 / 3) || !/^[\w-]+$/.test(s)) throw Error('invalid_record');
  const b = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (b.length < min || b.length > max || encode64(b) !== s) throw Error('invalid_record');
  return b;
}
async function kw(root: CryptoKey) {
  if (root.algorithm.name === 'AES-KW' && (root.algorithm as AesKeyAlgorithm).length === 256) return root;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', root));
  try { return await crypto.subtle.importKey('raw', raw, 'AES-KW', false, ['wrapKey', 'unwrapKey']); }
  finally { raw.fill(0); }
}
// Remember only a non-extractable wrapping key. No recovery/re-wrapping of a remembered root is exposed.
export async function rememberKey(root: CryptoKey): Promise<CryptoKey> { return kw(root); }
function aad(context: Context, parent: string | null) {
  additionalData(context, 'record'); // Reuse strict UUID context validation.
  if (parent !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parent)) throw Error('invalid_record');
  return enc.encode(JSON.stringify(['tasks-record', 2, 'A256KW+A256GCM', context.accountId, context.vaultId,
    context.keyId, context.objectId, context.revisionId, parent]));
}
export async function seal(root: CryptoKey, context: Context, parent: string | null, value: unknown): Promise<Sealed> {
  const data = enc.encode(JSON.stringify(value)), binding = aad(context, parent);
  if (data.length > MAX_RECORD_BYTES) throw Error('record_too_large');
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: binding, tagLength: 128 }, key, data);
    return { v: 2, key: encode64(new Uint8Array(await crypto.subtle.wrapKey('raw', key, await kw(root), 'AES-KW'))),
      iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) };
  } finally { data.fill(0); }
}
export async function unseal(root: CryptoKey, context: Context, parent: string | null, value: Sealed): Promise<unknown> {
  if (!value || value.v !== 2 || Object.keys(value).sort().join() !== 'ciphertext,iv,key,v') throw Error('invalid_record');
  const binding = aad(context, parent), wrapped = bytes(value.key, 40), iv = bytes(value.iv, 12), ct = bytes(value.ciphertext, 16, MAX_RECORD_BYTES + 16);
  const key = await crypto.subtle.unwrapKey('raw', wrapped, await kw(root), 'AES-KW', 'AES-GCM', false, ['decrypt']);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: binding, tagLength: 128 }, key, ct));
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } finally { raw.fill(0); }
}
