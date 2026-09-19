import { h as e } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { NoteAttachment } from '../planner';
import { UiIcon } from './ui.ts';

const allowedTags = new Set(['A','B','BLOCKQUOTE','BR','CODE','DIV','EM','FONT','H1','H2','H3','I','LI','OL','P','PRE','S','SPAN','STRONG','TABLE','TBODY','TD','TH','THEAD','TR','U','UL']);
const allowedStyles = new Set(['color','background-color','font-family','font-size','text-align']);

export function plainToHtml(value:string){
  const div=document.createElement('div');div.textContent=value;
  return div.innerHTML.replaceAll('\n','<br>');
}

export function sanitizeNoteHtml(value:string){
  const template=document.createElement('template');template.innerHTML=value;
  const clean=(parent:ParentNode)=>{
    for(const node of [...parent.childNodes]){
      if(node.nodeType===Node.COMMENT_NODE){node.remove();continue;}
      if(node.nodeType!==Node.ELEMENT_NODE)continue;
      const element=node as HTMLElement;
      if(!allowedTags.has(element.tagName)){
        const fragment=document.createDocumentFragment();while(element.firstChild)fragment.append(element.firstChild);
        element.replaceWith(fragment);clean(parent);continue;
      }
      for(const attribute of [...element.attributes]){
        const name=attribute.name.toLowerCase();
        if(name==='style'){
          const declarations=[...element.style].filter(property=>allowedStyles.has(property));
          const values=declarations.map(property=>property+':'+element.style.getPropertyValue(property)).join(';');
          if(values)element.setAttribute('style',values);else element.removeAttribute('style');
        }else if(element.tagName==='A'&&name==='href'){
          try{const url=new URL(attribute.value,location.origin);if(!['http:','https:','mailto:'].includes(url.protocol))element.removeAttribute(attribute.name);}
          catch{element.removeAttribute(attribute.name);}
        }else if(element.tagName==='A'&&['target','rel'].includes(name)){
          element.removeAttribute(attribute.name);
        }else if(element.tagName==='FONT'&&['face','size','color'].includes(name)){
          // document.execCommand uses these legacy attributes; they are presentation-only.
        }else element.removeAttribute(attribute.name);
      }
      if(element.tagName==='A'&&element.hasAttribute('href')){element.setAttribute('target','_blank');element.setAttribute('rel','noopener noreferrer');}
      clean(element);
    }
  };
  clean(template.content);return template.innerHTML;
}

function command(name:string,value?:string){document.execCommand(name,false,value);}
function readFile(file:File){return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});}
function attachmentUrl(item:NoteAttachment){return item.data&&/^data:[^;,]{1,100};base64,[A-Za-z0-9+/=]+$/.test(item.data)?item.data:'';}
function imageUrl(item:NoteAttachment){return item.data&&/^image\/(png|jpeg|gif|webp|avif)$/i.test(item.type)&&/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(item.data)?item.data:'';}

function AsyncPreview({item,load}:{item:NoteAttachment;load?:(item:NoteAttachment)=>Promise<Blob|null>}){
  const [url,setUrl]=useState('');useEffect(()=>{let active=true,current='';if(load&&item.type.startsWith('image/'))void load(item).then(blob=>{if(!active||!blob)return;current=URL.createObjectURL(blob);setUrl(current);}).catch(()=>{});
    return()=>{active=false;if(current)URL.revokeObjectURL(current);};},[item.id]);const inline=imageUrl(item);
  return (inline||url)?e('img',{src:inline||url,alt:item.name,loading:'lazy'}):null;
}
export function Attachments({items,onRemove,onDownload,onRename,onSetCover,onMove,coverId,loadPreview,moveTargets=[]}:{items:NoteAttachment[];
  onRemove?:(item:NoteAttachment)=>void;onDownload?:(item:NoteAttachment)=>void;onRename?:(item:NoteAttachment)=>void;
  onSetCover?:(item:NoteAttachment)=>void;onMove?:(item:NoteAttachment,objectId:string)=>void;coverId?:string;
  loadPreview?:(item:NoteAttachment)=>Promise<Blob|null>;moveTargets?:{id:string;title:string}[]}){
  if(!items.length)return null;
  return e('section',{class:'note-attachments','aria-label':'Вложения'},
    e('div',{class:'section-heading'},e('div',null,e('h2',null,'Файлы'),e('p',{class:'muted'},items.length+' '+(items.length===1?'файл':'файлов')))),
    e('div',{class:'attachment-list'},items.map(item=>{
      const image=item.type.startsWith('image/'),cover=coverId===item.id;
      return e('article',{class:'attachment-card'+(cover?' is-cover':''),key:item.id},
        e('div',{class:'attachment-preview'},image?e(AsyncPreview,{item,load:loadPreview}):e(UiIcon,{name:'file',size:24})),
        e('div',{class:'attachment-copy'},
          e('div',{class:'attachment-title-row'},e('strong',null,item.name),cover&&e('span',{class:'badge accent'},'Обложка')),
          e('small',null,formatBytes(item.size)+' · '+(item.type||'Файл'))),
        e('div',{class:'attachment-actions'},
          item.data&&!onDownload?e('a',{class:'attachment-action',href:attachmentUrl(item),download:item.name,'aria-label':'Скачать '+item.name},e(UiIcon,{name:'download',size:17}),'Скачать')
            :onDownload&&e('button',{type:'button',class:'tertiary-button',onClick:()=>onDownload(item)},e(UiIcon,{name:'download',size:17}),'Скачать'),
          onRename&&e('button',{type:'button',class:'tertiary-button',onClick:()=>onRename(item)},e(UiIcon,{name:'edit',size:17}),'Переименовать'),
          onSetCover&&image&&e('button',{type:'button',class:cover?'secondary-button':'tertiary-button',onClick:()=>onSetCover(item)},e(UiIcon,{name:'image',size:17}),cover?'Обложка':'На обложку'),
          onMove&&moveTargets.length>0&&e('select',{class:'attachment-move',value:'','aria-label':'Переместить вложение '+item.name,onChange:(ev:Event)=>{const value=(ev.target as HTMLSelectElement).value;if(value)onMove(item,value);}},
            e('option',{value:''},'Переместить…'),moveTargets.map(target=>e('option',{value:target.id,key:target.id},target.title||'Без заголовка'))),
          onRemove&&e('button',{type:'button',class:'text-danger-button',onClick:()=>onRemove(item),'aria-label':'Удалить вложение '+item.name},e(UiIcon,{name:'trash',size:17}),'Удалить')));
    })));
}
function formatBytes(value:number){if(value<1024)return value+' Б';if(value<1024*1024)return (value/1024).toFixed(value<10*1024?1:0)+' КБ';if(value<1024*1024*1024)return (value/1024/1024).toFixed(value<10*1024*1024?1:0)+' МБ';return (value/1024/1024/1024).toFixed(1)+' ГБ';}

export function RichTextEditor({html,text,attachments,onChange,onAttachmentsChange,onFilesSelected,onRemoveAttachment,onDownloadAttachment,onRenameAttachment,onSetCover,coverId,loadPreview,onError}:{
  html?:string;text:string;attachments:NoteAttachment[];
  onChange:(html:string,text:string)=>void;onAttachmentsChange:(items:NoteAttachment[])=>void;
  onFilesSelected?:(files:File[])=>Promise<void>|void;onRemoveAttachment?:(item:NoteAttachment)=>void;onDownloadAttachment?:(item:NoteAttachment)=>void;
  onRenameAttachment?:(item:NoteAttachment)=>void;onSetCover?:(item:NoteAttachment)=>void;coverId?:string;loadPreview?:(item:NoteAttachment)=>Promise<Blob|null>;
  onError:(message:string)=>void;
}){
  const editor=useRef<HTMLDivElement>(null),files=useRef<HTMLInputElement>(null),selection=useRef<Range|null>(null);
  const initial=useRef(sanitizeNoteHtml(html??plainToHtml(text)));
  useEffect(()=>{if(editor.current)editor.current.innerHTML=initial.current;},[]);
  const remember=()=>{const selected=document.getSelection(),root=editor.current;if(selected?.rangeCount&&root?.contains(selected.anchorNode))selection.current=selected.getRangeAt(0).cloneRange();};
  const restore=()=>{const selected=document.getSelection();if(selection.current&&selected){selected.removeAllRanges();selected.addRange(selection.current);}editor.current?.focus();};
  const changed=()=>{const root=editor.current;if(root){remember();onChange(sanitizeNoteHtml(root.innerHTML),root.innerText.replace(/\u00a0/g,' '));}};
  const apply=(name:string,value?:string)=>{restore();command(name,value);changed();};
  const keepSelection=(event:MouseEvent)=>event.preventDefault();
  const addTable=()=>apply('insertHTML','<table><tbody><tr><th>Заголовок</th><th>Заголовок</th></tr><tr><td>Ячейка</td><td>Ячейка</td></tr></tbody></table><p><br></p>');
  const addFiles=async(event:Event)=>{
    const input=event.target as HTMLInputElement;const selected=[...(input.files??[])];input.value='';if(!selected.length)return;
    if(attachments.length+selected.length>500){onError('В одной заметке допускается до 500 вложений.');return;}
    if(onFilesSelected){try{await onFilesSelected(selected);}catch(caught){onError(caught instanceof Error?caught.message:'Не удалось загрузить выбранный файл.');}return;}
    try{const legacy=selected.filter(file=>file.size<=512*1024);if(legacy.length!==selected.length)throw Error('Для больших файлов нужен потоковый загрузчик.');
      const added=await Promise.all(legacy.map(async file=>({id:crypto.randomUUID(),name:file.name.slice(0,200)||'Файл',type:file.type.slice(0,100)||'application/octet-stream',size:file.size,data:await readFile(file)})));
      onAttachmentsChange([...attachments,...added]);
    }catch(caught){onError(caught instanceof Error?caught.message:'Не удалось прочитать выбранный файл.');}
  };
  const paste=(event:ClipboardEvent)=>{
    event.preventDefault();const source=event.clipboardData?.getData('text/html');
    apply(source?'insertHTML':'insertText',source?sanitizeNoteHtml(source):event.clipboardData?.getData('text/plain')??'');
  };
  return e('div',{class:'rich-editor'},
    e('div',{class:'editor-toolbar',role:'toolbar','aria-label':'Форматирование заметки'},
      e('button',{type:'button',onMouseDown:keepSelection,onClick:()=>apply('bold'),'aria-label':'Полужирный',title:'Полужирный (Ctrl+B)'},'B'),
      e('button',{type:'button',onMouseDown:keepSelection,onClick:()=>apply('italic'),'aria-label':'Курсив',title:'Курсив (Ctrl+I)'},'I'),
      e('button',{type:'button',onMouseDown:keepSelection,onClick:()=>apply('underline'),'aria-label':'Подчёркивание',title:'Подчёркивание (Ctrl+U)'},'U'),
      e('button',{type:'button',onMouseDown:keepSelection,onClick:()=>apply('strikeThrough'),'aria-label':'Зачёркивание'},'S'),
      e('select',{'aria-label':'Стиль абзаца',onMouseDown:remember,onChange:(ev:Event)=>apply('formatBlock',(ev.target as HTMLSelectElement).value)},
        e('option',{value:'p'},'Обычный'),e('option',{value:'h1'},'Заголовок 1'),e('option',{value:'h2'},'Заголовок 2'),e('option',{value:'blockquote'},'Цитата'),e('option',{value:'pre'},'Код')),
      e('select',{'aria-label':'Шрифт',onMouseDown:remember,onChange:(ev:Event)=>apply('fontName',(ev.target as HTMLSelectElement).value)},
        e('option',{value:'-apple-system'},'Системный'),e('option',{value:'Arial'},'Arial'),e('option',{value:'Georgia'},'Georgia'),e('option',{value:'monospace'},'Моноширинный')),
      e('select',{'aria-label':'Размер текста',onMouseDown:remember,onChange:(ev:Event)=>apply('fontSize',(ev.target as HTMLSelectElement).value)},
        e('option',{value:'3'},'Обычный'),e('option',{value:'2'},'Мелкий'),e('option',{value:'4'},'Крупный'),e('option',{value:'5'},'Очень крупный')),
      e('button',{type:'button',onMouseDown:keepSelection,onClick:()=>apply('insertUnorderedList'),'aria-label':'Маркированный список'},'• Список'),
      e('button',{type:'button',onMouseDown:keepSelection,onClick:()=>apply('insertOrderedList'),'aria-label':'Нумерованный список'},'1. Список'),
      e('button',{type:'button',onMouseDown:keepSelection,onClick:addTable},'Таблица'),
      e('button',{type:'button',onClick:()=>files.current?.click()},'Фото / файл'),
      e('button',{type:'button',onMouseDown:keepSelection,onClick:()=>apply('removeFormat')},'Очистить формат')),
    e('div',{ref:editor,class:'rich-editor-area',contentEditable:true,role:'textbox','aria-multiline':'true','aria-label':'Текст заметки',onInput:changed,onKeyUp:remember,onMouseUp:remember,onBlur:remember,onPaste:paste,
      onDrop:(event:DragEvent)=>{event.preventDefault();onError('Добавляйте файлы кнопкой «Фото / файл».');},
      onKeyDown:(ev:KeyboardEvent)=>{if((ev.ctrlKey||ev.metaKey)&&ev.shiftKey&&ev.key==='7'){ev.preventDefault();apply('insertOrderedList');}else if((ev.ctrlKey||ev.metaKey)&&ev.shiftKey&&ev.key==='8'){ev.preventDefault();apply('insertUnorderedList');}}}),
    e('input',{ref:files,class:'file-picker',type:'file',multiple:true,onChange:addFiles}),
    e('p',{class:'hint'},'Поддерживаются стандартные сочетания Ctrl/⌘+B, I, U; списки — Ctrl/⌘+Shift+7 или 8.'),
    e(Attachments,{items:attachments,coverId,loadPreview,onDownload:onDownloadAttachment,onRename:onRenameAttachment,onSetCover,
      onRemove:onRemoveAttachment??(item=>onAttachmentsChange(attachments.filter(current=>current.id!==item.id)))}));
}
