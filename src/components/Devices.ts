import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { accountRequest, authMessage } from '../auth';
import { renameDevice } from '../planner';
import type { User } from '../types/auth';
const e=h;
interface DeviceSession {id:string;deviceId:string|null;deviceName:string;clientKind:'pwa'|'browser'|string;createdAt:number;lastSeen:number;revoked:boolean;expiresAt:number;current:boolean;pushActive:boolean}
function ago(value:number){const d=Math.max(0,Date.now()-value),m=Math.floor(d/60000),h=Math.floor(m/60),days=Math.floor(h/24);if(m<2)return'сейчас';if(m<60)return`${m} мин назад`;if(h<24)return`${h} ч назад`;if(days<7)return`${days} дн назад`;return'давно';}
export function DevicesScreen({user,onBack,onAuthLost}:{user:User;onBack:()=>void;onAuthLost:()=>Promise<void>}){
 const [items,setItems]=useState<DeviceSession[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
 async function load(){setBusy(true);setError('');try{const data=await accountRequest('devices');if(!Array.isArray(data.devices))throw Error('response');setItems(data.devices as DeviceSession[]);}catch(c){setError(authMessage(c));await onAuthLost();}finally{setBusy(false);}}
 useEffect(()=>{void load();},[]);
 async function revoke(id:string){if(!confirm('Завершить эту сессию? Локальные зашифрованные данные на том устройстве не будут удалены.'))return;setBusy(true);try{await accountRequest('devices/revoke',{id});await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 async function revokeOthers(){if(!confirm('Выйти на всех остальных устройствах? Текущая сессия останется активной.'))return;setBusy(true);try{await accountRequest('devices/revoke-others',{});await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 async function rename(item:DeviceSession){const value=prompt('Название устройства',item.deviceName)?.trim();if(!value||value===item.deviceName)return;setBusy(true);try{await accountRequest('devices/rename',{id:item.id,deviceName:value});if(item.current)await renameDevice(user,value);await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 return e('main',{class:'users-screen'},e('button',{onClick:onBack},'← Назад'),e('h1',{class:'screen-title'},'Устройства и сеансы'),
  e('div',{class:'actions'},e('button',{disabled:busy,onClick:()=>void load()},busy?'Обновляем…':'Обновить'),e('button',{disabled:busy,onClick:()=>void revokeOthers()},'Выйти на всех остальных')),
  error&&e('p',{class:'error',role:'alert'},error),e('ul',{class:'user-list'},items.map(item=>e('li',{key:item.id},
   e('strong',null,item.deviceName,item.current?' · это устройство':''),e('p',null,item.clientKind==='pwa'?'PWA':'Браузер',' · ',item.revoked?'сеанс завершён':'активен'),
   e('p',{class:'muted'},'Активность: ',ago(item.lastSeen),' · Push: ',item.pushActive?'включён':'не подключён'),e('div',{class:'actions'},e('button',{disabled:busy,onClick:()=>void rename(item)},'Переименовать'),
    !item.current&&!item.revoked&&e('button',{disabled:busy,onClick:()=>void revoke(item.id)},'Завершить сессию'))))));
}
