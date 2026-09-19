import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { authMessage, deletePasskey, listPasskeys, registerPasskey, webAuthnCapability, type PasskeyInfo } from '../auth';
import { readState } from '../storage';
import type { User } from '../types/auth';
import { PageHeader,UiIcon } from './ui.ts';
const e=h;
function date(value:number|null){return value?new Date(value).toLocaleDateString('ru-RU'):'ещё не использовался';}
export function PasskeysScreen({user,onBack}:{user:User;onBack:()=>void}){
 const [items,setItems]=useState<PasskeyInfo[]>([]),[available,setAvailable]=useState(false),[platform,setPlatform]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState('');
 async function load(){setBusy(true);setError('');try{const [capability,passkeys]=await Promise.all([webAuthnCapability(),listPasskeys()]);setAvailable(capability.available);setPlatform(capability.platform);setItems(passkeys);}catch(c){setError(authMessage(c));}finally{setBusy(false);}}
 useEffect(()=>{void load();},[]);
 async function add(){if(!available||busy)return;setBusy(true);setError('');try{const state=await readState(user.id);const fallback=platform?'Системный ключ доступа':'Ключ доступа';await registerPasskey((state?.deviceName||fallback).slice(0,80));await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 async function remove(item:PasskeyInfo){if(!confirm(`Удалить «${item.displayName}» как способ входа?\n\nЛокальная системная разблокировка хранилищ управляется отдельно.`))return;setBusy(true);setError('');try{await deletePasskey(item.id);await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 return e('main',{class:'settings-screen passkeys-screen'},
  e(PageHeader,{eyebrow:'Безопасность',title:'Ключи доступа',description:'Дополнительный способ входа без замены логина и пароля.',back:onBack,
   actions:e('button',{class:'primary',disabled:busy||!available,onClick:()=>void add()},e(UiIcon,{name:'plus',size:17}),busy?'Подождите…':'Добавить ключ')}),
  !available&&e('div',{class:'inline-alert warning'},e(UiIcon,{name:'warning',size:18}),e('span',null,'WebAuthn недоступен в этом браузере. Используйте вход по логину и паролю.')),
  available&&!platform&&e('div',{class:'inline-alert info'},e(UiIcon,{name:'info',size:18}),e('span',null,'Браузер не подтверждает встроенный системный аутентификатор. Возможен внешний или синхронизируемый ключ доступа.')),
  error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
  !busy&&!items.length&&e('div',{class:'empty-state card'},e(UiIcon,{name:'key',size:32}),e('h2',null,'Ключей доступа пока нет'),e('p',null,'Добавьте Passkey, чтобы быстрее входить на поддерживаемых устройствах.')),
  e('section',{class:'passkey-list'},items.map(item=>e('article',{class:'passkey-card',key:item.id},
   e('div',{class:'passkey-icon'},e(UiIcon,{name:'key',size:22})),
   e('div',{class:'passkey-copy'},e('strong',null,item.displayName),e('p',null,item.deviceType==='multiDevice'?'Синхронизируемый ключ доступа':'Ключ одного аутентификатора'),e('small',null,'Добавлен: '+date(item.createdAt)+' · последнее использование: '+date(item.lastUsed))),
   e('button',{class:'text-danger-button',disabled:busy,onClick:()=>void remove(item)},'Удалить')))),
  e('div',{class:'info-panel'},e(UiIcon,{name:'info',size:18}),e('p',null,'Удаление запрещает этому credential вход в Tasks, но не удаляет его из iCloud Keychain, Google Password Manager или Windows и не меняет ключи E2EE-хранилищ.')));
}
