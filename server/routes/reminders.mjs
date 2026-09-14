import { randomUUID } from 'node:crypto';
import { fail } from '../auth/accounts.mjs';
import { intervals, validZone, zonedTime, validPlan } from '../../shared/reminders.mjs';
const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
export function reminderHeads(db,vault,object){
  const rows=db.prepare('SELECT id,parent_id,payload FROM records WHERE vault_id=? AND object_id=?').all(vault,object);
  const parents=new Set(rows.flatMap(r=>[r.parent_id,...(JSON.parse(r.payload).resolves??[])]));return rows.filter(r=>!parents.has(r.id)).map(r=>r.id);
}
export function registerReminders(app,db,{action,guard,own,permit,clock}){
  const settings=user=>{db.prepare('INSERT OR IGNORE INTO reminder_settings(user_id) VALUES(?)').run(user.id);return db.prepare('SELECT zone,nudge_hours FROM reminder_settings WHERE user_id=?').get(user.id);};
  const post=(path,schema,fn)=>app.post('/api/reminders/'+path,{preHandler:guard,schema:{body:schema}},action(fn));
  app.get('/api/reminders/settings',action((_req,user)=>settings(user)));
  post('zone',obj({zone:{type:'string',maxLength:100}}),(req,user)=>{
    const previous=settings(user);if(!validZone(req.body.zone))fail('invalid_timezone',400);
    if(previous.zone!==req.body.zone){
      db.prepare('UPDATE reminder_settings SET zone=? WHERE user_id=?').run(req.body.zone,user.id);
      for(const r of db.prepare('SELECT id,local_at FROM reminders WHERE user_id=? AND fired_at IS NULL').all(user.id)){
        const due=zonedTime(r.local_at,req.body.zone);db.prepare('UPDATE reminders SET due_at=? WHERE id=?').run(due,r.id);
      }
    }
    return settings(user);
  });
  post('settings',obj({nudgeHours:{type:'integer',enum:intervals}}),(req,user)=>{
    settings(user);db.prepare('UPDATE reminder_settings SET nudge_hours=? WHERE user_id=?').run(req.body.nudgeHours,user.id);
    db.prepare('UPDATE reminders SET next_nudge=? WHERE user_id=? AND fired_at IS NOT NULL AND seen_at IS NULL')
      .run(req.body.nudgeHours?clock()+req.body.nudgeHours*3600000:null,user.id);
    if(!req.body.nudgeHours)db.prepare('DELETE FROM reminder_deliveries WHERE reminder_id IN (SELECT id FROM reminders WHERE user_id=?) AND cycle>1').run(user.id);
    return settings(user);
  });
  app.get('/api/reminders',action((_req,user)=>({settings:settings(user),items:db.prepare(`SELECT r.id,r.vault_id,r.object_id,r.config_id,r.record_id,r.local_at,r.due_at,r.plan_state,r.paused,r.fired_at,r.seen_at,
    (SELECT status FROM reminder_deliveries d WHERE d.reminder_id=r.id ORDER BY d.cycle DESC,d.due_at DESC LIMIT 1) delivery
    FROM reminders r WHERE r.user_id=?`).all(user.id)})));
  const plan=obj({id:uuid,state:{enum:['active','off','done']},local:{type:'string',maxLength:16},mode:{enum:['neutral','custom']},text:{type:'string',maxLength:400}});
  post('set',obj({vaultId:uuid,objectId:uuid,recordId:uuid,plan:{anyOf:[plan,{type:'null'}]}}),(req,user)=>{
    const {vaultId,objectId,recordId,plan:p}=req.body;permit(req,own(user,vaultId));
    const heads=reminderHeads(db,vaultId,objectId);
    if(heads.length!==1||heads[0]!==recordId)fail('reminder_conflict',409);
    const old=db.prepare('SELECT * FROM reminders WHERE vault_id=? AND object_id=?').get(vaultId,objectId);
    if(!p){db.prepare('DELETE FROM reminders WHERE vault_id=? AND object_id=?').run(vaultId,objectId);return{ok:true};}
    if(!validPlan(p))fail('invalid_reminder',400);
    const pref=settings(user),due=zonedTime(p.local,pref.zone),body=p.state==='active'&&p.mode==='custom'?p.text:null;
    if(p.state==='active'&&due===null)fail('invalid_local_time',400);
    if(!old&&db.prepare('SELECT count(*) n FROM reminders WHERE user_id=?').get(user.id).n>=1000)fail('reminder_limit',409);
    if(old&&old.config_id===p.id){
      if(old.local_at!==p.local||old.plan_state!==p.state||old.body!==body)fail('id_conflict',409);
      db.prepare('UPDATE reminders SET record_id=?,paused=0 WHERE id=?').run(recordId,old.id);return{ok:true};
    }
    if(old){db.prepare('DELETE FROM reminder_deliveries WHERE reminder_id=?').run(old.id);
      db.prepare('UPDATE reminders SET config_id=?,record_id=?,local_at=?,due_at=?,plan_state=?,body=?,paused=0,fired_at=NULL,seen_at=NULL,next_nudge=NULL,cycle=0 WHERE id=?')
        .run(p.id,recordId,p.local,due,p.state,body,old.id);
    }else db.prepare('INSERT INTO reminders(id,user_id,vault_id,object_id,config_id,record_id,local_at,due_at,plan_state,body) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),user.id,vaultId,objectId,p.id,recordId,p.local,due,p.state,body);
    return{ok:true};
  });
  post('seen',obj({vaultId:uuid,objectId:uuid,configId:uuid}),(req,user)=>{
    const r=db.prepare('SELECT * FROM reminders WHERE user_id=? AND vault_id=? AND object_id=?').get(user.id,req.body.vaultId,req.body.objectId);
    const matched=Boolean(r&&r.config_id===req.body.configId&&r.due_at!==null&&r.due_at<=clock());
    if(matched){
      db.prepare('UPDATE reminders SET seen_at=?,next_nudge=NULL WHERE id=?').run(clock(),r.id);
      db.prepare('DELETE FROM reminder_deliveries WHERE reminder_id=?').run(r.id);
    }
    return{ok:true,exists:Boolean(r),matched};
  });
}

export function createReminderWorker(db,{clock,send,keys,config,validEndpoint}){
  return async function tick(){
    const now=clock();
    db.prepare("UPDATE reminder_deliveries SET status='unknown' WHERE status='sending' AND lease_until<=?").run(now);
    db.prepare("UPDATE reminder_deliveries SET status='expired' WHERE status='scheduled' AND expires_at<=?").run(now);
    db.prepare('DELETE FROM reminder_deliveries WHERE expires_at<?').run(now-7*86400000);
    db.exec('BEGIN IMMEDIATE');
    try{
      const due=db.prepare(`SELECT r.*,s.nudge_hours FROM reminders r JOIN reminder_settings s ON s.user_id=r.user_id
        WHERE r.plan_state='active' AND r.paused=0 AND r.seen_at IS NULL AND r.due_at<=?
        AND (r.fired_at IS NULL OR r.next_nudge<=?) ORDER BY coalesce(r.next_nudge,r.due_at) LIMIT 20`).all(now,now);
      for(const r of due){
        const heads=reminderHeads(db,r.vault_id,r.object_id);
        if(heads.length!==1||heads[0]!==r.record_id){db.prepare('UPDATE reminders SET paused=1 WHERE id=?').run(r.id);continue;}
        db.prepare('DELETE FROM reminder_deliveries WHERE reminder_id=?').run(r.id);
        const cycle=r.cycle+1;
        db.prepare('UPDATE reminders SET cycle=?,fired_at=coalesce(fired_at,?),next_nudge=? WHERE id=?').run(cycle,now,r.nudge_hours?now+r.nudge_hours*3600000:null,r.id);
        // With nudges disabled, an initial notification older than an hour stays missed.
        if(!r.nudge_hours&&!r.fired_at&&now-r.due_at>3600000)continue;
        const subs=db.prepare(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id=p.session_id
          WHERE p.user_id=? AND s.revoked=0 AND s.refresh_expires>? AND s.absolute_expires>?`).all(r.user_id,now,now);
        for(const sub of subs)db.prepare("INSERT INTO reminder_deliveries(id,reminder_id,subscription_id,cycle,status,due_at,expires_at) VALUES(?,?,?,?,'scheduled',?,?)")
          .run(randomUUID(),r.id,sub.id,cycle,now,now+3600000);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    // Bounded dispatch: one delivery per tick. Never replay a backlog of nudge cycles.
    let job;
    db.exec('BEGIN IMMEDIATE');
    try{
      job=db.prepare(`SELECT d.*,r.user_id,r.vault_id,r.object_id,r.config_id,r.body,p.endpoint,p.p256dh,p.auth
        FROM reminder_deliveries d JOIN reminders r ON r.id=d.reminder_id JOIN push_subscriptions p ON p.id=d.subscription_id JOIN sessions s ON s.id=p.session_id
        WHERE d.status='scheduled' AND d.due_at<=? AND d.expires_at>? AND r.paused=0 AND r.seen_at IS NULL AND r.plan_state='active'
        AND s.revoked=0 AND s.refresh_expires>? AND s.absolute_expires>? ORDER BY d.due_at LIMIT 1`).get(clock(),clock(),clock(),clock());
      if(job)db.prepare("UPDATE reminder_deliveries SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?").run(clock()+30000,job.id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    if(!job)return;
    try{
      if(!validEndpoint(job.endpoint))throw Object.assign(Error(),{statusCode:400});const k=keys();
      const payload={type:'tasks-reminder',accountId:job.user_id,vaultId:job.vault_id,objectId:job.object_id,configId:job.config_id,body:job.body??'У вас запланировано напоминание'};
      await send({endpoint:job.endpoint,keys:{p256dh:job.p256dh,auth:job.auth}},JSON.stringify(payload),{
        vapidDetails:{subject:config.origin,publicKey:k.public_key,privateKey:k.private_key},TTL:Math.max(1,Math.floor((job.expires_at-clock())/1000)),timeout:5000,
        topic:job.reminder_id.replaceAll('-',''),urgency:'normal'});
      db.prepare("UPDATE reminder_deliveries SET status='accepted' WHERE id=?").run(job.id);
    }catch(error){
      if(error.statusCode===404||error.statusCode===410){db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(job.subscription_id);return;}
      const retry=(error.statusCode===429||error.statusCode>=500)&&job.attempts<4;
      db.prepare('UPDATE reminder_deliveries SET status=?,due_at=? WHERE id=?')
        .run(retry?'scheduled':error.statusCode?'failed':'unknown',clock()+[15000,60000,300000,900000][Math.min(job.attempts,3)],job.id);
    }
  };
}
