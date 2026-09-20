import { h } from 'preact';
import { useEffect,useState } from 'preact/hooks';
import type { User } from '../types/auth.ts';
import { authMessage,AuthError } from '../auth.ts';
import { readState } from '../storage.ts';
import {
  acceptContact,acceptVaultInvite,cancelContact,collaborationIdentity,collaborationIsUnlocked,contactState,
  enableCollaborationSystemUnlock,ensureCollaborationIdentity,findUser,forgetCollaborationSystemUnlock,invites,
  persistCollaborationPasswordWrapper,rejectContact,rejectVaultInvite,removeContact,replaceCollaborationIdentity,requestContact,
  unlockCollaborationPassword,unlockCollaborationSystem,type ContactInfo,type PublicIdentity
} from '../collaboration.ts';
import { PageHeader,StatusDot,UiIcon } from './ui.ts';
import { appConfirm } from './AppDialog.ts';

const e=h;
function message(error:unknown){
  if(error instanceof AuthError)return authMessage(error);
  if(error&&typeof error==='object'&&'code'in error){
    const code=String((error as {code:unknown}).code);
    return ({identity_missing:'Ключ совместной работы ещё не создан.',identity_changed:'Ключ совместной работы изменился. Обновите страницу и повторите.',
      collaboration_locked:'Сначала откройте ключ совместной работы.',collaboration_system_unlock_missing:'Системная разблокировка ключа не настроена.',
      account_not_found:'Пользователь с таким логином не найден.',incoming_request_exists:'От этого пользователя уже есть входящая заявка.',
      contact_required:'Сначала добавьте пользователя в контакты.',network:'Нет связи с сервером.'} as Record<string,string>)[code]??code;
  }
  return error instanceof Error?error.message:'Не удалось выполнить действие.';
}
const shortFingerprint=(value:string)=>value.slice(0,10)+'…'+value.slice(-8);

export function CollaborationScreen({user,onBack}:{user:User;onBack:()=>void}){
  const [identity,setIdentity]=useState<Awaited<ReturnType<typeof collaborationIdentity>>>(null);
  const [unlocked,setUnlocked]=useState(false);
  const [hasSystemUnlock,setHasSystemUnlock]=useState(false),[recoveryRequired,setRecoveryRequired]=useState(false);
  const [contacts,setContacts]=useState<ContactInfo[]>([]);
  const [incoming,setIncoming]=useState<any[]>([]),[outgoing,setOutgoing]=useState<any[]>([]);
  const [vaultInvites,setVaultInvites]=useState<any[]>([]);
  const [password,setPassword]=useState(''),[login,setLogin]=useState('');
  const [found,setFound]=useState<{user:{id:string;login:string};identity:PublicIdentity|null}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  const [tab,setTab]=useState<'contacts'|'invites'|'security'>('contacts');

  async function refresh(){
    const [identityValue,contactValue,inviteValue,local]=await Promise.all([collaborationIdentity(user.id),contactState(user),invites(user),readState(user.id)]);
    setIdentity(identityValue);setContacts(contactValue.contacts);setIncoming(contactValue.incoming);setOutgoing(contactValue.outgoing);
    setVaultInvites(inviteValue);setUnlocked(collaborationIsUnlocked(user.id));setHasSystemUnlock(Boolean(local?.collaboration?.systemUnlock));setRecoveryRequired(Boolean(local?.collaboration?.recoveryRequired));
  }
  useEffect(()=>{void refresh().catch(c=>setError(message(c)));},[user.id]);
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setStatus('');try{await fn();await refresh();}catch(c){setError(message(c));}finally{setBusy(false);}}
  async function unlockOrCreate(ev:Event){ev.preventDefault();const secret=password;setPassword('');await run(async()=>{if(identity)await unlockCollaborationPassword(user,secret);else await ensureCollaborationIdentity(user,secret);setUnlocked(true);setStatus(identity?'Ключ совместной работы открыт.':'Ключ совместной работы создан и зашифрован.');});}
  async function search(ev:Event){ev.preventDefault();await run(async()=>{setFound(await findUser(user,login));});}

  const requestCount=incoming.length+outgoing.length;
  return e('main',{class:'settings-screen collaboration-screen'},
    e(PageHeader,{eyebrow:'Совместная работа',title:'Контакты и доступ',description:'Контакты, приглашения в совместные хранилища и общий ключ шифрования аккаунта.',back:onBack}),
    error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
    status&&e('div',{class:'inline-alert success',role:'status'},e(UiIcon,{name:'check',size:18}),status),

    e('nav',{class:'subtabs collaboration-tabs','aria-label':'Совместная работа'},
      e('button',{class:tab==='contacts'?'selected':'',onClick:()=>setTab('contacts')},e(UiIcon,{name:'contacts',size:18}),'Контакты',requestCount>0&&e('span',{class:'tab-count'},String(requestCount))),
      e('button',{class:tab==='invites'?'selected':'',onClick:()=>setTab('invites')},e(UiIcon,{name:'folder',size:18}),'Приглашения',vaultInvites.length>0&&e('span',{class:'tab-count'},String(vaultInvites.length))),
      e('button',{class:tab==='security'?'selected':'',onClick:()=>setTab('security')},e(UiIcon,{name:'key',size:18}),'Ключ шифрования')),

    tab==='contacts'&&e('div',{class:'collaboration-grid'},
      e('section',{class:'settings-panel contact-search-panel'},
        e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Найти пользователя'),e('p',null,'Поиск только по точному логину — публичного каталога нет.'))),
        e('form',{class:'contact-search-form',onSubmit:search},
          e('label',{class:'search-field'},e('span',null,'Логин'),e('span',{class:'search-input-wrap'},e(UiIcon,{name:'search',size:18}),e('input',{value:login,minLength:3,maxLength:32,required:true,autoCapitalize:'none',spellcheck:false,placeholder:'Точный логин',onInput:(ev:Event)=>{setLogin((ev.target as HTMLInputElement).value);setFound(null);}}))),
          e('button',{class:'primary',disabled:busy},'Найти')),
        found&&e('article',{class:'contact-result'},
          e('span',{class:'avatar'},found.user.login.slice(0,1).toUpperCase()),
          e('div',null,e('strong',null,found.user.login),e('small',null,found.identity?'Отпечаток ключа '+shortFingerprint(found.identity.fingerprint):'Ключ шифрования ещё не создан')),
          e('button',{class:'secondary-button',disabled:busy||contacts.some(c=>c.id===found.user.id),onClick:()=>void run(async()=>{await requestContact(user,found.user.id);setFound(null);setLogin('');})},contacts.some(c=>c.id===found.user.id)?'В контактах':'Отправить заявку'))),

      e('section',{class:'settings-panel'},
        e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Заявки'),e('p',null,'Входящие и исходящие запросы контактов.'))),
        !incoming.length&&!outgoing.length&&e('div',{class:'empty-mini'},'Новых заявок нет'),
        incoming.map(item=>e('article',{class:'contact-row',key:item.id},e('span',{class:'avatar'},item.user.login.slice(0,1).toUpperCase()),e('div',null,e('strong',null,item.user.login),e('small',null,'Входящая заявка')),
          e('div',{class:'row-actions'},e('button',{class:'primary',disabled:busy,onClick:()=>void run(()=>acceptContact(user,item.id).then(()=>{}))},'Принять'),e('button',{class:'tertiary-button',disabled:busy,onClick:()=>void run(()=>rejectContact(user,item.id).then(()=>{}))},'Отклонить')))),
        outgoing.map(item=>e('article',{class:'contact-row',key:item.id},e('span',{class:'avatar'},item.user.login.slice(0,1).toUpperCase()),e('div',null,e('strong',null,item.user.login),e('small',null,'Заявка отправлена')),e('button',{class:'tertiary-button',disabled:busy,onClick:()=>void run(()=>cancelContact(user,item.id).then(()=>{}))},'Отменить')))),

      e('section',{class:'settings-panel collaboration-span'},
        e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Контакты'),e('p',null,'Подтверждённые пользователи и отпечатки их ключей шифрования.'))),
        !contacts.length&&e('div',{class:'empty-state compact'},e(UiIcon,{name:'contacts',size:28}),e('h2',null,'Контактов пока нет')),
        e('div',{class:'contact-list'},contacts.map(contact=>e('article',{class:'contact-row',key:contact.id},e('span',{class:'avatar'},contact.login.slice(0,1).toUpperCase()),
          e('div',null,e('strong',null,contact.login),contact.identity?e('small',{class:'mono'},shortFingerprint(contact.identity.fingerprint)):e('small',{class:'danger-text'},'Ключ шифрования недоступен')),
          e('button',{class:'text-danger-button',disabled:busy,onClick:async()=>{if(await appConfirm('Доступ к уже открытым совместным хранилищам автоматически не отзывается.',{title:'Удалить '+contact.login+' из контактов?',confirmLabel:'Удалить',danger:true}))void run(()=>removeContact(user,contact.id).then(()=>{}));}},'Удалить')))))),

    tab==='invites'&&e('section',{class:'settings-panel'},
      e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Приглашения в хранилища'),e('p',null,'Примите роль после разблокировки ключа совместной работы.'))),
      !vaultInvites.length&&e('div',{class:'empty-state'},e(UiIcon,{name:'folder',size:30}),e('h2',null,'Приглашений нет'),e('p',null,'Новые совместные хранилища появятся здесь.')),
      e('div',{class:'invite-list'},vaultInvites.map(item=>e('article',{class:'invite-card',key:item.id},
        e('span',{class:'invite-icon'},e(UiIcon,{name:'folder',size:22})),
        e('div',{class:'invite-copy'},e('strong',null,item.displayName),e('p',null,'От '+item.inviter.login),e('span',{class:'badge accent'},item.role==='editor'?'Редактор':'Просмотр')),
        e('div',{class:'row-actions'},e('button',{class:'primary',disabled:busy||!unlocked,onClick:()=>void run(async()=>{await acceptVaultInvite(user,item.id);setStatus('Приглашение принято. Выполняется синхронизация совместного хранилища.');})},'Принять'),e('button',{class:'tertiary-button',disabled:busy,onClick:()=>void run(()=>rejectVaultInvite(user,item.id).then(()=>{}))},'Отклонить')),
        !unlocked&&e('small',{class:'invite-hint'},'Сначала откройте ключ шифрования совместной работы.'))))),

    tab==='security'&&e('section',{class:'settings-panel collaboration-security'},
      e('div',{class:'security-key-hero'},
        e('span',{class:'security-key-icon'},e(UiIcon,{name:'key',size:26})),
        e('div',null,e('h2',null,'Ключ шифрования совместной работы'),e('p',null,!identity?'Ключ ещё не создан.':('Версия '+identity.version+' · '+(unlocked?'открыт до закрытия приложения':'заблокирован')))),
        e('span',{class:'status-pill '+(unlocked?'success':'neutral')},e(StatusDot,{tone:unlocked?'success':'neutral'}),unlocked?'Открыт':'Заблокирован')),
      e('p',{class:'settings-footnote'},'Один ключ аккаунта защищает совместную работу. Сервер хранит только публичную часть и зашифрованные данные ключа.'),
      (!identity||!unlocked)&&e('form',{class:'security-key-form',onSubmit:unlockOrCreate},e('label',{class:'field-stack'},e('span',null,'Пароль аккаунта'),e('input',{type:'password',autoComplete:'current-password',required:true,value:password,onInput:(ev:Event)=>setPassword((ev.target as HTMLInputElement).value)})),e('button',{class:'primary',disabled:busy},busy?'Проверяем…':identity?'Открыть ключ':'Создать ключ')),
      e('div',{class:'button-row security-key-actions'},
        identity&&hasSystemUnlock&&!unlocked&&e('button',{class:'secondary-button',disabled:busy,onClick:()=>void run(async()=>{await unlockCollaborationSystem(user);setUnlocked(true);setStatus('Ключ открыт системной проверкой.');})},'Разблокировать системно'),
        identity&&unlocked&&!hasSystemUnlock&&e('button',{class:'secondary-button',disabled:busy,onClick:()=>void run(async()=>{await enableCollaborationSystemUnlock(user);setHasSystemUnlock(true);setStatus('Системная разблокировка ключа шифрования включена на этом устройстве.');})},'Включить системную разблокировку'),
        identity&&hasSystemUnlock&&e('button',{class:'tertiary-button',disabled:busy,onClick:async()=>{if(await appConfirm('Пароль аккаунта останется резервным способом.',{title:'Забыть системную разблокировку?',confirmLabel:'Забыть',danger:true}))void run(async()=>{await forgetCollaborationSystemUnlock(user);setHasSystemUnlock(false);});}},'Забыть системную разблокировку')),
      identity&&recoveryRequired&&e('div',{class:'inline-alert warning recovery-panel'},e(UiIcon,{name:'warning',size:18}),e('div',null,e('strong',null,'Ключ требует восстановления после сброса пароля'),e('p',null,'Если ключ открыт на доверенном устройстве, перепривяжите его к текущему паролю. Иначе потребуется аварийная замена.'),
        unlocked&&e('form',{class:'recovery-form',onSubmit:(ev:Event)=>{ev.preventDefault();const secret=password;setPassword('');void run(async()=>{await persistCollaborationPasswordWrapper(user,secret);setRecoveryRequired(false);setStatus('Тот же ключ шифрования безопасно перепривязан к текущему паролю.');});}},e('input',{type:'password',required:true,placeholder:'Текущий пароль аккаунта',value:password,onInput:(ev:Event)=>setPassword((ev.target as HTMLInputElement).value)}),e('button',{class:'primary',disabled:busy},'Перепривязать')))),
      identity&&e('details',{class:'danger-zone'},e('summary',null,'Аварийная замена ключа шифрования'),e('div',{class:'danger-zone-body'},e('p',null,'Используйте только при утрате старого ключа. Личные настройки напоминаний будут сброшены, а доступ к совместным хранилищам потребуется выдать заново.'),
        e('form',{class:'security-key-form',onSubmit:async(ev:Event)=>{ev.preventDefault();const secret=password;if(!await appConfirm('Старые ключи доступа участников станут недействительны.',{title:'Создать новый ключ шифрования?',confirmLabel:'Заменить ключ',danger:true}))return;setPassword('');void run(async()=>{await replaceCollaborationIdentity(user,secret);setUnlocked(true);setStatus('Создан новый ключ шифрования. Доступ к совместным хранилищам потребуется выдать заново.');});}},e('label',{class:'field-stack'},e('span',null,'Текущий пароль'),e('input',{type:'password',required:true,value:password,onInput:(ev:Event)=>setPassword((ev.target as HTMLInputElement).value)})),e('button',{class:'danger-button',disabled:busy},'Заменить ключ шифрования'))))));
}
