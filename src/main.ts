import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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
import { detachPush, browserUnsubscribe } from './push';
import { profiles, profileActivity, readState, eraseState, exclusive, announce, changes } from './storage';
import { flushDraft, hasUnsaved, synchronize, requireOutboxReview, OutboxReviewRequired, lockAfterBackground } from './planner';
import { session, signOut, authMessage, AuthError } from './auth';
import type { User } from './types/auth';
import { updateReminderZone, type ReminderTarget } from './reminders';

const e = h;

type DefinitionRow = [term: string, value: string, wide?: boolean];
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
  const [page, setPage] = useState<'home' | 'password' | 'users' | 'devices' | 'passkeys' | 'diagnostics' | 'notifications' | 'data'>('home');
  const [localProfiles, setLocalProfiles] = useState<User[]>([]);
  const localMode = useRef(false);
  const [notice, setNotice] = useState('');
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
        if (s && hasUnsaved(s) && !confirm('Есть заметки или стеш, не сохранённые на сервере. Выйти и удалить их вместе с ключами с этого устройства?')) return false;
        await signOut();
        await browserUnsubscribe().catch(() => {}); // Server session revocation already cancels its subscriptions.
        if (user) { await eraseState(user.id); announce('logout:' + user.id); }
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
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(async registration => {
      if (!alive) return;
      if (registration.waiting) setWaiting(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (alive && worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker);
        });
      });
      await navigator.serviceWorker.ready;
      if (alive) setShell('Готова к открытию без сети');
    }).catch(() => {
      if (alive) {
        setShell('Не подготовлена');
        setSwError('Не удалось сохранить оболочку. Перезагрузите страницу при работающем сервере.');
      }
    });
    return () => { alive = false; };
  }, []);

  async function applyUpdate() {
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
        setAuthError('Закройте другие вкладки приложения и повторите обновление. Их черновики должны сохраниться перед закрытием.');
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

  const updateNotice = waiting && e('div', { class: 'update', role: 'status' },
    'Доступна новая версия оболочки.', e('button', { onClick: applyUpdate }, 'Обновить приложение'));
  if (authLoading) return e('main', { class: 'auth-screen', role: 'status' }, 'Проверяем вход…');
  if (!user) return e('div', null,
    updateNotice && e('div', { class: 'auth-status' }, updateNotice),
    authError && e('div', { class: 'auth-status' }, e('p', { class: 'error', role: 'alert' }, authError),
      e('button', { onClick: () => void checkSession() }, 'Повторить проверку входа')),
    localProfiles.length > 0 && e('section', { class: 'auth-status card' }, e('h2', null, 'Данные на этом устройстве'),
      localProfiles.map(profile => e('button', { onClick: () => { localMode.current = true;userRef.current=profile;setUser(profile); } }, 'Открыть локально · ' + profile.login))),
    e(Login, { onLogin: (result) => { authGeneration.current++; localMode.current = false;void requireOutboxReview(result).catch(()=>{}).finally(()=>{userRef.current=result;setUser(result);setAuthError('');void updateReminderZone(result).catch(()=>{});}); } }));

  if (user.mustChangePassword || page === 'password') return e('div', null,
    updateNotice && e('div', { class: 'auth-status' }, updateNotice),
    authError && e('p', { class: 'auth-status error', role: 'alert' }, authError),
    e(PasswordScreen, { key: user.id, user, onBack: () => setPage('home'), onLogout: logout, onRefresh: checkSession,
      onDone: (result) => { authGeneration.current++;void requireOutboxReview(result).catch(()=>{}).finally(()=>{userRef.current=result;setUser(result);setPage('home');setAuthError('');setNotice('Пароль изменён.');}); } }));
  if (page === 'devices') return e(DevicesScreen, { user, onBack: () => setPage('home'), onAuthLost: checkSession });
  if (page === 'passkeys') return e(PasskeysScreen, { user, onBack: () => setPage('home') });
  if (page === 'users' && user.role === 'admin') return e('div', null,
    authError && e('p', { class: 'auth-status error', role: 'alert' }, authError),
    e(UsersScreen, { key: user.id, onBack: () => setPage('home'), onRefresh: checkSession }));

  return e('main', null,
    e('header', null,
      e('a', { class: 'brand', href: '/', 'aria-label': 'Tasks, главная' },
        e('img', { src: '/icon.svg', width: 40, height: 40, alt: '' }), 'Tasks'),
      e('span', { class: 'shell-sync', role: 'status', 'aria-live': 'polite' }, syncing && e('span', { class: 'sync-spinner', 'aria-hidden': 'true' }), syncing ? 'Синхронизация…' : '')),
    connection === 'offline' && e('div', { class: 'offline-banner', role: 'status' }, 'ОФЛАЙН РЕЖИМ · изменения сохраняются на устройстве'),
    e('div', { class: 'account-bar' }, e('p', null, user.login, ' · ', user.role === 'admin' ? 'Администратор' : 'Пользователь'),
      e('button', { disabled: loggingOut, onClick: logout }, loggingOut ? 'Выходим…' : 'Выйти')),
    authError && e('p', { class: 'error', role: 'alert' }, authError),
    notice && e('p', { class: 'auth-notice', role: 'status' }, notice),
    e('nav', { class: 'actions', 'aria-label': 'Управление аккаунтом' },
      e('button', { onClick: () => void flushDraft().then(() => setPage('home')).catch(() => setAuthError('Сохраните черновик')) }, 'Заметки'),
      e('button', { onClick: () => void flushDraft().then(() => setPage('diagnostics')).catch(() => setAuthError('Сохраните черновик')) }, 'Диагностика'),
      e('button', { onClick: () => void flushDraft().then(() => setPage('notifications')).catch(() => setAuthError('Сохраните черновик')) }, 'Уведомления'),
      e('button', { onClick: () => void flushDraft().then(() => setPage('devices')).catch(() => setAuthError('Сохраните черновик')) }, 'Устройства'),
      e('button', { onClick: () => void flushDraft().then(() => setPage('passkeys')).catch(() => setAuthError('Сохраните черновик')) }, 'Ключи доступа'),
      e('button', { onClick: () => void flushDraft().then(() => setPage('data')).catch(() => setAuthError('Сохраните черновик')) }, 'Данные'),
      e('button', { onClick: () => void flushDraft().then(() => setPage('password')).catch(() => setAuthError('Сохраните черновик')) }, 'Изменить пароль'),
      user.role === 'admin' && e('button', { onClick: () => void flushDraft().then(() => setPage('users')).catch(() => setAuthError('Сохраните черновик')) }, 'Пользователи'),
      e('button', { onClick: () => void flushDraft().then(detachPush).then(() => { setUser(null); void profiles().then(setLocalProfiles); }).catch(error => setAuthError(error instanceof Error?error.message:'Сохраните черновик и проверьте сеть')) }, 'Войти снова / другой аккаунт')),
    reminderTarget&&reminderTarget.accountId!==user.id&&e('p',{class:'auth-notice',role:'status'},'Уведомление относится к другому аккаунту. Войдите в нужный аккаунт, чтобы открыть заметку.'),
    page === 'home' && e(Planner, { user, key: user.id, reminderTarget, onReminderHandled:()=>setReminderTarget(undefined),
      onSyncState:(next:'syncing'|'online'|'offline'|'auth'|'error'|'idle')=>{setSyncing(next==='syncing');if(next!=='syncing'&&next!=='idle')setConnection(next);} }),
    page === 'notifications' && e(Notifications, { user, key: user.id }),
    page === 'data' && e(DataTransfer, { user, key: user.id }),
    updateNotice,
    page === 'diagnostics' && e('div', null,
    user.role==='admin'&&e(ServerStorage,{key:user.id}),
    e('section', { class: 'intro' },
      e('p', { class: 'eyebrow' }, 'ПЕРВЫЙ ЗАПУСК'),
      e('h1', null, 'Основа приложения'),
      e('p', null, 'Проверим подключение и сохранность данных перед созданием вашего хранилища.')),
    e('section', { class: 'card', 'aria-labelledby': 'server-heading' },
      e('div', { class: 'card-heading' },
        e('h2', { id: 'server-heading' }, 'Сервер и база данных'),
        e('span', { class: `badge ${health ? 'good' : ''}` }, busy ? 'Проверяем' : health ? 'Работают' : 'Нет связи')),
      e('div', { 'aria-live': 'polite' },
        error && e('p', { class: 'error' }, error),
        health ? e(DefinitionList, { rows: serverRows }) : e('p', { class: 'muted' }, 'Сведения появятся после успешного ответа сервера.')),
      e('p', { class: 'hint' }, 'После перезапуска контейнера идентификатор должен остаться прежним, а число запусков — увеличиться.'),
      e('div', { class: 'actions' },
        e('button', { class: 'primary', disabled: busy, onClick: checkServer }, busy ? 'Проверяем…' : 'Проверить ещё раз'),
        e('a', { href: '/api/health', target: '_blank', rel: 'noreferrer' }, 'Открыть ответ API ↗'))),
    e('section', { class: 'card', 'aria-labelledby': 'device-heading' },
      e('h2', { id: 'device-heading' }, 'На этом устройстве'),
      e(DefinitionList, { rows: deviceRows }),
      swError && e('p', { class: 'error' }, swError),
      e('p', { class: 'hint' }, 'Когда оболочка готова, остановите сервер и перезагрузите страницу. Она должна открыться с сообщением об отсутствии связи.')),
    e(CryptoCheck, { key: user.id }),
    e('footer', null,
      e('strong', null, 'Криптографический модуль готов к проверке на тестовых данных.'),
      e('p', null, 'Хранилища доступны в разделе «Заметки», тестовый push — в разделе «Уведомления».')),
    ));
}

const root = document.getElementById('app');
if (!root) throw new Error('Application root is missing');
render(e(App, null), root);
