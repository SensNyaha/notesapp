import { h as e } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { User } from '../types/auth';
import { readState, changes, type State, type Revision } from '../storage';
import { createVault, openVault, closeVault, saveNote, readNote, vaultName, heads, synchronize, transferVault,
  readStash, moveStash, discardStash, discardPurgedObjects, registerDraftFlush, edit, hasUnsaved, closeAllVault, resolveConflict, renameDevice,
  acknowledgeReminder, readTags, createTag, renameTag, deleteTag, copyNote, readVaultPushMode, setVaultPushMode,
  archiveNote,restoreArchivedNote,trashNote,restoreTrashedNote,permanentlyDeleteNote,noteHistory,restoreNoteVersion,noteLifecycle,
  outboxReviewItems,decideOutboxReview,OutboxReviewRequired,enableSystemUnlock,unlockVaultSystem,lockVault,forgetSystemUnlock,setSystemAutoLock,lockAfterBackground,deleteVault,vaultEntryMode,
  type Note, type TagDefinition, type VaultPushMode, type NoteLifecycleState, type OutboxReviewItem } from '../planner';
import { AUTO_LOCK_VALUES, type AutoLockMs } from '../crypto/system-unlock';
import { localTime } from '../../shared/reminders.mjs';
import type { ReminderPlan,ReminderRepeat,ReminderEnd } from '../../shared/reminders.mjs';
import { reminderRequest, type ReminderSettings, type ReminderStatus, type ReminderTarget } from '../reminders';
import { Attachments, RichTextEditor, sanitizeNoteHtml } from './RichTextEditor';
import { noteSearchScore } from '../search';
import { AuthError } from '../auth';
import { createNoteZip, downloadBytes, noteZipFileName } from '../portable';

interface Draft extends Note { vault: string; object: string; revision: string | null; dirty: boolean; key: CryptoKey }
interface OpenedNote extends Note { vault: string; object: string; revision: string; key: CryptoKey }
interface HistoryState {vault:string;objectId:string;back:'list'|'archive'|'trash';selected:string;entries:{revision:Revision;note:Note}[]}
export function Planner({ user,reminderTarget,onReminderHandled,onSyncState }: { user: User;reminderTarget?:ReminderTarget;onReminderHandled:()=>void;
  onSyncState:(state:'syncing'|'online'|'offline'|'auth'|'error'|'idle')=>void }) {
  const [state, setState] = useState<State>();
  const stateRef = useRef<State>(); stateRef.current = state;
  const hiddenAt = useRef<number | null>(null);
  const backgroundLockTimer = useRef<ReturnType<typeof setTimeout>>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [tags,setTags]=useState<Record<string,TagDefinition[]>>({});
  const [pushDefaults,setPushDefaults]=useState<Record<string,VaultPushMode>>({});
  const [stash, setStash] = useState<Record<string, Note>>({});
  const [reviewItems,setReviewItems]=useState<OutboxReviewItem[]>([]);
  const [selected, setSelected] = useState('');
  const selectedRef=useRef('');selectedRef.current=selected;
  const selectionInitialized = useRef(false);
  const startupUnlockHandled=useRef(false);
  const unlockAttempt=useRef(0);
  function select(vid: string) {
    selectionInitialized.current = true;
    setSelected(vid);
    setSelectedTags([]);setQuickFilter('all');
    if (vid) void edit(user, async s => {
      if (s.vaults.some(v => v.header.id === vid && !v.deleted)) s.lastVaultId = vid;
    }).catch(() => setError('Не удалось запомнить выбранное хранилище'));
  }
  const [screen, setScreen] = useState<'list' | 'create' | 'open' | 'transfer' | 'stash' | 'close-all' | 'system-unlock' | 'conflict' | 'device'|'reminder'|'schedule'|'tags'|'archive'|'trash'|'history'|'outbox-review'>('list');
  const [password,setPassword]=useState('');
  const [autoLockMs,setAutoLockMs]=useState<AutoLockMs>(900_000);
  const [comparison,setComparison]=useState<{objectId:string;versions:string[];chosen:string}>();
  const [name, setName] = useState(''); const [phrase, setPhrase] = useState(''); const [repeat, setRepeat] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [target, setTarget] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null); const draftRef = useRef<Draft | null>(null);
  const [viewing,setViewing]=useState<OpenedNote|null>(null);const viewingRef=useRef<OpenedNote|null>(null);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  const localDateAfter=(days:number)=>new Date(Date.parse(localTime(Date.now(),zone).slice(0,10)+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
  const [reminderDate,setReminderDate]=useState(''),[reminderClock,setReminderClock]=useState('');
  const [reminderMode,setReminderMode]=useState<'neutral'|'custom'|'title'>('neutral'),[reminderText,setReminderText]=useState('');
  const [reminderConsent,setReminderConsent]=useState(false);
  const [serverReminders,setServerReminders]=useState<ReminderStatus[]>([]);
  const [reminderSettings,setReminderSettings]=useState<ReminderSettings>({zone, nudge_hours:1,all_day_time:'09:00'});
  const [reminderAllDay,setReminderAllDay]=useState(false),[reminderImportant,setReminderImportant]=useState(false);
  const [reminderRepeat,setReminderRepeat]=useState<ReminderRepeat>({type:'once'}),[reminderEnd,setReminderEnd]=useState<ReminderEnd>({type:'never'});
  const [selectedOccurrence,setSelectedOccurrence]=useState(''),[snoozeOpen,setSnoozeOpen]=useState(false),[snoozeLocal,setSnoozeLocal]=useState('');
  const [todayMenuOpen,setTodayMenuOpen]=useState(false),[todayPickOpen,setTodayPickOpen]=useState(false),[showReminderHistory,setShowReminderHistory]=useState(false);
  const [query,setQuery]=useState(''),[selectedTags,setSelectedTags]=useState<string[]>([]);
  const [quickFilter,setQuickFilter]=useState<'all'|'pinned'|'untagged'|'reminder'>('all'),[sort,setSort]=useState<'newest'|'oldest'|'title'>('newest');
  const [searchSort,setSearchSort]=useState<'relevance'|'newest'|'oldest'>('relevance');
  const [hideCompleted,setHideCompleted]=useState(false),[menuOpen,setMenuOpen]=useState(false);
  const [history,setHistory]=useState<HistoryState|null>(null);
  const [tagName,setTagName]=useState(''),[tagColor,setTagColor]=useState('#356AE6'),[editingTag,setEditingTag]=useState('');
  const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [syncStatus,setSyncStatus]=useState<'local'|'syncing'|'synced'|'offline'|'error'>('local');
  const timer = useRef<ReturnType<typeof setTimeout>>(); const saving = useRef<Promise<void> | null>(null);
  const syncTimer=useRef<ReturnType<typeof setTimeout>>(),syncAgain=useRef(false);
  const draggedChecklistItem=useRef<number|null>(null);
  const syncRunning = useRef(false), alive = useRef(true), generation = useRef(0);
  const acknowledgedTarget=useRef('');
  function showDraft(d: Draft | null) { draftRef.current = d; setDraft(d); }
  function showViewing(note:OpenedNote|null){viewingRef.current=note;setViewing(note);}
  async function load() {
    const g = ++generation.current, s = await readState(user.id);
    if (!s) { if (alive.current && g === generation.current) { setState(undefined); setNames({}); setNotes({});setTags({}); setStash({});setReviewItems([]); showDraft(null); } return; }
    const ns: Record<string, string> = {}, texts: Record<string, Note> = {}, catalogs:Record<string,TagDefinition[]>={},defaults:Record<string,VaultPushMode>={},st: Record<string, Note> = {};
    for (const v of s.vaults) {
      ns[v.header.id] = await vaultName(user.id, v);
      if (v.key){catalogs[v.header.id]=await readTags(user.id,v);defaults[v.header.id]=await readVaultPushMode(user.id,v);for (const r of heads(v)) texts[r.id] = await readNote(user.id, v, r);}
    }
    for (const item of s.stash) st[item.id] = await readStash(s, item.id);
    const reviews=s.sessionReviewRequired?await outboxReviewItems(user):[];
    if (!alive.current || g !== generation.current) return;
    if (!selectionInitialized.current) {
      selectionInitialized.current = true;
      if (s.vaults.some(v => v.header.id === s.lastVaultId && !v.deleted)) setSelected(s.lastVaultId!);
    }
    setState(s); setNames(ns); setNotes(texts);setTags(catalogs);setPushDefaults(defaults); setStash(st);setReviewItems(reviews);
    const d = draftRef.current;
    if (d && !s.vaults.some(v => v.header.id === d.vault && v.key && !v.deleted)) {
      if (d.dirty) await flush(); showDraft(null); setStatus('Хранилище закрыто или удалено. Черновик сохранён зашифрованным; стеш используется только при удалении источника.');
    }
    const opened=viewingRef.current;
    if(opened){
      const current=s.vaults.find(v=>v.header.id===opened.vault&&v.key&&!v.deleted);
      if(!current)showViewing(null);
      else if(!draftRef.current){
        const versions=heads(current).filter(r=>r.objectId===opened.object);
        if(versions.length===1&&versions[0].id!==opened.revision&&texts[versions[0].id])
          showViewing({...texts[versions[0].id],vault:opened.vault,object:opened.object,revision:versions[0].id,key:current.key!});
        else if(versions.length>1)setStatus('Заметка изменена на нескольких устройствах. Откройте конфликт версий из списка.');
        else if(!versions.length)showViewing(null);
      }
    }
  }
  async function flush() {
    if (timer.current) clearTimeout(timer.current);
    const task = (saving.current ?? Promise.resolve()).catch(() => {}).then(async () => {
      while (draftRef.current?.dirty) {
      const snapshot = { ...draftRef.current };
      const result = await saveNote(user, snapshot.vault, snapshot.object, snapshot.revision,
        { title: snapshot.title, text: snapshot.text,...(snapshot.html!==undefined?{html:snapshot.html}:{}),
          ...(snapshot.attachments?.length?{attachments:snapshot.attachments}:{}),...(snapshot.checklist?.length?{checklist:snapshot.checklist}:{}),
          ...(snapshot.tagIds?.length?{tagIds:snapshot.tagIds}:{}),...(snapshot.pinned?{pinned:true}:{}),...(snapshot.reminder?{reminder:snapshot.reminder}:{}),
          ...(snapshot.lifecycle?{lifecycle:snapshot.lifecycle}:{}) }, snapshot.key);
      const latest = draftRef.current;
      if (latest && latest.object === snapshot.object) {
        const comparable=(value:Note)=>JSON.stringify({title:value.title,text:value.text,html:value.html,attachments:value.attachments??[],checklist:value.checklist??[],tagIds:value.tagIds??[],pinned:Boolean(value.pinned),reminder:value.reminder,lifecycle:value.lifecycle});
        const unchanged = comparable(latest)===comparable(snapshot);
        showDraft({ ...latest, revision: result.id, dirty: !unchanged });
      }
      setStatus(result.stashed ? 'Хранилище недоступно. Заметка сохранена в стеше.' : 'Сохранено на устройстве · ожидает синхронизации');
      setSyncStatus('local');
      if(syncTimer.current)clearTimeout(syncTimer.current);
      syncTimer.current=setTimeout(()=>{if(syncRunning.current)syncAgain.current=true;else void sync();},1500);
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
  function unlockError(caught:unknown){
    return caught instanceof DOMException&&caught.name==='NotAllowedError'
      ?'Системная разблокировка отменена. Можно повторить её, ввести фразу или отложить открытие хранилища.'
      :caught instanceof Error?caught.message:'Не удалось разблокировать хранилище';
  }
  async function activateVault(vid:string){
    select(vid);showDraft(null);showViewing(null);
    if(!vid){setScreen('list');return;}
    const local=await readState(user.id),current=local?.vaults.find(item=>item.header.id===vid&&!item.deleted);
    if(!current){setSelected('');setScreen('list');setError('Хранилище больше не доступно.');return;}
    const mode=vaultEntryMode(current);
    if(mode==='open'){setScreen('list');setError('');return;}
    setPhrase('');setRepeat('');setPassword('');setConfirmed(false);setError('');setScreen('open');
    if(mode==='phrase')return;
    const attempt=++unlockAttempt.current;setBusy(true);
    try{
      await unlockVaultSystem(user,vid);
      if(attempt!==unlockAttempt.current||!alive.current)return;
      setStatus('Хранилище разблокировано системной проверкой.');setScreen('list');await load();void sync();
    }catch(caught){if(attempt===unlockAttempt.current&&alive.current)setError(unlockError(caught));}
    finally{if(attempt===unlockAttempt.current&&alive.current)setBusy(false);}
  }
  function postponeUnlock(){unlockAttempt.current++;setPhrase('');setError('');setScreen('list');select('');}
  async function sync() {
    if (syncRunning.current) { syncAgain.current=true; return; }
    syncRunning.current = true;
    setSyncStatus('syncing');onSyncState('syncing');
    try { await flush(); await synchronize(user);void reminderRequest(user,'').then(remote=>{setServerReminders(remote.items);setReminderSettings(remote.settings);}).catch(()=>{}); const s = await readState(user.id);
      if(alive.current){const pending=Boolean(draftRef.current?.dirty||saving.current||s&&hasUnsaved(s));setSyncStatus(pending?'local':'synced');onSyncState('online');
        setStatus(pending ? 'Сохранено на устройстве. Есть отложенные или неотправленные заметки.' : 'Синхронизировано'); await load();} }
    catch (caught) { if (alive.current) {
      if(caught instanceof OutboxReviewRequired){setSyncStatus('local');onSyncState('online');setStatus('Перед синхронизацией проверьте локальные изменения после завершения предыдущей сессии.');await load();return;}
      const network=caught instanceof TypeError||caught instanceof AuthError&&caught.code==='network'||caught instanceof Error&&caught.name==='TimeoutError'
        ||Boolean(caught&&typeof caught==='object'&&'code'in caught&&caught.code==='network');
      const auth=caught instanceof AuthError&&caught.code==='unauthorized'||caught instanceof Error&&caught.message.startsWith('Для синхронизации войдите');
      setSyncStatus(network?'offline':'error');onSyncState(network?'offline':auth?'auth':'error');
      setStatus(network?'Нет синхронизации. Локальные изменения сохранены; повторим при подключении.':caught instanceof Error?caught.message:'Ошибка синхронизации. Локальные данные сохранены.');
    } }
    finally { syncRunning.current = false;if(syncAgain.current&&alive.current){syncAgain.current=false;syncTimer.current=setTimeout(()=>void sync(),1000);} }
  }
  useEffect(() => {
    alive.current = true;
    const changed = () => { void load().catch(() => { if (alive.current) setError('Не удалось прочитать данные. Возможно, запись повреждена.'); }); };
    const wake = () => {
      if (document.visibilityState !== 'visible') {
        hiddenAt.current = Date.now();
        void flush().catch(() => setError('Не удалось сохранить черновик'));
        if(backgroundLockTimer.current)clearTimeout(backgroundLockTimer.current);
        const limits=(stateRef.current?.vaults??[]).filter(v=>v.key&&v.systemUnlock&&v.systemUnlock.autoLockMs>0).map(v=>v.systemUnlock!.autoLockMs);
        if(limits.length){const delay=Math.min(...limits);backgroundLockTimer.current=setTimeout(()=>{
          const started=hiddenAt.current;if(started===null)return;const away=Math.max(0,Date.now()-started);
          void lockAfterBackground(user,away).then(locked=>{if(locked){showDraft(null);showViewing(null);setNotes({});setTags({});setPushDefaults({});return load();}})
            .catch(error=>setError(error instanceof Error?error.message:'Не удалось заблокировать хранилище'));
        },delay);}
        return;
      }
      if(backgroundLockTimer.current){clearTimeout(backgroundLockTimer.current);backgroundLockTimer.current=undefined;}
      const started = hiddenAt.current; hiddenAt.current = null;
      if (started !== null) {
        const away = Math.max(0, Date.now() - started);
        void (async()=>{
          const locked=await lockAfterBackground(user,away);
          if(locked){showDraft(null);showViewing(null);setNotes({});setTags({});setPushDefaults({});}
          await load();
          const local=await readState(user.id),vid=selectedRef.current,current=local?.vaults.find(item=>item.header.id===vid&&!item.deleted);
          if(current?.systemUnlock&&!current.key&&current.systemUnlock.autoLockMs>0&&away>=current.systemUnlock.autoLockMs){await activateVault(vid);return;}
          await sync();
        })().catch(error=>setError(error instanceof Error?error.message:'Не удалось восстановить приложение после блокировки'));
        return;
      }
      void sync();
    };
    const leave = (event: BeforeUnloadEvent) => { if (draftRef.current?.dirty || saving.current) { event.preventDefault(); event.returnValue = ''; } };
    changed(); void edit(user,async s=>{s.lastOpenedAt=Date.now();}).then(()=>sync()).catch(error=>setError(error instanceof Error?error.message:'Не удалось открыть локальные данные')); registerDraftFlush(flush);
    changes?.addEventListener('message', changed); window.addEventListener('tasks-data', changed);
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake); window.addEventListener('beforeunload', leave);
    const interval = setInterval(() => { void sync(); }, 30000);
    return () => { alive.current = false; generation.current++; registerDraftFlush(); if (timer.current) clearTimeout(timer.current);if(syncTimer.current)clearTimeout(syncTimer.current);if(backgroundLockTimer.current)clearTimeout(backgroundLockTimer.current);onSyncState('idle');
      clearInterval(interval); changes?.removeEventListener('message', changed); window.removeEventListener('tasks-data', changed);
      window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); window.removeEventListener('beforeunload', leave); };
  }, [user.id]);
  useEffect(()=>{
    if(!state||startupUnlockHandled.current)return;
    startupUnlockHandled.current=true;
    const last=state.vaults.find(item=>item.header.id===state.lastVaultId&&!item.deleted);
    if(last)void activateVault(last.header.id);
  },[state?.lastVaultId]);
  useEffect(()=>{
    if(!reminderTarget||reminderTarget.accountId!==user.id||!state)return;
    const targetKey=reminderTarget.configId+'.'+(reminderTarget.occurrenceId??'');if(acknowledgedTarget.current!==targetKey){acknowledgedTarget.current=targetKey;void acknowledgeReminder(user,reminderTarget);}
    const targetVault=state.vaults.find(v=>v.header.id===reminderTarget.vaultId);
    if(!targetVault){setStatus('Заметка из уведомления ещё не загружена. Выполняется синхронизация.');void sync();return;}
    if(targetVault.deleted){setError('Хранилище из уведомления удалено.');onReminderHandled();return;}
    if(selected!==reminderTarget.vaultId){void activateVault(reminderTarget.vaultId);return;}
    if(!targetVault.key){if(screen!=='open'&&!busy)void activateVault(reminderTarget.vaultId);return;}
    const versions=heads(targetVault).filter(r=>r.objectId===reminderTarget.objectId);
    if(versions.length>1){setComparison({objectId:reminderTarget.objectId,versions:versions.map(r=>r.id),chosen:versions[0].id});setScreen('conflict');onReminderHandled();return;}
    const revision=versions[0],value=revision&&notes[revision.id];
    if(value){showDraft(null);showViewing({...value,vault:targetVault.header.id,object:revision.objectId,revision:revision.id,key:targetVault.key});setScreen('list');onReminderHandled();}
    else{setStatus('Заметка из уведомления загружается.');void sync();}
  },[reminderTarget?.configId,reminderTarget?.occurrenceId,state,notes,selected,screen]);
  const v = state?.vaults.find(v => v.header.id === selected);
  const active = state?.vaults.filter(v => !v.deleted) ?? [];
  const autoLockLabel=(value:number)=>value===0?'Никогда':value===60_000?'Через 1 минуту':value===300_000?'Через 5 минут':value===900_000?'Через 15 минут':value===1_800_000?'Через 30 минут':'Через 1 час';
  const opened = active.filter(v => v.key && !v.transfer);
  function form(next: typeof screen, vid = '') { showViewing(null);select(vid); setName(''); setPhrase(''); setRepeat(''); setPassword(''); setConfirmed(false); setError(''); setScreen(next); }
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
    const reminder=field==='title'&&d.reminder?.mode==='title'
      ?{...d.reminder,text:Array.from(value).slice(0,200).join('')}:d.reminder;
    showDraft({ ...d, [field]: value,...(reminder?{reminder}:{}),dirty: true }); setStatus('Сохраняем…');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => setError('Не удалось сохранить. Не закрывайте страницу; повторите сохранение.')); }, 350);
  }
  function changeContent(patch:Partial<Pick<Note,'text'|'html'|'attachments'|'checklist'|'tagIds'|'pinned'>>){
    const d=draftRef.current;if(!d)return;const next={...d,...patch,dirty:true};
    if(new TextEncoder().encode(JSON.stringify({title:next.title,text:next.text,html:next.html,attachments:next.attachments,checklist:next.checklist,tagIds:next.tagIds,pinned:next.pinned,reminder:next.reminder})).length>900*1024){
      setError('Заметка достигла локального лимита 900 КБ. Удалите часть текста или вложений.');return;
    }
    showDraft(next);setError('');setStatus('Сохраняем…');if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(()=>{void flush().catch(()=>setError('Не удалось сохранить. Не закрывайте страницу; повторите сохранение.'));},350);
  }
  function changeReminder(plan:ReminderPlan|undefined){
    const d=draftRef.current;if(!d)return;
    showDraft({...d,...(plan?{reminder:plan}:{reminder:undefined}),dirty:true});setStatus('Сохраняем…');
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(()=>{void flush().catch(()=>setError('Не удалось сохранить напоминание.'));},350);
  }
  function prepareReminderForm(d:Draft){
    const local=d.reminder?.local??localTime(Date.now()+3600000,zone),mode=d.reminder?.mode??pushDefaults[d.vault]??'neutral';
    setReminderDate(local.slice(0,10));setReminderClock(local.slice(11,16));setReminderMode(mode);setReminderText(d.reminder?.text??'');
    setReminderAllDay(Boolean(d.reminder?.allDay));setReminderImportant(Boolean(d.reminder?.important));setReminderRepeat(d.reminder?.repeat??{type:'once'});setReminderEnd(d.reminder?.end??{type:'never'});
    setReminderConsent(mode==='title'&&(d.reminder?.mode==='title'||pushDefaults[d.vault]==='title'));setError('');setScreen('reminder');
  }
  function openReminderForm(){const d=draftRef.current;if(d)prepareReminderForm(d);}
  function editReminderFor(current:NonNullable<State['vaults'][number]>,revision:ReturnType<typeof heads>[number]){
    const value=notes[revision.id];if(!value||!current.key)return;const d={...value,vault:current.header.id,object:revision.objectId,revision:revision.id,dirty:false,key:current.key};showViewing(null);showDraft(d);prepareReminderForm(d);
  }
  function openRevision(current:NonNullable<State['vaults'][number]>,revision:ReturnType<typeof heads>[number]){
    const value=notes[revision.id];if(!value||!current.key)return;
    showDraft(null);showViewing({...value,vault:current.header.id,object:revision.objectId,revision:revision.id,key:current.key});
    if(value.reminder)void acknowledgeReminder(user,{vaultId:current.header.id,objectId:revision.objectId,configId:value.reminder.id});
  }
  function editRevision(current:NonNullable<State['vaults'][number]>,revision:ReturnType<typeof heads>[number]){
    openRevision(current,revision);const value=notes[revision.id];if(!value||!current.key)return;
    showDraft({...value,vault:current.header.id,object:revision.objectId,revision:revision.id,dirty:false,key:current.key});
  }
  function activeTags(vid:string){return (tags[vid]??[]).filter(tag=>!tag.deleted);}
  function tagChips(vid:string,ids:string[]|undefined){const byId=new Map(activeTags(vid).map(tag=>[tag.id,tag]));return (ids??[]).map(tagId=>byId.get(tagId)).filter((tag):tag is TagDefinition=>Boolean(tag));}
  async function duplicate(current:NonNullable<State['vaults'][number]>,revision:string){
    await flush();await copyNote(user,current.header.id,revision);showViewing(null);setMenuOpen(false);setStatus('Копия создана и сохранена на устройстве.');void sync();
  }
  function exportViewingZip(){
    if(!viewing)return;
    const {vault:_,object:__,revision:___,key:____,...note}=viewing;
    const source=note.importSource??{kind:'tasks-note-v1' as const,vaultId:viewing.vault,objectId:viewing.object};
    const used=new Set(note.tagIds??[]),exportTags=(tags[viewing.vault]??[]).filter(tag=>used.has(tag.id)).map(tag=>({...tag}));
    const bytes=createNoteZip({note,tags:exportTags,source});
    downloadBytes(bytes,noteZipFileName(note.title||'note'),'application/zip');setMenuOpen(false);
    setStatus('ZIP заметки создан. Внутри находятся note.md, manifest.json и вложения.');
  }
  function statusOf(current:NonNullable<State['vaults'][number]>,revision:Revision,value:Note):NoteLifecycleState{return noteLifecycle(current,revision,value);}
  async function openHistory(current:NonNullable<State['vaults'][number]>,objectId:string,back:'list'|'archive'|'trash'){
    const entries=(await noteHistory(user.id,current,objectId)).sort((a,b)=>(b.note.author?.time??0)-(a.note.author?.time??0));
    const currentRevision=heads(current).find(item=>item.objectId===objectId)?.id??entries[0]?.revision.id??'';
    showViewing(null);setMenuOpen(false);setHistory({vault:current.header.id,objectId,back,selected:currentRevision,entries});setScreen('history');
  }
  async function archiveCurrent(current:NonNullable<State['vaults'][number]>,objectId:string){
    await archiveNote(user,current.header.id,objectId);showViewing(null);setMenuOpen(false);setStatus('Заметка перемещена в архив. Напоминание приостановлено.');void sync();
  }
  async function restoreArchive(current:NonNullable<State['vaults'][number]>,revision:Revision,value:Note){
    const resume=Boolean(value.reminder)&&confirm('У заметки сохранено напоминание. Возобновить его сейчас? Нажмите «Отмена», чтобы вернуть заметку с приостановленным напоминанием.');
    await restoreArchivedNote(user,current.header.id,revision.objectId,resume);showViewing(null);setMenuOpen(false);setStatus(resume?'Заметка восстановлена, напоминание возобновлено.':value.reminder?'Заметка восстановлена. Напоминание осталось приостановленным.':'Заметка восстановлена.');void sync();
  }
  async function trashCurrent(current:NonNullable<State['vaults'][number]>,objectId:string){
    await trashNote(user,current.header.id,objectId);showViewing(null);setMenuOpen(false);setStatus('Заметка перемещена в корзину на 30 дней.');void sync();
  }
  async function restoreTrash(current:NonNullable<State['vaults'][number]>,objectId:string){
    await restoreTrashedNote(user,current.header.id,objectId);showViewing(null);setMenuOpen(false);setStatus('Заметка восстановлена. Напоминание осталось приостановленным.');void sync();
  }
  async function purgeCurrent(current:NonNullable<State['vaults'][number]>,objectId:string){
    await permanentlyDeleteNote(user,current.header.id,objectId);showViewing(null);setMenuOpen(false);setStatus('Окончательное удаление поставлено в очередь синхронизации.');void sync();
  }
  async function updateViewing(patch:Partial<Note>){
    const current=viewingRef.current;if(!current)return;showDraft({...current,...patch,dirty:true});await flush();const saved=draftRef.current;
    if(saved?.revision)showViewing({...saved,revision:saved.revision});showDraft(null);void sync();
  }
  function checklistEditor(){
    if(!draft)return null;const items=draft.checklist??[];
    const replace=(next:NonNullable<Note['checklist']>)=>changeContent({checklist:next});
    const reorder=(index:number,target:number)=>{if(index===target||index<0||target<0||index>=items.length||target>=items.length)return;const next=[...items],[item]=next.splice(index,1);next.splice(target,0,item);replace(next);};
    const move=(index:number,delta:number)=>reorder(index,index+delta);
    return e('section',{class:'checklist-editor'},e('div',{class:'section-heading'},e('h2',null,'Чек-лист'),items.some(item=>item.done)&&e('button',{onClick:()=>setHideCompleted(!hideCompleted)},hideCompleted?'Показать выполненные':'Скрыть выполненные')),
      items.map((item,index)=>hideCompleted&&item.done?null:e('div',{class:'checklist-row',key:item.id,onDragOver:(ev:DragEvent)=>ev.preventDefault(),onDrop:(ev:DragEvent)=>{ev.preventDefault();if(draggedChecklistItem.current!==null)reorder(draggedChecklistItem.current,index);draggedChecklistItem.current=null;}},
        e('input',{type:'checkbox',checked:item.done,'aria-label':'Выполнено',onChange:(ev:Event)=>replace(items.map(current=>current.id===item.id?{...current,done:(ev.target as HTMLInputElement).checked}:current))}),
        e('button',{class:'drag-handle',draggable:true,'aria-label':'Перетащить пункт',onDragStart:(ev:DragEvent)=>{draggedChecklistItem.current=index;if(ev.dataTransfer)ev.dataTransfer.effectAllowed='move';},onDragEnd:()=>{draggedChecklistItem.current=null;}},'⋮⋮'),
        e('input',{value:item.text,maxLength:1000,placeholder:'Пункт списка',onInput:(ev:Event)=>replace(items.map(current=>current.id===item.id?{...current,text:(ev.target as HTMLInputElement).value}:current))}),
        e('button',{disabled:index===0,'aria-label':'Поднять пункт',onClick:()=>move(index,-1)},'↑'),e('button',{disabled:index===items.length-1,'aria-label':'Опустить пункт',onClick:()=>move(index,1)},'↓'),
        e('button',{class:'icon-danger','aria-label':'Удалить пункт',onClick:()=>replace(items.filter(current=>current.id!==item.id))},'×'))),
      e('button',{onClick:()=>replace([...items,{id:crypto.randomUUID(),text:'',done:false}])},'+ Добавить пункт'));
  }
  async function finishEditing(){
    await flush();const saved=draftRef.current;
    if(saved?.revision)showViewing({...saved,vault:saved.vault,object:saved.object,revision:saved.revision,key:saved.key});
    else showViewing(null);
    showDraft(null);void sync();
  }
  const feedback = e('div', { 'aria-live': 'polite' },e('p',{class:'sync-state '+syncStatus},
      syncStatus==='syncing'?'Синхронизация…':syncStatus==='synced'?'Синхронизировано':syncStatus==='offline'?'Нет подключения · сохранено на устройстве':syncStatus==='error'?'Ошибка синхронизации · локальная копия сохранена':'Сохранено на устройстве · ожидает синхронизации'),
    error && e('p', { class: 'error', role: 'alert' }, error),
    status && e('p', { class: 'hint' }, status));
  if(screen==='device')return e('section',{class:'card'},e('button',{onClick:()=>setScreen('list')},'Назад'),e('h2',null,'Название этого устройства'),
    e('form',{onSubmit:(ev:Event)=>{ev.preventDefault();void run(async()=>{await renameDevice(user,name);setScreen('list');});}},
      e('label',null,'Название',e('input',{value:name,maxLength:80,required:true,onInput:(ev:Event)=>setName((ev.target as HTMLInputElement).value)})),
      e('p',{class:'hint'},'Название и время изменения будут видны в новых версиях заметок после расшифровки.'),feedback,
      e('button',{class:'primary',disabled:busy},'Сохранить')));
  if(screen==='system-unlock'){
    const configured=Boolean(v?.systemUnlock);
    return e('section',{class:'card'},
      e('button',{disabled:busy,onClick:()=>{setPhrase('');setScreen('list');}},'Назад'),
      e('h2',null,'Системная разблокировка'),
      e('p',{class:'auth-notice'},'Фраза остаётся резервным способом. Tasks не получает Face ID, отпечаток пальца или системный код. Для криптографической разблокировки требуется WebAuthn PRF.'),
      e('form',{onSubmit:(ev:Event)=>{ev.preventDefault();const secret=phrase;setPhrase('');void run(async()=>{
        if(configured)await setSystemAutoLock(user,selected,autoLockMs);
        else await enableSystemUnlock(user,selected,secret,autoLockMs);
        setScreen('list');setStatus(configured?'Настройки автоблокировки сохранены.':'Системная разблокировка включена. Готовый ключ хранилища больше не сохраняется в IndexedDB.');});}},
        !configured&&e('label',null,'Фраза хранилища',e('input',{type:'password',autoComplete:'off',value:phrase,required:true,onInput:(ev:Event)=>setPhrase((ev.target as HTMLInputElement).value)})),
        e('label',null,'Автоблокировка после ухода из приложения',e('select',{value:String(autoLockMs),onChange:(ev:Event)=>setAutoLockMs(Number((ev.target as HTMLSelectElement).value) as AutoLockMs)},
          AUTO_LOCK_VALUES.map(value=>e('option',{value:String(value),key:value},autoLockLabel(value))))),
        e('p',{class:'hint'},'Пока PWA находится на экране, хранилище не блокируется по таймеру. «Никогда» отключает background-таймер. После закрытия, перезагрузки или перезапуска PWA защищённый root key отсутствует в runtime, поэтому потребуется системная проверка либо фраза.'),
        feedback,e('button',{class:'primary',disabled:busy},busy?'Сохраняем…':configured?'Сохранить настройку':'Включить системную разблокировку')));
  }
  if(screen==='outbox-review')return e('section',{class:'card planner'},e('button',{disabled:busy,onClick:()=>setScreen('list')},'Назад'),
    e('h1',null,'Проверка локальных изменений'),e('p',{class:'auth-notice'},'Предыдущая серверная сессия была завершена. Ничего из локальной очереди не будет отправлено, пока вы не решите судьбу каждой заметки.'),
    reviewItems.length?e('div',{class:'conflict-grid'},reviewItems.map(item=>{const blocked=item.serverState==='locked'||item.serverState==='conflict';
      const serverLabel=item.serverState==='present'?'Текущая версия на сервере':item.serverState==='missing'?'На сервере заметки нет':item.serverState==='deleted'?'Хранилище удалено на сервере':item.serverState==='conflict'?'На сервере несколько версий':'Хранилище нужно открыть для сравнения';
      return e('article',{class:'note-row',key:item.key},e('h2',null,item.local?.title||item.server?.title||'Без заголовка'),e('p',{class:'muted'},names[item.vaultId]||'Хранилище'),
        e('div',{class:'review-compare'},e('div',null,e('strong',null,serverLabel),item.server&&e('p',{class:'note-preview'},item.server.text||'Без текста')),
          e('div',null,e('strong',null,item.kind==='purge'?'Планируется окончательное удаление':'Локальная версия после применения'),item.local&&e('p',{class:'note-preview'},item.local.text||'Без текста'))),
        blocked&&e('p',{class:'error'},item.serverState==='locked'?'Сначала вернитесь к списку и откройте это хранилище прежней фразой.':'Сначала разрешите конфликт серверных версий.'),
        item.serverState==='deleted'&&e('p',{class:'hint'},'Если принять локальную версию, обычная логика восстановления сохранит её локально, а не перезапишет удалённое хранилище.'),
        e('div',{class:'actions'},e('button',{class:'primary',disabled:busy||blocked,onClick:()=>void run(async()=>{const done=await decideOutboxReview(user,item.key,true);if(done){setScreen('list');setStatus('Все локальные изменения проверены. Синхронизация продолжена.');queueMicrotask(()=>void sync());}})},item.kind==='purge'?'Подтвердить удаление':'Применить изменение'),
          e('button',{disabled:busy||blocked,onClick:()=>void run(async()=>{const done=await decideOutboxReview(user,item.key,false);if(done){setScreen('list');setStatus('Все локальные изменения проверены. Синхронизация продолжена.');queueMicrotask(()=>void sync());}})},'Отклонить локальное изменение')));})):e('p',null,'Изменений для проверки нет.'),feedback);
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
  if(screen==='reminder'&&draft){
    const quick=(hours:number)=>{const local=localTime(Date.now()+hours*3600000,zone);setReminderDate(local.slice(0,10));setReminderClock(local.slice(11));};
    const tomorrow=()=>{setReminderDate(localDateAfter(1));setReminderClock('09:00');};
    return e('section',{class:'card reminder-form'},e('button',{disabled:busy,onClick:()=>setScreen('list')},'Назад'),e('h1',null,'Напоминание'),
      e('p',{class:'hint'},'Одно расписание на заметку. Часовой пояс: '+zone+'. При открытии приложения онлайн будущие сроки сохраняют местные дату и время в новом поясе.'),
      e('div',{class:'actions compact'},e('button',{type:'button',onClick:()=>quick(1)},'Через час'),e('button',{type:'button',onClick:tomorrow},'Завтра, 09:00')),
      e('form',{onSubmit:(event:Event)=>{event.preventDefault();void run(async()=>{
        const local=reminderDate+'T'+(reminderAllDay?reminderSettings.all_day_time:reminderClock);
        if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local))throw Error('Укажите дату и время');
        if(reminderMode!=='neutral'&&!reminderConsent)throw Error('Подтвердите отправку текста через push-службу');
        const pushText=reminderMode==='title'?Array.from(draft.title).slice(0,200).join(''):reminderText;
        if(reminderMode==='custom'&&(!pushText.trim()||Array.from(pushText).length>200))throw Error('Собственный текст: от 1 до 200 символов');
        if(reminderEnd.type==='date'&&reminderEnd.date<reminderDate)throw Error('Дата окончания не может быть раньше первого срабатывания');
        const schedule={local,repeat:reminderRepeat,end:reminderEnd,allDay:reminderAllDay,important:reminderImportant};
        const old=draft.reminder,unchanged=old&&JSON.stringify({local:reminderAllDay?old.local.slice(0,10):old.local,repeat:old.repeat??{type:'once'},end:old.end??{type:'never'},allDay:Boolean(old.allDay),important:Boolean(old.important)})===JSON.stringify({...schedule,local:reminderAllDay?schedule.local.slice(0,10):schedule.local});
        changeReminder({id:unchanged?old!.id:crypto.randomUUID(),state:'active',...schedule,mode:reminderMode,text:reminderMode==='neutral'?'':pushText});
        setScreen('list');await flush();void sync();
      });}},
        e('div',{class:'reminder-fields'},e('label',null,'Дата первого срабатывания',e('input',{type:'date',required:true,value:reminderDate,onInput:(ev:Event)=>setReminderDate((ev.target as HTMLInputElement).value)})),
          e('label',null,'Время',e('input',{type:'time',required:!reminderAllDay,disabled:reminderAllDay,value:reminderAllDay?reminderSettings.all_day_time:reminderClock,onInput:(ev:Event)=>setReminderClock((ev.target as HTMLInputElement).value)}))),
        e('label',{class:'check-row'},e('input',{type:'checkbox',checked:reminderAllDay,onChange:(ev:Event)=>setReminderAllDay((ev.target as HTMLInputElement).checked)}),'Весь день · push в '+reminderSettings.all_day_time),
        e('fieldset',null,e('legend',null,'Повтор'),
          e('label',null,'Расписание',e('select',{value:reminderRepeat.type,onChange:(ev:Event)=>{const type=(ev.target as HTMLSelectElement).value;setReminderRepeat(type==='daily'?{type:'daily'}:type==='weekly'?{type:'weekly',days:[new Date((reminderDate||'2026-01-05')+'T00:00:00Z').getUTCDay()||7]}:type==='interval'?{type:'interval',days:2}:type==='monthly'?{type:'monthly',day:Number(reminderDate.slice(8,10))||1,shortMonth:'last'}:{type:'once'});}},
            e('option',{value:'once'},'Один раз'),e('option',{value:'daily'},'Каждый день'),e('option',{value:'weekly'},'По дням недели'),e('option',{value:'interval'},'Каждые N дней'),e('option',{value:'monthly'},'Каждый месяц'))),
          reminderRepeat.type==='weekly'&&e('div',{class:'weekday-picker'},['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((label,index)=>e('label',{class:'check-row',key:label},e('input',{type:'checkbox',checked:reminderRepeat.days.includes(index+1),onChange:(ev:Event)=>{const checked=(ev.target as HTMLInputElement).checked,days=checked?[...reminderRepeat.days,index+1]:reminderRepeat.days.filter(day=>day!==index+1);if(days.length)setReminderRepeat({type:'weekly',days:days.sort()});}}),label))),
          reminderRepeat.type==='interval'&&e('label',null,'Интервал, дней',e('input',{type:'number',min:2,max:365,value:reminderRepeat.days,onInput:(ev:Event)=>setReminderRepeat({type:'interval',days:Number((ev.target as HTMLInputElement).value)})})),
          reminderRepeat.type==='monthly'&&e('div',null,e('label',null,'День месяца',e('input',{type:'number',min:1,max:31,value:reminderRepeat.day,onInput:(ev:Event)=>setReminderRepeat({...reminderRepeat,day:Number((ev.target as HTMLInputElement).value)})})),
            e('label',null,'Если такого дня нет',e('select',{value:reminderRepeat.shortMonth,onChange:(ev:Event)=>setReminderRepeat({...reminderRepeat,shortMonth:(ev.target as HTMLSelectElement).value as 'last'|'skip'})},e('option',{value:'last'},'В последний день месяца'),e('option',{value:'skip'},'Пропустить месяц')))),
          reminderRepeat.type!=='once'&&e('div',null,e('label',null,'Окончание',e('select',{value:reminderEnd.type,onChange:(ev:Event)=>{const type=(ev.target as HTMLSelectElement).value;setReminderEnd(type==='date'?{type:'date',date:reminderDate}:type==='count'?{type:'count',count:10}:{type:'never'});}},e('option',{value:'never'},'Без окончания'),e('option',{value:'date'},'По дату включительно'),e('option',{value:'count'},'После количества срабатываний'))),
            reminderEnd.type==='date'&&e('label',null,'Последняя дата',e('input',{type:'date',required:true,value:reminderEnd.date,onInput:(ev:Event)=>setReminderEnd({type:'date',date:(ev.target as HTMLInputElement).value})})),
            reminderEnd.type==='count'&&e('label',null,'Количество, включая первое',e('input',{type:'number',min:1,max:10000,required:true,value:reminderEnd.count,onInput:(ev:Event)=>setReminderEnd({type:'count',count:Number((ev.target as HTMLInputElement).value)})})))),
        e('label',{class:'check-row important-control'},e('input',{type:'checkbox',checked:reminderImportant,onChange:(ev:Event)=>setReminderImportant((ev.target as HTMLInputElement).checked)}),'Важное напоминание (выделение в приложении и высокий приоритет Web Push)'),
        e('label',null,'Режим push по умолчанию для этого хранилища',e('select',{value:pushDefaults[draft.vault]??'neutral',disabled:busy,onChange:(ev:Event)=>{const mode=(ev.target as HTMLSelectElement).value as VaultPushMode;if(mode==='title'&&!confirm('Заголовки будущих напоминаний этого хранилища будут передаваться серверу и push-службе без шифрования. Продолжить?'))return;void run(async()=>{await setVaultPushMode(user,draft.vault,mode);setPushDefaults(current=>({...current,[draft.vault]:mode}));});}},e('option',{value:'neutral'},'Нейтральный'),e('option',{value:'title'},'Заголовок заметки'))),
        e('fieldset',null,e('legend',null,'Текст уведомления'),
          e('label',{class:'check-row'},e('input',{type:'radio',name:'reminder-mode',checked:reminderMode==='neutral',onChange:()=>setReminderMode('neutral')}),'Нейтральный: «У вас запланировано напоминание»'),
          e('label',{class:'check-row'},e('input',{type:'radio',name:'reminder-mode',checked:reminderMode==='custom',onChange:()=>setReminderMode('custom')}),'Свой текст'),
          e('button',{type:'button',class:reminderMode==='title'?'title-push-button selected':'title-push-button','aria-pressed':reminderMode==='title',
            onClick:()=>{setReminderMode('title');setReminderText('');}},'Взять заголовок как текст сообщения')),
        reminderMode==='custom'&&e('div',null,e('label',null,'Текст push',e('textarea',{rows:3,maxLength:200,required:true,value:reminderText,onInput:(ev:Event)=>setReminderText((ev.target as HTMLTextAreaElement).value)})),
          e('small',null,Array.from(reminderText).length+' / 200')),
        reminderMode==='title'&&e('div',{class:'title-push-value'},e('strong',null,'Текущий текст push'),e('p',null,Array.from(draft.title).slice(0,200).join('')||'Сначала укажите заголовок заметки'),
          Array.from(draft.title).length>200&&e('small',null,'В push попадут первые 200 символов. Текст будет обновляться вместе с заголовком.')),
        reminderMode!=='neutral'&&e('label',{class:'check-row'},e('input',{type:'checkbox',checked:reminderConsent,required:true,onChange:(ev:Event)=>setReminderConsent((ev.target as HTMLInputElement).checked)}),'Разрешаю передать этот текст серверу и push-службе. Он не будет защищён ключом хранилища.'),
        e('div',{class:'reminder-preview','aria-label':'Предпросмотр уведомления'},e('strong',null,'Tasks'),e('p',null,reminderMode==='custom'?(reminderText||'Введите свой текст'):reminderMode==='title'?(Array.from(draft.title).slice(0,200).join('')||'Сначала укажите заголовок заметки'):'У вас запланировано напоминание')),
        feedback,e('button',{class:'primary',disabled:busy,type:'submit'},busy?'Сохраняем…':'Сохранить напоминание')),
      draft.reminder&&e('button',{class:'danger-button',disabled:busy,onClick:()=>void run(async()=>{changeReminder(undefined);setScreen('list');await flush();void sync();})},'Удалить напоминание'));
  }
  if(screen==='history'&&history){
    const currentVault=state?.vaults.find(item=>item.header.id===history.vault),currentId=currentVault&&heads(currentVault).find(item=>item.objectId===history.objectId)?.id;
    const selectedVersion=history.entries.find(item=>item.revision.id===history.selected),currentVersion=history.entries.find(item=>item.revision.id===currentId)??history.entries[0];
    const preview=(entry:typeof selectedVersion,label:string)=>entry&&e('article',{class:'version-preview'},e('p',{class:'eyebrow'},label),e('h2',null,entry.note.title||'Без заголовка'),
      entry.note.html?e('div',{class:'rich-note-content',dangerouslySetInnerHTML:{__html:sanitizeNoteHtml(entry.note.html)}}):e('p',{class:'note-preview'},entry.note.text||'Нет текста'),
      Boolean(entry.note.checklist?.length)&&e('p',{class:'hint'},'Чек-лист: '+entry.note.checklist!.filter(item=>item.done).length+' / '+entry.note.checklist!.length),
      Boolean(entry.note.attachments?.length)&&e('p',{class:'hint'},'Вложения: '+entry.note.attachments!.length));
    return e('section',{class:'card planner history-screen'},e('button',{onClick:()=>{setHistory(null);setScreen(history.back);}},'Назад'),e('h1',null,'История версий'),
      e('p',{class:'hint'},'Все версии расшифровываются только на этом устройстве. Восстановление создаёт новую версию и сохраняет текущую в истории.'),
      e('div',{class:'version-layout'},e('div',{class:'version-list'},history.entries.map(entry=>e('button',{key:entry.revision.id,class:history.selected===entry.revision.id?'version-row selected':'version-row',onClick:()=>setHistory({...history,selected:entry.revision.id})},
        e('strong',null,entry.revision.id===currentId?'Текущая версия':entry.note.author?new Date(entry.note.author.time).toLocaleString('ru-RU'):'Время неизвестно'),
        e('small',null,(entry.note.author?.name??'Источник неизвестен')+(entry.note.lifecycle?.state==='archived'?' · Архив':entry.note.lifecycle?.state==='trashed'?' · Корзина':''))))),
        e('div',{class:'version-comparison'},preview(currentVersion,'ТЕКУЩАЯ'),selectedVersion?.revision.id!==currentVersion?.revision.id&&preview(selectedVersion,'ВЫБРАННАЯ'))),
      selectedVersion&&selectedVersion.revision.id!==currentId&&e('button',{class:'primary',disabled:busy,onClick:()=>{if(confirm('Восстановить выбранное содержимое как новую версию? Старое напоминание останется выключенным.'))void run(async()=>{await restoreNoteVersion(user,history.vault,history.objectId,history.selected);const back=history.back;setHistory(null);setScreen(back);setStatus('Выбранная версия восстановлена как новая.');void sync();});}},'Восстановить эту версию'),
      feedback);
  }
  if(viewing&&!draft){const current=state?.vaults.find(item=>item.header.id===viewing.vault),versions=current?heads(current).filter(item=>item.objectId===viewing.object):[],competing=versions.length>1,
    revision=versions.find(item=>item.id===viewing.revision),lifecycle=current&&revision?statusOf(current,revision,viewing):'active';return e('section',{class:'card note-view'},
    e('div',{class:'actions note-view-actions'},e('button',{onClick:()=>{showViewing(null);setMenuOpen(false);}},'Назад'),
      e('div',{class:'actions compact'},e('button',{disabled:competing,onClick:()=>setMenuOpen(!menuOpen),'aria-expanded':menuOpen&&!competing},'Действия'),lifecycle==='active'&&!competing&&e('button',{class:'primary',onClick:()=>showDraft({...viewing,dirty:false})},'Редактировать'))),
    competing&&e('div',{class:'error',role:'status'},'Заметка изменена на нескольких устройствах. Выберите версию, прежде чем редактировать.',
      e('button',{onClick:()=>{setComparison({objectId:viewing.object,versions:versions.map(item=>item.id),chosen:versions[0].id});showViewing(null);setMenuOpen(false);setScreen('conflict');}},'Сравнить версии')),
    menuOpen&&!competing&&e('div',{class:'note-action-menu',role:'menu'},
      lifecycle==='active'&&e('button',{onClick:()=>{setMenuOpen(false);void run(()=>updateViewing({pinned:!viewing.pinned}));}},viewing.pinned?'Открепить':'Закрепить'),
      lifecycle==='active'&&e('button',{onClick:()=>showDraft({...viewing,dirty:false})},'Изменить теги'),
      lifecycle==='active'&&e('button',{disabled:busy,onClick:()=>{if(current)void run(()=>duplicate(current,viewing.revision));}},'Создать копию'),
      e('button',{disabled:busy,onClick:exportViewingZip},'Экспортировать ZIP'),
      current&&e('button',{disabled:busy,onClick:()=>void run(()=>openHistory(current,viewing.object,lifecycle==='archived'?'archive':lifecycle==='trashed'?'trash':'list'))},'История версий'),
      lifecycle==='active'&&current&&e('button',{disabled:busy,onClick:()=>void run(()=>archiveCurrent(current,viewing.object))},'Архивировать'),
      lifecycle==='archived'&&current&&revision&&e('button',{disabled:busy,onClick:()=>void run(()=>restoreArchive(current,revision,viewing))},'Вернуть из архива'),
      lifecycle!=='trashed'&&current&&e('button',{class:'menu-danger',disabled:busy,onClick:()=>{if(confirm('Переместить заметку в корзину? Она будет окончательно удалена через 30 дней.'))void run(()=>trashCurrent(current,viewing.object));}},'Удалить'),
      lifecycle==='trashed'&&current&&e('button',{disabled:busy,onClick:()=>void run(()=>restoreTrash(current,viewing.object))},'Восстановить'),
      lifecycle==='trashed'&&current&&e('button',{class:'menu-danger',disabled:busy,onClick:()=>{if(confirm('Удалить заметку и всю историю навсегда? Восстановить её средствами приложения будет невозможно.'))void run(()=>purgeCurrent(current,viewing.object));}},'Удалить навсегда')),
    lifecycle!=='active'&&e('p',{class:lifecycle==='trashed'?'lifecycle-banner trash':'lifecycle-banner'},lifecycle==='archived'?'Заметка находится в архиве. Напоминание приостановлено.':'Заметка находится в корзине. Она будет удалена автоматически через 30 дней.'),
    e('h1',null,viewing.title||'Без заголовка'),
    tagChips(viewing.vault,viewing.tagIds).length>0&&e('div',{class:'tag-list'},tagChips(viewing.vault,viewing.tagIds).map(tag=>e('span',{class:'tag-chip',style:{'--tag-color':tag.color},key:tag.id},tag.name))),
    viewing.html?e('div',{class:'note-view-text rich-note-content',dangerouslySetInnerHTML:{__html:sanitizeNoteHtml(viewing.html)}})
      :viewing.text?e('div',{class:'note-view-text'},viewing.text):e('p',{class:'muted'},'В заметке пока нет текста.'),
    Boolean(viewing.checklist?.length)&&e('section',{class:'checklist-view'},e('h2',null,'Чек-лист'),viewing.checklist!.map(item=>e('label',{class:'checklist-view-row',key:item.id},e('input',{type:'checkbox',checked:item.done,disabled:busy,onChange:(ev:Event)=>void run(()=>updateViewing({checklist:viewing.checklist!.map(current=>current.id===item.id?{...current,done:(ev.target as HTMLInputElement).checked}:current)}))}),e('span',{class:item.done?'completed':''},item.text||'Пустой пункт')))),
    e(Attachments,{items:viewing.attachments??[]}),
    viewing.reminder&&e('section',{class:'reminder-card'},e('h2',null,'Напоминание'),
      e('p',null,new Date(viewing.reminder.local+'Z').toLocaleString('ru-RU',{timeZone:'UTC'}),' · ',
        viewing.reminder.state==='active'?'Активно':viewing.reminder.state==='done'?'Выполнено':'Выключено'),
      e('p',{class:'hint'},viewing.reminder.mode==='custom'?'Для push разрешён отдельный собственный текст.':viewing.reminder.mode==='title'?'Текст push автоматически повторяет заголовок заметки.':'Push не содержит названия хранилища и текста заметки.')),feedback);}
  if (draft) return e('section', { class: 'card note-editor' },
    e('div', { class: 'actions' }, e('button', { disabled: busy, onClick: () => void run(finishEditing) }, 'Назад'),
      e('button', { class: 'primary', disabled: busy, onClick: () => void run(finishEditing) }, 'Готово')),
    e('label', null, 'Заголовок', e('input', { value: draft.title, maxLength: 500, onInput: (ev: Event) => change('title', (ev.target as HTMLInputElement).value) })),
    e('label',{class:'editor-label'},'Текст заметки'),
    e(RichTextEditor,{key:draft.object,html:draft.html,text:draft.text,attachments:draft.attachments??[],
      onChange:(html:string,text:string)=>changeContent({html,text}),onAttachmentsChange:(attachments:NonNullable<Note['attachments']>)=>changeContent({attachments}),onError:setError}),
    checklistEditor(),
    e('section',{class:'note-tags'},e('div',{class:'section-heading'},e('h2',null,'Теги'),e('button',{onClick:()=>void run(async()=>{await flush();showDraft(null);showViewing(null);setScreen('tags');})},'Редактировать список')),
      e('div',{class:'tag-picker'},activeTags(draft.vault).map(tag=>e('label',{class:'tag-choice',key:tag.id},e('input',{type:'checkbox',checked:(draft.tagIds??[]).includes(tag.id),onChange:(ev:Event)=>{
        const checked=(ev.target as HTMLInputElement).checked,current=draftRef.current?.tagIds??[];changeContent({tagIds:checked?[...current,tag.id]:current.filter(id=>id!==tag.id)});}}),e('span',{class:'tag-chip',style:{'--tag-color':tag.color}},tag.name))))),
    e('label',{class:'check-row pin-control'},e('input',{type:'checkbox',checked:Boolean(draft.pinned),onChange:(ev:Event)=>changeContent({pinned:(ev.target as HTMLInputElement).checked})}),'Закрепить заметку'),
    e('section',{class:'reminder-card'},e('h2',null,'Напоминание'),draft.reminder?
      e('div',null,e('p',null,new Date(draft.reminder.local+'Z').toLocaleString('ru-RU',{timeZone:'UTC'}),' · ',
        draft.reminder.state==='active'?'Активно':draft.reminder.state==='done'?'Выполнено':'Выключено'),
        e('p',{class:'hint'},draft.reminder.mode==='custom'?'Push отправит сохранённый собственный текст.':draft.reminder.mode==='title'?'Текст push автоматически повторяет заголовок заметки.':'Push не содержит названия хранилища и текста заметки.'),
        e('div',{class:'actions compact'},e('button',{onClick:openReminderForm},'Изменить'),
          draft.reminder.state==='active'&&e('button',{disabled:busy,onClick:()=>void run(async()=>{changeReminder({...draft.reminder!,id:crypto.randomUUID(),state:'done'});await flush();void sync();})},'Выполнено')))
      :e('button',{onClick:openReminderForm},'Напомнить')),
    feedback, error && e('button', { onClick: () => void run(flush) }, 'Повторить сохранение'));
  if (screen === 'create' || screen === 'open' || screen === 'transfer') return e('section', { class: 'card' },
    e('button', { disabled: busy, onClick: () => { if(screen==='open'){postponeUnlock();return;}setScreen('list');setPhrase('');setRepeat(''); } }, screen==='open'?'Отложить':'Назад'),
    e('h2', null, screen === 'open' ? 'Открыть хранилище' : screen === 'transfer' ? 'Перенести с новой фразой' : 'Новое хранилище'),
    screen==='open'&&v?.systemUnlock&&e('div',{class:'auth-notice'},
      e('p',null,'Для этого хранилища настроена системная разблокировка на данном устройстве. При выборе хранилища Tasks сразу запрашивает системную проверку.'),
      e('button',{class:'primary',type:'button',disabled:busy,onClick:()=>void activateVault(selected)},busy?'Ожидаем системную проверку…':'Повторить системную разблокировку'),
      e('p',{class:'hint'},'Можно вместо этого ввести фразу хранилища ниже или отложить открытие.')),
    screen!=='open'&&e('p',{class:'hint'},'Название видно на всех ваших устройствах до разблокировки и хранится на сервере отдельно от зашифрованных заметок.'),
    e('p', { class: 'hint' }, screen==='open'&&v?.systemUnlock?'Фраза остаётся независимым резервным способом и не отправляется на сервер.':'Фраза не отправляется на сервер. Доступ сохранится на этом устройстве до «Закрыть хранилище». Без фразы и сохранённого доступа восстановить заметки невозможно.'),
    e('form', { onSubmit: submit }, screen !== 'open' && e('label', null, 'Название', e('input', { required: true, maxLength: 200, value: name, onInput: (ev: Event) => setName((ev.target as HTMLInputElement).value) })),
      e('label', null, 'Фраза хранилища', e('input', { type: 'password', autoComplete: screen === 'open' ? 'current-password' : 'new-password', autoFocus:screen==='open', required: true, value: phrase,
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
  if(screen==='schedule'){
    const localNotes=(state?.vaults??[]).flatMap(current=>current.key&&!current.deleted?heads(current).map(revision=>({current,revision,note:notes[revision.id]})):[])
      .filter(item=>Boolean(item.note)&&statusOf(item.current,item.revision,item.note!)==='active');
    const findLocal=(item:ReminderStatus)=>localNotes.find(local=>local.current.header.id===item.vault_id&&local.revision.objectId===item.object_id);
    const nowLocal=localTime(Date.now(),zone),today=nowLocal.slice(0,10),tomorrowDate=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10);
    const activeStatuses=new Set(['scheduled','fired','seen','missed']),visible=serverReminders.filter(item=>item.plan_state==='active'&&(showReminderHistory||activeStatuses.has(item.occurrence_status))).filter(item=>{
      if(!selectedTags.length)return true;const local=findLocal(item);return Boolean(local&&local.current.header.id===selected&&selectedTags.every(tagId=>(local.note!.tagIds??[]).includes(tagId)));
    });
    const itemLocal=(item:ReminderStatus)=>item.snooze_local??item.scheduled_local;
    const groups:[string,string,(item:ReminderStatus)=>boolean][]=[
      ['overdue','Просрочено',item=>['scheduled','fired','seen'].includes(item.occurrence_status)&&itemLocal(item)<nowLocal],
      ['today','Сегодня',item=>['scheduled','fired','seen'].includes(item.occurrence_status)&&itemLocal(item).slice(0,10)===today&&itemLocal(item)>=nowLocal],
      ['tomorrow','Завтра',item=>['scheduled','fired','seen'].includes(item.occurrence_status)&&itemLocal(item).slice(0,10)===tomorrowDate],
      ['later','Позже',item=>['scheduled','fired','seen'].includes(item.occurrence_status)&&itemLocal(item).slice(0,10)>tomorrowDate],
      ['missed','Пропущено',item=>item.occurrence_status==='missed'],
      ['history','История',item=>['done','skipped'].includes(item.occurrence_status)],
    ];
    const selectedItem=serverReminders.find(item=>item.occurrence_id===selectedOccurrence),selectedLocal=selectedItem&&findLocal(selectedItem);
    const repeatLabel=(item:ReminderStatus)=>{const schedule=JSON.parse(item.schedule) as {repeat:ReminderRepeat;allDay:boolean;important:boolean};return schedule.repeat.type==='once'?'Один раз':schedule.repeat.type==='daily'?'Ежедневно':schedule.repeat.type==='weekly'?'По дням недели':schedule.repeat.type==='interval'?'Каждые '+schedule.repeat.days+' дн.':'Ежемесячно';};
    const refreshReminders=async()=>{const value=await reminderRequest(user,'');setServerReminders(value.items);setReminderSettings(value.settings);};
    const act=(item:ReminderStatus,operation:'complete'|'skip'|'snooze'|'pause',local:null|string=null)=>void run(async()=>{await reminderRequest(user,'action',{occurrenceId:item.occurrence_id,operation,local});setSnoozeOpen(false);await refreshReminders();});
    const addNew=()=>{const current=(v?.key&&!v.deleted?v:opened[0]);if(!current?.key){setError('Сначала откройте хранилище');return;}select(current.header.id);const d:Draft={vault:current.header.id,object:crypto.randomUUID(),revision:null,title:'',text:'',dirty:false,key:current.key};showViewing(null);showDraft(d);prepareReminderForm(d);};
    const removeSchedule=()=>{if(!selectedLocal)return;const d:Draft={...selectedLocal.note!,vault:selectedLocal.current.header.id,object:selectedLocal.revision.objectId,revision:selectedLocal.revision.id,dirty:true,key:selectedLocal.current.key!};showDraft({...d,reminder:undefined});setSelectedOccurrence('');setScreen('list');void run(async()=>{await flush();void sync();});};
    const pauseSchedule=()=>{if(!selectedLocal?.note?.reminder){act(selectedItem!,'pause');return;}const d:Draft={...selectedLocal.note,vault:selectedLocal.current.header.id,object:selectedLocal.revision.objectId,revision:selectedLocal.revision.id,dirty:true,key:selectedLocal.current.key!};
      showDraft({...d,reminder:{...selectedLocal.note.reminder,state:'off'}});setSelectedOccurrence('');setScreen('list');void run(async()=>{await flush();void sync();});};
    const formatLocal=(local:string)=>new Date(local+'Z').toLocaleString('ru-RU',{timeZone:'UTC',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});
    if(selectedItem)return e('section',{class:'card planner occurrence-detail'},e('button',{onClick:()=>{setSelectedOccurrence('');setSnoozeOpen(false);}},'Назад'),
      e('p',{class:'eyebrow'},selectedItem.occurrence_status==='missed'?'ПРОПУЩЕНО':selectedItem.occurrence_status==='done'?'ВЫПОЛНЕНО':'СРАБАТЫВАНИЕ'),
      e('h1',null,selectedLocal?.note?.title||'Напоминание из закрытого хранилища'),
      e('p',{class:'occurrence-time'},formatLocal(selectedItem.snooze_local??selectedItem.scheduled_local)),
      e('p',{class:'hint'},(names[selectedItem.vault_id]||'Закрытое хранилище')+' · '+repeatLabel(selectedItem)+(JSON.parse(selectedItem.schedule).important?' · Важное':'')),
      selectedLocal&&e('article',{class:'linked-note'},e('strong',null,'Связанная заметка'),e('p',null,selectedLocal.note!.text.slice(0,180)||'Нет текста')),
      ['scheduled','fired','seen'].includes(selectedItem.occurrence_status)&&e('div',{class:'actions occurrence-actions'},
        e('button',{class:'primary',disabled:busy,onClick:()=>act(selectedItem,'complete')},'Выполнить'),e('button',{disabled:busy,onClick:()=>setSnoozeOpen(!snoozeOpen)},'Отложить')),
      snoozeOpen&&e('section',{class:'snooze-sheet'},e('h2',null,'Отложить'),
        e('div',{class:'quick-filters'},[[15,'15 минут'],[60,'1 час'],[180,'3 часа']].map(([minutes,label])=>e('button',{disabled:busy,onClick:()=>act(selectedItem,'snooze',localTime(Date.now()+Number(minutes)*60000,zone))},label)),
          e('button',{disabled:busy,onClick:()=>act(selectedItem,'snooze',localDateAfter(1)+'T09:00')},'Завтра, 09:00'),
          e('button',{disabled:busy,onClick:()=>{let ms=Date.now()+86400000;while(![6,7].includes(new Date(localTime(ms,zone)+'Z').getUTCDay()||7))ms+=86400000;act(selectedItem,'snooze',localTime(ms,zone).slice(0,10)+'T09:00');}},'На выходные')),
        e('label',null,'Своя дата и время',e('input',{type:'datetime-local',value:snoozeLocal,min:localTime(Date.now()+60000,zone),onInput:(ev:Event)=>setSnoozeLocal((ev.target as HTMLInputElement).value)})),
        e('button',{class:'primary',disabled:busy||!snoozeLocal,onClick:()=>act(selectedItem,'snooze',snoozeLocal)},'Отложить')),
      e('div',{class:'actions'},selectedLocal&&e('button',{onClick:()=>{openRevision(selectedLocal.current,selectedLocal.revision);setSelectedOccurrence('');setScreen('list');}},'Открыть заметку'),
        selectedLocal&&e('button',{onClick:()=>{setSelectedOccurrence('');editReminderFor(selectedLocal.current,selectedLocal.revision);}},'Изменить напоминание'),
        e('button',{disabled:busy,onClick:pauseSchedule},'Приостановить расписание')),
      selectedLocal?e('button',{class:'danger-button',disabled:busy,onClick:()=>{if(confirm('Удалить расписание и всю историю его срабатываний?'))removeSchedule();}},'Удалить напоминание')
        :state?.vaults.some(item=>item.header.id===selectedItem.vault_id&&!item.deleted&&!item.key)&&e('button',{onClick:()=>form('open',selectedItem.vault_id)},'Открыть хранилище'),feedback);
    return e('section',{class:'card planner today-screen'},e('button',{onClick:()=>setScreen('list')},'Назад'),
      e('div',{class:'card-heading'},e('div',null,e('p',{class:'eyebrow'},new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'}).toUpperCase()),e('h1',null,'Сегодня')),
        e('button',{class:'today-add',onClick:()=>setTodayMenuOpen(!todayMenuOpen),'aria-expanded':todayMenuOpen},'+ Добавить')),
      e('div',{class:'today-counters'},groups.slice(0,4).map(([key,label,test])=>e('div',{key},e('strong',null,visible.filter(test).length),e('span',null,label)))),
      todayMenuOpen&&e('div',{class:'note-action-menu today-add-menu'},e('button',{onClick:addNew},'Новая заметка с напоминанием'),e('button',{onClick:()=>setTodayPickOpen(!todayPickOpen)},'Выбрать существующую заметку')),
      todayPickOpen&&e('div',{class:'today-note-picker'},localNotes.map(item=>e('button',{class:'note-row',key:item.revision.id,onClick:()=>{setTodayMenuOpen(false);setTodayPickOpen(false);editReminderFor(item.current,item.revision);}},e('strong',null,item.note!.title||'Без заголовка'),e('small',null,names[item.current.header.id])))),
      v?.key&&activeTags(v.header.id).length>0&&e('div',{class:'tag-filter today-tag-filter'},activeTags(v.header.id).map(tag=>e('button',{key:tag.id,class:selectedTags.includes(tag.id)?'tag-chip selected':'tag-chip',style:{'--tag-color':tag.color},'aria-pressed':selectedTags.includes(tag.id),onClick:()=>setSelectedTags(current=>current.includes(tag.id)?current.filter(id=>id!==tag.id):[...current,tag.id])},tag.name))),
      e('label',{class:'check-row history-toggle'},e('input',{type:'checkbox',checked:showReminderHistory,onChange:(ev:Event)=>setShowReminderHistory((ev.target as HTMLInputElement).checked)}),'Показать выполненные и пропущенные срабатывания'),
      !visible.length&&e('div',{class:'empty-state'},e('h2',null,'Напоминаний пока нет'),e('p',null,'Добавьте новую заметку с напоминанием или выберите существующую.')),
      groups.map(([key,label,test])=>{const items=visible.filter(test);return items.length&&e('section',{class:'today-group',key},e('h2',null,label),items.map(item=>{const local=findLocal(item),schedule=JSON.parse(item.schedule);return e('button',{class:'note-row occurrence-row'+(schedule.important?' important':''),key:item.occurrence_id,onClick:()=>setSelectedOccurrence(item.occurrence_id)},
          e('strong',null,local?.note?.title||'Напоминание из закрытого хранилища'),e('span',null,schedule.allDay?'Весь день · '+item.scheduled_local.slice(11):formatLocal(item.snooze_local??item.scheduled_local)),
          e('small',null,(names[item.vault_id]||'Закрытое хранилище')+' · '+repeatLabel(item)+(item.snooze_local?' · Отложено':'')));}))}),feedback);
  }
  if(screen==='tags'&&v?.key){const catalog=activeTags(v.header.id);return e('section',{class:'card planner tag-manager'},
    e('button',{onClick:()=>{setScreen('list');setEditingTag('');setTagName('');}},'Назад'),e('h1',null,'Теги хранилища'),
    e('p',{class:'hint'},'Названия и цвета тегов зашифрованы вместе с хранилищем. Удалённый тег исчезнет из заметок, но сами заметки сохранятся.'),
    e('form',{class:'tag-form',onSubmit:(event:Event)=>{event.preventDefault();void run(async()=>{if(editingTag)await renameTag(user,selected,editingTag,tagName,tagColor);else await createTag(user,selected,tagName,tagColor);setTagName('');setEditingTag('');void sync();});}},
      e('label',null,editingTag?'Название тега':'Новый тег',e('input',{required:true,maxLength:60,value:tagName,onInput:(ev:Event)=>setTagName((ev.target as HTMLInputElement).value)})),
      e('label',null,'Цвет',e('input',{type:'color',value:tagColor,onInput:(ev:Event)=>setTagColor((ev.target as HTMLInputElement).value)})),
      e('button',{class:'primary',disabled:busy},editingTag?'Сохранить':'Добавить'),editingTag&&e('button',{type:'button',onClick:()=>{setEditingTag('');setTagName('');}},'Отмена')),
    catalog.map(tag=>{const count=heads(v).filter(r=>(notes[r.id]?.tagIds??[]).includes(tag.id)).length;return e('div',{class:'tag-manage-row',key:tag.id},
      e('span',{class:'tag-chip',style:{'--tag-color':tag.color}},tag.name),e('small',null,count+' заметок'),
      e('button',{onClick:()=>{setEditingTag(tag.id);setTagName(tag.name);setTagColor(tag.color);}},'Изменить'),
      e('button',{class:'icon-danger',onClick:()=>{if(confirm('Удалить тег «'+tag.name+'»? Заметки останутся на месте.'))void run(async()=>{await deleteTag(user,selected,tag.id);setSelectedTags(current=>current.filter(id=>id!==tag.id));void sync();});}},'Удалить'));}),feedback);
  }
  if((screen==='archive'||screen==='trash')&&v?.key){const wanted=screen==='archive'?'archived':'trashed',normalized=query.trim().toLocaleLowerCase('ru');
    const conflictObjects=[...new Set(heads(v).map(revision=>revision.objectId))].filter(objectId=>{const versions=heads(v).filter(revision=>revision.objectId===objectId);return versions.length>1&&versions.some(revision=>notes[revision.id]&&statusOf(v,revision,notes[revision.id])===wanted);});
    const items=heads(v).map(revision=>({revision,note:notes[revision.id]})).filter((item):item is {revision:Revision;note:Note}=>Boolean(item.note))
      .filter(item=>!conflictObjects.includes(item.revision.objectId)&&statusOf(v,item.revision,item.note)===wanted&&!(screen==='trash'&&v.purgePending?.includes(item.revision.objectId))&&selectedTags.every(tagId=>(item.note.tagIds??[]).includes(tagId)))
      .map(item=>({...item,score:normalized?noteSearchScore(query,{note:item.note,tags:tagChips(v.header.id,item.note.tagIds)}):0})).filter(item=>!normalized||item.score)
      .sort((a,b)=>normalized?(searchSort==='relevance'?b.score-a.score:searchSort==='oldest'?(a.note.author?.time??0)-(b.note.author?.time??0):(b.note.author?.time??0)-(a.note.author?.time??0))
        :sort==='title'?a.note.title.localeCompare(b.note.title,'ru'):sort==='oldest'?(a.note.author?.time??0)-(b.note.author?.time??0):(b.note.author?.time??0)-(a.note.author?.time??0));
    const all=heads(v).map(revision=>({revision,note:notes[revision.id]})).filter((item):item is {revision:Revision;note:Note}=>Boolean(item.note)&&statusOf(v,item.revision,item.note)===wanted&&!v.purgePending?.includes(item.revision.objectId));
    return e('section',{class:'card planner lifecycle-screen'},
      e('div',{class:'card-heading'},e('button',{onClick:()=>{setQuery('');setSelectedTags([]);setScreen('list');}},'Назад'),e('h1',null,screen==='archive'?'Архив':'Корзина'),
        screen==='trash'&&Boolean(all.length)&&e('button',{class:'danger-button',disabled:busy,onClick:()=>{if(confirm('Окончательно удалить все заметки из корзины и всю их историю?'))void run(async()=>{for(const item of all)await permanentlyDeleteNote(user,v.header.id,item.revision.objectId);setStatus('Очистка корзины поставлена в очередь синхронизации.');void sync();});}},'Очистить корзину')),
      e('div',{class:screen==='archive'?'lifecycle-info':'lifecycle-info trash'},screen==='archive'?'Архивные заметки не удалены. Их можно восстановить в любое время; напоминания приостановлены.':'Заметки автоматически удаляются через 30 дней. До этого их можно восстановить.'),
      e('div',{class:'organization-tools'},e('label',{class:'search-field'},'Поиск',e('input',{type:'search',value:query,placeholder:'Найти заметку',onInput:(event:Event)=>setQuery((event.target as HTMLInputElement).value)})),
        normalized?e('label',null,'Сортировка результатов',e('select',{value:searchSort,onChange:(event:Event)=>setSearchSort((event.target as HTMLSelectElement).value as typeof searchSort)},e('option',{value:'relevance'},'По релевантности'),e('option',{value:'newest'},'Сначала новые'),e('option',{value:'oldest'},'Сначала старые')))
          :e('label',null,'Сортировка',e('select',{value:sort,onChange:(event:Event)=>setSort((event.target as HTMLSelectElement).value as typeof sort)},e('option',{value:'newest'},'Сначала новые'),e('option',{value:'oldest'},'Сначала старые'),e('option',{value:'title'},'По заголовку')))),
      activeTags(v.header.id).length>0&&e('div',{class:'tag-filter'},e('button',{class:selectedTags.length?'filter-chip':'filter-chip selected',onClick:()=>setSelectedTags([])},'Все'),activeTags(v.header.id).map(tag=>e('button',{key:tag.id,class:selectedTags.includes(tag.id)?'tag-chip selected':'tag-chip',style:{'--tag-color':tag.color},'aria-pressed':selectedTags.includes(tag.id),onClick:()=>setSelectedTags(current=>current.includes(tag.id)?current.filter(id=>id!==tag.id):[...current,tag.id])},tag.name))),
      conflictObjects.map(objectId=>e('button',{class:'conflict-notice',disabled:busy,key:'conflict-'+objectId,onClick:()=>{const versions=heads(v).filter(revision=>revision.objectId===objectId).map(revision=>revision.id);setComparison({objectId,versions,chosen:versions[0]});setScreen('conflict');}},'Разрешить конфликт версий: '+(notes[heads(v).find(revision=>revision.objectId===objectId)!.id]?.title||'Без заголовка'))),
      !items.length&&e('div',{class:'empty-state'},e('h2',null,normalized?'Ничего не найдено':screen==='archive'?'Архив пуст':'Корзина пуста'),e('p',null,normalized?'Измените поисковый запрос.':screen==='archive'?'Архивированные заметки появятся здесь.':'Удалённые заметки будут храниться здесь 30 дней.')),
      items.map(item=>{
        const expiry=v.objectStates?.[item.revision.objectId]?.purgeAfter;
        return e('article',{class:'lifecycle-row',key:item.revision.id},
          e('button',{class:'note-row',onClick:()=>openRevision(v,item.revision)},e('strong',null,item.note.title||'Без заголовка'),
            e('span',{class:'note-preview'},item.note.text.slice(0,140)),
            tagChips(v.header.id,item.note.tagIds).length>0&&e('span',{class:'tag-list'},tagChips(v.header.id,item.note.tagIds).map(tag=>e('span',{class:'tag-chip',style:{'--tag-color':tag.color},key:tag.id},tag.name))),
            e('small',null,screen==='trash'?(expiry?'Удаление '+new Date(expiry).toLocaleDateString('ru-RU'):'Ожидает синхронизации срока удаления'):new Date(item.note.lifecycle?.changedAt??item.note.author?.time??0).toLocaleString('ru-RU'))),
          e('div',{class:'actions compact'},
            screen==='archive'?e('button',{disabled:busy,onClick:()=>void run(()=>restoreArchive(v,item.revision,item.note))},'Восстановить'):e('button',{disabled:busy,onClick:()=>void run(()=>restoreTrash(v,item.revision.objectId))},'Восстановить'),
            e('button',{disabled:busy,onClick:()=>void run(()=>openHistory(v,item.revision.objectId,screen))},'История'),
            screen==='trash'&&e('button',{class:'danger-button',disabled:busy,onClick:()=>{if(confirm('Удалить заметку и всю историю навсегда?'))void run(()=>purgeCurrent(v,item.revision.objectId));}},'Удалить навсегда'))
        );
      }),feedback);
  }
  const normalizedQuery=query.trim().toLocaleLowerCase('ru');
  const candidates=(normalizedQuery?(state?.vaults??[]).filter(current=>current.key&&!current.deleted&&!current.transfer):v?.key?[v]:[]).flatMap(current=>
    heads(current).map(revision=>({current,revision,note:notes[revision.id]})).filter(item=>Boolean(item.note)&&statusOf(current,item.revision,item.note!)==='active'));
  const visibleItems=candidates.map(item=>({...item,score:normalizedQuery?noteSearchScore(query,{note:item.note!,tags:tagChips(item.current.header.id,item.note!.tagIds)}):0})).filter(({current,note,score})=>{
    if(normalizedQuery&&!score)return false;
    if(quickFilter==='pinned'&&!note!.pinned||quickFilter==='untagged'&&(note!.tagIds??[]).some(id=>activeTags(current.header.id).some(tag=>tag.id===id))||quickFilter==='reminder'&&!note!.reminder)return false;
    return (!selectedTags.length||current.header.id===selected)&&selectedTags.every(tagId=>(note!.tagIds??[]).includes(tagId));
  }).sort((a,b)=>normalizedQuery?(searchSort==='relevance'?b.score-a.score||(b.note!.author?.time??0)-(a.note!.author?.time??0):searchSort==='oldest'?(a.note!.author?.time??0)-(b.note!.author?.time??0):(b.note!.author?.time??0)-(a.note!.author?.time??0))
    :Number(Boolean(b.note!.pinned))-Number(Boolean(a.note!.pinned))||(sort==='title'?a.note!.title.localeCompare(b.note!.title,'ru'):sort==='oldest'?(a.note!.author?.time??0)-(b.note!.author?.time??0):(b.note!.author?.time??0)-(a.note!.author?.time??0)));
  return e('section', { class: 'card planner' },
    e('div', { class: 'card-heading' }, e('h1', null, 'Заметки'), e('button', { disabled: busy, onClick: () => void run(sync) }, 'Синхронизировать')),
    e('label', null, 'Хранилище', e('select', { value: selected, onChange: (ev: Event) => void activateVault((ev.target as HTMLSelectElement).value) },
      e('option', { value: '' }, 'Выберите хранилище'), active.map(v => e('option', { value: v.header.id, key: v.header.id }, names[v.header.id] || 'Хранилище')))),
    state?.sessionReviewRequired&&e('div',{class:'auth-notice',role:'status'},e('strong',null,'Синхронизация локальных изменений приостановлена.'),
      e('p',null,reviewItems.length?`Нужно проверить изменений: ${reviewItems.length}.`:'Проверяем актуальное состояние сервера…'),
      reviewItems.length>0&&e('button',{class:'primary',onClick:()=>setScreen('outbox-review')},'Проверить изменения')),
    e('div',{class:'organization-tools'},e('label',{class:'search-field'},'Поиск во всех открытых хранилищах',e('input',{type:'search',value:query,placeholder:'Слова, часть слова или фраза',onInput:(ev:Event)=>setQuery((ev.target as HTMLInputElement).value)})),
      normalizedQuery?e('label',null,'Сортировка результатов',e('select',{value:searchSort,onChange:(ev:Event)=>setSearchSort((ev.target as HTMLSelectElement).value as typeof searchSort)},e('option',{value:'relevance'},'По релевантности'),e('option',{value:'newest'},'Сначала новые'),e('option',{value:'oldest'},'Сначала старые')))
        :e('label',null,'Сортировка',e('select',{value:sort,onChange:(ev:Event)=>setSort((ev.target as HTMLSelectElement).value as typeof sort)},e('option',{value:'newest'},'Сначала новые'),e('option',{value:'oldest'},'Сначала старые'),e('option',{value:'title'},'По заголовку')))),
    v?.key&&e('div',{class:'filters'},e('div',{class:'quick-filters'},([['all','Все'],['pinned','Закреплённые'],['untagged','Без тегов'],['reminder','С напоминанием']] as const).map(([value,label])=>e('button',{class:quickFilter===value?'filter-chip selected':'filter-chip','aria-pressed':quickFilter===value,onClick:()=>setQuickFilter(value)},label))),
      e('div',{class:'tag-filter'},activeTags(v.header.id).map(tag=>e('button',{key:tag.id,class:selectedTags.includes(tag.id)?'tag-chip selected':'tag-chip',style:{'--tag-color':tag.color},'aria-pressed':selectedTags.includes(tag.id),onClick:()=>setSelectedTags(current=>current.includes(tag.id)?current.filter(id=>id!==tag.id):[...current,tag.id])},tag.name)),
        e('button',{onClick:()=>setScreen('tags')},'Управлять тегами'))),
    e('div', { class: 'actions' }, e('button', { disabled: busy, onClick: () => form('create') }, '+ Хранилище'),
      e('button',{disabled:busy,onClick:()=>{setScreen('schedule');setSelectedOccurrence('');setSelectedTags([]);void reminderRequest(user,'').then(value=>{setServerReminders(value.items);setReminderSettings(value.settings);}).catch(()=>{});}},'Сегодня'),
      e('button',{disabled:!v?.key,onClick:()=>{setQuery('');setSelectedTags([]);setScreen('archive');}},'Архив'+(v?.key?' ('+heads(v).filter(r=>notes[r.id]&&statusOf(v,r,notes[r.id])==='archived').length+')':'')),
      e('button',{disabled:!v?.key,onClick:()=>{setQuery('');setSelectedTags([]);setScreen('trash');}},'Корзина'+(v?.key?' ('+heads(v).filter(r=>notes[r.id]&&statusOf(v,r,notes[r.id])==='trashed'&&!v.purgePending?.includes(r.objectId)).length+')':'')),
      e('button', { onClick: () => setScreen('stash') }, 'Отложенные заметки (' + (state?.stash.length ?? 0) + ')'),
      e('button',{onClick:()=>{setName(state?.deviceName??'Устройство');setScreen('device');}},'Это устройство: '+(state?.deviceName??'Устройство'))),
    v&&!v.deleted&&e('div',{class:'vault-security'},
      e('h2',null,'Разблокировка'),
      v.systemUnlock
        ? e('div',null,
          e('p',{class:'hint'},'Системная разблокировка включена · '+autoLockLabel(v.systemUnlock.autoLockMs)),
          e('div',{class:'actions'},
            v.key&&e('button',{disabled:busy,onClick:()=>void run(async()=>{await flush();showDraft(null);showViewing(null);await lockVault(user,selected);setStatus('Хранилище заблокировано.');})},'Заблокировать сейчас'),
            !v.key&&e('button',{class:'primary',disabled:busy,onClick:()=>void run(async()=>{await unlockVaultSystem(user,selected);setStatus('Хранилище разблокировано системной проверкой.');})},'Разблокировать системно'),
            e('button',{disabled:busy,onClick:()=>{setAutoLockMs(v.systemUnlock!.autoLockMs);setScreen('system-unlock');setPhrase('');setError('');}},'Настройки разблокировки'),
            e('button',{disabled:busy,onClick:()=>{if(confirm('Забыть системную разблокировку на этом устройстве? Фраза хранилища останется рабочей.'))void run(async()=>{await flush();showDraft(null);showViewing(null);await forgetSystemUnlock(user,selected);setStatus('Системная разблокировка забыта. Для открытия введите фразу.');});}},'Забыть системную разблокировку')))
        : e('div',null,e('p',{class:'hint'},'Хранилище остаётся открытым на этом устройстве после перезапуска PWA, пока вы явно его не закроете.'),
          v.key&&e('button',{disabled:busy||Boolean(v.transfer),onClick:()=>{setAutoLockMs(900_000);setPhrase('');setScreen('system-unlock');}},'Включить системную разблокировку')),
      e('button',{disabled:busy||Boolean(v.transfer)||!v.access,onClick:()=>form('close-all',selected)},'Закрыть на всех устройствах'),
      v.syncError&&e('p',{class:'error',role:'status'},v.syncError)),
    state?.stash.length ? e('p', { class: 'auth-notice', role: 'status' }, 'Есть заметки, не попавшие в конечное хранилище. Откройте «Отложенные заметки».') : null,
    state?.vaults.filter(v => v.deleted && v.records.some(r => r.pending)).map(v => e('div', { class: 'auth-notice' },
      e('p', null, 'Удалённое хранилище содержит локальные изменения. Чтобы перенести их в стеш, откройте его прежней фразой.'),
      e('button', { onClick: () => form('open', v.header.id) }, 'Открыть для сохранения заметок'),
      e('button', { onClick: () => { if (confirm('Удалить локальные изменения удалённого хранилища без возможности восстановления?')) void run(async () => {
        await edit(user, async s => { s.vaults = s.vaults.filter(x => x.header.id !== v.header.id); });
      }); } }, 'Удалить локальную копию'))),
    state?.vaults.filter(v=>!v.deleted&&Boolean(v.purgedObjects?.length)).map(v=>e('div',{class:'auth-notice',key:'purged-'+v.header.id},
      e('p',null,'На этом устройстве остались несинхронизированные версии окончательно удалённых заметок из «'+(names[v.header.id]||'закрытого хранилища')+'». Откройте хранилище прежней фразой, чтобы перенести их в отложенные заметки.'),
      e('button',{onClick:()=>form('open',v.header.id)},'Открыть и сохранить'),
      e('button',{onClick:()=>{if(confirm('Удалить эти локальные версии с устройства без возможности восстановления?'))void run(()=>discardPurgedObjects(user,v.header.id));}},'Удалить локальные версии'))),
    !active.length && e('div', { class: 'empty-state' }, e('h2', null, 'Пока нет хранилищ'), e('p', null, 'Создайте первое хранилище и задайте его фразу.')),
    v && !v.deleted && (!v.key ? e('button', { class: 'primary', onClick: () => void activateVault(selected) }, 'Открыть хранилище') : e('div', null,
      e('div', { class: 'actions' }, e('button', { disabled: busy || Boolean(v.transfer), onClick: () => void run(() => closeVault(user, selected)) }, 'Закрыть хранилище'),
        e('button', { disabled: busy || Boolean(v.transfer), onClick: () => form('transfer', selected) }, 'Забыл фразу · перенести'),
        e('button',{class:'danger-button',disabled:busy||Boolean(v.transfer),onClick:()=>{
          const label=names[selected]||'это хранилище';
          if(confirm('Удалить «'+label+'» и все его серверные данные? Хранилище исчезнет на остальных устройствах после синхронизации. Отменить это действие средствами приложения будет невозможно.'))void run(async()=>{
            await flush();showDraft(null);showViewing(null);await deleteVault(user,selected);select('');setScreen('list');setStatus('Хранилище удалено.');
          });
        }},'Удалить хранилище')),
      v.transfer && e('p', { class: 'auth-notice' }, 'Перенос подготовлен. Подключитесь к сети и завершите синхронизацию. Исходник сохранён до подтверждения.'),
      !heads(v).some(r=>notes[r.id]&&statusOf(v,r,notes[r.id])==='active') && !normalizedQuery&&e('div', { class: 'empty-state' }, e('h2', null, 'Пока нет заметок'), e('p', null, 'Создайте первую заметку или верните заметку из архива.')),
      heads(v).some(r=>notes[r.id]&&statusOf(v,r,notes[r.id])==='active')&&!visibleItems.length&&e('div',{class:'empty-state'},e('h2',null,'Ничего не найдено'),e('p',null,'Измените запрос или сбросьте фильтры.'),e('button',{onClick:()=>{setQuery('');setSelectedTags([]);setQuickFilter('all');}},'Сбросить фильтры')),
      [...new Set(heads(v).map(r=>r.objectId))].filter(objectId=>{const versions=heads(v).filter(r=>r.objectId===objectId);return versions.length>1&&versions.some(r=>notes[r.id]&&statusOf(v,r,notes[r.id])==='active');}).map(objectId=>
        e('button',{disabled:busy||Boolean(v.transfer),onClick:()=>{const versions=heads(v).filter(r=>r.objectId===objectId).map(r=>r.id);
          setComparison({objectId,versions,chosen:versions[0]});setScreen('conflict');}},'Сравнить версии: '+(notes[heads(v).find(r=>r.objectId===objectId)!.id]?.title||'Без заголовка'))),
      visibleItems.map(({current,revision:r,note}) => e('div',{class:'note-list-item',key:current.header.id+'.'+r.id},e('button', { class:'note-row'+(note!.pinned?' pinned':''), disabled: Boolean(current.transfer), onClick: () => openRevision(current,r) },
        e('strong', null,note!.pinned?'📌 '+(note!.title||'Без заголовка'):note!.title||'Без заголовка'),normalizedQuery&&e('small',null,names[current.header.id]||'Хранилище'), e('span', { class: 'note-preview' }, note!.text.slice(0, 140)),
        tagChips(current.header.id,note!.tagIds).length>0&&e('span',{class:'tag-list'},tagChips(current.header.id,note!.tagIds).map(tag=>e('span',{class:'tag-chip',style:{'--tag-color':tag.color},key:tag.id},tag.name))),
        note!.checklist?.length&&e('small',null,'Чек-лист: '+note!.checklist.filter(item=>item.done).length+' / '+note!.checklist.length),
        note!.reminder&&e('small',null,'Напоминание: '+new Date(note!.reminder.local+'Z').toLocaleString('ru-RU',{timeZone:'UTC'})),
        e('small',{class:'sync-state '+(r.pending?syncStatus==='syncing'?'syncing':syncStatus==='offline'?'offline':syncStatus==='error'?'error':'local':'synced')},
          r.pending?syncStatus==='syncing'?'Синхронизация…':syncStatus==='offline'?'Нет подключения':syncStatus==='error'?'Ошибка синхронизации':'Сохранено на устройстве':'Синхронизировано'),
        heads(current).filter(x => x.objectId === r.objectId).length > 1 && e('small', null, 'Есть другая версия — обе сохранены')),
        e('button',{class:'row-edit-button',disabled:Boolean(current.transfer),onClick:()=>editRevision(current,r),'aria-label':'Редактировать заметку «'+(note!.title||'Без заголовка')+'»'},'Редактировать'))),
      e('button', { class: 'primary', disabled: busy || Boolean(v.transfer), onClick: () => { if (v.key) showDraft({ vault: selected, object: crypto.randomUUID(), revision: null, title: '', text: '', dirty: false, key: v.key }); } }, '+ Новая заметка'))), feedback);
}
