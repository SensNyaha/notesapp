import type { User } from './types/auth.ts';
import { AuthError, listPasskeys, session } from './auth.ts';
import { readState, writeState, exclusive, announce, type Vault } from './storage.ts';
import { unwrapWithPhrase, type Context } from './crypto/vault.ts';
import { rememberKey, seal, unseal, type Sealed } from './crypto/records.ts';
import { evaluateVaultPrf, webAuthnPrfPossible } from './webauthn-prf.ts';
import {
  clearCollaborationRuntime, clearVaultEpochKeys, collaborationFingerprint, collaborationPrfSalt, createCollaborationIdentity, createCollaborationPasswordWrapper,
  createCollaborationPrfWrapper, createOwnerKeyringBox, decryptVaultKeyring, encryptVaultKeyring,
  getCollaborationRuntime, getVaultEpochKey, importVaultKeyring, keyringFromRaw, openOwnerKeyringBox,
  openPersonalReminder, sealPersonalReminder, setCollaborationRuntime, setVaultEpochKey,
  unlockCollaborationWithPassword, unlockCollaborationWithPrf, vaultKeyringRaw,
  type CollaborationIdentity, type CollaborationPublicKey, type PersonalReminderBox, type VaultKeyring, type VaultMemberEnvelope
} from './crypto/collaboration.ts';
import type { ReminderPlan } from '../shared/reminders.mjs';
import { validPlan } from '../shared/reminders.mjs';

export class CollaborationError extends Error{code:string;constructor(code:string){super(code);this.code=code;}}
export class ContactKeyChanged extends Error{userId:string;previous:string;current:string;
  constructor(userId:string,previous:string,current:string){super('contact_key_changed');this.userId=userId;this.previous=previous;this.current=current;}}
export interface PublicIdentity{version:number;publicKey:CollaborationPublicKey;fingerprint:string}
export interface ContactInfo{id:string;login:string;createdAt?:number;identity:PublicIdentity|null}
export interface VaultMemberInfo{user:{id:string;login:string};role:'owner'|'editor'|'viewer';joinedAt:number;identity:PublicIdentity|null}
export interface DecryptedComment{id:string;author:{id:string;login:string};text:string;createdAt:number;updatedAt:number;keyEpoch:number}

async function csrf(){
  const r=await fetch('/api/auth/csrf',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10_000)}),v=await r.json();
  if(!r.ok||!v||typeof v.csrf!=='string')throw new CollaborationError('network');return v.csrf as string;
}
export async function collaborationRequest(userId:string,path:string,body?:unknown,vaultIds:string[]=[]):Promise<any>{
  const actor=await session();if(actor?.id!==userId)throw new CollaborationError('unauthorized');
  const state=await readState(userId),headers:Record<string,string>={'X-Tasks-Account':userId};
  if(state?.deviceId)headers['X-Tasks-Device']=state.deviceId;
  if(vaultIds.length){const grants:Record<string,string>={};for(const id of vaultIds){const token=state?.vaults.find(v=>v.header.id===id)?.grant;if(token)grants[id]=token;}headers['X-Vault-Grants']=JSON.stringify(grants);}
  if(body!==undefined){headers['X-CSRF-Token']=await csrf();headers['Content-Type']='application/json';}
  let r:Response;try{r=await fetch('/api/collaboration/'+path,{method:body===undefined?'GET':'POST',headers,credentials:'same-origin',cache:'no-store',
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15_000)});}catch{throw new CollaborationError('network');}
  let value:any;try{value=await r.json();}catch{throw new CollaborationError('network');}
  if(!r.ok)throw new CollaborationError(typeof value?.error==='string'?value.error:'network');return value;
}
export async function collaborationIdentity(userId:string):Promise<CollaborationIdentity|null>{
  const value=await collaborationRequest(userId,'identity');return value.identity??null;
}
async function updateLocal(userId:string,fn:(state:NonNullable<Awaited<ReturnType<typeof readState>>>)=>void|Promise<void>){
  await exclusive(async()=>{const state=await readState(userId);if(!state)throw Error('Локальный аккаунт закрыт');await fn(state);await writeState(state);announce();});
}
export async function ensureCollaborationIdentity(user:User,password:string){
  let identity=await collaborationIdentity(user.id);
  if(!identity){const created=await createCollaborationIdentity(user.id,password);const result=await collaborationRequest(user.id,'identity/setup',{password,...created.identity});
    identity=result.identity as CollaborationIdentity;setCollaborationRuntime(user.id,created.runtime);}
  else await unlockCollaborationWithPassword(user.id,identity,password);
  await hydratePersonalReminderRuntime(user.id);return identity;
}
export async function unlockCollaborationPassword(user:User,password:string){
  const identity=await collaborationIdentity(user.id);if(!identity)throw new CollaborationError('identity_missing');
  const runtime=await unlockCollaborationWithPassword(user.id,identity,password);await hydratePersonalReminderRuntime(user.id);return runtime;
}
export async function enableCollaborationSystemUnlock(user:User){
  if(!webAuthnPrfPossible())throw Error('WebAuthn PRF недоступен на этом устройстве.');
  const runtime=getCollaborationRuntime(user.id);if(!runtime)throw Error('Сначала откройте ключ совместной работы паролем аккаунта.');
  const passkeys=await listPasskeys();if(!passkeys.length)throw Error('Сначала добавьте ключ доступа в настройках аккаунта.');
  const salt=collaborationPrfSalt(),evaluation=await evaluateVaultPrf(passkeys,salt);
  try{const wrapper=await createCollaborationPrfWrapper(user.id,runtime,evaluation.credentialId,salt,evaluation.output);
    await updateLocal(user.id,state=>{state.collaboration??={};state.collaboration.systemUnlock=wrapper;});return wrapper;}
  finally{evaluation.output.fill(0);}
}
export function collaborationIsUnlocked(userId:string){return Boolean(getCollaborationRuntime(userId));}
export async function forgetCollaborationSystemUnlock(user:User){
  await updateLocal(user.id,state=>{if(state.collaboration?.systemUnlock)delete state.collaboration.systemUnlock;});
}
export async function unlockCollaborationSystem(user:User){
  const state=await readState(user.id),wrapper=state?.collaboration?.systemUnlock;if(!wrapper)throw new CollaborationError('collaboration_system_unlock_missing');
  const identity=await collaborationIdentity(user.id);if(!identity||identity.version!==wrapper.identityVersion)throw new CollaborationError('identity_changed');
  const evaluation=await evaluateVaultPrf([{credentialId:wrapper.credentialId}],wrapper.prfSalt);
  try{if(evaluation.credentialId!==wrapper.credentialId)throw new CollaborationError('identity_changed');
    const runtime=await unlockCollaborationWithPrf(user.id,identity,wrapper,evaluation.output);await hydratePersonalReminderRuntime(user.id);return runtime;}
  finally{evaluation.output.fill(0);}
}
export async function rewrapCollaborationPassword(userId:string,newPassword:string){
  const identity=await collaborationIdentity(userId),runtime=getCollaborationRuntime(userId);if(!identity||!runtime||runtime.version!==identity.version)return null;
  return{version:identity.version,wrapper:await createCollaborationPasswordWrapper(userId,identity.version,identity.publicKey,runtime.root,newPassword)};
}
export async function prepareCollaborationPasswordChange(user:User,currentPassword:string,newPassword:string){
  const identity=await collaborationIdentity(user.id);if(!identity)return{identity:false,rewrap:null,recoveryRequired:false};
  if(!getCollaborationRuntime(user.id)){
    try{await unlockCollaborationPassword(user,currentPassword);}
    catch{
      try{await unlockCollaborationSystem(user);}catch{return{identity:true,rewrap:null,recoveryRequired:true};}
    }
  }
  const rewrap=await rewrapCollaborationPassword(user.id,newPassword);
  return{identity:true,rewrap,recoveryRequired:!rewrap};
}
export async function markCollaborationRecoveryRequired(userId:string){
  await updateLocal(userId,state=>{state.collaboration??={};state.collaboration.recoveryRequired=true;});
}
export async function persistCollaborationPasswordWrapper(user:User,currentPassword:string){
  const prepared=await rewrapCollaborationPassword(user.id,currentPassword);if(!prepared)throw new CollaborationError('collaboration_locked');
  await collaborationRequest(user.id,'identity/rewrap',{password:currentPassword,expectedVersion:prepared.version,passwordWrapper:prepared.wrapper});
  await updateLocal(user.id,state=>{if(state.collaboration)delete state.collaboration.recoveryRequired;});
  return prepared;
}
export async function replaceCollaborationIdentity(user:User,password:string){
  const previous=await collaborationIdentity(user.id);if(!previous)throw new CollaborationError('identity_missing');
  const next=await createCollaborationIdentity(user.id,password,previous.version+1);
  const result=await collaborationRequest(user.id,'identity/replace',{password,expectedVersion:previous.version,...next.identity,confirmed:true});
  setCollaborationRuntime(user.id,next.runtime);clearVaultEpochKeys(user.id);personalPlans.clear();
  await updateLocal(user.id,state=>{state.collaboration??={};if(state.collaboration.systemUnlock)delete state.collaboration.systemUnlock;delete state.collaboration.recoveryRequired;state.personalReminderConfigs={};});
  return result.identity as CollaborationIdentity;
}
export async function findUser(user:User,login:string):Promise<{user:{id:string;login:string};identity:PublicIdentity|null}>{
  return collaborationRequest(user.id,'users/find',{login});
}
export async function contactState(user:User):Promise<{contacts:ContactInfo[];incoming:any[];outgoing:any[]}>{
  return collaborationRequest(user.id,'contacts');
}
export const requestContact=(user:User,userId:string)=>collaborationRequest(user.id,'contacts/request',{userId});
export const acceptContact=(user:User,requestId:string)=>collaborationRequest(user.id,'contacts/accept',{requestId});
export const rejectContact=(user:User,requestId:string)=>collaborationRequest(user.id,'contacts/reject',{requestId});
export const cancelContact=(user:User,requestId:string)=>collaborationRequest(user.id,'contacts/cancel',{requestId});
export const removeContact=(user:User,userId:string)=>collaborationRequest(user.id,'contacts/remove',{userId,confirmed:true});

export async function trustFingerprint(user:User,userId:string,current:string,confirmChange=false){
  const state=await readState(user.id),previous=state?.collaboration?.trustedFingerprints?.[userId];
  if(previous&&previous!==current&&!confirmChange)throw new ContactKeyChanged(userId,previous,current);
  if(previous!==current)await updateLocal(user.id,s=>{s.collaboration??={};s.collaboration.trustedFingerprints??={};s.collaboration.trustedFingerprints[userId]=current;});
  return previous?'known':'first';
}
function ownerContext(userId:string,v:Vault):Context{
  const accountId=v.ownerId??userId;return{accountId,vaultId:v.header.id,keyId:v.header.keyId,objectId:v.header.keyId,revisionId:v.header.revisionId};
}
function random32(){const raw=new Uint8Array(32);crypto.getRandomValues(raw);return raw;}
export async function initializeSharedVault(user:User,vaultId:string,phrase:string){
  if(!getCollaborationRuntime(user.id))throw Error('Сначала откройте ключ совместной работы.');
  const state=await readState(user.id),v=state?.vaults.find(item=>item.header.id===vaultId);
  if(!v||v.deleted||!v.key||v.role&&v.role!=='owner')throw Error('Откройте своё хранилище перед включением совместного доступа.');
  if(v.shared&&v.keyring)return v.keyring;
  let root:CryptoKey;try{root=await unwrapWithPhrase(ownerContext(user.id,v),phrase,v.header.wrapper);}catch{throw Error('Неверная фраза хранилища.');}
  const raw=new Uint8Array(await crypto.subtle.exportKey('raw',root));try{
    const ring=keyringFromRaw(1,0,[raw]),epoch0=await rememberKey(root),box=await createOwnerKeyringBox(epoch0,ownerContext(user.id,v),ring);
    await collaborationRequest(user.id,'vaults/keyring/setup',{vaultId,version:1,currentEpoch:0,ownerBox:box});
    await importVaultKeyring(user.id,vaultId,ring);setVaultEpochKey(user.id,vaultId,0,epoch0);
    await updateLocal(user.id,s=>{const current=s.vaults.find(x=>x.header.id===vaultId);if(!current)throw Error('Хранилище изменилось');
      current.shared=true;current.role='owner';current.ownerId=user.id;current.keyring={version:1,currentEpoch:0,ownerBox:box};current.key=epoch0;});
    return{version:1,currentEpoch:0,ownerBox:box};
  }finally{raw.fill(0);}
}
export async function loadOwnerKeyring(user:User,vaultId:string){
  const state=await readState(user.id),v=state?.vaults.find(x=>x.header.id===vaultId);if(!v?.key||v.role!=='owner'||!v.keyring?.ownerBox)throw Error('Хранилище не готово.');
  const ring=await openOwnerKeyringBox(v.key,ownerContext(user.id,v),v.keyring.ownerBox);if(ring.version!==v.keyring.version||ring.currentEpoch!==v.keyring.currentEpoch)throw Error('Keyring metadata mismatch');
  await importVaultKeyring(user.id,vaultId,ring);setVaultEpochKey(user.id,vaultId,0,v.key);return ring;
}
export async function unlockMemberVault(user:User,vaultId:string){
  const runtime=getCollaborationRuntime(user.id);if(!runtime)throw new CollaborationError('collaboration_locked');
  const state=await readState(user.id),v=state?.vaults.find(x=>x.header.id===vaultId);if(!v||v.role==='owner'||!v.memberEnvelope||!v.keyring)throw Error('Совместный доступ не готов.');
  const ring=await decryptVaultKeyring(user.id,vaultId,v.memberEnvelope.keyringVersion,v.memberEnvelope.identityVersion,v.memberEnvelope.keyEnvelope,runtime);
  if(ring.version!==v.keyring.version||ring.currentEpoch!==v.keyring.currentEpoch)throw new CollaborationError('keyring_changed');
  await importVaultKeyring(user.id,vaultId,ring);const epoch0=getVaultEpochKey(user.id,vaultId,0);if(!epoch0)throw Error('Не удалось открыть ключ хранилища.');
  await updateLocal(user.id,s=>{const current=s.vaults.find(x=>x.header.id===vaultId);if(!current)throw Error('Хранилище изменилось');current.key=epoch0;current.needsGrant=true;});
  return ring;
}
export async function sharedVaultMembers(user:User,vaultId:string):Promise<VaultMemberInfo[]>{
  return (await collaborationRequest(user.id,'vaults/'+vaultId+'/members',undefined,[vaultId])).members;
}
export async function invites(user:User){return (await collaborationRequest(user.id,'invites')).invites as any[];}
export const acceptVaultInvite=(user:User,inviteId:string)=>collaborationRequest(user.id,'vaults/invite/accept',{inviteId});
export const rejectVaultInvite=(user:User,inviteId:string)=>collaborationRequest(user.id,'vaults/invite/reject',{inviteId});
export const cancelVaultInvite=(user:User,inviteId:string)=>collaborationRequest(user.id,'vaults/invite/cancel',{inviteId});

async function ownerRing(user:User,vaultId:string){
  const state=await readState(user.id),v=state?.vaults.find(x=>x.header.id===vaultId);if(!v?.key||v.role!=='owner'||!v.keyring?.ownerBox)throw Error('Откройте shared vault владельца.');
  return{v,ring:await openOwnerKeyringBox(v.key,ownerContext(user.id,v),v.keyring.ownerBox)};
}
export async function inviteToVault(user:User,vaultId:string,target:{id:string;login:string;identity:PublicIdentity|null},role:'editor'|'viewer',confirmChanged=false){
  if(!target.identity)throw Error('У контакта ещё нет E2EE-ключа совместной работы.');
  await trustFingerprint(user,target.id,target.identity.fingerprint,confirmChanged);
  const {ring}=await ownerRing(user,vaultId),keyEnvelope=await encryptVaultKeyring(vaultId,ring,target.id,target.identity.version,target.identity.publicKey);
  return collaborationRequest(user.id,'vaults/invite',{vaultId,userId:target.id,role,keyringVersion:ring.version,identityVersion:target.identity.version,keyEnvelope},[vaultId]);
}
export const changeMemberRole=(user:User,vaultId:string,userId:string,role:'editor'|'viewer')=>
  collaborationRequest(user.id,'vaults/member/role',{vaultId,userId,role},[vaultId]);
export async function regrantMember(user:User,vaultId:string,target:VaultMemberInfo,confirmChanged=false){
  if(!target.identity)throw Error('У участника нет E2EE-ключа.');await trustFingerprint(user,target.user.id,target.identity.fingerprint,confirmChanged);
  const {ring}=await ownerRing(user,vaultId),keyEnvelope=await encryptVaultKeyring(vaultId,ring,target.user.id,target.identity.version,target.identity.publicKey);
  return collaborationRequest(user.id,'vaults/member/regrant',{vaultId,userId:target.user.id,keyringVersion:ring.version,identityVersion:target.identity.version,keyEnvelope},[vaultId]);
}
export async function removeVaultMember(user:User,vaultId:string,userId:string,confirmChanged=false){
  const members=await sharedVaultMembers(user,vaultId),remaining=members.filter(m=>m.role!=='owner'&&m.user.id!==userId);
  const {v,ring}=await ownerRing(user,vaultId),raw=vaultKeyringRaw(ring),nextRaw=random32();raw.push(nextRaw);
  try{
    const next=keyringFromRaw(ring.version+1,ring.currentEpoch+1,raw),ownerBox=await createOwnerKeyringBox(v.key!,ownerContext(user.id,v),next),envelopes=[] as any[];
    for(const member of remaining){if(!member.identity)throw Error('У оставшегося участника нет E2EE-ключа.');await trustFingerprint(user,member.user.id,member.identity.fingerprint,confirmChanged);
      envelopes.push({userId:member.user.id,identityVersion:member.identity.version,keyEnvelope:await encryptVaultKeyring(vaultId,next,member.user.id,member.identity.version,member.identity.publicKey)});}
    const result=await collaborationRequest(user.id,'vaults/member/remove',{vaultId,userId,expectedVersion:ring.version,newVersion:next.version,currentEpoch:next.currentEpoch,ownerBox,envelopes,confirmed:true},[vaultId]);
    await importVaultKeyring(user.id,vaultId,next);await updateLocal(user.id,s=>{const current=s.vaults.find(x=>x.header.id===vaultId);if(current)current.keyring={version:next.version,currentEpoch:next.currentEpoch,ownerBox};});
    return result;
  }finally{for(const bytes of raw)bytes.fill(0);}
}
export async function leaveSharedVault(user:User,vaultId:string){
  const result=await collaborationRequest(user.id,'vaults/leave',{vaultId,confirmed:true},[vaultId]);
  await updateLocal(user.id,s=>{const v=s.vaults.find(x=>x.header.id===vaultId);if(v){v.membershipRevoked=true;v.role='viewer';delete v.grant;v.needsGrant=false;v.syncError='Вы вышли из совместного хранилища. Локальная копия содержит только ранее полученные данные.';}});return result;
}

function commentContext(userId:string,v:Vault,noteId:string,commentId:string):Context{
  return{accountId:v.ownerId??userId,vaultId:v.header.id,keyId:v.header.keyId,objectId:noteId,revisionId:commentId};
}
export async function loadComments(user:User,vaultId:string,objectId:string):Promise<DecryptedComment[]>{
  const state=await readState(user.id),v=state?.vaults.find(x=>x.header.id===vaultId);if(!v?.key)throw Error('Откройте хранилище.');
  const rows=(await collaborationRequest(user.id,'comments/'+vaultId+'/'+objectId,undefined,[vaultId])).comments as any[],result:DecryptedComment[]=[];
  for(const row of rows){const key=(row.keyEpoch??0)===0?(v.key??getVaultEpochKey(user.id,vaultId,0)):getVaultEpochKey(user.id,vaultId,row.keyEpoch);if(!key)throw Error('Ключ старого комментария недоступен.');
    const value=await unseal(key,commentContext(user.id,v,objectId,row.id),null,row.payload) as any;if(!value||value.kind!=='note-comment-v1'||typeof value.text!=='string')throw Error('Повреждён комментарий');
    result.push({id:row.id,author:row.author,text:value.text,createdAt:row.createdAt,updatedAt:row.updatedAt,keyEpoch:row.keyEpoch});}
  return result;
}
export async function createComment(user:User,vaultId:string,objectId:string,text:string){
  const clean=text.trim();if(!clean||clean.length>4000)throw Error('Комментарий: от 1 до 4000 символов.');
  const state=await readState(user.id),v=state?.vaults.find(x=>x.header.id===vaultId);if(!v?.key)throw Error('Откройте хранилище.');
  const keyEpoch=v.keyring?.currentEpoch??0,key=keyEpoch===0?(v.key??getVaultEpochKey(user.id,vaultId,0)):getVaultEpochKey(user.id,vaultId,keyEpoch);if(!key)throw Error('Актуальный ключ недоступен.');
  const id=crypto.randomUUID(),payload=await seal(key,commentContext(user.id,v,objectId,id),null,{kind:'note-comment-v1',text:clean});
  return collaborationRequest(user.id,'comments/create',{id,vaultId,objectId,keyEpoch,payload},[vaultId]);
}
export async function updateComment(user:User,vaultId:string,objectId:string,id:string,text:string){
  const clean=text.trim();if(!clean||clean.length>4000)throw Error('Комментарий: от 1 до 4000 символов.');
  const state=await readState(user.id),v=state?.vaults.find(x=>x.header.id===vaultId);if(!v?.key)throw Error('Откройте хранилище.');
  const keyEpoch=v.keyring?.currentEpoch??0,key=keyEpoch===0?(v.key??getVaultEpochKey(user.id,vaultId,0)):getVaultEpochKey(user.id,vaultId,keyEpoch);if(!key)throw Error('Актуальный ключ недоступен.');
  const payload=await seal(key,commentContext(user.id,v,objectId,id),null,{kind:'note-comment-v1',text:clean});
  return collaborationRequest(user.id,'comments/update',{id,vaultId,keyEpoch,payload},[vaultId]);
}
export const deleteComment=(user:User,vaultId:string,id:string)=>collaborationRequest(user.id,'comments/delete',{id,vaultId,confirmed:true},[vaultId]);

const personalPlans=new Map<string,ReminderPlan>(),planId=(accountId:string,vaultId:string,objectId:string)=>accountId+':'+vaultId+':'+objectId;
export function clearCollaborationLocalRuntime(userId:string){clearCollaborationRuntime(userId);clearVaultEpochKeys(userId);for(const id of [...personalPlans.keys()])if(id.startsWith(userId+':'))personalPlans.delete(id);}
export function personalReminder(userId:string,vaultId:string,objectId:string){return personalPlans.get(planId(userId,vaultId,objectId));}
export async function setPersonalReminderLocal(user:User,vaultId:string,objectId:string,plan:ReminderPlan|null){
  const runtime=getCollaborationRuntime(user.id);if(!runtime)throw new CollaborationError('collaboration_locked');const key=planId(user.id,vaultId,objectId);
  if(plan!==null&&!validPlan(plan))throw Error('Повреждено напоминание');
  if(plan===null){personalPlans.delete(key);await updateLocal(user.id,s=>{const previous=s.personalReminderConfigs?.[vaultId+':'+objectId];if(previous){previous.pending=true;previous.deleted=true;}});return;}
  const revisionId=crypto.randomUUID(),payload=await sealPersonalReminder(user.id,vaultId,objectId,revisionId,runtime.root,plan);personalPlans.set(key,plan);
  await updateLocal(user.id,s=>{s.personalReminderConfigs??={};s.personalReminderConfigs[vaultId+':'+objectId]={revisionId,payload,pending:true};});
}
export async function hydratePersonalReminderRuntime(userId:string){
  const runtime=getCollaborationRuntime(userId),state=await readState(userId);if(!runtime||!state)return;
  for(const [key,item] of Object.entries(state.personalReminderConfigs??{})){const split=key.indexOf(':'),vaultId=key.slice(0,split),objectId=key.slice(split+1);
    if(item.deleted){personalPlans.delete(planId(userId,vaultId,objectId));continue;}
    try{const plan=await openPersonalReminder(userId,vaultId,objectId,item.revisionId,runtime.root,item.payload);if(validPlan(plan))personalPlans.set(planId(userId,vaultId,objectId),plan);}
    catch{/* keep encrypted config; user can recover from server or another client */}}
}
export async function syncPersonalReminderConfigs(user:User,vaultId:string){
  const runtime=getCollaborationRuntime(user.id);if(!runtime)return;const remote=await collaborationRequest(user.id,'reminder-configs/'+vaultId,undefined,[vaultId]);
  if(!Array.isArray(remote.items))throw Error('Некорректные personal reminder configs');
  await updateLocal(user.id,s=>{s.personalReminderConfigs??={};for(const row of remote.items){const key=vaultId+':'+row.objectId,local=s.personalReminderConfigs[key];if(!local?.pending)s.personalReminderConfigs[key]={revisionId:row.revisionId,payload:row.payload};}});
  let state=await readState(user.id);for(const [key,item] of Object.entries(state?.personalReminderConfigs??{})){if(!key.startsWith(vaultId+':')||!item.pending)continue;const objectId=key.slice(vaultId.length+1);
    if(item.deleted)await collaborationRequest(user.id,'reminder-configs/delete',{vaultId,objectId},[vaultId]);
    else await collaborationRequest(user.id,'reminder-configs/set',{vaultId,objectId,revisionId:item.revisionId,payload:item.payload},[vaultId]);
    await updateLocal(user.id,s=>{const current=s.personalReminderConfigs?.[key];if(current){if(current.deleted)delete s.personalReminderConfigs![key];else delete current.pending;}});
  }
  await hydratePersonalReminderRuntime(user.id);
}
