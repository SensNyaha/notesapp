import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVaultKey, wrapWithPhrase, unwrapWithPhrase } from '../src/crypto/vault.ts';
import { rememberKey, seal, unseal } from '../src/crypto/records.ts';
import { createSystemUnlockWrapper, unlockSystemWrapper, updateSystemUnlockAutoLock, generatePrfSalt } from '../src/crypto/system-unlock.ts';

const accountId='10000000-0000-4000-8000-000000000001';
const vaultId='20000000-0000-4000-8000-000000000002';
const otherVaultId='20000000-0000-4000-8000-000000000003';
const keyId='30000000-0000-4000-8000-000000000003';
const wrapperRevision='40000000-0000-4000-8000-000000000004';
const objectId='50000000-0000-4000-8000-000000000005';
const recordRevision='60000000-0000-4000-8000-000000000006';
const credential='C'.repeat(32);
const systemContext={accountId,vaultId,keyId};
const phraseContext={accountId,vaultId,keyId,objectId:keyId,revisionId:wrapperRevision};
const recordContext={accountId,vaultId,keyId,objectId,revisionId:recordRevision};
const phrase='correct horse battery staple';
const flip=value=>(value[0]==='A'?'B':'A')+value.slice(1);

async function prepared(){
  const root=await generateVaultKey(),phraseWrapper=await wrapWithPhrase(root,phraseContext,phrase);
  const remembered=await rememberKey(root),record=await seal(remembered,recordContext,null,{title:'secret',text:'private'});
  const output=crypto.getRandomValues(new Uint8Array(32)),salt=generatePrfSalt();
  const wrapper=await createSystemUnlockWrapper(root,systemContext,credential,salt,output,0,900_000);
  return{root,phraseWrapper,record,output,salt,wrapper};
}
test('PRF wrapper unlocks the same vault root; phrase fallback remains independent and root does not rotate',async()=>{
  const p=await prepared();
  const systemKey=await unlockSystemWrapper(systemContext,p.wrapper,p.output,0);
  assert.equal(systemKey.extractable,false);assert.equal(systemKey.algorithm.name,'AES-KW');
  assert.deepEqual(await unseal(systemKey,recordContext,null,p.record),{title:'secret',text:'private'});
  const phraseRoot=await unwrapWithPhrase(phraseContext,phrase,p.phraseWrapper),phraseKey=await rememberKey(phraseRoot);
  assert.deepEqual(await unseal(phraseKey,recordContext,null,p.record),{title:'secret',text:'private'});
  const second=await createSystemUnlockWrapper(phraseRoot,systemContext,credential,generatePrfSalt(),p.output,0,900_000);
  const secondKey=await unlockSystemWrapper(systemContext,second,p.output,0);
  assert.deepEqual(await unseal(secondKey,recordContext,null,p.record),{title:'secret',text:'private'});
});

test('wrong PRF, vault, credential, epoch and modified ciphertext/IV/salt/metadata fail',async()=>{
  const p=await prepared(),wrong=crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(unlockSystemWrapper(systemContext,p.wrapper,wrong,0));
  await assert.rejects(unlockSystemWrapper({...systemContext,vaultId:otherVaultId},p.wrapper,p.output,0));
  await assert.rejects(unlockSystemWrapper(systemContext,{...p.wrapper,credentialId:'D'.repeat(32)},p.output,0));
  await assert.rejects(unlockSystemWrapper(systemContext,p.wrapper,p.output,1));
  await assert.rejects(unlockSystemWrapper(systemContext,{...p.wrapper,ciphertext:flip(p.wrapper.ciphertext)},p.output,0));
  await assert.rejects(unlockSystemWrapper(systemContext,{...p.wrapper,iv:flip(p.wrapper.iv)},p.output,0));
  await assert.rejects(unlockSystemWrapper(systemContext,{...p.wrapper,prfSalt:flip(p.wrapper.prfSalt)},p.output,0));
  await assert.rejects(unlockSystemWrapper(systemContext,{...p.wrapper,autoLockMs:300_000},p.output,0));
});
test('auto-lock metadata is re-authenticated and can only be changed with the same PRF result',async()=>{
  const p=await prepared();
  const updated=await updateSystemUnlockAutoLock(systemContext,p.wrapper,p.output,0,0);
  assert.equal(updated.autoLockMs,0);assert.notEqual(updated.iv,p.wrapper.iv);
  const key=await unlockSystemWrapper(systemContext,updated,p.output,0);
  assert.deepEqual(await unseal(key,recordContext,null,p.record),{title:'secret',text:'private'});
  await assert.rejects(updateSystemUnlockAutoLock(systemContext,p.wrapper,crypto.getRandomValues(new Uint8Array(32)),0,300_000));
});

test('wrappers are vault-scoped even when the same credential and PRF output are used',async()=>{
  const rootA=await generateVaultKey(),rootB=await generateVaultKey(),output=crypto.getRandomValues(new Uint8Array(32));
  const contextA=systemContext,contextB={accountId,vaultId:otherVaultId,keyId:'70000000-0000-4000-8000-000000000007'};
  const wrapperA=await createSystemUnlockWrapper(rootA,contextA,credential,generatePrfSalt(),output,0,900_000);
  const wrapperB=await createSystemUnlockWrapper(rootB,contextB,credential,generatePrfSalt(),output,0,900_000);
  await unlockSystemWrapper(contextA,wrapperA,output,0);await unlockSystemWrapper(contextB,wrapperB,output,0);
  await assert.rejects(unlockSystemWrapper(contextB,wrapperA,output,0));
  await assert.rejects(unlockSystemWrapper(contextA,wrapperB,output,0));
});
