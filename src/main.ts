import { h, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { isHealthResponse, type HealthResponse } from './types/api';
import './style.css';

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
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shell, setShell] = useState('Подготавливаем…');
  const [swError, setSwError] = useState('');
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const secure = window.isSecureContext;
  const cryptoAvailable = secure && Boolean(window.crypto?.subtle);

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

  return e('main', null,
    e('header', null,
      e('a', { class: 'brand', href: '/', 'aria-label': 'Tasks, главная' },
        e('img', { src: '/icon.svg', width: 40, height: 40, alt: '' }), 'Tasks'),
      e('span', { class: 'stage' }, 'Этап 01')),
    e('section', { class: 'intro' },
      e('p', { class: 'eyebrow' }, 'ПЕРВЫЙ ЗАПУСК'),
      e('h1', null, 'Основа приложения'),
      e('p', null, 'Проверим подключение и сохранность данных перед созданием вашего хранилища.')),
    waiting && e('div', { class: 'update', role: 'status' },
      'Доступна новая версия оболочки.',
      e('button', { onClick: applyUpdate }, 'Обновить приложение')),
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
    e('footer', null,
      e('strong', null, 'Дальше — аккаунты и зашифрованные заметки.'),
      e('p', null, 'В этой версии проверяем запуск, API и офлайн-оболочку. Создание заметок и уведомления появятся на следующих шагах.')),
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('Application root is missing');
render(e(App, null), root);
