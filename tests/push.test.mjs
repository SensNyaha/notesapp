import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createECDH } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { validEndpoint } from '../server/routes/push.mjs';

const origin='https://notes.example.test';
function subscription(host='web.push.apple.com'){
  const ecdh=createECDH('prime256v1');ecdh.generateKeys();
  return{endpoint:'https://'+host+'/'+randomUUID(),keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'tasks-push-'));let now=Date.now(),app;
  const deliveries=[];let behavior=async()=>({statusCode:201});
  const options={dataDir:dir,logger:false,clock:()=>now,auth:{origin,secure:true,bootstrap:{login:'PushAdmin',password:'Secret9Admin'}},
    push:{interval:0,send:async(...args)=>{deliveries.push(args);return behavior(...args);}}};
  app=await createApp(options);const db=new DatabaseSync(join(dir,'tasks.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
  let address=1;
  function client(){const jar=new Map(),remoteAddress='127.0.0.'+(address++);let user;
    const request=async(path,body,headers={})=>{
      if(body!==undefined){const csrf=await request('/api/auth/csrf');headers={'x-csrf-token':csrf.json().csrf,'content-type':'application/json',...headers};}
      const response=await app.inject({url:path,method:body===undefined?'GET':'POST',remoteAddress,
        headers:{origin,cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(user?{'x-tasks-account':user.id}:{}),...headers},payload:body});
      for(const c of response.cookies){if(c.value)jar.set(c.name,c.value);else jar.delete(c.name);}
      return response;
    };
    return{request,get user(){return user;},async login(login='PushAdmin',password='Secret9Admin'){
      const response=await request('/api/auth/login',{login,password});assert.equal(response.statusCode,200);user=response.json().user;
    }};
  }
  const admin=client();await admin.login();
  return{db,admin,client,deliveries,get app(){return app;},advance(ms){now+=ms;},behavior(fn){behavior=fn;},async restart(){await app.close();app=await createApp(options);}};
}

test('push isolates sessions/accounts, validates providers and keys, detaches without deleting local vaults',async t=>{
  const f=await fixture(t),a=f.admin,b=f.client(),deviceId=randomUUID(),sub=subscription();
  assert.equal((await b.request('/api/push/config')).statusCode,401);
  const publicConfig=(await a.request('/api/push/config')).json();assert.equal(publicConfig.enabled,true);assert.match(publicConfig.publicKey,/^[\w-]{87}$/);
  assert.equal(publicConfig.privateKey,undefined);
  assert.equal((await a.request('/api/push/subscribe',{deviceId,subscription:sub},{'x-csrf-token':'invalid'})).statusCode,403);
  assert.equal((await a.request('/api/push/subscribe',{deviceId,subscription:sub},{'x-tasks-account':randomUUID()})).statusCode,409);
  assert.equal((await a.request('/api/push/subscribe',{deviceId,subscription:{...sub,endpoint:'https://127.0.0.1/secret'}})).statusCode,400);
  assert.equal((await a.request('/api/push/subscribe',{deviceId,subscription:{...sub,keys:{...sub.keys,p256dh:Buffer.alloc(65).toString('base64url')}}})).statusCode,400);
  assert.equal((await a.request('/api/push/subscribe',{deviceId,subscription:sub})).statusCode,200);
  assert.equal((await a.request('/api/push/subscribe',{deviceId,subscription:sub})).statusCode,200);
  await b.login();
  assert.equal((await b.request('/api/push/status',{deviceId})).json().active,false);
  assert.equal((await b.request('/api/push/subscribe',{deviceId,subscription:sub})).statusCode,409);
  await a.request('/api/auth/users/create',{login:'PushUser',password:'Temporary9Pass'});
  const c=f.client();await c.login('PushUser','Temporary9Pass');
  assert.equal((await c.request('/api/push/config')).statusCode,403);
  await c.request('/api/auth/change-password',{currentPassword:'Temporary9Pass',password:'Permanent9Pass',repeatPassword:'Permanent9Pass',revokeOthers:true});
  assert.equal((await c.request('/api/push/subscribe',{deviceId,subscription:sub})).statusCode,409);
  const testId=randomUUID();await a.request('/api/push/test',{deviceId,operationId:testId});
  assert.equal((await a.request('/api/push/detach',{})).statusCode,200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM push_tests').get().n,0);
  assert.ok((await a.request('/api/auth/session')).json().user,'detach leaves account session available');
  assert.equal((await c.request('/api/push/subscribe',{deviceId,subscription:sub})).statusCode,200);
  await c.request('/api/auth/logout',{});
  assert.equal(f.db.prepare('SELECT count(*) n FROM push_subscriptions').get().n,0);
  for(const endpoint of ['http://web.push.apple.com/x','https://web.push.apple.com.evil.test/x','https://user@web.push.apple.com/x','https://web.push.apple.com:8443/x','https://fcm.googleapis.com/x#fragment','https://localhost/x'])assert.equal(validEndpoint(endpoint),false);
});

test('delayed push persists through restart, retries idempotently and never exposes note content',async t=>{
  const f=await fixture(t),a=f.admin,deviceId=randomUUID(),sub=subscription(),operationId=randomUUID();
  await a.request('/api/push/subscribe',{deviceId,subscription:sub});
  const publicKey=(await a.request('/api/push/config')).json().publicKey;
  const first=await a.request('/api/push/test',{deviceId,operationId});assert.equal(first.statusCode,200);
  assert.deepEqual((await a.request('/api/push/test',{deviceId,operationId})).json(),first.json());
  assert.equal((await a.request('/api/push/test',{deviceId,operationId:randomUUID()})).statusCode,429);
  f.advance(9999);await f.app.runPushTests();assert.equal(f.deliveries.length,0);
  await f.restart();assert.equal((await a.request('/api/push/config')).json().publicKey,publicKey);
  f.advance(1);await Promise.all([f.app.runPushTests(),f.app.runPushTests()]);assert.equal(f.deliveries.length,1);
  const [destination,payload,options]=f.deliveries[0];assert.deepEqual(destination,sub);
  assert.deepEqual(JSON.parse(payload),{type:'tasks-test',id:operationId});assert.equal(options.vapidDetails.publicKey,publicKey);assert.ok(options.TTL<=50);
  assert.equal((await a.request('/api/push/status',{deviceId})).json().test.status,'accepted');
  await f.app.runPushTests();assert.equal(f.deliveries.length,1);
  f.advance(30000);await a.request('/api/push/test',{deviceId,operationId:randomUUID()});
  f.advance(60000);await f.app.runPushTests();assert.equal(f.deliveries.length,1);
  assert.equal((await a.request('/api/push/status',{deviceId})).json().test.status,'expired');
});

test('bounded service retries, ambiguous sends, invalid subscriptions and revocation cancel pending tests',async t=>{
  const f=await fixture(t),a=f.admin,deviceId=randomUUID();
  await a.request('/api/push/subscribe',{deviceId,subscription:subscription('fcm.googleapis.com')});
  const schedule=async()=>{f.advance(31000);const r=await a.request('/api/push/test',{deviceId,operationId:randomUUID()});assert.equal(r.statusCode,200);f.advance(10000);};
  f.behavior(async()=>{throw Object.assign(Error(),{statusCode:503});});await schedule();
  await f.app.runPushTests();f.advance(5000);await f.app.runPushTests();f.advance(15000);await f.app.runPushTests();
  assert.equal(f.deliveries.length,3);assert.equal((await a.request('/api/push/status',{deviceId})).json().test.status,'failed');
  f.behavior(async()=>{throw Error('network outcome unknown');});await schedule();await f.app.runPushTests();
  assert.equal((await a.request('/api/push/status',{deviceId})).json().test.status,'unknown');
  await f.app.runPushTests();assert.equal(f.deliveries.length,4);
  f.behavior(async()=>{throw Object.assign(Error(),{statusCode:410});});await schedule();await f.app.runPushTests();
  assert.equal((await a.request('/api/push/status',{deviceId})).json().active,false);
  await a.request('/api/push/subscribe',{deviceId,subscription:subscription()});await schedule();
  await a.request('/api/auth/logout',{});await f.app.runPushTests();assert.equal(f.deliveries.length,5);
  assert.equal(f.db.prepare('SELECT count(*) n FROM push_tests').get().n,0);
});

test('client account switch unsubscribes the browser and revokes the old session, preventing a racing tab from reattaching',async t=>{
  const f=await fixture(t),a=f.admin,deviceId=randomUUID(),sub=subscription();
  const originalFetch=globalThis.fetch;
  const oldService=Object.getOwnPropertyDescriptor(navigator,'serviceWorker'),oldLocks=Object.getOwnPropertyDescriptor(navigator,'locks');
  let browserSub=null,unsubscribed=0;
  const nativeSub={toJSON:()=>sub,unsubscribe:async()=>{browserSub=null;unsubscribed++;return true;}};
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:async()=>({active:{},pushManager:{
    getSubscription:async()=>browserSub,subscribe:async options=>{assert.equal(options.userVisibleOnly,true);browserSub=nativeSub;return nativeSub;},
  }})}});
  const queues=new Map();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(name,fn)=>{const task=(queues.get(name)??Promise.resolve()).then(fn);queues.set(name,task.catch(()=>{}));return task;}}});
  globalThis.fetch=async(path,options={})=>{const response=await a.request(path,options.body===undefined?undefined:JSON.parse(options.body),options.headers);
    return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});};
  t.after(()=>{globalThis.fetch=originalFetch;for(const [key,descriptor] of [['serviceWorker',oldService],['locks',oldLocks]]){
    if(descriptor)Object.defineProperty(navigator,key,descriptor);else delete navigator[key];}});
  const {enablePush,detachPush}=await import('../src/push.ts');
  const key=(await a.request('/api/push/config')).json().publicKey;
  await enablePush(a.user,deviceId,key);assert.equal((await a.request('/api/push/status',{deviceId})).json().active,true);
  await a.request('/api/push/test',{deviceId,operationId:randomUUID()});
  await detachPush();assert.equal(unsubscribed,1);assert.equal(browserSub,null);
  assert.equal((await a.request('/api/auth/session')).statusCode,401);
  assert.equal((await a.request('/api/push/subscribe',{deviceId,subscription:sub})).statusCode,401);
  assert.equal(f.db.prepare('SELECT count(*) n FROM push_subscriptions').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM push_tests').get().n,0);
});
