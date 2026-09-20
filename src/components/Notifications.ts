import { h as e } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { User } from '../types/auth';
import { edit } from '../planner';
import { pushRequest, enablePush, disablePush } from '../push';
import { reminderRequest, type ReminderSettings } from '../reminders';
import { InfoTip,PageHeader,StatusDot,UiIcon } from './ui.ts';

const statusText:Record<string,string>={scheduled:'Ожидает отправки',sending:'Отправляется',accepted:'Принято push-службой',
  expired:'Тест устарел и отменён',failed:'Push-служба отклонила отправку',unknown:'Результат отправки неизвестен. Проверьте телефон перед повтором.'};

export function Notifications({user,onBack}:{user:User;onBack:()=>void}){
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

  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await fn();}catch(err){setError(err instanceof Error?err.message:'Не удалось выполнить действие');}finally{if(alive.current){await refresh();setBusy(false);}}}
  function enable(){const consent=Notification.requestPermission();void run(async()=>{if(await consent!=='granted')throw Error('Уведомления не разрешены. Измените разрешение в настройках устройства.');await enablePush(user,device,config!.publicKey!);setNotice('Уведомления включены для этого аккаунта.');});}
  const ready=checked&&supported&&permission==='granted'&&active&&browserActive;
  const permissionText=({default:'Не запрашивалось',granted:'Разрешено',denied:'Запрещено',unsupported:'API недоступно'} as Record<string,string>)[permission];
  const subscriptionText=!checked?'Нет актуальной проверки':active&&browserActive?'Активна':active||browserActive?'Требует переподключения':'Неактивна';

  return e('main',{class:'settings-screen notifications-screen'},
    e(PageHeader,{eyebrow:'Настройки',title:'Уведомления и часовой пояс',description:'Push для этого устройства и повторы непросмотренных напоминаний.',back:onBack}),
    !standalone&&e('section',{class:'install-panel'},
      e('span',{class:'install-panel-icon'},e(UiIcon,{name:'bell',size:22})),
      e('div',null,e('strong',null,'Установите Tasks для надёжных push'),
        iphone?e('p',null,'На iPhone: Safari → Поделиться → «На экран Домой», затем откройте приложение с новой иконки.')
          :e('p',null,'Установите приложение через меню браузера, если этот пункт доступен.')),
      e('span',{class:'badge'},standalone?'PWA':'Браузер')),

    e('section',{class:'settings-panel'},
      e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,name),e('p',null,'Push-канал текущего устройства')),e('span',{class:'status-pill '+(ready?'success':'neutral')},e(StatusDot,{tone:ready?'success':'neutral'}),ready?'Подключено':'Не подключено')),
      e('div',{class:'status-grid'},
        e('div',null,e('span',null,'Режим'),e('strong',null,standalone?'Установленная PWA':'Браузер')),
        e('div',null,e('span',null,'Разрешение'),e('strong',null,permissionText)),
        e('div',null,e('span',null,'Подписка'),e('strong',null,subscriptionText))),
      (!supported||(iphone&&!standalone))&&e('div',{class:'inline-alert warning'},e(UiIcon,{name:'warning',size:18}),e('span',null,'На iPhone push доступен из установленной PWA. В браузере проверьте поддержку Notification API.')),
      config&&!config.enabled&&e(InfoTip,{label:'О настройке push'},'Сервер работает без реальной push-конфигурации. Для доставки нужен HTTPS-режим с Web Push.'),
      permission==='denied'&&e('div',{class:'inline-alert warning'},e(UiIcon,{name:'warning',size:18}),e('span',null,'Разрешение запрещено на уровне устройства или браузера. Измените его в системных настройках и повторите проверку.')),
      error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
      notice&&e('div',{class:'inline-alert success',role:'status'},e(UiIcon,{name:'check',size:18}),notice),
      e('div',{class:'button-row'},
        e('button',{class:'primary',disabled:busy||!device||!supported||!checked||!config?.enabled||!config.publicKey||permission==='denied'||(iphone&&!standalone)||ready,onClick:enable},e(UiIcon,{name:'bell',size:17}),'Включить'),
        e('button',{class:'secondary-button',disabled:busy||!device||!checked||(!active&&!browserActive),onClick:()=>void run(async()=>{await disablePush(user,device);operation.current=undefined;setNotice('Уведомления отключены на этом устройстве.');})},'Отключить'),
        e('button',{class:'tertiary-button',disabled:busy||!device,onClick:()=>{setError('');void refresh();}},e(UiIcon,{name:'sync',size:17}),'Проверить')),
      e('div',{class:'test-push-row'},
        e('div',null,e('strong',null,'Тестовое уведомление'),e('small',null,test?'Последний тест: '+(statusText[test.status]??'Неизвестный статус'):'Отправится через 10 секунд')),
        e('button',{class:'secondary-button',disabled:busy||!ready||!config?.enabled||test?.status==='scheduled'||test?.status==='sending',onClick:()=>void run(async()=>{operation.current??=crypto.randomUUID();await pushRequest(user,'test',{deviceId:device,operationId:operation.current});operation.current=undefined;setNotice('Тест запланирован через 10 секунд. Сверните приложение или заблокируйте телефон.');})},'Отправить тест'))),

    e('section',{class:'settings-panel'},
      e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Повторы напоминаний'),e('p',null,'Что делать, если заметку не открыли после push'))),
      e('div',{class:'form-grid two'},
        e('label',null,e('span',null,'Повторять'),e('select',{value:String(reminders?.nudge_hours??1),disabled:busy||!reminders,onChange:(event:Event)=>void run(async()=>{const nudgeHours=Number((event.target as HTMLSelectElement).value);await reminderRequest(user,'settings',{nudgeHours});setNotice('Настройка повторов сохранена для аккаунта.');})},
          e('option',{value:'0'},'Не повторять'),e('option',{value:'1'},'Каждый час'),e('option',{value:'3'},'Каждые 3 часа'),e('option',{value:'6'},'Каждые 6 часов'),e('option',{value:'24'},'Раз в сутки'))),
        e('label',null,e('span',null,'События «Весь день»'),e('input',{type:'time',value:reminders?.all_day_time??'09:00',disabled:busy||!reminders,onChange:(event:Event)=>void run(async()=>{const allDayTime=(event.target as HTMLInputElement).value;await reminderRequest(user,'settings',{nudgeHours:reminders?.nudge_hours??1,allDayTime});setNotice('Время событий «Весь день» сохранено для аккаунта.');})}))),
      reminders&&e('div',{class:'timezone-row'},e(UiIcon,{name:'calendar',size:18}),e('span',null,'Часовой пояс аккаунта'),e('strong',null,reminders.zone)),
      e('p',{class:'settings-footnote'},'Переход по push или открытие заметки на любом устройстве прекращает повторы, но не отмечает напоминание выполненным. Принятие push-службой не гарантирует показ на телефоне.')));
}
