import { browserSupportsWebAuthn, base64URLStringToBuffer } from '@simplewebauthn/browser';
import { prfSaltBytes } from './crypto/system-unlock.ts';

interface PrfOutputs { prf?: { enabled?: boolean; results?: { first?: BufferSource; second?: BufferSource } } }
interface PrfCredential { credentialId:string; transports?:string[] }
export interface PrfEvaluation { credentialId: string; output: Uint8Array<ArrayBuffer> }

function challenge() { return crypto.getRandomValues(new Uint8Array(32)); }
export function webAuthnPrfPossible() { return browserSupportsWebAuthn() && Boolean(navigator.credentials?.get); }

export async function evaluateVaultPrf(passkeys: PrfCredential[], salt: string): Promise<PrfEvaluation> {
  if (!webAuthnPrfPossible() || !passkeys.length) throw Error('webauthn_unavailable');
  const allowCredentials = passkeys.map(item => ({
    type: 'public-key' as const,
    id: base64URLStringToBuffer(item.credentialId),
    ...(item.transports?.length ? { transports: item.transports as AuthenticatorTransport[] } : {}),
  }));
  const extensions = { prf: { eval: { first: prfSaltBytes(salt) } } };
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: challenge(), allowCredentials, userVerification: 'required', timeout: 120_000,
    extensions: extensions as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!credential) throw Error('webauthn_cancelled');
  const result = credential.getClientExtensionResults() as PrfOutputs;
  const first = result.prf?.results?.first;
  if (!first) throw Error('prf_unavailable');
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  if (bytes.byteLength !== 32) throw Error('prf_unavailable');
  return { credentialId: credential.id, output: Uint8Array.from(bytes) };
}
