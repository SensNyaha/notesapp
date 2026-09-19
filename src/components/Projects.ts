import { h as e } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { User } from '../types/auth.ts';
import { changes, readState, type State } from '../storage.ts';
import {
  createProject,createTask,deleteProject,entityKind,movePlannerObject,readProjectWorkspace,readTags,rescheduleTasks,setProjectArchived,synchronize,
  updateProject,updateTask,vaultName,type ChecklistItem,type GanttCalendar,type Note,type ProjectWorkspace,type TagDefinition,type TaskDependency,type TaskDependencyType,type TaskPriority,type TaskReminderAnchor,type TaskStatus,type WorkspaceItem
} from '../planner.ts';
import { cascadeSchedule,dependencyConflicts,type ScheduleChange } from '../gantt.ts';
import { GanttView,type GanttDateChange } from './Gantt.ts';
import { PageHeader,UiIcon } from './ui.ts';
import { sharedVaultMembers,type VaultMemberInfo } from '../collaboration.ts';
import type { ReminderPlan } from '../../shared/reminders.mjs';

type ProjectFilter='active'|'all'|'favorite'|'archive';
type ProjectTab='overview'|'tasks'|'notes'|'files';
type TaskFilter='all'|'active'|'done'|'cancelled'|'unscheduled';
type ReminderChoice='none'|'exact'|'start'|'start-1d'|'end'|'end-1d';
type TaskView='list'|'gantt';
type ImpactState={taskId:string;changes:ScheduleChange[];single:GanttDateChange};
const templates=[
  {id:'work',name:'Рабочий проект',tasks:['Определить результат','Подготовить план','Проверить итог']},
  {id:'study',name:'Обучение',tasks:['Собрать материалы','Изучить основной блок','Повторить и закрепить']},
  {id:'home',name:'Дом и быт',tasks:['Составить список','Купить необходимое','Выполнить работы']},
  {id:'travel',name:'Путешествие',tasks:['Проверить документы','Забронировать дорогу и жильё','Составить маршрут']},
  {id:'event',name:'Мероприятие',tasks:['Определить формат и дату','Подготовить список участников','Проверить готовность']},
] as const;
const statusLabel:Record<TaskStatus,string>={todo:'К выполнению',in_progress:'В работе',done:'Выполнено',cancelled:'Отменено'};
const priorityLabel:Record<TaskPriority,string>={none:'Без приоритета',low:'Низкий',medium:'Средний',high:'Высокий'};
const dependencyLabel:Record<TaskDependencyType,string>={FS:'Окончание → начало',SS:'Начало → начало',FF:'Окончание → окончание',SF:'Начало → окончание'};
const dateShift=(date:string,days:number)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const activeItem=(item:WorkspaceItem)=>item.lifecycle==='active';
const taskOf=(item:WorkspaceItem)=>item.value.task!;
const byTitle=(a:WorkspaceItem,b:WorkspaceItem)=>a.value.title.localeCompare(b.value.title,'ru');
const cleanProjectId=(value:string)=>value||undefined;

export function ProjectsScreen({user,onBack}:{user:User;onBack:()=>void}){
  const [state,setState]=useState<State>();
  const [names,setNames]=useState<Record<string,string>>({});
  const [selectedVault,setSelectedVault]=useState('');
  const selectedRef=useRef('');selectedRef.current=selectedVault;
  const [workspace,setWorkspace]=useState<ProjectWorkspace>();
  const [tags,setTags]=useState<TagDefinition[]>([]);
  const [members,setMembers]=useState<VaultMemberInfo[]>([]);
  const [screen,setScreen]=useState<'projects'|'project-form'|'project'|'task-form'>('projects');
  const [selectedProject,setSelectedProject]=useState('');
  const [tab,setTab]=useState<ProjectTab>('overview');
  const [projectFilter,setProjectFilter]=useState<ProjectFilter>('active');
  const [taskFilter,setTaskFilter]=useState<TaskFilter>('all');
  const [query,setQuery]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  const [editingProject,setEditingProject]=useState('');
  const [projectTitle,setProjectTitle]=useState(''),[projectDescription,setProjectDescription]=useState('');
  const [projectStart,setProjectStart]=useState(''),[projectEnd,setProjectEnd]=useState(''),[projectFavorite,setProjectFavorite]=useState(false);
  const [projectCalendar,setProjectCalendar]=useState<GanttCalendar>('calendar');
  const [template,setTemplate]=useState('');
  const [editingTask,setEditingTask]=useState('');
  const [taskTitle,setTaskTitle]=useState(''),[taskDescription,setTaskDescription]=useState('');
  const [taskProject,setTaskProject]=useState(''),[taskStatus,setTaskStatus]=useState<TaskStatus>('todo'),[taskPriority,setTaskPriority]=useState<TaskPriority>('none');
  const [taskStart,setTaskStart]=useState(''),[taskEnd,setTaskEnd]=useState(''),[taskAssignee,setTaskAssignee]=useState('');
  const [taskChecklist,setTaskChecklist]=useState<ChecklistItem[]>([]),[taskTags,setTaskTags]=useState<string[]>([]);
  const [taskDependencies,setTaskDependencies]=useState<TaskDependency[]>([]);
  const [taskView,setTaskView]=useState<TaskView>('list'),[impact,setImpact]=useState<ImpactState|null>(null);
  const impactActions=useRef<{only:()=>Promise<void>;chain:()=>Promise<void>}>();
  const [reminderChoice,setReminderChoice]=useState<ReminderChoice>('none'),[reminderLocal,setReminderLocal]=useState('');
  const [existingReminderId,setExistingReminderId]=useState('');

  async function load(preferred?:string){
    const s=await readState(user.id);if(!s){setState(undefined);setWorkspace(undefined);return;}
    const opened=s.vaults.filter(v=>!v.deleted&&!v.transfer&&Boolean(v.key));
    const ns:Record<string,string>={};for(const v of s.vaults)ns[v.header.id]=await vaultName(user.id,v);
    let vid=preferred??selectedRef.current;if(!opened.some(v=>v.header.id===vid))vid=opened.find(v=>v.header.id===s.lastVaultId)?.header.id??opened[0]?.header.id??'';
    setState(s);setNames(ns);setSelectedVault(vid);
    if(!vid){setWorkspace(undefined);setTags([]);setMembers([]);return;}
    const model=await readProjectWorkspace(user,vid);setWorkspace(model);setTags((await readTags(user.id,model.vault)).filter(tag=>!tag.deleted));
    if(model.vault.shared){try{setMembers(await sharedVaultMembers(user,vid));}catch{setMembers([]);}}else setMembers([]);
  }
  async function syncQuiet(){
    try{await synchronize(user);setStatus('Синхронизировано.');}catch{setStatus('Изменения сохранены на устройстве и будут синхронизированы позже.');}
  }
  async function run(fn:()=>Promise<void>){
    setBusy(true);setError('');try{await fn();await syncQuiet();await load();}catch(caught){setError(caught instanceof Error?caught.message:'Не удалось выполнить действие');}
    finally{setBusy(false);}
  }
  useEffect(()=>{
    let alive=true;const changed=()=>{if(alive)void load().catch(c=>setError(c instanceof Error?c.message:'Не удалось прочитать проекты'));};
    changed();changes?.addEventListener('message',changed);window.addEventListener('tasks-data',changed);
    const timer=setInterval(()=>{if(alive&&navigator.onLine)void synchronize(user).then(()=>load()).catch(()=>{});},30000);
    return()=>{alive=false;clearInterval(timer);changes?.removeEventListener('message',changed);window.removeEventListener('tasks-data',changed);};
  },[user.id]);

  const vault=workspace?.vault,readOnly=Boolean(vault?.membershipRevoked||vault?.role==='viewer');
  const activeProjects=(workspace?.projects??[]).filter(activeItem);
  const archivedProjects=(workspace?.projects??[]).filter(item=>item.lifecycle==='archived');
  const projectById=new Map((workspace?.projects??[]).map(item=>[item.revision.objectId,item]));
  const currentProject=selectedProject?projectById.get(selectedProject):undefined;
  const currentProjectName=selectedProject?(currentProject?.value.title??'Проект'):'Без проекта';
  const itemsForProject=(items:WorkspaceItem[],projectId=selectedProject)=>items.filter(item=>activeItem(item)&&(item.value.projectId??'')===projectId);
  const projectTasks=(projectId:string)=>itemsForProject(workspace?.tasks??[],projectId);
  const projectNotes=(projectId:string)=>itemsForProject(workspace?.notes??[],projectId);
  const progress=(projectId:string)=>{
    const tasks=projectTasks(projectId).filter(item=>taskOf(item).status!=='cancelled'),done=tasks.filter(item=>taskOf(item).status==='done').length;
    return{done,total:tasks.length,percent:tasks.length?Math.round(done/tasks.length*100):0};
  };
  const writableProjects=activeProjects.sort(byTitle);
  const assigneeName=(id:string|undefined)=>{
    if(!id)return'Не назначен';const member=members.find(item=>item.user.id===id);return member?member.user.login:'Участник больше не имеет доступа';
  };
  const dependencyCandidates=(workspace?.tasks??[]).filter(item=>activeItem(item)&&(item.value.projectId??'')===taskProject&&item.revision.objectId!==editingTask).sort(byTitle);
  const successorTasks=editingTask?(workspace?.tasks??[]).filter(item=>activeItem(item)&&item.value.task?.dependencies?.some(dep=>dep.taskId===editingTask)):[];
  function resetProjectForm(){
    setEditingProject('');setProjectTitle('');setProjectDescription('');setProjectStart('');setProjectEnd('');setProjectFavorite(false);setProjectCalendar('calendar');setTemplate('');
  }
  function openProjectForm(item?:WorkspaceItem){
    setError('');setTemplate('');if(item){setEditingProject(item.revision.objectId);setProjectTitle(item.value.title);setProjectDescription(item.value.text);
      setProjectStart(item.value.project?.startDate??'');setProjectEnd(item.value.project?.endDate??'');setProjectFavorite(Boolean(item.value.project?.favorite));setProjectCalendar(item.value.project?.calendar??'calendar');
    }else resetProjectForm();setScreen('project-form');
  }
  function resetTaskForm(projectId=selectedProject){
    setEditingTask('');setTaskTitle('');setTaskDescription('');setTaskProject(projectId);setTaskStatus('todo');setTaskPriority('none');setTaskStart('');setTaskEnd('');
    setTaskAssignee('');setTaskChecklist([]);setTaskTags([]);setTaskDependencies([]);setReminderChoice('none');setReminderLocal('');setExistingReminderId('');
  }
  function openTaskForm(item?:WorkspaceItem,projectId=selectedProject){
    setError('');if(!item){resetTaskForm(projectId);setScreen('task-form');return;}
    const task=item.value.task!;setEditingTask(item.revision.objectId);setTaskTitle(item.value.title);setTaskDescription(item.value.text);setTaskProject(item.value.projectId??'');
    setTaskStatus(task.status);setTaskPriority(task.priority);setTaskStart(task.startDate??'');setTaskEnd(task.endDate??'');setTaskAssignee(task.assigneeUserId??'');
    setTaskChecklist((item.value.checklist??[]).map(x=>({...x})));setTaskTags([...(item.value.tagIds??[])]);setTaskDependencies((task.dependencies??[]).map(dep=>({...dep})));
    setExistingReminderId(item.value.reminder?.id??'');setReminderChoice(task.reminderAnchor??(item.value.reminder?'exact':'none'));setReminderLocal(item.value.reminder?.local??'');setScreen('task-form');
  }
  function reminderPlan():ReminderPlan|undefined{
    if(reminderChoice==='none')return undefined;let local=reminderLocal;
    if(reminderChoice!=='exact'){
      const anchor=reminderChoice.startsWith('start')?taskStart:taskEnd;if(!anchor)throw Error('Для относительного напоминания сначала задайте дату задачи.');
      const shifted=dateShift(anchor,reminderChoice.endsWith('-1d')?-1:0);local=shifted+'T09:00';
    }
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local))throw Error('Укажите дату и время напоминания.');
    return{id:existingReminderId||crypto.randomUUID(),local,mode:'neutral',state:taskStatus==='done'?'done':taskStatus==='cancelled'?'off':'active',text:'',
      repeat:{type:'once'},end:{type:'never'},allDay:false,important:taskPriority==='high'};
  }

  function ganttRows(projectId=selectedProject){
    return projectTasks(projectId).map(item=>({id:item.revision.objectId,title:item.value.title,status:taskOf(item).status,priority:taskOf(item).priority,
      startDate:taskOf(item).startDate,endDate:taskOf(item).endDate,dependencies:taskOf(item).dependencies}));
  }
  function scheduleImpact(projectId:string,change:GanttDateChange,only:()=>Promise<void>,chain:()=>Promise<void>){
    const rows=ganttRows(projectId),calendar=projectById.get(projectId)?.value.project?.calendar??'calendar',calculated=cascadeSchedule(rows,change.id,change.startDate,change.endDate,calendar);
    const related=calculated.changes.length>1||rows.some(row=>row.id===change.id&&(row.dependencies?.length??0)>0)||rows.some(row=>row.dependencies?.some(dep=>dep.taskId===change.id));
    if(!related){void run(only);return false;}
    impactActions.current={only,chain};setImpact({taskId:change.id,changes:calculated.changes,single:change});return true;
  }
  async function applyImpact(mode:'only'|'chain'){
    const actions=impactActions.current;if(!actions)return;setImpact(null);impactActions.current=undefined;
    await run(mode==='chain'?actions.chain:actions.only);
  }

  async function submitProject(ev:Event){
    ev.preventDefault();await run(async()=>{
      if(editingProject){
        await updateProject(user,selectedVault,editingProject,{title:projectTitle,description:projectDescription,favorite:projectFavorite,startDate:projectStart||undefined,endDate:projectEnd||undefined,calendar:projectCalendar});
        setSelectedProject(editingProject);setScreen('project');setStatus('Проект обновлён.');
      }else{
        const created=await createProject(user,selectedVault,{title:projectTitle,description:projectDescription,favorite:projectFavorite,startDate:projectStart||undefined,endDate:projectEnd||undefined,calendar:projectCalendar});
        const tpl=templates.find(item=>item.id===template);if(tpl)for(const title of tpl.tasks)await createTask(user,selectedVault,{title,projectId:created.objectId,status:'todo',priority:'none'});
        setSelectedProject(created.objectId);setTab('overview');setScreen('project');setStatus(tpl?'Проект создан из шаблона.':'Проект создан.');
      }
    });
  }
  async function submitTask(ev:Event){
    ev.preventDefault();setError('');
    try{
      const reminder=reminderPlan(),reminderAnchor:TaskReminderAnchor|null=reminderChoice==='none'||reminderChoice==='exact'?null:reminderChoice;
      const payload={title:taskTitle,description:taskDescription,projectId:cleanProjectId(taskProject),status:taskStatus,priority:taskPriority,startDate:taskStart||undefined,
        endDate:taskEnd||undefined,assigneeUserId:taskAssignee||undefined,checklist:taskChecklist,tagIds:taskTags,reminder,dependencies:taskDependencies,reminderAnchor};
      const finish=()=>{setSelectedProject(taskProject);setTab('tasks');setScreen('project');setStatus(editingTask?'Задача обновлена.':'Задача создана.');};
      if(!editingTask){await run(async()=>{await createTask(user,selectedVault,{...payload,reminderAnchor:reminderAnchor??undefined});finish();});return;}
      const existing=(workspace?.tasks??[]).find(item=>item.revision.objectId===editingTask),before=existing?.value.task;
      if(existing&&(existing.value.projectId??'')!==taskProject&&((before?.dependencies?.length??0)>0||successorTasks.length>0))throw Error('Перед переносом задачи в другой проект удалите её связи с предшественниками и последователями.');
      const saveOnly=async()=>{await updateTask(user,selectedVault,editingTask,payload);finish();};
      const datesChanged=Boolean(before&&(before.startDate??'')!==taskStart||(before&&(before.endDate??'')!==taskEnd));
      if(datesChanged&&existing&&(existing.value.projectId??'')===taskProject){
        const change={id:editingTask,startDate:taskStart||undefined,endDate:taskEnd||undefined};
        const saveChain=async()=>{
          const rows=ganttRows(taskProject),calendar=projectById.get(taskProject)?.value.project?.calendar??'calendar';
          const calculated=cascadeSchedule(rows,editingTask,change.startDate,change.endDate,calendar);
          await updateTask(user,selectedVault,editingTask,payload);
          const rest=calculated.changes.filter(item=>item.id!==editingTask).map(item=>({objectId:item.id,startDate:item.startDate,endDate:item.endDate}));
          if(rest.length)await rescheduleTasks(user,selectedVault,rest);finish();
        };
        scheduleImpact(taskProject,change,saveOnly,saveChain);return;
      }
      await run(saveOnly);
    }catch(caught){setError(caught instanceof Error?caught.message:'Не удалось сохранить задачу');}
  }
  async function chooseVault(vid:string){
    setSelectedVault(vid);setSelectedProject('');setScreen('projects');setTab('overview');setError('');await load(vid);
  }
  const feedback=e('div',null,error&&e('p',{class:'error',role:'alert'},error),status&&e('p',{class:'auth-notice',role:'status'},status));
  const openedVaults=state?.vaults.filter(v=>!v.deleted&&!v.transfer&&Boolean(v.key))??[];
  const taskTitleById=new Map((workspace?.tasks??[]).map(item=>[item.revision.objectId,item.value.title]));
  const reminderShiftCount=impact?.changes.filter(change=>{const item=(workspace?.tasks??[]).find(row=>row.revision.objectId===change.id);return Boolean(item?.value.reminder&&item.value.task?.reminderAnchor);}).length??0;
  const impactNode=impact&&e('div',{class:'modal-backdrop',role:'presentation'},
    e('section',{class:'impact-dialog card',role:'dialog','aria-modal':'true','aria-labelledby':'impact-title'},
      e('p',{class:'eyebrow'},'ВЛИЯНИЕ НА ПЛАН'),e('h2',{id:'impact-title'},'Изменение сроков затрагивает зависимости'),
      e('p',null,'До применения проверьте цепочку. Можно сдвинуть связанные задачи, изменить только выбранную задачу или отменить действие.'),
      e('div',{class:'impact-list'},impact.changes.map(change=>e('div',{key:change.id,class:change.id===impact.taskId?'impact-row primary-impact':'impact-row'},
        e('strong',null,taskTitleById.get(change.id)??'Задача'),
        e('span',null,(change.oldStart??'—')+' — '+(change.oldEnd??'—')+' → '+(change.startDate??'—')+' — '+(change.endDate??'—')),
        change.shiftDays!==0&&e('small',null,(change.shiftDays>0?'+':'')+change.shiftDays+' дн.')))),
      reminderShiftCount>0&&e('p',{class:'hint'},'Привязанные к началу/сроку напоминания будут пересчитаны: '+reminderShiftCount+'.'),
      e('p',{class:'hint'},'Если изменить только выбранную задачу, нарушенные зависимости останутся видимыми как конфликты и их можно будет исправить позже.'),
      e('div',{class:'impact-actions'},
        impact.changes.length>1&&e('button',{class:'primary',disabled:busy,onClick:()=>void applyImpact('chain')},'Сдвинуть цепочку'),
        e('button',{disabled:busy,onClick:()=>void applyImpact('only')},'Только эту задачу'),
        e('button',{disabled:busy,onClick:()=>{impactActions.current=undefined;setImpact(null);}},'Отмена'))));
  if(!openedVaults.length)return e('main',{class:'projects-screen'},
    e(PageHeader,{eyebrow:'Проекты',title:'Проекты',description:'Задачи, сроки и планирование внутри E2EE-хранилищ.'}),
    e('div',{class:'empty-state card'},e(UiIcon,{name:'folder',size:32}),e('h2',null,'Сначала откройте хранилище'),e('p',null,'Проекты принадлежат конкретному E2EE-хранилищу. Откройте его в разделе «Заметки», затем вернитесь сюда.')),feedback);

  if(screen==='project-form')return e('main',{class:'projects-screen'},
    e(PageHeader,{eyebrow:'Проект',title:editingProject?'Редактировать проект':'Новый проект',description:'Название, сроки и правила календаря остаются внутри E2EE-записи.',back:()=>setScreen(editingProject?'project':'projects')}),
    e('section',{class:'card project-form'},
      e('form',{onSubmit:submitProject},
        e('label',null,'Название',e('input',{required:true,maxLength:200,value:projectTitle,onInput:(ev:Event)=>setProjectTitle((ev.target as HTMLInputElement).value)})),
        e('label',null,'Описание',e('textarea',{rows:5,maxLength:10000,value:projectDescription,onInput:(ev:Event)=>setProjectDescription((ev.target as HTMLTextAreaElement).value)})),
        e('div',{class:'project-date-grid'},
          e('label',null,'Дата начала',e('input',{type:'date',value:projectStart,onInput:(ev:Event)=>setProjectStart((ev.target as HTMLInputElement).value)})),
          e('label',null,'Дата окончания',e('input',{type:'date',value:projectEnd,onInput:(ev:Event)=>setProjectEnd((ev.target as HTMLInputElement).value)}))),
        e('label',null,'Календарь планирования',e('select',{value:projectCalendar,onChange:(ev:Event)=>setProjectCalendar((ev.target as HTMLSelectElement).value as GanttCalendar)},
          e('option',{value:'calendar'},'Календарные дни'),e('option',{value:'weekdays'},'Рабочие дни · Пн–Пт'))),
        e('p',{class:'hint'},projectCalendar==='weekdays'?'Каскад зависимостей пропускает субботу и воскресенье. Государственные праздники пока не учитываются.':'Каскад считает каждый календарный день.'),
        e('label',{class:'check-row'},e('input',{type:'checkbox',checked:projectFavorite,onChange:(ev:Event)=>setProjectFavorite((ev.target as HTMLInputElement).checked)}),'Избранный проект'),
        !editingProject&&e('details',{class:'template-picker'},e('summary',null,'Начать с шаблона (необязательно)'),
          e('p',{class:'hint'},'Шаблон только создаст несколько стартовых задач. Его можно не выбирать.'),
          e('select',{value:template,onChange:(ev:Event)=>setTemplate((ev.target as HTMLSelectElement).value)},
            e('option',{value:''},'Пустой проект'),templates.map(item=>e('option',{key:item.id,value:item.id},item.name)))),
        e('button',{class:'primary',disabled:busy},busy?'Сохраняем…':editingProject?'Сохранить':'Создать проект'))),feedback);

  if(screen==='task-form')return e('main',{class:'projects-screen'},
    e(PageHeader,{eyebrow:'Задача',title:editingTask?'Редактировать задачу':'Новая задача',description:'Сроки, статус, зависимости и напоминание задачи.',back:()=>setScreen('project')}),
    e('section',{class:'card task-form'},
      e('form',{onSubmit:submitTask},
        e('label',null,'Название',e('input',{required:true,maxLength:200,value:taskTitle,onInput:(ev:Event)=>setTaskTitle((ev.target as HTMLInputElement).value)})),
        e('label',null,'Описание',e('textarea',{rows:5,maxLength:20000,value:taskDescription,onInput:(ev:Event)=>setTaskDescription((ev.target as HTMLTextAreaElement).value)})),
        e('label',null,'Проект',e('select',{value:taskProject,onChange:(ev:Event)=>{const next=(ev.target as HTMLSelectElement).value;if(next!==taskProject)setTaskDependencies([]);setTaskProject(next);}},
          e('option',{value:''},'Без проекта'),writableProjects.map(item=>e('option',{key:item.revision.objectId,value:item.revision.objectId},item.value.title)))),
        e('div',{class:'project-date-grid'},
          e('label',null,'Статус',e('select',{value:taskStatus,onChange:(ev:Event)=>setTaskStatus((ev.target as HTMLSelectElement).value as TaskStatus)},
            (Object.keys(statusLabel) as TaskStatus[]).map(value=>e('option',{key:value,value},statusLabel[value])))),
          e('label',null,'Приоритет',e('select',{value:taskPriority,onChange:(ev:Event)=>setTaskPriority((ev.target as HTMLSelectElement).value as TaskPriority)},
            (Object.keys(priorityLabel) as TaskPriority[]).map(value=>e('option',{key:value,value},priorityLabel[value]))))),
        e('div',{class:'project-date-grid'},
          e('label',null,'Дата начала',e('input',{type:'date',value:taskStart,onInput:(ev:Event)=>setTaskStart((ev.target as HTMLInputElement).value)})),
          e('label',null,'Срок',e('input',{type:'date',value:taskEnd,onInput:(ev:Event)=>setTaskEnd((ev.target as HTMLInputElement).value)}))),
        vault?.shared&&e('label',null,'Исполнитель',e('select',{value:taskAssignee,onChange:(ev:Event)=>setTaskAssignee((ev.target as HTMLSelectElement).value)},
          e('option',{value:''},'Не назначен'),
          taskAssignee&&!members.some(item=>item.user.id===taskAssignee)&&e('option',{value:taskAssignee},'Участник больше не имеет доступа'),
          members.map(item=>e('option',{key:item.user.id,value:item.user.id},item.user.login+' · '+(item.role==='owner'?'владелец':item.role==='editor'?'редактор':'просмотр'))))),
        e('fieldset',{class:'task-dependencies'},e('legend',null,'Зависимости'),
          e('p',{class:'hint'},'Предшественники хранятся внутри E2EE-задачи. Циклические связи не сохраняются. Положительный лаг добавляет дни после контрольной точки, отрицательный — допускает перекрытие.'),
          taskDependencies.map((dep,index)=>e('div',{class:'dependency-row',key:dep.taskId+'-'+index},
            e('select',{value:dep.taskId,'aria-label':'Предшественник',onChange:(ev:Event)=>setTaskDependencies(current=>current.map((item,i)=>i===index?{...item,taskId:(ev.target as HTMLSelectElement).value}:item))},
              dependencyCandidates.map(item=>e('option',{key:item.revision.objectId,value:item.revision.objectId},item.value.title))),
            e('select',{value:dep.type,'aria-label':'Тип зависимости',onChange:(ev:Event)=>setTaskDependencies(current=>current.map((item,i)=>i===index?{...item,type:(ev.target as HTMLSelectElement).value as TaskDependencyType}:item))},
              (Object.keys(dependencyLabel) as TaskDependencyType[]).map(type=>e('option',{key:type,value:type},dependencyLabel[type]))),
            e('label',{class:'dependency-lag'},'Лаг, дн.',e('input',{type:'number',min:-3650,max:3650,value:String(dep.lagDays),onInput:(ev:Event)=>setTaskDependencies(current=>current.map((item,i)=>i===index?{...item,lagDays:Number((ev.target as HTMLInputElement).value)||0}:item))})),
            e('button',{type:'button',class:'icon-danger',onClick:()=>setTaskDependencies(current=>current.filter((_,i)=>i!==index))},'Удалить'))),
          dependencyCandidates.some(item=>!taskDependencies.some(dep=>dep.taskId===item.revision.objectId))
            ?e('button',{type:'button',onClick:()=>{const candidate=dependencyCandidates.find(item=>!taskDependencies.some(dep=>dep.taskId===item.revision.objectId));if(candidate)setTaskDependencies(current=>[...current,{taskId:candidate.revision.objectId,type:'FS',lagDays:0}]);}},'+ Предшественник')
            :e('p',{class:'muted'},dependencyCandidates.length?'Все доступные задачи уже добавлены.':'В этом проекте пока нет другой задачи для связи.'),
          successorTasks.length>0&&e('div',{class:'dependency-successors'},e('strong',null,'Последователи'),successorTasks.map(item=>e('span',{key:item.revision.objectId},item.value.title)))),

        e('fieldset',{class:'task-checklist'},e('legend',null,'Чек-лист'),
          taskChecklist.map((item,index)=>e('div',{class:'project-check-row',key:item.id},
            e('input',{type:'checkbox',checked:item.done,onChange:(ev:Event)=>setTaskChecklist(current=>current.map(row=>row.id===item.id?{...row,done:(ev.target as HTMLInputElement).checked}:row))}),
            e('input',{value:item.text,maxLength:1000,placeholder:'Пункт чек-листа',onInput:(ev:Event)=>setTaskChecklist(current=>current.map(row=>row.id===item.id?{...row,text:(ev.target as HTMLInputElement).value}:row))}),
            e('button',{type:'button',class:'icon-danger',onClick:()=>setTaskChecklist(current=>current.filter(row=>row.id!==item.id))},'Удалить'))),
          e('button',{type:'button',onClick:()=>setTaskChecklist(current=>[...current,{id:crypto.randomUUID(),text:'',done:false}])},'+ Пункт')),
        tags.length>0&&e('fieldset',null,e('legend',null,'Теги'),
          e('div',{class:'tag-filter'},tags.map(tag=>e('label',{class:'tag-choice',key:tag.id,style:{'--tag-color':tag.color}},
            e('input',{type:'checkbox',checked:taskTags.includes(tag.id),onChange:(ev:Event)=>setTaskTags(current=>(ev.target as HTMLInputElement).checked?[...current,tag.id]:current.filter(id=>id!==tag.id))}),tag.name)))),
        e('fieldset',null,e('legend',null,'Напоминание'),
          e('label',null,'Когда напомнить',e('select',{value:reminderChoice,onChange:(ev:Event)=>setReminderChoice((ev.target as HTMLSelectElement).value as ReminderChoice)},
            e('option',{value:'none'},'Без напоминания'),e('option',{value:'exact'},'Точная дата и время'),
            e('option',{value:'start'},'В день начала · 09:00'),e('option',{value:'start-1d'},'За день до начала · 09:00'),
            e('option',{value:'end'},'В день срока · 09:00'),e('option',{value:'end-1d'},'За день до срока · 09:00'))),
          reminderChoice==='exact'&&e('label',null,'Дата и время',e('input',{type:'datetime-local',value:reminderLocal,onInput:(ev:Event)=>setReminderLocal((ev.target as HTMLInputElement).value)})),
          reminderChoice!=='none'&&reminderChoice!=='exact'&&e('p',{class:'hint'},'Напоминание остаётся привязанным к началу или сроку задачи. При подтверждённом каскаде Ганта его дата пересчитывается автоматически.')),
        e('button',{class:'primary',disabled:busy||readOnly},busy?'Сохраняем…':editingTask?'Сохранить задачу':'Создать задачу'))),feedback,impactNode);


  if(screen==='project'){
    if(selectedProject&&(!currentProject||currentProject.lifecycle==='trashed')){
      setTimeout(()=>setScreen('projects'),0);
      return e('main',{class:'projects-screen'},'Проект больше не доступен.');
    }
    const tasks=itemsForProject(workspace?.tasks??[]),notes=itemsForProject(workspace?.notes??[]);
    const visibleTasks=tasks.filter(item=>{
      const task=taskOf(item);
      if(taskFilter==='active')return task.status==='todo'||task.status==='in_progress';
      if(taskFilter==='done')return task.status==='done';
      if(taskFilter==='cancelled')return task.status==='cancelled';
      if(taskFilter==='unscheduled')return !task.startDate&&!task.endDate;
      return true;
    }).sort((a,b)=>(taskOf(a).endDate??'9999-99-99').localeCompare(taskOf(b).endDate??'9999-99-99')||byTitle(a,b));
    const p=selectedProject?progress(selectedProject):progress('');
    const files=[...notes,...tasks].flatMap(item=>(item.value.attachments??[]).map(file=>({file,owner:item.value.title,objectId:item.revision.objectId})));
    const overviewNode=selectedProject&&tab==='overview'?e('div',{class:'project-overview'},
      e('div',{class:'project-summary-grid'},
        e('div',null,e('strong',null,String(tasks.filter(item=>taskOf(item).status==='in_progress').length)),e('span',null,'В работе')),
        e('div',null,e('strong',null,String(tasks.filter(item=>taskOf(item).status==='done').length)),e('span',null,'Выполнено')),
        e('div',null,e('strong',null,String(notes.length)),e('span',null,'Заметок')),
        e('div',null,e('strong',null,String(files.length)),e('span',null,'Файлов'))),
      e('h2',null,'Ближайшие задачи'),
      !tasks.some(item=>!['done','cancelled'].includes(taskOf(item).status))&&e('p',{class:'muted'},'Активных задач нет.'),
      tasks.filter(item=>!['done','cancelled'].includes(taskOf(item).status))
        .sort((a,b)=>(taskOf(a).endDate??'9999').localeCompare(taskOf(b).endDate??'9999')).slice(0,5)
        .map(item=>e('button',{class:'note-row',key:item.revision.objectId,onClick:()=>openTaskForm(item)},
          e('strong',null,item.value.title),
          e('small',null,statusLabel[taskOf(item).status]+' · '+priorityLabel[taskOf(item).priority]+(taskOf(item).endDate?' · до '+taskOf(item).endDate:'')))))
      :null;
    const tasksNode=tab==='tasks'?e('div',{class:'project-task-list'},
      e('div',{class:'section-heading'},e('h2',null,'Задачи'),
        e('div',{class:'task-view-switch'},e('button',{class:taskView==='list'?'filter-chip selected':'filter-chip',onClick:()=>setTaskView('list')},'Список'),e('button',{class:taskView==='gantt'?'filter-chip selected':'filter-chip',onClick:()=>setTaskView('gantt')},'Гант')),
        !readOnly&&e('button',{class:'primary',onClick:()=>openTaskForm(undefined,selectedProject)},'+ Задача')),
      taskView==='list'&&e('div',{class:'quick-filters'},([['all','Все'],['active','Активные'],['done','Завершённые'],['cancelled','Отменённые'],['unscheduled','Без срока']] as const)
        .map(([value,label])=>e('button',{class:taskFilter===value?'filter-chip selected':'filter-chip',onClick:()=>setTaskFilter(value)},label))),
      taskView==='list'&&!visibleTasks.length&&e('p',{class:'muted'},'Нет задач по выбранному фильтру.'),
      taskView==='list'&&visibleTasks.map(item=>{
        const task=taskOf(item);
        return e('article',{class:'task-row',key:item.revision.objectId},
          e('button',{class:'task-main',onClick:()=>openTaskForm(item)},
            e('strong',null,item.value.title),
            e('small',null,statusLabel[task.status]+' · '+priorityLabel[task.priority]+(task.endDate?' · срок '+task.endDate:' · без срока')),
            task.assigneeUserId&&e('small',null,'Исполнитель: '+assigneeName(task.assigneeUserId)),
            item.value.checklist?.length&&e('small',null,'Чек-лист: '+item.value.checklist.filter(x=>x.done).length+' / '+item.value.checklist.length)),
          !readOnly&&e('select',{value:task.status,'aria-label':'Статус задачи',onChange:(ev:Event)=>void run(async()=>{
            const next=(ev.target as HTMLSelectElement).value as TaskStatus;
            const reminder=item.value.reminder?{...item.value.reminder,state:next==='done'?'done':next==='cancelled'?'off':item.value.reminder.state}:undefined;
            await updateTask(user,selectedVault,item.revision.objectId,{
              title:item.value.title,description:item.value.text,projectId:item.value.projectId,status:next,priority:task.priority,
              startDate:task.startDate,endDate:task.endDate,assigneeUserId:task.assigneeUserId,
              checklist:item.value.checklist,tagIds:item.value.tagIds,reminder
            });
          })},(Object.keys(statusLabel) as TaskStatus[]).map(value=>e('option',{key:value,value},statusLabel[value]))));
      }),
      taskView==='gantt'&&e(GanttView,{rows:ganttRows(selectedProject),calendar:currentProject?.value.project?.calendar??'calendar',readOnly,
        onOpen:(id:string)=>{const item=tasks.find(row=>row.revision.objectId===id);if(item)openTaskForm(item);},
        onRequestDates:(change:GanttDateChange)=>{
          const only=async()=>{await rescheduleTasks(user,selectedVault,[{objectId:change.id,startDate:change.startDate,endDate:change.endDate}]);setStatus('Срок задачи изменён.');};
          const chain=async()=>{const rows=ganttRows(selectedProject),calendar=currentProject?.value.project?.calendar??'calendar',calculated=cascadeSchedule(rows,change.id,change.startDate,change.endDate,calendar);
            await rescheduleTasks(user,selectedVault,calculated.changes.map(item=>({objectId:item.id,startDate:item.startDate,endDate:item.endDate})));setStatus('Сроки цепочки зависимостей изменены.');};
          scheduleImpact(selectedProject,change,only,chain);
        }})
      )
      :null;
    const notesNode=tab==='notes'?e('div',{class:'project-note-list'},
      e('div',{class:'section-heading'},e('h2',null,'Заметки проекта'),
        e('span',{class:'muted'},'Перемещение остаётся внутри этого E2EE-хранилища.')),
      !notes.length&&e('p',{class:'muted'},'В проекте пока нет заметок.'),
      notes.map(item=>e('article',{class:'note-row',key:item.revision.objectId},
        e('strong',null,item.value.title||'Без заголовка'),
        e('span',{class:'note-preview'},item.value.text.slice(0,140)),
        !readOnly&&e('label',null,'Проект',
          e('select',{value:item.value.projectId??'',onChange:(ev:Event)=>void run(async()=>{
            await movePlannerObject(user,selectedVault,item.revision.objectId,(ev.target as HTMLSelectElement).value||undefined);
          })},
            e('option',{value:''},'Без проекта'),
            writableProjects.map(project=>e('option',{key:project.revision.objectId,value:project.revision.objectId},project.value.title)))))),
      !readOnly&&selectedProject&&e('details',{class:'project-add-existing'},
        e('summary',null,'Добавить существующую заметку'),
        projectNotes('').length
          ?projectNotes('').map(item=>e('button',{class:'note-row',key:item.revision.objectId,onClick:()=>void run(async()=>{
              await movePlannerObject(user,selectedVault,item.revision.objectId,selectedProject);
            })},e('strong',null,item.value.title||'Без заголовка'),e('small',null,'Переместить в «'+currentProjectName+'»')))
          :e('p',{class:'muted'},'Заметок без проекта нет.')))
      :null;
    const filesNode=tab==='files'?e('div',{class:'project-files'},
      e('h2',null,'Файлы'),
      e('p',{class:'hint'},'Stage 17 агрегирует существующие малые вложения. Потоковая загрузка и file manager относятся к Stage 18.'),
      !files.length&&e('p',{class:'muted'},'В этом проекте пока нет вложений.'),
      files.map(({file,owner,objectId})=>e('article',{class:'attachment-card',key:objectId+'.'+file.id},
        file.type.startsWith('image/')&&e('img',{src:file.data,alt:''}),
        e('div',null,e('strong',null,file.name),e('small',null,owner+' · '+Math.ceil(file.size/1024)+' КБ')),
        e('a',{href:file.data,download:file.name},'Сохранить'))))
      :null;
    const actionsNode=selectedProject&&currentProject?e('div',{class:'project-actions'},
      !readOnly&&e('button',{onClick:()=>openProjectForm(currentProject)},'Редактировать проект'),
      !readOnly&&e('button',{onClick:()=>void run(async()=>{
        await setProjectArchived(user,selectedVault,selectedProject,currentProject.lifecycle!=='archived');
        setScreen('projects');setSelectedProject('');
      })},currentProject.lifecycle==='archived'?'Вернуть из архива':'Архивировать'),
      !readOnly&&(!vault?.shared||vault.role==='owner')&&e('button',{class:'danger-button',onClick:()=>{
        if(confirm('Удалить проект «'+currentProject.value.title+'»? Заметки и задачи останутся и перейдут в «Без проекта».'))void run(async()=>{
          await deleteProject(user,selectedVault,selectedProject,false);setScreen('projects');setSelectedProject('');
        });
      }},'Удалить проект'),
      !readOnly&&(!vault?.shared||vault.role==='owner')&&e('button',{class:'danger-button',onClick:()=>{
        if(confirm('Удалить проект «'+currentProject.value.title+'» ВМЕСТЕ со всеми его заметками, задачами и вложениями? После синхронизации восстановить их средствами приложения будет невозможно.'))void run(async()=>{
          await deleteProject(user,selectedVault,selectedProject,true);setScreen('projects');setSelectedProject('');
        });
      }},'Удалить проект со всем содержимым'))
      :null;
    return e('main',{class:'projects-screen'},
      e(PageHeader,{eyebrow:selectedProject?'Проект':'Системная группа',title:currentProjectName,
        description:selectedProject?'Рабочее пространство проекта: задачи, заметки, файлы и сроки.':'Заметки и задачи без привязки к проекту.',
        back:()=>{setScreen('projects');setSelectedProject('');},
        actions:e('button',{class:'tertiary-button',disabled:busy,onClick:()=>void load()},e(UiIcon,{name:'sync',size:17}),'Обновить')}),
      e('section',{class:'card project-card-detail'},
        selectedProject&&currentProject?.value.project?.favorite&&e('span',{class:'badge accent project-favorite'},'★ Избранное'),
        selectedProject&&e('div',{class:'project-progress'},
          e('div',{class:'project-progress-track'},e('span',{style:{width:p.percent+'%'}})),
          e('small',null,p.percent+'% · '+p.done+' / '+p.total+' задач')),
        selectedProject&&currentProject&&e('div',{class:'project-meta'},
          (currentProject.value.project?.startDate||currentProject.value.project?.endDate)&&e('p',null,
            currentProject.value.project?.startDate?'Начало: '+new Date(currentProject.value.project.startDate+'T00:00:00Z').toLocaleDateString('ru-RU'):'',
            currentProject.value.project?.startDate&&currentProject.value.project?.endDate?' · ':'',
            currentProject.value.project?.endDate?'Срок: '+new Date(currentProject.value.project.endDate+'T00:00:00Z').toLocaleDateString('ru-RU'):''),
          currentProject.value.text&&e('p',{class:'note-preview'},currentProject.value.text)),
        !selectedProject&&e('p',{class:'hint'},'Заметки и задачи без привязки к проекту. Это виртуальная группа без отдельного project record.'),
        e('nav',{class:'project-tabs','aria-label':'Раздел проекта'},
          selectedProject&&e('button',{class:tab==='overview'?'filter-chip selected':'filter-chip',onClick:()=>setTab('overview')},'Обзор'),
          e('button',{class:tab==='tasks'?'filter-chip selected':'filter-chip',onClick:()=>setTab('tasks')},'Задачи ('+tasks.length+')'),
          e('button',{class:tab==='notes'?'filter-chip selected':'filter-chip',onClick:()=>setTab('notes')},'Заметки ('+notes.length+')'),
          e('button',{class:tab==='files'?'filter-chip selected':'filter-chip',onClick:()=>setTab('files')},'Файлы ('+files.length+')')),
        overviewNode,tasksNode,notesNode,filesNode,actionsNode,
        workspace?.conflicts.length?e('p',{class:'error'},'Есть конфликтующие версии объектов: '+workspace.conflicts.length+'. Разрешите их перед редактированием.'):null,
        feedback),impactNode);
  }

  const normalized=query.trim().toLocaleLowerCase('ru');
  const source=projectFilter==='archive'?archivedProjects:projectFilter==='all'?[...activeProjects,...archivedProjects]:activeProjects;
  const filtered=source.filter(item=>projectFilter!=='favorite'||Boolean(item.value.project?.favorite))
    .filter(item=>!normalized||item.value.title.toLocaleLowerCase('ru').includes(normalized)||item.value.text.toLocaleLowerCase('ru').includes(normalized))
    .sort((a,b)=>Number(Boolean(b.value.project?.favorite))-Number(Boolean(a.value.project?.favorite))||byTitle(a,b));
  const unassignedTasks=projectTasks(''),unassignedNotes=projectNotes('');
  return e('main',{class:'projects-screen'},
    e(PageHeader,{eyebrow:'Workspace',title:'Проекты',description:'Организуйте задачи и заметки внутри выбранного E2EE-хранилища.',
      actions:!readOnly?e('button',{class:'primary',onClick:()=>openProjectForm()},e(UiIcon,{name:'plus',size:17}),'Новый проект'):undefined}),
    e('section',{class:'projects-toolbar card'},
      e('label',{class:'vault-project-selector'},e('span',null,'Хранилище'),e('select',{value:selectedVault,onChange:(ev:Event)=>void chooseVault((ev.target as HTMLSelectElement).value)},
        openedVaults.map(v=>e('option',{key:v.header.id,value:v.header.id},names[v.header.id]||'Хранилище')))),
      vault?.shared&&e('p',{class:'hint'},'Совместное хранилище · роль: '+(vault.role==='owner'?'владелец':vault.role==='editor'?'редактор':'просмотр')+
        '. Названия, статусы, сроки, исполнители и project links остаются внутри E2EE ciphertext.'),
      e('div',{class:'organization-tools'},e('label',{class:'search-field'},'Поиск проектов',e('input',{type:'search',value:query,placeholder:'Название или описание',onInput:(ev:Event)=>setQuery((ev.target as HTMLInputElement).value)})),
        e('label',null,'Показывать',e('select',{value:projectFilter,onChange:(ev:Event)=>setProjectFilter((ev.target as HTMLSelectElement).value as ProjectFilter)},
          e('option',{value:'active'},'Активные'),e('option',{value:'all'},'Все'),e('option',{value:'favorite'},'Избранные'),e('option',{value:'archive'},'Архив')))),
      e('div',{class:'section-heading'},e('div',null,e('h2',null,'Проекты'),e('p',{class:'muted'},filtered.length+' '+(filtered.length===1?'проект':'проектов')))),
      e('button',{class:'project-list-card unassigned',onClick:()=>{setSelectedProject('');setTab('tasks');setScreen('project');}},
        e('strong',null,'Без проекта'),e('small',null,unassignedNotes.length+' заметок · '+unassignedTasks.length+' задач')),
      !filtered.length&&e('div',{class:'empty-state'},e('h2',null,normalized?'Ничего не найдено':projectFilter==='archive'?'Архив проектов пуст':'Проектов пока нет'),
        e('p',null,normalized?'Измените запрос.':'Создайте проект или продолжайте использовать группу «Без проекта».')),
      filtered.map(item=>{const p=progress(item.revision.objectId),taskCount=projectTasks(item.revision.objectId).length,noteCount=projectNotes(item.revision.objectId).length;return e('button',{
          class:'project-list-card'+(item.lifecycle==='archived'?' archived':''),key:item.revision.objectId,onClick:()=>{setSelectedProject(item.revision.objectId);setTab('overview');setScreen('project');}},
        e('div',{class:'section-heading'},e('strong',null,(item.value.project?.favorite?'★ ':'')+item.value.title),item.lifecycle==='archived'&&e('span',{class:'badge'},'Архив')),
        item.value.text&&e('span',{class:'note-preview'},item.value.text.slice(0,160)),
        e('div',{class:'project-progress'},e('div',{class:'project-progress-track'},e('span',{style:{width:p.percent+'%'}})),e('small',null,p.percent+'% · '+p.done+' / '+p.total)),
        e('small',null,noteCount+' заметок · '+taskCount+' задач'+(item.value.project?.endDate?' · срок '+item.value.project.endDate:'')));}),
      workspace?.conflicts.length?e('p',{class:'error'},'Не показано конфликтующих объектов: '+workspace.conflicts.length+'. Разрешите их в разделе «Заметки».'):null,
      feedback));
}
