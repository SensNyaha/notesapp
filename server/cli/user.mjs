import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { SCHEMA_VERSION } from '../migrations.mjs';
import { AccountError, createAccount, resetAccount } from '../auth/accounts.mjs';
import { normalizeLogin, validPassword } from '../auth/password.mjs';

export function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let value;
  do { value = Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
  while (!validPassword(value));
  return value;
}
export function hiddenPassword(prompt, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('tty_required');
  output.write(prompt);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise((resolvePromise, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('keypress', keypress); input.setRawMode(Boolean(wasRaw)); input.pause(); output.write('\n');
      if (error) reject(error); else resolvePromise(value);
      value = '';
    };
    function keypress(text, key = {}) {
      if (key.ctrl && key.name === 'c') return finish(new Error('cancelled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl || key.meta || !text || /[\x00-\x1f\x7f]/.test(text)) return;
      if (Array.from(value + text).length <= 128) value += text;
    }
    input.on('keypress', keypress);
  });
}
export async function run(args = process.argv.slice(2)) {
  const [operation, login, flag, ...extra] = args;
  if (!['create', 'reset', 'recover-admin'].includes(operation) || !normalizeLogin(login)
    || (flag !== undefined && flag !== '--generate') || extra.length) throw new Error('usage');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('tty_required');
  // Never migrate or initialize a missing database from an administrative command.
  const source = join(resolve(process.env.DATA_DIR || 'data'), 'tasks.sqlite');
  const probe = new DatabaseSync(source, { readOnly: true });
  try { if (probe.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) throw new Error('schema'); }
  finally { probe.close(); }
  const db = new DatabaseSync(source, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    const normalized = normalizeLogin(login);
    const row = db.prepare('SELECT * FROM users WHERE login=?').get(normalized);
    const role = operation === 'recover-admin' ? 'admin' : 'user';
    if (operation === 'create' && row) throw new AccountError('login_exists');
    if (operation !== 'create') {
      if (!row || row.role !== role) throw new AccountError('account_not_found');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let confirmed;
      try { confirmed = await rl.question(`Будут завершены ВСЕ сеансы ${normalized}. Для подтверждения введите логин: `); }
      finally { rl.close(); }
      if (confirmed !== normalized) throw new Error('cancelled');
    }
    const password = flag === '--generate' ? generatePassword() : await hiddenPassword('Временный пароль (ввод скрыт): ');
    if (flag !== '--generate' && password !== await hiddenPassword('Повторите пароль: ')) throw new Error('password_mismatch');
    const result = operation === 'create' ? await createAccount(db, { login: normalized, password })
      : await resetAccount(db, { id: row.id, password, expectedVersion: row.credential_version, role });
    process.stdout.write(`Готово: ${result.login}. Пароль действует до ${new Date(result.temporaryExpires).toISOString()} (48 часов).\n`);
    process.stdout.write(`Временный пароль: ${password}\nПередайте пользователю. Повторно посмотреть пароль нельзя.\n`);
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(error => {
    const messages = {
      usage: 'Использование: node server/cli/user.mjs create|reset|recover-admin LOGIN [--generate]',
      tty_required: 'Нужен интерактивный терминал: docker compose exec app … (без -T). Пароли в аргументах и через pipe не принимаются.',
      schema: 'Сначала обновите приложение после резервного копирования. CLI не выполняет миграции.',
      cancelled: 'Операция отменена.', password_mismatch: 'Пароли не совпадают.',
      login_exists: 'Логин уже занят.', account_not_found: 'Аккаунт с требуемой ролью не найден.',
      account_changed: 'Аккаунт изменился. Проверьте состояние перед повтором.',
      invalid_credentials: 'Нужны 6–128 символов, цифра, заглавная и строчная буквы.',
      setup_required: 'Сначала завершите первоначальное создание администратора.',
    };
    process.stderr.write((messages[error instanceof AccountError ? error.code : error.message]
      || 'Операция не завершена. Проверьте доступность БД и состояние аккаунта перед повтором.') + '\n');
    process.exitCode = 1;
  });
}
