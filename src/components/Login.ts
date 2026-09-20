import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { authMessage, setupRequired, signIn, signInWithPasskey, webAuthnCapability, AuthError } from '../auth';
import type { User } from '../types/auth';
import { InfoTip,UiIcon } from './ui.ts';

const e=h;
export function Login({onLogin}:{onLogin:(user:User)=>void}){
  const [login,setLogin]=useState(''),[password,setPassword]=useState(''),[repeat,setRepeat]=useState('');
  const [confirming,setConfirming]=useState(false),[visible,setVisible]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[help,setHelp]=useState(false);
  const repeatField=useRef<HTMLInputElement>(null),loginField=useRef<HTMLInputElement>(null);
  const [passkeyAvailable,setPasskeyAvailable]=useState(false);
  useEffect(()=>{if(confirming)repeatField.current?.focus();},[confirming]);
  useEffect(()=>{void webAuthnCapability().then(result=>setPasskeyAvailable(result.available)).catch(()=>{});},[]);

  async function passkeyLogin(){if(busy)return;setBusy(true);setError('');try{if(await setupRequired()){setError('Сначала создайте первого администратора с логином и паролем.');return;}onLogin(await signInWithPasskey());}catch(c){setError(authMessage(c));}finally{setBusy(false);}}
  async function submit(event:SubmitEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      if(!confirming&&await setupRequired()){setConfirming(true);return;}
      if(confirming&&repeat!==password){setError('Пароли не совпадают. Повторите введённый пароль.');return;}
      const user=await signIn(login,password,confirming?repeat:undefined);
      setPassword('');setRepeat('');setVisible(false);onLogin(user);
    }catch(c){
      setError(authMessage(c));
      if(c instanceof AuthError&&c.code==='setup_complete'){setConfirming(false);setPassword('');setRepeat('');}
    }finally{setBusy(false);}
  }

  return e('main',{class:'auth-screen'},
    e('section',{class:'auth-card'},
      e('a',{class:'auth-brand',href:'/'},e('span',{class:'auth-brand-mark'},e('img',{src:'/icon.svg',width:38,height:38,alt:''})),e('span',null,e('strong',null,'Tasks'),e('small',null,'Private productivity workspace'))),
      e('div',{class:'auth-heading'},e('p',{class:'eyebrow'},confirming?'Первичная настройка':'Добро пожаловать'),e('h1',null,confirming?'Создайте администратора':'Вход в Tasks'),
        e('p',null,confirming?'Это первый аккаунт на сервере. После создания вы войдёте автоматически.':'Продолжите работу со своими зашифрованными хранилищами.')),
      confirming&&e(InfoTip,{label:'О первом аккаунте'},'Аккаунтов ещё нет. Создаётся первая учётная запись администратора.'),
      e('form',{class:'auth-form',onSubmit:submit,'aria-busy':busy},
        e('label',{for:'login'},e('span',null,'Логин'),e('input',{ref:loginField,id:'login',value:login,required:true,minLength:3,maxLength:32,pattern:'[a-zA-Z][a-zA-Z0-9._\\-]{2,31}',autoComplete:'username',autoCapitalize:'none',spellcheck:false,disabled:busy||confirming,onInput:(event:Event)=>setLogin((event.currentTarget as HTMLInputElement).value),placeholder:'например, makarov'})),
        confirming&&e('p',{class:'field-hint'},'3–32 символа: латиница, цифры, точка, дефис или _. Начните с буквы.'),
        e('label',{for:'password'},e('span',null,confirming?'Пароль администратора':'Пароль'),
          e('span',{class:'password-row'},e('input',{id:'password',type:visible?'text':'password',value:password,required:true,maxLength:256,autoComplete:confirming?'new-password':'current-password',disabled:busy||confirming,onInput:(event:Event)=>setPassword((event.currentTarget as HTMLInputElement).value),placeholder:'Введите пароль'}),
            e('button',{type:'button',class:'password-toggle','aria-label':visible?'Скрыть пароль':'Показать пароль','aria-pressed':visible,onClick:()=>setVisible(!visible)},e('span',null,visible?'Скрыть':'Показать')))),
        confirming&&e('label',{for:'repeat-password'},e('span',null,'Повторите пароль'),e('input',{ref:repeatField,id:'repeat-password',type:visible?'text':'password',value:repeat,required:true,maxLength:256,autoComplete:'new-password',disabled:busy,onInput:(event:Event)=>setRepeat((event.currentTarget as HTMLInputElement).value),placeholder:'Повторите пароль'})),
        confirming&&e('p',{class:'field-hint'},'6–128 символов, хотя бы одна цифра, одна заглавная и одна строчная буква.'),
        error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),e('span',null,error)),
        e('button',{class:'primary auth-submit',type:'submit',disabled:busy},busy?'Подождите…':confirming?'Создать администратора':'Войти'),
        confirming&&e('button',{class:'tertiary-button auth-cancel',type:'button',disabled:busy,onClick:()=>{setConfirming(false);setPassword('');setRepeat('');setError('');setVisible(false);requestAnimationFrame(()=>loginField.current?.focus());}},'Отмена')),
      !confirming&&passkeyAvailable&&e('div',{class:'auth-divider'},e('span',null,'или')),
      !confirming&&passkeyAvailable&&e('button',{class:'passkey-login secondary-button',type:'button',disabled:busy,onClick:()=>void passkeyLogin()},e(UiIcon,{name:'key',size:18}),'Войти с ключом доступа'),
      !confirming&&e('button',{class:'text-button auth-help-toggle',type:'button','aria-expanded':help,onClick:()=>setHelp(!help)},'Не получается войти?'),
      help&&!confirming&&e('div',{class:'auth-help'},e('strong',null,'Восстановление доступа'),e('p',null,'Обратитесь к администратору за временным паролем. Он действует 48 часов. Сброс пароля аккаунта не восстанавливает фразу зашифрованного хранилища.'))));
}
