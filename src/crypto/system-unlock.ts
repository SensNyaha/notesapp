import { encode64 } from './vault.ts';

const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const credential = /^[A-Za-z0-9_-]{16,1024}$/;
export const AUTO_LOCK_VALUES = [0, 60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;
export type AutoLockMs = typeof AUTO_LOCK_VALUES[number];
export interface SystemUnlockContext { accountId: string; vaultId: string; keyId: string }
export interface VaultSystemUnlock {
  v: 1; purpose: 'webauthn-prf'; alg: 'A256GCM'; vaultId: string; keyId: string;
  credentialId: string; prfSalt: string; iv: string; ciphertext: string;
  lockEpoch: number; autoLockMs: AutoLockMs;
}

function fail(): never { throw Error('invalid_system_unlock'); }
function decode(value: unknown, bytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(bytes * 4 / 3)) fail();
  let text: string;
  try { text = atob(value.replace(/-/g, '+').replace(/_/g, '/')); } catch { return fail(); }
  const result = Uint8Array.from(text, c => c.charCodeAt(0));
  if (result.length !== bytes || encode64(result) !== value) fail();
  return result;
}

function validContext(context: SystemUnlockContext) {
  if (!uuid.test(context.accountId) || !uuid.test(context.vaultId) || !uuid.test(context.keyId)) fail();
}
function inspect(value: unknown, context: SystemUnlockContext): VaultSystemUnlock {
  validContext(context);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  const fields = ['v','purpose','alg','vaultId','keyId','credentialId','prfSalt','iv','ciphertext','lockEpoch','autoLockMs'];
  if (Object.keys(row).sort().join() !== fields.sort().join()) fail();
  if (row.v !== 1 || row.purpose !== 'webauthn-prf' || row.alg !== 'A256GCM') fail();
  if (row.vaultId !== context.vaultId || row.keyId !== context.keyId) fail();
  if (typeof row.credentialId !== 'string' || !credential.test(row.credentialId)) fail();
  if (!Number.isSafeInteger(row.lockEpoch) || (row.lockEpoch as number) < 0) fail();
  if (!AUTO_LOCK_VALUES.includes(row.autoLockMs as AutoLockMs)) fail();
  decode(row.prfSalt, 32); decode(row.iv, 12); decode(row.ciphertext, 48);
  return value as VaultSystemUnlock;
}

function aad(context: SystemUnlockContext, wrapper: Pick<VaultSystemUnlock,'credentialId'|'prfSalt'|'lockEpoch'|'autoLockMs'>) {
  validContext(context);
  return encoder.encode(JSON.stringify(['tasks-vault-system-unlock',1,'webauthn-prf','A256GCM',
    context.accountId,context.vaultId,context.keyId,wrapper.credentialId,wrapper.prfSalt,wrapper.lockEpoch,wrapper.autoLockMs]));
}

async function prfKey(output: BufferSource) {
  const bytes = output instanceof ArrayBuffer ? new Uint8Array(output) : new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  if (bytes.byteLength !== 32) fail();
  const copy = Uint8Array.from(bytes);
  try { return await crypto.subtle.importKey('raw', copy, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']); }
  finally { copy.fill(0); }
}
export function generatePrfSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return encode64(salt);
}
export function prfSaltBytes(value: string): Uint8Array<ArrayBuffer> { return decode(value, 32); }

export async function createSystemUnlockWrapper(root: CryptoKey, context: SystemUnlockContext,
  credentialId: string, prfSalt: string, output: BufferSource, lockEpoch: number, autoLockMs: AutoLockMs): Promise<VaultSystemUnlock> {
  validContext(context);
  if (!credential.test(credentialId) || !Number.isSafeInteger(lockEpoch) || lockEpoch < 0 || !AUTO_LOCK_VALUES.includes(autoLockMs)) fail();
  decode(prfSalt, 32);
  if (!root.extractable || root.algorithm.name !== 'AES-GCM' || (root.algorithm as AesKeyAlgorithm).length !== 256) fail();
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', root));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = { credentialId, prfSalt, lockEpoch, autoLockMs };
  try {
    const ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:aad(context,base), tagLength:128 }, await prfKey(output), raw);
    return { v:1, purpose:'webauthn-prf', alg:'A256GCM', vaultId:context.vaultId, keyId:context.keyId,
      ...base, iv:encode64(iv), ciphertext:encode64(new Uint8Array(ciphertext)) };
  } finally { raw.fill(0); }
}

export async function updateSystemUnlockAutoLock(context:SystemUnlockContext,value:unknown,output:BufferSource,
  expectedEpoch:number,autoLockMs:AutoLockMs):Promise<VaultSystemUnlock>{
  const wrapper=inspect(value,context);if(wrapper.lockEpoch!==expectedEpoch||!AUTO_LOCK_VALUES.includes(autoLockMs))fail();
  let raw:Uint8Array<ArrayBuffer>;
  try{raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(wrapper.iv,12),additionalData:aad(context,wrapper),tagLength:128},
    await prfKey(output),decode(wrapper.ciphertext,48)));}catch{throw Error('system_unlock_failed');}
  if(raw.byteLength!==32){raw.fill(0);fail();}
  const next={...wrapper,autoLockMs,iv:encode64(crypto.getRandomValues(new Uint8Array(12)))};
  try{const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:decode(next.iv,12),additionalData:aad(context,next),tagLength:128},await prfKey(output),raw);
    return{...next,ciphertext:encode64(new Uint8Array(encrypted))};}
  finally{raw.fill(0);}
}

export async function unlockSystemWrapper(context: SystemUnlockContext, value: unknown,
  output: BufferSource, expectedEpoch: number): Promise<CryptoKey> {
  const wrapper = inspect(value, context);
  if (wrapper.lockEpoch !== expectedEpoch) fail();
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv:decode(wrapper.iv,12),
      additionalData:aad(context,wrapper), tagLength:128 }, await prfKey(output), decode(wrapper.ciphertext,48)));
  } catch { throw Error('system_unlock_failed'); }
  if (raw.byteLength !== 32) { raw.fill(0); fail(); }
  try { return await crypto.subtle.importKey('raw', raw, { name:'AES-KW', length:256 }, false, ['wrapKey','unwrapKey']); }
  finally { raw.fill(0); }
}
