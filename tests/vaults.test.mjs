import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { createApp } from '../server/app.mjs';
import { generateVaultKey } from '../src/crypto/vault.ts';
import { seal, unseal } from '../src/crypto/records.ts';
import { signAccess } from '../src/crypto/access.ts';
import { createVault, openVault, closeVault, saveNote, readNote, heads, synchronize, transferVault,
  readStash, moveStash, discardStash, edit, closeAllVault, deleteVault, resolveConflict, renameDevice, acknowledgeReminder, context, vaultName,
  readTags,createTag,renameTag,deleteTag,copyNote,readVaultPushMode,setVaultPushMode,archiveNote,restoreArchivedNote,trashNote,
  createProject,updateProject,createTask,updateTask,rescheduleTasks,movePlannerObject,deleteProject,readProjectWorkspace,
  restoreTrashedNote,permanentlyDeleteNote,restoreNoteVersion,noteHistory,noteLifecycle,requireOutboxReview,outboxReviewItems,decideOutboxReview,OutboxReviewRequired } from '../src/planner.ts';
import { readState, writeState, changes } from '../src/storage.ts';

test('record v2 interoperates with OpenSSL AES-KW/GCM and authenticates context, parent and payload', async () => {
  const key = await generateVaultKey(), c = Object.fromEntries(['accountId','vaultId','keyId','objectId','revisionId'].map(x => [x, randomUUID()]));
  const value = { title: 'Секрет', text: 'Текст' }, parent = randomUUID(), r = await seal(key, c, parent, value);
  assert.deepEqual(await unseal(key, c, parent, r), value);
  const unwrap = createDecipheriv('id-aes256-wrap', Buffer.from(await crypto.subtle.exportKey('raw', key)), Buffer.alloc(8, 0xa6));
  const raw = Buffer.concat([unwrap.update(Buffer.from(r.key, 'base64url')), unwrap.final()]);
  const ct = Buffer.from(r.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', raw, Buffer.from(r.iv, 'base64url'));
  decipher.setAAD(Buffer.from(JSON.stringify(['tasks-record',2,'A256KW+A256GCM',c.accountId,c.vaultId,c.keyId,c.objectId,c.revisionId,parent])));
  decipher.setAuthTag(ct.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0,-16)),decipher.final()])),value);
  for (const field of Object.keys(c)) await assert.rejects(unseal(key, { ...c, [field]: randomUUID() }, parent, r));
  await assert.rejects(unseal(key,c,null,r));
  for (const field of ['key','iv','ciphertext']) {
    const bytes = Buffer.from(r[field], 'base64url'); bytes[0] ^= 1;
    await assert.rejects(unseal(key,c,parent,{ ...r, [field]: bytes.toString('base64url') }));
  }
  await assert.rejects(unseal(key,c,parent,{...r, extra:true}));
  await assert.rejects(seal(key,c,parent,'a'.repeat(1024*1024)));
  const second = await seal(key,c,parent,value); assert.notEqual(second.key,r.key);
});

test('vault persistence, offline queue, conflicts, deletion and encrypted stash integrate with authenticated HTTP', async t => {
  globalThis.window = new EventTarget();
  const queues = new Map();
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request(name, fn) {
    const next = (queues.get(name) ?? Promise.resolve()).then(fn); queues.set(name,next.catch(()=>{})); return next;
  } } });
  const dir = await mkdtemp(join(tmpdir(),'tasks-vaults-'));
  const credentials = { login: 'VaultAdmin', password: 'Secret9Admin' };
  let now=Date.now();
  const app = await createApp({ dataDir:dir, logger:false, clock:()=>now, auth:{ origin:'http://localhost:3100',secure:false,bootstrap:credentials } });
  const jar = new Map(), originalFetch = globalThis.fetch;
  let lose = '', offline = false, gate, failPath='';
  const send = async (path, options={}) => {
    const cookie = [...jar].map(([k,v])=>`${k}=${v}`).join('; ');
    const account = path.startsWith('/api/vaults') ? (await app.inject({url:'/api/auth/session',headers:{cookie}})).json().user?.id : undefined;
    const response = await app.inject({ url:path, method: options.method ?? 'GET',
      headers:{ origin:'http://localhost:3100',cookie,...(account?{'x-tasks-account':account}:{}),...options.headers }, payload:options.body });
    for (const c of response.cookies) { if(c.value)jar.set(c.name,c.value);else jar.delete(c.name); }
    return response;
  };
  globalThis.fetch = async (path, options={}) => {
    if(offline)throw Error('offline');
    if(gate&&path.split('?')[0]===gate.path){const current=gate;gate=undefined;current.arrived();await current.wait;}
    if(failPath&&path.split('?')[0]===failPath)return new Response(JSON.stringify({error:'server_error'}),{status:500});
    const response = await send(path,options);
    if(lose===path){lose='';throw Error('lost response');}
    return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  };
  t.after(async()=>{globalThis.fetch=originalFetch;changes?.close();await app.close();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:75});});
  const post = async(path,body) => {
    const csrf=(await send('/api/auth/csrf')).json().csrf;
    return send(path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
  };
  const user=(await post('/api/auth/login',credentials)).json().user;
  const secret={title:'PRIVATE TITLE 98765',text:'PRIVATE BODY 54321',html:'<p><strong>PRIVATE BODY 54321</strong></p>',
    attachments:[{id:randomUUID(),name:'private.txt',type:'text/plain',size:6,data:'data:text/plain;base64,c2VjcmV0'}]};
  let source, target, base, deviceB;
  await t.test('creates multiple vaults, retains CryptoKey through IndexedDB, wrong phrase changes nothing',async()=>{
    source=await createVault(user,'PRIVATE VAULT 87654','      ');
    target=await createVault(user,'Другое','123456');
    await assert.rejects(createVault(user,'x','12345'));
    const objectId=randomUUID();base=await saveNote(user,source,objectId,null,secret);
    let s=await readState(user.id),v=s.vaults[0];const {author,...plain}=await readNote(user.id,v,heads(v)[0]);assert.deepEqual(plain,secret);assert.equal(author.name,'Устройство');
    assert.ok(v.key instanceof CryptoKey);
    assert.equal(v.key.extractable,false);
    await assert.rejects(crypto.subtle.exportKey('raw',v.key));
    assert.ok(!JSON.stringify(s).includes(secret.title));
    await closeVault(user,source); await assert.rejects(openVault(user,source,'wrong!'));
    assert.equal((await readState(user.id)).vaults[0].key,undefined);
    await openVault(user,source,'      ');await synchronize(user);
    s=await readState(user.id);assert.equal(s.vaults[0].records[0].pending,false);
    assert.equal((await send('/api/vaults')).json().vaults.find(v=>v.id===source).displayName,'PRIVATE VAULT 87654');
    assert.equal(await vaultName(user.id,{...s.vaults[0],key:undefined}),'PRIVATE VAULT 87654 (закрыто)');
    deviceB=structuredClone(s);
  });
  await t.test('authorization, CSRF, permanent accounts, ownership and immutable/idempotent revisions',async()=>{
    assert.equal((await app.inject({url:'/api/vaults'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/vaults/create',payload:{}})).statusCode,400);
    let s=await readState(user.id),v=s.vaults[0],r=v.records[0]; const {pending,...wire}=r;
    assert.equal((await post('/api/vaults/record',{vaultId:source,record:wire})).statusCode,200);
    assert.equal((await send('/api/vaults',{headers:{'x-tasks-account':randomUUID()}})).statusCode,409);
    assert.equal((await post('/api/vaults/record',{vaultId:source,record:{...wire,parent:randomUUID()}})).statusCode,409);
    const cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
    assert.equal((await app.inject({method:'POST',url:'/api/vaults/create',headers:{cookie,origin:'http://evil.invalid'},payload:v.header})).statusCode,403);
    const account=(await post('/api/auth/users/create',{login:'OtherVault',password:'Temporary9Pass'})).json().user;
    const adminJar=new Map(jar);await post('/api/auth/login',{login:'OtherVault',password:'Temporary9Pass'});
    assert.equal((await send('/api/vaults')).statusCode,403);
    await post('/api/auth/change-password',{currentPassword:'Temporary9Pass',password:'Permanent9Pass',repeatPassword:'Permanent9Pass',revokeOthers:true});
    assert.deepEqual((await send('/api/vaults')).json().vaults,[]);
    assert.equal((await send('/api/vaults/'+source)).statusCode,404);
    assert.equal((await post('/api/vaults/label',{vaultId:source,displayName:'Foreign rename'})).statusCode,404);
    assert.equal((await post('/api/vaults/create',v.header)).statusCode,409);
    jar.clear();for(const [k,v]of adminJar)jar.set(k,v);
    await post('/api/auth/login',credentials);
    assert.notEqual(account.id,user.id);
  });
  await t.test('lost write acknowledgment retries safely and parallel device edits keep both heads',async()=>{
    let s=await readState(user.id),v=s.vaults[0];
    await saveNote(user,source,v.records[0].objectId,base.id,{title:'A',text:'device A'});
    lose='/api/vaults/record';await assert.rejects(synchronize(user));await synchronize(user);
    const deviceA=await readState(user.id);
    await writeState(deviceB);offline=true;
    await saveNote(user,source,v.records[0].objectId,base.id,{title:'B',text:'device B'});
    await assert.rejects(synchronize(user));offline=false;await synchronize(user);
    s=await readState(user.id);v=s.vaults[0];assert.equal(heads(v).length,2);
    assert.deepEqual(new Set(await Promise.all(heads(v).map(async r=>(await readNote(user.id,v,r)).title))),new Set(['A','B']));
    await writeState(deviceA);await synchronize(user);deviceB=await readState(user.id);
  });
  await t.test('transfer loss/retry deletes source only after target saved, stale device gets encrypted persistent stash',async()=>{
    const before=await readState(user.id),original=before.vaults[0],head=heads(original)[0];
    const local=await saveNote(user,source,head.objectId,head.id,{title:'Only in transfer snapshot',text:'Not uploaded into source'});
    const destination=await transferVault(user,source,'Новый дом','abcdef');
    lose='/api/vaults/record';await assert.rejects(synchronize(user));
    assert.equal((await send('/api/vaults')).json().vaults.find(v=>v.id===source).deleted,false);
    assert.ok(!(await send('/api/vaults/'+source)).json().records.some(r=>r.id===local.id));
    lose='/api/vaults/transfer';await assert.rejects(synchronize(user));
    await synchronize(user);
    const remote=(await send('/api/vaults')).json().vaults;
    assert.equal(remote.find(v=>v.id===source).deleted,true);
    assert.equal(remote.find(v=>v.id===source).header,null);
    assert.equal((await send('/api/vaults/'+source)).statusCode,410);
    assert.equal((await send('/api/vaults/'+destination)).json().records.length,2);
    const after=await readState(user.id),dest=after.vaults.find(v=>v.header.id===destination);
    assert.ok((await Promise.all(heads(dest).map(r=>readNote(user.id,dest,r)))).some(n=>n.text==='Not uploaded into source'));
    await writeState(deviceB);const v=deviceB.vaults[0], r=heads(v)[0];
    await saveNote(user,source,r.objectId,r.id,{title:'Forgotten offline edit',text:'Never sent'});
    await synchronize(user);let s=await readState(user.id);
    assert.equal(s.stash.length,1);assert.equal(s.vaults[0].key,undefined);
    const {author,...plain}=await readStash(s,s.stash[0].id);assert.deepEqual(plain,{title:'Forgotten offline edit',text:'Never sent'});assert.equal(author.name,'Устройство');
    assert.ok(!JSON.stringify(s).includes('Never sent'));
    await closeVault(user,target);await assert.rejects(moveStash(user,s.stash[0].id,target));
    assert.equal((await readState(user.id)).stash.length,1);
    await openVault(user,target,'123456');await moveStash(user,s.stash[0].id,target);await synchronize(user);
    s=await readState(user.id);assert.equal(s.stash.length,0);
    assert.equal((await readNote(user.id,s.vaults[1],heads(s.vaults[1])[0])).text,'Never sent');
    assert.equal((await post('/api/vaults/create',v.header)).statusCode,410);
  });
  await t.test('closed deleted source remains recoverable by phrase; late drafts stash and explicit deletion works',async()=>{
    await writeState(deviceB);const v=deviceB.vaults[0],r=heads(v)[0];
    await saveNote(user,source,r.objectId,r.id,{title:'Closed',text:'preserve encrypted'});
    await closeVault(user,source);await synchronize(user);
    let s=await readState(user.id);assert.equal(s.stash.length,0);assert.ok(s.vaults[0].records.some(r=>r.pending));
    await openVault(user,source,'      ');s=await readState(user.id);assert.equal(s.stash.length,1);
    await discardStash(user,s.stash[0].id);assert.equal((await readState(user.id)).stash.length,0);
    await saveNote(user,source,randomUUID(),null,{title:'Late draft',text:'close in another tab'});
    assert.equal((await readState(user.id)).stash.length,1);
  });
  await t.test('failed IndexedDB write preserves the stash and does not add a half-written destination',async()=>{
    let s=await readState(user.id),sid=s.stash[0].id;
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(){throw new DOMException('Quota exceeded','QuotaExceededError');};
    try { await assert.rejects(moveStash(user,sid,target)); } finally { IDBObjectStore.prototype.put=put; }
    const after=await readState(user.id);assert.equal(after.stash.length,s.stash.length);
    assert.equal(after.vaults.find(v=>v.header.id===target).records.length,s.vaults.find(v=>v.header.id===target).records.length);
  });
  await t.test('closing one vault preserves other keys; a late editor draft stays encrypted under the closed vault, never in stash',async()=>{
    const local=await createVault(user,'Закрываемое','abcdef');
    const before=await readState(user.id),opened=before.vaults.find(v=>v.header.id===local);
    await closeVault(user,local);
    await saveNote(user,local,randomUUID(),null,{title:'Last draft',text:'Private while locked'},opened.key);
    let after=await readState(user.id),closed=after.vaults.find(v=>v.header.id===local);
    assert.equal(closed.key,undefined);assert.equal(after.stash.length,before.stash.length);
    assert.equal(after.vaults.find(v=>v.header.id===target).key.extractable,false);
    assert.ok(!JSON.stringify(after).includes('Private while locked'));
    await assert.rejects(readNote(user.id,closed,heads(closed)[0]));
    await openVault(user,local,'abcdef');after=await readState(user.id);closed=after.vaults.find(v=>v.header.id===local);
    assert.equal((await readNote(user.id,closed,heads(closed)[0])).text,'Private while locked');
  });
  await t.test('SQLite records and backup keep note content encrypted; vault labels are intentional metadata',async()=>{
    const db=new DatabaseSync(join(dir,'tasks.sqlite'));
    const wire=JSON.stringify(db.prepare('SELECT * FROM vaults').all())+JSON.stringify(db.prepare('SELECT * FROM records').all());
    for(const plain of [secret.title,secret.text,'PRIVATE VAULT 87654','Forgotten offline edit'])assert.ok(!wire.includes(plain));
    const before=db.prepare('SELECT * FROM installation').get();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);db.close();
    const {createBackup}=await import('../server/cli/backup.mjs');const file=join(dir,'copy.sqlite');
    await createBackup(join(dir,'tasks.sqlite'),file);const bytes=await readFile(file);assert.ok(!bytes.includes(Buffer.from(secret.text)));
    assert.ok(before.installation_id);
  });
  await t.test('global close revokes grants immediately, needs account password, is idempotent and reopens devices independently',async()=>{
    const vid=await createVault(user,'Global lock test','abcdef');await synchronize(user);
    let a=await readState(user.id),b=structuredClone(a);b.deviceId=randomUUID();
    const challenge=(await post('/api/vaults/access/challenge',{vaultId:vid,deviceId:a.deviceId})).json().challenge;
    await assert.rejects(closeAllVault(user,vid,'Wrong9Password'),/пароль/);
    assert.equal((await send('/api/vaults')).json().vaults.find(v=>v.id===vid).epoch,0);
    const operation=(await readState(user.id)).vaults.find(v=>v.header.id===vid).closeOperation;
    lose='/api/vaults/close-all';await assert.rejects(closeAllVault(user,vid,credentials.password));
    assert.equal((await send('/api/vaults/'+vid)).statusCode,423);
    assert.equal((await post('/api/vaults/access/grant',{vaultId:vid,deviceId:a.deviceId,challengeId:challenge[6],signature:Buffer.alloc(64).toString('base64url')})).statusCode,403);
    await closeAllVault(user,vid,credentials.password);
    assert.equal((await send('/api/vaults')).json().vaults.find(v=>v.id===vid).epoch,1);
    assert.ok(operation);assert.equal((await readState(user.id)).vaults.find(v=>v.header.id===vid).key,undefined);
    await openVault(user,vid,'abcdef');await synchronize(user);a=await readState(user.id);
    const tokenA=a.vaults.find(v=>v.header.id===vid).grant;
    assert.equal((await send('/api/vaults/'+vid,{headers:{'x-tasks-device':a.deviceId,'x-vault-grants':JSON.stringify({[vid]:tokenA})}})).statusCode,200);
    await writeState(b);await assert.rejects(synchronize(user),/закрыто/);
    b=await readState(user.id);assert.equal(b.vaults.find(v=>v.header.id===vid).key,undefined);
    assert.ok(b.vaults.find(v=>v.header.id===target).key);
    await openVault(user,vid,'abcdef');await synchronize(user);b=await readState(user.id);
    const tokenB=b.vaults.find(v=>v.header.id===vid).grant;assert.ok(tokenB&&tokenB!==tokenA);
    assert.equal((await send('/api/vaults/'+vid,{headers:{'x-tasks-device':a.deviceId,'x-vault-grants':JSON.stringify({[vid]:tokenA})}})).statusCode,200);
    await closeAllVault(user,vid,credentials.password);
    assert.equal((await send('/api/vaults/'+vid,{headers:{'x-tasks-device':a.deviceId,'x-vault-grants':JSON.stringify({[vid]:tokenA})}})).statusCode,423);
    const invalid=(await post('/api/vaults/access/challenge',{vaultId:vid,deviceId:b.deviceId})).json().challenge;
    assert.equal((await post('/api/vaults/access/grant',{vaultId:vid,deviceId:b.deviceId,challengeId:invalid[6],signature:Buffer.alloc(64).toString('base64url')})).statusCode,403);
    await openVault(user,vid,'abcdef');await synchronize(user);
  });
  await t.test('proofs expire, are single-use, and revocation during upload preserves the pending edit',async()=>{
    const vid=await createVault(user,'Race','abcdef');await synchronize(user);
    await closeAllVault(user,vid,credentials.password);await openVault(user,vid,'abcdef');await synchronize(user);
    const state=await readState(user.id),v=state.vaults.find(v=>v.header.id===vid);
    const proofDevice=randomUUID();
    const proof=async()=>{
      const challenge=(await post('/api/vaults/access/challenge',{vaultId:vid,deviceId:proofDevice})).json().challenge;
      const signature=await signAccess(v.key,context(user.id,v.header,v.header.keyId,v.header.keyId),v.access,challenge);
      return{vaultId:vid,deviceId:proofDevice,challengeId:challenge[6],signature};
    };
    const valid=await proof();assert.equal((await post('/api/vaults/access/grant',valid)).statusCode,200);
    assert.equal((await post('/api/vaults/access/grant',valid)).statusCode,403);
    const expired=await proof();now+=60001;
    assert.equal((await post('/api/vaults/access/grant',expired)).statusCode,403);
    await openVault(user,vid,'abcdef');await synchronize(user);
    const revision=await saveNote(user,vid,randomUUID(),null,{title:'Pending',text:'Keep after revocation'});
    let arrived,release;const seen=new Promise(resolve=>{arrived=resolve;});const wait=new Promise(resolve=>{release=resolve;});
    gate={path:'/api/vaults/record',arrived,wait};const running=synchronize(user);await seen;
    try{await closeAllVault(user,vid,credentials.password);}finally{release();}
    await assert.rejects(running,/закрыто/);
    const locked=(await readState(user.id)).vaults.find(v=>v.header.id===vid);
    assert.equal(locked.key,undefined);assert.equal(locked.records.find(r=>r.id===revision.id).pending,true);
    await openVault(user,vid,'abcdef');await synchronize(user);
    assert.equal((await readState(user.id)).vaults.find(v=>v.header.id===vid).records.find(r=>r.id===revision.id).pending,false);
  });
  await t.test('network waits do not block local encrypted writes; a failing vault does not stop another outbox',async()=>{
    const slow=await createVault(user,'Slow','abcdef'),healthy=await createVault(user,'Healthy','abcdef');await synchronize(user);
    let arrived,release;
    const seen=new Promise(resolve=>{arrived=resolve;});const wait=new Promise(resolve=>{release=resolve;});
    gate={path:'/api/vaults/'+slow,arrived,wait};const running=synchronize(user);await seen;
    let timer;try{await Promise.race([saveNote(user,healthy,randomUUID(),null,{title:'During network wait',text:'Saved locally'}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('data lock held during network wait')),1000);})]);}
    finally{clearTimeout(timer);release();}await running;
    const fresh=await saveNote(user,healthy,randomUUID(),null,{title:'Healthy queue',text:'Independent'});
    failPath='/api/vaults/'+slow;try{await assert.rejects(synchronize(user),/server_error/);}finally{failPath='';}
    const s=await readState(user.id);assert.equal(s.vaults.find(v=>v.header.id===healthy).records.find(r=>r.id===fresh.id).pending,false);
    assert.ok(s.vaults.find(v=>v.header.id===slow).syncError);await synchronize(user);
  });
  await t.test('conflict choice and keeping both preserve history, authenticate links and retain concurrent resolutions',async()=>{
    const vid=await createVault(user,'Conflicts','abcdef'),oid=randomUUID();await renameDevice(user,'Phone');
    const base=await saveNote(user,vid,oid,null,{title:'Base',text:'Base'});
    await saveNote(user,vid,oid,base.id,{title:'First',text:'One'});await renameDevice(user,'Computer');
    await saveNote(user,vid,oid,base.id,{title:'Second',text:'Two'});await synchronize(user);
    const before=await readState(user.id),v=before.vaults.find(v=>v.header.id===vid),versions=heads(v).map(r=>r.id);
    assert.equal(versions.length,2);
    assert.equal((await readNote(user.id,v,heads(v)[0])).author.name,'Phone');
    assert.equal((await readNote(user.id,v,heads(v)[1])).author.name,'Computer');
    await resolveConflict(user,vid,oid,versions,versions[0],false);await synchronize(user);
    let after=await readState(user.id),resolved=after.vaults.find(v=>v.header.id===vid);assert.equal(heads(resolved).length,1);assert.equal(resolved.records.length,4);
    const r=heads(resolved)[0];await assert.rejects(readNote(user.id,resolved,{...r,resolves:[]}));
    await assert.rejects(resolveConflict(user,vid,oid,versions,versions[0],true),/изменился/);
    await writeState(before);await resolveConflict(user,vid,oid,versions,versions[1],false);await synchronize(user);
    after=await readState(user.id);resolved=after.vaults.find(v=>v.header.id===vid);assert.equal(heads(resolved).length,2);
    const headsBefore=heads(resolved).map(r=>r.id),history=resolved.records.length;
    await resolveConflict(user,vid,oid,headsBefore,headsBefore[0],true);lose='/api/vaults/record';await assert.rejects(synchronize(user));await synchronize(user);
    after=await readState(user.id);resolved=after.vaults.find(v=>v.header.id===vid);assert.equal(heads(resolved).length,2);
    assert.equal(new Set(heads(resolved).map(r=>r.objectId)).size,2);assert.equal(resolved.records.length,history+2);
  });
  await t.test('encrypted reminder metadata survives sync; transfer keeps it disabled and deletes the source schedule',async()=>{
    const vid=await createVault(user,'Reminder source','abcdef'),oid=randomUUID();
    const reminder={id:randomUUID(),state:'active',local:'2026-12-20T09:30',mode:'custom',text:'EXPLICIT PUSH 4812'};
    await saveNote(user,vid,oid,null,{title:'PRIVATE REMINDER NOTE',text:'encrypted body',reminder});lose='/api/reminders/set';await assert.rejects(synchronize(user));
    assert.equal((await readState(user.id)).vaults.find(v=>v.header.id===vid).records.some(r=>r.reminderPending),true);await synchronize(user);
    let s=await readState(user.id),v=s.vaults.find(v=>v.header.id===vid),value=await readNote(user.id,v,heads(v)[0]);
    assert.deepEqual(value.reminder,reminder);assert.equal(v.records.some(r=>r.reminderPending),false);
    offline=true;await acknowledgeReminder(user,{vaultId:vid,objectId:oid,configId:reminder.id});
    assert.equal((await readState(user.id)).reminderSeen.length,1);offline=false;await synchronize(user);
    assert.equal((await readState(user.id)).reminderSeen.length,0);
    let probe=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});
    assert.equal(probe.prepare('SELECT body FROM reminders WHERE vault_id=?').get(vid).body,reminder.text);
    assert.ok(!probe.prepare('SELECT payload FROM records WHERE vault_id=?').get(vid).payload.includes('PRIVATE REMINDER NOTE'));probe.close();
    const destination=await transferVault(user,vid,'Reminder destination','ghijkl');await synchronize(user);
    s=await readState(user.id);v=s.vaults.find(v=>v.header.id===destination);value=await readNote(user.id,v,heads(v)[0]);
    assert.equal(value.reminder.state,'off');assert.notEqual(value.reminder.id,reminder.id);
    probe=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});
    assert.equal(probe.prepare('SELECT 1 FROM reminders WHERE vault_id=?').get(vid),undefined);
    assert.equal(probe.prepare('SELECT plan_state FROM reminders WHERE vault_id=?').get(destination).plan_state,'off');probe.close();
  });
  await t.test('vault-scoped encrypted tags, checklist, pinning and copy survive synchronization',async()=>{
    const vid=await createVault(user,'Организация','abcdef');let s=await readState(user.id),v=s.vaults.find(item=>item.header.id===vid);
    const defaults=await readTags(user.id,v);assert.ok(defaults.some(tag=>tag.name==='Работа'));assert.equal(await readVaultPushMode(user.id,v),'neutral');assert.equal(heads(v).length,0);
    await setVaultPushMode(user,vid,'title');s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);assert.equal(await readVaultPushMode(user.id,v),'title');
    const tagId=await createTag(user,vid,'PRIVATE TAG 7719','#123ABC');await renameTag(user,vid,tagId,'PRIVATE RENAMED TAG 8821','#ABC123');
    s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);const catalogRevision=v.records.filter(r=>r.objectId===v.header.id).at(-1);
    await saveNote(user,vid,v.header.id,catalogRevision.id,{title:'Служебные данные тегов',text:'Случайно сохранено старым клиентом'});
    s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);assert.equal((await readTags(user.id,v)).find(tag=>tag.id===tagId).name,'PRIVATE RENAMED TAG 8821');assert.equal(await readVaultPushMode(user.id,v),'title');assert.equal(heads(v).length,0);
    const reminder={id:randomUUID(),state:'active',local:'2027-01-20T11:15',mode:'neutral',text:''};
    const checklist=[{id:randomUUID(),text:'PRIVATE CHECK 6631',done:false},{id:randomUUID(),text:'Готово',done:true}];
    const saved=await saveNote(user,vid,randomUUID(),null,{title:'Организованная',text:'Основной текст',checklist,tagIds:[tagId],pinned:true,reminder});
    const copiedId=await copyNote(user,vid,saved.id);await synchronize(user);s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);
    assert.equal(heads(v).length,2);const original=await readNote(user.id,v,heads(v).find(r=>r.id===saved.id));
    const copied=await readNote(user.id,v,heads(v).find(r=>r.id===copiedId));assert.deepEqual(original.checklist,checklist);assert.deepEqual(original.tagIds,[tagId]);assert.equal(original.pinned,true);
    assert.deepEqual(copied.checklist,checklist);assert.deepEqual(copied.tagIds,[tagId]);assert.equal(copied.pinned,false);assert.equal(copied.reminder.state,'off');assert.notEqual(copied.reminder.id,reminder.id);
    assert.equal((await readTags(user.id,v)).find(tag=>tag.id===tagId).name,'PRIVATE RENAMED TAG 8821');
    const probe=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});try{const payloads=probe.prepare('SELECT payload FROM records WHERE vault_id=?').all(vid).map(row=>row.payload).join('');
      assert.ok(!payloads.includes('PRIVATE RENAMED TAG 8821'));assert.ok(!payloads.includes('PRIVATE CHECK 6631'));}finally{probe.close();}
    const beforeConcurrent=await readState(user.id);offline=true;await deleteTag(user,vid,tagId);const deletedOnDevice=await readState(user.id);
    await writeState(beforeConcurrent);await renameTag(user,vid,tagId,'Старая офлайн-правка','#654321');offline=false;await synchronize(user);
    await writeState(deletedOnDevice);await synchronize(user);s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);
    assert.equal((await readTags(user.id,v)).find(tag=>tag.id===tagId).deleted,true);assert.deepEqual((await readNote(user.id,v,heads(v)[0])).tagIds,[tagId]);
  });
  await t.test('projects and tasks stay E2EE, move safely, and project deletion can preserve contents',async()=>{
    const vid=await createVault(user,'Планировщик','abcdef');
    const project=await createProject(user,vid,{title:'PRIVATE PROJECT 1701',description:'PRIVATE PROJECT BODY 1702',favorite:true,startDate:'2027-04-01',endDate:'2027-04-30'});
    const task=await createTask(user,vid,{title:'PRIVATE TASK 1703',description:'PRIVATE TASK BODY 1704',projectId:project.objectId,status:'in_progress',priority:'high',startDate:'2027-04-02',endDate:'2027-04-05',checklist:[{id:randomUUID(),text:'PRIVATE TASK CHECK 1705',done:false}]});
    let model=await readProjectWorkspace(user,vid);assert.equal(model.projects.length,1);assert.equal(model.tasks.length,1);assert.equal(model.notes.length,0);
    assert.equal(model.projects[0].value.project.favorite,true);assert.equal(model.tasks[0].value.projectId,project.objectId);assert.equal(model.tasks[0].value.task.status,'in_progress');
    let local=await readState(user.id),encrypted=JSON.stringify(local.vaults.find(v=>v.header.id===vid).records);
    assert.ok(!encrypted.includes('PRIVATE PROJECT 1701'));assert.ok(!encrypted.includes('PRIVATE PROJECT BODY 1702'));assert.ok(!encrypted.includes('PRIVATE TASK 1703'));assert.ok(!encrypted.includes('PRIVATE TASK BODY 1704'));assert.ok(!encrypted.includes('PRIVATE TASK CHECK 1705'));
    await updateProject(user,vid,project.objectId,{title:'Проект после правки',description:'Описание',favorite:false,startDate:'2027-04-01',endDate:'2027-05-01'});
    await updateTask(user,vid,task.objectId,{title:'Задача после правки',description:'Текст',status:'done',priority:'medium',startDate:'2027-04-02',endDate:'2027-04-06'});
    await movePlannerObject(user,vid,task.objectId);model=await readProjectWorkspace(user,vid);
    assert.equal(model.tasks[0].value.projectId,undefined);assert.equal(model.tasks[0].value.task.status,'done');
    await movePlannerObject(user,vid,task.objectId,project.objectId);await deleteProject(user,vid,project.objectId,false);model=await readProjectWorkspace(user,vid);
    assert.equal(model.projects.length,1);assert.equal(model.projects[0].lifecycle,'trashed');assert.equal(model.tasks.length,1);assert.equal(model.tasks[0].value.projectId,undefined);
    await edit(user,async s=>{s.vaults=s.vaults.filter(v=>v.header.id!==vid);});
  });
  await t.test('task dependencies stay E2EE, reject invalid graphs, protect moves, and anchored reminders follow rescheduling',async()=>{
    const vid=await createVault(user,'Гант','abcdef');
    const project=await createProject(user,vid,{title:'PRIVATE GANTT PROJECT 1901',favorite:false,calendar:'weekdays'});
    const other=await createProject(user,vid,{title:'Другой проект',favorite:false});
    const first=await createTask(user,vid,{title:'PRIVATE GANTT A 1902',projectId:project.objectId,status:'todo',priority:'medium',startDate:'2027-04-02',endDate:'2027-04-02'});
    const reminder={id:randomUUID(),state:'active',local:'2027-04-06T09:00',mode:'neutral',text:''};
    const second=await createTask(user,vid,{title:'PRIVATE GANTT B 1903',projectId:project.objectId,status:'in_progress',priority:'high',startDate:'2027-04-05',endDate:'2027-04-06',
      dependencies:[{taskId:first.objectId,type:'FS',lagDays:0}],reminder,reminderAnchor:'end'});
    let model=await readProjectWorkspace(user,vid);
    assert.equal(model.projects.find(item=>item.revision.objectId===project.objectId).value.project.calendar,'weekdays');
    assert.deepEqual(model.tasks.find(item=>item.revision.objectId===second.objectId).value.task.dependencies,[{taskId:first.objectId,type:'FS',lagDays:0}]);
    await assert.rejects(updateTask(user,vid,first.objectId,{title:'A',description:'',projectId:project.objectId,status:'todo',priority:'medium',startDate:'2027-04-02',endDate:'2027-04-02',
      dependencies:[{taskId:second.objectId,type:'FS',lagDays:0}]}),/цикл/i);
    await assert.rejects(createTask(user,vid,{title:'Cross-project',projectId:other.objectId,status:'todo',priority:'none',dependencies:[{taskId:first.objectId,type:'FS',lagDays:0}]}),/того же проекта/i);
    await assert.rejects(movePlannerObject(user,vid,first.objectId,other.objectId),/последователями/i);
    await rescheduleTasks(user,vid,[{objectId:second.objectId,startDate:'2027-04-08',endDate:'2027-04-09'}]);
    model=await readProjectWorkspace(user,vid);
    const shifted=model.tasks.find(item=>item.revision.objectId===second.objectId).value;
    assert.equal(shifted.reminder.local,'2027-04-09T09:00');assert.equal(shifted.task.reminderAnchor,'end');
    await updateTask(user,vid,second.objectId,{title:shifted.title,description:shifted.text,projectId:project.objectId,status:shifted.task.status,priority:shifted.task.priority,
      startDate:shifted.task.startDate,endDate:shifted.task.endDate,reminder:shifted.reminder,reminderAnchor:'end',dependencies:[]});
    await movePlannerObject(user,vid,first.objectId,other.objectId);
    model=await readProjectWorkspace(user,vid);assert.equal(model.tasks.find(item=>item.revision.objectId===first.objectId).value.projectId,other.objectId);
    const local=await readState(user.id),encrypted=JSON.stringify(local.vaults.find(v=>v.header.id===vid).records);
    assert.ok(!encrypted.includes('PRIVATE GANTT PROJECT 1901'));assert.ok(!encrypted.includes('PRIVATE GANTT A 1902'));assert.ok(!encrypted.includes('PRIVATE GANTT B 1903'));
    await edit(user,async s=>{s.vaults=s.vaults.filter(v=>v.header.id!==vid);});
  });
  await t.test('archive, trash, encrypted history and permanent purge survive offline synchronization',async()=>{
    const vid=await createVault(user,'Жизненный цикл','abcdef'),oid=randomUUID(),reminder={id:randomUUID(),state:'active',local:'2027-03-20T10:00',mode:'neutral',text:''};
    const first=await saveNote(user,vid,oid,null,{title:'Первая версия',text:'Секретная история',reminder});await synchronize(user);
    let s=await readState(user.id),v=s.vaults.find(item=>item.header.id===vid),base=heads(v)[0];
    await saveNote(user,vid,oid,base.id,{...(await readNote(user.id,v,base)),title:'Вторая версия'});await archiveNote(user,vid,oid);await synchronize(user);
    s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);let head=heads(v)[0],value=await readNote(user.id,v,head);
    assert.equal(noteLifecycle(v,head,value),'archived');assert.equal(value.reminder.state,'off');
    await restoreArchivedNote(user,vid,oid,true);await synchronize(user);s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);head=heads(v)[0];value=await readNote(user.id,v,head);
    assert.equal(noteLifecycle(v,head,value),'active');assert.equal(value.reminder.state,'active');
    const beforeRestore=v.records.length;await restoreNoteVersion(user,vid,oid,first.id);s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);head=heads(v)[0];value=await readNote(user.id,v,head);
    assert.equal(value.title,'Первая версия');assert.equal(value.reminder.state,'off');assert.equal(v.records.length,beforeRestore+1);assert.ok((await noteHistory(user.id,v,oid)).length>=5);
    await synchronize(user);const stale=await readState(user.id);await trashNote(user,vid,oid);await synchronize(user);
    s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);head=heads(v)[0];value=await readNote(user.id,v,head);
    assert.equal(noteLifecycle(v,head,value),'trashed');assert.equal(v.objectStates[oid].state,'trash');assert.equal(v.objectStates[oid].purgeAfter-v.objectStates[oid].trashedAt,30*86400000);
    let probe=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(probe.prepare('SELECT plan_state FROM reminders WHERE vault_id=? AND object_id=?').get(vid,oid).plan_state,'off');probe.close();
    await restoreTrashedNote(user,vid,oid);await synchronize(user);s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);assert.equal(v.objectStates[oid].state,'active');
    await trashNote(user,vid,oid);await synchronize(user);await permanentlyDeleteNote(user,vid,oid);await synchronize(user);
    probe=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(probe.prepare('SELECT count(*) n FROM records WHERE vault_id=? AND object_id=?').get(vid,oid).n,0);assert.equal(probe.prepare('SELECT state FROM note_lifecycle WHERE vault_id=? AND object_id=?').get(vid,oid).state,'purged');probe.close();
    const automatic=randomUUID();await saveNote(user,vid,automatic,null,{title:'Автоочистка',text:'30 дней'});await synchronize(user);await trashNote(user,vid,automatic);await synchronize(user);
    probe=new DatabaseSync(join(dir,'tasks.sqlite'));probe.prepare('UPDATE note_lifecycle SET purge_after=? WHERE vault_id=? AND object_id=?').run(now,vid,automatic);probe.close();await synchronize(user);
    probe=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(probe.prepare('SELECT state FROM note_lifecycle WHERE vault_id=? AND object_id=?').get(vid,automatic).state,'purged');assert.equal(probe.prepare('SELECT count(*) n FROM records WHERE vault_id=? AND object_id=?').get(vid,automatic).n,0);probe.close();
    await writeState(stale);offline=true;const staleVault=(await readState(user.id)).vaults.find(item=>item.header.id===vid),staleHead=heads(staleVault)[0];await saveNote(user,vid,oid,staleHead.id,{...(await readNote(user.id,staleVault,staleHead)),title:'Офлайн после удаления'});offline=false;await synchronize(user);
    s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);assert.equal(v.records.some(record=>record.objectId===oid),false);
    const rescued=await Promise.all(s.stash.map(item=>readStash(s,item.id)));assert.ok(rescued.some(note=>note.title==='Офлайн после удаления'));
  });
  await t.test('legacy names backfill from an unlocked device and reach a fresh locked device',async()=>{
    const vid=await createVault(user,'Узнаваемое хранилище','abcdef');await synchronize(user);
    const probe=new DatabaseSync(join(dir,'tasks.sqlite'));
    try{probe.prepare('DELETE FROM vault_labels WHERE vault_id=?').run(vid);}finally{probe.close();}
    await edit(user,async s=>{delete s.vaults.find(v=>v.header.id===vid).displayName;});
    await synchronize(user);
    const first=await readState(user.id);
    assert.equal(first.vaults.find(v=>v.header.id===vid).displayName,'Узнаваемое хранилище');
    await writeState({user,vaults:[],stash:[],deviceId:randomUUID()});
    // Other vaults were globally locked earlier; names must arrive despite their missing grants.
    await assert.rejects(synchronize(user),/закрыто на всех устройствах/);
    const second=await readState(user.id),locked=second.vaults.find(v=>v.header.id===vid);
    assert.equal(locked.key,undefined);assert.equal(await vaultName(user.id,locked),'Узнаваемое хранилище (закрыто)');
    await writeState(first);
  });
  await t.test('vault deletion requires an open local key and cryptographic vault proof',async()=>{
    const vid=await createVault(user,'Удаляемое хранилище','abcdef'),oid=randomUUID();
    await saveNote(user,vid,oid,null,{title:'Удаляемая заметка',text:'Содержимое'});await synchronize(user);
    let s=await readState(user.id),snapshot;
    const direct=await post('/api/vaults/delete',{vaultId:vid,confirmed:true});assert.equal(direct.statusCode,423);
    await closeVault(user,vid);await assert.rejects(deleteVault(user,vid),/только открытое/);
    await openVault(user,vid,'abcdef');snapshot=structuredClone(await readState(user.id));
    lose='/api/vaults/delete';await assert.rejects(deleteVault(user,vid),/lost response/);
    let remote=(await send('/api/vaults')).json().vaults.find(v=>v.id===vid);assert.equal(remote.deleted,true);assert.ok((await readState(user.id)).vaults.some(v=>v.header.id===vid));
    await deleteVault(user,vid);s=await readState(user.id);assert.equal(s.vaults.some(v=>v.header.id===vid),false);
    remote=(await send('/api/vaults')).json().vaults.find(v=>v.id===vid);assert.equal(remote.deleted,true);assert.equal(remote.header,null);
    let probe=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});
    assert.equal(probe.prepare('SELECT count(*) n FROM records WHERE vault_id=?').get(vid).n,0);
    assert.equal(probe.prepare('SELECT count(*) n FROM vault_labels WHERE vault_id=?').get(vid).n,0);probe.close();
    assert.equal((await post('/api/vaults/delete',{vaultId:vid,confirmed:true})).statusCode,200);
    await writeState(snapshot);await synchronize(user);s=await readState(user.id);
    const stale=s.vaults.find(v=>v.header.id===vid);assert.equal(stale.deleted,true);assert.equal(stale.key,undefined);assert.equal(stale.records.length,0);
  });
  await t.test('re-login review blocks the outbox until each local note is accepted or rejected',async()=>{
    const vid=await createVault(user,'Проверка очереди','abcdef'),oid=randomUUID();await saveNote(user,vid,oid,null,{title:'Серверная версия',text:'До офлайна'});await synchronize(user);
    let s=await readState(user.id),v=s.vaults.find(item=>item.header.id===vid),head=heads(v)[0];
    await requireOutboxReview(user);await saveNote(user,vid,oid,head.id,{title:'Отклоняемая версия',text:'Локально после отзыва'});
    await assert.rejects(synchronize(user),error=>error instanceof OutboxReviewRequired);assert.equal((await send('/api/vaults/'+vid)).json().records.length,1);
    let review=await outboxReviewItems(user);assert.equal(review.length,1);assert.equal(review[0].server.title,'Серверная версия');assert.equal(review[0].local.title,'Отклоняемая версия');
    assert.equal(await decideOutboxReview(user,review[0].key,false),true);await synchronize(user);assert.equal((await send('/api/vaults/'+vid)).json().records.length,1);
    s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);head=heads(v)[0];assert.equal((await readNote(user.id,v,head)).title,'Серверная версия');
    await requireOutboxReview(user);await saveNote(user,vid,oid,head.id,{title:'Принятая версия',text:'Отправить после подтверждения'});
    await assert.rejects(synchronize(user),error=>error instanceof OutboxReviewRequired);review=await outboxReviewItems(user);assert.equal(review[0].local.title,'Принятая версия');
    assert.equal(await decideOutboxReview(user,review[0].key,true),true);await synchronize(user);assert.equal((await send('/api/vaults/'+vid)).json().records.length,2);
    s=await readState(user.id);v=s.vaults.find(item=>item.header.id===vid);head=heads(v)[0];assert.equal((await readNote(user.id,v,head)).title,'Принятая версия');assert.equal(head.pending,false);
  });
});
