import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { writeState, profileActivity, profiles, changes } from '../src/storage.ts';

test('the last active local account is selected without mixing profile data', async t => {
  t.after(() => changes?.close());
  const first = { id: '00000000-0000-4000-8000-000000000001', login: 'first', role: 'user' };
  const second = { id: '00000000-0000-4000-8000-000000000002', login: 'second', role: 'user' };
  await writeState({ user: first, vaults: [], stash: [] });
  await writeState({ user: second, vaults: [], stash: [] });
  assert.ok((await profileActivity()).every(item => item.lastOpenedAt === undefined));

  await writeState({ user: second, vaults: [], stash: [], lastOpenedAt: 100 });
  await writeState({ user: first, vaults: [], stash: [], lastOpenedAt: 200 });
  assert.equal((await profileActivity())[0].user.id, first.id);
  assert.deepEqual((await profiles()).map(user => user.id), [first.id, second.id]);

  await writeState({ user: second, vaults: [], stash: [], lastOpenedAt: 300 });
  assert.equal((await profileActivity())[0].user.id, second.id);
});
