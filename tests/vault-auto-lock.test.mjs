import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { writeState, readState, eraseState, setRuntimeVaultKey, clearRuntimeVaultKey, changes } from '../src/storage.ts';
import { lockAfterBackground, lockVault, vaultEntryMode } from '../src/planner.ts';

const user={id:'81000000-0000-4000-8000-000000000001',login:'lock-user',role:'user'};
const vaultId='82000000-0000-4000-8000-000000000002';
const wrapper={v:1,purpose:'webauthn-prf',alg:'A256GCM',vaultId,keyId:'83000000-0000-4000-8000-000000000003',
  credentialId:'E'.repeat(32),prfSalt:'A'.repeat(43),iv:'B'.repeat(16),ciphertext:'C'.repeat(64),lockEpoch:0,autoLockMs:900_000};

function installLocks(){
  globalThis.window=new EventTarget();const queues=new Map();
  Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request(name,fn){
    const next=(queues.get(name)??Promise.resolve()).then(fn);queues.set(name,next.catch(()=>{}));return next;
  }}});
}
async function runtimeKey(){return crypto.subtle.generateKey({name:'AES-KW',length:256},false,['wrapKey','unwrapKey']);}
function state(key,autoLockMs=900_000){return{user,vaults:[{header:{id:vaultId,keyId:wrapper.keyId,revisionId:'84000000-0000-4000-8000-000000000004',wrapper:{},name:{}},
  records:[],key,systemUnlock:{...wrapper,autoLockMs}}],stash:[]};}

test('vault entry chooses immediate access, system verification or phrase from current local state',()=>{
  assert.equal(vaultEntryMode({key:{}}),'open');
  assert.equal(vaultEntryMode({systemUnlock:wrapper}),'system');
  assert.equal(vaultEntryMode({}),'phrase');
});

test('protected root key is runtime-only; timeout/manual lock clear it while encrypted wrapper remains',async t=>{
  installLocks();t.after(async()=>{await eraseState(user.id);changes?.close();});
  const key=await runtimeKey();await writeState(state(key));
  assert.ok((await readState(user.id)).vaults[0].key);
  clearRuntimeVaultKey(user.id,vaultId);
  let stored=await readState(user.id);assert.equal(stored.vaults[0].key,undefined);assert.ok(stored.vaults[0].systemUnlock);
  setRuntimeVaultKey(user.id,vaultId,key);stored=await readState(user.id);assert.ok(stored.vaults[0].key);
  assert.equal(await lockAfterBackground(user,899_999),false);assert.ok((await readState(user.id)).vaults[0].key);
  assert.equal(await lockAfterBackground(user,900_000),true);stored=await readState(user.id);assert.equal(stored.vaults[0].key,undefined);assert.ok(stored.vaults[0].systemUnlock);
  await writeState(state(key,0));assert.equal(await lockAfterBackground(user,24*60*60_000),false);assert.ok((await readState(user.id)).vaults[0].key);
  await lockVault(user,vaultId);stored=await readState(user.id);assert.equal(stored.vaults[0].key,undefined);assert.ok(stored.vaults[0].systemUnlock);
});