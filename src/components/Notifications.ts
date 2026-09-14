import { h as e } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { User } from '../types/auth';
import { edit } from '../planner';
import { pushRequest, enablePush, disablePush } from '../push';
import { reminderRequest, type ReminderSettings } from '../reminders';

const statusText:Record<string,string>={scheduled:'Ожидает отправки',sending:'Отправляется',accepted:'Принято push-службой',
  expired:'Тест устарел и отменён',failed:'Push-служба отклонила отправку',unknown:'Результат отправки неизвестен. Проверьте телефон перед повтором.'};
export function Notifications({user}:{user:User}){
  const [device,setDevice]=useState(''),[name,setName]=useState('Это устройство');
  const [config,setConfig]=useState<{enabled:boolean;publicKey:string|null}>();
  const [permission,setPermission]=useState<string>(()=>'Notification'in window?Notification.permission:'unsupported'),[active,setActive]=useState(false),[browserActive,setBrowserActive]=useState(false);
  const [test,setTest]=useState<{id:string;status:string;due_at:number}|null>(null);
  const [reminders,setReminders]=useState<ReminderSettings>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checked,setChecked]=useState(false);
  const operation=useRef<string|undefined>(undefined),alive=useRef(true),generation=useRef(0);
  const supported=window.isSecureContext&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
  const standalone=window.matchMedia('(display-mode: standalone)').matches||Boolean((navigator as Navigator&{standalone?:boolean}).standalone);
  const iphone=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  async function refresh(id=device){
    const g=++generation.current;setChecked(false);
    try{
      const [cfg,info,prefs]=await Promise.all([pushRequest(user,'config'),pushRequest(user,'status',{deviceId:id}),reminderRequest(user,'settings')]);
      const reg=supported?await navigator.serviceWorker.getRegistration('/'):undefined;
      const sub=reg&&await reg.pushManager.getSubscription();
      if(!alive.current||g!==generation.current)return;
      if(info.test?.id===operation.current)operation.current=undefined;
      setConfig(cfg);setActive(info.active);setBrowserActive(Boolean(sub));setTest(info.test);setReminders(prefs);setChecked(true);
      setPermission(supported?Notification.permission:'unsupported');
    }catch(err){if(alive.current&&g===generation.current){setChecked(false);setError(err instanceof Error?err.message:'Не удалось проверить уведомления');}}
  }
  useEffect(()=>{
    alive.current=true;
    void edit(user,async s=>{s.deviceId??=crypto.randomUUID();return{id:s.deviceId,name:s.deviceName??'Это устройство'};})
      .then(async value=>{if(alive.current){setDevice(value.id);setName(value.name);await refresh(value.id);}})
      .catch(()=>setError('Не удалось прочитать данные устройства'));
    return()=>{alive.current=false;generation.current++;};
  },[user.id]);
  useEffect(()=>{
    if(!device)return;
    const wake=()=>{if(document.visibilityState==='visible')void refresh();};
    document.addEventListener('visibilitychange',wake);window.addEventListener('online',wake);
    const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!busy)void refresh();},5000);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',wake);window.removeEventListener('online',wake);};
  },[device,busy]);
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setNotice('');
    try{await fn();}catch(err){setError(err instanceof Error?err.message:'Не удалось выполнить действие');}
    finally{if(alive.current){await refresh();setBusy(false);}}
  }
  function enable(){
    // Must begin in the button's user activation, before any network awaits.
    const consent=Notification.requestPermission();
    void run(async()=>{if(await consent!=='granted')throw Error('Уведомления не разрешены. Измените разрешение в настройках устройства.');
      await enablePush(user,device,config!.publicKey!);setNotice('Уведомления включены для этого аккаунта.');});
  }
  const ready=checked&&supported&&permission==='granted'&&active&&browserActive;
  return e('section',{class:'card','aria-labelledby':'notifications-title'},
    e('h1',{id:'notifications-title'},'Уведомления'),
    e('p',{class:'muted'},'Push текущего устройства и повторы непросмотренных напоминаний для всего аккаунта.'),
    !standalone&&e('div',{class:'auth-notice'},e('h2',null,'Установить приложение'),
      iphone?e('ol',null,e('li',null,'Откройте меню «Поделиться» в Safari.'),e('li',null,'Выберите «На экран Домой» и оставьте «Открывать как веб-приложение» включённым.'),e('li',null,'Запустите приложение с новой иконки.'))
        :e('p',null,'Используйте действие «Установить приложение» в меню браузера, если оно доступно. На компьютере push можно включить и в поддерживаемом браузере.')),
    e('h2',null,name),
    e('dl',null,
      e('div',null,e('dt',null,'Запущено как приложение'),e('dd',null,standalone?'Да':'Нет')),
      e('div',null,e('dt',null,'Разрешение устройства'),e('dd',null,({default:'Не запрашивалось',granted:'Разрешено',denied:'Запрещено',unsupported:'API недоступно'} as Record<string,string>)[permission])),
      e('div',null,e('dt',null,'Подписка этого аккаунта'),e('dd',null,!checked?'Нет актуальной проверки':active&&browserActive?'Активна':active||browserActive?'Требует переподключения':'Неактивна'))),
    (!supported||(iphone&&!standalone))&&e('p',{class:'hint'},'На iPhone откройте установленное приложение с экрана «Домой». Если API недоступно, проверьте поддержку уведомлений браузером.'),
    config&&!config.enabled&&e('p',{class:'hint'},'Сервер работает в локальном режиме. Для реальной отправки используйте HTTPS-версию приложения.'),
    permission==='denied'&&e('p',{class:'hint'},'Откройте настройки уведомлений этого приложения в iOS и разрешите их. На компьютере измените разрешение сайта в браузере, затем нажмите «Проверить снова».'),
    e('div',{'aria-live':'polite'},error&&e('p',{class:'error',role:'alert'},error),notice&&e('p',null,notice)),
    e('div',{class:'actions'},
      e('button',{class:'primary',disabled:busy||!device||!supported||!checked||!config?.enabled||!config.publicKey||permission==='denied'||(iphone&&!standalone)||ready,onClick:enable},'Включить уведомления'),
      e('button',{disabled:busy||!device||!checked||(!active&&!browserActive),onClick:()=>void run(async()=>{await disablePush(user,device);operation.current=undefined;setNotice('Уведомления отключены на этом устройстве.');})},'Отключить'),
      e('button',{disabled:busy||!device,onClick:()=>{setError('');void refresh();}},'Проверить снова')),
    e('button',{class:'primary',disabled:busy||!ready||!config?.enabled||test?.status==='scheduled'||test?.status==='sending',onClick:()=>void run(async()=>{
      operation.current??=crypto.randomUUID();await pushRequest(user,'test',{deviceId:device,operationId:operation.current});operation.current=undefined;
      setNotice('Тест запланирован через 10 секунд. Сверните приложение или заблокируйте телефон.');})},'Отправить тест через 10 секунд'),
    test&&e('p',{role:'status'},'Последний тест: '+(statusText[test.status]??'Неизвестный статус')),
    e('hr',null),e('h2',null,'Повторы напоминаний'),
    e('label',null,'Если заметку не открыли',e('select',{value:String(reminders?.nudge_hours??1),disabled:busy||!reminders,
      onChange:(event:Event)=>void run(async()=>{const nudgeHours=Number((event.target as HTMLSelectElement).value);await reminderRequest(user,'settings',{nudgeHours});setNotice('Настройка повторов сохранена для аккаунта.');})},
      e('option',{value:'0'},'Не повторять'),e('option',{value:'1'},'Каждый час'),e('option',{value:'3'},'Каждые 3 часа'),e('option',{value:'6'},'Каждые 6 часов'),e('option',{value:'24'},'Раз в сутки'))),
    reminders&&e('p',{class:'hint'},'Часовой пояс аккаунта: '+reminders.zone+'. Он обновляется при открытии приложения онлайн.'),
    e('p',{class:'hint'},'Переход по push или открытие заметки на любом устройстве прекращает повторы, но не отмечает напоминание выполненным.'),
    e('p',{class:'hint'},'Принятие push-службой не подтверждает показ на телефоне. Уведомление нейтральное, без названия хранилища и текста заметок. Тест действует одну минуту.'),
    e('p',{class:'hint'},'При выходе или смене аккаунта уведомления этого сеанса отключаются. Уже отправленное сообщение отозвать невозможно.'));
}
