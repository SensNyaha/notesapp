import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,randomBytes,createECDH } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { zonedTime } from '../shared/reminders.mjs';

const origin='https://notes.example.test';
const b64=n=>randomBytes(n).toString('base64url');
function header(){const id=randomUUID();return{id,keyId:randomUUID(),revisionId:randomUUID(),wrapper:{v:1,alg:'A256GCM',purpose:'phrase',iv:b64(12),ciphertext:b64(48),kdf:{name:'PBKDF2-SHA256',iterations:600000,salt:b64(16)}},name:{v:2,key:b64(40),iv:b64(12),ciphertext:b64(16)}};}
function record(objectId,parent=null,resolves){return{id:randomUUID(),objectId,parent,sealed:{v:2,key:b64(40),iv:b64(12),ciphertext:b64(16)},...(resolves?{resolves}:{})};}
function subscription(){const key=createECDH('prime256v1');key.generateKeys();return{endpoint:'https://web.push.apple.com/'+randomUUID(),keys:{p256dh:key.getPublicKey().toString('base64url'),auth:b64(16)}};}

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'tasks-reminders-'));let now=Date.parse('2026-09-13T10:00:00Z'),app;
  const deliveries=[];
  const options={dataDir:dir,logger:false,clock:()=>now,auth:{origin,secure:true,bootstrap:{login:'ReminderAdmin',password:'Secret9Admin'}},
    push:{interval:0,send:async(...args)=>{deliveries.push(args);return{statusCode:201};}}};
  app=await createApp(options);const db=new DatabaseSync(join(dir,'tasks.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
  let address=1;
  function client(){const jar=new Map(),remoteAddress='127.0.0.'+(address++);let user;
    const request=async(path,body,headers={})=>{
      if(body!==undefined){const csrf=await request('/api/auth/csrf');headers={'x-csrf-token':csrf.json().csrf,'content-type':'application/json',...headers};}
      const response=await app.inject({url:path,method:body===undefined?'GET':'POST',remoteAddress,headers:{origin,cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(user?{'x-tasks-account':user.id}:{}),...headers},payload:body});
      for(const cookie of response.cookies){if(cookie.value)jar.set(cookie.name,cookie.value);else jar.delete(cookie.name);}return response;
    };
    return{request,get user(){return user;},async login(){const response=await request('/api/auth/login',{login:'ReminderAdmin',password:'Secret9Admin'});assert.equal(response.statusCode,200);user=response.json().user;}};
  }
  const a=client();await a.login();return{a,client,db,deliveries,get app(){return app;},advance(ms){now+=ms;},now:()=>now,
    async restart(){await app.close();app=await createApp(options);}};
}

test('reminders keep encrypted records opaque, follow the account timezone and pause on conflicts',async t=>{
  const f=await fixture(t),a=f.a,v=header(),objectId=randomUUID(),base=record(objectId);
  assert.deepEqual((await a.request('/api/reminders/settings')).json(),{zone:'UTC',nudge_hours:1});
  assert.equal((await a.request('/api/vaults/create',v)).statusCode,200);
  assert.equal((await a.request('/api/vaults/record',{vaultId:v.id,record:base})).statusCode,200);
  const config=randomUUID(),plan={id:config,state:'active',local:'2026-09-13T10:10',mode:'neutral',text:''};
  assert.equal((await a.request('/api/reminders/set',{vaultId:v.id,objectId,recordId:base.id,plan})).statusCode,200);
  let row=f.db.prepare('SELECT * FROM reminders').get();assert.equal(row.due_at,Date.parse('2026-09-13T10:10:00Z'));assert.equal(row.body,null);
  assert.ok(!f.db.prepare('SELECT payload FROM records').get().payload.includes('10:10'));
  assert.equal((await a.request('/api/reminders/zone',{zone:'Europe/Samara'})).statusCode,200);
  row=f.db.prepare('SELECT * FROM reminders').get();assert.equal(row.local_at,'2026-09-13T10:10');assert.equal(row.due_at,Date.parse('2026-09-13T06:10:00Z'));
  const first=record(objectId,base.id),second=record(objectId,base.id);
  await a.request('/api/vaults/record',{vaultId:v.id,record:first});await a.request('/api/vaults/record',{vaultId:v.id,record:second});
  assert.equal(f.db.prepare('SELECT paused FROM reminders').get().paused,1);
  assert.equal((await a.request('/api/reminders/set',{vaultId:v.id,objectId,recordId:first.id,plan})).statusCode,409);
  const resolved=record(objectId,first.id,[second.id]);await a.request('/api/vaults/record',{vaultId:v.id,record:resolved});
  assert.equal((await a.request('/api/reminders/set',{vaultId:v.id,objectId,recordId:resolved.id,plan})).statusCode,200);
  row=f.db.prepare('SELECT record_id,paused FROM reminders').get();assert.equal(row.record_id,resolved.id);assert.equal(row.paused,0);
});

test('one-time reminders reach every subscribed session, repeat at the account interval and stop on open',async t=>{
  const f=await fixture(t),a=f.a,b=f.client(),v=header(),objectId=randomUUID(),base=record(objectId),subA=subscription(),subB=subscription();await b.login();
  await a.request('/api/push/subscribe',{deviceId:randomUUID(),subscription:subA});await b.request('/api/push/subscribe',{deviceId:randomUUID(),subscription:subB});
  await a.request('/api/vaults/create',v);await a.request('/api/vaults/record',{vaultId:v.id,record:base});await a.request('/api/reminders/zone',{zone:'UTC'});
  const config=randomUUID(),plan={id:config,state:'active',local:'2026-09-13T10:01',mode:'custom',text:'Пора действовать'};
  await a.request('/api/reminders/set',{vaultId:v.id,objectId,recordId:base.id,plan});
  await f.restart();f.advance(60000);await f.app.runPushTests();await f.app.runPushTests();
  assert.equal(f.deliveries.length,2);assert.deepEqual(new Set(f.deliveries.map(x=>x[0].endpoint)),new Set([subA.endpoint,subB.endpoint]));
  for(const [,payload] of f.deliveries)assert.deepEqual(JSON.parse(payload),{type:'tasks-reminder',accountId:a.user.id,vaultId:v.id,objectId,configId:config,body:'Пора действовать'});
  f.advance(3600000);await f.app.runPushTests();await f.app.runPushTests();assert.equal(f.deliveries.length,4);
  assert.equal((await b.request('/api/auth/refresh',{})).statusCode,200);assert.equal((await b.request('/api/auth/session')).statusCode,200);
  assert.equal((await b.request('/api/reminders/seen',{vaultId:v.id,objectId,configId:config})).statusCode,200);f.advance(3600000);await f.app.runPushTests();
  assert.equal(f.deliveries.length,4);assert.ok(f.db.prepare('SELECT seen_at FROM reminders').get().seen_at);
  assert.equal((await a.request('/api/auth/refresh',{})).statusCode,200);
  assert.equal((await a.request('/api/reminders/settings',{nudgeHours:0})).statusCode,200);
});

test('timezone conversion rejects DST gaps and chooses the first instant of a repeated local time',()=>{
  assert.equal(zonedTime('2026-03-29T02:30','Europe/Berlin'),null);
  assert.equal(zonedTime('2026-10-25T02:30','Europe/Berlin'),Date.parse('2026-10-25T00:30:00Z'));
});
