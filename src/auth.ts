import { isUser, type User } from './types/auth';

export class AuthError extends Error {
  constructor(public code: string) { super(code); }
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

export function authMessage(error: unknown): string {
  const code = error instanceof AuthError ? error.code : 'network';
  return ({ invalid_credentials: 'Проверьте логин и пароль. Для нового пароля нужны 6–128 символов, цифра, заглавная и строчная буквы.',
    invalid_request: 'Проверьте заполненные поля.', setup_complete: 'Администратор уже создан. Войдите с существующими данными.',
    setup_required: 'Сначала подтвердите создание администратора.', rate_limited: 'Слишком много попыток. Повторите позже (до 15 минут).',
    forbidden: 'Адрес приложения не совпадает с настройкой сервера. Проверьте APP_ORIGIN.',
    csrf: 'Проверка запроса не прошла. Повторите действие.',
  } as Record<string, string>)[code] ?? 'Не удалось связаться с сервером. Проверьте подключение и повторите.';
}
