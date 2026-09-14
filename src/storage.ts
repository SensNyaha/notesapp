import type { User } from './types/auth';
import type { WrappedKey } from './crypto/vault';
import type { Sealed } from './crypto/records';
import type { AccessPack } from './crypto/access';
export interface Header { id: string; keyId: string; revisionId: string; wrapper: WrappedKey; name: Sealed }
export interface Revision { id: string; objectId: string; parent: string | null; sealed: Sealed; pending?: boolean; reminderPending?:boolean; resolves?:string[] }
export interface Vault { header: Header; key?: CryptoKey; pending?: boolean; deleted?: boolean; records: Revision[];
  transfer?: { target: string; revisions: string[] }; epoch?:number; access?:AccessPack; grant?:string;
  needsGrant?:boolean; closeOperation?:string; closeBaseEpoch?:number; syncError?:string }
export interface Stashed { id: string; sealed: Sealed; source: string }
export interface ReminderSeen { vaultId:string;objectId:string;configId:string }
export interface State { user: User; vaults: Vault[]; stash: Stashed[]; stashKey?: CryptoKey; deviceId?:string; deviceName?:string; lastVaultId?:string;
  reminderSeen?:ReminderSeen[] }
let connection: Promise<IDBDatabase> | undefined;
function database() {
  return connection ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('tasks-private-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('accounts', { keyPath: 'user.id' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
export async function readState(id: string): Promise<State | undefined> {
  const db = await database(); return new Promise((resolve, reject) => {
    const t = db.transaction('accounts'), r = t.objectStore('accounts').get(id);
    t.oncomplete = () => resolve(r.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
export async function profiles(): Promise<User[]> {
  const db = await database(); return new Promise((resolve, reject) => {
    const t = db.transaction('accounts'), r = t.objectStore('accounts').getAll();
    t.oncomplete = () => resolve(r.result.map((s: State) => s.user)); t.onabort = () => reject(t.error);
  });
}
export async function writeState(state: State) {
  const db = await database(); await new Promise<void>((resolve, reject) => {
    const t = db.transaction('accounts', 'readwrite'); t.objectStore('accounts').put(state);
    t.oncomplete = () => resolve(); t.onabort = () => reject(t.error); t.onerror = () => reject(t.error);
  });
}
export async function eraseState(id: string) {
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
