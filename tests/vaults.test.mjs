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
  readStash, moveStash, discardStash, edit, closeAllVault, resolveConflict, renameDevice, acknowledgeReminder, context } from '../src/planner.ts';
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
  t.after(async()=>{globalThis.fetch=originalFetch;changes?.close();await app.close();await rm(dir,{recursive:true,force:true});});
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
  await t.test('SQLite and backup contain ciphertext only',async()=>{
    const db=new DatabaseSync(join(dir,'tasks.sqlite'));
    const wire=JSON.stringify(db.prepare('SELECT * FROM vaults').all())+JSON.stringify(db.prepare('SELECT * FROM records').all());
    for(const plain of [secret.title,secret.text,'PRIVATE VAULT 87654','Forgotten offline edit'])assert.ok(!wire.includes(plain));
    const before=db.prepare('SELECT * FROM installation').get();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,7);db.close();
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
});
