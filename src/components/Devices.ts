import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { accountRequest, authMessage } from '../auth';
import { renameDevice } from '../planner';
import type { User } from '../types/auth';
import { PageHeader,StatusDot,UiIcon } from './ui.ts';
import { appConfirm,appPrompt } from './AppDialog.ts';
const e=h;
interface DeviceSession {id:string;deviceId:string|null;deviceName:string;clientKind:'pwa'|'browser'|string;createdAt:number;lastSeen:number;revoked:boolean;expiresAt:number;current:boolean;pushActive:boolean}
function ago(value:number){const d=Math.max(0,Date.now()-value),m=Math.floor(d/60000),h=Math.floor(m/60),days=Math.floor(h/24);if(m<2)return'сейчас';if(m<60)return`${m} мин назад`;if(h<24)return`${h} ч назад`;if(days<7)return`${days} дн назад`;return'давно';}
export function DevicesScreen({user,onBack,onAuthLost}:{user:User;onBack:()=>void;onAuthLost:()=>Promise<void>}){
 const [items,setItems]=useState<DeviceSession[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
 async function load(){setBusy(true);setError('');try{const data=await accountRequest('devices');if(!Array.isArray(data.devices))throw Error('response');setItems(data.devices as DeviceSession[]);}catch(c){setError(authMessage(c));await onAuthLost();}finally{setBusy(false);}}
 useEffect(()=>{void load();},[]);
 async function revoke(id:string){if(!await appConfirm('Локальные зашифрованные данные на том устройстве не будут удалены.',{title:'Завершить эту сессию?',confirmLabel:'Завершить',danger:true}))return;setBusy(true);try{await accountRequest('devices/revoke',{id});await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 async function revokeOthers(){if(!await appConfirm('Текущая сессия останется активной.',{title:'Выйти на остальных устройствах?',confirmLabel:'Выйти',danger:true}))return;setBusy(true);try{await accountRequest('devices/revoke-others',{});await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 async function rename(item:DeviceSession){const value=(await appPrompt('Название устройства',item.deviceName))?.trim();if(!value||value===item.deviceName)return;setBusy(true);try{await accountRequest('devices/rename',{id:item.id,deviceName:value});if(item.current)await renameDevice(user,value);await load();}catch(c){setError(authMessage(c));setBusy(false);}}
 return e('main',{class:'settings-screen devices-screen'},
  e(PageHeader,{eyebrow:'Безопасность',title:'Устройства и сессии',description:'Управляйте активными входами и именами устройств.',back:onBack,
    actions:e('div',{class:'header-actions'},e('button',{class:'secondary-button',disabled:busy,onClick:()=>void load()},e(UiIcon,{name:'sync',size:17}),busy?'Обновляем…':'Обновить'),
      e('button',{class:'text-danger-button',disabled:busy,onClick:()=>void revokeOthers()},'Выйти на остальных'))}),
  error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
  !busy&&!items.length&&e('div',{class:'empty-state card'},e(UiIcon,{name:'devices',size:30}),e('h2',null,'Нет активных сессий')),
  e('section',{class:'session-list'},items.map(item=>e('article',{class:'session-card '+(item.current?'current ':'')+(item.revoked?'revoked':''),key:item.id},
    e('div',{class:'session-icon'},e(UiIcon,{name:'devices',size:22})),
    e('div',{class:'session-main'},
      e('div',{class:'session-title-row'},e('strong',null,item.deviceName),item.current&&e('span',{class:'badge accent'},'Это устройство'),item.revoked&&e('span',{class:'badge'},'Завершена')),
      e('p',null,item.clientKind==='pwa'?'Установленная PWA':'Браузер'),
      e('div',{class:'session-meta'},e('span',null,e(StatusDot,{tone:item.revoked?'neutral':'success'}),item.revoked?'Сеанс завершён':'Активен'),e('span',null,'Активность: '+ago(item.lastSeen)),e('span',null,'Push: '+(item.pushActive?'подключён':'не подключён')))),
    e('div',{class:'session-actions'},e('button',{class:'tertiary-button',disabled:busy,onClick:()=>void rename(item)},'Переименовать'),
      !item.current&&!item.revoked&&e('button',{class:'text-danger-button',disabled:busy,onClick:()=>void revoke(item.id)},'Завершить'))))));
}
