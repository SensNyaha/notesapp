import { randomUUID } from 'node:crypto';
import { fail } from '../auth/accounts.mjs';
import { intervals, validZone, zonedTime, validPlan, normalizePlan, nextOccurrenceLocal, localTime } from '../../shared/reminders.mjs';
const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const repeat={anyOf:[
  {type:'object',additionalProperties:false,required:['type'],properties:{type:{const:'once'}}},
  {type:'object',additionalProperties:false,required:['type'],properties:{type:{const:'daily'}}},
  {type:'object',additionalProperties:false,required:['type','days'],properties:{type:{const:'weekly'},days:{type:'array',minItems:1,maxItems:7,uniqueItems:true,items:{type:'integer',minimum:1,maximum:7}}}},
  {type:'object',additionalProperties:false,required:['type','days'],properties:{type:{const:'interval'},days:{type:'integer',minimum:2,maximum:365}}},
  {type:'object',additionalProperties:false,required:['type','day','shortMonth'],properties:{type:{const:'monthly'},day:{type:'integer',minimum:1,maximum:31},shortMonth:{enum:['last','skip']}}},
]};
const ending={anyOf:[
  {type:'object',additionalProperties:false,required:['type'],properties:{type:{const:'never'}}},
  {type:'object',additionalProperties:false,required:['type','date'],properties:{type:{const:'date'},date:{type:'string',maxLength:10}}},
  {type:'object',additionalProperties:false,required:['type','count'],properties:{type:{const:'count'},count:{type:'integer',minimum:1,maximum:10000}}},
]};
const plan={type:'object',additionalProperties:false,required:['id','state','local','mode','text'],properties:{id:uuid,state:{enum:['active','off','done']},local:{type:'string',maxLength:16},mode:{enum:['neutral','custom','title']},text:{type:'string',maxLength:400},repeat,end:ending,allDay:{type:'boolean'},important:{type:'boolean'}}};

export function reminderHeads(db,vault,object){
  const rows=db.prepare('SELECT id,parent_id,payload FROM records WHERE vault_id=? AND object_id=?').all(vault,object);
  const parents=new Set(rows.flatMap(r=>[r.parent_id,...(JSON.parse(r.payload).resolves??[])]));return rows.filter(r=>!parents.has(r.id)).map(r=>r.id);
}
const scheduleOf=p=>{const value=normalizePlan(p);return{repeat:value.repeat,end:value.end,allDay:value.allDay,important:value.important};};
const atAllDayTime=(local,allDay,time)=>allDay?local.slice(0,10)+'T'+time:local;
const storedPlan=row=>({id:row.config_id,state:row.plan_state,local:row.local_at,mode:'neutral',text:'',...JSON.parse(row.schedule)});
function ensureOccurrences(db,row,zone,until){
  if(row.plan_state!=='active')return;
  const plan=storedPlan(row),maximum=db.prepare('SELECT max(sequence) sequence FROM reminder_occurrences WHERE reminder_id=?').get(row.id).sequence??0;
  let sequence=maximum,generated=db.prepare('SELECT count(*) count FROM reminder_occurrences WHERE reminder_id=? AND config_id=?').get(row.id,row.config_id).count,last=db.prepare('SELECT scheduled_local FROM reminder_occurrences WHERE reminder_id=? AND config_id=? ORDER BY sequence DESC LIMIT 1').get(row.id,row.config_id)?.scheduled_local;
  const insert=local=>{const due=zonedTime(local,zone);db.prepare(`INSERT OR IGNORE INTO reminder_occurrences
    (id,reminder_id,config_id,sequence,scheduled_local,due_at,effective_due_at,status) VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(),row.id,row.config_id,++sequence,local,due,due,due===null?'missed':'scheduled');generated++;};
  if(!last){last=row.local_at;insert(last);}
  const horizon=localTime(until,zone);let count=0;
  while(count++<500){const next=nextOccurrenceLocal(plan,last,generated);if(!next||next>horizon)break;last=next;insert(next);}
}
function refreshDue(db,reminderId){const next=db.prepare("SELECT effective_due_at FROM reminder_occurrences WHERE reminder_id=? AND status IN('scheduled','fired') ORDER BY effective_due_at LIMIT 1").get(reminderId);db.prepare('UPDATE reminders SET due_at=? WHERE id=?').run(next?.effective_due_at??null,reminderId);}

export function registerReminders(app,db,{action,guard,own,permit,clock}){
  const settings=user=>{db.prepare('INSERT OR IGNORE INTO reminder_settings(user_id) VALUES(?)').run(user.id);return db.prepare('SELECT zone,nudge_hours,all_day_time FROM reminder_settings WHERE user_id=?').get(user.id);};
  const post=(path,schema,fn)=>app.post('/api/reminders/'+path,{preHandler:guard,schema:{body:schema}},action(fn));
  app.get('/api/reminders/settings',action((_req,user)=>settings(user)));
  post('zone',obj({zone:{type:'string',maxLength:100}}),(req,user)=>{
    const previous=settings(user);if(!validZone(req.body.zone))fail('invalid_timezone',400);
    if(previous.zone!==req.body.zone){db.prepare('UPDATE reminder_settings SET zone=? WHERE user_id=?').run(req.body.zone,user.id);
      for(const occurrence of db.prepare(`SELECT o.id,o.scheduled_local,o.snooze_local FROM reminder_occurrences o JOIN reminders r ON r.id=o.reminder_id WHERE r.user_id=? AND o.status IN('scheduled','fired')`).all(user.id)){
        const due=zonedTime(occurrence.snooze_local??occurrence.scheduled_local,req.body.zone);db.prepare('UPDATE reminder_occurrences SET due_at=?,effective_due_at=? WHERE id=?').run(zonedTime(occurrence.scheduled_local,req.body.zone),due,occurrence.id);}
      for(const row of db.prepare('SELECT id FROM reminders WHERE user_id=?').all(user.id))refreshDue(db,row.id);
    }return settings(user);
  });
  const settingsSchema={type:'object',additionalProperties:false,required:['nudgeHours'],properties:{nudgeHours:{type:'integer',enum:intervals},allDayTime:{type:'string',maxLength:5}}};
  post('settings',settingsSchema,(req,user)=>{
    const previous=settings(user),allDayTime=req.body.allDayTime??previous.all_day_time;if(!/^\d\d:\d\d$/.test(allDayTime)||zonedTime('2026-01-01T'+allDayTime,'UTC')===null)fail('invalid_local_time',400);
    db.prepare('UPDATE reminder_settings SET nudge_hours=?,all_day_time=? WHERE user_id=?').run(req.body.nudgeHours,allDayTime,user.id);
    if(allDayTime!==previous.all_day_time){
      for(const reminder of db.prepare('SELECT * FROM reminders WHERE user_id=?').all(user.id)){
        const schedule=JSON.parse(reminder.schedule);if(!schedule.allDay)continue;
        const local=reminder.local_at.slice(0,10)+'T'+allDayTime;
        db.prepare('UPDATE reminders SET local_at=? WHERE id=?').run(local,reminder.id);
        for(const occurrence of db.prepare("SELECT id,scheduled_local,snooze_local FROM reminder_occurrences WHERE reminder_id=? AND status IN('scheduled','fired')").all(reminder.id)){
          const scheduled=occurrence.scheduled_local.slice(0,10)+'T'+allDayTime;
          db.prepare('UPDATE reminder_occurrences SET scheduled_local=?,due_at=?,effective_due_at=? WHERE id=?')
            .run(scheduled,zonedTime(scheduled,previous.zone),zonedTime(occurrence.snooze_local??scheduled,previous.zone),occurrence.id);
        }
        refreshDue(db,reminder.id);
      }
    }
    db.prepare("UPDATE reminder_occurrences SET next_nudge=? WHERE reminder_id IN(SELECT id FROM reminders WHERE user_id=?) AND status='fired'").run(req.body.nudgeHours?clock()+req.body.nudgeHours*3600000:null,user.id);
    if(!req.body.nudgeHours)db.prepare('DELETE FROM reminder_deliveries WHERE reminder_id IN (SELECT id FROM reminders WHERE user_id=?) AND cycle>1').run(user.id);return settings(user);
  });
  app.get('/api/reminders',action((_req,user)=>{const pref=settings(user),rows=db.prepare('SELECT * FROM reminders WHERE user_id=?').all(user.id);for(const row of rows)ensureOccurrences(db,row,pref.zone,clock()+35*86400000);
    return{settings:pref,items:db.prepare(`SELECT r.id,r.vault_id,r.object_id,r.config_id,r.record_id,r.local_at,r.plan_state,r.paused,r.schedule,
      o.id occurrence_id,o.sequence,o.scheduled_local,o.due_at,o.snooze_local,o.effective_due_at,o.status occurrence_status,o.fired_at,o.seen_at,o.completed_at,
      (SELECT status FROM reminder_deliveries d WHERE d.occurrence_id=o.id ORDER BY d.cycle DESC,d.due_at DESC LIMIT 1) delivery
      FROM reminders r JOIN reminder_occurrences o ON o.reminder_id=r.id WHERE r.user_id=? ORDER BY coalesce(o.effective_due_at,o.due_at),o.sequence`).all(user.id)};}));
  post('set',obj({vaultId:uuid,objectId:uuid,recordId:uuid,plan:{anyOf:[plan,{type:'null'}]}}),(req,user)=>{
    const {vaultId,objectId,recordId,plan:p}=req.body;permit(req,own(user,vaultId));const heads=reminderHeads(db,vaultId,objectId);if(heads.length!==1||heads[0]!==recordId)fail('reminder_conflict',409);
    const old=db.prepare('SELECT * FROM reminders WHERE vault_id=? AND object_id=?').get(vaultId,objectId);if(!p){if(old)db.prepare('DELETE FROM reminders WHERE id=?').run(old.id);return{ok:true};}
    if(!validPlan(p))fail('invalid_reminder',400);const source=normalizePlan(p),pref=settings(user),normalized={...source,local:atAllDayTime(source.local,source.allDay,pref.all_day_time)},due=zonedTime(normalized.local,pref.zone),body=normalized.state==='active'&&normalized.mode!=='neutral'&&normalized.text?normalized.text:null,schedule=JSON.stringify(scheduleOf(normalized));
    if(normalized.state==='active'&&due===null)fail('invalid_local_time',400);if(normalized.end.type==='date'&&normalized.local.slice(0,10)>normalized.end.date)fail('invalid_reminder',400);if(!old&&db.prepare('SELECT count(*) n FROM reminders WHERE user_id=?').get(user.id).n>=1000)fail('reminder_limit',409);
    if(old&&old.config_id===normalized.id){if(old.local_at!==normalized.local||old.schedule!==schedule)fail('id_conflict',409);
      db.prepare('UPDATE reminders SET record_id=?,plan_state=?,body=?,paused=0 WHERE id=?').run(recordId,normalized.state,body,old.id);ensureOccurrences(db,{...old,record_id:recordId,plan_state:normalized.state},pref.zone,clock()+35*86400000);refreshDue(db,old.id);return{ok:true};}
    if(old){db.prepare('DELETE FROM reminder_deliveries WHERE reminder_id=?').run(old.id);db.prepare("UPDATE reminder_occurrences SET status='skipped',completed_at=? WHERE reminder_id=? AND status IN('scheduled','fired','seen')").run(clock(),old.id);
      db.prepare('UPDATE reminders SET config_id=?,record_id=?,local_at=?,due_at=?,plan_state=?,body=?,schedule=?,paused=0,fired_at=NULL,seen_at=NULL,next_nudge=NULL,cycle=0 WHERE id=?').run(normalized.id,recordId,normalized.local,due,normalized.state,body,schedule,old.id);
      ensureOccurrences(db,{...old,config_id:normalized.id,record_id:recordId,local_at:normalized.local,due_at:due,plan_state:normalized.state,schedule},pref.zone,clock()+35*86400000);refreshDue(db,old.id);
    }else{const reminderId=randomUUID();db.prepare('INSERT INTO reminders(id,user_id,vault_id,object_id,config_id,record_id,local_at,due_at,plan_state,body,schedule) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(reminderId,user.id,vaultId,objectId,normalized.id,recordId,normalized.local,due,normalized.state,body,schedule);
      ensureOccurrences(db,{id:reminderId,config_id:normalized.id,local_at:normalized.local,plan_state:normalized.state,schedule},pref.zone,clock()+35*86400000);refreshDue(db,reminderId);}return{ok:true};
  });
  const seenSchema={type:'object',additionalProperties:false,required:['vaultId','objectId','configId'],properties:{vaultId:uuid,objectId:uuid,configId:uuid,occurrenceId:uuid}};
  post('seen',seenSchema,(req,user)=>{const r=db.prepare('SELECT * FROM reminders WHERE user_id=? AND vault_id=? AND object_id=?').get(user.id,req.body.vaultId,req.body.objectId);let matched=false;
    if(r&&r.config_id===req.body.configId){const rows=req.body.occurrenceId?db.prepare("SELECT * FROM reminder_occurrences WHERE reminder_id=? AND id=? AND status='fired'").all(r.id,req.body.occurrenceId):db.prepare("SELECT * FROM reminder_occurrences WHERE reminder_id=? AND status='fired' AND effective_due_at<=?").all(r.id,clock());
      for(const row of rows){matched=true;db.prepare("UPDATE reminder_occurrences SET status='seen',seen_at=?,next_nudge=NULL WHERE id=?").run(clock(),row.id);db.prepare('DELETE FROM reminder_deliveries WHERE occurrence_id=?').run(row.id);}if(matched)db.prepare('UPDATE reminders SET seen_at=?,next_nudge=NULL WHERE id=?').run(clock(),r.id);}
    return{ok:true,exists:Boolean(r),matched};});
  post('action',obj({occurrenceId:uuid,operation:{enum:['complete','skip','snooze','pause']},local:{anyOf:[{type:'string',maxLength:16},{type:'null'}]}}),(req,user)=>{
    const row=db.prepare(`SELECT o.*,r.user_id,r.id schedule_id,s.zone FROM reminder_occurrences o JOIN reminders r ON r.id=o.reminder_id JOIN reminder_settings s ON s.user_id=r.user_id WHERE o.id=? AND r.user_id=?`).get(req.body.occurrenceId,user.id);if(!row)fail('occurrence_missing',404);db.prepare('DELETE FROM reminder_deliveries WHERE occurrence_id=?').run(row.id);
    if(req.body.operation==='snooze'){const due=req.body.local&&zonedTime(req.body.local,row.zone);if(due===null||due<=clock())fail('invalid_local_time',400);db.prepare("UPDATE reminder_occurrences SET status='scheduled',snooze_local=?,effective_due_at=?,fired_at=NULL,seen_at=NULL,completed_at=NULL,next_nudge=NULL,cycle=0 WHERE id=?").run(req.body.local,due,row.id);}
    else if(req.body.operation==='pause')db.prepare("UPDATE reminders SET plan_state='off' WHERE id=?").run(row.schedule_id);else db.prepare('UPDATE reminder_occurrences SET status=?,completed_at=?,next_nudge=NULL WHERE id=?').run(req.body.operation==='complete'?'done':'skipped',clock(),row.id);refreshDue(db,row.schedule_id);return{ok:true};
  });
}

export function createReminderWorker(db,{clock,send,keys,config,validEndpoint}){return async function tick(){const now=clock();
  db.prepare("UPDATE reminder_deliveries SET status='unknown' WHERE status='sending' AND lease_until<=?").run(now);db.prepare("UPDATE reminder_deliveries SET status='expired' WHERE status='scheduled' AND expires_at<=?").run(now);db.prepare('DELETE FROM reminder_deliveries WHERE expires_at<?').run(now-7*86400000);
  db.exec('BEGIN IMMEDIATE');try{const reminders=db.prepare("SELECT r.*,s.zone,s.nudge_hours FROM reminders r JOIN reminder_settings s ON s.user_id=r.user_id WHERE r.plan_state='active' AND r.paused=0").all();for(const r of reminders)ensureOccurrences(db,r,r.zone,now+35*86400000);
    for(const r of reminders){if(JSON.parse(r.schedule).repeat.type==='once')continue;const overdue=db.prepare("SELECT id FROM reminder_occurrences WHERE reminder_id=? AND status IN('scheduled','fired') AND effective_due_at<=? ORDER BY effective_due_at DESC").all(r.id,now);for(const old of overdue.slice(1)){db.prepare("UPDATE reminder_occurrences SET status='missed',completed_at=?,next_nudge=NULL WHERE id=?").run(now,old.id);db.prepare('DELETE FROM reminder_deliveries WHERE occurrence_id=?').run(old.id);}}
    const due=db.prepare(`SELECT o.*,r.user_id,r.vault_id,r.object_id,r.config_id,r.record_id,r.body,r.schedule,s.nudge_hours FROM reminder_occurrences o JOIN reminders r ON r.id=o.reminder_id JOIN reminder_settings s ON s.user_id=r.user_id
      WHERE r.plan_state='active' AND r.paused=0 AND ((o.status='scheduled' AND o.effective_due_at<=?) OR (o.status='fired' AND o.next_nudge<=?)) ORDER BY coalesce(o.next_nudge,o.effective_due_at) LIMIT 20`).all(now,now);
    for(const o of due){const heads=reminderHeads(db,o.vault_id,o.object_id);if(heads.length!==1||heads[0]!==o.record_id){db.prepare('UPDATE reminders SET paused=1 WHERE id=?').run(o.reminder_id);continue;}db.prepare('DELETE FROM reminder_deliveries WHERE occurrence_id=?').run(o.id);const cycle=o.cycle+1;
      db.prepare("UPDATE reminder_occurrences SET status='fired',cycle=?,fired_at=coalesce(fired_at,?),next_nudge=? WHERE id=?").run(cycle,now,o.nudge_hours?now+o.nudge_hours*3600000:null,o.id);db.prepare('UPDATE reminders SET cycle=?,fired_at=coalesce(fired_at,?),next_nudge=? WHERE id=?').run(cycle,now,o.nudge_hours?now+o.nudge_hours*3600000:null,o.reminder_id);
      const subs=db.prepare(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id=p.session_id WHERE p.user_id=? AND s.revoked=0 AND s.refresh_expires>? AND s.absolute_expires>?`).all(o.user_id,now,now);
      for(const sub of subs)db.prepare("INSERT INTO reminder_deliveries(id,reminder_id,occurrence_id,subscription_id,cycle,status,due_at,expires_at) VALUES(?,?,?,?,?,'scheduled',?,?)").run(randomUUID(),o.reminder_id,o.id,sub.id,cycle,now,now+3600000);}
    db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  let job;db.exec('BEGIN IMMEDIATE');try{job=db.prepare(`SELECT d.*,r.user_id,r.vault_id,r.object_id,r.config_id,r.body,r.schedule,p.endpoint,p.p256dh,p.auth FROM reminder_deliveries d JOIN reminders r ON r.id=d.reminder_id JOIN reminder_occurrences o ON o.id=d.occurrence_id JOIN push_subscriptions p ON p.id=d.subscription_id JOIN sessions s ON s.id=p.session_id
    WHERE d.status='scheduled' AND d.due_at<=? AND d.expires_at>? AND r.paused=0 AND o.status='fired' AND s.revoked=0 AND s.refresh_expires>? AND s.absolute_expires>? ORDER BY d.due_at LIMIT 1`).get(clock(),clock(),clock(),clock());if(job)db.prepare("UPDATE reminder_deliveries SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?").run(clock()+30000,job.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}if(!job)return;
  try{if(!validEndpoint(job.endpoint))throw Object.assign(Error(),{statusCode:400});const k=keys(),schedule=JSON.parse(job.schedule),payload={type:'tasks-reminder',accountId:job.user_id,vaultId:job.vault_id,objectId:job.object_id,configId:job.config_id,occurrenceId:job.occurrence_id,body:job.body??'У вас запланировано напоминание'};
    await send({endpoint:job.endpoint,keys:{p256dh:job.p256dh,auth:job.auth}},JSON.stringify(payload),{vapidDetails:{subject:config.origin,publicKey:k.public_key,privateKey:k.private_key},TTL:Math.max(1,Math.floor((job.expires_at-clock())/1000)),timeout:5000,topic:job.occurrence_id.replaceAll('-',''),urgency:schedule.important?'high':'normal'});db.prepare("UPDATE reminder_deliveries SET status='accepted' WHERE id=?").run(job.id);
  }catch(error){if(error.statusCode===404||error.statusCode===410){db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(job.subscription_id);return;}const retry=(error.statusCode===429||error.statusCode>=500)&&job.attempts<4;db.prepare('UPDATE reminder_deliveries SET status=?,due_at=? WHERE id=?').run(retry?'scheduled':error.statusCode?'failed':'unknown',clock()+[15000,60000,300000,900000][Math.min(job.attempts,3)],job.id);}
};}
