import { h as e } from 'preact';
import { useEffect,useRef,useState } from 'preact/hooks';
import { accountRequest,authMessage } from '../auth';
import { StatusDot,UiIcon } from './ui.ts';

interface Disk{totalBytes:string;usedBytes:string;availableBytes:string;availablePercent:number;level:'ok'|'warning'|'critical';checkedAt:string}
function size(bytes:string){return(Number(bytes)/1024**3).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ГиБ';}

export function ServerStorage(){
  const [disk,setDisk]=useState<Disk>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),running=useRef(false);
  async function refresh(){
    if(running.current)return;running.current=true;setBusy(true);
    try{const result=await accountRequest('diagnostics');if(alive.current){setDisk(result.disk as Disk);setError('');}}
    catch(error){if(alive.current){setDisk(undefined);setError(authMessage(error));}}
    finally{running.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{
    alive.current=true;void refresh();
    const wake=()=>{if(document.visibilityState==='visible')void refresh();};
    const interval=setInterval(wake,60000);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
    return()=>{alive.current=false;clearInterval(interval);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
  },[]);

  const tone=disk?.level==='ok'?'success':disk?.level==='critical'?'danger':'warning';
  const title=disk?.level==='critical'?'Критически мало места':disk?.level==='warning'?'Мало свободного места':'Диск сервера';
  return e('section',{class:'diagnostic-panel settings-panel server-storage-panel','aria-labelledby':'server-storage-heading'},
    e('div',{class:'diagnostic-panel-heading'},
      e('span',{class:'diagnostic-icon'},e(UiIcon,{name:'database',size:21})),
      e('div',null,e('h2',{id:'server-storage-heading'},title),e('p',null,'Хранилище серверной SQLite и файлов приложения.')),
      e('span',{class:'status-pill '+(disk?.level==='ok'?'success':'neutral')},e(StatusDot,{tone:disk?tone:'neutral'}),busy?'Проверяем':disk?disk.level==='ok'?'Норма':disk.level==='warning'?'Внимание':'Критично':'Нет данных')),
    error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),e('span',null,error)),
    disk&&e('div',{'aria-live':'polite'},
      e('div',{class:'storage-overview'},
        e('div',{class:'storage-value'},e('strong',null,size(disk.availableBytes)),e('span',null,'свободно · '+disk.availablePercent.toLocaleString('ru-RU')+'%')),
        e('div',{class:'storage-progress','aria-label':'Свободно '+disk.availablePercent+'%'},e('span',{style:{width:Math.max(0,Math.min(100,disk.availablePercent))+'%'}}))),
      disk.level!=='ok'&&e('div',{class:'inline-alert '+(disk.level==='critical'?'danger':'warning')},e(UiIcon,{name:'warning',size:18}),e('span',null,disk.level==='critical'?'Осталось не больше 5%. Освободите место или расширьте диск.':'Осталось не больше 15%. Запланируйте очистку или расширение диска.')),
      e('div',{class:'diagnostic-metrics storage-metrics'},
        e('div',null,e('span',null,'Всего'),e('strong',null,size(disk.totalBytes))),
        e('div',null,e('span',null,'Занято'),e('strong',null,size(disk.usedBytes))),
        e('div',null,e('span',null,'Доступно'),e('strong',null,size(disk.availableBytes)))),
      e('p',{class:'settings-footnote'},'Проверено '+new Date(disk.checkedAt).toLocaleString('ru-RU')+'. Данные обновляются раз в минуту, пока открыта диагностика.')),
    e('div',{class:'diagnostic-actions'},e('button',{class:'tertiary-button',disabled:busy,onClick:()=>void refresh()},e(UiIcon,{name:'sync',size:17}),busy?'Обновляем…':'Обновить')));
}
