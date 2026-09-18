import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { User } from '../types/auth.ts';
import { authMessage, AuthError } from '../auth.ts';
import { readState } from '../storage.ts';
import {
  acceptContact, acceptVaultInvite, cancelContact, collaborationIdentity, collaborationIsUnlocked, contactState,
  enableCollaborationSystemUnlock, ensureCollaborationIdentity, findUser, forgetCollaborationSystemUnlock, invites,
  persistCollaborationPasswordWrapper, rejectContact, rejectVaultInvite, removeContact, replaceCollaborationIdentity, requestContact,
  unlockCollaborationPassword, unlockCollaborationSystem, type ContactInfo, type PublicIdentity
} from '../collaboration.ts';

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

  async function refresh(){
    const [identityValue,contactValue,inviteValue,local]=await Promise.all([
      collaborationIdentity(user.id),contactState(user),invites(user),readState(user.id)
    ]);
    setIdentity(identityValue);setContacts(contactValue.contacts);setIncoming(contactValue.incoming);setOutgoing(contactValue.outgoing);
    setVaultInvites(inviteValue);setUnlocked(collaborationIsUnlocked(user.id));setHasSystemUnlock(Boolean(local?.collaboration?.systemUnlock));setRecoveryRequired(Boolean(local?.collaboration?.recoveryRequired));
  }
  useEffect(()=>{void refresh().catch(c=>setError(message(c)));},[user.id]);
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setStatus('');try{await fn();await refresh();}catch(c){setError(message(c));}finally{setBusy(false);}}
  async function unlockOrCreate(ev:Event){ev.preventDefault();const secret=password;setPassword('');await run(async()=>{
    if(identity)await unlockCollaborationPassword(user,secret);else await ensureCollaborationIdentity(user,secret);
    setUnlocked(true);setStatus(identity?'Ключ совместной работы открыт.':'Ключ совместной работы создан и зашифрован.');
  });}
  async function search(ev:Event){ev.preventDefault();await run(async()=>{const value=await findUser(user,login);setFound(value);});}

  return e('main',{class:'users-screen'},
    e('button',{disabled:busy,onClick:onBack},'← Назад'),
    e('h1',{class:'screen-title'},'Контакты и совместная работа'),
    e('section',{class:'card'},
      e('h2',null,'E2EE-ключ совместной работы'),
      !identity
        ?e('p',{class:'hint'},'Создаётся один account-wide ECDH-ключ. Сервер хранит только публичный ключ и зашифрованную приватную часть.')
        :e('p',{class:'hint'},'Ключ создан · версия '+identity.version+'. '+(unlocked?'Открыт только в runtime текущего приложения.':'Сейчас заблокирован.')),
      (!identity||!unlocked)&&e('form',{onSubmit:unlockOrCreate},
        e('label',null,'Пароль аккаунта',e('input',{type:'password',autoComplete:'current-password',required:true,value:password,
          onInput:(ev:Event)=>setPassword((ev.target as HTMLInputElement).value)})),
        e('button',{class:'primary',disabled:busy},busy?'Проверяем…':identity?'Открыть E2EE-ключ':'Создать E2EE-ключ')),
      identity&&hasSystemUnlock&&!unlocked&&e('button',{disabled:busy,onClick:()=>void run(async()=>{await unlockCollaborationSystem(user);setUnlocked(true);setStatus('Ключ открыт системной проверкой.');})},'Разблокировать системно'),
      identity&&unlocked&&!hasSystemUnlock&&e('button',{disabled:busy,onClick:()=>void run(async()=>{await enableCollaborationSystemUnlock(user);setHasSystemUnlock(true);setStatus('Системная разблокировка E2EE-ключа включена на этом устройстве.');})},'Включить системную разблокировку'),
      identity&&hasSystemUnlock&&e('button',{disabled:busy,onClick:()=>{if(confirm('Забыть локальную системную разблокировку ключа совместной работы? Пароль аккаунта останется резервным способом.'))void run(async()=>{await forgetCollaborationSystemUnlock(user);setHasSystemUnlock(false);});}},'Забыть системную разблокировку'),
      identity&&recoveryRequired&&e('div',{class:'auth-notice'},
        e('strong',null,'Пароль E2EE-ключа требует восстановления.'),
        e('p',null,'После административного сброса старый E2EE-ключ не был раскрыт администратору. Если вы открыли его на доверенном устройстве системной проверкой, привяжите тот же ключ к текущему паролю. Иначе используйте аварийную замену ниже.'),
        unlocked&&e('form',{onSubmit:(ev:Event)=>{ev.preventDefault();const secret=password;setPassword('');void run(async()=>{await persistCollaborationPasswordWrapper(user,secret);setRecoveryRequired(false);setStatus('Тот же E2EE-ключ безопасно перепривязан к текущему паролю.');});}},
          e('label',null,'Текущий пароль аккаунта',e('input',{type:'password',required:true,value:password,onInput:(ev:Event)=>setPassword((ev.target as HTMLInputElement).value)})),
          e('button',{class:'primary',disabled:busy},'Перепривязать ключ'))),
      identity&&e('details',null,e('summary',null,'Аварийно заменить E2EE-ключ'),
        e('p',{class:'error'},'Замена используется только при утрате старого ключа. Личные E2EE-настройки напоминаний будут сброшены, а доступ участника к shared vault потребуется выдать заново владельцем.'),
        e('form',{onSubmit:(ev:Event)=>{ev.preventDefault();const secret=password;setPassword('');if(!confirm('Создать новый E2EE-ключ? Старые member-envelopes станут недействительны.'))return;void run(async()=>{await replaceCollaborationIdentity(user,secret);setUnlocked(true);setStatus('Создан новый E2EE-ключ. Для shared vault потребуется regrant.');});}},
          e('label',null,'Текущий пароль аккаунта',e('input',{type:'password',required:true,value:password,onInput:(ev:Event)=>setPassword((ev.target as HTMLInputElement).value)})),
          e('button',{class:'danger-button',disabled:busy},'Заменить E2EE-ключ')))),
    e('section',{class:'card'},
      e('h2',null,'Найти пользователя'),
      e('p',{class:'hint'},'Поиск выполняется только по полному логину и не показывает каталог аккаунтов.'),
      e('form',{onSubmit:search},e('label',null,'Точный логин',e('input',{value:login,minLength:3,maxLength:32,required:true,autoCapitalize:'none',spellcheck:false,onInput:(ev:Event)=>{setLogin((ev.target as HTMLInputElement).value);setFound(null);}})),
        e('button',{disabled:busy},'Найти')),
      found&&e('div',{class:'note-row'},e('strong',null,found.user.login),
        e('small',null,found.identity?'E2EE fingerprint: '+shortFingerprint(found.identity.fingerprint):'E2EE-ключ ещё не создан'),
        e('button',{disabled:busy||contacts.some(c=>c.id===found.user.id),onClick:()=>void run(async()=>{await requestContact(user,found.user.id);setFound(null);setLogin('');})},
          contacts.some(c=>c.id===found.user.id)?'Уже в контактах':'Отправить заявку'))),
    e('section',{class:'card'},e('h2',null,'Заявки'),
      !incoming.length&&!outgoing.length&&e('p',{class:'muted'},'Заявок нет.'),
      incoming.map(item=>e('div',{class:'note-row',key:item.id},e('strong',null,item.user.login),e('small',null,'Входящая заявка'),
        e('div',{class:'actions compact'},e('button',{class:'primary',disabled:busy,onClick:()=>void run(()=>acceptContact(user,item.id).then(()=>{}))},'Принять'),
          e('button',{disabled:busy,onClick:()=>void run(()=>rejectContact(user,item.id).then(()=>{}))},'Отклонить')))),
      outgoing.map(item=>e('div',{class:'note-row',key:item.id},e('strong',null,item.user.login),e('small',null,'Заявка отправлена'),
        e('button',{disabled:busy,onClick:()=>void run(()=>cancelContact(user,item.id).then(()=>{}))},'Отменить')))),
    e('section',{class:'card'},e('h2',null,'Контакты'),
      !contacts.length&&e('p',{class:'muted'},'Контактов пока нет.'),
      contacts.map(contact=>e('div',{class:'note-row',key:contact.id},e('strong',null,contact.login),
        contact.identity?e('small',null,'E2EE fingerprint: '+shortFingerprint(contact.identity.fingerprint)):e('small',{class:'error'},'E2EE-ключ недоступен'),
        e('button',{disabled:busy,onClick:()=>{if(confirm('Удалить '+contact.login+' из контактов? Доступ к уже расшаренным хранилищам от этого автоматически не отзывается.'))void run(()=>removeContact(user,contact.id).then(()=>{}));}},'Удалить контакт')))),
    e('section',{class:'card'},e('h2',null,'Приглашения в хранилища'),
      !vaultInvites.length&&e('p',{class:'muted'},'Приглашений нет.'),
      vaultInvites.map(item=>e('div',{class:'note-row',key:item.id},
        e('strong',null,item.displayName),
        e('small',null,'От '+item.inviter.login+' · роль '+(item.role==='editor'?'Редактор':'Просмотр')),
        e('div',{class:'actions compact'},
          e('button',{class:'primary',disabled:busy||!unlocked,onClick:()=>void run(async()=>{await acceptVaultInvite(user,item.id);setStatus('Приглашение принято. Выполняется синхронизация shared vault.');})},'Принять'),
          e('button',{disabled:busy,onClick:()=>void run(()=>rejectVaultInvite(user,item.id).then(()=>{}))},'Отклонить')),
        !unlocked&&e('small',{class:'hint'},'Перед принятием откройте E2EE-ключ совместной работы.')))),
    error&&e('p',{class:'error',role:'alert'},error),
    status&&e('p',{class:'auth-notice',role:'status'},status));
}
