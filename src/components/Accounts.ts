import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { accountRequest, authMessage, AuthError } from '../auth';
import { markCollaborationRecoveryRequired, prepareCollaborationPasswordChange } from '../collaboration.ts';
import { isUser, type User, type Account } from '../types/auth';

const e = h;
const rules = '6–128 символов, хотя бы одна цифра, заглавная и строчная буква.';
const uncertain = 'Ответ мог потеряться после сохранения. Проверьте состояние перед повтором. Если сеанс завершён, попробуйте войти с новым паролем.';
const date = (value: number) => new Date(value).toLocaleString('ru-RU');
function isAccount(value: unknown): value is Account {
  return isUser(value) && typeof (value as Account).createdAt === 'number' && typeof (value as Account).credentialVersion === 'number';
}
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let value = '';
  do {
    value = '';
    while (value.length < 16) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      for (const byte of bytes) if (byte < Math.floor(256 / alphabet.length) * alphabet.length && value.length < 16) value += alphabet[byte % alphabet.length];
    }
  } while (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value));
  return value;
}
function PasswordField({ id, label, value, setValue, busy, current = false }: {
  id: string; label: string; value: string; setValue: (value: string) => void; busy: boolean; current?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return e('div', null, e('label', { for: id }, label), e('div', { class: 'password-row' },
    e('input', { id, value, type: visible ? 'text' : 'password', required: true, maxLength: 256,
      autoComplete: current ? 'current-password' : 'new-password', disabled: busy,
      onInput: event => setValue(event.currentTarget.value) }),
    e('button', { type: 'button', class: 'password-toggle', disabled: busy, 'aria-pressed': visible,
      'aria-label': visible ? `Скрыть: ${label}` : `Показать: ${label}`, onClick: () => setVisible(!visible) },
      e('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'aria-hidden': 'true' },
        e('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }), e('circle', { cx: 12, cy: 12, r: 3 }),
        visible && e('path', { d: 'M3 3l18 18' })))));
}
function useHeading() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return ref;
}
function needsAuth(error: unknown) {
  return error instanceof AuthError && ['unauthorized', 'password_change_required', 'admin_required'].includes(error.code);
}
export function PasswordScreen({ user, onDone, onBack, onLogout, onRefresh }: {
  user: User; onDone: (user: User) => void; onBack: () => void; onLogout: () => Promise<void>; onRefresh: () => Promise<void>;
}) {
  const heading = useHeading();
  const [currentPassword, setCurrent] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  const [revokeOthers, setRevoke] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy) return;
    if (password !== repeat) { setError('Пароли не совпадают.'); return; }
    setBusy(true); setError('');
    try {
      const collaboration=await prepareCollaborationPasswordChange(user,currentPassword,password);
      if(collaboration.recoveryRequired&&!user.mustChangePassword)throw Error('Не удалось открыть E2EE-ключ совместной работы. Сначала разблокируйте его системно или текущим паролем.');
      const collaborationRewrap=collaboration.rewrap?{identityVersion:collaboration.rewrap.version,passwordWrapper:collaboration.rewrap.wrapper}:undefined;
      const result = await accountRequest('change-password', { currentPassword, password, repeatPassword: repeat, revokeOthers,...(collaborationRewrap?{collaborationRewrap}:{}) });
      if (!isUser(result.user)) throw new Error('response');
      if(collaboration.recoveryRequired)await markCollaborationRecoveryRequired(user.id);
      setCurrent(''); setPassword(''); setRepeat(''); onDone(result.user);
    } catch (caught) {
      setError(authMessage(caught) + (!(caught instanceof AuthError) || caught.code === 'network' ? ' ' + uncertain : ''));
      if (needsAuth(caught)) await onRefresh();
    } finally { setBusy(false); }
  }
  return e('main', { class: 'auth-screen' },
    e('button', { disabled: busy, onClick: () => user.mustChangePassword ? void onLogout() : onBack() }, user.mustChangePassword ? 'Выйти' : '← Назад'),
    e('h1', { ref: heading, tabIndex: -1, class: 'screen-title' }, 'Изменить пароль'),
    e('p', null, user.login),
    user.mustChangePassword && e('p', { class: 'auth-notice' }, 'Вы вошли с временным паролем. Для продолжения задайте свой пароль.',
      user.temporaryExpires && ` Сделайте это до ${date(user.temporaryExpires)}. Все прежние сеансы будут завершены.`),
    e('form', { onSubmit: submit, 'aria-busy': busy },
      e(PasswordField, { id: 'current-password', label: 'Текущий пароль', value: currentPassword, setValue: setCurrent, busy, current: true }),
      e(PasswordField, { id: 'new-password', label: 'Новый пароль', value: password, setValue: setPassword, busy }),
      e('p', { class: 'hint' }, rules, ' Новый пароль должен отличаться от текущего.'),
      e(PasswordField, { id: 'repeat-password', label: 'Повторите пароль', value: repeat, setValue: setRepeat, busy }),
      !user.mustChangePassword && e('label', { class: 'checkbox-row' }, e('input', { type: 'checkbox', checked: revokeOthers, disabled: busy,
        onChange: event => setRevoke(event.currentTarget.checked) }), 'Выйти на других устройствах'),
      error && e('p', { class: 'error', role: 'alert' }, error),
      e('button', { type: 'submit', class: 'primary auth-submit', disabled: busy }, busy ? 'Сохраняем…' : 'Сохранить пароль')));
}

function IssuePassword({ target, onBack, onRefresh }: { target: Account | null; onBack: () => void; onRefresh: () => Promise<void> }) {
  const heading = useHeading();
  const [login, setLogin] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState<Account | null>(null), [copyStatus, setCopyStatus] = useState('');
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy || result) return;
    if (password !== repeat) { setError('Пароли не совпадают.'); return; }
    setBusy(true); setError('');
    try {
      const data = await accountRequest(target ? 'users/reset' : 'users/create', target
        ? { id: target.id, expectedVersion: target.credentialVersion, password, confirmed }
        : { login, password });
      if (!isAccount(data.user)) throw new Error('response');
      setResult(data.user); setRepeat('');
    } catch (caught) {
      setError(authMessage(caught) + (!(caught instanceof AuthError) || caught.code === 'network' ? ' ' + uncertain : ''));
      if (needsAuth(caught)) await onRefresh();
    } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(password); setCopyStatus('Пароль скопирован.'); }
    catch { setCopyStatus('Не удалось скопировать. Выделите пароль и скопируйте вручную.'); }
  }
  return e('main', { class: 'auth-screen' },
    e('button', { disabled: busy, onClick: onBack }, '← Пользователи'),
    e('h1', { ref: heading, tabIndex: -1, class: 'screen-title' }, result ? 'Пароль выдан' : target ? 'Сбросить пароль' : 'Создать пользователя'),
    result ? e('div', { role: 'status' }, e('p', null, `Логин: ${result.login}`),
      e('p', null, `Временный пароль действует до ${date(result.temporaryExpires!)} (48 часов).`),
      e('label', { for: 'issued-password' }, 'Временный пароль'), e('input', { id: 'issued-password', value: password, readOnly: true, autoComplete: 'off' }),
      e('button', { class: 'auth-submit', onClick: () => void copy() }, 'Скопировать пароль'),
      e('p', null, copyStatus), e('p', { class: 'auth-notice' }, 'Передайте пароль пользователю. После закрытия этого экрана посмотреть его повторно нельзя. При входе потребуется задать свой пароль.'),
      e('button', { class: 'primary auth-submit', onClick: onBack }, 'Готово'))
    : e('form', { onSubmit: submit, 'aria-busy': busy },
      target ? e('p', null, `Пользователь: ${target.login}`) : e('div', null,
        e('label', { for: 'new-login' }, 'Логин'), e('input', { id: 'new-login', value: login, required: true, minLength: 3, maxLength: 32,
          pattern: '[a-zA-Z][a-zA-Z0-9._\\-]{2,31}', autoComplete: 'off', autoCapitalize: 'none', spellcheck: false, disabled: busy,
          onInput: event => setLogin(event.currentTarget.value) }), e('p', { class: 'hint' }, '3–32 символа: латиница, цифры, точка, дефис или _. Начните с буквы.')),
      e(PasswordField, { id: 'temporary-password', label: 'Временный пароль', value: password, setValue: setPassword, busy }),
      e('p', { class: 'hint' }, rules),
      e('button', { type: 'button', class: 'auth-cancel', disabled: busy, onClick: () => { const value = generatePassword(); setPassword(value); setRepeat(value); setError(''); } }, 'Сгенерировать пароль'),
      e(PasswordField, { id: 'repeat-temporary', label: 'Повторите пароль', value: repeat, setValue: setRepeat, busy }),
      e('p', { class: 'hint' }, 'Действует 48 часов с момента выдачи. Вход не продлевает срок.'),
      target && e('label', { class: 'checkbox-row' }, e('input', { type: 'checkbox', required: true, checked: confirmed, disabled: busy,
        onChange: event => setConfirmed(event.currentTarget.checked) }), 'Подтверждаю сброс пароля и завершение всех сеансов пользователя.'),
      error && e('p', { class: 'error', role: 'alert' }, error),
      e('button', { type: 'submit', class: 'primary auth-submit', disabled: busy }, busy ? 'Сохраняем…' : target ? 'Сбросить и выдать пароль' : 'Создать пользователя')));
}

export function UsersScreen({ onBack, onRefresh }: { onBack: () => void; onRefresh: () => Promise<void> }) {
  const heading = useHeading();
  const [users, setUsers] = useState<Account[]>([]), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [editing, setEditing] = useState(false), [target, setTarget] = useState<Account | null>(null);
  const generation = useRef(0);
  async function refresh() {
    const current = ++generation.current; setBusy(true); setError('');
    try {
      const data = await accountRequest('users');
      if (!Array.isArray(data.users) || !data.users.every(isAccount)) throw new Error('response');
      if (generation.current === current) setUsers(data.users);
    } catch (caught) { if (generation.current === current) { setError(authMessage(caught)); if (needsAuth(caught)) await onRefresh(); } }
    finally { if (generation.current === current) setBusy(false); }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []);
  if (editing) return e(IssuePassword, { target, onRefresh, onBack: () => { setEditing(false); setTarget(null); void refresh(); requestAnimationFrame(() => heading.current?.focus()); } });
  return e('main', { class: 'users-screen' },
    e('button', { onClick: onBack }, '← Назад'), e('h1', { ref: heading, tabIndex: -1, class: 'screen-title' }, 'Пользователи'),
    e('div', { class: 'actions' },
      e('button', { class: 'primary', disabled: busy, onClick: () => { setTarget(null); setEditing(true); } }, 'Создать пользователя'),
      e('button', { disabled: busy, onClick: () => void refresh() }, busy ? 'Загружаем…' : 'Обновить список')),
    error && e('p', { class: 'error', role: 'alert' }, error),
    !busy && !error && users.length === 0 && e('p', null, 'Пользователей пока нет.'),
    e('ul', { class: 'user-list', 'aria-busy': busy }, users.map(user => e('li', { key: user.id },
      e('strong', null, user.login), e('p', null, user.role === 'admin' ? 'Администратор' : 'Пользователь'),
      e('p', { class: 'muted' }, `Создан: ${date(user.createdAt)}`),
      e('p', null, user.mustChangePassword ? (user.temporaryExpires! > Date.now()
        ? `Ожидает смены пароля до ${date(user.temporaryExpires!)}` : 'Временный пароль истёк') : 'Пароль установлен'),
      user.role === 'user' && e('button', { disabled: busy || Boolean(error), onClick: () => { setTarget(user); setEditing(true); } }, 'Выдать новый временный пароль')))));
}
