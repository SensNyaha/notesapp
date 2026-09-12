import { generateVaultKey, wrapWithPhrase, unwrapWithPhrase, type Context } from './crypto/vault.ts';
import { seal, unseal, rememberKey } from './crypto/records.ts';
import { readState, writeState, exclusive, announce, type State, type Vault, type Header, type Revision } from './storage.ts';
import { session } from './auth.ts';
import type { User } from './types/auth';
export interface Note { title: string; text: string }
const id = () => crypto.randomUUID();
export const heads = (v: Vault) => { const parents = new Set(v.records.map(r => r.parent)); return v.records.filter(r => !parents.has(r.id)); };
export const context = (user: string, v: Header, objectId: string, revisionId: string): Context =>
  ({ accountId: user, vaultId: v.id, keyId: v.keyId, objectId, revisionId });
function note(value: unknown): Note {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string'
    || !('text' in value) || typeof value.text !== 'string') throw Error('Повреждённая заметка');
  return { title: value.title, text: value.text };
}
export async function readNote(user: string, v: Vault, r: Revision): Promise<Note> {
  if (!v.key) throw Error('Откройте хранилище');
  return note(await unseal(v.key, context(user, v.header, r.objectId, r.id), r.parent, r.sealed));
}
export async function vaultName(user: string, v: Vault) {
  if (!v.key) return 'Закрытое хранилище · ' + v.header.id.slice(0, 8);
  const result = await unseal(v.key, context(user, v.header, v.header.id, v.header.revisionId), null, v.header.name);
  if (typeof result !== 'string') throw Error('Повреждённое имя хранилища'); return result;
}
export async function edit<T>(user: User, fn: (s: State) => Promise<T>): Promise<T> {
  return exclusive(async () => {
    const s = await readState(user.id) ?? { user, vaults: [], stash: [] };
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
});
export const closeVault = (user: User, vid: string) => edit(user, async s => {
  const v = vault(s, vid); if (v.transfer) throw Error('Сначала завершите перенос');
  if (v.deleted) await stashDeleted(s, v); delete v.key;
});
async function addRevision(user: string, v: Vault, objectId: string, parent: string | null, value: Note) {
  if (!v.key || v.deleted || v.transfer) throw Error('Хранилище недоступно для записи');
  const rid = id(), r: Revision = { id: rid, objectId, parent, sealed: await seal(v.key, context(user, v.header, objectId, rid), parent, value), pending: true };
  v.records.push(r); return r;
}
export const saveNote = (user: User, vid: string, objectId: string, parent: string | null, value: Note, draftKey?: CryptoKey) => edit(user, async s => {
  const v = vault(s, vid, false); if (v.deleted) {
    await addStash(s, vid, value); return { id: parent ?? objectId, stashed: true };
  }
  // An already-open editor may finish encrypting its draft after another tab closed the vault.
  // Never persist the temporary key again or put this draft into an independently accessible stash.
  const writable = v.key ? v : { ...v, key: draftKey };
  const r = await addRevision(user.id, writable, objectId, parent, value); return { id: r.id, stashed: false };
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
  await addRevision(user.id, vault(s, target), id(), null, await readStash(s, sid));
  s.stash = s.stash.filter(r => r.id !== sid);
});
export const discardStash = (user: User, sid: string) => edit(user, async s => { s.stash = s.stash.filter(r => r.id !== sid); });
export const transferVault = (user: User, source: string, name: string, phrase: string) => edit(user, async s => {
  const v = vault(s, source); if (v.deleted || v.transfer) throw Error('Перенос уже начат или хранилище удалено');
  const target = await makeVault(user.id, name, phrase);
  for (const r of heads(v)) await addRevision(user.id, target, id(), null, await readNote(user.id, v, r));
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
    } as Record<string, string>)[code] ?? 'Не удалось синхронизировать данные (' + code + '). Локальная копия сохранена.');
    this.code = code;
  }
}
async function vaultRequest(account: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { 'X-Tasks-Account': account };
  if (body !== undefined) {
    const r = await fetch('/api/auth/csrf', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new APIError('csrf'); const c = await r.json();
    headers['X-CSRF-Token'] = c.csrf; headers['Content-Type'] = 'application/json';
  }
  const r = await fetch('/api/vaults' + path, { method: body === undefined ? 'GET' : 'POST', headers, cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const value = await r.json(); if (!r.ok) throw new APIError(value.error ?? 'network'); return value;
}
// Persist after each successful merge/ack. A failed request never drops an outbox entry.
export async function synchronize(user: User) {
  const current = await session(); if (!current || current.id !== user.id) throw Error('Для синхронизации войдите в этот аккаунт. Локальные данные сохранены.');
  const api = (path: string, body?: unknown) => vaultRequest(user.id, path, body);
  async function fetchRecords(vid: string): Promise<Revision[]> {
    const records: Revision[] = []; let after = 0;
    do {
      const page = await api('/' + vid + '?after=' + after);
      if (!Array.isArray(page.records) || page.records.length > 5 || records.length + page.records.length > 10000) throw Error('Некорректный ответ сервера');
      records.push(...page.records);
      if (page.next === null) return records;
      if (!Number.isSafeInteger(page.next) || page.next <= after) throw Error('Некорректная страница данных');
      after = page.next;
    } while (true);
  }
  await exclusive(async () => {
    const s = await readState(user.id) ?? { user, vaults: [], stash: [] };
    const persist = async () => { await writeState(s); announce(); };
    const remote = await api('');
    for (const item of remote.vaults) {
      let v = s.vaults.find(v => v.header.id === item.id);
      if (item.deleted) {
        if (v) { v.deleted = true; await stashDeleted(s, v); await persist(); } continue;
      }
      if (!v) { v = { header: item.header, records: [] }; s.vaults.push(v); }
      if (JSON.stringify(v.header) !== JSON.stringify(item.header)) throw Error('Заголовок хранилища изменён. Синхронизация остановлена.');
    }
    await persist();
    for (const v of s.vaults.filter(v => !v.deleted)) {
      try {
        if (v.pending) {
          const source = s.vaults.find(x => x.transfer?.target === v.header.id);
          await api('/create', { ...v.header, ...(source ? { transferSource: source.header.id } : {}) }); v.pending = false; await persist();
        }
        const incoming = await fetchRecords(v.header.id);
        for (const r of incoming) {
          const local = v.records.find(x => x.id === r.id);
          if (!local) v.records.push(r);
          else {
            const { pending: _, ...wire } = local;
            if (JSON.stringify(wire) !== JSON.stringify(r)) throw Error('Версия заметки изменена на сервере');
            local.pending = false;
          }
        }
        await persist();
        // The accepted transfer snapshot includes local edits; do not require the full source outbox
        // to fit on the server before moving it (e.g. source reached its revision/size limit).
        for (const r of v.records.filter(r => r.pending && !v.transfer)) {
          const { pending: _, ...wire } = r;
          await api('/record', { vaultId: v.header.id, record: wire }); r.pending = false; await persist();
        }
      } catch (error) {
        if (error instanceof APIError && error.code === 'vault_deleted') { v.deleted = true; await stashDeleted(s, v); await persist(); }
        else throw error;
      }
    }
    for (const v of s.vaults.filter(v => v.transfer && !v.deleted)) {
      const transfer = v.transfer!;
      const target = s.vaults.find(x => x.header.id === transfer.target);
      const received = await fetchRecords(transfer.target);
      for (const rid of transfer.revisions) {
        const expected = target?.records.find(r => r.id === rid), actual = received.find(r => r.id === rid);
        if (!expected || !actual) throw Error('Перенос ещё не сохранён полностью');
        const { pending: _, ...wire } = expected;
        if (JSON.stringify(wire) !== JSON.stringify(actual)) throw Error('Проверка перенесённой заметки не прошла');
      }
      await api('/transfer', { source: v.header.id, target: transfer.target, revisions: transfer.revisions, confirmed: true });
      v.deleted = true; v.records = []; delete v.key; delete v.transfer; await persist();
    }
  });
}
export const hasUnsaved = (s: State) => s.stash.length > 0 || s.vaults.some(v => v.pending || v.transfer || v.records.some(r => r.pending));
let flushHandler: (() => Promise<void>) | undefined;
export function registerDraftFlush(fn?: () => Promise<void>) { flushHandler = fn; }
export async function flushDraft() { await flushHandler?.(); }
