import { h as e } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { User } from '../types/auth';
import { readState, changes, type State } from '../storage';
import { createVault, openVault, closeVault, saveNote, readNote, vaultName, heads, synchronize, transferVault,
  readStash, moveStash, discardStash, registerDraftFlush, edit, hasUnsaved, closeAllVault, resolveConflict, renameDevice, type Note } from '../planner';

interface Draft extends Note { vault: string; object: string; revision: string | null; dirty: boolean; key: CryptoKey }
export function Planner({ user }: { user: User }) {
  const [state, setState] = useState<State>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [stash, setStash] = useState<Record<string, Note>>({});
  const [selected, setSelected] = useState('');
  const selectionInitialized = useRef(false);
  function select(vid: string) {
    selectionInitialized.current = true;
    setSelected(vid);
    if (vid) void edit(user, async s => {
      if (s.vaults.some(v => v.header.id === vid && !v.deleted)) s.lastVaultId = vid;
    }).catch(() => setError('Не удалось запомнить выбранное хранилище'));
  }
  const [screen, setScreen] = useState<'list' | 'create' | 'open' | 'transfer' | 'stash' | 'close-all' | 'conflict' | 'device'>('list');
  const [password,setPassword]=useState('');
  const [comparison,setComparison]=useState<{objectId:string;versions:string[];chosen:string}>();
  const [name, setName] = useState(''); const [phrase, setPhrase] = useState(''); const [repeat, setRepeat] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [target, setTarget] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null); const draftRef = useRef<Draft | null>(null);
  const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(); const saving = useRef<Promise<void> | null>(null);
  const syncRunning = useRef(false), alive = useRef(true), generation = useRef(0);
  function showDraft(d: Draft | null) { draftRef.current = d; setDraft(d); }
  async function load() {
    const g = ++generation.current, s = await readState(user.id);
    if (!s) { if (alive.current && g === generation.current) { setState(undefined); setNames({}); setNotes({}); setStash({}); showDraft(null); } return; }
    const ns: Record<string, string> = {}, texts: Record<string, Note> = {}, st: Record<string, Note> = {};
    for (const v of s.vaults) {
      ns[v.header.id] = await vaultName(user.id, v);
      if (v.key) for (const r of heads(v)) texts[r.id] = await readNote(user.id, v, r);
    }
    for (const item of s.stash) st[item.id] = await readStash(s, item.id);
    if (!alive.current || g !== generation.current) return;
    if (!selectionInitialized.current) {
      selectionInitialized.current = true;
      if (s.vaults.some(v => v.header.id === s.lastVaultId && !v.deleted)) setSelected(s.lastVaultId!);
    }
    setState(s); setNames(ns); setNotes(texts); setStash(st);
    const d = draftRef.current;
    if (d && !s.vaults.some(v => v.header.id === d.vault && v.key && !v.deleted)) {
      if (d.dirty) await flush(); showDraft(null); setStatus('Хранилище закрыто или удалено. Черновик сохранён зашифрованным; стеш используется только при удалении источника.');
    }
  }
  async function flush() {
    if (timer.current) clearTimeout(timer.current);
    const task = (saving.current ?? Promise.resolve()).catch(() => {}).then(async () => {
      while (draftRef.current?.dirty) {
      const snapshot = { ...draftRef.current };
      const result = await saveNote(user, snapshot.vault, snapshot.object, snapshot.revision, { title: snapshot.title, text: snapshot.text }, snapshot.key);
      const latest = draftRef.current;
      if (latest && latest.object === snapshot.object) {
        const unchanged = latest.title === snapshot.title && latest.text === snapshot.text;
        showDraft({ ...latest, revision: result.id, dirty: !unchanged });
      }
      setStatus(result.stashed ? 'Хранилище недоступно. Заметка сохранена в стеше.' : 'Сохранено на устройстве · ожидает синхронизации');
      }
    });
    saving.current = task;
    try { await task; } finally { if (saving.current === task) saving.current = null; }
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось выполнить действие'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function sync() {
    if (syncRunning.current) return;
    syncRunning.current = true;
    try { await flush(); await synchronize(user); const s = await readState(user.id);
      setStatus(s && hasUnsaved(s) ? 'Сохранено на устройстве. Есть отложенные или неотправленные заметки.' : 'Синхронизация завершена'); await load(); }
    catch (caught) { if (alive.current) setStatus(caught instanceof Error && !(caught instanceof TypeError) && caught.name !== 'TimeoutError'
      ? caught.message : 'Нет синхронизации. Локальные изменения сохранены; повторим при подключении.'); }
    finally { syncRunning.current = false; }
  }
  useEffect(() => {
    alive.current = true;
    const changed = () => { void load().catch(() => { if (alive.current) setError('Не удалось прочитать данные. Возможно, запись повреждена.'); }); };
    const wake = () => { if (document.visibilityState === 'visible') void sync(); else void flush().catch(() => setError('Не удалось сохранить черновик')); };
    const leave = (event: BeforeUnloadEvent) => { if (draftRef.current?.dirty || saving.current) { event.preventDefault(); event.returnValue = ''; } };
    changed(); void edit(user,async()=>{}).then(()=>sync()).catch(error=>setError(error instanceof Error?error.message:'Не удалось открыть локальные данные')); registerDraftFlush(flush);
    changes?.addEventListener('message', changed); window.addEventListener('tasks-data', changed);
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake); window.addEventListener('beforeunload', leave);
    const interval = setInterval(() => { if (!draftRef.current?.dirty) void sync(); }, 30000);
    return () => { alive.current = false; generation.current++; registerDraftFlush(); if (timer.current) clearTimeout(timer.current);
      clearInterval(interval); changes?.removeEventListener('message', changed); window.removeEventListener('tasks-data', changed);
      window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); window.removeEventListener('beforeunload', leave); };
  }, [user.id]);
  const v = state?.vaults.find(v => v.header.id === selected);
  const active = state?.vaults.filter(v => !v.deleted) ?? [];
  const opened = active.filter(v => v.key && !v.transfer);
  function form(next: typeof screen, vid = '') { select(vid); setName(''); setPhrase(''); setRepeat(''); setPassword(''); setConfirmed(false); setError(''); setScreen(next); }
  async function submit(event: Event) {
    event.preventDefault(); await run(async () => {
      if (screen === 'open') await openVault(user, selected, phrase);
      else {
        if (phrase !== repeat) throw Error('Фраза и повтор не совпадают');
        if (screen === 'transfer' && !confirmed) throw Error('Подтвердите последствия переноса');
        select(screen === 'transfer' ? await transferVault(user, selected, name, phrase) : await createVault(user, name, phrase));
      }
      setPhrase(''); setRepeat(''); setScreen('list'); void sync();
    });
  }
  function change(field: 'title' | 'text', value: string) {
    const d = draftRef.current; if (!d) return;
    showDraft({ ...d, [field]: value, dirty: true }); setStatus('Сохраняем…');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => setError('Не удалось сохранить. Не закрывайте страницу; повторите сохранение.')); }, 350);
  }
  const feedback = e('div', { 'aria-live': 'polite' }, error && e('p', { class: 'error', role: 'alert' }, error),
    status && e('p', { class: 'hint' }, status));
  if(screen==='device')return e('section',{class:'card'},e('button',{onClick:()=>setScreen('list')},'Назад'),e('h2',null,'Название этого устройства'),
    e('form',{onSubmit:(ev:Event)=>{ev.preventDefault();void run(async()=>{await renameDevice(user,name);setScreen('list');});}},
      e('label',null,'Название',e('input',{value:name,maxLength:80,required:true,onInput:(ev:Event)=>setName((ev.target as HTMLInputElement).value)})),
      e('p',{class:'hint'},'Название и время изменения будут видны в новых версиях заметок после расшифровки.'),feedback,
      e('button',{class:'primary',disabled:busy},'Сохранить')));
  if(screen==='close-all')return e('section',{class:'card'},e('button',{disabled:busy,onClick:()=>{setPassword('');setScreen('list');}},'Назад'),
    e('h2',null,'Закрыть хранилище на всех устройствах'),e('p',null,'Будет закрыто только выбранное хранилище, включая это устройство. Сервер сразу остановит синхронизацию. Устройства без сети удалят сохранённый ключ при подключении. Заметки и очередь не удаляются.'),
    e('form',{onSubmit:(ev:Event)=>{ev.preventDefault();const secret=password;setPassword('');void run(async()=>{
      if(!confirmed)throw Error('Подтвердите закрытие');await closeAllVault(user,selected,secret);setScreen('list');setStatus('Хранилище закрыто на всех устройствах.');});}},
      e('label',null,'Пароль аккаунта',e('input',{type:'password',autoComplete:'current-password',value:password,required:true,onInput:(ev:Event)=>setPassword((ev.target as HTMLInputElement).value)})),
      e('label',{class:'check-row'},e('input',{type:'checkbox',checked:confirmed,required:true,onChange:(ev:Event)=>setConfirmed((ev.target as HTMLInputElement).checked)}),
        'Фраза хранилища мне известна. Если она забыта, после закрытия всех сохранённых ключей содержимое может стать недоступно.'),feedback,
      e('button',{class:'primary',disabled:busy},busy?'Закрываем…':'Закрыть на всех устройствах')));
  if(screen==='conflict'&&comparison&&v?.key){
    const alternatives=v.records.filter(r=>comparison.versions.includes(r.id));
    const finish=(keep:boolean)=>void run(async()=>{await resolveConflict(user,selected,comparison.objectId,comparison.versions,comparison.chosen,keep);setScreen('list');void sync();});
    return e('section',{class:'card'},e('button',{onClick:()=>setScreen('list')},'Назад'),e('h2',null,'Версии заметки'),
      e('p',null,'Заметку изменили независимо. Выберите актуальную версию или сохраните все как отдельные заметки. Исходные версии останутся в истории.'),
      e('div',{class:'conflict-grid'},alternatives.map(r=>e('article',{class:'note-row',key:r.id},
        e('label',{class:'check-row'},e('input',{type:'radio',name:'chosen-version',checked:comparison.chosen===r.id,onChange:()=>setComparison({...comparison,chosen:r.id})}),
          e('strong',null,notes[r.id]?.author?.name??'Источник неизвестен')),
        e('small',null,notes[r.id]?.author?new Date(notes[r.id].author!.time).toLocaleString():'Время неизвестно'),
        e('h3',null,notes[r.id]?.title||'Без заголовка'),e('p',{class:'note-preview'},notes[r.id]?.text)))),feedback,
      e('div',{class:'actions'},e('button',{class:'primary',disabled:busy,onClick:()=>finish(true)},alternatives.length===2?'Сохранить обе':'Сохранить все'),
        e('button',{disabled:busy,onClick:()=>finish(false)},'Выбрать версию')));
  }
  if (draft) return e('section', { class: 'card note-editor' },
    e('div', { class: 'actions' }, e('button', { disabled: busy, onClick: () => void run(async () => { await flush(); showDraft(null); void sync(); }) }, 'Назад'),
      e('button', { class: 'primary', disabled: busy, onClick: () => void run(async () => { await flush(); showDraft(null); void sync(); }) }, 'Готово')),
    e('label', null, 'Заголовок', e('input', { value: draft.title, maxLength: 500, onInput: (ev: Event) => change('title', (ev.target as HTMLInputElement).value) })),
    e('label', null, 'Текст заметки', e('textarea', { value: draft.text, rows: 16, onInput: (ev: Event) => change('text', (ev.target as HTMLTextAreaElement).value) })),
    feedback, error && e('button', { onClick: () => void run(flush) }, 'Повторить сохранение'));
  if (screen === 'create' || screen === 'open' || screen === 'transfer') return e('section', { class: 'card' },
    e('button', { disabled: busy, onClick: () => { setScreen('list'); setPhrase(''); setRepeat(''); } }, 'Назад'),
    e('h2', null, screen === 'open' ? 'Открыть хранилище' : screen === 'transfer' ? 'Перенести с новой фразой' : 'Новое хранилище'),
    e('p', { class: 'hint' }, 'Фраза не отправляется на сервер. Доступ сохранится на этом устройстве до «Закрыть хранилище». Без фразы и сохранённого доступа восстановить заметки невозможно.'),
    e('form', { onSubmit: submit }, screen !== 'open' && e('label', null, 'Название', e('input', { required: true, maxLength: 200, value: name, onInput: (ev: Event) => setName((ev.target as HTMLInputElement).value) })),
      e('label', null, 'Фраза хранилища', e('input', { type: 'password', autoComplete: screen === 'open' ? 'current-password' : 'new-password', required: true, value: phrase,
        onInput: (ev: Event) => setPhrase((ev.target as HTMLInputElement).value) })),
      screen !== 'open' && e('label', null, 'Повторите фразу (минимум 6 любых символов)', e('input', { type: 'password', autoComplete: 'new-password', required: true, value: repeat,
        onInput: (ev: Event) => setRepeat((ev.target as HTMLInputElement).value) })),
      screen === 'transfer' && e('label', { class: 'check-row' }, e('input', { type: 'checkbox', checked: confirmed, required: true, onChange: (ev: Event) => setConfirmed((ev.target as HTMLInputElement).checked) }),
        'Согласен удалить старое хранилище на сервере после переноса. Наработки других устройств могут не попасть в новое хранилище.'),
      feedback, e('button', { class: 'primary', disabled: busy, type: 'submit' }, busy ? 'Подождите…' : screen === 'open' ? 'Открыть' : screen === 'transfer' ? 'Перенести и удалить старое' : 'Создать')));
  if (screen === 'stash') return e('section', { class: 'card' }, e('button', { onClick: () => setScreen('list') }, 'Назад'),
    e('h2', null, 'Отложенные заметки'), e('p', null, 'Эти заметки не попали в конечное хранилище: источник был удалён. Они сохранены только на этом устройстве.'),
    e('label', null, 'Перенести в открытое хранилище', e('select', { value: target, onChange: (ev: Event) => setTarget((ev.target as HTMLSelectElement).value) },
      e('option', { value: '' }, 'Выберите хранилище'), opened.map(v => e('option', { value: v.header.id }, names[v.header.id])))),
    !opened.length && e('p', { class: 'hint' }, 'Вернитесь назад и создайте или откройте хранилище. Заметки останутся здесь.'),
    state?.stash.map(item => e('article', { class: 'note-row', key: item.id }, e('h3', null, stash[item.id]?.title || 'Без заголовка'),
      e('p', { class: 'note-preview' }, stash[item.id]?.text), e('div', { class: 'actions' },
        e('button', { disabled: busy || !opened.some(v => v.header.id === target), onClick: () => void run(async () => { await moveStash(user, item.id, target); void sync(); }) }, 'Перенести'),
        e('button', { disabled: busy, onClick: () => { if (confirm('Удалить эту отложенную заметку с устройства? Восстановить её будет невозможно.')) void run(() => discardStash(user, item.id)); } }, 'Удалить с устройства')))),
    !state?.stash.length && e('p', null, 'Отложенных заметок нет'), feedback,
    e('button', { onClick: () => setScreen('list') }, 'Оставить на потом'));
  return e('section', { class: 'card planner' },
    e('div', { class: 'card-heading' }, e('h1', null, 'Заметки'), e('button', { disabled: busy, onClick: () => void run(sync) }, 'Синхронизировать')),
    e('label', null, 'Хранилище', e('select', { value: selected, onChange: (ev: Event) => select((ev.target as HTMLSelectElement).value) },
      e('option', { value: '' }, 'Выберите хранилище'), active.map(v => e('option', { value: v.header.id, key: v.header.id }, names[v.header.id] || 'Хранилище')))),
    e('div', { class: 'actions' }, e('button', { disabled: busy, onClick: () => form('create') }, '+ Хранилище'),
      e('button', { onClick: () => setScreen('stash') }, 'Отложенные заметки (' + (state?.stash.length ?? 0) + ')'),
      e('button',{onClick:()=>{setName(state?.deviceName??'Устройство');setScreen('device');}},'Это устройство: '+(state?.deviceName??'Устройство'))),
    v&&!v.deleted&&e('div',null,
      e('button',{disabled:busy||Boolean(v.transfer)||!v.access,onClick:()=>form('close-all',selected)},'Закрыть на всех устройствах'),
      v.syncError&&e('p',{class:'error',role:'status'},v.syncError)),
    state?.stash.length ? e('p', { class: 'auth-notice', role: 'status' }, 'Есть заметки, не попавшие в конечное хранилище. Откройте «Отложенные заметки».') : null,
    state?.vaults.filter(v => v.deleted && v.records.some(r => r.pending)).map(v => e('div', { class: 'auth-notice' },
      e('p', null, 'Удалённое хранилище содержит локальные изменения. Чтобы перенести их в стеш, откройте его прежней фразой.'),
      e('button', { onClick: () => form('open', v.header.id) }, 'Открыть для сохранения заметок'),
      e('button', { onClick: () => { if (confirm('Удалить локальные изменения удалённого хранилища без возможности восстановления?')) void run(async () => {
        await edit(user, async s => { s.vaults = s.vaults.filter(x => x.header.id !== v.header.id); });
      }); } }, 'Удалить локальную копию'))),
    !active.length && e('div', { class: 'empty-state' }, e('h2', null, 'Пока нет хранилищ'), e('p', null, 'Создайте первое хранилище и задайте его фразу.')),
    v && !v.deleted && (!v.key ? e('button', { class: 'primary', onClick: () => form('open', selected) }, 'Открыть хранилище') : e('div', null,
      e('div', { class: 'actions' }, e('button', { disabled: busy || Boolean(v.transfer), onClick: () => void run(() => closeVault(user, selected)) }, 'Закрыть хранилище'),
        e('button', { disabled: busy || Boolean(v.transfer), onClick: () => form('transfer', selected) }, 'Забыл фразу · перенести')),
      v.transfer && e('p', { class: 'auth-notice' }, 'Перенос подготовлен. Подключитесь к сети и завершите синхронизацию. Исходник сохранён до подтверждения.'),
      !heads(v).length && e('div', { class: 'empty-state' }, e('h2', null, 'Пока нет заметок'), e('p', null, 'Создайте первую заметку')),
      [...new Set(heads(v).map(r=>r.objectId))].filter(objectId=>heads(v).filter(r=>r.objectId===objectId).length>1).map(objectId=>
        e('button',{disabled:busy||Boolean(v.transfer),onClick:()=>{const versions=heads(v).filter(r=>r.objectId===objectId).map(r=>r.id);
          setComparison({objectId,versions,chosen:versions[0]});setScreen('conflict');}},'Сравнить версии: '+(notes[heads(v).find(r=>r.objectId===objectId)!.id]?.title||'Без заголовка'))),
      heads(v).map(r => e('button', { class: 'note-row', disabled: Boolean(v.transfer), key: r.id, onClick: () => {
        const text = notes[r.id]; if (text && v.key) showDraft({ ...text, vault: selected, object: r.objectId, revision: r.id, dirty: false, key: v.key });
      } }, e('strong', null, notes[r.id]?.title || 'Без заголовка'), e('span', { class: 'note-preview' }, notes[r.id]?.text.slice(0, 140)),
        e('small', null, r.pending ? 'Сохранено на устройстве' : 'Синхронизировано'),
        heads(v).filter(x => x.objectId === r.objectId).length > 1 && e('small', null, 'Есть другая версия — обе сохранены'))),
      e('button', { class: 'primary', disabled: busy || Boolean(v.transfer), onClick: () => { if (v.key) showDraft({ vault: selected, object: crypto.randomUUID(), revision: null, title: '', text: '', dirty: false, key: v.key }); } }, '+ Новая заметка'))), feedback);
}
