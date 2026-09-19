import { h as e, type ComponentChildren } from 'preact';

export type UiIconName='notes'|'today'|'projects'|'settings'|'logout'|'search'|'plus'|'sync'|'chevron-right'|'back'|'user'|'bell'|'devices'|'key'|'archive'|'trash'|'contacts'|'database'|'diagnostics'|'users'|'info'|'palette'|'lock'|'more'|'check'|'warning'|'wifi-off'|'folder'|'calendar'|'menu'|'file'|'download'|'edit'|'image'|'upload';

export function UiIcon({name,size=20}:{name:UiIconName;size?:number}){
  const common={width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'} as const;
  const p=(d:string)=>e('path',{d});
  if(name==='notes')return e('svg',common,p('M6 3.5h9l3 3V20.5H6z'),p('M15 3.5v4h4'),p('M9 11h6M9 15h6'));
  if(name==='today'||name==='calendar')return e('svg',common,e('rect',{x:3.5,y:5.5,width:17,height:15,rx:2}),p('M7 3.5v4M17 3.5v4M3.5 9.5h17'),name==='today'&&p('M8.5 13h3v3h-3z'));
  if(name==='projects'||name==='folder')return e('svg',common,p('M3.5 7h6l2-2h9v14.5h-17z'),p('M3.5 9.5h17'));
  if(name==='settings')return e('svg',common,e('circle',{cx:12,cy:12,r:3}),e('path',{d:'M19 13.5v-3l-2-.6a7 7 0 0 0-.7-1.6l1-1.9-2.1-2.1-1.9 1a7 7 0 0 0-1.6-.7L11 2H8l-.6 2a7 7 0 0 0-1.6.7l-1.9-1-2.1 2.1 1 1.9a7 7 0 0 0-.7 1.6L0 10v3l2 .6a7 7 0 0 0 .7 1.6l-1 1.9 2.1 2.1 1.9-1a7 7 0 0 0 1.6.7l.6 2h3l.6-2a7 7 0 0 0 1.6-.7l1.9 1 2.1-2.1-1-1.9a7 7 0 0 0 .7-1.6z',transform:'translate(1 0) scale(.92)'}));
  if(name==='logout')return e('svg',common,p('M10 5H5v14h5M14 8l4 4-4 4M8 12h10'));
  if(name==='search')return e('svg',common,e('circle',{cx:10.5,cy:10.5,r:6}),p('m15 15 4.5 4.5'));
  if(name==='plus')return e('svg',common,p('M12 5v14M5 12h14'));
  if(name==='sync')return e('svg',common,p('M20 7v5h-5'),p('M4 17v-5h5'),p('M6.1 8A7 7 0 0 1 18 6l2 1M18 16a7 7 0 0 1-11.9.1L4 17'));
  if(name==='chevron-right')return e('svg',common,p('m9 6 6 6-6 6'));
  if(name==='back')return e('svg',common,p('m15 18-6-6 6-6'));
  if(name==='user')return e('svg',common,e('circle',{cx:12,cy:8,r:3.5}),p('M5.5 20a6.5 6.5 0 0 1 13 0'));
  if(name==='bell')return e('svg',common,p('M6 9a6 6 0 0 1 12 0c0 7 3 7 3 7H3s3 0 3-7'),p('M10 20h4'));
  if(name==='devices')return e('svg',common,e('rect',{x:3.5,y:4,width:12.5,height:14,rx:2}),p('M8 21h11a2 2 0 0 0 2-2V9'));
  if(name==='key')return e('svg',common,e('circle',{cx:8,cy:12,r:4}),p('M12 12h9M17 12v3M20 12v2'));
  if(name==='archive')return e('svg',common,e('rect',{x:4,y:6,width:16,height:14,rx:2}),p('M3 4h18v4H3zM9 12h6'));
  if(name==='trash')return e('svg',common,p('M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5'));
  if(name==='contacts')return e('svg',common,e('circle',{cx:9,cy:9,r:3}),e('circle',{cx:17,cy:10,r:2.5}),p('M3.5 20a5.5 5.5 0 0 1 11 0M14 16.5a4 4 0 0 1 6.5 3.5'));
  if(name==='database')return e('svg',common,e('ellipse',{cx:12,cy:5.5,rx:7.5,ry:3}),p('M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6'));
  if(name==='diagnostics')return e('svg',common,p('M4 18h3l2-7 3 10 2-6 2 3h4'),p('M4 5h16'));
  if(name==='users')return e('svg',common,e('circle',{cx:9,cy:8,r:3}),e('circle',{cx:17,cy:9,r:2.3}),p('M3 20a6 6 0 0 1 12 0M14 16a4.5 4.5 0 0 1 7 4'));
  if(name==='info')return e('svg',common,e('circle',{cx:12,cy:12,r:9}),p('M12 10v6'),p('M12 7h.01'));
  if(name==='palette')return e('svg',common,p('M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5a3 3 0 0 0 3-3c0-4-4-7-9-7Z'),e('circle',{cx:7.5,cy:9, r:1}),e('circle',{cx:10.5,cy:6.5,r:1}),e('circle',{cx:14,cy:6.5,r:1}));
  if(name==='lock')return e('svg',common,e('rect',{x:5,y:10,width:14,height:10,rx:2}),p('M8 10V7a4 4 0 0 1 8 0v3'));
  if(name==='more')return e('svg',common,e('circle',{cx:5,cy:12,r:1}),e('circle',{cx:12,cy:12,r:1}),e('circle',{cx:19,cy:12,r:1}));
  if(name==='check')return e('svg',common,p('m5 12 4 4L19 6'));
  if(name==='warning')return e('svg',common,p('M12 3 2.8 19h18.4L12 3Z'),p('M12 9v4M12 16h.01'));
  if(name==='wifi-off')return e('svg',common,p('M2 8a15 15 0 0 1 17.5-1.2M5 12a10 10 0 0 1 9.8-1.8M8.5 15.5a5 5 0 0 1 2.8-.5'),p('M3 3l18 18'),e('circle',{cx:12,cy:19,r:1}));
  if(name==='file')return e('svg',common,p('M6 3.5h8l4 4v13H6z'),p('M14 3.5v4h4'));
  if(name==='download')return e('svg',common,p('M12 3v12M7 10l5 5 5-5'),p('M5 20h14'));
  if(name==='edit')return e('svg',common,p('M4 20h4l11-11-4-4L4 16z'),p('m13.5 6.5 4 4'));
  if(name==='image')return e('svg',common,e('rect',{x:3.5,y:4,width:17,height:16,rx:2}),e('circle',{cx:9,cy:9,r:1.5}),p('m5 18 4.5-4.5 3 3 2-2 4.5 3.5'));
  if(name==='upload')return e('svg',common,p('M12 21V9M7 14l5-5 5 5'),p('M5 4h14'));
  return e('svg',common,p('M4 6h16M4 12h16M4 18h16'));
}

export function BackButton({onClick,label='Назад'}:{onClick:()=>void;label?:string}){
  return e('button',{type:'button',class:'ui-back',onClick},e(UiIcon,{name:'back'}),e('span',null,label));
}

export function PageHeader({eyebrow,title,description,actions,back}:{eyebrow?:string;title:string;description?:string;actions?:ComponentChildren;back?:()=>void}){
  return e('header',{class:'ui-page-header'},
    e('div',{class:'ui-page-heading'},
      back&&e(BackButton,{onClick:back}),
      eyebrow&&e('p',{class:'eyebrow'},eyebrow),
      e('h1',null,title),
      description&&e('p',{class:'ui-page-description'},description)),
    actions&&e('div',{class:'ui-page-actions'},actions));
}

export function SectionHeader({title,description,action}:{title:string;description?:string;action?:ComponentChildren}){
  return e('div',{class:'ui-section-header'},e('div',null,e('h2',null,title),description&&e('p',null,description)),action);
}

export function StatusDot({tone='neutral'}:{tone?:'neutral'|'success'|'warning'|'danger'|'accent'}){
  return e('span',{class:'ui-status-dot '+tone,'aria-hidden':'true'});
}

export function Chevron(){return e(UiIcon,{name:'chevron-right',size:18});}
