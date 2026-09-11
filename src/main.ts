import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { isHealthResponse, type HealthResponse } from './types/api';
import './style.css';
import { Login } from './components/Login';
import { PasswordScreen, UsersScreen } from './components/Accounts';
import { CryptoCheck } from './components/CryptoCheck';
import { session, signOut, authMessage } from './auth';
import type { User } from './types/auth';

const e = h;

type DefinitionRow = [term: string, value: string, wide?: boolean];

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
  const [page, setPage] = useState<'home' | 'password' | 'users'>('home');
  const [notice, setNotice] = useState('');
  useEffect(() => { setPage('home'); setNotice(''); }, [user?.id]);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const authGeneration = useRef(0);
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
      if (generation === authGeneration.current) { setUser(result); setAuthError(''); }
    } catch (caught) {
      if (generation === authGeneration.current) setAuthError(authMessage(caught));
    } finally { if (generation === authGeneration.current) setAuthLoading(false); }
  }
  useEffect(() => {
    void checkSession();
    const wake = () => { if (document.visibilityState === 'visible') void checkSession(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => { authGeneration.current++; document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, []);

  async function logout() {
    setLoggingOut(true); authGeneration.current++;
    try { await signOut(); authGeneration.current++; setUser(null); setAuthError(''); }
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

  function applyUpdate() {
    if (!waiting) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
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
    e(Login, { onLogin: (result) => { authGeneration.current++; setUser(result); setAuthError(''); } }));

  if (user.mustChangePassword || page === 'password') return e('div', null,
    updateNotice && e('div', { class: 'auth-status' }, updateNotice),
    authError && e('p', { class: 'auth-status error', role: 'alert' }, authError),
    e(PasswordScreen, { key: user.id, user, onBack: () => setPage('home'), onLogout: logout, onRefresh: checkSession,
      onDone: (result) => { authGeneration.current++; setUser(result); setPage('home'); setAuthError(''); setNotice('Пароль изменён.'); } }));
  if (page === 'users' && user.role === 'admin') return e('div', null,
    authError && e('p', { class: 'auth-status error', role: 'alert' }, authError),
    e(UsersScreen, { key: user.id, onBack: () => setPage('home'), onRefresh: checkSession }));

  return e('main', null,
    e('header', null,
      e('a', { class: 'brand', href: '/', 'aria-label': 'Tasks, главная' },
        e('img', { src: '/icon.svg', width: 40, height: 40, alt: '' }), 'Tasks'),
      e('span', { class: 'stage' }, 'Этап 05')),
    e('div', { class: 'account-bar' }, e('p', null, user.login, ' · ', user.role === 'admin' ? 'Администратор' : 'Пользователь'),
      e('button', { disabled: loggingOut, onClick: logout }, loggingOut ? 'Выходим…' : 'Выйти')),
    authError && e('p', { class: 'error', role: 'alert' }, authError),
    notice && e('p', { class: 'auth-notice', role: 'status' }, notice),
    e('nav', { class: 'actions', 'aria-label': 'Управление аккаунтом' },
      e('button', { onClick: () => setPage('password') }, 'Изменить пароль'),
      user.role === 'admin' && e('button', { onClick: () => setPage('users') }, 'Пользователи')),
    e('section', { class: 'intro' },
      e('p', { class: 'eyebrow' }, 'ПЕРВЫЙ ЗАПУСК'),
      e('h1', null, 'Основа приложения'),
      e('p', null, 'Проверим подключение и сохранность данных перед созданием вашего хранилища.')),
    updateNotice,
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
      e('p', null, 'Хранилища, заметки и уведомления появятся на следующих этапах.')),
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('Application root is missing');
render(e(App, null), root);
