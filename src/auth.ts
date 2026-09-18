import { isUser, type User } from './types/auth.ts';
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startAuthentication, startRegistration,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export class AuthError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

async function request(path: string, body?: object): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    const result = await fetch('/api/auth/csrf', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10_000) });
    const json: unknown = await result.json();
    if (!result.ok || !json || typeof json !== 'object' || !('csrf' in json) || typeof json.csrf !== 'string') throw new AuthError('network');
    headers['X-CSRF-Token'] = json.csrf;
    headers['Content-Type'] = 'application/json';
  }
  const result = await fetch('/api/auth/' + path, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const json: unknown = await result.json();
  if (!json || typeof json !== 'object') throw new AuthError('network');
  const data = json as Record<string, unknown>;
  if (!result.ok) throw new AuthError(typeof data.error === 'string' ? data.error : 'network');
  return data;
}

function userFrom(data: Record<string, unknown>): User {
  if (!isUser(data.user)) throw new AuthError('network');
  return data.user;
}

export async function setupRequired(): Promise<boolean> {
  const data = await request('setup-status');
  if (typeof data.setupRequired !== 'boolean') throw new AuthError('network');
  return data.setupRequired;
}

let recovering: Promise<User | null> | null = null;
export async function session(): Promise<User | null> {
  const recover = async () => {
    try { return userFrom(await request('session')); }
    catch (error) { if (!(error instanceof AuthError) || error.code !== 'unauthorized') throw error; }
    try {
      await request('refresh', {});
      return userFrom(await request('session'));
    } catch (error) {
      if (error instanceof AuthError && error.code === 'unauthorized') return null;
      if (error instanceof AuthError && error.code === 'refresh_conflict') {
        // Another tab advanced the cookie. Re-read once instead of endlessly retrying an old token.
        try { return userFrom(await request('session')); }
        catch (again) { if (again instanceof AuthError && again.code === 'unauthorized') return null; throw again; }
      }
      throw error;
    }
  };
  if (!recovering) {
    recovering = (navigator.locks ? navigator.locks.request('tasks-auth-refresh', recover) : recover())
      .finally(() => { recovering = null; });
  }
  return recovering;
}

export async function signIn(login: string, password: string, repeatPassword?: string): Promise<User> {
  return userFrom(await request(repeatPassword === undefined ? 'login' : 'bootstrap',
    { login, password, ...(repeatPassword === undefined ? {} : { repeatPassword }) }));
}
export async function signOut(): Promise<void> { await request('logout', {}); }

export interface PasskeyInfo {
  id: string; credentialId: string; displayName: string; createdAt: number; lastUsed: number | null;
  deviceType: 'singleDevice' | 'multiDevice'; backedUp: boolean; transports: string[];
}
export async function webAuthnCapability() {
  const available = browserSupportsWebAuthn();
  let platform = false;
  if (available) try { platform = await platformAuthenticatorIsAvailable(); } catch { /* feature probe only */ }
  return { available, platform };
}
function webAuthnFailure(error: unknown): never {
  if (error instanceof AuthError) throw error;
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) throw new AuthError('passkey_cancelled');
  throw new AuthError('passkey_unavailable');
}
export async function signInWithPasskey(): Promise<User> {
  try {
    const begin = await request('passkeys/login/options', {});
    if (typeof begin.challengeId !== 'string' || !begin.options || typeof begin.options !== 'object') throw new AuthError('network');
    const response = await startAuthentication({ optionsJSON: begin.options as PublicKeyCredentialRequestOptionsJSON });
    return userFrom(await request('passkeys/login/finish', { challengeId: begin.challengeId, response }));
  } catch (error) { return webAuthnFailure(error); }
}

export async function accountRequest(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!await session()) throw new AuthError('unauthorized');
  // Never automatically repeat mutations after a possibly lost response.
  return request(path, body);
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const data = await accountRequest('passkeys');
  if (!Array.isArray(data.passkeys)) throw new AuthError('network');
  return data.passkeys as PasskeyInfo[];
}
export async function registerPasskey(displayName: string): Promise<PasskeyInfo> {
  try {
    const begin = await accountRequest('passkeys/register/options', {});
    if (typeof begin.challengeId !== 'string' || !begin.options || typeof begin.options !== 'object') throw new AuthError('network');
    const response = await startRegistration({ optionsJSON: begin.options as PublicKeyCredentialCreationOptionsJSON });
    const finish = await accountRequest('passkeys/register/finish', { challengeId: begin.challengeId, displayName, response });
    if (!finish.passkey || typeof finish.passkey !== 'object') throw new AuthError('network');
    return finish.passkey as PasskeyInfo;
  } catch (error) { return webAuthnFailure(error); }
}
export async function deletePasskey(id: string): Promise<void> { await accountRequest('passkeys/delete', { id }); }

export function authMessage(error: unknown): string {
  const code = error instanceof AuthError ? error.code : 'network';
  return ({ invalid_credentials: 'Проверьте логин и пароль. Для нового пароля нужны 6–128 символов, цифра, заглавная и строчная буквы.',
    invalid_request: 'Проверьте заполненные поля.', setup_complete: 'Администратор уже создан. Войдите с существующими данными.',
    unauthorized: 'Сеанс завершён. Войдите снова.', admin_required: 'Доступно только администратору.',
    password_change_required: 'Сначала смените временный пароль.',
    temporary_expired: '48 часов истекли. Обратитесь к администратору за новым временным паролем.',
    login_exists: 'Этот логин уже занят. Если предыдущий ответ потерялся, проверьте список пользователей.',
    account_not_found: 'Пользователь не найден.', account_changed: 'Пароль аккаунта уже изменился. Вернитесь к списку и обновите его перед новым действием.',
    invalid_new_password: 'Новый пароль и повтор должны совпадать: 6–128 символов, цифра, заглавная и строчная буквы.',
    wrong_password: 'Текущий пароль неверен.', same_password: 'Новый пароль должен отличаться от текущего.',
    setup_required: 'Сначала подтвердите создание администратора.', rate_limited: 'Слишком много попыток. Повторите позже (до 15 минут).',
    forbidden: 'Адрес приложения не совпадает с настройкой сервера. Проверьте APP_ORIGIN.',
    csrf: 'Проверка запроса не прошла. Повторите действие.',
    device_not_found: 'Устройство или сеанс больше не найден.', current_session: 'Текущую сессию нужно завершать обычной кнопкой «Выйти».',
    invalid_passkey: 'Ключ доступа не прошёл проверку.', invalid_challenge: 'Запрос ключа доступа устарел или уже был использован. Повторите действие.',
    passkey_unavailable: 'Ключи доступа недоступны в этом браузере или на этом устройстве.', passkey_cancelled: 'Системная проверка отменена.',
    credential_exists: 'Этот ключ доступа уже зарегистрирован.', passkey_not_found: 'Ключ доступа уже удалён или недоступен.',
    collaboration_rewrap_required: 'Ключ совместной работы должен быть безопасно перепривязан к новому паролю.',
    identity_changed: 'Ключ совместной работы изменился. Обновите состояние и повторите действие.',
  } as Record<string, string>)[code] ?? 'Не удалось связаться с сервером. Проверьте подключение и повторите.';
}
