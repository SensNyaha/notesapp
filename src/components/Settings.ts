import { h as e } from 'preact';
import { useMemo,useState } from 'preact/hooks';
import type { User } from '../types/auth.ts';
import { readThemePreference,setThemePreference,type ThemePreference } from '../preferences.ts';
import { Chevron,InfoTip,PageHeader,UiIcon,type UiIconName } from './ui.ts';

export type SettingsPage='account'|'appearance'|'notifications'|'devices'|'passkeys'|'collaboration'|'data'|'diagnostics'|'password'|'users'|'ocr-test'|'archive'|'trash'|'about';

interface SettingsItem{
  id:SettingsPage;title:string;description:string;admin?:boolean;keywords:string;icon:UiIconName;group:'Основное'|'Данные и доступ'|'Система';
}
const items:SettingsItem[]=[
  {id:'account',title:'Аккаунт и безопасность',description:'Пароль, способы входа и активные сессии',keywords:'аккаунт профиль пароль безопасность вход',icon:'user',group:'Основное'},
  {id:'appearance',title:'Оформление',description:'Системная, светлая или тёмная тема',keywords:'оформление тема светлая темная системная',icon:'palette',group:'Основное'},
  {id:'notifications',title:'Уведомления и часовой пояс',description:'Push, повторы, приватность текста и «Весь день»',keywords:'уведомления push напоминания часовой пояс приватность',icon:'bell',group:'Основное'},
  {id:'devices',title:'Устройства и сессии',description:'Активные входы, имена устройств и отзыв сессий',keywords:'устройства сессии выход',icon:'devices',group:'Основное'},
  {id:'passkeys',title:'Ключи доступа',description:'Passkey и системные WebAuthn-аутентификаторы',keywords:'passkey ключ face id windows hello',icon:'key',group:'Основное'},
  {id:'archive',title:'Архив',description:'Архивированные заметки текущего хранилища',keywords:'архив заметки',icon:'archive',group:'Данные и доступ'},
  {id:'trash',title:'Корзина',description:'Восстановление и окончательное удаление',keywords:'корзина удалить восстановить',icon:'trash',group:'Данные и доступ'},
  {id:'collaboration',title:'Контакты и совместная работа',description:'Контакты, совместные хранилища и ключ шифрования',keywords:'контакты друзья совместная работа шифрование',icon:'contacts',group:'Данные и доступ'},
  {id:'data',title:'Данные и резервные копии',description:'Импорт, экспорт и зашифрованные резервные копии',keywords:'данные импорт экспорт резервные копии',icon:'database',group:'Данные и доступ'},
  {id:'diagnostics',title:'Диагностика',description:'Сервер, PWA, Web Crypto и локальное хранилище',keywords:'диагностика сервер pwa crypto',icon:'diagnostics',group:'Система'},
  {id:'users',title:'Пользователи',description:'Аккаунты и временные пароли',keywords:'пользователи админ временный пароль',icon:'users',group:'Система',admin:true},
  {id:'ocr-test',title:'OCR · тестовая страница',description:'Локальное распознавание текста в тестовой заметке',keywords:'ocr htr распознавание изображение рукописный печатный тест',icon:'image',group:'Система',admin:true},
  {id:'about',title:'О приложении',description:'Версия, режим запуска и часовой пояс',keywords:'версия приложение timezone часовой пояс',icon:'info',group:'Система'},
];

function SettingsRow({item,onOpen}:{item:SettingsItem;onOpen:(page:SettingsPage)=>void}){
  return e('button',{class:'settings-row',onClick:()=>onOpen(item.id)},
    e('span',{class:'settings-row-icon'},e(UiIcon,{name:item.icon,size:20})),
    e('span',{class:'settings-row-copy'},e('strong',null,item.title),e('small',null,item.description)),
    e('span',{class:'settings-row-chevron'},e(Chevron,null)));
}

export function SettingsHub({user,onOpen,onLogout,loggingOut}:{user:User;onOpen:(page:SettingsPage)=>void;onLogout:()=>void;loggingOut:boolean}){
  const [query,setQuery]=useState('');
  const normalized=query.trim().toLocaleLowerCase('ru');
  const filtered=useMemo(()=>items.filter(item=>(!item.admin||user.role==='admin')&&(!normalized||(item.title+' '+item.description+' '+item.keywords).toLocaleLowerCase('ru').includes(normalized))),[normalized,user.role]);
  const groups=(['Основное','Данные и доступ','Система'] as const).map(group=>({group,items:filtered.filter(item=>item.group===group)})).filter(group=>group.items.length);

  return e('main',{class:'settings-screen'},
    e(PageHeader,{title:'Настройки'}),
    e('section',{class:'profile-summary card'},
      e('div',{class:'profile-main'},
        e('span',{class:'avatar large','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),
        e('div',null,e('strong',null,user.login),e('small',null,user.role==='admin'?'Администратор':'Пользователь'))),
      e('button',{class:'tertiary-button',onClick:()=>onOpen('account')},'Аккаунт')),
    e('label',{class:'settings-search'},
      e('span',{class:'sr-only'},'Поиск по настройкам'),
      e('span',{class:'search-input-wrap'},e(UiIcon,{name:'search',size:18}),e('input',{type:'search',value:query,placeholder:'Найти настройку',onInput:(ev:Event)=>setQuery((ev.target as HTMLInputElement).value)}))),
    groups.map(({group,items:groupItems})=>e('section',{class:'settings-group',key:group},
      e('h2',null,group),
      e('div',{class:'settings-list'},groupItems.map(item=>e(SettingsRow,{key:item.id,item,onOpen}))))),
    !filtered.length&&e('div',{class:'empty-state settings-empty'},e(UiIcon,{name:'search',size:28}),e('h2',null,'Ничего не найдено'),e('p',null,'Попробуйте другой запрос.')),
    e('button',{class:'settings-logout text-danger-button',disabled:loggingOut,onClick:onLogout},e(UiIcon,{name:'logout',size:18}),loggingOut?'Выходим…':'Выйти из аккаунта'));
}

export function AccountOverview({user,onOpen,onLogout,loggingOut,onBack}:{user:User;onOpen:(page:SettingsPage)=>void;onLogout:()=>void;loggingOut:boolean;onBack:()=>void}){
  const rows=[
    {id:'password' as SettingsPage,title:'Изменить пароль',description:'Обновить пароль серверного аккаунта',icon:'lock' as UiIconName},
    {id:'passkeys' as SettingsPage,title:'Ключи доступа',description:'Passkey и WebAuthn',icon:'key' as UiIconName},
    {id:'devices' as SettingsPage,title:'Активные сессии',description:'Устройства, где выполнен вход',icon:'devices' as UiIconName},
  ];
  return e('main',{class:'settings-screen account-screen'},
    e(PageHeader,{eyebrow:'Аккаунт',title:'Аккаунт и безопасность',back:onBack}),
    e('section',{class:'account-identity card'},
      e('span',{class:'avatar profile-avatar','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),
      e('div',{class:'account-identity-copy'},e('h2',null,user.login),e('p',null,user.role==='admin'?'Администратор системы':'Пользователь'))),
    e('section',{class:'settings-group'},
      e('div',{class:'settings-group-heading'},
        e('h2',null,'Безопасность'),
        e('details',{class:'account-info-tip app-popover'},
          e('summary',{class:'icon-button','aria-label':'О модели аккаунта',title:'О модели аккаунта'},e(UiIcon,{name:'info',size:18})),
          e('div',{class:'context-tip-panel'},'Серверная модель аккаунта использует логин и роль. Имя, email и 2FA не являются частью текущего продукта.'))),
      e('div',{class:'settings-list'},rows.map(row=>e('button',{class:'settings-row',key:row.id,onClick:()=>onOpen(row.id)},
        e('span',{class:'settings-row-icon'},e(UiIcon,{name:row.icon,size:20})),
        e('span',{class:'settings-row-copy'},e('strong',null,row.title),e('small',null,row.description)),
        e('span',{class:'settings-row-chevron'},e(Chevron,null)))))),
    e('button',{class:'text-danger-button',disabled:loggingOut,onClick:onLogout},e(UiIcon,{name:'logout',size:18}),loggingOut?'Выходим…':'Выйти из аккаунта'));
}

export function AppearanceSettings({onBack}:{onBack:()=>void}){
  const [theme,setTheme]=useState<ThemePreference>(()=>readThemePreference());
  const change=(value:ThemePreference)=>{setTheme(value);setThemePreference(value);};
  const meta:Record<ThemePreference,{title:string;description:string;preview:string}>={
    system:{title:'Как в системе',description:'Следовать настройке устройства',preview:'system'},
    light:{title:'Светлая',description:'Светлое оформление всегда',preview:'light'},
    dark:{title:'Тёмная',description:'Тёмное оформление всегда',preview:'dark'},
  };
  return e('main',{class:'settings-screen'},
    e(PageHeader,{eyebrow:'Оформление',title:'Тема приложения',description:'Настройка хранится только на этом устройстве.',back:onBack}),
    e('section',{class:'theme-grid'},(['system','light','dark'] as ThemePreference[]).map(value=>
      e('label',{class:'theme-card '+(theme===value?'selected':'')},
        e('input',{type:'radio',name:'theme',value,checked:theme===value,onChange:()=>change(value)}),
        e('span',{class:'theme-preview '+meta[value].preview},e('i',null),e('i',null),e('i',null)),
        e('span',{class:'theme-card-copy'},e('strong',null,meta[value].title),e('small',null,meta[value].description)),
        theme===value&&e('span',{class:'theme-check'},e(UiIcon,{name:'check',size:16}))))));
}

export function AboutSettings({onBack}:{onBack:()=>void}){
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  const standalone=matchMedia('(display-mode: standalone)').matches||Boolean((navigator as Navigator&{standalone?:boolean}).standalone);
  return e('main',{class:'settings-screen about-screen'},
    e(PageHeader,{eyebrow:'О приложении',title:'Tasks',back:onBack}),
    e('section',{class:'about-hero'},e('img',{src:'/icon.svg',width:64,height:64,alt:''}),e('div',null,e('strong',null,'Tasks'),e('span',null,'Версия 0.20.8'))),
    e('section',{class:'about-grid card'},
      e('div',null,e('span',null,'Версия'),e('strong',null,'0.20.8')),
      e('div',null,e('span',null,'Режим'),e('strong',null,standalone?'Установленная PWA':'Браузер')),
      e('div',null,e('span',null,'Часовой пояс'),e('strong',null,zone))),
    e(InfoTip,{label:'О часовом поясе'},'Часовой пояс аккаунта обновляется из текущего часового пояса устройства при работе онлайн.'));
}
