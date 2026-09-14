import { generateVaultKey, wrapWithPhrase, unwrapWithPhrase, type Context } from './crypto/vault.ts';
import { seal, unseal, rememberKey } from './crypto/records.ts';
import { readState, writeState, exclusive, announce, type State, type Vault, type Header, type Revision } from './storage.ts';
import { session } from './auth.ts';
import type { User } from './types/auth';
import { createAccess, signAccess } from './crypto/access.ts';
import { validPlan } from '../shared/reminders.mjs';
import type { ReminderPlan } from '../shared/reminders.mjs';
import { reminderRequest } from './reminders.ts';
export interface Note { title: string; text: string; reminder?:ReminderPlan; author?:{name:string;time:number} }
const id = () => crypto.randomUUID();
export const heads = (v: Vault) => { const parents = new Set(v.records.flatMap(r => [r.parent,...(r.resolves??[])])); return v.records.filter(r => !parents.has(r.id)); };
export const context = (user: string, v: Header, objectId: string, revisionId: string): Context =>
  ({ accountId: user, vaultId: v.id, keyId: v.keyId, objectId, revisionId });
function note(value: unknown): Note {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string'
    || !('text' in value) || typeof value.text !== 'string') throw Error('Повреждённая заметка');
  const author='author' in value?value.author:undefined;
  const reminder='reminder'in value?value.reminder:undefined;
  if(reminder!==undefined&&!validPlan(reminder))throw Error('Повреждено напоминание');
  return { title: value.title, text: value.text, ...(reminder?{reminder}:{}), ...(author&&typeof author==='object'&&'name'in author&&typeof author.name==='string'&&'time'in author&&Number.isSafeInteger(author.time)
    ?{author:author as {name:string;time:number}}:{}) };
}
export async function readNote(user: string, v: Vault, r: Revision): Promise<Note> {
  if (!v.key) throw Error('Откройте хранилище');
  const value=await unseal(v.key, context(user, v.header, r.objectId, r.id), r.parent, r.sealed) as Note&{resolves?:string[]};
  if(JSON.stringify(value.resolves??[])!==JSON.stringify(r.resolves??[]))throw Error('Повреждена связь конфликтующих версий');
  return note(value);
}
export async function vaultName(user: string, v: Vault) {
  if (!v.key) return 'Закрытое хранилище · ' + v.header.id.slice(0, 8);
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
function phraseCheck(phrase: string) {
  if (Array.from(phrase).length < 6 || new TextEncoder().encode(phrase).length > 4096) throw Error('Фраза: минимум 6 символов, максимум 4096 байт.');
}
async function makeVault(user: string, name: string, phrase: string): Promise<Vault> {
  phraseCheck(phrase); if (!name.trim() || name.length > 200) throw Error('Название: от 1 до 200 символов');
  const key = await generateVaultKey(), v = { id: id(), keyId: id(), revisionId: id() };
  const ctx = { accountId: user, vaultId: v.id, keyId: v.keyId, objectId: v.keyId, revisionId: v.revisionId };
  const header: Header = { ...v, wrapper: await wrapWithPhrase(key, ctx, phrase),
    name: await seal(key, { ...ctx, objectId: v.id }, null, name) };
  return { header, key: await rememberKey(key), records: [], pending: true };
}
export const createVault = (user: User, name: string, phrase: string) => edit(user, async s => {
  const v = await makeVault(user.id, name, phrase); s.vaults.push(v); return v.header.id;
});
export const openVault = (user: User, vid: string, phrase: string) => edit(user, async s => {
  const v = vault(s, vid, false);
  try { v.key = await rememberKey(await unwrapWithPhrase(context(user.id, v.header, v.header.keyId, v.header.revisionId), phrase, v.header.wrapper));
    await vaultName(user.id, v);
  } catch { delete v.key; throw Error('Неверная фраза или повреждённые данные.'); }
  if (v.deleted) await stashDeleted(s, v);
  else v.needsGrant=true;
});
export const closeVault = (user: User, vid: string) => edit(user, async s => {
  const v = vault(s, vid); if (v.transfer) throw Error('Сначала завершите перенос');
  if (v.deleted) await stashDeleted(s, v); delete v.key;delete v.grant;v.needsGrant=false;
});
async function addRevision(user: string, v: Vault, objectId: string, parent: string | null, value: Note) {
  if (!v.key || v.deleted || v.transfer) throw Error('Хранилище недоступно для записи');
  const rid = id(), r: Revision = { id: rid, objectId, parent, sealed: await seal(v.key, context(user, v.header, objectId, rid), parent, value), pending: true, reminderPending:true };
  v.records.push(r); return r;
}
export const saveNote = (user: User, vid: string, objectId: string, parent: string | null, value: Note, draftKey?: CryptoKey) => edit(user, async s => {
  const v = vault(s, vid, false); if (v.deleted) {
    await addStash(s, vid, value); return { id: parent ?? objectId, stashed: true };
  }
  // An already-open editor may finish encrypting its draft after another tab closed the vault.
  // Never persist the temporary key again or put this draft into an independently accessible stash.
  const writable = v.key ? v : { ...v, key: draftKey };
  const r = await addRevision(user.id, writable, objectId, parent, {...value,author:{name:s.deviceName??'Устройство',time:Date.now()}}); return { id: r.id, stashed: false };
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
export const moveStash = (user: User, sid: string, target: string) => edit(user, async s => {
  const value=await readStash(s,sid);
  await addRevision(user.id,vault(s,target),id(),null,{...value,...(value.reminder?{reminder:{...value.reminder,id:id(),state:'off' as const}}:{})});
  s.stash = s.stash.filter(r => r.id !== sid);
});
export const discardStash = (user: User, sid: string) => edit(user, async s => { s.stash = s.stash.filter(r => r.id !== sid); });
export const renameDevice=(user:User,name:string)=>edit(user,async s=>{
  if(!name.trim()||name.length>80)throw Error('Название устройства: от 1 до 80 символов');s.deviceName=name.trim();
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
  if(keepBoth)for(const r of others){const copy=await readNote(user.id,v,r);
    await addRevision(user.id,v,id(),null,{...copy,...(copy.reminder?{reminder:{...copy.reminder,id:id(),state:'off' as const}}:{}),author});}
});
export const transferVault = (user: User, source: string, name: string, phrase: string) => edit(user, async s => {
  const v = vault(s, source); if (v.deleted || v.transfer) throw Error('Перенос уже начат или хранилище удалено');
  const target = await makeVault(user.id, name, phrase);
  for (const r of heads(v)){const copy=await readNote(user.id,v,r);
    await addRevision(user.id,target,id(),null,{...copy,...(copy.reminder?{reminder:{...copy.reminder,id:id(),state:'off' as const}}:{})});}
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
const wire=(r:Revision)=>{const{pending:_,reminderPending:__,...value}=r;return value;};
function lock(v:Vault,epoch?:number){delete v.key;delete v.grant;v.needsGrant=false;if(epoch!==undefined)v.epoch=epoch;}
const accessContext=(user:string,v:Vault)=>context(user,v.header,v.header.keyId,v.header.keyId);
export async function closeAllVault(user:User,vid:string,password:string){
  const actor=await session();if(actor?.id!==user.id)throw Error('Войдите в этот аккаунт');
  let operationId='';
  await commit(user,async s=>{const v=vault(s,vid,false);if(v.pending||!v.access)throw Error('Сначала синхронизируйте открытое хранилище');
    if(v.transfer)throw Error('Сначала завершите перенос');
    if(!v.closeOperation){v.closeOperation=id();v.closeBaseEpoch=v.epoch??0;}operationId=v.closeOperation;});
  const result=await vaultRequest(user.id,'/close-all',{vaultId:vid,operationId,password,confirmed:true});
  await commit(user,async s=>{const v=vault(s,vid,false);lock(v,result.epoch);delete v.closeOperation;delete v.closeBaseEpoch;});
}
export async function acknowledgeReminder(user:User,target:{vaultId:string;objectId:string;configId:string}){
  await edit(user,async s=>{s.reminderSeen??=[];if(!s.reminderSeen.some(x=>x.vaultId===target.vaultId&&x.objectId===target.objectId&&x.configId===target.configId))s.reminderSeen.push(target);});
  try{
    const current=await session();if(current?.id!==user.id)return;
    const result=await reminderRequest(user,'seen',target);
    if(result.exists)await commit(user,async s=>{s.reminderSeen=(s.reminderSeen??[]).filter(x=>x.vaultId!==target.vaultId||x.objectId!==target.objectId||x.configId!==target.configId);});
  }catch{/* The durable local acknowledgement is retried by synchronize(). */}
}
export async function synchronize(user:User){
  if(!navigator.locks)throw Error('Для синхронизации нужен Web Locks');
  return navigator.locks.request('tasks-sync:'+user.id,async()=>{
    if(!await readState(user.id))return;
    const current=await session();if(current?.id!==user.id)throw Error('Для синхронизации войдите в этот аккаунт. Локальные данные сохранены.');
    await commit(user,async s=>{s.deviceId??=id();s.deviceName??='Устройство';});
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
    const failures:string[]=[];
    const remote=await api('');
    for(const item of remote.vaults){
      await commit(user,async s=>{
        let v=s.vaults.find(v=>v.header.id===item.id);
        if(item.deleted){s.reminderSeen=(s.reminderSeen??[]).filter(x=>x.vaultId!==item.id);if(v){v.deleted=true;await stashDeleted(s,v);}return;}
        if(!v){v={header:item.header,records:[]};s.vaults.push(v);}
        if(JSON.stringify(v.header)!==JSON.stringify(item.header)){v.syncError='Заголовок хранилища изменён';failures.push(v.syncError);return;}
        const epoch=item.epoch??0;
        if(epoch<(v.epoch??0))throw Error('Сервер вернул устаревшую блокировку');
        if(epoch>(v.epoch??0))lock(v,epoch);
        v.epoch=epoch;v.access=item.access??undefined;
        if(v.closeOperation&&epoch>(v.closeBaseEpoch??0)){delete v.closeOperation;delete v.closeBaseEpoch;}
      });
    }
    const ids=(await readState(user.id))?.vaults.filter(v=>!v.deleted).map(v=>v.header.id)??[];
    async function recordFailure(vid:string,error:unknown){
      await commit(user,async s=>{
        const v=vault(s,vid,false);
        if(error instanceof APIError&&error.code==='vault_deleted'){v.deleted=true;await stashDeleted(s,v);return;}
        if(error instanceof APIError&&error.code==='vault_locked')lock(v);
        v.syncError=error instanceof Error?error.message:'Ошибка синхронизации';failures.push(v.syncError);
      });
    }
    for(const vid of ids){try{
      let {s,v}=await snapshot(vid);
      const remoteHeader=remote.vaults.find((x:any)=>x.id===vid&&!x.deleted)?.header;
      if(remoteHeader&&JSON.stringify(remoteHeader)!==JSON.stringify(v.header))continue;
      if(v.pending){
        const source=s.vaults.find(x=>x.transfer?.target===vid);
        await api('/create',{...v.header,...(source?{transferSource:source.header.id}:{})},source?[source.header.id]:[]);
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
      if(v.key){
        const pendingSeen=(await readState(user.id))?.reminderSeen?.filter(x=>x.vaultId===vid)??[];
        for(const target of pendingSeen){const current=(await snapshot(vid)).v,latest=heads(current).filter(r=>r.objectId===target.objectId);
          if(latest.length===1&&current.key){const value=await readNote(user.id,current,latest[0]);
            if(value.reminder?.id!==target.configId)await commit(user,async state=>{state.reminderSeen=(state.reminderSeen??[]).filter(x=>x.vaultId!==vid||x.objectId!==target.objectId||x.configId!==target.configId);});}}
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
      if(result.exists)await commit(user,async s=>{s.reminderSeen=(s.reminderSeen??[]).filter(x=>x.vaultId!==target.vaultId||x.objectId!==target.objectId||x.configId!==target.configId);});
    }
    const transfers=(await readState(user.id))?.vaults.filter(v=>v.transfer&&!v.deleted).map(v=>v.header.id)??[];
    for(const vid of transfers){try{
      const {s,v}=await snapshot(vid),transfer=v.transfer!;const target=s.vaults.find(x=>x.header.id===transfer.target);
      if(!target||target.pending||target.deleted||target.syncError||target.records.some(r=>r.reminderPending))continue;
      const received=await fetchRecords(transfer.target);
      for(const rid of transfer.revisions){const expected=target.records.find(r=>r.id===rid),actual=received.find(r=>r.id===rid);
        if(!expected||!actual||JSON.stringify(wire(expected))!==JSON.stringify(actual))throw Error('Проверка перенесённой заметки не прошла');}
      await api('/transfer',{source:vid,target:transfer.target,revisions:transfer.revisions,confirmed:true},[vid,transfer.target]);
      await commit(user,async state=>{const current=vault(state,vid,false);current.deleted=true;current.records=[];lock(current);delete current.transfer;
        state.reminderSeen=(state.reminderSeen??[]).filter(x=>x.vaultId!==vid);});
    }catch(error){await recordFailure(vid,error);}}
    if(failures.length)throw Error([...new Set(failures)].join(' · '));
  });
}
export const hasUnsaved = (s: State) => Boolean(s.reminderSeen?.length)||s.stash.length > 0 || s.vaults.some(v => v.pending || v.transfer || v.records.some(r => r.pending||r.reminderPending));
let flushHandler: (() => Promise<void>) | undefined;
export function registerDraftFlush(fn?: () => Promise<void>) { flushHandler = fn; }
export async function flushDraft() { await flushHandler?.(); }
