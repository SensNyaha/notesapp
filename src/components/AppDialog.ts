import { h as e } from 'preact';
import { useEffect,useRef,useState } from 'preact/hooks';

type DialogRequest={kind:'confirm'|'prompt';title:string;message:string;value?:string;confirmLabel:string;cancelLabel?:string;danger?:boolean;resolve:(value:boolean|string|null)=>void};
let current:DialogRequest|null=null;
const listeners=new Set<(request:DialogRequest|null)=>void>();
function publish(request:DialogRequest|null){current=request;for(const listener of listeners)listener(request);}

export function appConfirm(message:string,options:{title?:string;confirmLabel?:string;cancelLabel?:string;danger?:boolean}={}):Promise<boolean>{
  return new Promise(resolve=>publish({kind:'confirm',title:options.title??'Подтвердите действие',message,confirmLabel:options.confirmLabel??'Продолжить',cancelLabel:options.cancelLabel,danger:options.danger,resolve:value=>resolve(value===true)}));
}

export function appPrompt(title:string,value='',options:{message?:string;confirmLabel?:string}={}):Promise<string|null>{
  return new Promise(resolve=>publish({kind:'prompt',title,message:options.message??'',value,confirmLabel:options.confirmLabel??'Сохранить',resolve:value=>resolve(typeof value==='string'?value:null)}));
}

export function AppDialogHost(){
  const [request,setRequest]=useState<DialogRequest|null>(current),[value,setValue]=useState('');
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{const listener=(next:DialogRequest|null)=>{setRequest(next);setValue(next?.value??'');};listeners.add(listener);return()=>{listeners.delete(listener);};},[]);
  useEffect(()=>{if(request?.kind==='prompt')requestAnimationFrame(()=>input.current?.focus());},[request]);
  if(!request)return null;
  const finish=(result:boolean|string|null)=>{const active=request;publish(null);active.resolve(result);};
  return e('div',{class:'app-dialog-backdrop',role:'presentation',onMouseDown:(event:MouseEvent)=>{if(event.target===event.currentTarget)finish(request.kind==='confirm'?false:null);}},
    e('section',{class:'app-dialog',role:'dialog','aria-modal':'true','aria-labelledby':'app-dialog-title'},
      e('h2',{id:'app-dialog-title'},request.title),
      request.message&&e('p',null,request.message),
      request.kind==='prompt'&&e('input',{ref:input,value,onInput:(event:Event)=>setValue((event.currentTarget as HTMLInputElement).value),onKeyDown:(event:KeyboardEvent)=>{if(event.key==='Enter'&&value.trim())finish(value.trim());}}),
      e('div',{class:'app-dialog-actions'},
        e('button',{class:'tertiary-button',onClick:()=>finish(request.kind==='confirm'?false:null)},request.cancelLabel??'Отмена'),
        e('button',{class:request.danger?'danger-button':'primary',disabled:request.kind==='prompt'&&!value.trim(),onClick:()=>finish(request.kind==='prompt'?value.trim():true)},request.confirmLabel))));
}
