import { h as e } from 'preact';
import { useMemo,useRef,useState } from 'preact/hooks';
import { addScheduleDays,criticalTaskIds,dependencyConflicts,type GanttCalendar,type GanttTask,type TaskDependency } from '../gantt.ts';
import type { TaskPriority,TaskStatus } from '../planner.ts';

export interface GanttRow extends GanttTask {
  status:TaskStatus;priority:TaskPriority;
}
export interface GanttDateChange {id:string;startDate?:string;endDate?:string}
const DAY=86_400_000;
const ms=(date:string)=>Date.parse(date+'T00:00:00Z');
const iso=(value:number)=>new Date(value).toISOString().slice(0,10);
const diff=(a:string,b:string)=>Math.round((ms(b)-ms(a))/DAY);
const shiftCalendar=(date:string,days:number)=>iso(ms(date)+days*DAY);
const label=(date:string,scale:'day'|'week')=>new Intl.DateTimeFormat('ru-RU',scale==='day'?{day:'2-digit',month:'short'}:{day:'2-digit',month:'short'}).format(new Date(date+'T00:00:00Z'));
const endpoint=(row:GanttRow,dep:TaskDependency,source:boolean)=>{
  if(source)return dep.type[0]==='F'?row.endDate:row.startDate;
  return dep.type[1]==='F'?row.endDate:row.startDate;
};
const duration=(row:GanttRow)=>row.startDate&&row.endDate?diff(row.startDate,row.endDate):0;

export function GanttView({rows,calendar,readOnly,onOpen,onRequestDates}:{rows:GanttRow[];calendar:GanttCalendar;readOnly:boolean;onOpen:(id:string)=>void;onRequestDates:(change:GanttDateChange)=>void}){
  const [scale,setScale]=useState<'day'|'week'>('day'),[showLinks,setShowLinks]=useState(true),[showCritical,setShowCritical]=useState(false),[fullscreen,setFullscreen]=useState(false);
  const scrollRef=useRef<HTMLDivElement>(null),cell=scale==='day'?34:14,rowHeight=48;
  const scheduled=rows.filter(row=>row.startDate||row.endDate),today=new Date().toISOString().slice(0,10);
  const range=useMemo(()=>{
    const dates=scheduled.flatMap(row=>[row.startDate,row.endDate].filter(Boolean) as string[]);dates.push(today);
    let start=dates.sort()[0]??today,end=dates.sort().at(-1)??today;start=shiftCalendar(start,-7);end=shiftCalendar(end,14);
    const days=Math.max(28,Math.min(1460,diff(start,end)+1));return{start,end:shiftCalendar(start,days-1),days};
  },[rows.map(row=>row.id+row.startDate+row.endDate).join('|'),today]);
  const width=range.days*cell,critical=showCritical?criticalTaskIds(rows,calendar):new Set<string>();
  const conflicts=dependencyConflicts(rows,calendar),conflictIds=new Set(conflicts.map(item=>item.taskId));
  const byId=new Map(rows.map(row=>[row.id,row])),indexById=new Map(scheduled.map((row,index)=>[row.id,index]));
  const tickStep=scale==='day'?1:7,ticks=[] as {date:string;left:number}[];
  for(let n=0;n<range.days;n+=tickStep){const date=shiftCalendar(range.start,n);ticks.push({date,left:n*cell});}
  function todayScroll(){const left=Math.max(0,diff(range.start,today)*cell-120);scrollRef.current?.scrollTo({left,behavior:'smooth'});}
  function beginDrag(ev:PointerEvent,row:GanttRow,mode:'move'|'start'|'end'){
    if(readOnly||(!row.startDate&&!row.endDate))return;const allowed=innerWidth>=700||matchMedia('(orientation: landscape)').matches;if(!allowed)return;
    ev.preventDefault();const originX=ev.clientX,start=row.startDate,end=row.endDate,target=ev.currentTarget as HTMLElement;target.setPointerCapture?.(ev.pointerId);
    const finish=(up:PointerEvent)=>{
      window.removeEventListener('pointerup',finish);const raw=Math.round((up.clientX-originX)/cell);if(!raw)return;
      let nextStart=start,nextEnd=end;
      if(mode==='move'){if(start)nextStart=addScheduleDays(start,raw,calendar);if(end)nextEnd=addScheduleDays(end,raw,calendar);}
      else if(mode==='start'&&start){const shifted=addScheduleDays(start,raw,calendar);if(!end||shifted<=end)nextStart=shifted;}
      else if(mode==='end'&&end){const shifted=addScheduleDays(end,raw,calendar);if(!start||shifted>=start)nextEnd=shifted;}
      onRequestDates({id:row.id,startDate:nextStart,endDate:nextEnd});
    };
    window.addEventListener('pointerup',finish,{once:true});
  }
  const linkLines=showLinks?scheduled.flatMap((row)=>{
    const y2=(indexById.get(row.id)??0)*rowHeight+rowHeight/2;
    return(row.dependencies??[]).flatMap((dep)=>{
      const pred=byId.get(dep.taskId),predIndex=indexById.get(dep.taskId);if(!pred||predIndex===undefined)return[];
      const fromDate=endpoint(pred,dep,true),toDate=endpoint(row,dep,false);if(!fromDate||!toDate)return[];
      const x1=(diff(range.start,fromDate)+(dep.type[0]==='F'?1:0))*cell,x2=(diff(range.start,toDate)+(dep.type[1]==='F'?1:0))*cell,y1=predIndex*rowHeight+rowHeight/2;
      const middle=x1+(x2-x1)/2;return[e('path',{key:row.id+dep.taskId,d:`M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`,class:'gantt-link',markerEnd:'url(#gantt-arrow)'})];
    });
  }):[];
  return e('section',{class:'gantt'+(fullscreen?' gantt-fullscreen':'')},
    e('div',{class:'gantt-toolbar'},
      e('div',{class:'segmented'},e('button',{class:scale==='day'?'selected':'',onClick:()=>setScale('day')},'Дни'),e('button',{class:scale==='week'?'selected':'',onClick:()=>setScale('week')},'Недели')),
      e('button',{onClick:todayScroll},'Сегодня'),
      e('label',{class:'compact-check'},e('input',{type:'checkbox',checked:showLinks,onChange:(ev:Event)=>setShowLinks((ev.target as HTMLInputElement).checked)}),'Связи'),
      e('label',{class:'compact-check'},e('input',{type:'checkbox',checked:showCritical,onChange:(ev:Event)=>setShowCritical((ev.target as HTMLInputElement).checked)}),'Критический путь'),
      e('button',{onClick:()=>setFullscreen(value=>!value)},fullscreen?'Закрыть полный экран':'Полный экран')),
    conflictIds.size>0&&e('p',{class:'gantt-warning',role:'status'},'Есть '+conflictIds.size+' задач с нарушенными зависимостями. Они отмечены предупреждением.'),
    e('div',{class:'gantt-layout'},
      e('div',{class:'gantt-label-column'},
        e('div',{class:'gantt-label-head'},'Задача'),
        scheduled.map(row=>e('button',{key:row.id,class:'gantt-label-row'+(critical.has(row.id)?' critical':'')+(conflictIds.has(row.id)?' conflict':''),onClick:()=>onOpen(row.id)},
          e('strong',null,row.title),e('small',null,row.startDate&&row.endDate?row.startDate+' — '+row.endDate:row.startDate?'с '+row.startDate:row.endDate?'до '+row.endDate:'Без срока')))),
      e('div',{class:'gantt-scroll',ref:scrollRef},
        e('div',{class:'gantt-canvas',style:{width:width+'px',height:(38+scheduled.length*rowHeight)+'px'}},
          e('div',{class:'gantt-timeline-head',style:{height:'38px'}},ticks.map(t=>e('span',{key:t.date,style:{left:t.left+'px',width:tickStep*cell+'px'}},label(t.date,scale)))),
          e('div',{class:'gantt-grid-lines'},ticks.map(t=>e('i',{key:t.date,style:{left:t.left+'px'}})),e('i',{class:'today-line',style:{left:diff(range.start,today)*cell+'px'}})),
          showLinks&&e('svg',{class:'gantt-links',width,height:scheduled.length*rowHeight,'aria-hidden':'true'},e('defs',null,e('marker',{id:'gantt-arrow',markerWidth:'7',markerHeight:'7',refX:'6',refY:'3.5',orient:'auto'},e('path',{d:'M0,0 L7,3.5 L0,7 z'}))),linkLines),
          e('div',{class:'gantt-bars',style:{height:scheduled.length*rowHeight+'px'}},scheduled.map((row,index)=>{
            const start=row.startDate??row.endDate!,end=row.endDate??row.startDate!,left=Math.max(0,diff(range.start,start)*cell),barWidth=Math.max(cell,(diff(start,end)+1)*cell);
            return e('div',{class:'gantt-track',key:row.id,style:{top:index*rowHeight+'px',height:rowHeight+'px'}},
              e('button',{class:'gantt-bar status-'+row.status+(critical.has(row.id)?' critical':'')+(conflictIds.has(row.id)?' conflict':''),style:{left:left+'px',width:barWidth+'px'},title:row.title,onClick:()=>onOpen(row.id),onPointerDown:(ev:PointerEvent)=>beginDrag(ev,row,'move')},
                !readOnly&&e('span',{class:'gantt-handle start','aria-hidden':'true',onPointerDown:(ev:PointerEvent)=>{ev.stopPropagation();beginDrag(ev,row,'start');}}),
                e('span',null,row.title),
                !readOnly&&e('span',{class:'gantt-handle end','aria-hidden':'true',onPointerDown:(ev:PointerEvent)=>{ev.stopPropagation();beginDrag(ev,row,'end');}})));
          }))))),
    rows.some(row=>!row.startDate&&!row.endDate)&&e('details',{class:'gantt-unscheduled'},e('summary',null,'Без срока · '+rows.filter(row=>!row.startDate&&!row.endDate).length),
      rows.filter(row=>!row.startDate&&!row.endDate).map(row=>e('button',{key:row.id,onClick:()=>onOpen(row.id)},row.title))),
    !readOnly&&e('p',{class:'hint gantt-edit-hint'},'Перетаскивание и изменение краёв полосы доступны на широком экране и в альбомной ориентации. В портретном режиме iPhone Гант остаётся полноценным режимом просмотра; даты всегда можно изменить через карточку задачи.'));
}
