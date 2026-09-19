import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from '../crypto/vault';
import { StatusDot,UiIcon } from './ui.ts';

const e=h;
interface Result{protect:number;recover:number;encrypt:number;decrypt:number}

export function CryptoCheck(){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null);
  const alive=useRef(true),running=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const available=window.isSecureContext&&Boolean(window.crypto?.subtle);

  async function run(){
    if(running.current||!available)return;
    running.current=true;setBusy(true);setError('');setResult(null);
    let plain:Uint8Array|undefined,restored:Uint8Array|undefined;
    try{
      const key=await api.generateVaultKey();
      const keyId=crypto.randomUUID();
      const context={accountId:crypto.randomUUID(),vaultId:crypto.randomUUID(),keyId,objectId:keyId,revisionId:crypto.randomUUID()};
      const phrase='Только тестовая фраза проверки скорости 2026';
      let start=performance.now();
      const wrapped=await api.wrapWithPhrase(key,context,phrase);
      const protect=performance.now()-start;
      start=performance.now();
      const opened=await api.unwrapWithPhrase(context,phrase,api.parseEnvelope(api.serializeEnvelope(wrapped)));
      const recover=performance.now()-start;
      plain=crypto.getRandomValues(new Uint8Array(64*1024));
      const recordContext={...context,objectId:crypto.randomUUID(),revisionId:crypto.randomUUID()};
      start=performance.now();
      const record=await api.encryptRecord(opened,recordContext,plain,new api.MemoryEncryptionBudget());
      const encrypt=performance.now()-start;
      start=performance.now();
      restored=await api.decryptRecord(opened,recordContext,record);
      const decrypt=performance.now()-start;
      if(restored.length!==plain.length||restored.some((byte,index)=>byte!==plain![index]))throw new Error('check');
      if(alive.current)setResult({protect,recover,encrypt,decrypt});
    }catch{
      if(alive.current)setError('Проверка не завершена. Обновите приложение и повторите. Если ошибка сохраняется, сообщите модель устройства и версию браузера.');
    }finally{
      plain?.fill(0);restored?.fill(0);running.current=false;if(alive.current)setBusy(false);
    }
  }

  const rows=result?[
    ['Защита ключа',result.protect],['Восстановление ключа',result.recover],
    ['Шифрование 64 КиБ',result.encrypt],['Расшифровка 64 КиБ',result.decrypt],
  ] as [string,number][]:[];

  return e('section',{class:'diagnostic-panel settings-panel','aria-labelledby':'crypto-heading'},
    e('div',{class:'diagnostic-panel-heading'},
      e('span',{class:'diagnostic-icon'},e(UiIcon,{name:'lock',size:21})),
      e('div',null,e('h2',{id:'crypto-heading'},'Проверка шифрования'),e('p',null,'Локальный self-check Web Crypto на тестовых данных.')),
      e('span',{class:'status-pill '+(result?'success':'neutral')},e(StatusDot,{tone:result?'success':available?'neutral':'warning'}),result?'Пройдена':busy?'Проверяем':'Готово')),
    !available&&e('div',{class:'inline-alert warning'},e(UiIcon,{name:'warning',size:18}),e('span',null,'Web Crypto недоступен. Нужен localhost или HTTPS.')),
    busy&&e('div',{class:'diagnostic-progress','aria-live':'polite','aria-busy':'true'},e('span',{class:'sync-spinner'}),e('span',null,'Проверяем криптографические операции…')),
    result&&e('div',{class:'diagnostic-metrics'},rows.map(([label,value])=>e('div',{key:label},e('span',null,label),e('strong',null,value.toFixed(1)+' мс')))),
    result&&e('div',{class:'inline-alert success'},e(UiIcon,{name:'check',size:18}),e('span',null,'Тестовые данные восстановлены без изменений.')),
    error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),e('span',null,error)),
    e('p',{class:'settings-footnote'},'PBKDF2-SHA-256 · 600 000 итераций. Значения производительности ориентировочные и зависят от устройства.'),
    e('div',{class:'diagnostic-actions'},e('button',{class:'secondary-button',disabled:busy||!available,onClick:()=>void run()},e(UiIcon,{name:'diagnostics',size:17}),busy?'Проверяем…':result?'Проверить снова':'Запустить проверку')));
}
