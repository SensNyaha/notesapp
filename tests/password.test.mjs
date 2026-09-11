import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { normalizeLogin, validPassword, hashPassword, verifyPassword } from '../server/auth/password.mjs';

test('login and agreed password policy: Unicode case, length boundaries, exact bytes', async t => {
  assert.equal(normalizeLogin('MiKe._-9'), 'mike._-9');
  for (const login of ['aa', '9admin', ' admin', 'админ', 'a@b.com', 'a'.repeat(33)]) assert.equal(normalizeLogin(login), null);
  for (const password of ['Abcde1', 'Пароль1', 'Aa1' + 'a'.repeat(125), ' Aa1  ']) assert(validPassword(password));
  for (const password of ['Abcd1', 'abcdef1', 'ABCDEF1', 'Abcdef', 'Aa1' + 'a'.repeat(126)]) assert(!validPassword(password));
  const started = performance.now();
  const first = await hashPassword('Пароль1');
  t.diagnostic(`Argon2id 64 MiB/t=3/p=1: ${(performance.now() - started).toFixed(0)} ms (this test environment)`);
  const second = await hashPassword('Пароль1');
  assert.notEqual(first, second);
  assert.match(first, /^\$argon2id\$v=19\$/);
  const parts = first.split('$');
  assert.deepEqual(Object.fromEntries(parts[3].split(',').map(field => field.split('='))), { m: '65536', t: '3', p: '1' });
  assert.equal(Buffer.from(parts[4], 'base64').length, 16);
  assert.equal(Buffer.from(parts[5], 'base64').length, 32);
  assert(await verifyPassword(first, 'Пароль1'));
  assert.equal(await verifyPassword(first, 'пароль1'), false);
  assert.equal(await verifyPassword(first, 'Пароль1 '), false);
  assert.equal(await verifyPassword('corrupt', 'Пароль1'), false);
});
