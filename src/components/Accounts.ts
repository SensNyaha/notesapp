import { h } from 'preact';
import { useEffect,useMemo,useRef,useState } from 'preact/hooks';
import { accountRequest,authMessage,AuthError } from '../auth';
import { markCollaborationRecoveryRequired,prepareCollaborationPasswordChange } from '../collaboration.ts';
import { isUser,type User,type Account } from '../types/auth';
import { PageHeader,UiIcon } from './ui.ts';

const e=h;
const rules='6–128 символов, хотя бы одна цифра, заглавная и строчная буква.';
const uncertain='Ответ мог потеряться после сохранения. Проверьте состояние перед повтором. Если сеанс завершён, попробуйте войти с новым паролем.';
const date=(value:number)=>new Date(value).toLocaleString('ru-RU');

function isAccount(value:unknown):value is Account{
  return isUser(value)&&typeof(value as Account).createdAt==='number'&&typeof(value as Account).credentialVersion==='number';
}
function generatePassword(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';let value='';
  do{value='';while(value.length<16){const bytes=crypto.getRandomValues(new Uint8Array(32));for(const byte of bytes)if(byte<Math.floor(256/alphabet.length)*alphabet.length&&value.length<16)value+=alphabet[byte%alphabet.length];}}
  while(!/[A-Z]/.test(value)||!/[a-z]/.test(value)||!/[0-9]/.test(value));return value;
}
function PasswordField({id,label,value,setValue,busy,current=false}:{id:string;label:string;value:string;setValue:(value:string)=>void;busy:boolean;current?:boolean}){
  const [visible,setVisible]=useState(false);
  return e('label',{class:'field-stack',for:id},e('span',null,label),
    e('span',{class:'password-row'},
      e('input',{id,value,type:visible?'text':'password',required:true,maxLength:256,autoComplete:current?'current-password':'new-password',disabled:busy,onInput:(event:Event)=>setValue((event.currentTarget as HTMLInputElement).value)}),
      e('button',{type:'button',class:'password-toggle',disabled:busy,'aria-pressed':visible,'aria-label':visible?`Скрыть: ${label}`:`Показать: ${label}`,onClick:()=>setVisible(!visible)},visible?'Скрыть':'Показать')));
}
function useHeading(){const ref=useRef<HTMLHeadingElement>(null);useEffect(()=>{ref.current?.focus();},[]);return ref;}
function needsAuth(error:unknown){return error instanceof AuthError&&['unauthorized','password_change_required','admin_required'].includes(error.code);}

export function PasswordScreen({user,onDone,onBack,onLogout,onRefresh}:{user:User;onDone:(user:User)=>void;onBack:()=>void;onLogout:()=>Promise<void>;onRefresh:()=>Promise<void>}){
  const heading=useHeading();
  const [currentPassword,setCurrent]=useState(''),[password,setPassword]=useState(''),[repeat,setRepeat]=useState('');
  const [revokeOthers,setRevoke]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(event:SubmitEvent){
    event.preventDefault();if(busy)return;if(password!==repeat){setError('Пароли не совпадают.');return;}setBusy(true);setError('');
    try{
      const collaboration=await prepareCollaborationPasswordChange(user,currentPassword,password);
      if(collaboration.recoveryRequired&&!user.mustChangePassword)throw Error('Не удалось открыть E2EE-ключ совместной работы. Сначала разблокируйте его системно или текущим паролем.');
      const collaborationRewrap=collaboration.rewrap?{identityVersion:collaboration.rewrap.version,passwordWrapper:collaboration.rewrap.wrapper}:undefined;
      const result=await accountRequest('change-password',{currentPassword,password,repeatPassword:repeat,revokeOthers,...(collaborationRewrap?{collaborationRewrap}:{})});
      if(!isUser(result.user))throw new Error('response');if(collaboration.recoveryRequired)await markCollaborationRecoveryRequired(user.id);
      setCurrent('');setPassword('');setRepeat('');onDone(result.user);
    }catch(c){setError(authMessage(c)+(!(c instanceof AuthError)||c.code==='network'?' '+uncertain:''));if(needsAuth(c))await onRefresh();}
    finally{setBusy(false);}
  }
  return e('main',{class:'settings-screen password-screen'},
    e(PageHeader,{eyebrow:user.mustChangePassword?'Обязательный шаг':'Безопасность',title:'Изменить пароль',
      description:user.mustChangePassword?'Вы вошли с временным паролем. Для продолжения задайте постоянный пароль.':'Обновите пароль серверного аккаунта.',back:()=>user.mustChangePassword?void onLogout():onBack()}),
    user.mustChangePassword&&e('div',{class:'inline-alert warning'},e(UiIcon,{name:'warning',size:18}),e('span',null,'Временный пароль'+(user.temporaryExpires?' действует до '+date(user.temporaryExpires):'')+'. После смены прежние сессии будут завершены.')),
    e('form',{class:'settings-panel form-panel',onSubmit:submit,'aria-busy':busy},
      e('h2',{ref:heading,tabIndex:-1},'Новый пароль для '+user.login),
      e(PasswordField,{id:'current-password',label:'Текущий пароль',value:currentPassword,setValue:setCurrent,busy,current:true}),
      e(PasswordField,{id:'new-password',label:'Новый пароль',value:password,setValue:setPassword,busy}),
      e('p',{class:'field-hint'},rules,' Новый пароль должен отличаться от текущего.'),
      e(PasswordField,{id:'repeat-password',label:'Повторите пароль',value:repeat,setValue:setRepeat,busy}),
      !user.mustChangePassword&&e('label',{class:'checkbox-row'},e('input',{type:'checkbox',checked:revokeOthers,disabled:busy,onChange:(event:Event)=>setRevoke((event.currentTarget as HTMLInputElement).checked)}),e('span',null,'Выйти на других устройствах')),
      error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
      e('div',{class:'form-actions'},e('button',{type:'submit',class:'primary',disabled:busy},busy?'Сохраняем…':'Сохранить пароль'))));
}

function IssuePassword({target,onBack,onRefresh}:{target:Account|null;onBack:()=>void;onRefresh:()=>Promise<void>}){
  const heading=useHeading();
  const [login,setLogin]=useState(''),[password,setPassword]=useState(''),[repeat,setRepeat]=useState('');
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [result,setResult]=useState<Account|null>(null),[copyStatus,setCopyStatus]=useState('');
  async function submit(event:SubmitEvent){
    event.preventDefault();if(busy||result)return;if(password!==repeat){setError('Пароли не совпадают.');return;}setBusy(true);setError('');
    try{
      const data=await accountRequest(target?'users/reset':'users/create',target?{id:target.id,expectedVersion:target.credentialVersion,password,confirmed}:{login,password});
      if(!isAccount(data.user))throw new Error('response');setResult(data.user);setRepeat('');
    }catch(c){setError(authMessage(c)+(!(c instanceof AuthError)||c.code==='network'?' '+uncertain:''));if(needsAuth(c))await onRefresh();}
    finally{setBusy(false);}
  }
  async function copy(){try{await navigator.clipboard.writeText(password);setCopyStatus('Пароль скопирован.');}catch{setCopyStatus('Не удалось скопировать. Выделите пароль вручную.');}}

  if(result)return e('main',{class:'settings-screen temporary-password-screen'},
    e(PageHeader,{eyebrow:'Администрирование',title:'Временный пароль выдан',back:onBack}),
    e('section',{class:'issued-password-card card'},e('span',{class:'issued-password-icon'},e(UiIcon,{name:'key',size:24})),e('h2',null,result.login),
      e('p',null,'Временный пароль действует до '+date(result.temporaryExpires!)+' (48 часов).'),
      e('label',{class:'field-stack',for:'issued-password'},e('span',null,'Покажите пароль пользователю один раз'),e('input',{id:'issued-password',value:password,readOnly:true,autoComplete:'off'})),
      e('div',{class:'button-row'},e('button',{class:'primary',onClick:()=>void copy()},'Скопировать пароль'),e('button',{class:'secondary-button',onClick:onBack},'Готово')),
      copyStatus&&e('p',{class:'field-hint'},copyStatus)),
    e('div',{class:'inline-alert warning'},e(UiIcon,{name:'warning',size:18}),e('span',null,'После закрытия экрана пароль посмотреть повторно нельзя. При первом входе пользователь обязан задать собственный пароль.')));

  return e('main',{class:'settings-screen temporary-password-screen'},
    e(PageHeader,{eyebrow:'Администрирование',title:target?'Сбросить пароль':'Создать пользователя',description:target?'Будет выдан новый временный пароль и завершены текущие сессии пользователя.':'Новый пользователь получит временный пароль на 48 часов.',back:onBack}),
    e('form',{class:'settings-panel form-panel',onSubmit:submit,'aria-busy':busy},
      e('h2',{ref:heading,tabIndex:-1},target?target.login:'Новый аккаунт'),
      !target&&e('label',{class:'field-stack',for:'new-login'},e('span',null,'Логин'),e('input',{id:'new-login',value:login,required:true,minLength:3,maxLength:32,pattern:'[a-zA-Z][a-zA-Z0-9._\\-]{2,31}',autoComplete:'off',autoCapitalize:'none',spellcheck:false,disabled:busy,onInput:(event:Event)=>setLogin((event.currentTarget as HTMLInputElement).value)})),
      !target&&e('p',{class:'field-hint'},'3–32 символа: латиница, цифры, точка, дефис или _. Начните с буквы.'),
      e(PasswordField,{id:'temporary-password',label:'Временный пароль',value:password,setValue:setPassword,busy}),
      e('div',{class:'inline-actions'},e('p',{class:'field-hint'},rules),e('button',{type:'button',class:'tertiary-button',disabled:busy,onClick:()=>{const value=generatePassword();setPassword(value);setRepeat(value);setError('');}},'Сгенерировать')),
      e(PasswordField,{id:'repeat-temporary',label:'Повторите пароль',value:repeat,setValue:setRepeat,busy}),
      e('p',{class:'field-hint'},'Пароль действует 48 часов с момента выдачи. Вход не продлевает срок.'),
      target&&e('label',{class:'checkbox-row danger-confirm'},e('input',{type:'checkbox',required:true,checked:confirmed,disabled:busy,onChange:(event:Event)=>setConfirmed((event.currentTarget as HTMLInputElement).checked)}),e('span',null,'Подтверждаю сброс пароля и завершение всех сессий пользователя.')),
      error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
      e('div',{class:'form-actions'},e('button',{type:'submit',class:'primary',disabled:busy},busy?'Сохраняем…':target?'Сбросить и выдать пароль':'Создать пользователя'))));
}

export function UsersScreen({onBack,onRefresh}:{onBack:()=>void;onRefresh:()=>Promise<void>}){
  const heading=useHeading();
  const [users,setUsers]=useState<Account[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const [editing,setEditing]=useState(false),[target,setTarget]=useState<Account|null>(null);
  const [query,setQuery]=useState(''),[roleFilter,setRoleFilter]=useState<'all'|'admin'|'user'>('all');
  const visibleUsers=useMemo(()=>{const q=query.trim().toLocaleLowerCase('ru');return users.filter(user=>(roleFilter==='all'||user.role===roleFilter)&&(!q||user.login.toLocaleLowerCase('ru').includes(q)));},[users,query,roleFilter]);
  const generation=useRef(0);
  async function refresh(){const current=++generation.current;setBusy(true);setError('');try{const data=await accountRequest('users');if(!Array.isArray(data.users)||!data.users.every(isAccount))throw new Error('response');if(generation.current===current)setUsers(data.users);}catch(c){if(generation.current===current){setError(authMessage(c));if(needsAuth(c))await onRefresh();}}finally{if(generation.current===current)setBusy(false);}}
  useEffect(()=>{void refresh();return()=>{generation.current++;};},[]);
  if(editing)return e(IssuePassword,{target,onRefresh,onBack:()=>{setEditing(false);setTarget(null);void refresh();requestAnimationFrame(()=>heading.current?.focus());}});

  const admins=users.filter(user=>user.role==='admin').length,regular=users.length-admins;
  return e('main',{class:'settings-screen users-screen'},
    e(PageHeader,{eyebrow:'Администрирование',title:'Пользователи',description:'Управление серверными аккаунтами и временными паролями.',back:onBack,
      actions:e('div',{class:'header-actions'},e('button',{class:'primary',disabled:busy,onClick:()=>{setTarget(null);setEditing(true);}},e(UiIcon,{name:'plus',size:17}),'Создать'),e('button',{class:'tertiary-button',disabled:busy,onClick:()=>void refresh()},e(UiIcon,{name:'sync',size:17}),'Обновить'))}),
    e('div',{class:'stats-row'},e('div',null,e('strong',null,String(users.length)),e('span',null,'Всего')),e('div',null,e('strong',null,String(admins)),e('span',null,'Администраторы')),e('div',null,e('strong',null,String(regular)),e('span',null,'Пользователи'))),
    e('div',{class:'user-filterbar'},
      e('label',{class:'search-field'},e('span',null,'Поиск'),e('span',{class:'search-input-wrap'},e(UiIcon,{name:'search',size:18}),e('input',{type:'search',value:query,placeholder:'Логин пользователя',onInput:(event:Event)=>setQuery((event.currentTarget as HTMLInputElement).value)}))),
      e('label',null,e('span',null,'Роль'),e('select',{value:roleFilter,onChange:(event:Event)=>setRoleFilter((event.currentTarget as HTMLSelectElement).value as typeof roleFilter)},e('option',{value:'all'},'Все'),e('option',{value:'admin'},'Администраторы'),e('option',{value:'user'},'Пользователи')))),
    error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
    !busy&&!error&&users.length===0&&e('div',{class:'empty-state card'},e(UiIcon,{name:'users',size:30}),e('h2',null,'Пользователей пока нет')),
    !busy&&!error&&users.length>0&&visibleUsers.length===0&&e('div',{class:'empty-state card'},e(UiIcon,{name:'search',size:28}),e('h2',null,'Ничего не найдено')),
    e('section',{class:'admin-user-list','aria-busy':busy},visibleUsers.map(user=>e('article',{class:'admin-user-row',key:user.id},
      e('span',{class:'avatar'},user.login.slice(0,1).toUpperCase()),
      e('div',{class:'admin-user-copy'},e('div',{class:'admin-user-title'},e('strong',null,user.login),e('span',{class:'badge '+(user.role==='admin'?'accent':'')},user.role==='admin'?'Администратор':'Пользователь')),
        e('small',null,'Создан '+date(user.createdAt)),
        e('span',{class:'credential-state '+(user.mustChangePassword?'warning':'success')},user.mustChangePassword?(user.temporaryExpires!>Date.now()?'Ожидает смены временного пароля':'Временный пароль истёк'):'Пароль установлен')),
      e('div',{class:'admin-user-actions'},user.role==='user'&&e('button',{class:'secondary-button',disabled:busy||Boolean(error),onClick:()=>{setTarget(user);setEditing(true);}},'Выдать временный пароль'))))));
}
