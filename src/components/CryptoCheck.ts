import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from '../crypto/vault';

const e = h;
interface Result { protect: number; recover: number; encrypt: number; decrypt: number }
export function CryptoCheck() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<Result | null>(null);
  const alive = useRef(true), running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const available = window.isSecureContext && Boolean(window.crypto?.subtle);
  async function run() {
    if (running.current || !available) return;
    running.current = true; setBusy(true); setError(''); setResult(null);
    let plain: Uint8Array | undefined, restored: Uint8Array | undefined;
    try {
      const key = await api.generateVaultKey();
      const keyId = crypto.randomUUID();
      const context = { accountId: crypto.randomUUID(), vaultId: crypto.randomUUID(), keyId,
        objectId: keyId, revisionId: crypto.randomUUID() };
      const phrase = 'Только тестовая фраза проверки скорости 2026';
      let start = performance.now();
      const wrapped = await api.wrapWithPhrase(key, context, phrase);
      const protect = performance.now() - start;
      start = performance.now();
      const opened = await api.unwrapWithPhrase(context, phrase, api.parseEnvelope(api.serializeEnvelope(wrapped)));
      const recover = performance.now() - start;
      plain = crypto.getRandomValues(new Uint8Array(64 * 1024));
      const recordContext = { ...context, objectId: crypto.randomUUID(), revisionId: crypto.randomUUID() };
      start = performance.now();
      const record = await api.encryptRecord(opened, recordContext, plain, new api.MemoryEncryptionBudget());
      const encrypt = performance.now() - start;
      start = performance.now();
      restored = await api.decryptRecord(opened, recordContext, record);
      const decrypt = performance.now() - start;
      if (restored.length !== plain.length || restored.some((byte, index) => byte !== plain![index])) throw new Error('check');
      if (alive.current) setResult({ protect, recover, encrypt, decrypt });
    } catch {
      if (alive.current) setError('Проверка не завершена. Обновите приложение и повторите. Если ошибка сохраняется, сообщите модель устройства и версию браузера.');
    } finally {
      plain?.fill(0); restored?.fill(0); running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return e('section', { class: 'card', 'aria-labelledby': 'crypto-heading' },
    e('h2', { id: 'crypto-heading' }, 'Проверка шифрования'),
    e('p', { class: 'muted' }, 'Проверка на тестовых данных этого устройства. Ваши пароли и записи не используются, результаты не отправляются на сервер.'),
    !available && e('p', { class: 'error' }, 'Web Crypto недоступен. Нужен localhost на компьютере или HTTPS.'),
    e('div', { role: 'status', 'aria-live': 'polite', 'aria-busy': busy },
      busy && e('p', null, 'Проверяем… Это может занять несколько секунд.'),
      result && e('div', null, e('p', null, 'Проверка пройдена. Тестовые данные восстановлены без изменений.'),
        e('dl', null, [
          ['Защита ключа', result.protect], ['Восстановление ключа', result.recover],
          ['Шифрование 64 КиБ', result.encrypt], ['Расшифровка 64 КиБ', result.decrypt],
        ].map(([label, value]) => e('div', { key: String(label) }, e('dt', null, label), e('dd', null, `${Number(value).toFixed(1)} мс`)))))),
    error && e('p', { class: 'error', role: 'alert' }, error),
    e('p', { class: 'hint' }, 'PBKDF2-SHA-256: 600 000 итераций. Параметры предварительные до замера на iPhone после настройки HTTPS. Повторные результаты могут отличаться.'),
    e('div', { class: 'actions' }, e('button', { class: 'primary', disabled: busy || !available, onClick: () => void run() }, busy ? 'Проверяем…' : 'Проверить шифрование')));
}
