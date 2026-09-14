import { h as e } from 'preact';
import { useEffect,useRef,useState } from 'preact/hooks';
import { accountRequest,authMessage } from '../auth';

interface Disk {totalBytes:string;usedBytes:string;availableBytes:string;availablePercent:number;level:'ok'|'warning'|'critical';checkedAt:string}
function size(bytes:string){return (Number(bytes)/1024**3).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ГиБ';}
export function ServerStorage(){
  const [disk,setDisk]=useState<Disk>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),running=useRef(false);
  async function refresh(){
    if(running.current)return;running.current=true;setBusy(true);
    try{
      const result=await accountRequest('diagnostics');
      if(alive.current){setDisk(result.disk as Disk);setError('');}
    }catch(error){if(alive.current){setDisk(undefined);setError(authMessage(error));}}
    finally{running.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{
    alive.current=true;void refresh();
    const wake=()=>{if(document.visibilityState==='visible')void refresh();};
    const interval=setInterval(wake,60000);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
    return()=>{alive.current=false;clearInterval(interval);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
  },[]);
  return e('section',{class:'card','aria-labelledby':'server-storage-heading'},
    e('div',{class:'card-heading'},e('h2',{id:'server-storage-heading'},'Диск сервера'),
      e('button',{disabled:busy,onClick:()=>void refresh()},busy?'Проверяем…':'Обновить')),
    e('p',{class:'hint'},'Диск, на котором хранятся данные приложения. Показатели обновляются каждую минуту, пока открыта диагностика.'),
    error&&e('p',{class:'error',role:'alert'},error),
    disk&&e('div',{'aria-live':'polite'},
      e('p',{class:disk.level==='ok'?'hint':'error',role:disk.level==='ok'?'status':'alert'},disk.level==='critical'?'Критически мало места: осталось не больше 5%. Освободите место или расширьте диск.':disk.level==='warning'?'Мало места: осталось не больше 15%. Запланируйте очистку или расширение диска.':'Свободного места достаточно'),
      e('dl',null,e('div',null,e('dt',null,'Доступно для записи'),e('dd',null,size(disk.availableBytes)+' · '+disk.availablePercent.toLocaleString('ru-RU')+'%')),
        e('div',null,e('dt',null,'Всего'),e('dd',null,size(disk.totalBytes))),e('div',null,e('dt',null,'Занято на диске'),e('dd',null,size(disk.usedBytes)))),
      e('p',{class:'hint'},'Проверено: '+new Date(disk.checkedAt).toLocaleString('ru-RU'))));
}
