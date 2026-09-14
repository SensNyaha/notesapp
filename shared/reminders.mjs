export const intervals = [0, 1, 3, 6, 24];
export function validZone(zone) {
  try { return typeof zone==='string'&&zone.length<=100&&Boolean(new Intl.DateTimeFormat('en',{timeZone:zone}).resolvedOptions().timeZone); } catch { return false; }
}
export function localTime(ms,zone) {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function zonedTime(local,zone) {
  if(typeof local!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)||!validZone(zone))return null;
  const naive=Date.parse(local+'Z');if(!Number.isFinite(naive)||new Date(naive).toISOString().slice(0,16)!==local)return null;
  const offsets=new Set();
  for(let h=-36;h<=36;h+=6){const instant=naive+h*3600000;offsets.add(Date.parse(localTime(instant,zone)+'Z')-instant);}
  const matches=[...offsets].map(offset=>naive-offset).filter(ms=>localTime(ms,zone)===local);
  return matches.length?Math.min(...matches):null; // DST fold: first occurrence; gap: explicit validation error.
}
export function validPlan(p) {
  if(!(p&&typeof p==='object'))return false;
  const allowed=new Set(['id','local','mode','state','text','repeat','end','allDay','important']);
  if(Object.keys(p).some(key=>!allowed.has(key)))return false;
  const repeat=p.repeat??{type:'once'},end=p.end??{type:'never'};
  const validRepeat=repeat&&typeof repeat==='object'&&(
    repeat.type==='once'&&Object.keys(repeat).length===1||repeat.type==='daily'&&Object.keys(repeat).length===1
    ||repeat.type==='weekly'&&Object.keys(repeat).length===2&&Array.isArray(repeat.days)&&repeat.days.length>0&&repeat.days.length<=7&&new Set(repeat.days).size===repeat.days.length&&repeat.days.every(day=>Number.isInteger(day)&&day>=1&&day<=7)
    ||repeat.type==='interval'&&Object.keys(repeat).length===2&&Number.isInteger(repeat.days)&&repeat.days>=2&&repeat.days<=365
    ||repeat.type==='monthly'&&Object.keys(repeat).length===3&&Number.isInteger(repeat.day)&&repeat.day>=1&&repeat.day<=31&&['last','skip'].includes(repeat.shortMonth));
  const validEnd=end&&typeof end==='object'&&(end.type==='never'&&Object.keys(end).length===1
    ||end.type==='date'&&Object.keys(end).length===2&&typeof end.date==='string'&&/^\d{4}-\d\d-\d\d$/.test(end.date)&&!Number.isNaN(Date.parse(end.date+'T00:00:00Z'))
    ||end.type==='count'&&Object.keys(end).length===2&&Number.isInteger(end.count)&&end.count>=1&&end.count<=10000);
  return validRepeat&&validEnd&&(p.allDay===undefined||typeof p.allDay==='boolean')&&(p.important===undefined||typeof p.important==='boolean')
    &&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.id)&&['active','off','done'].includes(p.state)
    &&['neutral','custom','title'].includes(p.mode)&&typeof p.local==='string'&&zonedTime(p.local,'UTC')!==null
    &&typeof p.text==='string'&&Array.from(p.text).length<=200&&(p.mode==='neutral'?p.text==='':p.mode==='custom'?Boolean(p.text.trim()):true);
}
export function normalizePlan(p){return{...p,repeat:p.repeat??{type:'once'},end:p.end??{type:'never'},allDay:p.allDay??false,important:p.important??false};}
const dateParts=local=>({year:Number(local.slice(0,4)),month:Number(local.slice(5,7)),day:Number(local.slice(8,10)),time:local.slice(11)});
const dateString=(date,time)=>date.toISOString().slice(0,10)+'T'+time;
const addDays=(local,days)=>{const p=dateParts(local);return dateString(new Date(Date.UTC(p.year,p.month-1,p.day+days)),p.time);};
export function nextOccurrenceLocal(input,current,sequence){
  const plan=normalizePlan(input),rule=plan.repeat;if(rule.type==='once')return null;
  let next;
  if(rule.type==='daily')next=addDays(current,1);
  else if(rule.type==='interval')next=addDays(current,rule.days);
  else if(rule.type==='weekly'){
    next=addDays(current,1);for(let attempt=0;attempt<7;attempt++,next=addDays(next,1)){
      const d=new Date(next+'Z').getUTCDay()||7;if(rule.days.includes(d))break;
    }
  }else{
    const base=dateParts(plan.local),present=dateParts(current);let offset=1,nextMonth;
    for(;;offset++){
      const first=new Date(Date.UTC(present.year,present.month-1+offset,1)),last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
      if(rule.day<=last||rule.shortMonth==='last'){const day=Math.min(rule.day,last);nextMonth=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),day));break;}
    }
    next=dateString(nextMonth,base.time);
  }
  if(plan.end.type==='count'&&sequence>=plan.end.count)return null;
  if(plan.end.type==='date'&&next.slice(0,10)>plan.end.date)return null;
  return next;
}
