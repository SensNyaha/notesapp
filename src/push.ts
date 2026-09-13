import { session, signOut } from './auth.ts';
import type { User } from './types/auth';

const messages:Record<string,string>={
  unauthorized:'Войдите в аккаунт для настройки уведомлений.',account_mismatch:'Сейчас на сервере выбран другой аккаунт.',
  push_unavailable:'Уведомления доступны после настройки HTTPS на сервере.',
  unsupported_push_service:'Эта push-служба пока не поддерживается. Поддерживаются Safari, Chrome/Edge и Firefox со стандартными push-службами.',
  subscription_in_use:'Подписка относится к другому сеансу. Отключите уведомления и включите заново.',
  rate_limited:'Повторный тест доступен через 30 секунд.',test_pending:'Предыдущий тест ещё ожидает отправки.',
  push_not_subscribed:'Сначала включите уведомления.',push_limit:'Достигнут лимит подписок аккаунта.',
  csrf:'Повторите действие: проверка запроса не прошла.',forbidden:'Адрес приложения не совпадает с настройкой сервера.',
};
export async function pushRequest(user:User,path:string,body?:object):Promise<any>{
  const current=await session();if(current?.id!==user.id)throw Error(messages.account_mismatch);
  const headers:Record<string,string>={'X-Tasks-Account':user.id};
  if(body!==undefined){
    const response=await fetch('/api/auth/csrf',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
    const data=await response.json();if(!response.ok||typeof data.csrf!=='string')throw Error('Не удалось подготовить запрос');
    headers['X-CSRF-Token']=data.csrf;headers['Content-Type']='application/json';
  }
  const response=await fetch('/api/push/'+path,{credentials:'same-origin',cache:'no-store',headers,method:body===undefined?'GET':'POST',
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const data=await response.json();if(!response.ok)throw Error(messages[data.error]??'Не удалось выполнить запрос. Проверьте сеть и повторите.');
  return data;
}
export const pushLock=<T>(fn:()=>Promise<T>):Promise<T>=>{
  if(!navigator.locks)return Promise.reject(Error('Браузер не поддерживает безопасное управление подпиской'));
  return navigator.locks.request('tasks-push',fn);
};
export async function browserUnsubscribe(){
  if(!('serviceWorker'in navigator))return;
  const reg=await navigator.serviceWorker.getRegistration('/');
  if(!reg||!('pushManager'in reg))return;
  const sub=await reg.pushManager.getSubscription();
  if(sub&&!await sub.unsubscribe())throw Error('Не удалось отключить подписку браузера. Повторите действие.');
}
export async function detachPush(){return pushLock(async()=>{
  const current=await session();
  if(current&&!current.mustChangePassword)await pushRequest(current,'detach',{});
  // Revoke the shared browser session so a racing tab cannot reattach the old account.
  // Local profiles and vault keys are intentionally kept by the account-switch action.
  await signOut();
  await browserUnsubscribe();
});}
export async function enablePush(user:User,deviceId:string,publicKey:string){return pushLock(async()=>{
  const reg=await navigator.serviceWorker.getRegistration('/');if(!reg?.active)throw Error('Оболочка ещё не готова. Повторите проверку.');
  let sub=await reg.pushManager.getSubscription();
  const status=await pushRequest(user,'status',{deviceId});
  if(sub&&!status.active){await browserUnsubscribe();sub=null;}
  if(!sub){const key=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});}
  const value=sub.toJSON();
  // Browser expirationTime is advisory, not an account or device identity.
  await pushRequest(user,'subscribe',{deviceId,subscription:{endpoint:value.endpoint,keys:value.keys}});
});}
export async function disablePush(user:User,deviceId:string){return pushLock(async()=>{
  await pushRequest(user,'disable',{deviceId});await browserUnsubscribe();
});}
