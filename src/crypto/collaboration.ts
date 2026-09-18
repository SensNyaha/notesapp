import { encode64, PBKDF2_ITERATIONS, type Context } from './vault.ts';
import { seal, unseal, rememberKey, type Sealed } from './records.ts';
import { prfSaltBytes } from './system-unlock.ts';

const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const credential=/^[A-Za-z0-9_-]{16,1024}$/;
export interface CollaborationPublicKey{kty:'EC';crv:'P-256';x:string;y:string}
export interface CollaborationPrivateBox{v:1;purpose:'collaboration-private-key';alg:'A256GCM';iv:string;ciphertext:string}
export interface CollaborationPasswordWrapper{v:1;purpose:'collaboration-password';alg:'A256GCM';iv:string;ciphertext:string;
  kdf:{name:'PBKDF2-SHA256';iterations:number;salt:string}}
export interface CollaborationIdentity{version:number;publicKey:CollaborationPublicKey;privateBox:CollaborationPrivateBox;
  passwordWrapper:CollaborationPasswordWrapper;createdAt?:number;updatedAt?:number}
export interface CollaborationPrfWrapper{v:1;purpose:'collaboration-prf';alg:'A256GCM';identityVersion:number;
  credentialId:string;prfSalt:string;iv:string;ciphertext:string}
export interface VaultKeyring{version:number;currentEpoch:number;keys:{epoch:number;key:string}[]}
export interface VaultMemberEnvelope{v:1;purpose:'vault-keyring-member';alg:'ECDH-P256+HKDF-SHA256+A256GCM';
  ephemeralPublicKey:CollaborationPublicKey;salt:string;iv:string;ciphertext:string;recipientFingerprint:string}
export interface PersonalReminderBox{v:1;purpose:'personal-reminder';alg:'A256GCM';iv:string;ciphertext:string}
export interface CollaborationRuntime{version:number;publicKey:CollaborationPublicKey;root:CryptoKey;privateKey:CryptoKey}
const identities=new Map<string,CollaborationRuntime>(),epochKeys=new Map<string,CryptoKey>();
const epochId=(accountId:string,vaultId:string,epoch:number)=>accountId+':'+vaultId+':'+epoch;
export const setCollaborationRuntime=(accountId:string,value:CollaborationRuntime)=>identities.set(accountId,value);
export const getCollaborationRuntime=(accountId:string)=>identities.get(accountId);
export const clearCollaborationRuntime=(accountId:string)=>identities.delete(accountId);
export function setVaultEpochKey(accountId:string,vaultId:string,epoch:number,key:CryptoKey){epochKeys.set(epochId(accountId,vaultId,epoch),key);}
export function getVaultEpochKey(accountId:string,vaultId:string,epoch:number){return epochKeys.get(epochId(accountId,vaultId,epoch));}
export function clearVaultEpochKeys(accountId:string,vaultId?:string){const prefix=accountId+':'+(vaultId?vaultId+':':'');for(const id of epochKeys.keys())if(id.startsWith(prefix))epochKeys.delete(id);}

function fail(message='invalid_collaboration_crypto'):never{throw Error(message);}
function decode64(value:unknown,min?:number,max=min??Number.MAX_SAFE_INTEGER){
  if(typeof value!=='string'||value.length>Math.ceil(max*4/3)+4||!/^[A-Za-z0-9_-]+$/.test(value))fail();
  let text:string;try{text=atob(value.replace(/-/g,'+').replace(/_/g,'/'));}catch{return fail();}
  const bytes=Uint8Array.from(text,c=>c.charCodeAt(0));if((min!==undefined&&bytes.length<min)||bytes.length>max||encode64(bytes)!==value)fail();return bytes;
}
function random(n:number){const b=new Uint8Array(n);crypto.getRandomValues(b);return b;}
function validAccount(id:string){if(!uuid.test(id))fail();}
function validPublic(value:unknown):CollaborationPublicKey{
  if(!value||typeof value!=='object'||Array.isArray(value))fail();const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join()!=='crv,kty,x,y'||r.kty!=='EC'||r.crv!=='P-256')fail();
  decode64(r.x,32);decode64(r.y,32);return value as CollaborationPublicKey;
}
function publicJSON(key:CollaborationPublicKey){return JSON.stringify({kty:key.kty,crv:key.crv,x:key.x,y:key.y});}
export async function collaborationFingerprint(key:CollaborationPublicKey){
  validPublic(key);return encode64(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(publicJSON(key)))));
}
function passwordBytes(password:string){if(typeof password!=='string'||Array.from(password).length<6||new TextEncoder().encode(password).length>4096)fail('invalid_password');return enc.encode(password);}
async function passwordKey(password:string,kdf:CollaborationPasswordWrapper['kdf']){
  const raw=passwordBytes(password);try{const base=await crypto.subtle.importKey('raw',raw,'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:kdf.iterations,salt:decode64(kdf.salt,16)},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }finally{raw.fill(0);}
}
function identityAad(accountId:string,version:number,publicKey:CollaborationPublicKey,purpose:string){
  validAccount(accountId);if(!Number.isSafeInteger(version)||version<1)fail();validPublic(publicKey);
  return enc.encode(JSON.stringify(['tasks-collaboration-identity',1,purpose,accountId,version,publicKey]));
}
async function rootKey(raw:Uint8Array<ArrayBuffer>){if(raw.length!==32)fail();return crypto.subtle.importKey('raw',raw,{name:'AES-GCM',length:256},true,['encrypt','decrypt']);}
async function privateFromBox(accountId:string,identity:Pick<CollaborationIdentity,'version'|'publicKey'|'privateBox'>,root:CryptoKey){
  const box=identity.privateBox;if(!box||box.v!==1||box.purpose!=='collaboration-private-key'||box.alg!=='A256GCM')fail();
  let raw:Uint8Array<ArrayBuffer>;try{raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(box.iv,12),
    additionalData:identityAad(accountId,identity.version,identity.publicKey,'private-key'),tagLength:128},root,decode64(box.ciphertext,16,8192)));}
  catch{throw Error('collaboration_unlock_failed');}
  try{return await crypto.subtle.importKey('pkcs8',raw,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);}finally{raw.fill(0);}
}
export async function createCollaborationPasswordWrapper(accountId:string,version:number,publicKey:CollaborationPublicKey,root:CryptoKey,password:string):Promise<CollaborationPasswordWrapper>{
  const raw=new Uint8Array(await crypto.subtle.exportKey('raw',root)),salt=random(16),iv=random(12);
  const kdf={name:'PBKDF2-SHA256' as const,iterations:PBKDF2_ITERATIONS,salt:encode64(salt)};
  try{const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:identityAad(accountId,version,publicKey,'password-root'),tagLength:128},await passwordKey(password,kdf),raw);
    return{v:1,purpose:'collaboration-password',alg:'A256GCM',iv:encode64(iv),ciphertext:encode64(new Uint8Array(ciphertext)),kdf};}
  finally{raw.fill(0);}
}
export async function createCollaborationIdentity(accountId:string,password:string,version=1):Promise<{identity:CollaborationIdentity;runtime:CollaborationRuntime}>{
  validAccount(accountId);const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey),publicKey=validPublic({kty:'EC',crv:'P-256',x:jwk.x!,y:jwk.y!});
  const privateRaw=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey)),rootRaw=random(32),root=await rootKey(rootRaw),iv=random(12);
  try{
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:identityAad(accountId,version,publicKey,'private-key'),tagLength:128},root,privateRaw);
    const privateBox:CollaborationPrivateBox={v:1,purpose:'collaboration-private-key',alg:'A256GCM',iv:encode64(iv),ciphertext:encode64(new Uint8Array(ciphertext))};
    const passwordWrapper=await createCollaborationPasswordWrapper(accountId,version,publicKey,root,password);
    const runtime={version,publicKey,root,privateKey:pair.privateKey};return{identity:{version,publicKey,privateBox,passwordWrapper},runtime};
  }finally{privateRaw.fill(0);rootRaw.fill(0);}
}
export async function unlockCollaborationWithPassword(accountId:string,identity:CollaborationIdentity,password:string){
  validPublic(identity.publicKey);const w=identity.passwordWrapper;
  if(!w||w.v!==1||w.purpose!=='collaboration-password'||w.alg!=='A256GCM'||w.kdf?.name!=='PBKDF2-SHA256'
    ||!Number.isSafeInteger(w.kdf.iterations)||w.kdf.iterations<PBKDF2_ITERATIONS||w.kdf.iterations>2_000_000)fail();
  let raw:Uint8Array<ArrayBuffer>;try{raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(w.iv,12),
    additionalData:identityAad(accountId,identity.version,identity.publicKey,'password-root'),tagLength:128},await passwordKey(password,w.kdf),decode64(w.ciphertext,48)));}
  catch{throw Error('collaboration_unlock_failed');}
  try{const root=await rootKey(raw),privateKey=await privateFromBox(accountId,identity,root);const runtime={version:identity.version,publicKey:identity.publicKey,root,privateKey};setCollaborationRuntime(accountId,runtime);return runtime;}
  finally{raw.fill(0);}
}
function prfAad(accountId:string,version:number,publicKey:CollaborationPublicKey,w:Pick<CollaborationPrfWrapper,'credentialId'|'prfSalt'>){
  if(!credential.test(w.credentialId))fail();decode64(w.prfSalt,32);
  return enc.encode(JSON.stringify(['tasks-collaboration-prf',1,accountId,version,publicKey,w.credentialId,w.prfSalt]));
}
async function prfKey(output:BufferSource){const source=output instanceof ArrayBuffer?new Uint8Array(output):new Uint8Array(output.buffer,output.byteOffset,output.byteLength);
  if(source.length!==32)fail();const raw=Uint8Array.from(source);try{return crypto.subtle.importKey('raw',raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}finally{raw.fill(0);}}
export function collaborationPrfSalt(){return encode64(random(32));}
export async function createCollaborationPrfWrapper(accountId:string,runtime:CollaborationRuntime,credentialId:string,prfSalt:string,output:BufferSource):Promise<CollaborationPrfWrapper>{
  const raw=new Uint8Array(await crypto.subtle.exportKey('raw',runtime.root)),iv=random(12),base={credentialId,prfSalt};
  try{const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:prfAad(accountId,runtime.version,runtime.publicKey,base),tagLength:128},await prfKey(output),raw);
    return{v:1,purpose:'collaboration-prf',alg:'A256GCM',identityVersion:runtime.version,...base,iv:encode64(iv),ciphertext:encode64(new Uint8Array(ciphertext))};}
  finally{raw.fill(0);}
}
export async function unlockCollaborationWithPrf(accountId:string,identity:CollaborationIdentity,wrapper:CollaborationPrfWrapper,output:BufferSource){
  if(!wrapper||wrapper.v!==1||wrapper.purpose!=='collaboration-prf'||wrapper.alg!=='A256GCM'||wrapper.identityVersion!==identity.version)fail();
  let raw:Uint8Array<ArrayBuffer>;try{raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(wrapper.iv,12),
    additionalData:prfAad(accountId,identity.version,identity.publicKey,wrapper),tagLength:128},await prfKey(output),decode64(wrapper.ciphertext,48)));}
  catch{throw Error('collaboration_unlock_failed');}
  try{const root=await rootKey(raw),privateKey=await privateFromBox(accountId,identity,root),runtime={version:identity.version,publicKey:identity.publicKey,root,privateKey};
    setCollaborationRuntime(accountId,runtime);return runtime;}finally{raw.fill(0);}
}
function validateKeyring(value:unknown):VaultKeyring{
  if(!value||typeof value!=='object'||Array.isArray(value))fail();const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join()!=='currentEpoch,keys,version'||!Number.isSafeInteger(r.version)||(r.version as number)<1
    ||!Number.isSafeInteger(r.currentEpoch)||(r.currentEpoch as number)<0||!Array.isArray(r.keys))fail();
  const keys=(r.keys as unknown[]).map(item=>{if(!item||typeof item!=='object'||Array.isArray(item))fail();const x=item as Record<string,unknown>;
    if(Object.keys(x).sort().join()!=='epoch,key'||!Number.isSafeInteger(x.epoch)||(x.epoch as number)<0)fail();decode64(x.key,32);return{epoch:x.epoch as number,key:x.key as string};});
  const currentEpoch=r.currentEpoch as number;keys.sort((a,b)=>a.epoch-b.epoch);if(keys.length!==currentEpoch+1||keys.some((x,i)=>x.epoch!==i)||new Set(keys.map(x=>x.epoch)).size!==keys.length)fail();
  return{version:r.version as number,currentEpoch:r.currentEpoch as number,keys};
}
export function keyringFromRaw(version:number,currentEpoch:number,rawKeys:Uint8Array<ArrayBuffer>[]){
  return validateKeyring({version,currentEpoch,keys:rawKeys.map((key,epoch)=>({epoch,key:encode64(key)}))});
}
export function vaultKeyringRaw(value:VaultKeyring){
  const ring=validateKeyring(value);return ring.keys.map(entry=>Uint8Array.from(decode64(entry.key,32)));
}
export async function importVaultKeyring(accountId:string,vaultId:string,value:unknown){
  const ring=validateKeyring(value);for(const entry of ring.keys){const raw=decode64(entry.key,32);try{setVaultEpochKey(accountId,vaultId,entry.epoch,await crypto.subtle.importKey('raw',raw,'AES-KW',false,['wrapKey','unwrapKey']));}finally{raw.fill(0);}}
  return ring;
}
function envelopeAad(vaultId:string,version:number,recipientId:string,identityVersion:number,fingerprint:string){
  if(!uuid.test(vaultId)||!uuid.test(recipientId)||!Number.isSafeInteger(version)||version<1||!Number.isSafeInteger(identityVersion)||identityVersion<1)fail();decode64(fingerprint,32);
  return enc.encode(JSON.stringify(['tasks-vault-keyring-envelope',1,vaultId,version,recipientId,identityVersion,fingerprint]));
}
async function envelopeKey(privateKey:CryptoKey,publicKey:CryptoKey,salt:Uint8Array<ArrayBuffer>,info:Uint8Array<ArrayBuffer>){
  const secret=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},privateKey,256));
  try{const base=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
  finally{secret.fill(0);}
}
async function importPublic(key:CollaborationPublicKey){validPublic(key);return crypto.subtle.importKey('jwk',key,{name:'ECDH',namedCurve:'P-256'},false,[]);}
export async function encryptVaultKeyring(vaultId:string,keyring:VaultKeyring,recipientId:string,identityVersion:number,recipientPublicKey:CollaborationPublicKey):Promise<VaultMemberEnvelope>{
  const fingerprint=await collaborationFingerprint(recipientPublicKey),ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),jwk=await crypto.subtle.exportKey('jwk',ephemeral.publicKey);
  const ephemeralPublicKey=validPublic({kty:'EC',crv:'P-256',x:jwk.x!,y:jwk.y!}),salt=random(32),iv=random(12),aad=envelopeAad(vaultId,keyring.version,recipientId,identityVersion,fingerprint);
  const data=enc.encode(JSON.stringify(validateKeyring(keyring)));try{
    const key=await envelopeKey(ephemeral.privateKey,await importPublic(recipientPublicKey),salt,aad),ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,data);
    return{v:1,purpose:'vault-keyring-member',alg:'ECDH-P256+HKDF-SHA256+A256GCM',ephemeralPublicKey,salt:encode64(salt),iv:encode64(iv),ciphertext:encode64(new Uint8Array(ciphertext)),recipientFingerprint:fingerprint};
  }finally{data.fill(0);}
}
export async function decryptVaultKeyring(accountId:string,vaultId:string,version:number,identityVersion:number,envelope:VaultMemberEnvelope,runtime:CollaborationRuntime){
  if(runtime.version!==identityVersion||!envelope||envelope.v!==1||envelope.purpose!=='vault-keyring-member'||envelope.alg!=='ECDH-P256+HKDF-SHA256+A256GCM')fail();
  const fingerprint=await collaborationFingerprint(runtime.publicKey);if(envelope.recipientFingerprint!==fingerprint)throw Error('identity_changed');
  const aad=envelopeAad(vaultId,version,accountId,identityVersion,fingerprint),salt=decode64(envelope.salt,32),iv=decode64(envelope.iv,12);
  let raw:Uint8Array<ArrayBuffer>;try{const key=await envelopeKey(runtime.privateKey,await importPublic(validPublic(envelope.ephemeralPublicKey)),salt,aad);
    raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,decode64(envelope.ciphertext,16,65536)));}
  catch{throw Error('keyring_unlock_failed');}
  try{return validateKeyring(JSON.parse(dec.decode(raw)));}finally{raw.fill(0);}
}
export async function createOwnerKeyringBox(epoch0:CryptoKey,context:Context,keyring:VaultKeyring):Promise<Sealed>{
  return seal(await rememberKey(epoch0),context,null,{kind:'vault-keyring-owner-v1',keyring:validateKeyring(keyring)});
}
export async function openOwnerKeyringBox(epoch0:CryptoKey,context:Context,box:Sealed):Promise<VaultKeyring>{
  const value=await unseal(epoch0,context,null,box) as {kind?:unknown;keyring?:unknown};if(value?.kind!=='vault-keyring-owner-v1')fail();return validateKeyring(value.keyring);
}
function reminderAad(accountId:string,vaultId:string,objectId:string,revisionId:string){
  for(const id of [accountId,vaultId,objectId,revisionId])if(!uuid.test(id))fail();
  return enc.encode(JSON.stringify(['tasks-personal-reminder',1,accountId,vaultId,objectId,revisionId]));
}
export async function sealPersonalReminder(accountId:string,vaultId:string,objectId:string,revisionId:string,root:CryptoKey,value:unknown):Promise<PersonalReminderBox>{
  const data=enc.encode(JSON.stringify(value));if(data.length>12000)fail();const iv=random(12);
  try{const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:reminderAad(accountId,vaultId,objectId,revisionId),tagLength:128},root,data);
    return{v:1,purpose:'personal-reminder',alg:'A256GCM',iv:encode64(iv),ciphertext:encode64(new Uint8Array(ciphertext))};}finally{data.fill(0);}
}
export async function openPersonalReminder(accountId:string,vaultId:string,objectId:string,revisionId:string,root:CryptoKey,box:PersonalReminderBox){
  if(!box||box.v!==1||box.purpose!=='personal-reminder'||box.alg!=='A256GCM')fail();let raw:Uint8Array<ArrayBuffer>;
  try{raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(box.iv,12),additionalData:reminderAad(accountId,vaultId,objectId,revisionId),tagLength:128},root,decode64(box.ciphertext,16,16384)));}
  catch{throw Error('personal_reminder_unlock_failed');}try{return JSON.parse(dec.decode(raw));}finally{raw.fill(0);}
}
export function prfSaltForCollaboration(value:string){return prfSaltBytes(value);}
