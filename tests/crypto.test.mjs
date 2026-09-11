import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { generateVaultKey, generateRecoveryCode, encryptRecord, decryptRecord, wrapWithPhrase, unwrapWithPhrase,
  wrapWithRecovery, unwrapWithRecovery, serializeEnvelope, parseEnvelope, additionalData,
  MemoryEncryptionBudget, MAX_ENCRYPTIONS, MAX_RECORD_BYTES } from '../src/crypto/vault.ts';

const ids = [1, 2, 3, 4, 5].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const context = { accountId: ids[0], vaultId: ids[1], keyId: ids[2], objectId: ids[3], revisionId: ids[4] };
const keyContext = { ...context, objectId: context.keyId };
const rawKey = Uint8Array.from({ length: 32 }, (_, i) => i);
const importKey = () => crypto.subtle.importKey('raw', rawKey, 'AES-GCM', true, ['encrypt', 'decrypt']);
const clone = value => JSON.parse(JSON.stringify(value));
const budget = () => new MemoryEncryptionBudget();
const fixture = { v: 1, alg: 'A256GCM', iv: 'AAECAwQFBgcICQoL', ciphertext: 'FWewfreArHjoYeXu0oYKCZHE43w0N_pmgPC6rYAsUgo' };
// Fixed vectors generated independently with node:crypto/OpenSSL createCipheriv + pbkdf2Sync,
// literal AAD arrays (not the implementation's serializer), key 00..1f, IV 00..0b, salt 00..0f.
const wrappedFixture = { v: 1, alg: 'A256GCM', iv: fixture.iv,
  ciphertext: 'eOtWKF0q-0Vx_vWEgDM-EJ7QmBcrY40F8fC6u1yRbVO9CtrHEZ-nrPWH7Kw5QN_p', purpose: 'phrase',
  kdf: { name: 'PBKDF2-SHA256', iterations: 600000, salt: 'AAECAwQFBgcICQoLDA0ODw' } };

test('fixed AES-GCM and PBKDF2/wrapped-key vectors; encryption interoperates with the independent Node API', async () => {
  const key = await importKey();
  assert.equal(new TextDecoder().decode(await decryptRecord(key, context, fixture)), 'Reference record');
  const unwrapped = await unwrapWithPhrase(keyContext, 'Test phrase 2026', wrappedFixture);
  assert.deepEqual(new Uint8Array(await crypto.subtle.exportKey('raw', unwrapped)), rawKey);
  assert.equal(pbkdf2Sync('Test phrase 2026', Buffer.from(wrappedFixture.kdf.salt, 'base64url'), 600000, 32, 'sha256').toString('hex'),
    '4570ab7518ad5bf2b94a6807f82790fbb191ee38c210df36bb00a0281c8851e9');
  const plaintext = new TextEncoder().encode('Новая запись 🗒️');
  const encrypted = await encryptRecord(key, context, plaintext, budget());
  const bytes = Buffer.from(encrypted.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', rawKey, Buffer.from(encrypted.iv, 'base64url'));
  decipher.setAAD(Buffer.from(JSON.stringify(['tasks', 1, 'A256GCM', 'record', ...ids, null])));
  decipher.setAuthTag(bytes.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]), Buffer.from(plaintext));
  assert.equal(new TextDecoder().decode(additionalData(context, 'record')), JSON.stringify(['tasks', 1, 'A256GCM', 'record', ...ids, null]));
});

test('tampering with account, vault, key, object, revision, ciphertext or tag fails authentication', async () => {
  const key = await importKey();
  for (const field of Object.keys(context)) {
    await assert.rejects(decryptRecord(key, { ...context, [field]: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, fixture), /authentication_failed/);
  }
  for (const field of ['iv', 'ciphertext']) {
    const altered = clone(fixture), bytes = Buffer.from(altered[field], 'base64url');
    bytes[bytes.length - 1] ^= 1; altered[field] = bytes.toString('base64url');
    await assert.rejects(decryptRecord(key, context, altered), /authentication_failed/);
  }
  await assert.rejects(decryptRecord(await generateVaultKey(), context, fixture), /authentication_failed/);
  await assert.rejects(unwrapWithPhrase(keyContext, 'Wrong phrase 2026', wrappedFixture), /authentication_failed/);
  const alteredSalt = clone(wrappedFixture); alteredSalt.kdf.salt = Buffer.alloc(16, 9).toString('base64url');
  await assert.rejects(unwrapWithPhrase(keyContext, 'Test phrase 2026', alteredSalt), /authentication_failed/);
  const alteredIterations = clone(wrappedFixture); alteredIterations.kdf.iterations++;
  await assert.rejects(unwrapWithPhrase(keyContext, 'Test phrase 2026', alteredIterations), /authentication_failed/);
});

test('canonical wire format rejects unknown fields, versions, algorithms, invalid encoding, duplicates and excessive KDF costs', async () => {
  const canonical = serializeEnvelope(fixture);
  assert.deepEqual(parseEnvelope(canonical), fixture);
  assert.deepEqual(parseEnvelope(serializeEnvelope(wrappedFixture)), wrappedFixture);
  for (const text of [canonical + ' ', canonical.replace('"v":1', '"v":1,"v":1'), 'null', '[]', '{', ' '.repeat(1_500_000)]) {
    assert.throws(() => parseEnvelope(text), /invalid_format/);
  }
  const key = await importKey();
  for (const item of [
    { ...fixture, v: 2 }, { ...fixture, alg: 'AES-CBC' }, { ...fixture, extra: true }, { ...fixture, iv: fixture.iv + '=' },
    { ...fixture, ciphertext: fixture.ciphertext.slice(0, -1) + 'p' }, { ...fixture, iv: 'AA' }, { ...fixture, ciphertext: 'AA' },
  ]) await assert.rejects(decryptRecord(key, context, item), /invalid_format/);
  for (const iterations of [1, 599999, 2000001, 600000.5, '600000', null]) {
    const item = clone(wrappedFixture); item.kdf.iterations = iterations;
    await assert.rejects(unwrapWithPhrase(keyContext, 'Test phrase 2026', item), /invalid_format/);
  }
  await assert.rejects(unwrapWithRecovery(keyContext, generateRecoveryCode(), wrappedFixture), /invalid_format/);
});

test('phrase rewrapping and recovery preserve the data key and existing encrypted records', async () => {
  const key = await generateVaultKey(), code = generateRecoveryCode();
  assert.match(code, /^tasks-recovery-v1\.[A-Za-z0-9_-]{43}$/);
  const record = await encryptRecord(key, context, new TextEncoder().encode('Содержимое'), budget());
  const phrase = '  Тестовая фраза Ё 🗝️  ';
  const first = await wrapWithPhrase(key, keyContext, phrase);
  const again = await wrapWithPhrase(key, keyContext, phrase);
  assert.notEqual(first.kdf.salt, again.kdf.salt);
  assert.notEqual(first.iv, again.iv);
  assert(!serializeEnvelope(first).includes(phrase));
  await assert.rejects(unwrapWithPhrase(keyContext, phrase.trim(), first), /authentication_failed/);
  const opened = await unwrapWithPhrase(keyContext, phrase, first);
  const nextContext = { ...keyContext, revisionId: '00000000-0000-4000-8000-000000000006' };
  const second = await wrapWithPhrase(opened, nextContext, 'Другая тестовая фраза');
  await assert.rejects(unwrapWithPhrase(keyContext, 'Другая тестовая фраза', second), /authentication_failed/);
  const next = await unwrapWithPhrase(nextContext, 'Другая тестовая фраза', second);
  assert.equal(new TextDecoder().decode(await decryptRecord(next, context, record)), 'Содержимое');
  const recovery = await wrapWithRecovery(key, keyContext, code, budget());
  assert(!serializeEnvelope(recovery).includes(code));
  const recovered = await unwrapWithRecovery(keyContext, code, parseEnvelope(serializeEnvelope(recovery)));
  assert.equal(new TextDecoder().decode(await decryptRecord(recovered, context, record)), 'Содержимое');
  await assert.rejects(unwrapWithRecovery(keyContext, generateRecoveryCode(), recovery), /authentication_failed/);
  await assert.rejects(unwrapWithRecovery(keyContext, code + '=', recovery), /invalid_format/);
  await assert.rejects(unwrapWithPhrase(keyContext, '\ud800', first), /invalid_format/);
  await assert.rejects(wrapWithPhrase(key, keyContext, 'x'.repeat(4097)), /invalid_format/);
});

test('record limits, empty data, encryption budget and asynchronous input snapshots', async () => {
  const key = await generateVaultKey();
  for (const size of [0, MAX_RECORD_BYTES]) {
    const input = new Uint8Array(size).fill(73);
    const envelope = await encryptRecord(key, context, input, budget());
    assert.deepEqual(await decryptRecord(key, context, parseEnvelope(serializeEnvelope(envelope))), input);
  }
  await assert.rejects(encryptRecord(key, context, new Uint8Array(MAX_RECORD_BYTES + 1), budget()), /invalid_format/);
  const last = new MemoryEncryptionBudget([[context.keyId, MAX_ENCRYPTIONS - 1]]);
  const outcomes = await Promise.allSettled([1, 2].map(() => encryptRecord(key, context, new Uint8Array(), last)));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(r => r.status === 'rejected').reason.message, /usage_limit/);
  let resume;
  const delayed = { reserve: () => new Promise(resolve => { resume = resolve; }) };
  const data = new Uint8Array([1, 2, 3]), mutableContext = { ...context };
  const pending = encryptRecord(key, mutableContext, data, delayed);
  data.fill(9); mutableContext.objectId = ids[0]; resume();
  assert.deepEqual(await decryptRecord(key, context, await pending), new Uint8Array([1, 2, 3]));
  const samples = await Promise.all(Array.from({ length: 32 }, () => encryptRecord(key, context, new Uint8Array(), budget())));
  assert.equal(new Set(samples.map(sample => sample.iv)).size, samples.length, 'smoke check only, not a proof of nonce uniqueness');
});
