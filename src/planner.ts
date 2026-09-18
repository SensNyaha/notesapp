import { generateVaultKey, wrapWithPhrase, unwrapWithPhrase, type Context } from './crypto/vault.ts';
import { seal, unseal, rememberKey } from './crypto/records.ts';
import { readState, writeState, exclusive, announce, setRuntimeVaultKey, clearRuntimeVaultKey, clearRuntimeVaultKeys,
  type State, type Vault, type Header, type Revision, type ObjectState } from './storage.ts';
import { session, accountRequest, listPasskeys } from './auth.ts';
import { createSystemUnlockWrapper, generatePrfSalt, unlockSystemWrapper, updateSystemUnlockAutoLock, type AutoLockMs } from './crypto/system-unlock.ts';
import { evaluateVaultPrf, webAuthnPrfPossible } from './webauthn-prf.ts';
import { clearVaultEpochKeys, getCollaborationRuntime, getVaultEpochKey, setVaultEpochKey } from './crypto/collaboration.ts';
import { initializeSharedVault, personalReminder, setPersonalReminderLocal, syncPersonalReminderConfigs, unlockMemberVault } from './collaboration.ts';
import type { User } from './types/auth';
import { createAccess, signAccess } from './crypto/access.ts';
import { validPlan } from '../shared/reminders.mjs';
import type { ReminderPlan } from '../shared/reminders.mjs';
import { reminderRequest } from './reminders.ts';
import { createFileKey, unwrapFileKey, rewrapFileKey, encryptFileChunk, decryptFileChunk, FILE_CHUNK_BYTES } from './crypto/files.ts';
import { normalizeDependencies,validateDependencyGraph,type GanttCalendar,type TaskDependency,type TaskDependencyType } from './gantt.ts';
export interface NoteAttachment { id:string;name:string;type:string;size:number;data?:string;storage?:'stream';wrappedKey?:string;chunks?:number;keyEpoch?:number;cryptoVaultId?:string;preview?:{type:string;size:number;chunks:number} }
export interface AttachmentUploadProgress {sent:number;total:number;percent:number}
export interface NoteCover {attachmentId:string}

export interface ChecklistItem { id:string;text:string;done:boolean }
export interface TagDefinition { id:string;name:string;color:string;deleted:boolean;op:string }
export type VaultPushMode='neutral'|'title';
export type NoteLifecycleState='active'|'archived'|'trashed';
export interface NoteLifecycle { state:NoteLifecycleState;changedAt:number }
export type PlannerEntityKind='note'|'project'|'task';
export type TaskStatus='todo'|'in_progress'|'done'|'cancelled';
export type TaskPriority='none'|'low'|'medium'|'high';
export interface ProjectMeta { favorite:boolean;startDate?:string;endDate?:string;calendar?:GanttCalendar }
export type TaskReminderAnchor='start'|'start-1d'|'end'|'end-1d';
export interface TaskMeta { status:TaskStatus;priority:TaskPriority;startDate?:string;endDate?:string;assigneeUserId?:string;dependencies?:TaskDependency[];reminderAnchor?:TaskReminderAnchor }
export type { GanttCalendar,TaskDependency,TaskDependencyType };
export interface Note { title: string; text: string; html?:string;attachments?:NoteAttachment[];cover?:NoteCover;checklist?:ChecklistItem[];tagIds?:string[];pinned?:boolean;reminder?:ReminderPlan;
  kind?:PlannerEntityKind;projectId?:string;project?:ProjectMeta;task?:TaskMeta;
  lifecycle?:NoteLifecycle;author?:{name:string;time:number};importSource?:{kind:'tasks-note-v1';vaultId:string;objectId:string} }
export interface PortableVaultRevision { revisionId:string;objectId:string;parent:string|null;resolves:string[];note:Note }
export interface PortableVaultSnapshot { format:'tasks-vault-snapshot';version:1;sourceVaultId:string;name:string;exportedAt:number;
  tags:TagDefinition[];pushMode:VaultPushMode;revisions:PortableVaultRevision[] }
interface TagCatalog { kind:'tag-catalog';title:string;text:string;tags:TagDefinition[];push?:{mode:VaultPushMode;op:string} }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
const cryptoAccount=(user:string,v:Pick<Vault,'ownerId'>)=>v.ownerId??user;
const vaultContext=(user:string,v:Vault,objectId:string,revisionId:string)=>context(cryptoAccount(user,v),v.header,objectId,revisionId);
function revisionKey(user:string,v:Vault,r:Pick<Revision,'keyEpoch'>){
  const epoch=r.keyEpoch??0,key=epoch===0?(v.key??getVaultEpochKey(user,v.header.id,0)):getVaultEpochKey(user,v.header.id,epoch);
  if(!key)throw Error('Ключ этой версии хранилища недоступен.');return key;
}
function writeKey(user:string,v:Vault){
  const epoch=v.keyring?.currentEpoch??0,key=epoch===0?(v.key??getVaultEpochKey(user,v.header.id,0)):getVaultEpochKey(user,v.header.id,epoch);
  if(!key)throw Error('Актуальный ключ совместного хранилища недоступен.');return{key,epoch};
}
function validAttachment(item:unknown):item is NoteAttachment{
  if(!item||typeof item!=='object'||!('id'in item)||typeof item.id!=='string'||!uuid.test(item.id)
    ||!('name'in item)||typeof item.name!=='string'||!item.name.trim()||item.name.length>200
    ||!('type'in item)||typeof item.type!=='string'||item.type.length>100
    ||!('size'in item)||typeof item.size!=='number'||!Number.isSafeInteger(item.size)||item.size<0)return false;
  if('storage'in item&&item.storage==='stream'){
    const preview='preview'in item?item.preview:undefined;
    return 'wrappedKey'in item&&typeof item.wrappedKey==='string'&&/^[A-Za-z0-9_-]{54}$/.test(item.wrappedKey)
      &&'chunks'in item&&typeof item.chunks==='number'&&Number.isSafeInteger(item.chunks)&&item.chunks>=1&&item.chunks<=1_000_000
      &&'keyEpoch'in item&&typeof item.keyEpoch==='number'&&Number.isSafeInteger(item.keyEpoch)&&item.keyEpoch>=0&&item.keyEpoch<=1_000_000
      &&(!('cryptoVaultId'in item)||item.cryptoVaultId===undefined||typeof item.cryptoVaultId==='string'&&uuid.test(item.cryptoVaultId))
      &&(preview===undefined||Boolean(preview&&typeof preview==='object'&&'type'in preview&&typeof preview.type==='string'&&preview.type.length<=100
        &&'size'in preview&&typeof preview.size==='number'&&Number.isSafeInteger(preview.size)&&preview.size>=0
        &&'chunks'in preview&&typeof preview.chunks==='number'&&Number.isSafeInteger(preview.chunks)&&preview.chunks>=1&&preview.chunks<=64));
  }
  return 'data'in item&&typeof item.data==='string'&&item.size<=512*1024&&item.data.length<=700000&&/^data:[^;,]{1,100};base64,[A-Za-z0-9+/=]+$/.test(item.data);
}
const validDate=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'));
export const entityKind=(value:Pick<Note,'kind'>):PlannerEntityKind=>value.kind??'note';
function note(value: unknown): Note {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string'
    || !('text' in value) || typeof value.text !== 'string') throw Error('Повреждённый объект хранилища');
  const author='author' in value?value.author:undefined;
  const reminder='reminder'in value?value.reminder:undefined;
  const html='html'in value?value.html:undefined;
  const attachments='attachments'in value?value.attachments:undefined;
  const cover='cover'in value?value.cover:undefined;
  const checklist='checklist'in value?value.checklist:undefined;
  const tagIds='tagIds'in value?value.tagIds:undefined;
  const pinned='pinned'in value?value.pinned:undefined;
  const lifecycle='lifecycle'in value?value.lifecycle:undefined;
  const importSource='importSource'in value?value.importSource:undefined;
  const kind='kind'in value?value.kind:undefined;
  const projectId='projectId'in value?value.projectId:undefined;
  const project='project'in value?value.project:undefined;
  const task='task'in value?value.task:undefined;
  if(kind!==undefined&&!['note','project','task'].includes(String(kind)))throw Error('Повреждён тип объекта');
  if(projectId!==undefined&&(typeof projectId!=='string'||!uuid.test(projectId)))throw Error('Повреждена привязка к проекту');
  if(reminder!==undefined&&!validPlan(reminder))throw Error('Повреждено напоминание');
  if(html!==undefined&&typeof html!=='string')throw Error('Повреждено форматирование заметки');
  if(attachments!==undefined&&(!Array.isArray(attachments)||attachments.length>500||!attachments.every(validAttachment)))throw Error('Повреждены вложения заметки');
  if(cover!==undefined&&(!cover||typeof cover!=='object'||!('attachmentId'in cover)||typeof cover.attachmentId!=='string'||!uuid.test(cover.attachmentId)
    ||!Array.isArray(attachments)||!attachments.some(item=>item.id===cover.attachmentId&&item.type.startsWith('image/'))))throw Error('Повреждена обложка заметки');
  if(checklist!==undefined&&(!Array.isArray(checklist)||checklist.length>500||!checklist.every(item=>item&&typeof item==='object'
    &&'id'in item&&typeof item.id==='string'&&item.id.length<=100&&'text'in item&&typeof item.text==='string'&&item.text.length<=1000
    &&'done'in item&&typeof item.done==='boolean')))throw Error('Повреждён чек-лист');
  if(tagIds!==undefined&&(!Array.isArray(tagIds)||tagIds.length>100||!tagIds.every(item=>typeof item==='string'&&item.length<=100)
    ||new Set(tagIds).size!==tagIds.length))throw Error('Повреждены теги');
  if(pinned!==undefined&&typeof pinned!=='boolean')throw Error('Повреждён признак закрепления');
  if(lifecycle!==undefined&&(!lifecycle||typeof lifecycle!=='object'||!('state'in lifecycle)||!['active','archived','trashed'].includes(String(lifecycle.state))
    ||!('changedAt'in lifecycle)||!Number.isSafeInteger(lifecycle.changedAt)))throw Error('Повреждён жизненный цикл');
  if(project!==undefined){
    if(!project||typeof project!=='object'||!('favorite'in project)||typeof project.favorite!=='boolean')throw Error('Повреждён проект');
    const start='startDate'in project?project.startDate:undefined,end='endDate'in project?project.endDate:undefined;
    if(start!==undefined&&!validDate(start)||end!==undefined&&!validDate(end)||start&&end&&String(start)>String(end))throw Error('Повреждены даты проекта');
  }
  if(task!==undefined){
    if(!task||typeof task!=='object'||!('status'in task)||!['todo','in_progress','done','cancelled'].includes(String(task.status))
      ||!('priority'in task)||!['none','low','medium','high'].includes(String(task.priority)))throw Error('Повреждена задача');
    const start='startDate'in task?task.startDate:undefined,end='endDate'in task?task.endDate:undefined,assignee='assigneeUserId'in task?task.assigneeUserId:undefined;
    if(start!==undefined&&!validDate(start)||end!==undefined&&!validDate(end)||start&&end&&String(start)>String(end)
      ||assignee!==undefined&&(typeof assignee!=='string'||!uuid.test(assignee)))throw Error('Повреждены параметры задачи');
  }
  const normalizedKind=(kind??'note') as PlannerEntityKind;
  if(normalizedKind==='project'&&!project||normalizedKind==='task'&&!task||normalizedKind==='project'&&projectId!==undefined)throw Error('Повреждена структура объекта');
  if(importSource!==undefined&&(!importSource||typeof importSource!=='object'||!('kind'in importSource)||importSource.kind!=='tasks-note-v1'
    ||!('vaultId'in importSource)||typeof importSource.vaultId!=='string'||!uuid.test(importSource.vaultId)
    ||!('objectId'in importSource)||typeof importSource.objectId!=='string'||!uuid.test(importSource.objectId)))throw Error('Повреждён источник импортированной заметки');
  return { title: value.title, text: value.text, ...(html!==undefined?{html}:{}), ...(attachments?{attachments:attachments as NoteAttachment[]}:{}),...(cover?{cover:cover as NoteCover}:{}),
    ...(checklist?{checklist:checklist as ChecklistItem[]}:{}),...(tagIds?{tagIds:tagIds as string[]}:{}),...(pinned!==undefined?{pinned}:{}),
    ...(reminder?{reminder}:{}),...(kind!==undefined?{kind:normalizedKind}:{}),...(projectId!==undefined?{projectId:projectId as string}:{}),
    ...(project?{project:project as ProjectMeta}:{}),...(task?{task:task as TaskMeta}:{}),
    ...(lifecycle?{lifecycle:lifecycle as NoteLifecycle}:{}), ...(author&&typeof author==='object'&&'name'in author&&typeof author.name==='string'&&'time'in author&&Number.isSafeInteger(author.time)
    ?{author:author as {name:string;time:number}}:{}),...(importSource?{importSource:importSource as Note['importSource']}:{}) };
}
export async function readNote(user: string, v: Vault, r: Revision): Promise<Note> {
  const value=await unseal(revisionKey(user,v,r),vaultContext(user,v,r.objectId,r.id),r.parent,r.sealed) as Note&{resolves?:string[]};
  if(JSON.stringify(value.resolves??[])!==JSON.stringify(r.resolves??[]))throw Error('Повреждена связь конфликтующих версий');
  const normalized=note(value);
  if(v.shared){const{reminder:_,...contents}=normalized,personal=personalReminder(user,v.header.id,r.objectId);return{...contents,...(personal?{reminder:personal}:{})};}
  return normalized;
}
function validTag(value:unknown):value is TagDefinition{return Boolean(value&&typeof value==='object'&&'id'in value&&typeof value.id==='string'&&value.id.length<=100
  &&'name'in value&&typeof value.name==='string'&&value.name.trim()&&value.name.length<=60&&'color'in value&&typeof value.color==='string'&&/^#[0-9A-Fa-f]{6}$/.test(value.color)
  &&'deleted'in value&&typeof value.deleted==='boolean'&&'op'in value&&typeof value.op==='string'&&value.op.length<=100);}
async function readCatalogRevision(user:string,v:Vault,r:Revision):Promise<TagCatalog|null>{
  const value=await unseal(revisionKey(user,v,r),vaultContext(user,v,r.objectId,r.id),r.parent,r.sealed) as Partial<TagCatalog>&{resolves?:string[]};
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
  const result = await unseal(v.key, vaultContext(user,v,v.header.id,v.header.revisionId), null, v.header.name);
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
export async function enableVaultSharing(user:User,vid:string,phrase:string){
  if(!getCollaborationRuntime(user.id))throw Error('Сначала откройте ключ совместной работы паролем аккаунта.');
  const state=await readState(user.id),source=state?.vaults.find(v=>v.header.id===vid);
  if(!source||source.deleted||!source.key)throw Error('Сначала откройте хранилище.');
  if(source.role&&source.role!=='owner')throw Error('Только владелец может включить совместный доступ.');
  if(source.shared)return source.keyring;
  const reminders:{objectId:string;revisionId:string;plan:ReminderPlan}[]=[];
  for(const revision of heads(source)){const value=await readNote(user.id,source,revision);if(value.reminder)reminders.push({objectId:revision.objectId,revisionId:revision.id,plan:value.reminder});}
  for(const item of reminders)await setPersonalReminderLocal(user,vid,item.objectId,item.plan);
  if(reminders.length)await edit(user,async s=>{
    const v=vault(s,vid);for(const item of reminders){
      const current=heads(v).find(r=>r.objectId===item.objectId);if(!current||current.id!==item.revisionId)throw Error('Заметка изменилась. Повторите включение совместного доступа.');
      const value=await readNote(user.id,v,current),{reminder:_,...contents}=value;
      await addRevision(user.id,v,item.objectId,current.id,{...contents,author:{name:s.deviceName??'Устройство',time:Date.now()}});
    }
  });
  return initializeSharedVault(user,vid,phrase);
}
export const openVault = (user: User, vid: string, phrase: string) => edit(user, async s => {
  const v = vault(s, vid, false);
  if(v.role&&v.role!=='owner')throw Error('Участники открывают совместное хранилище через ключ совместной работы, а не фразу владельца.');
  try { v.key = await rememberKey(await unwrapWithPhrase(vaultContext(user.id,v,v.header.keyId,v.header.revisionId), phrase, v.header.wrapper));
    v.displayName=await vaultName(user.id, v);
  } catch { delete v.key; throw Error('Неверная фраза или повреждённые данные.'); }
  if (v.deleted) await stashDeleted(s, v);
  else {for(const objectId of v.purgedObjects??[])await stashPurgedObject(s,v,objectId);v.purgedObjects=[];v.needsGrant=true;}
});
export const closeVault = (user: User, vid: string) => edit(user, async s => {
  const v = vault(s, vid); if (v.transfer) throw Error('Сначала завершите перенос');
  if (v.deleted) await stashDeleted(s, v);
  clearRuntimeVaultKey(user.id,vid);if(v.shared)clearVaultEpochKeys(user.id,vid);delete v.key;delete v.systemUnlock;delete v.grant;v.needsGrant=false;
});
export const lockVault = (user:User,vid:string) => edit(user,async s=>{
  const v=vault(s,vid,false);if(!v.systemUnlock)throw Error('Системная разблокировка не включена');
  clearRuntimeVaultKey(user.id,vid);if(v.shared)clearVaultEpochKeys(user.id,vid);delete v.key;
});
export const forgetSystemUnlock = (user:User,vid:string) => edit(user,async s=>{
  const v=vault(s,vid,false);if(!v.systemUnlock)return;
  clearRuntimeVaultKey(user.id,vid);if(v.shared)clearVaultEpochKeys(user.id,vid);delete v.key;delete v.systemUnlock;
});
const systemContext=(userId:string,v:Vault)=>({accountId:userId,vaultId:v.header.id,keyId:v.header.keyId});
export async function enableSystemUnlock(user:User,vid:string,phrase:string,autoLockMs:AutoLockMs=900_000){
  phraseCheck(phrase);if(!webAuthnPrfPossible())throw Error('Системная WebAuthn-разблокировка недоступна в этом браузере.');
  const initial=await readState(user.id),v=initial?.vaults.find(v=>v.header.id===vid);if(!v||v.deleted)throw Error('Хранилище не найдено');
  if(v.role&&v.role!=='owner')throw Error('Системная разблокировка phrase-wrapper доступна только владельцу.');
  let root:CryptoKey;try{root=await unwrapWithPhrase(vaultContext(user.id,v,v.header.keyId,v.header.revisionId),phrase,v.header.wrapper);}
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
async function addRevision(user:string,v:Vault,objectId:string,parent:string|null,value:Note){
  if(v.deleted||v.transfer||v.membershipRevoked||v.role==='viewer')throw Error(v.membershipRevoked?'Доступ к совместному хранилищу отозван. Локальная копия доступна только для чтения.':v.role==='viewer'?'Хранилище доступно только для просмотра.':'Хранилище недоступно для записи');
  const {key,epoch}=writeKey(user,v),rid=id(),stored=v.shared?((({reminder:_,...contents})=>contents)(value)):value,r:Revision={id:rid,objectId,parent,
    sealed:await seal(key,vaultContext(user,v,objectId,rid),parent,stored),pending:true,reminderPending:true,
    ...(v.shared?{keyEpoch:epoch}:{})};
  v.records.push(r);return r;
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
  if(v.deleted||v.transfer||v.membershipRevoked||v.role==='viewer')throw Error(v.membershipRevoked?'Доступ к совместному хранилищу отозван. Локальная копия доступна только для чтения.':v.role==='viewer'?'Хранилище доступно только для просмотра.':'Хранилище недоступно для записи');
  const versions=catalogHeads(v),parent=versions[0]?.id??null,resolves=versions.slice(1).map(r=>r.id),rid=id(),{key,epoch}=writeKey(user,v);
  const value={kind:'tag-catalog' as const,title:'Служебные данные тегов',text:'Обновите приложение, чтобы управлять тегами этого хранилища.',tags,push,...(resolves.length?{resolves}:{})};
  v.records.push({id:rid,objectId:v.header.id,parent,...(resolves.length?{resolves}:{}),pending:true,...(v.shared?{keyEpoch:epoch}:{}),
    sealed:await seal(key,vaultContext(user,v,v.header.id,rid),parent,value)});
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
export async function saveNote(user:User,vid:string,objectId:string,parent:string|null,value:Note,draftKey?:CryptoKey){
  const before=await readState(user.id),beforeVault=before?.vaults.find(v=>v.header.id===vid),shared=Boolean(beforeVault?.shared);
  if(beforeVault?.membershipRevoked)throw Error('Доступ к совместному хранилищу отозван. Локальная копия доступна только для чтения.');
  if(beforeVault?.role==='viewer')throw Error('Хранилище доступно только для просмотра.');
  if(shared)await setPersonalReminderLocal(user,vid,objectId,value.reminder??null);
  return edit(user,async s=>{
    const v=vault(s,vid,false);if(v.deleted){await addStash(s,vid,value);return{id:parent??objectId,stashed:true};}
    // An already-open editor may finish encrypting its draft after another tab closed the vault.
    // Never persist the temporary key again or put this draft into an independently accessible stash.
    const writable=v.key?v:{...v,key:draftKey};
    const r=await addRevision(user.id,writable,objectId,parent,{...value,author:{name:s.deviceName??'Устройство',time:Date.now()}});
    return{id:r.id,stashed:false};
  });
}
export async function copyNote(user:User,vid:string,revisionId:string){
  const result=await edit(user,async s=>{
    const v=vault(s,vid),revision=heads(v).find(r=>r.id===revisionId);if(!revision)throw Error('Версия заметки изменилась');
    const source=await readNote(user.id,v,revision),reminder=source.reminder?{...source.reminder,id:id(),state:'off' as const}:undefined,{author:_,lifecycle:__,...contents}=source,objectId=id();
    const created=await addRevision(user.id,v,objectId,null,{...contents,title:source.title?source.title+' — копия':'Копия заметки',pinned:false,reminder,author:{name:s.deviceName??'Устройство',time:Date.now()}});
    return{id:created.id,objectId,shared:Boolean(v.shared),reminder};
  });
  if(result.shared&&result.reminder)await setPersonalReminderLocal(user,vid,result.objectId,result.reminder);
  return result.id;
}

export interface WorkspaceItem {revision:Revision;value:Note;lifecycle:NoteLifecycleState}
export interface ProjectWorkspace {vault:Vault;projects:WorkspaceItem[];tasks:WorkspaceItem[];notes:WorkspaceItem[];conflicts:string[]}
export async function readProjectWorkspace(user:User,vid:string):Promise<ProjectWorkspace>{
  const state=await readState(user.id),v=state?.vaults.find(item=>item.header.id===vid&&!item.deleted);
  if(!state||!v||!v.key)throw Error('Сначала откройте хранилище в разделе «Заметки».');
  const byObject=new Map<string,Revision[]>();for(const r of heads(v)){const list=byObject.get(r.objectId)??[];list.push(r);byObject.set(r.objectId,list);}
  const projects:WorkspaceItem[]=[],tasks:WorkspaceItem[]=[],notes:WorkspaceItem[]=[],conflicts:string[]=[];
  for(const [objectId,versions] of byObject){
    if(versions.length!==1){conflicts.push(objectId);continue;}
    const revision=versions[0],value=await readNote(user.id,v,revision),lifecycle=noteLifecycle(v,revision,value),item={revision,value,lifecycle};
    const kind=entityKind(value);if(kind==='project')projects.push(item);else if(kind==='task')tasks.push(item);else notes.push(item);
  }
  return{vault:v,projects,tasks,notes,conflicts};
}
function cleanTitle(value:string,label:string){const text=value.trim();if(!text||text.length>200)throw Error(label+': от 1 до 200 символов');return text;}
function projectMeta(input:ProjectMeta):ProjectMeta{
  const value={favorite:Boolean(input.favorite),calendar:input.calendar??'calendar',...(input.startDate?{startDate:input.startDate}:{}),...(input.endDate?{endDate:input.endDate}:{})};
  if(!['calendar','weekdays'].includes(value.calendar))throw Error('Некорректный календарь проекта.');
  if(value.startDate&&!validDate(value.startDate)||value.endDate&&!validDate(value.endDate)||value.startDate&&value.endDate&&value.startDate>value.endDate)throw Error('Проверьте даты проекта.');
  return value;
}
function taskMeta(input:TaskMeta):TaskMeta{
  if(!['todo','in_progress','done','cancelled'].includes(input.status)||!['none','low','medium','high'].includes(input.priority))throw Error('Некорректный статус или приоритет задачи.');
  const dependencies=normalizeDependencies(input.dependencies);
  const value={status:input.status,priority:input.priority,...(input.startDate?{startDate:input.startDate}:{}),...(input.endDate?{endDate:input.endDate}:{}),...(input.assigneeUserId?{assigneeUserId:input.assigneeUserId}:{}),...(dependencies.length?{dependencies}:{}),...(input.reminderAnchor?{reminderAnchor:input.reminderAnchor}:{})};
  if(value.reminderAnchor&&!['start','start-1d','end','end-1d'].includes(value.reminderAnchor))throw Error('Некорректная привязка напоминания.');
  if(value.startDate&&!validDate(value.startDate)||value.endDate&&!validDate(value.endDate)||value.startDate&&value.endDate&&value.startDate>value.endDate)throw Error('Проверьте даты задачи.');
  if(value.assigneeUserId&&!uuid.test(value.assigneeUserId))throw Error('Некорректный исполнитель.');
  return value;
}
async function validateTaskDependencies(userId:string,v:Vault,objectId:string,projectId:string|undefined,candidate:TaskMeta){
  const byObject=new Map<string,Revision[]>();for(const revision of heads(v)){const list=byObject.get(revision.objectId)??[];list.push(revision);byObject.set(revision.objectId,list);}
  const graph:{id:string;title:string;startDate?:string;endDate?:string;dependencies?:TaskDependency[]}[]=[];
  for(const [id,versions] of byObject){
    if(id===objectId){graph.push({id,title:'Текущая задача',startDate:candidate.startDate,endDate:candidate.endDate,dependencies:candidate.dependencies});continue;}
    if(versions.length!==1)continue;const revision=versions[0],value=await readNote(userId,v,revision);
    if(entityKind(value)!=='task'||noteLifecycle(v,revision,value)!=='active'||(value.projectId??'')!==(projectId??''))continue;
    graph.push({id,title:value.title,startDate:value.task?.startDate,endDate:value.task?.endDate,dependencies:value.task?.dependencies});
  }
  if(!graph.some(item=>item.id===objectId))graph.push({id:objectId,title:'Текущая задача',startDate:candidate.startDate,endDate:candidate.endDate,dependencies:candidate.dependencies});
  const ids=new Set(graph.map(item=>item.id));for(const dep of candidate.dependencies??[])if(!ids.has(dep.taskId))throw Error('Зависимость можно создать только с активной задачей того же проекта.');
  validateDependencyGraph(graph);
}
function anchoredReminder(reminder:ReminderPlan|undefined,anchor:TaskReminderAnchor|undefined,startDate?:string,endDate?:string){
  if(!reminder||!anchor)return reminder;const base=anchor.startsWith('start')?startDate:endDate;if(!base)return reminder;
  const day=anchor.endsWith('-1d')?new Date(Date.parse(base+'T00:00:00Z')-86400000).toISOString().slice(0,10):base;
  return{...reminder,local:day+'T09:00'};
}
export async function createProject(user:User,vid:string,input:{title:string;description?:string;favorite?:boolean;startDate?:string;endDate?:string;calendar?:GanttCalendar}){
  const objectId=id(),value:Note={kind:'project',title:cleanTitle(input.title,'Название проекта'),text:(input.description??'').slice(0,10000),
    project:projectMeta({favorite:Boolean(input.favorite),calendar:input.calendar??'calendar',...(input.startDate?{startDate:input.startDate}:{}),...(input.endDate?{endDate:input.endDate}:{})})};
  const result=await saveNote(user,vid,objectId,null,value);return{objectId,revisionId:result.id};
}
export async function updateProject(user:User,vid:string,objectId:string,input:{title:string;description?:string;favorite?:boolean;startDate?:string;endDate?:string;calendar?:GanttCalendar}){
  const state=await readState(user.id),v=state?.vaults.find(item=>item.header.id===vid);if(!v?.key)throw Error('Откройте хранилище.');
  const current=oneHead(v,objectId),previous=await readNote(user.id,v,current);if(entityKind(previous)!=='project')throw Error('Проект не найден.');
  return saveNote(user,vid,objectId,current.id,{...previous,title:cleanTitle(input.title,'Название проекта'),text:(input.description??'').slice(0,10000),
    project:projectMeta({favorite:Boolean(input.favorite),calendar:input.calendar??previous.project?.calendar??'calendar',...(input.startDate?{startDate:input.startDate}:{}),...(input.endDate?{endDate:input.endDate}:{})})});
}
export async function setProjectArchived(user:User,vid:string,objectId:string,archived:boolean){
  const state=await readState(user.id),v=state?.vaults.find(item=>item.header.id===vid);if(!v?.key)throw Error('Откройте хранилище.');
  const current=oneHead(v,objectId),previous=await readNote(user.id,v,current);if(entityKind(previous)!=='project')throw Error('Проект не найден.');
  return saveNote(user,vid,objectId,current.id,{...previous,lifecycle:{state:archived?'archived':'active',changedAt:Date.now()}});
}
export async function createTask(user:User,vid:string,input:{title:string;description?:string;projectId?:string;status?:TaskStatus;priority?:TaskPriority;startDate?:string;endDate?:string;assigneeUserId?:string;checklist?:ChecklistItem[];tagIds?:string[];reminder?:ReminderPlan;dependencies?:TaskDependency[];reminderAnchor?:TaskReminderAnchor}){
  const objectId=id(),meta=taskMeta({status:input.status??'todo',priority:input.priority??'none',
    ...(input.startDate?{startDate:input.startDate}:{}),...(input.endDate?{endDate:input.endDate}:{}),...(input.assigneeUserId?{assigneeUserId:input.assigneeUserId}:{}),
    ...(input.dependencies?.length?{dependencies:normalizeDependencies(input.dependencies,objectId)}:{}),...(input.reminderAnchor?{reminderAnchor:input.reminderAnchor}:{})});
  const state=await readState(user.id),vaultState=state?.vaults.find(item=>item.header.id===vid);if(!vaultState?.key)throw Error('Откройте хранилище.');
  await validateTaskDependencies(user.id,vaultState,objectId,input.projectId,meta);
  const value:Note={kind:'task',title:cleanTitle(input.title,'Название задачи'),text:(input.description??'').slice(0,20000),
    ...(input.projectId?{projectId:input.projectId}:{}),task:meta,
    ...(input.checklist?.length?{checklist:input.checklist}:{}),...(input.tagIds?.length?{tagIds:input.tagIds}:{}),...(input.reminder?{reminder:input.reminder}:{})};
  const result=await saveNote(user,vid,objectId,null,value);return{objectId,revisionId:result.id};
}
export async function updateTask(user:User,vid:string,objectId:string,input:{title:string;description?:string;projectId?:string;status:TaskStatus;priority:TaskPriority;startDate?:string;endDate?:string;assigneeUserId?:string;checklist?:ChecklistItem[];tagIds?:string[];reminder?:ReminderPlan;dependencies?:TaskDependency[];reminderAnchor?:TaskReminderAnchor|null}){
  const state=await readState(user.id),v=state?.vaults.find(item=>item.header.id===vid);if(!v?.key)throw Error('Откройте хранилище.');
  const current=oneHead(v,objectId),previous=await readNote(user.id,v,current);if(entityKind(previous)!=='task')throw Error('Задача не найдена.');
  const reminderAnchor=input.reminderAnchor===undefined?previous.task?.reminderAnchor:input.reminderAnchor??undefined;
  const meta=taskMeta({status:input.status,priority:input.priority,...(input.startDate?{startDate:input.startDate}:{}),
      ...(input.endDate?{endDate:input.endDate}:{}),...(input.assigneeUserId?{assigneeUserId:input.assigneeUserId}:{}),
      ...(input.dependencies!==undefined?{dependencies:normalizeDependencies(input.dependencies,objectId)}:previous.task?.dependencies?.length?{dependencies:previous.task.dependencies}:{}),
      ...(reminderAnchor?{reminderAnchor}:{})});
  await validateTaskDependencies(user.id,v,objectId,input.projectId,meta);
  const value:Note={...previous,title:cleanTitle(input.title,'Название задачи'),text:(input.description??'').slice(0,20000),
    projectId:input.projectId||undefined,task:meta,
    checklist:input.checklist?.length?input.checklist:undefined,tagIds:input.tagIds?.length?input.tagIds:undefined,reminder:input.reminder};
  if(!input.projectId)delete value.projectId;if(!input.reminder)delete value.reminder;
  return saveNote(user,vid,objectId,current.id,value);
}
export async function rescheduleTasks(user:User,vid:string,changes:{objectId:string;startDate?:string;endDate?:string}[]){
  return edit(user,async s=>{
    const v=vault(s,vid);const result:string[]=[];
    for(const change of changes){
      const current=oneHead(v,change.objectId),previous=await readNote(user.id,v,current);if(entityKind(previous)!=='task'||!previous.task)throw Error('Задача не найдена.');
      const meta=taskMeta({...previous.task,startDate:change.startDate,endDate:change.endDate});
      const reminder=anchoredReminder(previous.reminder,meta.reminderAnchor,meta.startDate,meta.endDate);
      const created=await addRevision(user.id,v,change.objectId,current.id,{...previous,task:meta,...(reminder?{reminder}:{})});
      result.push(created.id);
    }
    return result;
  });
}
export async function movePlannerObject(user:User,vid:string,objectId:string,projectId?:string){
  const state=await readState(user.id),v=state?.vaults.find(item=>item.header.id===vid);if(!v?.key)throw Error('Откройте хранилище.');
  if(projectId){const projectRevision=oneHead(v,projectId),projectValue=await readNote(user.id,v,projectRevision);if(entityKind(projectValue)!=='project'||noteLifecycle(v,projectRevision,projectValue)!=='active')throw Error('Целевой проект недоступен.');}
  const current=oneHead(v,objectId),previous=await readNote(user.id,v,current);if(entityKind(previous)==='project')throw Error('Проекты нельзя вкладывать друг в друга.');
  if(entityKind(previous)==='task'&&(previous.projectId??'')!==(projectId??'')){
    if(previous.task?.dependencies?.length)throw Error('Перед переносом задачи удалите её зависимости.');
    for(const revision of heads(v)){
      if(revision.objectId===objectId)continue;const value=await readNote(user.id,v,revision);
      if(entityKind(value)==='task'&&noteLifecycle(v,revision,value)==='active'&&value.task?.dependencies?.some(dep=>dep.taskId===objectId))
        throw Error('Перед переносом задачи удалите связи с её последователями.');
    }
  }
  const next={...previous,projectId:projectId||undefined};if(!projectId)delete next.projectId;
  return saveNote(user,vid,objectId,current.id,next);
}
export async function deleteProject(user:User,vid:string,projectId:string,withContents:boolean){
  return edit(user,async s=>{
    const v=vault(s,vid);if(v.shared&&v.role!=='owner')throw Error('Удалять проект в совместном хранилище может только владелец.');
    const projectRevision=oneHead(v,projectId),project=await readNote(user.id,v,projectRevision);if(entityKind(project)!=='project')throw Error('Проект не найден.');
    const assigned:{revision:Revision;value:Note}[]=[];
    for(const r of heads(v)){if(r.objectId===projectId)continue;const value=await readNote(user.id,v,r);if(value.projectId===projectId)assigned.push({revision:r,value});}
    const markPurge=async(revision:Revision,value:Note)=>{
      const expected=lifecycleExpected(v,revision.objectId),reminder=value.reminder?{...value.reminder,state:'off' as const}:undefined;
      const created=await addRevision(user.id,v,revision.objectId,revision.id,{...value,lifecycle:{state:'trashed',changedAt:Date.now()},reminder,author:{name:s.deviceName??'Устройство',time:Date.now()}});
      created.lifecyclePending={state:'trash',expected};v.purgePending??=[];if(!v.purgePending.includes(revision.objectId))v.purgePending.push(revision.objectId);
    };
    if(withContents)for(const item of assigned)await markPurge(item.revision,item.value);
    else for(const item of assigned){const next={...item.value,projectId:undefined,author:{name:s.deviceName??'Устройство',time:Date.now()}};delete next.projectId;await addRevision(user.id,v,item.revision.objectId,item.revision.id,next);}
    await markPurge(projectRevision,project);
    return{affected:assigned.length};
  });
}

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
async function stashRevokedChanges(s:State,v:Vault){
  if(!v.key)return;
  for(const r of heads(v).filter(r=>r.pending&&r.objectId!==v.header.id))await addStash(s,v.header.id,await readNote(s.user.id,v,r));
  v.records=v.records.filter(r=>!r.pending);
  v.purgePending=[];
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
  const rid=id(),value=await readNote(user.id,v,selected),{key,epoch}=writeKey(user.id,v);
  v.records.push({id:rid,objectId,parent:chosen,resolves,pending:true,reminderPending:true,...(v.shared?{keyEpoch:epoch}:{}),
    sealed:await seal(key,vaultContext(user.id,v,objectId,rid),chosen,{...value,author,resolves})});
  if(keepBoth)for(const r of others){const copy=await readNote(user.id,v,r),{lifecycle:_,author:__,...contents}=copy;
    await addRevision(user.id,v,id(),null,{...contents,...(copy.reminder?{reminder:{...copy.reminder,id:id(),state:'off' as const}}:{}),author});}
});
export const transferVault = (user: User, source: string, name: string, phrase: string) => edit(user, async s => {
  const v = vault(s, source); if (v.deleted || v.transfer) throw Error('Перенос уже начат или хранилище удалено');
  const target = await makeVault(user.id, name, phrase),files=new Set<string>(),mapped=new Map<string,NoteAttachment>(),targetWrite=writeKey(user.id,target);
  const mapAttachment=async(item:NoteAttachment)=>{
    if(item.storage!=='stream')return{...item};
    const cached=mapped.get(item.id);if(cached)return cached;
    if(!item.wrappedKey||item.keyEpoch===undefined)throw Error('Повреждено потоковое вложение.');
    const sourceRoot=fileEpochKey(user.id,v,item.keyEpoch),wrappedKey=await rewrapFileKey(sourceRoot,targetWrite.key,item.wrappedKey);
    const next:NoteAttachment={...item,wrappedKey,keyEpoch:targetWrite.epoch,cryptoVaultId:item.cryptoVaultId??v.header.id};mapped.set(item.id,next);files.add(item.id);return next;
  };
  for (const r of heads(v)){const copy=await readNote(user.id,v,r),attachments=copy.attachments?await Promise.all(copy.attachments.map(mapAttachment)):undefined;
    const created=await addRevision(user.id,target,id(),null,{...copy,...(attachments?{attachments}:{}),...(copy.reminder?{reminder:{...copy.reminder,id:id(),state:'off' as const}}:{})});
    if(copy.lifecycle?.state==='trashed')created.lifecyclePending={state:'trash',expected:null};}
  if(catalogHeads(v).length){const catalog=await readCatalog(user.id,v);await writeCatalog(user.id,target,catalog.tags,catalog.push);}
  s.vaults.push(target); v.transfer = { target: target.header.id, revisions: target.records.map(r => r.id),...(files.size?{files:[...files]}:{}) };
  return target.header.id;
});

export async function exportVaultSnapshot(user:User,vid:string):Promise<PortableVaultSnapshot>{
  const s=await readState(user.id),v=s?.vaults.find(item=>item.header.id===vid);
  if(!s||!v||v.deleted||!v.key)throw Error('Для резервной копии сначала откройте хранилище.');
  if(v.transfer)throw Error('Сначала завершите перенос хранилища.');
  const excluded=new Set([...(v.purgePending??[]),...(v.purgedObjects??[]),
    ...Object.entries(v.objectStates??{}).filter(([,state])=>state.state==='purged').map(([objectId])=>objectId)]);
  const revisions:PortableVaultRevision[]=[];
  for(const r of v.records)if(r.objectId!==v.header.id&&!excluded.has(r.objectId)){
    const value=await readNote(user.id,v,r);
    if(value.attachments?.some(item=>item.storage==='stream'))throw Error('Формат .tasks-backup v1 поддерживает только малые встроенные вложения. Потоковые файлы экспортируйте через ZIP заметки.');
    revisions.push({revisionId:r.id,objectId:r.objectId,parent:r.parent,resolves:[...(r.resolves??[])],note:value});
  }
  const catalog=await readCatalog(user.id,v);
  return{format:'tasks-vault-snapshot',version:1,sourceVaultId:v.header.id,name:await vaultName(user.id,v),
    exportedAt:Date.now(),tags:catalog.tags.map(tag=>({...tag})),pushMode:catalog.push.mode,revisions};
}

export function validateVaultSnapshot(value:unknown):PortableVaultSnapshot{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Некорректная резервная копия.');
  const row=value as Record<string,unknown>,fields=['format','version','sourceVaultId','name','exportedAt','tags','pushMode','revisions'];
  if(Object.keys(row).length!==fields.length||fields.some(field=>!Object.hasOwn(row,field))||row.format!=='tasks-vault-snapshot'||row.version!==1
    ||typeof row.sourceVaultId!=='string'||!uuid.test(row.sourceVaultId)||typeof row.name!=='string'||!row.name.trim()||row.name.length>200
    ||!Number.isSafeInteger(row.exportedAt)||!Array.isArray(row.tags)||row.tags.length>500||!row.tags.every(validTag)
    ||!['neutral','title'].includes(String(row.pushMode))||!Array.isArray(row.revisions)||row.revisions.length>10000)throw Error('Некорректная резервная копия.');
  const revisions:PortableVaultRevision[]=[];const byId=new Map<string,PortableVaultRevision>();
  for(const item of row.revisions){
    if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Некорректная история резервной копии.');
    const r=item as Record<string,unknown>,keys=['revisionId','objectId','parent','resolves','note'];
    if(Object.keys(r).length!==keys.length||keys.some(key=>!Object.hasOwn(r,key))||typeof r.revisionId!=='string'||!uuid.test(r.revisionId)
      ||typeof r.objectId!=='string'||!uuid.test(r.objectId)||(r.parent!==null&&(typeof r.parent!=='string'||!uuid.test(r.parent)))
      ||!Array.isArray(r.resolves)||r.resolves.length>100||!r.resolves.every(x=>typeof x==='string'&&uuid.test(x))||new Set(r.resolves).size!==r.resolves.length
      ||byId.has(r.revisionId))throw Error('Некорректная история резервной копии.');
    const normalizedNote=note(r.note);if(normalizedNote.attachments?.some(item=>item.storage==='stream'))throw Error('Резервная копия v1 не может содержать потоковые ссылки без самих файлов.');
    const normalized={revisionId:r.revisionId,objectId:r.objectId,parent:r.parent as string|null,resolves:[...r.resolves] as string[],note:normalizedNote};
    revisions.push(normalized);byId.set(normalized.revisionId,normalized);
  }
  for(const r of revisions)for(const ref of [...(r.parent?[r.parent]:[]),...r.resolves]){
    const linked=byId.get(ref);if(!linked||linked.objectId!==r.objectId)throw Error('Резервная копия содержит повреждённые связи версий.');
  }
  const ordered:PortableVaultRevision[]=[],visiting=new Set<string>(),done=new Set<string>();
  const visit=(revision:PortableVaultRevision)=>{
    if(done.has(revision.revisionId))return;
    if(visiting.has(revision.revisionId))throw Error('Резервная копия содержит цикл в истории версий.');
    visiting.add(revision.revisionId);
    for(const ref of [...(revision.parent?[revision.parent]:[]),...revision.resolves])visit(byId.get(ref)!);
    visiting.delete(revision.revisionId);done.add(revision.revisionId);ordered.push(revision);
  };
  for(const revision of revisions)visit(revision);
  return{format:'tasks-vault-snapshot',version:1,sourceVaultId:row.sourceVaultId as string,name:row.name as string,exportedAt:row.exportedAt as number,
    tags:(row.tags as TagDefinition[]).map(tag=>({...tag})),pushMode:row.pushMode as VaultPushMode,revisions:ordered};
}

export const importVaultSnapshot=(user:User,input:unknown,name:string,phrase:string)=>edit(user,async s=>{
  const snapshot=validateVaultSnapshot(input);phraseCheck(phrase);const target=await makeVault(user.id,name,phrase);
  const objectMap=new Map<string,string>(),revisionMap=new Map<string,string>(),reminders=new Map<string,string>();
  for(const source of snapshot.revisions){if(!objectMap.has(source.objectId))objectMap.set(source.objectId,id());revisionMap.set(source.revisionId,id());}
  const noteByRevision=new Map<string,Note>();
  for(const source of snapshot.revisions){
    const objectId=objectMap.get(source.objectId)!,rid=revisionMap.get(source.revisionId)!;
    const parent=source.parent?revisionMap.get(source.parent)!:null,resolves=source.resolves.map(value=>revisionMap.get(value)!);
    let copied:Note={...source.note,...(source.note.attachments?{attachments:source.note.attachments.map(item=>({...item}))}:{}),
      ...(source.note.checklist?{checklist:source.note.checklist.map(item=>({...item}))}:{})};
    if(copied.reminder){let reminderId=reminders.get(source.objectId);if(!reminderId){reminderId=id();reminders.set(source.objectId,reminderId);}copied={...copied,reminder:{...copied.reminder,id:reminderId,state:'off'}};}
    noteByRevision.set(rid,copied);
    target.records.push({id:rid,objectId,parent,...(resolves.length?{resolves}:{}),pending:true,
      sealed:await seal(target.key!,context(user.id,target.header,objectId,rid),parent,{...copied,...(resolves.length?{resolves}:{})})});
  }
  const importedHeads=heads(target);
  for(const objectId of new Set(importedHeads.map(r=>r.objectId))){
    const versions=importedHeads.filter(r=>r.objectId===objectId);if(versions.length!==1)continue;
    const head=versions[0],value=noteByRevision.get(head.id)!;
    if(value.reminder)head.reminderPending=true;
    if(value.lifecycle?.state==='trashed')head.lifecyclePending={state:'trash',expected:null};
  }
  await writeCatalog(user.id,target,snapshot.tags,snapshot.pushMode==='title'?{mode:'title',op:'999999999999-import'}:{mode:'neutral',op:'999999999999-import'});
  s.vaults.push(target);return target.header.id;
});

export interface PortableNoteImport {note:Note;tags:TagDefinition[];source?:{kind:'tasks-note-v1';vaultId:string;objectId:string};files?:{sourceId:string;name:string;type:string;size:number;bytes?:Uint8Array;blob?:Blob}[];coverAttachmentId?:string;cleanup?:()=>Promise<void>}
function validPortableNote(input:PortableNoteImport){
  const normalized=note(input.note);
  if(!Array.isArray(input.tags)||input.tags.length>500||!input.tags.every(validTag))throw Error('Некорректные теги импортируемой заметки.');
  if(input.source&&(!uuid.test(input.source.vaultId)||!uuid.test(input.source.objectId)))throw Error('Некорректный источник импортируемой заметки.');
  const files=input.files??[];if(!Array.isArray(files)||files.length>500||files.some(file=>!file||typeof file!=='object'||!uuid.test(file.sourceId)
    ||typeof file.name!=='string'||!file.name.trim()||file.name.length>200||typeof file.type!=='string'||file.type.length>100
    ||!Number.isSafeInteger(file.size)||file.size<0||(!((file.bytes instanceof Uint8Array)&&file.bytes.length===file.size)&&!((file.blob instanceof Blob)&&file.blob.size===file.size))))throw Error('Некорректные файлы импортируемой заметки.');
  if(input.coverAttachmentId!==undefined&&(!uuid.test(input.coverAttachmentId)||!files.some(file=>file.sourceId===input.coverAttachmentId&&file.type.startsWith('image/'))))throw Error('Некорректная обложка импортируемой заметки.');
  return{note:normalized,tags:input.tags,source:input.source,files,coverAttachmentId:input.coverAttachmentId,cleanup:input.cleanup};
}
async function duplicateImported(userId:string,v:Vault,source:NonNullable<PortableNoteImport['source']>){
  for(const r of heads(v)){const value=await readNote(userId,v,r);if(value.importSource?.vaultId===source.vaultId&&value.importSource.objectId===source.objectId)return true;}return false;
}
export async function noteImportIsDuplicate(user:User,vid:string,input:PortableNoteImport){
  const checked=validPortableNote(input),s=await readState(user.id),v=s?.vaults.find(item=>item.header.id===vid);
  if(!s||!v||v.deleted||!v.key)throw Error('Для импорта откройте целевое хранилище.');
  return checked.source?duplicateImported(user.id,v,checked.source):false;
}
export async function importPortableNote(user:User,vid:string,input:PortableNoteImport,duplicatePolicy:'skip'|'copy'){
  const checked=validPortableNote(input),uploaded:NoteAttachment[]=[],sourceToNew=new Map<string,string>(),objectId=id();
  try{
    const before=await readState(user.id),beforeVault=before?.vaults.find(item=>item.header.id===vid&&!item.deleted);
    if(!beforeVault?.key||beforeVault.transfer)throw Error('Хранилище недоступно для импорта.');
    const duplicate=checked.source?await duplicateImported(user.id,beforeVault,checked.source):false;if(duplicate&&duplicatePolicy==='skip')return{imported:false,duplicate:true};
    for(const portable of checked.files){
      const body=portable.blob??Uint8Array.from(portable.bytes!);const file=new File([body],portable.name,{type:portable.type});
      const result=await uploadAttachment(user,vid,objectId,file);uploaded.push(result.attachment);sourceToNew.set(portable.sourceId,result.attachment.id);
    }
    return await edit(user,async s=>{
      const v=vault(s,vid);if(v.deleted||v.transfer)throw Error('Хранилище недоступно для импорта.');
      const catalog=await readCatalog(user.id,v),tags=[...catalog.tags.map(tag=>({...tag}))],mapped:string[]=[];let changed=false;
      for(const sourceId of checked.note.tagIds??[]){const sourceTag=checked.tags.find(tag=>tag.id===sourceId&&!tag.deleted);if(!sourceTag)continue;
        let targetTag=tags.find(tag=>!tag.deleted&&tag.name.localeCompare(sourceTag.name,'ru',{sensitivity:'accent'})===0);
        if(!targetTag){targetTag={id:id(),name:sourceTag.name,color:sourceTag.color.toUpperCase(),deleted:false,op:nextTagOp(tags)};tags.push(targetTag);changed=true;}mapped.push(targetTag.id);
      }
      if(changed)await writeCatalog(user.id,v,tags,catalog.push);
      const {author:_,tagIds:__,reminder,...contents}=checked.note;
      const coverId=checked.coverAttachmentId?sourceToNew.get(checked.coverAttachmentId):undefined;
      const value:Note={...contents,tagIds:mapped,...(uploaded.length?{attachments:uploaded}:{}),...(coverId?{cover:{attachmentId:coverId}}:{}),
        ...(reminder?{reminder:{...reminder,id:id(),state:'off'}}:{}),...(checked.source?{importSource:checked.source}:{}),
        author:{name:s.deviceName??'Устройство',time:Date.now()}};
      const created=await addRevision(user.id,v,objectId,null,value);if(value.lifecycle?.state==='trashed')created.lifecyclePending={state:'trash',expected:null};
      return{imported:true,duplicate};
    });
  }catch(error){
    for(const item of uploaded)await deleteAttachmentFile(user,vid,item.id).catch(()=>{});
    throw error;
  }finally{
    if(checked.cleanup)await checked.cleanup().catch(()=>{});
  }
}
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
      disk_critical:'На сервере осталось 5% или меньше свободного места. Освободите место перед новой загрузкой.',upload_not_found:'Временная загрузка уже очищена. Выберите файл заново.',
      upload_incomplete:'Файл передан не полностью. Выберите его заново.',file_not_found:'Файл больше не найден на сервере.',stale_key_epoch:'Ключ совместного хранилища изменился. Синхронизируйте и повторите загрузку.',
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
async function csrfToken(){
  const r=await fetch('/api/auth/csrf',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
  const value=await r.json();if(!r.ok||typeof value?.csrf!=='string')throw new APIError('csrf');return value.csrf as string;
}
async function fileHeaders(user:User,vid:string,write=false){
  const current=await session();if(current?.id!==user.id)throw new APIError('unauthorized');
  const state=await readState(user.id),v=state?.vaults.find(item=>item.header.id===vid&&!item.deleted);
  if(!state||!v)throw Error('Хранилище недоступно');
  if(write&&(v.role==='viewer'||v.membershipRevoked))throw Error('Хранилище доступно только для просмотра.');
  const grants:Record<string,string>={};if(v.grant)grants[vid]=v.grant;
  return{state,v,headers:{'X-Tasks-Account':user.id,'X-Tasks-Device':state.deviceId??'','X-Vault-Grants':JSON.stringify(grants)} as Record<string,string>};
}
async function fileJson(user:User,vid:string,path:string,body:unknown,write=true){
  const {headers}=await fileHeaders(user,vid,write);headers['X-CSRF-Token']=await csrfToken();headers['Content-Type']='application/json';
  const r=await fetch('/api/files/'+path,{method:'POST',headers,credentials:'same-origin',cache:'no-store',body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const value=await r.json();if(!r.ok)throw new APIError(value?.error??'network');return value;
}
async function putFileChunk(user:User,vid:string,uploadId:string,kind:'data'|'preview',index:number,bytes:Uint8Array,signal?:AbortSignal){
  const {headers}=await fileHeaders(user,vid,true);headers['X-CSRF-Token']=await csrfToken();headers['Content-Type']='application/octet-stream';
  const body=new Blob([Uint8Array.from(bytes)],{type:'application/octet-stream'});
  const r=await fetch('/api/files/'+uploadId+'/'+kind+'/'+index,{method:'PUT',headers,credentials:'same-origin',cache:'no-store',body,signal:signal??AbortSignal.timeout(60000)});
  const value=await r.json();if(!r.ok)throw new APIError(value?.error??'network');return value;
}
async function getFileChunk(user:User,vid:string,attachmentId:string,kind:'data'|'preview',index:number){
  const {headers}=await fileHeaders(user,vid,false);
  const r=await fetch('/api/files/'+vid+'/'+attachmentId+'/'+kind+'/'+index,{headers,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(60000)});
  if(!r.ok){let value:any={};try{value=await r.json();}catch{}throw new APIError(value?.error??'network');}return new Uint8Array(await r.arrayBuffer());
}
async function imagePreview(file:File):Promise<Blob|null>{
  if(!file.type.startsWith('image/')||typeof createImageBitmap!=='function')return null;
  let bitmap:ImageBitmap|undefined;try{
    bitmap=await createImageBitmap(file);const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');if(!ctx)return null;ctx.drawImage(bitmap,0,0,width,height);
    const type=file.type==='image/png'?'image/png':'image/webp';
    return await new Promise(resolve=>canvas.toBlob(blob=>resolve(blob),type,type==='image/png'?undefined:.82));
  }catch{return null;}finally{bitmap?.close();}
}
function fileEpochKey(userId:string,v:Vault,epoch:number){
  const key=epoch===0?(v.key??getVaultEpochKey(userId,v.header.id,0)):getVaultEpochKey(userId,v.header.id,epoch);
  if(!key)throw Error('Ключ вложения недоступен.');return key;
}
export async function uploadAttachment(user:User,vid:string,objectId:string,file:File,onProgress?:(progress:AttachmentUploadProgress)=>void,signal?:AbortSignal):Promise<{attachment:NoteAttachment;warning:boolean}>{
  const {v}=await fileHeaders(user,vid,true);const {key,epoch}=writeKey(user.id,v),attachmentId=id(),fileKey=await createFileKey(key),preview=await imagePreview(file);
  const chunks=Math.max(1,Math.ceil(file.size/FILE_CHUNK_BYTES)),previewChunks=preview?Math.max(1,Math.ceil(preview.size/FILE_CHUNK_BYTES)):0;
  const start=await fileJson(user,vid,'start',{vaultId:vid,objectId,attachmentId,chunkCount:chunks,previewChunks,keyEpoch:epoch});
  let sent=0,total=file.size+(preview?.size??0);const report=()=>onProgress?.({sent,total,percent:total?Math.min(100,Math.round(sent*100/total)):100});
  try{
    for(let index=0;index<chunks;index++){
      if(signal?.aborted)throw new DOMException('Загрузка отменена','AbortError');
      const from=index*FILE_CHUNK_BYTES,to=Math.min(file.size,from+FILE_CHUNK_BYTES),plain=new Uint8Array(await file.slice(from,to).arrayBuffer());
      const encrypted=await encryptFileChunk(fileKey.key,cryptoAccount(user.id,v),vid,attachmentId,'data',index,plain);await putFileChunk(user,vid,start.uploadId,'data',index,encrypted,signal);sent+=plain.length;report();
    }
    if(preview)for(let index=0;index<previewChunks;index++){
      if(signal?.aborted)throw new DOMException('Загрузка отменена','AbortError');
      const from=index*FILE_CHUNK_BYTES,to=Math.min(preview.size,from+FILE_CHUNK_BYTES),plain=new Uint8Array(await preview.slice(from,to).arrayBuffer());
      const encrypted=await encryptFileChunk(fileKey.key,cryptoAccount(user.id,v),vid,attachmentId,'preview',index,plain);await putFileChunk(user,vid,start.uploadId,'preview',index,encrypted,signal);sent+=plain.length;report();
    }
    try{await fileJson(user,vid,'complete',{uploadId:start.uploadId});}catch(first){
      // Completion is idempotent: retry once so a lost HTTP response does not orphan a fully uploaded file.
      try{await fileJson(user,vid,'complete',{uploadId:start.uploadId});}catch{throw first;}
    }
    return{warning:Boolean(start.warning),attachment:{id:attachmentId,name:(file.name||'Файл').slice(0,200),type:(file.type||'application/octet-stream').slice(0,100),size:file.size,
      storage:'stream',wrappedKey:fileKey.wrappedKey,chunks,keyEpoch:epoch,...(preview?{preview:{type:preview.type||'image/webp',size:preview.size,chunks:previewChunks}}:{})}};
  }catch(error){throw error;}
}
async function cleanupOpfsFiles(directory:any,prefix:string,maxAge=24*60*60*1000){
  if(typeof directory.entries!=='function')return;
  try{for await(const [name,handle] of directory.entries())if(name.startsWith(prefix)&&handle?.kind==='file'){
    try{const file=await handle.getFile();if(Date.now()-file.lastModified>maxAge)await directory.removeEntry(name);}catch{}
  }}catch{}
}
async function streamedBlob(user:User,vid:string,item:NoteAttachment,kind:'data'|'preview'){
  if(item.storage!=='stream'||!item.wrappedKey||!item.chunks||item.keyEpoch===undefined)throw Error('Вложение хранится в старом формате.');
  const {v}=await fileHeaders(user,vid,false),root=fileEpochKey(user.id,v,item.keyEpoch),key=await unwrapFileKey(root,item.wrappedKey),count=kind==='data'?item.chunks:item.preview?.chunks??0;
  const storage=navigator.storage as StorageManager&{getDirectory?:()=>Promise<any>};
  if(kind==='data'&&storage.getDirectory){
    const directory=await storage.getDirectory();await cleanupOpfsFiles(directory,'tasks-download-');const temp='tasks-download-'+crypto.randomUUID(),handle=await directory.getFileHandle(temp,{create:true}),writer=await handle.createWritable();
    const cryptoVaultId=item.cryptoVaultId??vid;
    try{for(let index=0;index<count;index++){const plain=await decryptFileChunk(key,cryptoAccount(user.id,v),cryptoVaultId,item.id,kind,index,await getFileChunk(user,vid,item.id,kind,index));await writer.write(plain);}}
    catch(error){await writer.abort().catch(()=>{});await directory.removeEntry(temp).catch(()=>{});throw error;}
    await writer.close();const file=await handle.getFile();setTimeout(()=>void directory.removeEntry(temp).catch(()=>{}),10*60*1000);return file as Blob;
  }
  const cryptoVaultId=item.cryptoVaultId??vid;
  const parts:BlobPart[]=[];for(let index=0;index<count;index++)parts.push(Uint8Array.from(await decryptFileChunk(key,cryptoAccount(user.id,v),cryptoVaultId,item.id,kind,index,await getFileChunk(user,vid,item.id,kind,index))));
  return new Blob(parts,{type:kind==='data'?item.type:item.preview?.type??'application/octet-stream'});
}
export async function attachmentBlob(user:User,vid:string,item:NoteAttachment){if(item.storage==='stream')return streamedBlob(user,vid,item,'data');if(!item.data)throw Error('Вложение повреждено');return fetch(item.data).then(r=>r.blob());}
export async function attachmentPlainStream(user:User,vid:string,item:NoteAttachment){
  if(item.storage!=='stream'||!item.wrappedKey||!item.chunks||item.keyEpoch===undefined)throw Error('Вложение не является потоковым.');
  const {v}=await fileHeaders(user,vid,false),root=fileEpochKey(user.id,v,item.keyEpoch),key=await unwrapFileKey(root,item.wrappedKey),cryptoVaultId=item.cryptoVaultId??vid;
  async function* chunks(){for(let index=0;index<item.chunks!;index++)yield await decryptFileChunk(key,cryptoAccount(user.id,v),cryptoVaultId,item.id,'data',index,await getFileChunk(user,vid,item.id,'data',index));}
  return{size:item.size,chunks:chunks()};
}
export async function attachmentPreviewBlob(user:User,vid:string,item:NoteAttachment){if(item.storage==='stream'&&item.preview)return streamedBlob(user,vid,item,'preview');if(item.type.startsWith('image/'))return attachmentBlob(user,vid,item);return null;}
export async function deleteAttachmentFile(user:User,vid:string,attachmentId:string){await fileJson(user,vid,'delete',{vaultId:vid,attachmentId});}
export async function moveAttachmentFile(user:User,vid:string,attachmentId:string,objectId:string){await fileJson(user,vid,'move',{vaultId:vid,attachmentId,objectId});}

// Only short local transactions use the data lock. The network lock does not block typing/saving.
async function commit(user:User,fn:(s:State)=>Promise<void>){
  await exclusive(async()=>{const s=await readState(user.id);if(!s)throw Error('Локальный аккаунт закрыт');await fn(s);await writeState(s);announce();});
}
const wire=(r:Revision)=>{const{pending:_,reminderPending:__,lifecyclePending:___,authorUserId:____,createdAt:_____,...value}=r;return value;};
function lock(v:Vault,epoch?:number,accountId?:string){if(accountId){clearRuntimeVaultKey(accountId,v.header.id);clearVaultEpochKeys(accountId,v.header.id);}delete v.key;delete v.grant;v.needsGrant=false;if(epoch!==undefined){if(v.systemUnlock&&v.systemUnlock.lockEpoch!==epoch)delete v.systemUnlock;v.epoch=epoch;}}
function applyRemoteVaultMetadata(userId:string,v:Vault,item:any){
  const previousVersion=v.keyring?.version??0,nextVersion=item.keyring?.version??0,role=item.role as Vault['role'];
  if(role)v.role=role;if(typeof item.ownerId==='string')v.ownerId=item.ownerId;v.shared=Boolean(item.shared);delete v.membershipRevoked;
  v.keyring=item.keyring?{version:item.keyring.version,currentEpoch:item.keyring.currentEpoch,...(item.keyring.ownerBox?{ownerBox:item.keyring.ownerBox}:{})}:undefined;
  v.memberEnvelope=item.envelope?{keyringVersion:item.envelope.keyringVersion,identityVersion:item.envelope.identityVersion,keyEnvelope:item.envelope.keyEnvelope}:undefined;
  if(v.role!=='owner'&&previousVersion>0&&nextVersion>0&&previousVersion!==nextVersion){clearVaultEpochKeys(userId,v.header.id);delete v.key;delete v.grant;v.needsGrant=true;}
}
const accessContext=(user:string,v:Vault)=>vaultContext(user,v,v.header.keyId,v.header.keyId);
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
    clearRuntimeVaultKey(user.id,vid);clearVaultEpochKeys(user.id,vid);await commit(user,async s=>{s.vaults=s.vaults.filter(v=>v.header.id!==vid);s.reminderSeen=(s.reminderSeen??[]).filter(item=>item.vaultId!==vid);if(s.lastVaultId===vid)delete s.lastVaultId;});return;
  }
  let grant=initial.deviceId&&current.grant?{deviceId:initial.deviceId,token:current.grant}:await grantForOpenVault(user,vid);
  try{await vaultRequest(user.id,'/delete',{vaultId:vid,confirmed:true},{deviceId:grant.deviceId,grants:{[vid]:grant.token}});}
  catch(error){
    if(!(error instanceof APIError)||error.code!=='vault_locked')throw error;
    grant=await grantForOpenVault(user,vid);
    await vaultRequest(user.id,'/delete',{vaultId:vid,confirmed:true},{deviceId:grant.deviceId,grants:{[vid]:grant.token}});
  }
  clearRuntimeVaultKey(user.id,vid);clearVaultEpochKeys(user.id,vid);
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
      const epoch=item.epoch??0;if(epoch>(v.epoch??0))lock(v,epoch,user.id);v.epoch=epoch;v.access=item.access??undefined;applyRemoteVaultMetadata(user.id,v,item);if(typeof item.displayName==='string')v.displayName=item.displayName;});
    if(item.deleted)continue;let currentState=await readState(user.id),currentVault=currentState?.vaults.find(v=>v.header.id===local.header.id);if(!currentState||!currentVault||currentVault.syncError)continue;
    if((currentVault.epoch??0)>0&&!currentVault.grant&&currentVault.key&&currentVault.needsGrant&&currentVault.access){
      const challenge=await vaultRequest(user.id,'/access/challenge',{vaultId:currentVault.header.id,deviceId:currentState.deviceId},{deviceId:currentState.deviceId,grants:{}}),c=challenge.challenge;
      if(!Array.isArray(c)||c.length!==8||c[5]!==currentState.deviceId)throw new APIError('vault_locked');const signature=await signAccess(currentVault.key,accessContext(user.id,currentVault),currentVault.access,c);
      const granted=await vaultRequest(user.id,'/access/grant',{vaultId:currentVault.header.id,deviceId:currentState.deviceId,challengeId:c[6],signature},{deviceId:currentState.deviceId,grants:{}});
      await commit(user,async s=>{const v=vault(s,currentVault!.header.id,false);v.grant=granted.token;v.needsGrant=false;});
    }
    let after=0;try{for(;;){const current=await readState(user.id);if(!current)break;const v=current.vaults.find(v=>v.header.id===local.header.id);if(!v)break;
      const grants:Record<string,string>={};if(v.grant)grants[v.header.id]=v.grant;const page=await vaultRequest(user.id,'/'+v.header.id+'?after='+after,undefined,{deviceId:current.deviceId,grants});
      if(!Array.isArray(page.records)||page.records.length>5)throw Error('Некорректный ответ сервера');await commit(user,async s=>{const target=vault(s,v.header.id,false);for(const r of page.records){const existing=target.records.find(x=>x.id===r.id);if(!existing)target.records.push(r);else{if(JSON.stringify(wire(existing))!==JSON.stringify(wire(r)))throw Error('Версия заметки изменена на сервере');existing.authorUserId=r.authorUserId;existing.createdAt=r.createdAt;}}});
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
        v.epoch=epoch;v.access=item.access??undefined;applyRemoteVaultMetadata(user.id,v,item);
        if(v.closeOperation&&epoch>(v.closeBaseEpoch??0)){delete v.closeOperation;delete v.closeBaseEpoch;}
      });
    }
    const remoteIds=new Set(remote.vaults.map((item:any)=>item.id));
    await commit(user,async s=>{for(const v of s.vaults){
      if(v.shared&&v.role&&v.role!=='owner'&&!v.deleted&&!remoteIds.has(v.header.id)){
        await stashRevokedChanges(s,v);
        v.membershipRevoked=true;v.role='viewer';delete v.grant;v.needsGrant=false;
        v.syncError='Доступ к совместному хранилищу отозван. Несинхронизированные изменения сохранены в личном локальном stash; shared vault оставлен как read-only копия ранее полученных данных.';
      }
    }});
    const ids=(await readState(user.id))?.vaults.filter(v=>!v.deleted&&!v.membershipRevoked).map(v=>v.header.id)??[];
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
      if(v.shared&&v.role&&v.role!=='owner'&&!v.key&&getCollaborationRuntime(user.id)&&v.memberEnvelope){
        try{await unlockMemberVault(user,vid);}catch{/* Keep ciphertext synchronized; explicit unlock can surface key/identity errors. */}
        ({s,v}=await snapshot(vid));
      }
      if(!v.access&&v.key&&(!v.role||v.role==='owner')){
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
      ({s,v}=await snapshot(vid));
      if(v.shared&&getCollaborationRuntime(user.id))await syncPersonalReminderConfigs(user,vid);
      ({s,v}=await snapshot(vid));
      if(v.key&&(!v.role||v.role==='owner')&&!remote.vaults.find((item:any)=>item.id===vid)?.displayName){
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
          if(!local)current.records.push(r);else{if(JSON.stringify(wire(local))!==JSON.stringify(wire(r)))throw Error('Версия заметки изменена на сервере');local.pending=false;local.authorUserId=r.authorUserId;local.createdAt=r.createdAt;}}
      });
      ({v}=await snapshot(vid));
      const outgoing=v.transfer?[]:v.records.filter(r=>r.pending);
      for(const r of outgoing){
        const latest=(await snapshot(vid)).v;if(latest.transfer||latest.deleted)break;
        const attachmentIds=r.objectId===vid?[]:(await readNote(user.id,latest,r)).attachments?.filter(item=>item.storage==='stream').map(item=>item.id)??[];
        await api('/record',{vaultId:vid,record:wire(r),attachmentIds},[vid]);
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
      if(v.key&&(!v.shared||getCollaborationRuntime(user.id))){
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
        if(!expected||!actual||JSON.stringify(wire(expected))!==JSON.stringify(wire(actual)))throw Error('Проверка перенесённой заметки не прошла');}
      if(transfer.files?.length){
        const state=await readState(user.id);if(!state)throw Error('Локальный аккаунт закрыт');
        const sourceVault=state.vaults.find(item=>item.header.id===vid),targetVault=state.vaults.find(item=>item.header.id===transfer.target);
        const grants:Record<string,string>={};if(sourceVault?.grant)grants[vid]=sourceVault.grant;if(targetVault?.grant)grants[transfer.target]=targetVault.grant;
        const headers={'X-Tasks-Account':user.id,'X-Tasks-Device':state.deviceId??'','X-Vault-Grants':JSON.stringify(grants),'X-CSRF-Token':await csrfToken(),'Content-Type':'application/json'};
        const response=await fetch('/api/files/transfer',{method:'POST',headers,credentials:'same-origin',cache:'no-store',
          body:JSON.stringify({source:vid,target:transfer.target,attachmentIds:transfer.files}),signal:AbortSignal.timeout(30000)});
        const value=await response.json();if(!response.ok)throw new APIError(value?.error??'network');
      }
      await api('/transfer',{source:vid,target:transfer.target,revisions:transfer.revisions,confirmed:true},[vid,transfer.target]);
      await commit(user,async state=>{const current=vault(state,vid,false);current.deleted=true;current.records=[];lock(current,undefined,user.id);delete current.systemUnlock;delete current.transfer;
        state.reminderSeen=(state.reminderSeen??[]).filter(x=>x.vaultId!==vid);});
    }catch(error){await recordFailure(vid,error);}}
    if(failures.length)throw Error([...new Set(failures)].join(' · '));
  });
}
export async function lockAfterBackground(user:User,durationMs:number){
  let changed=false;await exclusive(async()=>{const s=await readState(user.id);if(!s)return;
    for(const v of s.vaults){const limit=v.systemUnlock?.autoLockMs??0;if(limit>0&&durationMs>=limit&&v.key){clearRuntimeVaultKey(user.id,v.header.id);if(v.shared)clearVaultEpochKeys(user.id,v.header.id);delete v.key;changed=true;}}
    if(changed)await writeState(s);});if(changed)announce('vault-lock');return changed;
}
export const hasUnsaved = (s: State) => Boolean(s.reminderSeen?.length)||Boolean(Object.values(s.personalReminderConfigs??{}).some(item=>item.pending))||s.stash.length > 0 || s.vaults.some(v => v.pending || v.transfer || Boolean(v.purgePending?.length)||Boolean(v.purgedObjects?.length)||v.records.some(r => r.pending||r.reminderPending||r.lifecyclePending));
let flushHandler: (() => Promise<void>) | undefined;
export function registerDraftFlush(fn?: () => Promise<void>) { flushHandler = fn; }
export async function flushDraft() { await flushHandler?.(); }
