import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'fake-indexeddb/auto';
import { generateVaultKey, wrapWithPhrase } from '../src/crypto/vault.ts';
import { rememberKey, seal } from '../src/crypto/records.ts';
import { ContactKeyChanged, trustFingerprint } from '../src/collaboration.ts';
import { readStash, synchronize } from '../src/planner.ts';
import { changes, readState, writeState } from '../src/storage.ts';

const user=id=>({id,login:'member',role:'user',mustChangePassword:false,temporaryExpires:null});
test.after(()=>changes?.close());

test('TOFU contact fingerprints require explicit confirmation when a collaboration key changes',async()=>{
  globalThis.window??=new EventTarget();
  const id=randomUUID(),u=user(id),contact=randomUUID();
  await writeState({user:u,vaults:[],stash:[],deviceId:randomUUID(),deviceName:'Test',deviceRegistered:true});
  assert.equal(await trustFingerprint(u,contact,'fingerprint-one'),'first');
  assert.equal(await trustFingerprint(u,contact,'fingerprint-one'),'known');
  await assert.rejects(trustFingerprint(u,contact,'fingerprint-two'),error=>error instanceof ContactKeyChanged
    &&error.previous==='fingerprint-one'&&error.current==='fingerprint-two');
  assert.equal((await readState(id)).collaboration.trustedFingerprints[contact],'fingerprint-one');
  assert.equal(await trustFingerprint(u,contact,'fingerprint-two',true),'known');
  assert.equal((await readState(id)).collaboration.trustedFingerprints[contact],'fingerprint-two');
});

test('revoked shared membership keeps downloaded data read-only and moves unsynced plaintext-equivalent state into encrypted personal stash',async()=>{
  globalThis.window??=new EventTarget();
  const locks={request:(_name,fn)=>fn()};
  Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:locks});
  const memberId=randomUUID(),ownerId=randomUUID(),u=user(memberId),vaultId=randomUUID(),keyId=randomUUID(),headerRevision=randomUUID();
  const root=await generateVaultKey(),key=await rememberKey(root),ctx={accountId:ownerId,vaultId,keyId,objectId:keyId,revisionId:headerRevision};
  const header={id:vaultId,keyId,revisionId:headerRevision,wrapper:await wrapWithPhrase(root,ctx,'abcdef'),
    name:await seal(root,{...ctx,objectId:vaultId},null,'Shared')};
  const objectId=randomUUID(),baseId=randomUUID(),pendingId=randomUUID();
  const base={id:baseId,objectId,parent:null,sealed:await seal(key,{accountId:ownerId,vaultId,keyId,objectId,revisionId:baseId},null,{title:'Base',text:'Downloaded'})};
  const pending={id:pendingId,objectId,parent:baseId,pending:true,sealed:await seal(key,{accountId:ownerId,vaultId,keyId,objectId,revisionId:pendingId},baseId,{title:'Offline',text:'Unsynced private edit'})};
  await writeState({user:u,vaults:[{header,displayName:'Shared',key,records:[base,pending],role:'editor',ownerId,shared:true,keyring:{version:1,currentEpoch:0}}],
    stash:[],deviceId:randomUUID(),deviceName:'Test device',deviceRegistered:true,reminderSeen:[]});

  const originalFetch=globalThis.fetch;
  globalThis.fetch=async path=>{
    if(path==='/api/auth/session')return new Response(JSON.stringify({user:u}),{status:200,headers:{'content-type':'application/json'}});
    if(path==='/api/vaults')return new Response(JSON.stringify({vaults:[]}),{status:200,headers:{'content-type':'application/json'}});
    throw Error('unexpected fetch '+path);
  };
  try{await synchronize(u);}finally{globalThis.fetch=originalFetch;}

  const after=await readState(memberId),v=after.vaults[0];
  assert.equal(v.membershipRevoked,true);assert.equal(v.role,'viewer');
  assert.equal(v.records.some(r=>r.pending),false);assert.equal(v.records.length,1);assert.equal(v.records[0].id,baseId);
  assert.equal(after.stash.length,1);assert.equal(after.stash[0].source,vaultId);
  const saved=await readStash(after,after.stash[0].id);assert.equal(saved.title,'Offline');assert.equal(saved.text,'Unsynced private edit');
  assert.ok(!JSON.stringify(after.stash).includes('Unsynced private edit'));
  assert.match(v.syncError,/stash|read-only/);
});
