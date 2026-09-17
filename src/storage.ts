import type { User } from './types/auth';
import type { WrappedKey } from './crypto/vault';
import type { Sealed } from './crypto/records';
import type { AccessPack } from './crypto/access';
import type { VaultSystemUnlock } from './crypto/system-unlock';
export interface Header { id: string; keyId: string; revisionId: string; wrapper: WrappedKey; name: Sealed }
export interface LifecyclePending { state:'active'|'trash';expected:string|null }
export interface ObjectState { state:'active'|'trash'|'purged';recordId:string;trashedAt?:number;purgeAfter?:number }
export interface Revision { id: string; objectId: string; parent: string | null; sealed: Sealed; pending?: boolean; reminderPending?:boolean; resolves?:string[];
  lifecyclePending?:LifecyclePending }
export interface Vault { header: Header; displayName?:string; key?: CryptoKey; pending?: boolean; deleted?: boolean; records: Revision[];
  transfer?: { target: string; revisions: string[] }; epoch?:number; access?:AccessPack; grant?:string;
  needsGrant?:boolean; closeOperation?:string; closeBaseEpoch?:number; syncError?:string; systemUnlock?:VaultSystemUnlock;
  objectStates?:Record<string,ObjectState>;purgePending?:string[];purgedObjects?:string[] }
export interface Stashed { id: string; sealed: Sealed; source: string }
export interface ReminderSeen { vaultId:string;objectId:string;configId:string;occurrenceId?:string }
export interface State { user: User; vaults: Vault[]; stash: Stashed[]; stashKey?: CryptoKey; deviceId?:string; deviceName?:string; deviceNameDirty?:boolean; deviceRegistered?:boolean; lastVaultId?:string;
  reminderSeen?:ReminderSeen[]; lastOpenedAt?:number; sessionReviewRequired?:boolean; reviewAccepted?:string[] }
let connection: Promise<IDBDatabase> | undefined;
function database() {
  return connection ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('tasks-private-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('accounts', { keyPath: 'user.id' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
const runtimeVaultKeys = new Map<string,CryptoKey>();
const runtimeId = (accountId:string,vaultId:string) => accountId+':'+vaultId;
export function setRuntimeVaultKey(accountId:string,vaultId:string,key:CryptoKey){runtimeVaultKeys.set(runtimeId(accountId,vaultId),key);}
export function clearRuntimeVaultKey(accountId:string,vaultId:string){runtimeVaultKeys.delete(runtimeId(accountId,vaultId));}
export function clearRuntimeVaultKeys(accountId:string){for(const id of runtimeVaultKeys.keys())if(id.startsWith(accountId+':'))runtimeVaultKeys.delete(id);}
export function hasRuntimeVaultKey(accountId:string,vaultId:string){return runtimeVaultKeys.has(runtimeId(accountId,vaultId));}
function hydrate(state:State|undefined){if(!state)return state;for(const v of state.vaults)if(v.systemUnlock){const key=runtimeVaultKeys.get(runtimeId(state.user.id,v.header.id));if(key)v.key=key;else delete v.key;}return state;}
function persistent(state:State):State{const vaults=state.vaults.map(v=>{if(!v.systemUnlock)return v;if(v.key)runtimeVaultKeys.set(runtimeId(state.user.id,v.header.id),v.key);const{key:_,...rest}=v;return rest;});return{...state,vaults};}
export async function readState(id: string): Promise<State | undefined> {
  const db = await database(); return new Promise((resolve, reject) => {
    const t = db.transaction('accounts'), r = t.objectStore('accounts').get(id);
    t.oncomplete = () => resolve(hydrate(r.result as State|undefined)); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
export async function profileActivity(): Promise<{user:User;lastOpenedAt?:number}[]> {
  const db = await database(); return new Promise((resolve, reject) => {
    const t = db.transaction('accounts'), r = t.objectStore('accounts').getAll();
    t.oncomplete = () => resolve((r.result as State[]).map(s=>({user:s.user,lastOpenedAt:s.lastOpenedAt}))
      .sort((a,b)=>(b.lastOpenedAt??0)-(a.lastOpenedAt??0)));t.onerror=()=>reject(t.error);t.onabort = () => reject(t.error);
  });
}
export async function profiles(): Promise<User[]> { return (await profileActivity()).map(item=>item.user); }
export async function writeState(state: State) {
  const db = await database(); await new Promise<void>((resolve, reject) => {
    const t = db.transaction('accounts', 'readwrite'); t.objectStore('accounts').put(persistent(state));
    t.oncomplete = () => resolve(); t.onabort = () => reject(t.error); t.onerror = () => reject(t.error);
  });
}
export async function eraseState(id: string) {
  clearRuntimeVaultKeys(id);
  const db = await database(); await new Promise<void>((resolve, reject) => {
    const t = db.transaction('accounts', 'readwrite'); t.objectStore('accounts').delete(id);
    t.oncomplete = () => resolve(); t.onabort = () => reject(t.error);
  });
}
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return Promise.reject(Error('Для безопасного сохранения нужен браузер с Web Locks.'));
  return navigator.locks.request('tasks-private-data', fn);
}
export const changes = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tasks-private-changes') : null;
export function announce(message = 'changed') { changes?.postMessage(message); window.dispatchEvent(new CustomEvent('tasks-data', { detail: message })); }
