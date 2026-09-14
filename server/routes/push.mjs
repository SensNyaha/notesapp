import webpush from 'web-push';
import { randomUUID, ECDH } from 'node:crypto';
import { digest } from '../auth/sessions.mjs';
import { requireUser, AccountError, fail } from '../auth/accounts.mjs';
import { createReminderWorker } from './reminders.mjs';

const uuid = { type:'string', pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const object = properties => ({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const encoded = length => ({type:'string',pattern:'^[A-Za-z0-9_-]+$',minLength:length,maxLength:length});
const providers = new Set(['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com']);
export function validEndpoint(value) {
  try { const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash
    &&providers.has(u.hostname)&&u.pathname!=='/'&&u.href===value; } catch { return false; }
}
export function registerPush(app, db, { guard, accessOf, clock, config, send = (...args)=>webpush.sendNotification(...args), interval = 1000 }) {
  const enabled=config.secure;
  function keys() {
    let row=db.prepare('SELECT * FROM push_config WHERE id=1').get();
    if(!row){const k=webpush.generateVAPIDKeys();db.prepare('INSERT OR IGNORE INTO push_config VALUES(1,?,?)').run(k.publicKey,k.privateKey);
      row=db.prepare('SELECT * FROM push_config WHERE id=1').get();}
    return row;
  }
  function action(fn) {return (req,reply)=>{
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const user=requireUser(db,accessOf(req),clock());
        if(req.headers['x-tasks-account']!==user.id)fail('account_mismatch',409);
        const session=db.prepare('SELECT id FROM sessions WHERE access_hash=?').get(digest(accessOf(req)));
        const result=fn(req,user,session.id);db.exec('COMMIT');return result;
      }catch(error){db.exec('ROLLBACK');throw error;}
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
  };}
  const post=(path,schema,fn)=>app.post('/api/push/'+path,{preHandler:guard,schema:{body:schema}},action(fn));
  const own=(user,session,device)=>db.prepare('SELECT * FROM push_subscriptions WHERE user_id=? AND session_id=? AND device_id=?').get(user.id,session,device);
  app.get('/api/push/config',action(()=>({enabled,publicKey:enabled?keys().public_key:null})));
  post('status',object({deviceId:uuid}),(req,user,session)=>{
    const sub=own(user,session,req.body.deviceId);
    const test=sub&&db.prepare('SELECT id,due_at,expires_at,status,attempts FROM push_tests WHERE subscription_id=? ORDER BY expires_at DESC LIMIT 1').get(sub.id);
    return{active:Boolean(sub),test:test??null};
  });
  post('subscribe',object({deviceId:uuid,subscription:object({endpoint:{type:'string',maxLength:2048},keys:object({p256dh:encoded(87),auth:encoded(22)})})}),(req,user,session)=>{
    if(!enabled)fail('push_unavailable',409);
    const {deviceId,subscription:s}=req.body;
    if(!validEndpoint(s.endpoint))fail('unsupported_push_service',400);
    try {
      for(const [key,size] of [['p256dh',65],['auth',16]]){const bytes=Buffer.from(s.keys[key],'base64url');
        if(bytes.length!==size||bytes.toString('base64url')!==s.keys[key])throw Error();}
      ECDH.convertKey(Buffer.from(s.keys.p256dh,'base64url'),'prime256v1');
    }catch{fail('invalid_request',400);}
    const old=db.prepare('SELECT * FROM push_subscriptions WHERE endpoint=?').get(s.endpoint);
    if(old&&(old.user_id!==user.id||old.session_id!==session||old.device_id!==deviceId))fail('subscription_in_use',409);
    if(old&&old.p256dh===s.keys.p256dh&&old.auth===s.keys.auth)return{active:true};
    if(db.prepare('SELECT count(*) n FROM push_subscriptions WHERE user_id=?').get(user.id).n>=20)fail('push_limit',409);
    db.prepare('DELETE FROM push_subscriptions WHERE session_id=? AND device_id=?').run(session,deviceId);
    keys();db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),user.id,session,deviceId,s.endpoint,s.keys.p256dh,s.keys.auth);
    return{active:true};
  });
  post('disable',object({deviceId:uuid}),(req,user,session)=>{
    db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND session_id=? AND device_id=?').run(user.id,session,req.body.deviceId);
    return{active:false};
  });
  // A browser shares one server session across tabs, even when a tab displays an offline profile.
  post('detach',object({}),(_req,_user,session)=>{
    db.prepare('DELETE FROM push_subscriptions WHERE session_id=?').run(session);return{ok:true};
  });
  post('test',object({deviceId:uuid,operationId:uuid}),(req,user,session)=>{
    if(!enabled)fail('push_unavailable',409);
    const sub=own(user,session,req.body.deviceId);if(!sub)fail('push_not_subscribed',409);
    const existing=db.prepare('SELECT * FROM push_tests WHERE id=?').get(req.body.operationId);
    if(existing){if(existing.subscription_id!==sub.id)fail('id_conflict',409);return{dueAt:existing.due_at};}
    const previous=db.prepare('SELECT last_test FROM push_test_limits WHERE user_id=?').get(user.id);
    if(previous&&clock()-previous.last_test<30000)fail('rate_limited',429);
    if(db.prepare("SELECT 1 FROM push_tests WHERE subscription_id=? AND status IN ('scheduled','sending')").get(sub.id))fail('test_pending',409);
    const now=clock();
    db.prepare('INSERT INTO push_test_limits VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_test=excluded.last_test').run(user.id,now);
    db.prepare("INSERT INTO push_tests(id,subscription_id,due_at,expires_at,status) VALUES(?,?,?,?,'scheduled')").run(req.body.operationId,sub.id,now+10000,now+60000);
    return{dueAt:now+10000};
  });
  const runReminders=createReminderWorker(db,{clock,send,keys,config,validEndpoint});
  let running=null,stopping=false;
  async function tick() {
    if(!enabled||stopping)return;
    const now=clock();
    db.prepare('DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM sessions WHERE revoked=1 OR absolute_expires<=? OR refresh_expires<=?)').run(now,now);
    db.prepare('DELETE FROM push_tests WHERE expires_at<?').run(now-7*86400000);
    db.prepare("UPDATE push_tests SET status='unknown' WHERE status='sending' AND lease_until<=?").run(now);
    db.prepare("UPDATE push_tests SET status='expired' WHERE status='scheduled' AND expires_at<=?").run(now);
    await runReminders();
    for(let i=0;i<4&&!stopping;i++){
      let job;
      db.exec('BEGIN IMMEDIATE');
      try {
        job=db.prepare("SELECT t.*,s.endpoint,s.p256dh,s.auth FROM push_tests t JOIN push_subscriptions s ON s.id=t.subscription_id WHERE t.status='scheduled' AND t.due_at<=? AND t.expires_at>? ORDER BY t.due_at LIMIT 1").get(clock(),clock());
        if(job)db.prepare("UPDATE push_tests SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?").run(clock()+30000,job.id);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      if(!job)break;
      try {
        const k=keys();
        if(!validEndpoint(job.endpoint))throw Object.assign(Error(),{statusCode:400});
        await send({endpoint:job.endpoint,keys:{p256dh:job.p256dh,auth:job.auth}},JSON.stringify({type:'tasks-test',id:job.id}),
          {vapidDetails:{subject:config.origin,publicKey:k.public_key,privateKey:k.private_key},TTL:Math.max(1,Math.floor((job.expires_at-clock())/1000)),timeout:5000,urgency:'normal',topic:job.id.replaceAll('-','')});
        db.prepare("UPDATE push_tests SET status='accepted' WHERE id=? AND status='sending'").run(job.id);
      }catch(error){
        if(error.statusCode===404||error.statusCode===410){db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(job.subscription_id);continue;}
        const retry=(error.statusCode===429||error.statusCode>=500)&&job.attempts<2&&clock()+5000<job.expires_at;
        db.prepare('UPDATE push_tests SET status=?,due_at=? WHERE id=? AND status=\'sending\'')
          .run(retry?'scheduled':error.statusCode?'failed':'unknown',clock()+(job.attempts?15000:5000),job.id);
      }
    }
  }
  const run=()=>running??=(tick().finally(()=>{running=null;}));
  // Exposed to integration tests; production only uses the bounded interval.
  app.decorate('runPushTests',run);
  const timer=interval>0?setInterval(()=>{void run().catch(()=>app.log.error('Push worker failed'));},interval):null;timer?.unref();
  app.addHook('onClose',async()=>{stopping=true;if(timer)clearInterval(timer);if(running)await running;});
}
