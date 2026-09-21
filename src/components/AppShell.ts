import { h as e, type ComponentChildren } from 'preact';
import { useEffect,useRef,useState } from 'preact/hooks';
import type { User } from '../types/auth.ts';
import { StatusDot,UiIcon } from './ui.ts';

export type ShellSection='notes'|'today'|'projects'|'settings';
export interface ShellVaultContext {
  value:string;
  options:{value:string;label:string}[];
  onChange:(value:string)=>void;
}
const nav:[ShellSection,string,'notes'|'today'|'projects'|'settings'][]=[
  ['notes','Заметки','notes'],['today','Сегодня','today'],['projects','Проекты','projects'],['settings','Настройки','settings']
];

type FieldMemory={key:string;value:string;checked?:boolean;html?:string};
type ScrollMemory={key:string;top:number;left:number};
type ScreenMemory={fields:FieldMemory[];details:string[];scrolls:ScrollMemory[];windowY:number};

function memoryKey(element:Element,index:number){
  const html=element as HTMLElement;
  return element.id||html.dataset.historyKey||[
    element.tagName,
    element.getAttribute('name')||'',
    element.getAttribute('aria-label')||'',
    [...element.classList].slice(0,3).join('.'),
    index,
  ].join('|');
}
function screenKey(root:HTMLElement,active:ShellSection){
  const view=root.querySelector<HTMLElement>('.note-editor,.note-view,.tag-manager,.reminder-editor,.lifecycle-screen,.settings-detail,.projects-screen,.today-screen,.notes-workspace,.settings-screen');
  const title=view?.querySelector('h1')?.textContent?.trim()||root.querySelector('h1')?.textContent?.trim()||'';
  const object=view?.dataset.viewKey||'';
  return [active,view?.className||root.firstElementChild?.className||'',object,title].join('::');
}
function captureScreen(root:HTMLElement):ScreenMemory{
  const controls=[...root.querySelectorAll<HTMLElement>('input,textarea,select,[contenteditable="true"]')]
    .filter(element=>!(element instanceof HTMLInputElement&&['password','file'].includes(element.type)));
  const fields=controls.map((element,index)=>{
    const input=element as HTMLInputElement;
    return{key:memoryKey(element,index),value:'value'in input?String(input.value):'',...('checked'in input?{checked:Boolean(input.checked)}:{}),...(element.isContentEditable?{html:element.innerHTML}:{})};
  });
  const detailNodes=[...root.querySelectorAll<HTMLDetailsElement>('details')];
  const details=detailNodes.flatMap((element,index)=>element.open?[memoryKey(element,index)]:[]);
  const scrollNodes=[root,...root.querySelectorAll<HTMLElement>('*')];
  const scrolls=scrollNodes.flatMap((element,index)=>(element.scrollTop>0||element.scrollLeft>0)?[{key:memoryKey(element,index),top:element.scrollTop,left:element.scrollLeft}]:[]);
  return{fields,details,scrolls,windowY:window.scrollY};
}
function restoreScreen(root:HTMLElement,memory:ScreenMemory){
  const controls=[...root.querySelectorAll<HTMLElement>('input,textarea,select,[contenteditable="true"]')]
    .filter(element=>!(element instanceof HTMLInputElement&&['password','file'].includes(element.type)));
  const fields=new Map(memory.fields.map(field=>[field.key,field]));
  controls.forEach((element,index)=>{
    const field=fields.get(memoryKey(element,index));if(!field)return;
    if(element.isContentEditable&&field.html!==undefined){if(element.innerHTML!==field.html){element.innerHTML=field.html;element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));}return;}
    const input=element as HTMLInputElement;
    let changed=false;
    if('checked'in input&&field.checked!==undefined&&input.checked!==field.checked){input.checked=field.checked;changed=true;}
    if('value'in input&&input.value!==field.value){input.value=field.value;changed=true;}
    if(changed){element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));}
  });
  const open=new Set(memory.details);
  [...root.querySelectorAll<HTMLDetailsElement>('details')].forEach((element,index)=>{element.open=open.has(memoryKey(element,index));});
  const scrollElements=[root,...root.querySelectorAll<HTMLElement>('*')];
  const scrolls=new Map(memory.scrolls.map(scroll=>[scroll.key,scroll]));
  scrollElements.forEach((element,index)=>{const scroll=scrolls.get(memoryKey(element,index));if(scroll)element.scrollTo(scroll.left,scroll.top);});
  window.scrollTo(0,memory.windowY);
}

export function AppShell({user,active,onNavigate,onHome,onBackGesture,syncing,connection,loggingOut,onLogout,children,notice,error,updateNotice,vaultContext,workspaceReady}:{
  user:User;active:ShellSection;onNavigate:(section:ShellSection)=>void;syncing:boolean;connection:'checking'|'online'|'offline'|'auth'|'error';
  onHome:()=>void;
  onBackGesture:()=>void;
  loggingOut:boolean;onLogout:()=>void;children?:ComponentChildren;notice?:string;error?:string;updateNotice?:ComponentChildren;vaultContext?:ShellVaultContext|null;workspaceReady:boolean;
}){
  const contentRef=useRef<HTMLDivElement>(null),backGestureRef=useRef(onBackGesture),memories=useRef(new Map<string,ScreenMemory>()),[swipeProgress,setSwipeProgress]=useState(0);
  backGestureRef.current=onBackGesture;
  useEffect(()=>{
    const root=contentRef.current;if(!root)return;
    let currentKey=screenKey(root,active),restoring=false,restoreTimer=0,scrollTimer=0;
    const remember=()=>{if(restoring)return;const key=screenKey(root,active);if(!key)return;const store=memories.current;store.delete(key);store.set(key,captureScreen(root));while(store.size>15)store.delete(store.keys().next().value!);currentKey=key;};
    const restore=()=>{const key=screenKey(root,active),memory=memories.current.get(key);currentKey=key;if(!memory)return;restoring=true;restoreScreen(root,memory);window.setTimeout(()=>{restoreScreen(root,memory);restoring=false;},80);};
    const scheduleRestore=()=>{cancelAnimationFrame(restoreTimer);restoreTimer=requestAnimationFrame(()=>requestAnimationFrame(restore));};
    const observer=new MutationObserver(()=>{const next=screenKey(root,active);if(next!==currentKey)scheduleRestore();});
    const afterInput=()=>queueMicrotask(remember);
    const afterScroll=()=>{clearTimeout(scrollTimer);scrollTimer=window.setTimeout(remember,80);};
    root.addEventListener('pointerdown',remember,true);root.addEventListener('input',afterInput,true);root.addEventListener('change',afterInput,true);root.addEventListener('scroll',afterScroll,true);observer.observe(root,{childList:true,subtree:true});scheduleRestore();
    return()=>{remember();observer.disconnect();cancelAnimationFrame(restoreTimer);clearTimeout(scrollTimer);root.removeEventListener('pointerdown',remember,true);root.removeEventListener('input',afterInput,true);root.removeEventListener('change',afterInput,true);root.removeEventListener('scroll',afterScroll,true);};
  },[active]);
  useEffect(()=>{
    const root=contentRef.current;if(!root)return;
    let pointer=-1,startX=0,startY=0,tracking=false,locked=false;
    const blocksSwipe=(target:EventTarget|null)=>{let element=target instanceof Element?target:null;while(element){if(element.matches('input,textarea,select,[contenteditable="true"],[data-swipe-lock],.image-gallery,.editor-toolbar,.app-dialog,.app-dialog-backdrop,.modal-backdrop,input[type="range"]'))return true;const style=getComputedStyle(element);if(/auto|scroll/.test(style.overflowX)&&element.scrollWidth>element.clientWidth)return true;element=element.parentElement;}return false;};
    const down=(event:PointerEvent)=>{if(event.isPrimary===false||event.clientX>32||event.button>0||blocksSwipe(event.target))return;pointer=event.pointerId;startX=event.clientX;startY=event.clientY;tracking=true;locked=false;};
    const move=(event:PointerEvent)=>{if(!tracking||event.pointerId!==pointer)return;const dx=event.clientX-startX,dy=Math.abs(event.clientY-startY);if(dx<0||(!locked&&dy>14&&dy>dx)){tracking=false;setSwipeProgress(0);return;}if(!locked&&dx>12&&dx>dy*1.25)locked=true;if(!locked)return;event.preventDefault();setSwipeProgress(Math.min(1,dx/120));};
    const finish=(event:PointerEvent)=>{if(!tracking||event.pointerId!==pointer)return;const dx=event.clientX-startX,dy=Math.abs(event.clientY-startY),go=locked&&dx>=72&&dx>dy*1.25;tracking=false;locked=false;pointer=-1;setSwipeProgress(0);if(go)backGestureRef.current();};
    document.addEventListener('pointerdown',down,true);window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);
    return()=>{document.removeEventListener('pointerdown',down,true);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);};
  },[]);
  const status=syncing?'Синхронизация…':connection==='checking'?'Проверяем связь…':connection==='offline'?'Офлайн':connection==='error'?'Ошибка связи':connection==='auth'?'Нужен вход':'Синхронизировано';
  const statusVisible=syncing||connection!=='online';
  const tone=connection==='offline'?'warning':connection==='error'||connection==='auth'?'danger':syncing||connection==='checking'?'accent':'success';
  const rootNav=workspaceReady?nav:nav.filter(([id])=>id==='notes'||id==='settings');
  return e('div',{class:'app-shell'},
    e('aside',{class:'app-sidebar','aria-label':'Основная навигация'},
      e('button',{class:'shell-brand',onClick:onHome,'aria-label':'Tasks · заметки'},
        e('span',{class:'shell-brand-mark'},e('img',{src:'/icon.svg',width:34,height:34,alt:''})),
        e('span',{class:'shell-brand-copy'},e('strong',null,'Tasks'),e('small',null,'Workspace'))),
      e('nav',{class:'shell-nav'},rootNav.map(([id,label,icon])=>
        e('button',{key:id,class:active===id?'active':'','aria-current':active===id?'page':undefined,onClick:()=>onNavigate(id),title:label},
          e(UiIcon,{name:icon}),e('span',null,label)))),
      e('div',{class:'sidebar-sync '+(syncing?'syncing':''),title:status,'aria-label':status},e(StatusDot,{tone}),statusVisible&&e('span',null,status)),
      e('div',{class:'sidebar-account'},
        e('span',{class:'avatar','aria-hidden':'true'},user.login.slice(0,1).toUpperCase()),
        e('div',{class:'sidebar-account-copy'},e('strong',null,user.login),e('small',null,user.role==='admin'?'Администратор':'Пользователь')),
        e('button',{class:'icon-button',disabled:loggingOut,onClick:onLogout,'aria-label':'Выйти',title:'Выйти'},e(UiIcon,{name:'logout'})))),

    e('div',{class:'shell-main'},
      e('header',{class:'mobile-shell-header'},
        e('button',{class:'mobile-brand',onClick:onHome,'aria-label':'Tasks'},
          e('img',{src:'/icon.svg',width:30,height:30,alt:''}),e('strong',null,'Tasks')),
        e('div',{class:'mobile-shell-context'},workspaceReady&&vaultContext&&
          e('label',{class:'mobile-vault-context'},
            e(UiIcon,{name:'database',size:16}),
            e('select',{value:vaultContext.value,'aria-label':'Текущее хранилище',onChange:(event:Event)=>vaultContext.onChange((event.target as HTMLSelectElement).value)},
              !vaultContext.value&&e('option',{value:'',disabled:true},'Выберите хранилище'),vaultContext.options.map(option=>e('option',{key:option.value,value:option.value},option.label))))),
        e('div',{class:'mobile-header-actions'},
          e('span',{class:'mobile-sync-indicator '+(syncing?'syncing':''),'aria-label':status,title:status,role:'status'},e(StatusDot,{tone})))),
      connection==='offline'&&e('div',{class:'offline-banner shell-offline',role:'status'},
        e(UiIcon,{name:'wifi-off',size:18}),e('div',null,e('strong',null,'Работа без подключения'),e('span',null,'Изменения сохраняются локально и синхронизируются после восстановления сети.'))),
      error&&e('div',{class:'shell-message error',role:'alert'},error),
      notice&&e('div',{class:'shell-message auth-notice',role:'status'},notice),
      updateNotice,
      e('div',{class:'shell-content',ref:contentRef},children),
      swipeProgress>0&&e('div',{class:'pwa-swipe-back-indicator',style:{'--swipe-progress':String(swipeProgress)},'aria-hidden':'true'},e(UiIcon,{name:'back',size:22}))),

    e('nav',{class:'bottom-nav','aria-label':'Основная навигация'},rootNav.map(([id,label,icon])=>
      e('button',{key:id,class:active===id?'active':'','aria-current':active===id?'page':undefined,onClick:()=>onNavigate(id)},
        e(UiIcon,{name:icon}),e('span',null,label))))
  );
}
