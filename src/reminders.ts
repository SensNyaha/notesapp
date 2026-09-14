import type { User } from './types/auth.ts';
import { readState } from './storage.ts';
import { session } from './auth.ts';

export interface ReminderSettings { zone:string;nudge_hours:number;all_day_time:string }
export interface ReminderTarget { accountId:string;vaultId:string;objectId:string;configId:string;occurrenceId?:string }
export interface ReminderStatus {
  id:string;vault_id:string;object_id:string;config_id:string;record_id:string;local_at:string;due_at:number|null;schedule:string;
  plan_state:'active'|'off'|'done';paused:number;occurrence_id:string;sequence:number;scheduled_local:string;snooze_local:string|null;effective_due_at:number|null;
  occurrence_status:'scheduled'|'fired'|'seen'|'done'|'skipped'|'missed';fired_at:number|null;seen_at:number|null;completed_at:number|null;delivery:string|null;
}

const messages:Record<string,string>={
  invalid_timezone:'Часовой пояс устройства не поддерживается.',invalid_local_time:'Выбранного времени не существует в текущем часовом поясе.',
  invalid_reminder:'Проверьте дату, время и текст напоминания.',reminder_conflict:'Напоминание приостановлено до разрешения конфликта версий.',
  reminder_limit:'Достигнут лимит 1000 напоминаний аккаунта.',account_mismatch:'Открыт другой аккаунт.',
  unauthorized:'Войдите в аккаунт для синхронизации напоминаний.',vault_locked:'Откройте хранилище для синхронизации напоминания.',
  occurrence_missing:'Срабатывание уже удалено или изменено.',
};

export async function reminderRequest(user:User,path:string,body?:unknown,vaultIds:string[]=[]):Promise<any>{
  const state=await readState(user.id),grants:Record<string,string>={};
  for(const id of vaultIds){const grant=state?.vaults.find(v=>v.header.id===id)?.grant;if(grant)grants[id]=grant;}
  const perform=async()=>{
    const headers:Record<string,string>={'X-Tasks-Account':user.id,
      ...(vaultIds.length?{'X-Tasks-Device':state?.deviceId??'','X-Vault-Grants':JSON.stringify(grants)}:{})};
    if(body!==undefined){const csrf=await fetch('/api/auth/csrf',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
      if(!csrf.ok)throw Error('Не удалось подготовить защищённый запрос.');headers['X-CSRF-Token']=(await csrf.json()).csrf;headers['Content-Type']='application/json';}
    const response=await fetch('/api/reminders'+(path?'/'+path:''),{credentials:'same-origin',cache:'no-store',headers,
      method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    return{response,value:await response.json()};
  };
  let {response,value}=await perform();
  if(response.status===401&&(await session())?.id===user.id)({response,value}=await perform());
  if(!response.ok)throw Error(messages[value.error]??'Не удалось синхронизировать напоминание ('+(value.error??response.status)+').');
  return value;
}

export async function updateReminderZone(user:User){
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  if(zone)return reminderRequest(user,'zone',{zone});
}
