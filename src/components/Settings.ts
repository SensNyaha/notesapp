import { h as e } from 'preact';
import { useMemo,useState } from 'preact/hooks';
import type { User } from '../types/auth.ts';
import { readThemePreference,setThemePreference,type ThemePreference } from '../preferences.ts';

export type SettingsPage='account'|'appearance'|'notifications'|'devices'|'passkeys'|'collaboration'|'data'|'diagnostics'|'password'|'users'|'archive'|'trash'|'about';
const items:{id:SettingsPage;title:string;description:string;admin?:boolean;keywords:string}[]=[
  {id:'account',title:'Аккаунт и безопасность',description:'Профиль, пароль и способы входа',keywords:'аккаунт профиль пароль безопасность вход'},
  {id:'appearance',title:'Оформление',description:'Системная, светлая или тёмная тема',keywords:'оформление тема светлая темная системная'},
  {id:'notifications',title:'Уведомления и часовой пояс',description:'Push, повторы, приватность текста и время «Весь день»',keywords:'уведомления push напоминания часовой пояс приватность'},
  {id:'devices',title:'Устройства и сессии',description:'Активные входы и отзыв отдельных сессий',keywords:'устройства сессии выход'},
  {id:'passkeys',title:'Ключи доступа',description:'Passkey, Face ID, Touch ID и Windows Hello',keywords:'passkey ключ face id windows hello'},
  {id:'archive',title:'Архив',description:'Архивированные заметки текущего хранилища',keywords:'архив заметки'},
  {id:'trash',title:'Корзина',description:'Восстановление и окончательное удаление',keywords:'корзина удалить восстановить'},
  {id:'collaboration',title:'Контакты и совместная работа',description:'Контакты, shared vault и доступ участников',keywords:'контакты друзья shared совместная работа'},
  {id:'data',title:'Данные и резервные копии',description:'Импорт, экспорт и зашифрованный backup',keywords:'данные импорт экспорт backup резервные копии'},
  {id:'diagnostics',title:'Диагностика',description:'Сервер, PWA, Web Crypto и локальное хранилище',keywords:'диагностика сервер pwa crypto'},
  {id:'users',title:'Пользователи',description:'Администрирование аккаунтов и временных паролей',keywords:'пользователи админ временный пароль',admin:true},
  {id:'about',title:'О приложении',description:'Версия, платформа и текущий часовой пояс',keywords:'версия приложение timezone часовой пояс'},
];
export function SettingsHub({user,onOpen,onLogout,loggingOut}:{user:User;onOpen:(page:SettingsPage)=>void;onLogout:()=>void;loggingOut:boolean}){
  const [query,setQuery]=useState('');const normalized=query.trim().toLocaleLowerCase('ru');
  const filtered=useMemo(()=>items.filter(item=>(!item.admin||user.role==='admin')&&(!normalized||(item.title+' '+item.description+' '+item.keywords).toLocaleLowerCase('ru').includes(normalized))),[normalized,user.role]);
  return e('main',{class:'settings-screen'},
    e('div',{class:'screen-heading'},e('div',null,e('p',{class:'eyebrow'},'НАСТРОЙКИ'),e('h1',null,'Настройки')),e('span',{class:'avatar large','aria-hidden':'true'},user.login.slice(0,1).toUpperCase())),
    e('section',{class:'profile-summary card'},e('div',{class:'profile-main'},e('span',{class:'avatar','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),e('div',null,e('strong',null,user.login),e('small',null,user.role==='admin'?'Администратор':'Пользователь'))),
      e('button',{onClick:()=>onOpen('account')},'Открыть аккаунт')),
    e('label',{class:'settings-search'},'Поиск по настройкам',e('input',{type:'search',value:query,placeholder:'Например, уведомления или backup',onInput:(ev:Event)=>setQuery((ev.target as HTMLInputElement).value)})),
    e('section',{class:'settings-list','aria-label':'Разделы настроек'},filtered.map(item=>e('button',{key:item.id,class:'settings-row',onClick:()=>onOpen(item.id)},
      e('div',null,e('strong',null,item.title),e('small',null,item.description)),e('span',{class:'settings-arrow','aria-hidden':'true'},'›'))),
      !filtered.length&&e('div',{class:'empty-state'},e('h2',null,'Ничего не найдено'),e('p',null,'Измените поисковый запрос.'))),
    e('button',{class:'settings-logout danger-button',disabled:loggingOut,onClick:onLogout},loggingOut?'Выходим…':'Выйти из аккаунта'));
}
export function AccountOverview({user,onOpen,onLogout,loggingOut}:{user:User;onOpen:(page:SettingsPage)=>void;onLogout:()=>void;loggingOut:boolean}){
  return e('main',{class:'settings-screen account-screen'},
    e('div',{class:'screen-heading'},e('div',null,e('p',{class:'eyebrow'},'АККАУНТ'),e('h1',null,'Аккаунт и безопасность'))),
    e('section',{class:'card account-identity'},e('span',{class:'avatar profile-avatar','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),e('div',null,e('h2',null,user.login),e('p',{class:'muted'},user.role==='admin'?'Администратор системы':'Пользователь'))),
    e('section',{class:'card'},e('h2',null,'Безопасность'),
      e('div',{class:'settings-inline-list'},
        e('button',{onClick:()=>onOpen('password')},e('span',null,e('strong',null,'Изменить пароль'),e('small',null,'Пароль серверного аккаунта')),e('span',{'aria-hidden':'true'},'›')),
        e('button',{onClick:()=>onOpen('passkeys')},e('span',null,e('strong',null,'Ключи доступа'),e('small',null,'Дополнительный вход через Passkey')),e('span',{'aria-hidden':'true'},'›')),
        e('button',{onClick:()=>onOpen('devices')},e('span',null,e('strong',null,'Активные сессии'),e('small',null,'Устройства, где выполнен вход')),e('span',{'aria-hidden':'true'},'›')))),
    e('p',{class:'hint'},'Серверная модель аккаунта сейчас использует логин и роль. Имя, email и 2FA не добавляются как фиктивные поля только ради концепт-макета.'),
    e('button',{class:'danger-button',disabled:loggingOut,onClick:onLogout},loggingOut?'Выходим…':'Выйти из аккаунта'));
}
export function AppearanceSettings(){
  const [theme,setTheme]=useState<ThemePreference>(()=>readThemePreference());
  const change=(value:ThemePreference)=>{setTheme(value);setThemePreference(value);};
  return e('main',{class:'settings-screen'},
    e('div',{class:'screen-heading'},e('div',null,e('p',{class:'eyebrow'},'ОФОРМЛЕНИЕ'),e('h1',null,'Тема приложения'))),
    e('section',{class:'card appearance-options'},(['system','light','dark'] as ThemePreference[]).map(value=>
      e('label',{class:'theme-choice'},e('input',{type:'radio',name:'theme',value,checked:theme===value,onChange:()=>change(value)}),
        e('span',null,e('strong',null,value==='system'?'Как в системе':value==='light'?'Светлая':'Тёмная'),
          e('small',null,value==='system'?'Следует настройке iOS, Android или компьютера':value==='light'?'Всегда светлое оформление':'Всегда тёмное оформление'))))),
    e('p',{class:'hint'},'Настройка хранится только на этом устройстве и не раскрывает содержимое хранилищ серверу.'));
}
export function AboutSettings(){
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  const standalone=matchMedia('(display-mode: standalone)').matches||Boolean((navigator as Navigator&{standalone?:boolean}).standalone);
  return e('main',{class:'settings-screen'},
    e('div',{class:'screen-heading'},e('div',null,e('p',{class:'eyebrow'},'О ПРИЛОЖЕНИИ'),e('h1',null,'Tasks 0.20.0'))),
    e('section',{class:'card about-grid'},
      e('div',null,e('span',null,'Версия'),e('strong',null,'0.20.0')),
      e('div',null,e('span',null,'Режим'),e('strong',null,standalone?'Установленная PWA':'Браузер')),
      e('div',null,e('span',null,'Часовой пояс устройства'),e('strong',null,zone))),
    e('p',{class:'hint'},'Часовой пояс аккаунта обновляется из текущего часового пояса устройства при работе онлайн; отдельное серверное хранение пользовательского текста для этого не требуется.'));
}
