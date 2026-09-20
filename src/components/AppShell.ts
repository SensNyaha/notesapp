import { h as e, type ComponentChildren } from 'preact';
import type { User } from '../types/auth.ts';
import { StatusDot,UiIcon } from './ui.ts';

export type ShellSection='notes'|'today'|'projects'|'settings';
export interface ShellVaultContext {
  value:string;
  options:{value:string;label:string}[];
  onChange:(value:string)=>void;
}
const nav:[ShellSection,string,'notes'|'today'|'projects'|'settings'][]=[
  ['notes','Заметки','notes'],['today','Сегодня','today'],['projects','Проекты','projects'],['settings','Настройки','settings']
];

export function AppShell({user,active,onNavigate,syncing,connection,loggingOut,onLogout,children,notice,error,updateNotice,vaultContext}:{
  user:User;active:ShellSection;onNavigate:(section:ShellSection)=>void;syncing:boolean;connection:'checking'|'online'|'offline'|'auth'|'error';
  loggingOut:boolean;onLogout:()=>void;children?:ComponentChildren;notice?:string;error?:string;updateNotice?:ComponentChildren;vaultContext?:ShellVaultContext|null;
}){
  const status=syncing?'Синхронизация…':connection==='checking'?'Проверяем связь…':connection==='offline'?'Офлайн':connection==='error'?'Ошибка связи':connection==='auth'?'Нужен вход':'Синхронизировано';
  const statusVisible=syncing||connection!=='online';
  const tone=connection==='offline'?'warning':connection==='error'||connection==='auth'?'danger':syncing||connection==='checking'?'accent':'success';
  const rootNav=nav;
  return e('div',{class:'app-shell'},
    e('aside',{class:'app-sidebar','aria-label':'Основная навигация'},
      e('button',{class:'shell-brand',onClick:()=>onNavigate('notes'),'aria-label':'Tasks · заметки'},
        e('span',{class:'shell-brand-mark'},e('img',{src:'/icon.svg',width:34,height:34,alt:''})),
        e('span',{class:'shell-brand-copy'},e('strong',null,'Tasks'),e('small',null,'Workspace'))),
      e('nav',{class:'shell-nav'},nav.map(([id,label,icon])=>
        e('button',{key:id,class:active===id?'active':'','aria-current':active===id?'page':undefined,onClick:()=>onNavigate(id),title:label},
          e(UiIcon,{name:icon}),e('span',null,label)))),
      e('div',{class:'sidebar-sync '+(syncing?'syncing':''),title:status,'aria-label':status},e(StatusDot,{tone}),statusVisible&&e('span',null,status)),
      e('div',{class:'sidebar-account'},
        e('span',{class:'avatar','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),
        e('div',{class:'sidebar-account-copy'},e('strong',null,user.login),e('small',null,user.role==='admin'?'Администратор':'Пользователь')),
        e('button',{class:'icon-button',disabled:loggingOut,onClick:onLogout,'aria-label':'Выйти',title:'Выйти'},e(UiIcon,{name:'logout'})))),

    e('div',{class:'shell-main'},
      e('header',{class:'mobile-shell-header'},
        e('button',{class:'mobile-brand',onClick:()=>onNavigate('notes'),'aria-label':'Tasks'},
          e('img',{src:'/icon.svg',width:30,height:30,alt:''}),e('strong',null,'Tasks')),
        e('div',{class:'mobile-shell-context'},vaultContext&&
          e('label',{class:'mobile-vault-context'},
            e(UiIcon,{name:'database',size:16}),
            e('select',{value:vaultContext.value,'aria-label':'Текущее хранилище',onChange:(event:Event)=>vaultContext.onChange((event.target as HTMLSelectElement).value)},
              !vaultContext.value&&e('option',{value:'',disabled:true},'Выберите хранилище'),vaultContext.options.map(option=>e('option',{key:option.value,value:option.value},option.label))))),
        e('div',{class:'mobile-header-actions'},
          e('span',{class:'mobile-sync-indicator '+(syncing?'syncing':''),'aria-label':status,title:status,role:'status'},e(StatusDot,{tone})))),
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
