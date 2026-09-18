import { generateVaultKey, wrapWithPhrase, unwrapWithPhrase, type Context } from './crypto/vault.ts';
import { seal, unseal, rememberKey } from './crypto/records.ts';
import { readState, writeState, exclusive, announce, setRuntimeVaultKey, clearRuntimeVaultKey, clearRuntimeVaultKeys,
  type State, type Vault, type Header, type Revision, type ObjectState } from './storage.ts';
import { session, accountRequest, listPasskeys } from './auth.ts';
import { createSystemUnlockWrapper, generatePrfSalt, unlockSystemWrapper, updateSystemUnlockAutoLock, type AutoLockMs } from './crypto/system-unlock.ts';
import { evaluateVaultPrf, webAuthnPrfPossible } from './webauthn-prf.ts';
import type { User } from './types/auth';
import { createAccess, signAccess } from './crypto/access.ts';
import { validPlan } from '../shared/reminders.mjs';
import type { ReminderPlan } from '../shared/reminders.mjs';
import { reminderRequest } from './reminders.ts';
export interface NoteAttachment { id:string;name:string;type:string;size:number;data:string }
export interface ChecklistItem { id:string;text:string;done:boolean }
export interface TagDefinition { id:string;name:string;color:string;deleted:boolean;op:string }
export type VaultPushMode='neutral'|'title';
export type NoteLifecycleState='active'|'archived'|'trashed';
export interface NoteLifecycle { state:NoteLifecycleState;changedAt:number }
export interface Note { title: string; text: string; html?:string;attachments?:NoteAttachment[];checklist?:ChecklistItem[];tagIds?:string[];pinned?:boolean;reminder?:ReminderPlan;
  lifecycle?:NoteLifecycle;author?:{name:string;time:number} }
interface TagCatalog { kind:'tag-catalog';title:string;text:string;tags:TagDefinition[];push?:{mode:VaultPushMode;op:string} }
const id = () => crypto.randomUUID();
function automaticDeviceName(){
  const ua=navigator.userAgent;const platform=/iPhone/.test(ua)?'iPhone':/iPad/.test(ua)?'iPad':/Android/.test(ua)?'Android':/Windows/.test(ua)?'Windows':/Macintosh/.test(ua)?'Mac':'Устройство';
  const standalone=Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches)||Boolean((navigator as Navigator&{standalone?:boolean}).standalone);
  return platform==='Устройство'&&!globalThis.matchMedia?'Устройство':platform+' · '+(standalone?'PWA':'браузер');
}
function clientKind(): 'pwa'|'browser' {return Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches)||Boolean((navigator as Navigator&{standalone?:boolean}).standalone)?'pwa':'browser';}
const allHeads = (v: Vault) => { const parents = new Set(v.records.flatMap(r => [r.parent,...(r.resolves??[])])); return v.records.filter(r => !parents.has(r.id)); };
export const heads = (v: Vault) => allHeads(v).filter(r=>r.objectId!==v.header.id);
const catalogHeads=(v:Vault)=>allHeads(v).filter(r=>r.objectId===v.header.id);
export const DEFAULT_TAGS:ReadonlyArray<TagDefinition>=Object.freeze([
  ['10000000-0000-4000-8000-000000000001','Работа','#356AE6'],['10000000-0000-4000-8000-000000000002','Личное','#8B5CF6'],
  ['10000000-0000-4000-8000-000000000003','Важное','#E24A4A'],['10000000-0000-4000-8000-000000000004','Идеи','#D68A00'],
  ['10000000-0000-4000-8000-000000000005','Покупки','#159A76'],['10000000-0000-4000-8000-000000000006','Учёба','#2878B8'],
  ['10000000-0000-4000-8000-000000000007','Здоровье','#2F9E44'],['10000000-0000-4000-8000-000000000008','Финансы','#6D7C32'],
  ['10000000-0000-4000-8000-000000000009','Путешествия','#C056A1'],
].map(([tagId,name,color])=>Object.freeze({id:tagId,name,color,deleted:false,op:'000000000000-default'})));
export const context = (user: string, v: Header, objectId: string, revisionId: string): Context =>
  ({ accountId: user, vaultId: v.id, keyId: v.keyId, objectId, revisionId });
function validAttachment(item:unknown):item is NoteAttachment{
  return Boolean(item&&typeof item==='object'&&'id'in item&&typeof item.id==='string'
    &&'name'in item&&typeof item.name==='string'&&item.name.length<=200&&'type'in item&&typeof item.type==='string'&&item.type.length<=100
    &&'size'in item&&typeof item.size==='number'&&Number.isSafeInteger(item.size)&&item.size>=0&&item.size<=512*1024&&'data'in item&&typeof item.data==='string'
    &&item.data.length<=700000&&/^data:[^;,]{1,100};base64,[A-Za-z0-9+/=]+$/.test(item.data));
}
function note(value: unknown): Note {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string'
    || !('text' in value) || typeof value.text !== 'string') throw Error('Повреждённая заметка');
  const author='author' in value?value.author:undefined;
  const reminder='reminder'in value?value.reminder:undefined;
  const html='html'in value?value.html:undefined;
  const attachments='attachments'in value?value.attachments:undefined;
  const checklist='checklist'in value?value.checklist:undefined;
  const tagIds='tagIds'in value?value.tagIds:undefined;
  const pinned='pinned'in value?value.pinned:undefined;
  const lifecycle='lifecycle'in value?value.lifecycle:undefined;
  if(reminder!==undefined&&!validPlan(reminder))throw Error('Повреждено напоминание');
  if(html!==undefined&&typeof html!=='string')throw Error('Повреждено форматирование заметки');
  if(attachments!==undefined&&(!Array.isArray(attachments)||attachments.length>15||!attachments.every(validAttachment)
    ||attachments.reduce((sum,item)=>sum+item.size,0)>512*1024))throw Error('Повреждены вложения заметки');
  if(checklist!==undefined&&(!Array.isArray(checklist)||checklist.length>500||!checklist.every(item=>item&&typeof item==='object'
    &&'id'in item&&typeof item.id==='string'&&item.id.length<=100&&'text'in item&&typeof item.text==='string'&&item.text.length<=1000
    &&'done'in item&&typeof item.done==='boolean')))throw Error('Повреждён чек-лист заметки');
  if(tagIds!==undefined&&(!Array.isArray(tagIds)||tagIds.length>100||!tagIds.every(item=>typeof item==='string'&&item.length<=100)
    ||new Set(tagIds).size!==tagIds.length))throw Error('Повреждены теги заметки');
  if(pinned!==undefined&&typeof pinned!=='boolean')throw Error('Повреждён признак закрепления заметки');
  if(lifecycle!==undefined&&(!lifecycle||typeof lifecycle!=='object'||!('state'in lifecycle)||!['active','archived','trashed'].includes(String(lifecycle.state))
    ||!('changedAt'in lifecycle)||!Number.isSafeInteger(lifecycle.changedAt)))throw Error('Повреждён жизненный цикл заметки');
  return { title: value.title, text: value.text, ...(html!==undefined?{html}:{}), ...(attachments?{attachments:attachments as NoteAttachment[]}:{}),
    ...(checklist?{checklist:checklist as ChecklistItem[]}:{}),...(tagIds?{tagIds:tagIds as string[]}:{}),...(pinned!==undefined?{pinned}:{}),
    ...(reminder?{reminder}:{}),...(lifecycle?{lifecycle:lifecycle as NoteLifecycle}:{}), ...(author&&typeof author==='object'&&'name'in author&&typeof author.name==='string'&&'time'in author&&Number.isSafeInteger(author.time)
    ?{author:author as {name:string;time:number}}:{}) };
}
export async function readNote(user: string, v: Vault, r: Revision): Promise<Note> {
  if (!v.key) throw Error('Откройте хранилище');
  const value=await unseal(v.key, context(user, v.header, r.objectId, r.id), r.parent, r.sealed) as Note&{resolves?:string[]};
  if(JSON.stringify(value.resolves??[])!==JSON.stringify(r.resolves??[]))throw Error('Повреждена связь конфликтующих версий');
  return note(value);
}
function validTag(value:unknown):value is TagDefinition{return Boolean(value&&typeof value==='object'&&'id'in value&&typeof value.id==='string'&&value.id.length<=100
  &&'name'in value&&typeof value.name==='string'&&value.name.trim()&&value.name.length<=60&&'color'in value&&typeof value.color==='string'&&/^#[0-9A-Fa-f]{6}$/.test(value.color)
  &&'deleted'in value&&typeof value.deleted==='boolean'&&'op'in value&&typeof value.op==='string'&&value.op.length<=100);}
async function readCatalogRevision(user:string,v:Vault,r:Revision):Promise<TagCatalog|null>{
  if(!v.key)throw Error('Откройте хранилище');
  const value=await unseal(v.key,context(user,v.header,r.objectId,r.id),r.parent,r.sealed) as Partial<TagCatalog>&{resolves?:string[]};
  if(JSON.stringify(value.resolves??[])!==JSON.stringify(r.resolves??[]))throw Error('Повреждена связь версий каталога тегов');
  // A previous PWA may save the compatibility note. Its parent still keeps the real catalog recoverable.
  if(value.kind!=='tag-catalog'){
    if(typeof value.title==='string'&&typeof value.text==='string')return null;
    throw Error('Повреждён каталог тегов');
  }
  if(typeof value.title!=='string'||typeof value.text!=='string'||!Array.isArray(value.tags)||value.tags.length>500||!value.tags.every(validTag)
    ||value.push!==undefined&&(!value.push||!['neutral','title'].includes(value.push.mode!)||typeof value.push.op!=='string'||value.push.op.length>100))throw Error('Повреждён каталог тегов');
  return {kind:'tag-catalog',title:value.title,text:value.text,tags:value.tags,...(value.push?{push:value.push as {mode:VaultPushMode;op:string}}:{})};
}
async function readCatalog(user:string,v:Vault):Promise<{tags:TagDefinition[];push:{mode:VaultPushMode;op:string}}>{
  const versions=(await Promise.all(v.records.filter(r=>r.objectId===v.header.id).map(r=>readCatalogRevision(user,v,r)))).filter((value):value is TagCatalog=>Boolean(value));
  const merged=new Map(DEFAULT_TAGS.map(tag=>[tag.id,{...tag}]));
  let push:{mode:VaultPushMode;op:string}={mode:'neutral',op:'000000000000-default'};
  for(const catalog of versions)for(const tag of catalog.tags){const previous=merged.get(tag.id);
    if(!previous||tag.deleted&&!previous.deleted||tag.deleted===previous.deleted&&tag.op>previous.op)merged.set(tag.id,{...tag});}
  for(const catalog of versions)if(catalog.push&&catalog.push.op>push.op)push={...catalog.push};
  return {tags:[...merged.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru')),push};
}
export async function readTags(user:string,v:Vault):Promise<TagDefinition[]>{return(await readCatalog(user,v)).tags;}
export async function readVaultPushMode(user:string,v:Vault):Promise<VaultPushMode>{return(await readCatalog(user,v)).push.mode;}
export async function vaultName(user: string, v: Vault) {
  if (!v.key) return v.displayName ? v.displayName+' (закрыто)' : 'Название ещё не синхронизировано (закрыто) · ' + v.header.id.slice(0, 8);
  const result = await unseal(v.key, context(user, v.header, v.header.id, v.header.revisionId), null, v.header.name);
  if (typeof result !== 'string') throw Error('Повреждённое имя хранилища'); return result;
}
export async function edit<T>(user: User, fn: (s: State) => Promise<T>): Promise<T> {
  return exclusive(async () => {
    const s = await readState(user.id) ?? { user, vaults: [], stash: [] };
    s.deviceId??=id();s.deviceName??='Устройство';
    const result = await fn(s); s.user = user; await writeState(s); announce(); return result;
  });
}
function vault(s: State, vid: string, open = true) {
  const v = s.vaults.find(v => v.header.id === vid);
  if (!v || (open && !v.key)) throw Error('Откройте хранилище'); return v;
}
export function vaultEntryMode(v:Pick<Vault,'key'|'systemUnlock'>):'open'|'system'|'phrase'{return v.key?'open':v.systemUnlock?'system':'phrase';}
function phraseCheck(phrase: string) {
  if (Array.from(phrase).length < 6 || new TextEncoder().encode(phrase).length > 4096) throw Error('Фраза: минимум 6 символов, максимум 4096 байт.');
}
async function makeVault(user: string, name: string, phrase: string): Promise<Vault> {
  phraseCheck(phrase); if (!name.trim() || name.length > 200) throw Error('Название: от 1 до 200 символов');
  const key = await generateVaultKey(), v = { id: id(), keyId: id(), revisionId: id() };
  const ctx = { accountId: user, vaultId: v.id, keyId: v.keyId, objectId: v.keyId, revisionId: v.revisionId };
  const header: Header = { ...v, wrapper: await wrapWithPhrase(key, ctx, phrase),
    name: await seal(key, { ...ctx, objectId: v.id }, null, name) };
  return { header, displayName:name, key: await rememberKey(key), records: [], pending: true };
}
export const createVault = (user: User, name: string, phrase: string) => edit(user, async s => {
  const v = await makeVault(user.id, name, phrase); s.vaults.push(v); return v.header.id;
});
export const openVault = (user: User, vid: string, phrase: string) => edit(user, async s => {
  const v = vault(s, vid, false);
  try { v.key = await rememberKey(await unwrapWithPhrase(context(user.id, v.header, v.header.keyId, v.header.revisionId), phrase, v.header.wrapper));
    v.displayName=await vaultName(user.id, v);
  } catch { delete v.key; throw Error('Неверная фраза или повреждённые данные.'); }
  if (v.deleted) await stashDeleted(s, v);
  else {for(const objectId of v.purgedObjects??[])await stashPurgedObject(s,v,objectId);v.purgedObjects=[];v.needsGrant=true;}
});
export const closeVault = (user: User, vid: string) => edit(user, async s => {
  const v = vault(s, vid); if (v.transfer) throw Error('Сначала завершите перенос');
  if (v.deleted) await stashDeleted(s, v);
  clearRuntimeVaultKey(user.id,vid);delete v.key;delete v.systemUnlock;delete v.grant;v.needsGrant=false;
});
export const lockVault = (user:User,vid:string) => edit(user,async s=>{
  const v=vault(s,vid,false);if(!v.systemUnlock)throw Error('Системная разблокировка не включена');
  clearRuntimeVaultKey(user.id,vid);delete v.key;
});
export const forgetSystemUnlock = (user:User,vid:string) => edit(user,async s=>{
  const v=vault(s,vid,false);if(!v.systemUnlock)return;
  clearRuntimeVaultKey(user.id,vid);delete v.key;delete v.systemUnlock;
});
const systemContext=(userId:string,v:Vault)=>({accountId:userId,vaultId:v.header.id,keyId:v.header.keyId});
export async function enableSystemUnlock(user:User,vid:string,phrase:string,autoLockMs:AutoLockMs=900_000){
  phraseCheck(phrase);if(!webAuthnPrfPossible())throw Error('Системная WebAuthn-разблокировка недоступна в этом браузере.');
  const initial=await readState(user.id),v=initial?.vaults.find(v=>v.header.id===vid);if(!v||v.deleted)throw Error('Хранилище не найдено');
  let root:CryptoKey;try{root=await unwrapWithPhrase(context(user.id,v.header,v.header.keyId,v.header.revisionId),phrase,v.header.wrapper);}
  catch{throw Error('Неверная фраза или повреждённые данные.');}
  const passkeys=await listPasskeys();if(!passkeys.length)throw Error('Сначала добавьте ключ доступа в настройках аккаунта.');
  const prfSalt=generatePrfSalt(),evaluation=await evaluateVaultPrf(passkeys,prfSalt);
  try{
    const wrapper=await createSystemUnlockWrapper(root,systemContext(user.id,v),evaluation.credentialId,prfSalt,evaluation.output,v.epoch??0,autoLockMs);
    const runtime=await rememberKey(root);
    await edit(user,async s=>{const current=vault(s,vid,false);if(current.header.keyId!==v.header.keyId||current.header.revisionId!==v.header.revisionId||(current.epoch??0)!==(v.epoch??0))throw Error('Хранилище изменилось. Повторите включение.');
      current.systemUnlock=wrapper;current.key=runtime;setRuntimeVaultKey(user.id,vid,runtime);});
  }finally{evaluation.output.fill(0);}
}
export async function unlockVaultSystem(user:User,vid:string){
  const state=await readState(user.id),v=state?.vaults.find(v=>v.header.id===vid);if(!v?.systemUnlock)throw Error('Системная разблокировка не настроена.');
  if(v.systemUnlock.lockEpoch!==(v.epoch??0))throw Error('Локальная системная разблокировка отозвана. Введите фразу хранилища.');
  const wrapper=v.systemUnlock,evaluation=await evaluateVaultPrf([{credentialId:wrapper.credentialId}],wrapper.prfSalt);
  try{if(evaluation.credentialId!==wrapper.credentialId)throw Error('Использован другой ключ доступа.');
    const key=await unlockSystemWrapper(systemContext(user.id,v),wrapper,evaluation.output,v.epoch??0);
    await edit(user,async s=>{const current=vault(s,vid,false);if(JSON.stringify(current.systemUnlock)!==JSON.stringify(wrapper)||(current.epoch??0)!==(v.epoch??0))throw Error('Настройки хранилища изменились.');
      current.key=key;setRuntimeVaultKey(user.id,vid,key);if(!current.deleted){current.needsGrant=true;for(const objectId of current.purgedObjects??[])await stashPurgedObject(s,current,objectId);current.purgedObjects=[];}});
  }finally{evaluation.output.fill(0);}
}
export async function setSystemAutoLock(user:User,vid:string,value:AutoLockMs){
  const state=await readState(user.id),v=state?.vaults.find(v=>v.header.id===vid);if(!v?.systemUnlock)throw Error('Системная разблокировка не включена');
  const wrapper=v.systemUnlock,evaluation=await evaluateVaultPrf([{credentialId:wrapper.credentialId}],wrapper.prfSalt);
  try{if(evaluation.credentialId!==wrapper.credentialId)throw Error('Использован другой ключ доступа.');
    const updated=await updateSystemUnlockAutoLock(systemContext(user.id,v),wrapper,evaluation.output,v.epoch??0,value);
    await edit(user,async s=>{const current=vault(s,vid,false);if(JSON.stringify(current.systemUnlock)!==JSON.stringify(wrapper)||(current.epoch??0)!==(v.epoch??0))throw Error('Настройки хранилища изменились.');current.systemUnlock=updated;});
  }finally{evaluation.output.fill(0);}
}
async function addRevision(user: string, v: Vault, objectId: string, parent: string | null, value: Note) {
  if (!v.key || v.deleted || v.transfer) throw Error('Хранилище недоступно для записи');
  const rid = id(), r: Revision = { id: rid, objectId, parent, sealed: await seal(v.key, context(user, v.header, objectId, rid), parent, value), pending: true, reminderPending:true };
  v.records.push(r); return r;
}
function oneHead(v:Vault,objectId:string){
  const versions=heads(v).filter(r=>r.objectId===objectId);if(versions.length!==1)throw Error('Сначала разрешите конфликт версий заметки.');return versions[0];
}
function lifecycleExpected(v:Vault,objectId:string){
  const pending=v.records.filter(r=>r.objectId===objectId&&r.lifecyclePending).at(-1);return pending?.id??v.objectStates?.[objectId]?.recordId??null;
}
export const noteLifecycle=(v:Vault,r:Revision,value:Note):NoteLifecycleState=>{
  if(v.purgePending?.includes(r.objectId)||v.purgedObjects?.includes(r.objectId))return'trashed';
  const pending=v.records.filter(item=>item.objectId===r.objectId&&item.lifecyclePending).at(-1)?.lifecyclePending;
  if(pending)return pending.state==='trash'?'trashed':'active';
  if(v.objectStates?.[r.objectId]?.state==='trash')return'trashed';
  return value.lifecycle?.state??'active';
};
export const archiveNote=(user:User,vid:string,objectId:string)=>edit(user,async s=>{
  const v=vault(s,vid),current=oneHead(v,objectId),value=await readNote(user.id,v,current);
  if(noteLifecycle(v,current,value)!=='active')throw Error('Заметка уже перемещена.');
  const reminder=value.reminder?{...value.reminder,state:'off' as const}:undefined;
  await addRevision(user.id,v,objectId,current.id,{...value,lifecycle:{state:'archived',changedAt:Date.now()},reminder,author:{name:s.deviceName??'Устройство',time:Date.now()}});
});
export const restoreArchivedNote=(user:User,vid:string,objectId:string,resumeReminder:boolean)=>edit(user,async s=>{
  const v=vault(s,vid),current=oneHead(v,objectId),value=await readNote(user.id,v,current);
  if(noteLifecycle(v,current,value)!=='archived')throw Error('Заметка не находится в архиве.');
  const reminder=value.reminder?{...value.reminder,state:resumeReminder?'active' as const:'off' as const}:undefined;
  await addRevision(user.id,v,objectId,current.id,{...value,lifecycle:{state:'active',changedAt:Date.now()},reminder,author:{name:s.deviceName??'Устройство',time:Date.now()}});
});
export const trashNote=(user:User,vid:string,objectId:string)=>edit(user,async s=>{
  const v=vault(s,vid),current=oneHead(v,objectId),value=await readNote(user.id,v,current);
  if(noteLifecycle(v,current,value)==='trashed')throw Error('Заметка уже находится в корзине.');
  const reminder=value.reminder?{...value.reminder,state:'off' as const}:undefined,expected=lifecycleExpected(v,objectId);
  const created=await addRevision(user.id,v,objectId,current.id,{...value,lifecycle:{state:'trashed',changedAt:Date.now()},reminder,author:{name:s.deviceName??'Устройство',time:Date.now()}});
  created.lifecyclePending={state:'trash',expected};
});
export const restoreTrashedNote=(user:User,vid:string,objectId:string)=>edit(user,async s=>{
  const v=vault(s,vid),current=oneHead(v,objectId),value=await readNote(user.id,v,current);
  if(noteLifecycle(v,current,value)!=='trashed')throw Error('Заметка не находится в корзине.');
  const expected=lifecycleExpected(v,objectId),reminder=value.reminder?{...value.reminder,state:'off' as const}:undefined;
  const created=await addRevision(user.id,v,objectId,current.id,{...value,lifecycle:{state:'active',changedAt:Date.now()},reminder,author:{name:s.deviceName??'Устройство',time:Date.now()}});
  created.lifecyclePending={state:'active',expected};v.purgePending=(v.purgePending??[]).filter(id=>id!==objectId);
});
export const permanentlyDeleteNote=(user:User,vid:string,objectId:string)=>edit(user,async s=>{
  const v=vault(s,vid),current=oneHead(v,objectId),value=await readNote(user.id,v,current);
  if(noteLifecycle(v,current,value)!=='trashed')throw Error('Сначала переместите заметку в корзину.');
  v.purgePending??=[];if(!v.purgePending.includes(objectId))v.purgePending.push(objectId);
});
export const noteHistory=async(user:string,v:Vault,objectId:string)=>Promise.all(v.records.filter(r=>r.objectId===objectId).map(async revision=>({revision,note:await readNote(user,v,revision)})));
export const restoreNoteVersion=(user:User,vid:string,objectId:string,revisionId:string)=>edit(user,async s=>{
  const v=vault(s,vid),current=oneHead(v,objectId),selected=v.records.find(r=>r.objectId===objectId&&r.id===revisionId);
  if(!selected)throw Error('Версия больше не доступна.');const previous=await readNote(user.id,v,selected),present=await readNote(user.id,v,current);
  const {author:_,lifecycle:__,reminder:oldReminder,...contents}=previous;
  const reminder=oldReminder?{...oldReminder,id:id(),state:'off' as const}:undefined;
  await addRevision(user.id,v,objectId,current.id,{...contents,...(reminder?{reminder}:{}),lifecycle:present.lifecycle??{state:'active',changedAt:Date.now()},author:{name:s.deviceName??'Устройство',time:Date.now()}});
});
async function writeCatalog(user:string,v:Vault,tags:TagDefinition[],push:{mode:VaultPushMode;op:string}){
  if(!v.key||v.deleted||v.transfer)throw Error('Хранилище недоступно для записи');
  const versions=catalogHeads(v),parent=versions[0]?.id??null,resolves=versions.slice(1).map(r=>r.id),rid=id();
  const value={kind:'tag-catalog' as const,title:'Служебные данные тегов',text:'Обновите приложение, чтобы управлять тегами этого хранилища.',tags,push,...(resolves.length?{resolves}:{})};
  v.records.push({id:rid,objectId:v.header.id,parent,...(resolves.length?{resolves}:{}),pending:true,
    sealed:await seal(v.key,context(user,v.header,v.header.id,rid),parent,value)});
}
function nextTagOp(tags:TagDefinition[]){const generation=Math.max(0,...tags.map(tag=>Number.parseInt(tag.op.slice(0,12),10)||0))+1;return String(generation).padStart(12,'0')+'-'+id();}
function nextCatalogOp(tags:TagDefinition[],push:{op:string}){const generation=Math.max(Number.parseInt(push.op.slice(0,12),10)||0,...tags.map(tag=>Number.parseInt(tag.op.slice(0,12),10)||0))+1;return String(generation).padStart(12,'0')+'-'+id();}
async function writeTags(user:string,v:Vault,tags:TagDefinition[]){const catalog=await readCatalog(user,v);await writeCatalog(user,v,tags,catalog.push);}
export const setVaultPushMode=(user:User,vid:string,mode:VaultPushMode)=>edit(user,async s=>{
  if(!['neutral','title'].includes(mode))throw Error('Недопустимый режим push');const v=vault(s,vid),catalog=await readCatalog(user.id,v);
  await writeCatalog(user.id,v,catalog.tags,{mode,op:nextCatalogOp(catalog.tags,catalog.push)});
});
export const createTag=(user:User,vid:string,name:string,color:string)=>edit(user,async s=>{
  const v=vault(s,vid),clean=name.trim();if(!clean||clean.length>60)throw Error('Название тега: от 1 до 60 символов');
  if(!/^#[0-9A-Fa-f]{6}$/.test(color))throw Error('Выберите цвет тега');const tags=await readTags(user.id,v);
  if(tags.some(tag=>!tag.deleted&&tag.name.localeCompare(clean,'ru',{sensitivity:'accent'})===0))throw Error('Такой тег уже существует');
  const tag={id:id(),name:clean,color:color.toUpperCase(),deleted:false,op:nextTagOp(tags)};await writeTags(user.id,v,[...tags,tag]);return tag.id;
});
export const renameTag=(user:User,vid:string,tagId:string,name:string,color:string)=>edit(user,async s=>{
  const v=vault(s,vid),clean=name.trim();if(!clean||clean.length>60)throw Error('Название тега: от 1 до 60 символов');
  if(!/^#[0-9A-Fa-f]{6}$/.test(color))throw Error('Выберите цвет тега');const tags=await readTags(user.id,v),tag=tags.find(item=>item.id===tagId&&!item.deleted);
  if(!tag)throw Error('Тег уже удалён');if(tags.some(item=>item.id!==tagId&&!item.deleted&&item.name.localeCompare(clean,'ru',{sensitivity:'accent'})===0))throw Error('Такой тег уже существует');
  const op=nextTagOp(tags);await writeTags(user.id,v,tags.map(item=>item.id===tagId?{...item,name:clean,color:color.toUpperCase(),op}:item));
});
export const deleteTag=(user:User,vid:string,tagId:string)=>edit(user,async s=>{
  const v=vault(s,vid),tags=await readTags(user.id,v),tag=tags.find(item=>item.id===tagId&&!item.deleted);if(!tag)throw Error('Тег уже удалён');
  const op=nextTagOp(tags);await writeTags(user.id,v,tags.map(item=>item.id===tagId?{...item,deleted:true,op}:item));
});
export const saveNote = (user: User, vid: string, objectId: string, parent: string | null, value: Note, draftKey?: CryptoKey) => edit(user, async s => {
  const v = vault(s, vid, false); if (v.deleted) {
    await addStash(s, vid, value); return { id: parent ?? objectId, stashed: true };
  }
  // An already-open editor may finish encrypting its draft after another tab closed the vault.
  // Never persist the temporary key again or put this draft into an independently accessible stash.
  const writable = v.key ? v : { ...v, key: draftKey };
  const r = await addRevision(user.id, writable, objectId, parent, {...value,author:{name:s.deviceName??'Устройство',time:Date.now()}}); return { id: r.id, stashed: false };
});
export const copyNote=(user:User,vid:string,revisionId:string)=>edit(user,async s=>{
  const v=vault(s,vid),revision=heads(v).find(r=>r.id===revisionId);if(!revision)throw Error('Версия заметки изменилась');
  const source=await readNote(user.id,v,revision),reminder=source.reminder?{...source.reminder,id:id(),state:'off' as const}:undefined,{author:_,lifecycle:__,...contents}=source;
  const created=await addRevision(user.id,v,id(),null,{...contents,title:source.title?source.title+' — копия':'Копия заметки',pinned:false,reminder,author:{name:s.deviceName??'Устройство',time:Date.now()}});return created.id;
});
function stashContext(s: State, sid: string): Context {
  return { accountId: s.user.id, vaultId: s.user.id, keyId: s.user.id, objectId: sid, revisionId: sid };
}
async function addStash(s: State, source: string, value: Note) {
  s.stashKey ??= await rememberKey(await generateVaultKey()); const sid = id();
  s.stash.push({ id: sid, source, sealed: await seal(s.stashKey, stashContext(s, sid), null, value) });
}
export async function readStash(s: State, sid: string): Promise<Note> {
  const item = s.stash.find(r => r.id === sid); if (!item || !s.stashKey) throw Error('Заметка не найдена');
  return note(await unseal(s.stashKey, stashContext(s, sid), null, item.sealed));
}
async function stashDeleted(s: State, v: Vault) {
  if (!v.key) return;
  for (const r of heads(v).filter(r => r.pending)) await addStash(s, v.header.id, await readNote(s.user.id, v, r));
  v.records = []; delete v.key; delete v.transfer;
}
async function stashPurgedObject(s:State,v:Vault,objectId:string){
  if(!v.key){
    if(v.records.some(r=>r.objectId===objectId&&r.pending)){v.purgedObjects??=[];if(!v.purgedObjects.includes(objectId))v.purgedObjects.push(objectId);}
    else v.records=v.records.filter(r=>r.objectId!==objectId);
    v.purgePending=(v.purgePending??[]).filter(id=>id!==objectId);delete v.objectStates?.[objectId];return;
  }
  for(const r of heads(v).filter(r=>r.objectId===objectId&&r.pending))await addStash(s,v.header.id,await readNote(s.user.id,v,r));
  v.records=v.records.filter(r=>r.objectId!==objectId);v.purgePending=(v.purgePending??[]).filter(id=>id!==objectId);delete v.objectStates?.[objectId];
  v.purgedObjects=(v.purgedObjects??[]).filter(id=>id!==objectId);
}
export const moveStash = (user: User, sid: string, target: string) => edit(user, async s => {
  const value=await readStash(s,sid),{lifecycle:_,author:__,...contents}=value;
  await addRevision(user.id,vault(s,target),id(),null,{...contents,...(value.reminder?{reminder:{...value.reminder,id:id(),state:'off' as const}}:{})});
  s.stash = s.stash.filter(r => r.id !== sid);
});
export const discardStash = (user: User, sid: string) => edit(user, async s => { s.stash = s.stash.filter(r => r.id !== sid); });
export const discardPurgedObjects=(user:User,vid:string)=>edit(user,async s=>{
  const v=vault(s,vid,false),objects=new Set(v.purgedObjects??[]);v.records=v.records.filter(r=>!objects.has(r.objectId));v.purgedObjects=[];
});
export const renameDevice=(user:User,name:string)=>edit(user,async s=>{
  if(!name.trim()||name.length>80)throw Error('Название устройства: от 1 до 80 символов');s.deviceName=name.trim();s.deviceNameDirty=true;
});
export const resolveConflict=(user:User,vid:string,objectId:string,expected:string[],chosen:string,keepBoth:boolean)=>edit(user,async s=>{
  const v=vault(s,vid),versions=heads(v).filter(r=>r.objectId===objectId);
  if(v.deleted||v.transfer||versions.length<2||versions.length>101||JSON.stringify(versions.map(r=>r.id).sort())!==JSON.stringify([...expected].sort()))throw Error('Набор версий изменился. Откройте сравнение заново.');
  const selected=versions.find(r=>r.id===chosen);if(!selected)throw Error('Выберите версию');
  const others=versions.filter(r=>r.id!==chosen),resolves=others.map(r=>r.id);
  const author={name:s.deviceName??'Устройство',time:Date.now()};
  const rid=id(),value=await readNote(user.id,v,selected);
  v.records.push({id:rid,objectId,parent:chosen,resolves,pending:true,reminderPending:true,
    sealed:await seal(v.key!,context(user.id,v.header,objectId,rid),chosen,{...value,author,resolves})});
  if(keepBoth)for(const r of others){const copy=await readNote(user.id,v,r),{lifecycle:_,author:__,...contents}=copy;
    await addRevision(user.id,v,id(),null,{...contents,...(copy.reminder?{reminder:{...copy.reminder,id:id(),state:'off' as const}}:{}),author});}
});
export const transferVault = (user: User, source: string, name: string, phrase: string) => edit(user, async s => {
  const v = vault(s, source); if (v.deleted || v.transfer) throw Error('Перенос уже начат или хранилище удалено');
  const target = await makeVault(user.id, name, phrase);
  for (const r of heads(v)){const copy=await readNote(user.id,v,r),created=await addRevision(user.id,target,id(),null,{...copy,...(copy.reminder?{reminder:{...copy.reminder,id:id(),state:'off' as const}}:{})});
    if(copy.lifecycle?.state==='trashed')created.lifecyclePending={state:'trash',expected:null};}
  if(catalogHeads(v).length){const catalog=await readCatalog(user.id,v);await writeCatalog(user.id,target,catalog.tags,catalog.push);}
  s.vaults.push(target); v.transfer = { target: target.header.id, revisions: target.records.map(r => r.id) };
  return target.header.id;
});
class APIError extends Error {
  code: string;
  constructor(code: string) {
    super(({ record_limit: 'Достигнут лимит хранилища (10000 версий или 64 МиБ). Перенесите актуальные заметки в новое хранилище.',
      vault_limit: 'Достигнут лимит 100 хранилищ.', account_mismatch: 'Аккаунт изменился. Войдите в нужный аккаунт для синхронизации.',
      unauthorized: 'Для синхронизации войдите в аккаунт.', rate_limited: 'Слишком много запросов. Синхронизация продолжится позже.',
      id_conflict: 'Сервер обнаружил несовпадение версии. Локальные данные сохранены.',
      missing_parent: 'Предыдущая версия пока не найдена на сервере. Локальные данные сохранены.',
      vault_locked:'Хранилище закрыто на всех устройствах. Введите фразу заново для синхронизации.',
      wrong_password:'Неверный пароль аккаунта.',access_not_ready:'Сначала откройте хранилище и синхронизируйте его.',
      object_deleted:'Заметка окончательно удалена на другом устройстве.',object_state_conflict:'Состояние заметки изменилось на другом устройстве. Синхронизируйте и повторите действие.',
    } as Record<string, string>)[code] ?? 'Не удалось синхронизировать данные (' + code + '). Локальная копия сохранена.');
    this.code = code;
  }
}
async function vaultRequest(account: string, path: string, body?: unknown, credentials?:{deviceId?:string;grants:Record<string,string>}): Promise<any> {
  const headers: Record<string, string> = { 'X-Tasks-Account': account,
    ...(credentials?{'X-Tasks-Device':credentials.deviceId??'','X-Vault-Grants':JSON.stringify(credentials.grants)}:{}) };
  if (body !== undefined) {
    const r = await fetch('/api/auth/csrf', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new APIError('csrf'); const c = await r.json();
    headers['X-CSRF-Token'] = c.csrf; headers['Content-Type'] = 'application/json';
  }
  const r = await fetch('/api/vaults' + path, { method: body === undefined ? 'GET' : 'POST', headers, cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const value = await r.json(); if (!r.ok) throw new APIError(value.error ?? 'network'); return value;
}
// Only short local transactions use the data lock. The network lock does not block typing/saving.
async function commit(user:User,fn:(s:State)=>Promise<void>){
  await exclusive(async()=>{const s=await readState(user.id);if(!s)throw Error('Локальный аккаунт закрыт');await fn(s);await writeState(s);announce();});
}
const wire=(r:Revision)=>{const{pending:_,reminderPending:__,lifecyclePending:___,...value}=r;return value;};
function lock(v:Vault,epoch?:number,accountId?:string){if(accountId)clearRuntimeVaultKey(accountId,v.header.id);delete v.key;delete v.grant;v.needsGrant=false;if(epoch!==undefined){if(v.systemUnlock&&v.systemUnlock.lockEpoch!==epoch)delete v.systemUnlock;v.epoch=epoch;}}
const accessContext=(user:string,v:Vault)=>context(user,v.header,v.header.keyId,v.header.keyId);
async function grantForOpenVault(user:User,vid:string){
  const actor=await session();if(actor?.id!==user.id)throw Error('Войдите в этот аккаунт');
  await commit(user,async s=>{s.deviceId??=id();});
  let state=await readState(user.id),v=state?.vaults.find(v=>v.header.id===vid);
  if(!state||!v||v.deleted||!v.key)throw Error('Сначала откройте хранилище');
  if(v.transfer)throw Error('Сначала завершите перенос');
  let pack=v.access;
  if(!pack){
    pack=await createAccess(v.key,accessContext(user.id,v));
    const result=await vaultRequest(user.id,'/access/setup',{vaultId:vid,pack});pack=result.pack;
    await commit(user,async s=>{vault(s,vid,false).access=pack;});
    state=await readState(user.id);v=state?.vaults.find(v=>v.header.id===vid);
    if(!state||!v?.key)throw Error('Хранилище было закрыто во время операции');
  }
  const challenge=await vaultRequest(user.id,'/access/challenge',{vaultId:vid,deviceId:state.deviceId}),c=challenge.challenge;
  if(!Array.isArray(c)||c.length!==8||c[0]!=='tasks-vault-access'||c[1]!==1||c[2]!==user.id||c[3]!==vid||c[4]!==(v.epoch??0)||c[5]!==state.deviceId)throw new APIError('vault_locked');
  const signature=await signAccess(v.key,accessContext(user.id,v),pack!,c);
  const granted=await vaultRequest(user.id,'/access/grant',{vaultId:vid,deviceId:state.deviceId,challengeId:c[6],signature});
  await commit(user,async s=>{const current=vault(s,vid,false);current.grant=granted.token;current.needsGrant=false;});
  return{deviceId:state.deviceId!,token:granted.token as string};
}
export async function deleteVault(user:User,vid:string){
  const initial=await readState(user.id),current=initial?.vaults.find(v=>v.header.id===vid);
  if(!initial||!current||current.deleted)throw Error('Хранилище не найдено');
  if(!current.key)throw Error('Удалить можно только открытое на этом устройстве хранилище');
  if(current.transfer)throw Error('Сначала завершите перенос');
  if(current.pending){
    clearRuntimeVaultKey(user.id,vid);await commit(user,async s=>{s.vaults=s.vaults.filter(v=>v.header.id!==vid);s.reminderSeen=(s.reminderSeen??[]).filter(item=>item.vaultId!==vid);if(s.lastVaultId===vid)delete s.lastVaultId;});return;
  }
  let grant=initial.deviceId&&current.grant?{deviceId:initial.deviceId,token:current.grant}:await grantForOpenVault(user,vid);
  try{await vaultRequest(user.id,'/delete',{vaultId:vid,confirmed:true},{deviceId:grant.deviceId,grants:{[vid]:grant.token}});}
  catch(error){
    if(!(error instanceof APIError)||error.code!=='vault_locked')throw error;
    grant=await grantForOpenVault(user,vid);
    await vaultRequest(user.id,'/delete',{vaultId:vid,confirmed:true},{deviceId:grant.deviceId,grants:{[vid]:grant.token}});
  }
  clearRuntimeVaultKey(user.id,vid);
  await commit(user,async s=>{s.vaults=s.vaults.filter(v=>v.header.id!==vid);s.reminderSeen=(s.reminderSeen??[]).filter(item=>item.vaultId!==vid);if(s.lastVaultId===vid)delete s.lastVaultId;});
}
export async function closeAllVault(user:User,vid:string,password:string){
  const actor=await session();if(actor?.id!==user.id)throw Error('Войдите в этот аккаунт');
  let operationId='';
  await commit(user,async s=>{const v=vault(s,vid,false);if(v.pending||!v.access)throw Error('Сначала синхронизируйте открытое хранилище');
    if(v.transfer)throw Error('Сначала завершите перенос');
    if(!v.closeOperation){v.closeOperation=id();v.closeBaseEpoch=v.epoch??0;}operationId=v.closeOperation;});
  const result=await vaultRequest(user.id,'/close-all',{vaultId:vid,operationId,password,confirmed:true});
  await commit(user,async s=>{const v=vault(s,vid,false);lock(v,result.epoch,user.id);delete v.closeOperation;delete v.closeBaseEpoch;});
}
export class OutboxReviewRequired extends Error { constructor(){super('Требуется проверка локальных изменений перед синхронизацией.');} }
export interface OutboxReviewItem { key:string;vaultId:string;objectId:string;kind:'change'|'purge';local?:Note;server?:Note;serverState:'present'|'missing'|'deleted'|'conflict'|'locked' }
const reviewKey=(vaultId:string,objectId:string)=>vaultId+':'+objectId;
function reviewKeys(s:State){const keys=new Set<string>();for(const v of s.vaults){for(const r of v.records)if(r.pending&&r.objectId!==v.header.id)keys.add(reviewKey(v.header.id,r.objectId));for(const objectId of v.purgePending??[])keys.add(reviewKey(v.header.id,objectId));}return keys;}
export async function requireOutboxReview(user:User){
  await exclusive(async()=>{const s=await readState(user.id);if(!s)return;s.sessionReviewRequired=true;s.reviewAccepted??=[];s.deviceRegistered=false;await writeState(s);announce();});
}
function remoteHeads(v:Vault,objectId:string){const records=v.records.filter(r=>r.objectId===objectId&&!r.pending),parents=new Set(records.flatMap(r=>[r.parent,...(r.resolves??[])]));return records.filter(r=>!parents.has(r.id));}
export async function outboxReviewItems(user:User):Promise<OutboxReviewItem[]>{
  const s=await readState(user.id);if(!s?.sessionReviewRequired)return[];const accepted=new Set(s.reviewAccepted??[]),items:OutboxReviewItem[]=[];
  for(const v of s.vaults){const objectIds=new Set<string>();for(const r of v.records)if(r.pending&&r.objectId!==v.header.id)objectIds.add(r.objectId);for(const objectId of v.purgePending??[])objectIds.add(objectId);
    for(const objectId of objectIds){const key=reviewKey(v.header.id,objectId);if(accepted.has(key))continue;const purge=Boolean(v.purgePending?.includes(objectId));
      const localHead=heads(v).filter(r=>r.objectId===objectId&&r.pending).at(-1),serverHeads=remoteHeads(v,objectId);let local:Note|undefined,server:Note|undefined;
      if(v.key){if(localHead)local=await readNote(user.id,v,localHead);if(serverHeads.length===1)server=await readNote(user.id,v,serverHeads[0]);}
      items.push({key,vaultId:v.header.id,objectId,kind:purge?'purge':'change',...(local?{local}:{}),...(server?{server}:{}),serverState:v.deleted?'deleted':!v.key?'locked':serverHeads.length>1?'conflict':serverHeads.length===1?'present':'missing'});
    }}return items;
}
export async function decideOutboxReview(user:User,key:string,accept:boolean){
  let finished=false;await commit(user,async s=>{if(!s.sessionReviewRequired)throw Error('Проверка уже завершена');const split=key.indexOf(':');if(split<1)throw Error('Некорректное изменение');
    const vaultId=key.slice(0,split),objectId=key.slice(split+1),v=s.vaults.find(v=>v.header.id===vaultId);if(!v)throw Error('Хранилище не найдено');s.reviewAccepted??=[];
    if(accept){if(!s.reviewAccepted.includes(key))s.reviewAccepted.push(key);}else{v.records=v.records.filter(r=>r.objectId!==objectId||!r.pending);v.purgePending=(v.purgePending??[]).filter(id=>id!==objectId);}
    const accepted=new Set(s.reviewAccepted),remaining=[...reviewKeys(s)].filter(item=>!accepted.has(item));if(!remaining.length){s.sessionReviewRequired=false;s.reviewAccepted=[];finished=true;}
  });return finished;
}
export async function acknowledgeReminder(user:User,target:{vaultId:string;objectId:string;configId:string;occurrenceId?:string}){
  await edit(user,async s=>{s.reminderSeen??=[];if(!s.reminderSeen.some(x=>x.vaultId===target.vaultId&&x.objectId===target.objectId&&x.configId===target.configId&&x.occurrenceId===target.occurrenceId))s.reminderSeen.push(target);});
  try{
    const current=await session();if(current?.id!==user.id)return;
    const result=await reminderRequest(user,'seen',target);
    if(result.exists)await commit(user,async s=>{s.reminderSeen=(s.reminderSeen??[]).filter(x=>x.vaultId!==target.vaultId||x.objectId!==target.objectId||x.configId!==target.configId||x.occurrenceId!==target.occurrenceId);});
  }catch{/* The durable local acknowledgement is retried by synchronize(). */}
}
async function refreshOutboxReviewRemote(user:User){
  const state=await readState(user.id);if(!state?.sessionReviewRequired)return;const remote=await vaultRequest(user.id,'');if(!Array.isArray(remote.vaults))throw Error('Некорректный список хранилищ');
  const affected=new Set([...reviewKeys(state)].map(key=>key.slice(0,key.indexOf(':'))));
  for(const local of state.vaults.filter(v=>affected.has(v.header.id))){
    const item=remote.vaults.find((row:any)=>row.id===local.header.id);if(!item)continue;
    await commit(user,async s=>{const v=vault(s,local.header.id,false);if(item.deleted){v.deleted=true;return;}if(JSON.stringify(v.header)!==JSON.stringify(item.header)){v.syncError='Заголовок хранилища изменён';return;}
      const epoch=item.epoch??0;if(epoch>(v.epoch??0))lock(v,epoch,user.id);v.epoch=epoch;v.access=item.access??undefined;if(typeof item.displayName==='string')v.displayName=item.displayName;});
    if(item.deleted)continue;let currentState=await readState(user.id),currentVault=currentState?.vaults.find(v=>v.header.id===local.header.id);if(!currentState||!currentVault||currentVault.syncError)continue;
    if((currentVault.epoch??0)>0&&!currentVault.grant&&currentVault.key&&currentVault.needsGrant&&currentVault.access){
      const challenge=await vaultRequest(user.id,'/access/challenge',{vaultId:currentVault.header.id,deviceId:currentState.deviceId},{deviceId:currentState.deviceId,grants:{}}),c=challenge.challenge;
      if(!Array.isArray(c)||c.length!==8||c[5]!==currentState.deviceId)throw new APIError('vault_locked');const signature=await signAccess(currentVault.key,accessContext(user.id,currentVault),currentVault.access,c);
      const granted=await vaultRequest(user.id,'/access/grant',{vaultId:currentVault.header.id,deviceId:currentState.deviceId,challengeId:c[6],signature},{deviceId:currentState.deviceId,grants:{}});
      await commit(user,async s=>{const v=vault(s,currentVault!.header.id,false);v.grant=granted.token;v.needsGrant=false;});
    }
    let after=0;try{for(;;){const current=await readState(user.id);if(!current)break;const v=current.vaults.find(v=>v.header.id===local.header.id);if(!v)break;
      const grants:Record<string,string>={};if(v.grant)grants[v.header.id]=v.grant;const page=await vaultRequest(user.id,'/'+v.header.id+'?after='+after,undefined,{deviceId:current.deviceId,grants});
      if(!Array.isArray(page.records)||page.records.length>5)throw Error('Некорректный ответ сервера');await commit(user,async s=>{const target=vault(s,v.header.id,false);for(const r of page.records){const existing=target.records.find(x=>x.id===r.id);if(!existing)target.records.push(r);else if(JSON.stringify(wire(existing))!==JSON.stringify(r))throw Error('Версия заметки изменена на сервере');}});
      if(page.next===null)break;if(!Number.isSafeInteger(page.next)||page.next<=after)throw Error('Некорректная страница данных');after=page.next;}}
    catch(error){if(error instanceof APIError&&error.code==='vault_locked')await commit(user,async s=>lock(vault(s,local.header.id,false),undefined,user.id));else throw error;}
  }
}
export async function synchronize(user:User){
  if(!navigator.locks)throw Error('Для синхронизации нужен Web Locks');
  return navigator.locks.request('tasks-sync:'+user.id,async()=>{
    if(!await readState(user.id))return;
    const current=await session();if(current?.id!==user.id){await requireOutboxReview(user);throw Error('Для синхронизации войдите в этот аккаунт. Локальные данные сохранены.');}
    await commit(user,async s=>{s.deviceId??=id();if(!s.deviceName||s.deviceName==='Устройство')s.deviceName=automaticDeviceName();});
    const deviceState=await readState(user.id);if(deviceState?.deviceId&&deviceState.deviceName&&(!deviceState.deviceRegistered||deviceState.deviceNameDirty)){
      try{const registered=await accountRequest('devices/register',{deviceId:deviceState.deviceId,deviceName:deviceState.deviceName,clientKind:clientKind(),rename:Boolean(deviceState.deviceNameDirty)});
        if(typeof registered.deviceName==='string')await commit(user,async s=>{s.deviceName=registered.deviceName as string;s.deviceRegistered=true;delete s.deviceNameDirty;});
      }catch{/* Device metadata must never block encrypted note sync. */}
    }
    const reviewState=await readState(user.id);if(reviewState?.sessionReviewRequired){await refreshOutboxReviewRemote(user);const pending=await outboxReviewItems(user);
      if(pending.length)throw new OutboxReviewRequired();await commit(user,async s=>{s.sessionReviewRequired=false;s.reviewAccepted=[];});}
    const api=async(path:string,body?:unknown,ids:string[]=[])=>{
      const s=await readState(user.id);if(!s)throw Error('Локальный аккаунт закрыт');
      const grants:Record<string,string>={};for(const vid of ids){const v=s.vaults.find(v=>v.header.id===vid);if(v?.grant)grants[vid]=v.grant;}
      return vaultRequest(user.id,path,body,{deviceId:s.deviceId,grants});
    };
    const snapshot=async(vid:string)=>{const s=await readState(user.id);if(!s)throw Error('Локальный аккаунт закрыт');return{ s,v:vault(s,vid,false) };};
    async function fetchRecords(vid:string):Promise<Revision[]>{
      const records:Revision[]=[];let after=0;
      for(;;){const page=await api('/'+vid+'?after='+after,undefined,[vid]);
        if(!Array.isArray(page.records)||page.records.length>5||records.length+page.records.length>10000)throw Error('Некорректный ответ сервера');
        records.push(...page.records);if(page.next===null)return records;
        if(!Number.isSafeInteger(page.next)||page.next<=after)throw Error('Некорректная страница данных');after=page.next;
      }
    }
    async function fetchObjectStates(vid:string):Promise<Record<string,ObjectState>>{
      const result=await api('/'+vid+'/objects',undefined,[vid]);if(!Array.isArray(result.objects)||result.objects.length>10000)throw Error('Некорректные состояния заметок');
      const states:Record<string,ObjectState>={};for(const item of result.objects){
        if(!item||!['active','trash','purged'].includes(item.state)||typeof item.objectId!=='string'||typeof item.recordId!=='string')throw Error('Некорректное состояние заметки');
        states[item.objectId]={state:item.state,recordId:item.recordId,...(Number.isSafeInteger(item.trashedAt)?{trashedAt:item.trashedAt}:{}),...(Number.isSafeInteger(item.purgeAfter)?{purgeAfter:item.purgeAfter}:{})};
      }return states;
    }
    const failures:string[]=[];
    const remote=await api('');
    for(const item of remote.vaults){
      await commit(user,async s=>{
        let v=s.vaults.find(v=>v.header.id===item.id);
        if(item.deleted){s.reminderSeen=(s.reminderSeen??[]).filter(x=>x.vaultId!==item.id);if(v){v.deleted=true;await stashDeleted(s,v);}return;}
        if(!v){v={header:item.header,records:[]};s.vaults.push(v);}
        if(typeof item.displayName==='string'&&item.displayName.trim()&&item.displayName.length<=200)v.displayName=item.displayName;
        if(JSON.stringify(v.header)!==JSON.stringify(item.header)){v.syncError='Заголовок хранилища изменён';failures.push(v.syncError);return;}
        const epoch=item.epoch??0;
        if(epoch<(v.epoch??0))throw Error('Сервер вернул устаревшую блокировку');
        if(epoch>(v.epoch??0))lock(v,epoch,user.id);
        v.epoch=epoch;v.access=item.access??undefined;
        if(v.closeOperation&&epoch>(v.closeBaseEpoch??0)){delete v.closeOperation;delete v.closeBaseEpoch;}
      });
    }
    const ids=(await readState(user.id))?.vaults.filter(v=>!v.deleted).map(v=>v.header.id)??[];
    async function recordFailure(vid:string,error:unknown){
      await commit(user,async s=>{
        const v=vault(s,vid,false);
        if(error instanceof APIError&&error.code==='vault_deleted'){v.deleted=true;await stashDeleted(s,v);return;}
        if(error instanceof APIError&&error.code==='vault_locked')lock(v,undefined,user.id);
        v.syncError=error instanceof Error?error.message:'Ошибка синхронизации';failures.push(v.syncError);
      });
    }
    for(const vid of ids){try{
      let {s,v}=await snapshot(vid);
      const remoteHeader=remote.vaults.find((x:any)=>x.id===vid&&!x.deleted)?.header;
      if(remoteHeader&&JSON.stringify(remoteHeader)!==JSON.stringify(v.header))continue;
      if(v.pending){
        const source=s.vaults.find(x=>x.transfer?.target===vid);
        await api('/create',{...v.header,...(v.displayName?{displayName:v.displayName}:{}),...(source?{transferSource:source.header.id}:{})},source?[source.header.id]:[]);
        await commit(user,async state=>{vault(state,vid,false).pending=false;});
      }
      ({s,v}=await snapshot(vid));
      if(!v.access&&v.key){
        const pack=await createAccess(v.key,accessContext(user.id,v));
        const result=await api('/access/setup',{vaultId:vid,pack});
        await commit(user,async state=>{vault(state,vid,false).access=result.pack;});
      }
      ({s,v}=await snapshot(vid));
      if((v.epoch??0)>0&&!v.grant){
        if(!v.key||!v.needsGrant||!v.access)throw new APIError('vault_locked');
        const result=await api('/access/challenge',{vaultId:vid,deviceId:s.deviceId});
        const c=result.challenge;
        if(!Array.isArray(c)||c.length!==8||c[0]!=='tasks-vault-access'||c[1]!==1||c[2]!==user.id||c[3]!==vid||c[4]!==v.epoch||c[5]!==s.deviceId)throw new APIError('vault_locked');
        const signature=await signAccess(v.key,accessContext(user.id,v),v.access,c);
        const granted=await api('/access/grant',{vaultId:vid,deviceId:s.deviceId,challengeId:c[6],signature});
        await commit(user,async state=>{const current=vault(state,vid,false);
          if(!current.key||!current.needsGrant||current.epoch!==granted.epoch)throw new APIError('vault_locked');
          current.grant=granted.token;current.needsGrant=false;});
      }
      if(v.key&&!remote.vaults.find((item:any)=>item.id===vid)?.displayName){
        const displayName=await vaultName(user.id,v);
        await api('/label',{vaultId:vid,displayName},[vid]);
        await commit(user,async state=>{vault(state,vid,false).displayName=displayName;});
      }
      const remoteStates=await fetchObjectStates(vid);
      await commit(user,async state=>{const current=vault(state,vid,false);current.objectStates??={};
        for(const [objectId,item] of Object.entries(remoteStates)){if(item.state==='purged')await stashPurgedObject(state,current,objectId);else current.objectStates[objectId]=item;}
      });
      const incoming=await fetchRecords(vid);
      await commit(user,async state=>{
        const current=vault(state,vid,false);if(current.deleted)return;
        for(const r of incoming){const local=current.records.find(x=>x.id===r.id);
          if(!local)current.records.push(r);else{if(JSON.stringify(wire(local))!==JSON.stringify(r))throw Error('Версия заметки изменена на сервере');local.pending=false;}}
      });
      ({v}=await snapshot(vid));
      const outgoing=v.transfer?[]:v.records.filter(r=>r.pending);
      for(const r of outgoing){
        const latest=(await snapshot(vid)).v;if(latest.transfer||latest.deleted)break;
        await api('/record',{vaultId:vid,record:wire(r)},[vid]);
        await commit(user,async state=>{const local=vault(state,vid,false).records.find(x=>x.id===r.id);if(local)local.pending=false;});
      }
      ({v}=await snapshot(vid));
      for(const r of v.records.filter(r=>r.lifecyclePending)){
        const pending=r.lifecyclePending!;const result=await api('/object-state',{vaultId:vid,objectId:r.objectId,recordId:r.id,expected:pending.expected,state:pending.state},[vid]);
        await commit(user,async state=>{const current=vault(state,vid,false),local=current.records.find(item=>item.id===r.id);if(local)delete local.lifecyclePending;
          current.objectStates??={};current.objectStates[r.objectId]={state:result.object.state,recordId:result.object.recordId,...(Number.isSafeInteger(result.object.trashedAt)?{trashedAt:result.object.trashedAt}:{}),...(Number.isSafeInteger(result.object.purgeAfter)?{purgeAfter:result.object.purgeAfter}:{})};});
      }
      ({v}=await snapshot(vid));
      for(const objectId of v.purgePending??[]){const objectState=v.objectStates?.[objectId];if(!objectState)continue;
        if(objectState.state!=='purged')await api('/purge-object',{vaultId:vid,objectId,expected:objectState.recordId,confirmed:true},[vid]);
        await commit(user,async state=>{const current=vault(state,vid,false);current.records=current.records.filter(r=>r.objectId!==objectId);current.purgePending=(current.purgePending??[]).filter(id=>id!==objectId);
          current.objectStates??={};current.objectStates[objectId]={state:'purged',recordId:objectState.recordId};state.reminderSeen=(state.reminderSeen??[]).filter(item=>item.vaultId!==vid||item.objectId!==objectId);});
      }
      ({v}=await snapshot(vid));
      if(v.key){
        const pendingSeen=(await readState(user.id))?.reminderSeen?.filter(x=>x.vaultId===vid)??[];
        for(const target of pendingSeen){const current=(await snapshot(vid)).v,latest=heads(current).filter(r=>r.objectId===target.objectId);
          if(latest.length===1&&current.key){const value=await readNote(user.id,current,latest[0]);
            if(value.reminder?.id!==target.configId)await commit(user,async state=>{state.reminderSeen=(state.reminderSeen??[]).filter(x=>x.vaultId!==vid||x.objectId!==target.objectId||x.configId!==target.configId||x.occurrenceId!==target.occurrenceId);});}}
        const objects=[...new Set(v.records.filter(r=>r.reminderPending).map(r=>r.objectId))];
        for(const objectId of objects){
          const current=(await snapshot(vid)).v,latest=heads(current).filter(r=>r.objectId===objectId);
          if(latest.length!==1||!current.key)continue;
          const head=latest[0],value=await readNote(user.id,current,head);
          await reminderRequest(user,'set',{vaultId:vid,objectId,recordId:head.id,plan:value.reminder??null},[vid]);
          await commit(user,async state=>{for(const r of vault(state,vid,false).records)if(r.objectId===objectId)delete r.reminderPending;
            if(!value.reminder)state.reminderSeen=(state.reminderSeen??[]).filter(x=>x.vaultId!==vid||x.objectId!==objectId);});
        }
      }
      await commit(user,async state=>{delete vault(state,vid,false).syncError;});
    }catch(error){await recordFailure(vid,error);}}
    for(const target of (await readState(user.id))?.reminderSeen??[]){
      const result=await reminderRequest(user,'seen',target);
      if(result.exists)await commit(user,async s=>{s.reminderSeen=(s.reminderSeen??[]).filter(x=>x.vaultId!==target.vaultId||x.objectId!==target.objectId||x.configId!==target.configId||x.occurrenceId!==target.occurrenceId);});
    }
    const transfers=(await readState(user.id))?.vaults.filter(v=>v.transfer&&!v.deleted).map(v=>v.header.id)??[];
    for(const vid of transfers){try{
      const {s,v}=await snapshot(vid),transfer=v.transfer!;const target=s.vaults.find(x=>x.header.id===transfer.target);
      if(!target||target.pending||target.deleted||target.syncError||target.records.some(r=>r.reminderPending))continue;
      const received=await fetchRecords(transfer.target);
      for(const rid of transfer.revisions){const expected=target.records.find(r=>r.id===rid),actual=received.find(r=>r.id===rid);
        if(!expected||!actual||JSON.stringify(wire(expected))!==JSON.stringify(actual))throw Error('Проверка перенесённой заметки не прошла');}
      await api('/transfer',{source:vid,target:transfer.target,revisions:transfer.revisions,confirmed:true},[vid,transfer.target]);
      await commit(user,async state=>{const current=vault(state,vid,false);current.deleted=true;current.records=[];lock(current,undefined,user.id);delete current.systemUnlock;delete current.transfer;
        state.reminderSeen=(state.reminderSeen??[]).filter(x=>x.vaultId!==vid);});
    }catch(error){await recordFailure(vid,error);}}
    if(failures.length)throw Error([...new Set(failures)].join(' · '));
  });
}
export async function lockAfterBackground(user:User,durationMs:number){
  let changed=false;await exclusive(async()=>{const s=await readState(user.id);if(!s)return;
    for(const v of s.vaults){const limit=v.systemUnlock?.autoLockMs??0;if(limit>0&&durationMs>=limit&&v.key){clearRuntimeVaultKey(user.id,v.header.id);delete v.key;changed=true;}}
    if(changed)await writeState(s);});if(changed)announce('vault-lock');return changed;
}
export const hasUnsaved = (s: State) => Boolean(s.reminderSeen?.length)||s.stash.length > 0 || s.vaults.some(v => v.pending || v.transfer || Boolean(v.purgePending?.length)||Boolean(v.purgedObjects?.length)||v.records.some(r => r.pending||r.reminderPending||r.lifecyclePending));
let flushHandler: (() => Promise<void>) | undefined;
export function registerDraftFlush(fn?: () => Promise<void>) { flushHandler = fn; }
export async function flushDraft() { await flushHandler?.(); }
