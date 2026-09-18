import { h as e, type ComponentChildren } from 'preact';
import type { User } from '../types/auth.ts';

export type ShellSection='notes'|'today'|'projects'|'settings';
function Icon({name}:{name:ShellSection|'logout'}){
  const common={width:22,height:22,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'} as const;
  if(name==='notes')return e('svg',common,e('path',{d:'M6 3.5h9l3 3V20.5H6z'}),e('path',{d:'M15 3.5v4h4'}),e('path',{d:'M9 11h6M9 15h6'}));
  if(name==='today')return e('svg',common,e('rect',{x:3.5,y:5.5,width:17,height:15,rx:2}),e('path',{d:'M7 3.5v4M17 3.5v4M3.5 9.5h17'}),e('path',{d:'M8 13h3v3H8z'}));
  if(name==='projects')return e('svg',common,e('path',{d:'M3.5 7h6l2-2h9v14.5h-17z'}),e('path',{d:'M3.5 9.5h17'}));
  if(name==='settings')return e('svg',common,e('circle',{cx:12,cy:12,r:3}),e('path',{d:'M19 13.5v-3l-2-.6a7 7 0 0 0-.7-1.6l1-1.9-2.1-2.1-1.9 1a7 7 0 0 0-1.6-.7L11 2H8l-.6 2a7 7 0 0 0-1.6.7l-1.9-1-2.1 2.1 1 1.9a7 7 0 0 0-.7 1.6L0 10v3l2 .6a7 7 0 0 0 .7 1.6l-1 1.9 2.1 2.1 1.9-1a7 7 0 0 0 1.6.7l.6 2h3l.6-2a7 7 0 0 0 1.6-.7l1.9 1 2.1-2.1-1-1.9a7 7 0 0 0 .7-1.6z',transform:'translate(1 0) scale(.92)'}));
  return e('svg',common,e('path',{d:'M10 5H5v14h5M14 8l4 4-4 4M8 12h10'}));
}
const nav:[ShellSection,string][]=[['notes','Заметки'],['today','Сегодня'],['projects','Проекты']];
export function AppShell({user,active,onNavigate,syncing,connection,loggingOut,onLogout,children,notice,error,updateNotice}:{
  user:User;active:ShellSection;onNavigate:(section:ShellSection)=>void;syncing:boolean;connection:'checking'|'online'|'offline'|'auth'|'error';
  loggingOut:boolean;onLogout:()=>void;children?:ComponentChildren;notice?:string;error?:string;updateNotice?:ComponentChildren;
}){
  const status=syncing?'Синхронизация…':connection==='offline'?'Офлайн':connection==='error'?'Ошибка связи':connection==='auth'?'Нужен вход':'Синхронизировано';
  return e('div',{class:'app-shell'},
    e('aside',{class:'app-sidebar','aria-label':'Основная навигация'},
      e('button',{class:'shell-brand',onClick:()=>onNavigate('notes'),'aria-label':'Tasks · заметки'},e('img',{src:'/icon.svg',width:36,height:36,alt:''}),e('span',null,'Tasks')),
      e('nav',{class:'shell-nav'},nav.map(([id,label])=>e('button',{key:id,class:active===id?'active':'','aria-current':active===id?'page':undefined,onClick:()=>onNavigate(id)},e(Icon,{name:id}),e('span',null,label))),
        e('button',{class:active==='settings'?'active':'','aria-current':active==='settings'?'page':undefined,onClick:()=>onNavigate('settings')},e(Icon,{name:'settings'}),e('span',null,'Настройки'))),
      e('div',{class:'sidebar-account'},e('span',{class:'avatar','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),e('div',null,e('strong',null,user.login),e('small',null,user.role==='admin'?'Администратор':'Пользователь')),
        e('button',{class:'icon-button',disabled:loggingOut,onClick:onLogout,'aria-label':'Выйти'},e(Icon,{name:'logout'})))),
    e('div',{class:'shell-main'},
      e('header',{class:'mobile-shell-header'},e('button',{class:'mobile-brand',onClick:()=>onNavigate('notes')},e('img',{src:'/icon.svg',width:32,height:32,alt:''}),e('strong',null,'Tasks')),
        e('div',{class:'mobile-header-actions'},e('span',{class:'shell-status '+connection,role:'status','aria-live':'polite'},syncing&&e('span',{class:'sync-spinner','aria-hidden':'true'}),status),
          e('button',{class:'icon-button',onClick:()=>onNavigate('settings'),'aria-label':'Настройки'},e(Icon,{name:'settings'})))),
      connection==='offline'&&e('div',{class:'offline-banner shell-offline',role:'status'},'ОФЛАЙН РЕЖИМ · изменения сохраняются на устройстве'),
      error&&e('div',{class:'shell-message error',role:'alert'},error),
      notice&&e('div',{class:'shell-message auth-notice',role:'status'},notice),
      updateNotice,
      e('div',{class:'shell-content'},children)),
    e('nav',{class:'bottom-nav','aria-label':'Основная навигация'},nav.map(([id,label])=>e('button',{key:id,class:active===id?'active':'','aria-current':active===id?'page':undefined,onClick:()=>onNavigate(id)},e(Icon,{name:id}),e('span',null,label))))
  );
}
