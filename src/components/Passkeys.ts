import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { authMessage, deletePasskey, listPasskeys, registerPasskey, webAuthnCapability, type PasskeyInfo } from '../auth';
import { readState } from '../storage';
import type { User } from '../types/auth';

const e = h;
function date(value: number | null) { return value ? new Date(value).toLocaleDateString('ru-RU') : 'ещё не использовался'; }

export function PasskeysScreen({ user, onBack }: { user: User; onBack: () => void }) {
  const [items, setItems] = useState<PasskeyInfo[]>([]);
  const [available, setAvailable] = useState(false);
  const [platform, setPlatform] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setBusy(true); setError('');
    try {
      const [capability, passkeys] = await Promise.all([webAuthnCapability(), listPasskeys()]);
      setAvailable(capability.available); setPlatform(capability.platform); setItems(passkeys);
    } catch (caught) { setError(authMessage(caught)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function add() {
    if (!available || busy) return;
    setBusy(true); setError('');
    try {
      const state = await readState(user.id);
      const fallback = platform ? 'Системный ключ доступа' : 'Ключ доступа';
      await registerPasskey((state?.deviceName || fallback).slice(0, 80));
      await load();
    } catch (caught) { setError(authMessage(caught)); setBusy(false); }
  }
  async function remove(item: PasskeyInfo) {
    if (!confirm(`Удалить «${item.displayName}» как способ входа?\n\nЛокальная системная разблокировка хранилищ управляется отдельно и не будет удалена.`)) return;
    setBusy(true); setError('');
    try { await deletePasskey(item.id); await load(); }
    catch (caught) { setError(authMessage(caught)); setBusy(false); }
  }

  return e('main', { class: 'users-screen' },
    e('button', { onClick: onBack }, '← Назад'),
    e('h1', { class: 'screen-title' }, 'Ключи доступа'),
    e('p', { class: 'hint' }, 'Ключ доступа — дополнительный способ входа. Логин и пароль продолжают работать всегда.'),
    !available && e('p', { class: 'auth-notice' }, 'WebAuthn недоступен в этом браузере. Используйте вход по логину и паролю.'),
    available && !platform && e('p', { class: 'auth-notice' }, 'WebAuthn доступен, но браузер не подтверждает наличие встроенного системного аутентификатора. Возможен внешний или синхронизируемый ключ доступа.'),
    error && e('p', { class: 'error', role: 'alert' }, error),
    e('div', { class: 'actions' },
      e('button', { class: 'primary', disabled: busy || !available, onClick: () => void add() }, busy ? 'Подождите…' : 'Добавить ключ доступа'),
      e('button', { disabled: busy, onClick: () => void load() }, 'Обновить')),
    items.length === 0 && !busy && e('p', { class: 'muted' }, 'Ключи доступа для аккаунта пока не зарегистрированы.'),
    e('ul', { class: 'user-list' }, items.map(item => e('li', { key: item.id },
      e('strong', null, item.displayName),
      e('p', null, item.deviceType === 'multiDevice' ? 'Синхронизируемый ключ доступа' : 'Ключ одного аутентификатора'),
      e('p', { class: 'muted' }, 'Добавлен: ', date(item.createdAt), ' · последнее использование: ', date(item.lastUsed)),
      e('button', { class: 'danger-button', disabled: busy, onClick: () => void remove(item) }, 'Удалить из аккаунта')))),
    e('p', { class: 'hint' }, 'Удаление здесь запрещает этим credential вход в Tasks, но не удаляет его из iCloud Keychain, Google Password Manager или Windows и не меняет ключи E2EE-хранилищ.'));
}
