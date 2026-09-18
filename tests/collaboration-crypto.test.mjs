import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateVaultKey } from '../src/crypto/vault.ts';
import { rememberKey } from '../src/crypto/records.ts';
import {
  clearCollaborationRuntime, clearVaultEpochKeys, collaborationFingerprint,
  createCollaborationIdentity, createCollaborationPasswordWrapper, createCollaborationPrfWrapper,
  createOwnerKeyringBox, decryptVaultKeyring, encryptVaultKeyring, getCollaborationRuntime,
  importVaultKeyring, keyringFromRaw, openOwnerKeyringBox, openPersonalReminder,
  sealPersonalReminder, unlockCollaborationWithPassword, unlockCollaborationWithPrf, vaultKeyringRaw,
} from '../src/crypto/collaboration.ts';

const raw32=()=>{const value=new Uint8Array(32);crypto.getRandomValues(value);return value;};
const flip=value=>{const bytes=Buffer.from(value,'base64url');bytes[0]^=1;return bytes.toString('base64url');};

test('account-wide collaboration identity stays E2EE under password and WebAuthn PRF wrappers',async()=>{
  const account=randomUUID(),password='Current9Password',next='Next9Password';
  const created=await createCollaborationIdentity(account,password);
  assert.equal(created.identity.version,1);
  assert.equal(created.identity.publicKey.kty,'EC');
  assert.equal(created.identity.publicKey.crv,'P-256');
  assert.ok(!JSON.stringify(created.identity).includes(password));

  clearCollaborationRuntime(account);
  const unlocked=await unlockCollaborationWithPassword(account,created.identity,password);
  assert.equal(getCollaborationRuntime(account),unlocked);
  await assert.rejects(unlockCollaborationWithPassword(account,created.identity,'Wrong9Password'),/collaboration_unlock_failed/);

  const nextWrapper=await createCollaborationPasswordWrapper(account,1,created.identity.publicKey,unlocked.root,next);
  clearCollaborationRuntime(account);
  const rewrapped={...created.identity,passwordWrapper:nextWrapper};
  const unlockedNext=await unlockCollaborationWithPassword(account,rewrapped,next);
  assert.equal(await collaborationFingerprint(unlockedNext.publicKey),await collaborationFingerprint(created.identity.publicKey));
  await assert.rejects(unlockCollaborationWithPassword(account,rewrapped,password),/collaboration_unlock_failed/);

  const output=raw32(),salt=Buffer.from(raw32()).toString('base64url'),credentialId=Buffer.from(raw32()).toString('base64url');
  const prf=await createCollaborationPrfWrapper(account,unlockedNext,credentialId,salt,output);
  clearCollaborationRuntime(account);
  const unlockedPrf=await unlockCollaborationWithPrf(account,rewrapped,prf,output);
  assert.equal(await collaborationFingerprint(unlockedPrf.publicKey),await collaborationFingerprint(created.identity.publicKey));
  const wrong=raw32();
  await assert.rejects(unlockCollaborationWithPrf(account,rewrapped,prf,wrong),/collaboration_unlock_failed/);
  clearCollaborationRuntime(account);
});

test('member envelopes expose a vault keyring only to the intended collaboration identity',async()=>{
  const owner=randomUUID(),recipient=randomUUID(),other=randomUUID(),vault=randomUUID();
  const a=await createCollaborationIdentity(owner,'Owner9Password');
  const b=await createCollaborationIdentity(recipient,'Member9Password');
  const c=await createCollaborationIdentity(other,'Other9Password');
  const keys=[raw32(),raw32()];
  const ring=keyringFromRaw(2,1,keys);
  const envelope=await encryptVaultKeyring(vault,ring,recipient,b.identity.version,b.identity.publicKey);

  const decoded=await decryptVaultKeyring(recipient,vault,2,b.identity.version,envelope,b.runtime);
  assert.deepEqual(decoded,ring);
  await importVaultKeyring(recipient,vault,decoded);

  await assert.rejects(decryptVaultKeyring(other,vault,2,c.identity.version,envelope,c.runtime),/identity_changed|keyring_unlock_failed/);
  await assert.rejects(decryptVaultKeyring(recipient,randomUUID(),2,b.identity.version,envelope,b.runtime),/keyring_unlock_failed|invalid_collaboration_crypto/);
  await assert.rejects(decryptVaultKeyring(recipient,vault,2,b.identity.version,{...envelope,ciphertext:flip(envelope.ciphertext)},b.runtime),/keyring_unlock_failed/);

  clearVaultEpochKeys(recipient,vault);
  clearCollaborationRuntime(owner);clearCollaborationRuntime(recipient);clearCollaborationRuntime(other);
});

test('owner keyring history is authenticated by the original vault root and survives epoch rotation',async()=>{
  const account=randomUUID(),vaultId=randomUUID(),keyId=randomUUID(),revisionId=randomUUID();
  const root=await generateVaultKey(),epoch0=await rememberKey(root);
  const raws=[new Uint8Array(await crypto.subtle.exportKey('raw',root)),raw32(),raw32()];
  const ring=keyringFromRaw(3,2,raws);
  const context={accountId:account,vaultId,keyId,objectId:keyId,revisionId};
  const box=await createOwnerKeyringBox(epoch0,context,ring);
  assert.deepEqual(await openOwnerKeyringBox(epoch0,context,box),ring);
  await assert.rejects(openOwnerKeyringBox(epoch0,{...context,vaultId:randomUUID()},box));
  await assert.rejects(openOwnerKeyringBox(epoch0,context,{...box,ciphertext:flip(box.ciphertext)}));
  const decoded=vaultKeyringRaw(ring);assert.equal(decoded.length,3);assert.deepEqual(decoded.map(x=>x.length),[32,32,32]);
  raws.forEach(x=>x.fill(0));decoded.forEach(x=>x.fill(0));
});

test('personal reminder configuration is opaque and bound to account, vault, object and revision',async()=>{
  const account=randomUUID(),vault=randomUUID(),object=randomUUID(),revision=randomUUID(),root=(await createCollaborationIdentity(account,'Reminder9Password')).runtime.root;
  const plan={id:randomUUID(),state:'active',local:'2026-09-18T12:00',mode:'neutral',text:'',repeat:{type:'once'},end:{type:'never'},allDay:false,important:false};
  const box=await sealPersonalReminder(account,vault,object,revision,root,plan);
  assert.ok(!JSON.stringify(box).includes('2026-09-18T12:00'));
  assert.deepEqual(await openPersonalReminder(account,vault,object,revision,root,box),plan);
  await assert.rejects(openPersonalReminder(randomUUID(),vault,object,revision,root,box),/personal_reminder_unlock_failed/);
  await assert.rejects(openPersonalReminder(account,randomUUID(),object,revision,root,box),/personal_reminder_unlock_failed/);
  await assert.rejects(openPersonalReminder(account,vault,object,randomUUID(),root,box),/personal_reminder_unlock_failed/);
});
