export type GanttCalendar='calendar'|'weekdays';
export type TaskDependencyType='FS'|'SS'|'FF'|'SF';
export interface TaskDependency {taskId:string;type:TaskDependencyType;lagDays:number}
export interface GanttTask {
  id:string;title:string;startDate?:string;endDate?:string;dependencies?:TaskDependency[];
}
export interface ScheduleChange {id:string;oldStart?:string;oldEnd?:string;startDate?:string;endDate?:string;shiftDays:number}

const DAY=86_400_000;
const dateOk=(value:string|undefined)=>Boolean(value&&/^\d{4}-\d\d-\d\d$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value);
const ms=(value:string)=>Date.parse(value+'T00:00:00Z');
const iso=(value:number)=>new Date(value).toISOString().slice(0,10);
export const isWorkday=(date:string)=>{const day=new Date(date+'T00:00:00Z').getUTCDay();return day!==0&&day!==6;};

export function addScheduleDays(date:string,days:number,calendar:GanttCalendar){
  if(!dateOk(date)||!Number.isInteger(days))throw Error('Некорректная дата или сдвиг.');
  if(days===0)return date;
  if(calendar==='calendar')return iso(ms(date)+days*DAY);
  let cursor=ms(date),remaining=Math.abs(days),step=days>0?1:-1;
  while(remaining){cursor+=step*DAY;if(isWorkday(iso(cursor)))remaining--;}
  return iso(cursor);
}
export function scheduleDistance(from:string,to:string,calendar:GanttCalendar){
  if(!dateOk(from)||!dateOk(to))throw Error('Некорректная дата.');
  if(from===to)return 0;
  const direction=from<to?1:-1;let cursor=from,count=0;
  while(cursor!==to&&Math.abs(count)<20_000){
    cursor=addScheduleDays(cursor,direction,calendar);count+=direction;
    if(direction>0&&cursor>to||direction<0&&cursor<to)break;
  }
  return count;
}
export function taskDuration(start:string|undefined,end:string|undefined,calendar:GanttCalendar){
  if(!start||!end||!dateOk(start)||!dateOk(end)||start>end)return 0;
  return Math.max(0,scheduleDistance(start,end,calendar));
}
const dependencyTypes:TaskDependencyType[]=['FS','SS','FF','SF'];
export function normalizeDependencies(input:TaskDependency[]|undefined,selfId?:string){
  const out:TaskDependency[]=[];
  for(const raw of input??[]){
    if(!raw||typeof raw!=='object'||typeof raw.taskId!=='string'||!dependencyTypes.includes(raw.type)||!Number.isInteger(raw.lagDays)||raw.lagDays<-3650||raw.lagDays>3650)throw Error('Некорректная зависимость задачи.');
    if(selfId&&raw.taskId===selfId)throw Error('Задача не может зависеть от самой себя.');
    if(out.some(item=>item.taskId===raw.taskId))throw Error('Одна задача не может быть добавлена в предшественники дважды.');
    out.push({taskId:raw.taskId,type:raw.type,lagDays:raw.lagDays});
  }
  return out;
}
export function dependencyCycles(tasks:GanttTask[]){
  const byId=new Map(tasks.map(task=>[task.id,task])),state=new Map<string,0|1|2>(),cycle=new Set<string>();
  const visit=(id:string,stack:string[])=>{
    const mark=state.get(id)??0;if(mark===2)return;if(mark===1){const at=stack.indexOf(id);for(const item of stack.slice(Math.max(0,at)))cycle.add(item);return;}
    state.set(id,1);const task=byId.get(id);for(const dep of task?.dependencies??[])if(byId.has(dep.taskId))visit(dep.taskId,[...stack,id]);
    state.set(id,2);
  };
  for(const task of tasks)visit(task.id,[]);
  return cycle;
}
export function validateDependencyGraph(tasks:GanttTask[]){
  const ids=new Set(tasks.map(task=>task.id));
  for(const task of tasks)for(const dep of normalizeDependencies(task.dependencies,task.id))if(!ids.has(dep.taskId))throw Error('Предшественник задачи больше не существует в этом проекте.');
  if(dependencyCycles(tasks).size)throw Error('Зависимости задач образуют цикл.');
}
function minConstraint(predecessor:GanttTask,dep:TaskDependency,calendar:GanttCalendar){
  if(dep.type==='FS'&&predecessor.endDate)return{field:'startDate' as const,date:addScheduleDays(predecessor.endDate,1+dep.lagDays,calendar)};
  if(dep.type==='SS'&&predecessor.startDate)return{field:'startDate' as const,date:addScheduleDays(predecessor.startDate,dep.lagDays,calendar)};
  if(dep.type==='FF'&&predecessor.endDate)return{field:'endDate' as const,date:addScheduleDays(predecessor.endDate,dep.lagDays,calendar)};
  if(dep.type==='SF'&&predecessor.startDate)return{field:'endDate' as const,date:addScheduleDays(predecessor.startDate,dep.lagDays,calendar)};
}
export function dependencyConflicts(tasks:GanttTask[],calendar:GanttCalendar){
  const byId=new Map(tasks.map(task=>[task.id,task])),out:{taskId:string;predecessorId:string;type:TaskDependencyType;required:string;actual?:string}[]=[];
  for(const task of tasks)for(const dep of task.dependencies??[]){
    const predecessor=byId.get(dep.taskId),constraint=predecessor&&minConstraint(predecessor,dep,calendar);if(!constraint)continue;
    const actual=task[constraint.field];if(!actual||actual<constraint.date)out.push({taskId:task.id,predecessorId:dep.taskId,type:dep.type,required:constraint.date,actual});
  }
  return out;
}
function shiftTask(task:GanttTask,days:number,calendar:GanttCalendar){
  if(days<=0)return task;
  return{...task,...(task.startDate?{startDate:addScheduleDays(task.startDate,days,calendar)}:{}),...(task.endDate?{endDate:addScheduleDays(task.endDate,days,calendar)}:{})};
}
function daysNeeded(actual:string|undefined,required:string,calendar:GanttCalendar){
  if(!actual||actual>=required)return 0;
  let shifted=actual,days=0;while(shifted<required&&days<20_000){days++;shifted=addScheduleDays(actual,days,calendar);}return days;
}
export function cascadeSchedule(tasks:GanttTask[],changedId:string,startDate:string|undefined,endDate:string|undefined,calendar:GanttCalendar){
  const original=new Map<string,GanttTask>(tasks.map(task=>[task.id,{...task,dependencies:task.dependencies?.map(dep=>({...dep}))}] as [string,GanttTask])),current=new Map<string,GanttTask>(original);
  const changed=current.get(changedId);if(!changed)throw Error('Задача не найдена.');
  if(startDate&&!dateOk(startDate)||endDate&&!dateOk(endDate)||startDate&&endDate&&startDate>endDate)throw Error('Проверьте даты задачи.');
  current.set(changedId,{...changed,startDate,endDate});
  let modified=true,round=0;
  while(modified&&round++<=tasks.length+1){
    modified=false;
    for(const task0 of tasks){
      const task=current.get(task0.id)!;let shift=0;
      for(const dep of task.dependencies??[]){
        const pred=current.get(dep.taskId),constraint=pred&&minConstraint(pred,dep,calendar);if(!constraint)continue;
        shift=Math.max(shift,daysNeeded(task[constraint.field],constraint.date,calendar));
      }
      if(shift>0){current.set(task.id,shiftTask(task,shift,calendar));modified=true;}
    }
  }
  const list=[...current.values()];if(dependencyCycles(list).size)throw Error('Зависимости задач образуют цикл.');
  const changes:ScheduleChange[]=[];
  for(const [id,next] of current){const before=original.get(id)!;if(before.startDate!==next.startDate||before.endDate!==next.endDate){
    const shift=before.startDate&&next.startDate?scheduleDistance(before.startDate,next.startDate,calendar):before.endDate&&next.endDate?scheduleDistance(before.endDate,next.endDate,calendar):0;
    changes.push({id,oldStart:before.startDate,oldEnd:before.endDate,startDate:next.startDate,endDate:next.endDate,shiftDays:shift});
  }}
  return{changes,conflicts:dependencyConflicts(list,calendar)};
}
export function criticalTaskIds(tasks:GanttTask[],calendar:GanttCalendar){
  if(!tasks.length||dependencyCycles(tasks).size)return new Set<string>();
  const byId=new Map(tasks.map(task=>[task.id,task])),successors=new Map<string,string[]>();
  for(const task of tasks)for(const dep of task.dependencies??[])if(byId.has(dep.taskId))successors.set(dep.taskId,[...(successors.get(dep.taskId)??[]),task.id]);
  const indegree=new Map(tasks.map(task=>[task.id,0]));for(const list of successors.values())for(const id of list)indegree.set(id,(indegree.get(id)??0)+1);
  const queue=[...indegree].filter(([,n])=>n===0).map(([id])=>id),score=new Map<string,number>(),prev=new Map<string,string>();
  for(const id of queue){const task=byId.get(id)!;score.set(id,taskDuration(task.startDate,task.endDate,calendar)+1);}
  for(let cursor=0;cursor<queue.length;cursor++){const id=queue[cursor],base=score.get(id)??1;for(const nextId of successors.get(id)??[]){
    const next=byId.get(nextId)!,candidate=base+taskDuration(next.startDate,next.endDate,calendar)+1;
    if(candidate>(score.get(nextId)??0)){score.set(nextId,candidate);prev.set(nextId,id);}
    indegree.set(nextId,(indegree.get(nextId)??1)-1);if(indegree.get(nextId)===0)queue.push(nextId);
  }}
  let end='';for(const [id,value] of score)if(!end||value>(score.get(end)??0))end=id;
  const result=new Set<string>();while(end){result.add(end);end=prev.get(end)??'';}return result;
}
