import { h, render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { isHealthResponse, type HealthResponse } from './types/api';
import './style.css';
import { Login } from './components/Login';
import { PasswordScreen, UsersScreen } from './components/Accounts';
import { DevicesScreen } from './components/Devices';
import { PasskeysScreen } from './components/Passkeys';
import { CryptoCheck } from './components/CryptoCheck';
import { Planner } from './components/Planner';
import { Notifications } from './components/Notifications';
import { ServerStorage } from './components/ServerStorage';
import { DataTransfer } from './components/DataTransfer';
import { CollaborationScreen } from './components/Collaboration';
import { ProjectsScreen } from './components/Projects';
import { AppShell,type ShellSection,type ShellVaultContext } from './components/AppShell';
import { AboutSettings,AccountOverview,AppearanceSettings,SettingsHub,type SettingsPage } from './components/Settings';
import { Onboarding } from './components/Onboarding';
import { PageHeader,StatusDot,UiIcon } from './components/ui.ts';
import { detachPush, browserUnsubscribe } from './push';
import { profiles, profileActivity, readState, eraseState, exclusive, announce, changes } from './storage';
import { flushDraft, hasUnsaved, synchronize, requireOutboxReview, OutboxReviewRequired, lockAfterBackground } from './planner';
import { session, signOut, authMessage, AuthError } from './auth';
import type { User } from './types/auth';
import { updateReminderZone, type ReminderTarget } from './reminders';
import { clearCollaborationLocalRuntime } from './collaboration.ts';
import { applyTheme } from './preferences.ts';
import { AppDialogHost,appConfirm } from './components/AppDialog.ts';

const e = h;
const OcrTestScreen = lazy(() =>
  import('./components/OcrTest.ts').then((module) => ({ default: module.OcrTestScreen })),
);
applyTheme();

type DefinitionRow = [term: string, value: string, wide?: boolean];
type UpdatePhase = 'available' | 'downloading' | 'ready' | 'error';
function initialReminderTarget():ReminderTarget|undefined{
  const match=location.hash.match(/^#reminder=([0-9a-f.-]+)$/),parts=match?.[1].split('.');
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if(match)history.replaceState(null,'',location.pathname+location.search);
  return (parts?.length===4||parts?.length===5)&&parts.every(value=>uuid.test(value))
    ?{accountId:parts[0],vaultId:parts[1],objectId:parts[2],configId:parts[3],...(parts[4]?{occurrenceId:parts[4]}:{})}:undefined;
}
function connectionFailure(caught:unknown):'offline'|'auth'|'error'{
  if(caught instanceof TypeError||caught instanceof AuthError&&caught.code==='network'||caught instanceof Error&&caught.name==='TimeoutError'
    ||Boolean(caught&&typeof caught==='object'&&'code'in caught&&caught.code==='network'))return'offline';
  if(caught instanceof AuthError&&caught.code==='unauthorized'||caught instanceof Error&&caught.message.startsWith('Для синхронизации войдите'))return'auth';
  return'error';
}

function DefinitionList({ rows }: { rows: DefinitionRow[] }) {
  return e('dl', null, rows.map(([term, value, wide = false]) =>
    e('div', { class: wide ? 'wide' : '', key: term },
      e('dt', null, term),
      e('dd', { class: term === 'Идентификатор установки' ? 'mono' : '' }, value),
    )
  ));
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const userRef = useRef<User | null>(null); userRef.current = user;
  const [page, setPage] = useState<'home'|'today'|'projects'|'settings'|'account'|'appearance'|'password'|'users'|'ocr-test'|'devices'|'passkeys'|'diagnostics'|'notifications'|'data'|'collaboration'|'archive'|'trash'|'about'>('home');
  const previousWorkspacePage = useRef<'home'|'today'|'projects'>('home');
  const pageHistory=useRef<Array<typeof page>>([]),gestureBackInProgress=useRef(false);
  const logoNavigationGuard = useRef<(() => Promise<boolean>) | null>(null);
  const [notesHomeVersion,setNotesHomeVersion]=useState(0);
  const registerLogoNavigationGuard=useCallback((guard:(()=>Promise<boolean>)|null)=>{logoNavigationGuard.current=guard;},[]);
  const [localProfiles, setLocalProfiles] = useState<User[]>([]);
  const localMode = useRef(false);
  const [notice, setNotice] = useState('');
  const [onboarding,setOnboarding]=useState(()=>{try{return localStorage.getItem('tasks-onboarding-v1')!=='done';}catch{return false;}});
  function finishOnboarding(){try{localStorage.setItem('tasks-onboarding-v1','done');}catch{}setOnboarding(false);}
  const [reminderTarget,setReminderTarget]=useState<ReminderTarget|undefined>(initialReminderTarget);
  useEffect(()=>{const read=()=>{const target=initialReminderTarget();setReminderTarget(target);if(target)setPage('home');};window.addEventListener('hashchange',read);return()=>window.removeEventListener('hashchange',read);},[]);
  useEffect(() => { setPage('home'); setNotice(''); }, [user?.id]);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [connection, setConnection] = useState<'checking'|'online'|'offline'|'auth'|'error'>('checking');
  const [syncing, setSyncing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const authGeneration = useRef(0);
  const backgroundAt = useRef<number | null>(null);
  const backgroundFlush = useRef<Promise<void> | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shell, setShell] = useState('Подготавливаем…');
  const [swError, setSwError] = useState('');
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('available');
  const [updateProgress, setUpdateProgress] = useState(0);
  const [vaultContext,setVaultContext]=useState<ShellVaultContext|null>(null);
  const secure = window.isSecureContext;
  const cryptoAvailable = secure && Boolean(window.crypto?.subtle);

  async function checkSession() {
    const generation = ++authGeneration.current;
    try {
      const result = await session();
      if (generation === authGeneration.current) {
        const active = userRef.current;
        if (result) {
          if (!active || result.id === active.id) {
            if (result.mustChangePassword && active && !active.mustChangePassword) await flushDraft();
            localMode.current = false;userRef.current=result;setUser(result);void updateReminderZone(result).catch(()=>{});
          }
        }
        if(active&&(!result||result.id!==active.id))await requireOutboxReview(active);
        setAuthError(active && (!result || result.id !== active.id) ? 'Для синхронизации войдите в этот аккаунт. Локальные данные доступны.' : '');
        setConnection(result && (!active || result.id === active.id) ? 'online' : 'auth');
        setLocalProfiles(await profiles());
      }
    } catch (caught) {
      if (generation === authGeneration.current) {
        const failure=connectionFailure(caught);if(failure==='auth'&&userRef.current)await requireOutboxReview(userRef.current);
        setAuthError(failure==='offline'&&userRef.current?'':authMessage(caught));setConnection(failure);
        setLocalProfiles(await profiles().catch(() => []));
      }
    } finally { if (generation === authGeneration.current) setAuthLoading(false); }
  }
  useEffect(() => {
    void profileActivity().then(local => {
      setLocalProfiles(local.map(item=>item.user));
      const recent=local[0];
      if (recent && (local.length===1||recent.lastOpenedAt) && !userRef.current) { userRef.current=recent.user;setUser(recent.user); }
    }).catch(() => {}).finally(() => { setAuthLoading(false); void checkSession(); });
    const wake = () => { if (document.visibilityState === 'visible') void checkSession(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => { authGeneration.current++; document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, []);
  useEffect(() => {
    if (!user || page === 'home' || user.mustChangePassword) return;
    let active=true,running=false;
    const tick=async()=>{
      if(running)return;running=true;setSyncing(true);
      try { await synchronize(user);if(active)setConnection('online'); }
      catch(caught){if(active)setConnection(caught instanceof OutboxReviewRequired?'online':connectionFailure(caught));}
      finally{running=false;if(active)setSyncing(false);}
    };
    const wake=()=>{if(document.visibilityState==='visible')void tick();};
    void tick();window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
    const interval=setInterval(wake,30000);
    return()=>{active=false;clearInterval(interval);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
  },[user?.id,user?.mustChangePassword,page]);
  useEffect(() => {
    const receive = (event: Event) => {
      const message = event instanceof MessageEvent ? event.data : (event as CustomEvent).detail;
      if (userRef.current && message === 'logout:' + userRef.current.id) {
        authGeneration.current++; setUser(null); void profiles().then(setLocalProfiles);
      }
    };
    changes?.addEventListener('message', receive); window.addEventListener('tasks-data', receive);
    return () => { changes?.removeEventListener('message', receive); window.removeEventListener('tasks-data', receive); };
  }, []);

  async function logout() {
    setLoggingOut(true); authGeneration.current++;
    try {
      await flushDraft();
      if (user) {
        try { await synchronize(user); } catch { /* Ask explicitly before discarding local-only data. */ }
      }
      const completed = await exclusive(async () => {
        const s = user && await readState(user.id);
        if (s && hasUnsaved(s) && !await appConfirm('Есть заметки или отложенные изменения, не сохранённые на сервере. Выйти и удалить их вместе с ключами с этого устройства?',{title:'Выйти из аккаунта?',confirmLabel:'Выйти',danger:true})) return false;
        await signOut();
        await browserUnsubscribe().catch(() => {}); // Server session revocation already cancels its subscriptions.
        if (user) { clearCollaborationLocalRuntime(user.id);await eraseState(user.id); announce('logout:' + user.id); }
        return true;
      });
      if (!completed) return;
      authGeneration.current++; localMode.current = false; setUser(null); setLocalProfiles(await profiles()); setAuthError('');
    }
    catch (caught) { setAuthError(authMessage(caught)); }
    finally { setLoggingOut(false); }
  }

  async function checkServer() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result: unknown = await response.json();
      if (!isHealthResponse(result)) {
        throw new Error('Неожиданный ответ сервера');
      }
      setHealth(result);
    } catch (caught) {
      setHealth(null);
      setError(caught instanceof Error && caught.message.startsWith('HTTP')
        ? caught.message
        : 'Сервер недоступен. Проверьте контейнер или SSH-туннель.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void checkServer();
    if (!secure || !('serviceWorker' in navigator)) {
      setShell('Недоступна');
      setSwError('Откройте приложение на localhost или по HTTPS.');
      return undefined;
    }
    let alive = true;
    let updateTimer: number | undefined;
    let checkForUpdate: (() => void) | undefined;
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(async registration => {
      if (!alive) return;
      const offerUpdate = (worker: ServiceWorker) => {
        setWaiting(worker);
        setUpdatePhase('available');
        setUpdateProgress(0);
      };
      if (registration.waiting) offerUpdate(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (alive && worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
      checkForUpdate = () => {
        if (document.visibilityState === 'visible' && navigator.onLine) void registration.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', checkForUpdate);
      window.addEventListener('online', checkForUpdate);
      updateTimer = window.setInterval(checkForUpdate, 15 * 60 * 1000);
      await navigator.serviceWorker.ready;
      if (alive) setShell('Готова к открытию без сети');
    }).catch(() => {
      if (alive) {
        setShell('Не подготовлена');
        setSwError('Не удалось сохранить оболочку. Перезагрузите страницу при работающем сервере.');
      }
    });
    return () => {
      alive = false;
      if (checkForUpdate) {
        document.removeEventListener('visibilitychange', checkForUpdate);
        window.removeEventListener('online', checkForUpdate);
      }
      if (updateTimer !== undefined) window.clearInterval(updateTimer);
    };
  }, []);

  function downloadUpdate() {
    if (!waiting || updatePhase === 'downloading') return;
    setUpdatePhase('downloading');
    setUpdateProgress(0);
    setAuthError('');
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      if (data?.type === 'UPDATE_PROGRESS') {
        const total = Number(data.total);
        const loaded = Number(data.loaded);
        setUpdateProgress(total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0);
      } else if (data?.type === 'UPDATE_READY') {
        setUpdateProgress(1);
        setUpdatePhase('ready');
        channel.port1.close();
      } else if (data?.type === 'UPDATE_ERROR') {
        setUpdatePhase('error');
        setAuthError('Не удалось загрузить обновление. Проверьте подключение и повторите попытку.');
        channel.port1.close();
      }
    };
    try {
      waiting.postMessage({ type: 'DOWNLOAD_UPDATE' }, [channel.port2]);
    } catch {
      channel.port1.close();
      setUpdatePhase('error');
      setAuthError('Не удалось начать загрузку обновления. Повторите попытку.');
    }
  }

  async function restartAfterUpdate() {
    if (!waiting) return;
    try { await flushDraft(); } catch { setAuthError('Сначала сохраните черновик. Обновление отложено.'); return; }
    const reload = async () => {
      const element = document.getElementById('app');
      if (element) element.inert = true;
      try { await flushDraft(); location.reload(); }
      catch { if (element) element.inert = false; setAuthError('Не удалось сохранить черновик. Перезагрузка отложена.'); }
    };
    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      channel.port1.close();
      if (!data.ok) {
        navigator.serviceWorker.removeEventListener('controllerchange', reload);
        if (data.reason === 'not_ready') {
          setUpdatePhase('available');
          setUpdateProgress(0);
          setAuthError('Файлы обновления ещё не загружены. Запустите загрузку повторно.');
        } else {
          setAuthError('Закройте другие вкладки приложения и повторите обновление. Их черновики должны сохраниться перед закрытием.');
        }
      }
    };
    waiting.postMessage({ type: 'SKIP_WAITING' }, [channel.port2]);
  }

  const serverRows: DefinitionRow[] = health ? [
    ['Версия приложения', health.version],
    ['Запусков сервера', String(health.bootCount)],
    ['Время сервера', new Date(health.serverTime).toLocaleString('ru-RU')],
    ['Идентификатор установки', health.installationId, true],
  ] : [];
  const deviceRows: DefinitionRow[] = [
    ['Безопасный контекст', secure ? 'Доступен' : 'Недоступен'],
    ['Web Crypto', cryptoAvailable ? 'Доступен' : 'Недоступен'],
    ['Оболочка PWA', shell],
    ['Часовой пояс', Intl.DateTimeFormat().resolvedOptions().timeZone],
  ];

  const updateButtonLabel = updatePhase === 'ready' ? 'Перезапустить приложение'
    : updatePhase === 'downloading' ? `Загрузка ${Math.round(updateProgress * 100)}%`
    : updatePhase === 'error' ? 'Повторить загрузку'
    : 'Обновить приложение';
  const updateNotice = waiting && e('div', { class: 'update', role: 'status' },
    e('span', null, updatePhase === 'ready' ? 'Новая версия загружена и готова к запуску.'
      : updatePhase === 'downloading' ? 'Загружаем новую версию приложения…'
      : updatePhase === 'error' ? 'Загрузка обновления прервана.'
      : 'Доступна новая версия приложения.'),
    e('button', {
      class: `update-action update-action-${updatePhase}`,
      disabled: updatePhase === 'downloading',
      style: `--update-progress:${Math.round(updateProgress * 100)}%`,
      onClick: updatePhase === 'ready' ? restartAfterUpdate : downloadUpdate,
    }, updateButtonLabel));
  if (authLoading) return e('main', { class: 'auth-screen', role: 'status' }, 'Проверяем вход…');
  if (!user) return e('div', {class:'logged-out-shell'},
    updateNotice && e('div', { class: 'auth-status' }, updateNotice),
    authError && e('div', { class: 'auth-status' }, e('p', { class: 'error', role: 'alert' }, authError),
      e('button', { onClick: () => void checkSession() }, 'Повторить проверку входа')),
    onboarding&&localProfiles.length===0
      ?e(Onboarding,{onDone:finishOnboarding})
      :e('div',null,
        localProfiles.length > 0 && e('section', { class: 'auth-status card local-profiles' }, e('h2', null, 'Данные на этом устройстве'),
          localProfiles.map(profile => e('button', { onClick: () => { localMode.current = true;userRef.current=profile;setUser(profile); } }, 'Открыть локально · ' + profile.login))),
        e(Login, { onLogin: (result) => { finishOnboarding();authGeneration.current++; localMode.current = false;void requireOutboxReview(result).catch(()=>{}).finally(()=>{userRef.current=result;setUser(result);setAuthError('');void updateReminderZone(result).catch(()=>{});}); } })));

  if (user.mustChangePassword) return e('div', null,
    updateNotice && e('div', { class: 'auth-status' }, updateNotice),
    authError && e('p', { class: 'auth-status error', role: 'alert' }, authError),
    e(PasswordScreen, { key: user.id, user, onBack: () => setPage('home'), onLogout: logout, onRefresh: checkSession,
      onDone: (result) => { authGeneration.current++;void requireOutboxReview(result).catch(()=>{}).finally(()=>{userRef.current=result;setUser(result);setPage('home');setAuthError('');setNotice('Пароль изменён.');}); } }));
  async function navigate(next:typeof page){
    try{await flushDraft();if(next!==page&&!gestureBackInProgress.current){pageHistory.current.push(page);if(pageHistory.current.length>15)pageHistory.current.shift();}gestureBackInProgress.current=false;setAuthError('');setPage(next);}
    catch{setAuthError('Сначала сохраните черновик.');}
  }
  async function navigateHomeFromLogo(){
    const guard=logoNavigationGuard.current;
    if(guard&&!await guard())return;
    if(page!=='home'){pageHistory.current.push(page);if(pageHistory.current.length>15)pageHistory.current.shift();}
    setAuthError('');
    setPage('home');
    setNotesHomeVersion(value=>value+1);
  }
  const navigateBackFromGesture=useCallback(()=>{
    const buttons=[...document.querySelectorAll<HTMLButtonElement>('.shell-content .ui-back')];
    const back=buttons.find(button=>!button.disabled&&button.offsetParent!==null);
    if(back){gestureBackInProgress.current=true;back.click();window.setTimeout(()=>{gestureBackInProgress.current=false;},1200);return;}
    let previous=pageHistory.current.pop();
    while(previous===page)previous=pageHistory.current.pop();
    if(previous){setAuthError('');setPage(previous);}
    else if(page!=='home'){setAuthError('');setPage('home');}
  },[page]);
  const shellActive:ShellSection=page==='home'?'notes':page==='today'?'today':page==='projects'?'projects':'settings';
  const navigateSection=(section:ShellSection)=>{
    if(section==='settings'){
      if(shellActive==='settings')void navigate(previousWorkspacePage.current);
      else{
        previousWorkspacePage.current=page as 'home'|'today'|'projects';
        void navigate('settings');
      }
      return;
    }
    const next=section==='notes'?'home':section==='today'?'today':section==='projects'?'projects':'settings';
    void navigate(next);
  };
  const openSetting=(next:SettingsPage)=>void navigate(next);
  const syncCallback=(next:'syncing'|'online'|'offline'|'auth'|'error'|'idle')=>{
    setSyncing(next==='syncing');if(next!=='syncing'&&next!=='idle')setConnection(next);
  };
  const diagnostics=e('main',{class:'settings-screen diagnostics-screen'},
    e(PageHeader,{eyebrow:'Настройки',title:'Диагностика',description:'Состояние сервера, этого устройства, хранилища и локальной криптографии.',
      back:()=>void navigate('settings'),
      actions:e('button',{class:'secondary-button',disabled:busy,onClick:checkServer},e(UiIcon,{name:'sync',size:17}),busy?'Обновляем…':'Обновить')}),
    e('div',{class:'diagnostics-grid'},
      e('section',{class:'diagnostic-panel settings-panel server-health-panel','aria-labelledby':'server-heading'},
        e('div',{class:'diagnostic-panel-heading'},
          e('span',{class:'diagnostic-icon'},e(UiIcon,{name:'diagnostics',size:21})),
          e('div',null,e('h2',{id:'server-heading'},'Сервер и база данных'),e('p',null,'Health endpoint и runtime приложения.')),
          e('span',{class:'status-pill '+(health?'success':'neutral')},e(StatusDot,{tone:health?'success':error?'danger':'neutral'}),busy?'Проверяем':health?'Работают':'Нет связи')),
        error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),e('span',null,error)),
        health?e('div',{class:'diagnostic-summary'},
          e('div',{class:'diagnostic-primary-metric'},e('span',null,'Версия'),e('strong',null,health.version)),
          e('div',{class:'diagnostic-primary-metric'},e('span',null,'База данных'),e('strong',null,health.database==='ok'?'Работает':health.database)),
          e('details',{class:'technical-details'},e('summary',null,'Технические сведения'),e(DefinitionList,{rows:serverRows})))
          :e('div',{class:'diagnostic-empty'},e(UiIcon,{name:'wifi-off',size:23}),e('span',null,'Сведения появятся после успешного ответа сервера.')),
        e('div',{class:'diagnostic-actions'},e('a',{class:'tertiary-link',href:'/api/health',target:'_blank',rel:'noreferrer'},'Открыть ответ API ↗'))),
      e('section',{class:'diagnostic-panel settings-panel device-health-panel','aria-labelledby':'device-heading'},
        e('div',{class:'diagnostic-panel-heading'},
          e('span',{class:'diagnostic-icon'},e(UiIcon,{name:'devices',size:21})),
          e('div',null,e('h2',{id:'device-heading'},'Это устройство'),e('p',null,'Браузерные возможности, PWA и локальный runtime.')),
          e('span',{class:'status-pill '+(secure&&cryptoAvailable?'success':'neutral')},e(StatusDot,{tone:secure&&cryptoAvailable?'success':'warning'}),secure&&cryptoAvailable?'Готово':'Ограничено')),
        e('div',{class:'diagnostic-device-grid'},
          e('div',null,e('span',null,'Безопасный контекст'),e('strong',null,secure?'Да':'Нет')),
          e('div',null,e('span',null,'Web Crypto'),e('strong',null,cryptoAvailable?'Доступен':'Недоступен')),
          e('div',null,e('span',null,'PWA'),e('strong',null,shell)),
          e('div',null,e('span',null,'Часовой пояс'),e('strong',null,Intl.DateTimeFormat().resolvedOptions().timeZone))),
        swError&&e('div',{class:'inline-alert warning'},e(UiIcon,{name:'warning',size:18}),e('span',null,swError)),
        e('details',{class:'technical-details'},e('summary',null,'Показать списком'),e(DefinitionList,{rows:deviceRows}))),
      user.role==='admin'&&e(ServerStorage,{key:user.id}),
      e(CryptoCheck,{key:user.id})));
  let content;
  if(page==='home'||page==='today'||page==='archive'||page==='trash')content=e(Planner,{user,key:user.id+':'+page+':'+(page==='home'?notesHomeVersion:0),section:page==='today'?'today':'notes',initialScreen:page==='archive'?'archive':page==='trash'?'trash':'list',reminderTarget,onReminderHandled:()=>setReminderTarget(undefined),onSyncState:syncCallback,onOpenProjects:()=>void navigate('projects'),onVaultContextChange:setVaultContext,onNavigationGuardChange:registerLogoNavigationGuard});
  else if(page==='projects')content=e(ProjectsScreen,{user,key:user.id,onBack:()=>void navigate('home'),onVaultContextChange:setVaultContext});
  else if(page==='settings')content=e(SettingsHub,{user,onOpen:openSetting,onLogout:logout,loggingOut});
  else if(page==='account')content=e(AccountOverview,{user,onOpen:openSetting,onLogout:logout,loggingOut,onBack:()=>void navigate('settings')});
  else if(page==='appearance')content=e(AppearanceSettings,{onBack:()=>void navigate('settings')});
  else if(page==='about')content=e(AboutSettings,{onBack:()=>void navigate('settings')});
  else if(page==='notifications')content=e(Notifications,{user,key:user.id,onBack:()=>void navigate('settings')});
  else if(page==='devices')content=e(DevicesScreen,{user,onBack:()=>void navigate('settings'),onAuthLost:checkSession});
  else if(page==='passkeys')content=e(PasskeysScreen,{user,onBack:()=>void navigate('settings')});
  else if(page==='collaboration')content=e(CollaborationScreen,{user,key:user.id,onBack:()=>void navigate('settings')});
  else if(page==='data')content=e(DataTransfer,{user,key:user.id,onBack:()=>void navigate('settings')});
  else if(page==='password')content=e(PasswordScreen,{key:user.id,user,onBack:()=>void navigate('settings'),onLogout:logout,onRefresh:checkSession,
    onDone:(result:User)=>{authGeneration.current++;void requireOutboxReview(result).catch(()=>{}).finally(()=>{userRef.current=result;setUser(result);setPage('settings');setAuthError('');setNotice('Пароль изменён.');});}});
  else if(page==='users'&&user.role==='admin')content=e(UsersScreen,{key:user.id,onBack:()=>void navigate('settings'),onRefresh:checkSession});
  else if(page==='ocr-test'&&user.role==='admin')content=e(Suspense,{fallback:e('div',{class:'settings-detail'},'Загрузка OCR…')},e(OcrTestScreen,{onBack:()=>void navigate('settings')}));
  else if(page==='diagnostics')content=diagnostics;
  else content=e(SettingsHub,{user,onOpen:openSetting,onLogout:logout,loggingOut});
  const shellNotice=reminderTarget&&reminderTarget.accountId!==user.id?'Уведомление относится к другому аккаунту. Войдите в нужный аккаунт, чтобы открыть заметку.':notice;
  return e(AppShell,{user,active:shellActive,onNavigate:navigateSection,onHome:()=>void navigateHomeFromLogo(),onBackGesture:navigateBackFromGesture,syncing,connection,loggingOut,onLogout:logout,
    notice:shellNotice,error:authError,updateNotice,vaultContext},content);
}

const root = document.getElementById('app');
if (!root) throw new Error('Application root is missing');
render(e('div',{class:'app-root'},e(App, null),e(AppDialogHost,null)), root);
