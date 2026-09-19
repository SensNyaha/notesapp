import { h as e, type ComponentChildren } from 'preact';
import type { User } from '../types/auth.ts';
import { StatusDot,UiIcon } from './ui.ts';

export type ShellSection='notes'|'today'|'projects'|'settings';
const nav:[ShellSection,string,'notes'|'today'|'projects'|'settings'][]=[
  ['notes','Заметки','notes'],['today','Сегодня','today'],['projects','Проекты','projects'],['settings','Настройки','settings']
];

export function AppShell({user,active,onNavigate,syncing,connection,loggingOut,onLogout,children,notice,error,updateNotice}:{
  user:User;active:ShellSection;onNavigate:(section:ShellSection)=>void;syncing:boolean;connection:'checking'|'online'|'offline'|'auth'|'error';
  loggingOut:boolean;onLogout:()=>void;children?:ComponentChildren;notice?:string;error?:string;updateNotice?:ComponentChildren;
}){
  const status=syncing?'Синхронизация…':connection==='offline'?'Офлайн':connection==='error'?'Ошибка связи':connection==='auth'?'Нужен вход':'Синхронизировано';
  const tone=connection==='offline'?'warning':connection==='error'||connection==='auth'?'danger':syncing||connection==='checking'?'accent':'success';
  const rootNav=nav.filter(([id])=>id!=='settings');
  return e('div',{class:'app-shell'},
    e('aside',{class:'app-sidebar','aria-label':'Основная навигация'},
      e('button',{class:'shell-brand',onClick:()=>onNavigate('notes'),'aria-label':'Tasks · заметки'},
        e('span',{class:'shell-brand-mark'},e('img',{src:'/icon.svg',width:34,height:34,alt:''})),
        e('span',{class:'shell-brand-copy'},e('strong',null,'Tasks'),e('small',null,'Workspace'))),
      e('nav',{class:'shell-nav'},nav.map(([id,label,icon])=>
        e('button',{key:id,class:active===id?'active':'','aria-current':active===id?'page':undefined,onClick:()=>onNavigate(id),title:label},
          e(UiIcon,{name:icon}),e('span',null,label)))),
      e('div',{class:'sidebar-sync'},e(StatusDot,{tone}),e('span',null,status)),
      e('div',{class:'sidebar-account'},
        e('span',{class:'avatar','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),
        e('div',{class:'sidebar-account-copy'},e('strong',null,user.login),e('small',null,user.role==='admin'?'Администратор':'Пользователь')),
        e('button',{class:'icon-button',disabled:loggingOut,onClick:onLogout,'aria-label':'Выйти',title:'Выйти'},e(UiIcon,{name:'logout'})))),

    e('div',{class:'shell-main'},
      e('header',{class:'mobile-shell-header'},
        e('button',{class:'mobile-brand',onClick:()=>onNavigate('notes'),'aria-label':'Tasks'},
          e('img',{src:'/icon.svg',width:30,height:30,alt:''}),e('strong',null,'Tasks')),
        e('div',{class:'mobile-header-actions'},
          e('button',{class:'mobile-sync-button','aria-label':status,title:status},
            e(StatusDot,{tone}),e('span',null,status)),
          e('button',{class:'icon-button',onClick:()=>onNavigate('settings'),'aria-label':'Настройки'},e(UiIcon,{name:'settings'})))),
      connection==='offline'&&e('div',{class:'offline-banner shell-offline',role:'status'},
        e(UiIcon,{name:'wifi-off',size:18}),e('div',null,e('strong',null,'Работа без подключения'),e('span',null,'Изменения сохраняются локально и синхронизируются после восстановления сети.'))),
      error&&e('div',{class:'shell-message error',role:'alert'},error),
      notice&&e('div',{class:'shell-message auth-notice',role:'status'},notice),
      updateNotice,
      e('div',{class:'shell-content'},children)),

    e('nav',{class:'bottom-nav','aria-label':'Основная навигация'},rootNav.map(([id,label,icon])=>
      e('button',{key:id,class:active===id?'active':'','aria-current':active===id?'page':undefined,onClick:()=>onNavigate(id)},
        e(UiIcon,{name:icon}),e('span',null,label))))
  );
}
