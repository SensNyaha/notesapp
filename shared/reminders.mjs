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
  return p&&typeof p==='object'&&JSON.stringify(Object.keys(p).sort())==='["id","local","mode","state","text"]'
    &&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.id)&&['active','off','done'].includes(p.state)
    &&['neutral','custom'].includes(p.mode)&&typeof p.local==='string'&&zonedTime(p.local,'UTC')!==null
    &&typeof p.text==='string'&&Array.from(p.text).length<=200&&(p.mode==='custom'?Boolean(p.text.trim()):p.text==='');
}
