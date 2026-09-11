import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { authMessage, setupRequired, signIn, AuthError } from '../auth';
import type { User } from '../types/auth';

const e = h;
export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const repeatField = useRef<HTMLInputElement>(null);
  const loginField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (confirming) repeatField.current?.focus(); }, [confirming]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!confirming && await setupRequired()) { setConfirming(true); return; }
      if (confirming && repeat !== password) { setError('Пароли не совпадают. Повторите введённый пароль.'); return; }
      const user = await signIn(login, password, confirming ? repeat : undefined);
      setPassword(''); setRepeat(''); setVisible(false);
      onLogin(user);
    } catch (caught) {
      setError(authMessage(caught));
      if (caught instanceof AuthError && caught.code === 'setup_complete') {
        setConfirming(false); setPassword(''); setRepeat('');
      }
    } finally { setBusy(false); }
  }
  return e('main', { class: 'auth-screen' },
    e('a', { class: 'brand', href: '/' }, e('img', { src: '/icon.svg', width: 40, height: 40, alt: '' }), 'Tasks'),
    e('h1', null, confirming ? 'Первый администратор' : 'Вход'),
    confirming && e('p', { class: 'auth-notice', role: 'status' }, 'Аккаунтов ещё нет. Вы создаёте учётную запись администратора. Для подтверждения повторите пароль, введённый при входе.'),
    e('form', { onSubmit: submit, 'aria-busy': busy },
      e('label', { for: 'login' }, 'Логин'),
      e('input', { ref: loginField, id: 'login', value: login, required: true, minLength: 3, maxLength: 32,
        pattern: '[a-zA-Z][a-zA-Z0-9._\\-]{2,31}', autoComplete: 'username', autoCapitalize: 'none', spellcheck: false,
        disabled: busy || confirming, onInput: (event) => setLogin(event.currentTarget.value), placeholder: 'Введите логин' }),
      e('p', { class: 'hint' }, '3–32 символа: латиница, цифры, точка, дефис или _. Начните с буквы.'),
      e('label', { for: 'password' }, 'Пароль'),
      e('div', { class: 'password-row' },
        e('input', { id: 'password', type: visible ? 'text' : 'password', value: password, required: true, maxLength: 256,
          autoComplete: confirming ? 'new-password' : 'current-password', disabled: busy || confirming,
          onInput: (event) => setPassword(event.currentTarget.value), placeholder: 'Введите пароль' }),
        e('button', { type: 'button', class: 'password-toggle', 'aria-label': visible ? 'Скрыть пароль' : 'Показать пароль',
          'aria-pressed': visible, onClick: () => setVisible(!visible) },
          e('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            'stroke-width': 1.8, 'aria-hidden': 'true' },
            e('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }),
            e('circle', { cx: 12, cy: 12, r: 3 }),
            visible && e('path', { d: 'M3 3l18 18' })))),
      confirming && e('div', null,
        e('label', { for: 'repeat-password' }, 'Повторите пароль'),
        e('input', { ref: repeatField, id: 'repeat-password', type: visible ? 'text' : 'password', value: repeat,
          required: true, maxLength: 256, autoComplete: 'new-password', disabled: busy,
          onInput: (event) => setRepeat(event.currentTarget.value) }),
        e('p', { class: 'hint' }, '6–128 символов, хотя бы одна цифра, одна заглавная и одна строчная буква.')),
      error && e('p', { class: 'error', role: 'alert' }, error),
      e('button', { class: 'primary auth-submit', type: 'submit', disabled: busy }, busy ? 'Подождите…' : confirming ? 'Создать администратора и войти' : 'Войти'),
      confirming && e('button', { class: 'auth-cancel', type: 'button', disabled: busy, onClick: () => {
        setConfirming(false); setPassword(''); setRepeat(''); setError(''); setVisible(false);
        requestAnimationFrame(() => loginField.current?.focus());
      } }, 'Отмена')),
    !confirming && e('button', { class: 'text-button', type: 'button', 'aria-expanded': help, onClick: () => setHelp(!help) }, 'Восстановить доступ'),
    help && !confirming && e('p', { class: 'auth-notice' }, 'Восстановление доступа пока не реализовано. Обратитесь к администратору сервера.'));
}
