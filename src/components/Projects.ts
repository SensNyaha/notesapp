import { h as e } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { User } from '../types/auth.ts';
import { changes, readState, type State } from '../storage.ts';
import {
  createProject,createTask,deleteProject,entityKind,movePlannerObject,readProjectWorkspace,readTags,setProjectArchived,synchronize,
  updateProject,updateTask,vaultName,type ChecklistItem,type Note,type ProjectWorkspace,type TagDefinition,type TaskPriority,type TaskStatus,type WorkspaceItem
} from '../planner.ts';
import { sharedVaultMembers,type VaultMemberInfo } from '../collaboration.ts';
import type { ReminderPlan } from '../../shared/reminders.mjs';

type ProjectFilter='active'|'all'|'favorite'|'archive';
type ProjectTab='overview'|'tasks'|'notes'|'files';
type TaskFilter='all'|'active'|'done'|'cancelled'|'unscheduled';
type ReminderChoice='none'|'exact'|'start'|'start-1d'|'end'|'end-1d';
const templates=[
  {id:'work',name:'Рабочий проект',tasks:['Определить результат','Подготовить план','Проверить итог']},
  {id:'study',name:'Обучение',tasks:['Собрать материалы','Изучить основной блок','Повторить и закрепить']},
  {id:'home',name:'Дом и быт',tasks:['Составить список','Купить необходимое','Выполнить работы']},
  {id:'travel',name:'Путешествие',tasks:['Проверить документы','Забронировать дорогу и жильё','Составить маршрут']},
  {id:'event',name:'Мероприятие',tasks:['Определить формат и дату','Подготовить список участников','Проверить готовность']},
] as const;
const statusLabel:Record<TaskStatus,string>={todo:'К выполнению',in_progress:'В работе',done:'Выполнено',cancelled:'Отменено'};
const priorityLabel:Record<TaskPriority,string>={none:'Без приоритета',low:'Низкий',medium:'Средний',high:'Высокий'};
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
  const [template,setTemplate]=useState('');
  const [editingTask,setEditingTask]=useState('');
  const [taskTitle,setTaskTitle]=useState(''),[taskDescription,setTaskDescription]=useState('');
  const [taskProject,setTaskProject]=useState(''),[taskStatus,setTaskStatus]=useState<TaskStatus>('todo'),[taskPriority,setTaskPriority]=useState<TaskPriority>('none');
  const [taskStart,setTaskStart]=useState(''),[taskEnd,setTaskEnd]=useState(''),[taskAssignee,setTaskAssignee]=useState('');
  const [taskChecklist,setTaskChecklist]=useState<ChecklistItem[]>([]),[taskTags,setTaskTags]=useState<string[]>([]);
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
  function resetProjectForm(){
    setEditingProject('');setProjectTitle('');setProjectDescription('');setProjectStart('');setProjectEnd('');setProjectFavorite(false);setTemplate('');
  }
  function openProjectForm(item?:WorkspaceItem){
    setError('');setTemplate('');if(item){setEditingProject(item.revision.objectId);setProjectTitle(item.value.title);setProjectDescription(item.value.text);
      setProjectStart(item.value.project?.startDate??'');setProjectEnd(item.value.project?.endDate??'');setProjectFavorite(Boolean(item.value.project?.favorite));
    }else resetProjectForm();setScreen('project-form');
  }
  function resetTaskForm(projectId=selectedProject){
    setEditingTask('');setTaskTitle('');setTaskDescription('');setTaskProject(projectId);setTaskStatus('todo');setTaskPriority('none');setTaskStart('');setTaskEnd('');
    setTaskAssignee('');setTaskChecklist([]);setTaskTags([]);setReminderChoice('none');setReminderLocal('');setExistingReminderId('');
  }
  function openTaskForm(item?:WorkspaceItem,projectId=selectedProject){
    setError('');if(!item){resetTaskForm(projectId);setScreen('task-form');return;}
    const task=item.value.task!;setEditingTask(item.revision.objectId);setTaskTitle(item.value.title);setTaskDescription(item.value.text);setTaskProject(item.value.projectId??'');
    setTaskStatus(task.status);setTaskPriority(task.priority);setTaskStart(task.startDate??'');setTaskEnd(task.endDate??'');setTaskAssignee(task.assigneeUserId??'');
    setTaskChecklist((item.value.checklist??[]).map(x=>({...x})));setTaskTags([...(item.value.tagIds??[])]);
    setExistingReminderId(item.value.reminder?.id??'');setReminderChoice(item.value.reminder?'exact':'none');setReminderLocal(item.value.reminder?.local??'');setScreen('task-form');
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

  async function submitProject(ev:Event){
    ev.preventDefault();await run(async()=>{
      if(editingProject){
        await updateProject(user,selectedVault,editingProject,{title:projectTitle,description:projectDescription,favorite:projectFavorite,startDate:projectStart||undefined,endDate:projectEnd||undefined});
        setSelectedProject(editingProject);setScreen('project');setStatus('Проект обновлён.');
      }else{
        const created=await createProject(user,selectedVault,{title:projectTitle,description:projectDescription,favorite:projectFavorite,startDate:projectStart||undefined,endDate:projectEnd||undefined});
        const tpl=templates.find(item=>item.id===template);if(tpl)for(const title of tpl.tasks)await createTask(user,selectedVault,{title,projectId:created.objectId,status:'todo',priority:'none'});
        setSelectedProject(created.objectId);setTab('overview');setScreen('project');setStatus(tpl?'Проект создан из шаблона.':'Проект создан.');
      }
    });
  }
  async function submitTask(ev:Event){
    ev.preventDefault();const reminder=reminderPlan();await run(async()=>{
      const payload={title:taskTitle,description:taskDescription,projectId:cleanProjectId(taskProject),status:taskStatus,priority:taskPriority,startDate:taskStart||undefined,
        endDate:taskEnd||undefined,assigneeUserId:taskAssignee||undefined,checklist:taskChecklist,tagIds:taskTags,reminder};
      if(editingTask)await updateTask(user,selectedVault,editingTask,payload);else await createTask(user,selectedVault,payload);
      setSelectedProject(taskProject);setTab('tasks');setScreen('project');setStatus(editingTask?'Задача обновлена.':'Задача создана.');
    });
  }
  async function chooseVault(vid:string){
    setSelectedVault(vid);setSelectedProject('');setScreen('projects');setTab('overview');setError('');await load(vid);
  }
  const feedback=e('div',null,error&&e('p',{class:'error',role:'alert'},error),status&&e('p',{class:'auth-notice',role:'status'},status));
  const openedVaults=state?.vaults.filter(v=>!v.deleted&&!v.transfer&&Boolean(v.key))??[];
  if(!openedVaults.length)return e('main',{class:'projects-screen'},e('button',{onClick:onBack},'← К заметкам'),e('h1',null,'Проекты'),
    e('div',{class:'empty-state card'},e('h2',null,'Нет открытого хранилища'),e('p',null,'Откройте нужное E2EE-хранилище в разделе «Заметки», затем вернитесь в проекты.')),feedback);

  if(screen==='project-form')return e('main',{class:'projects-screen'},
    e('button',{disabled:busy,onClick:()=>setScreen(editingProject?'project':'projects')},'← Назад'),
    e('section',{class:'card project-form'},e('h1',null,editingProject?'Редактировать проект':'Новый проект'),
      e('form',{onSubmit:submitProject},
        e('label',null,'Название',e('input',{required:true,maxLength:200,value:projectTitle,onInput:(ev:Event)=>setProjectTitle((ev.target as HTMLInputElement).value)})),
        e('label',null,'Описание',e('textarea',{rows:5,maxLength:10000,value:projectDescription,onInput:(ev:Event)=>setProjectDescription((ev.target as HTMLTextAreaElement).value)})),
        e('div',{class:'project-date-grid'},
          e('label',null,'Дата начала',e('input',{type:'date',value:projectStart,onInput:(ev:Event)=>setProjectStart((ev.target as HTMLInputElement).value)})),
          e('label',null,'Дата окончания',e('input',{type:'date',value:projectEnd,onInput:(ev:Event)=>setProjectEnd((ev.target as HTMLInputElement).value)}))),
        e('label',{class:'check-row'},e('input',{type:'checkbox',checked:projectFavorite,onChange:(ev:Event)=>setProjectFavorite((ev.target as HTMLInputElement).checked)}),'Избранный проект'),
        !editingProject&&e('details',{class:'template-picker'},e('summary',null,'Начать с шаблона (необязательно)'),
          e('p',{class:'hint'},'Шаблон только создаст несколько стартовых задач. Его можно не выбирать.'),
          e('select',{value:template,onChange:(ev:Event)=>setTemplate((ev.target as HTMLSelectElement).value)},
            e('option',{value:''},'Пустой проект'),templates.map(item=>e('option',{key:item.id,value:item.id},item.name)))),
        e('button',{class:'primary',disabled:busy},busy?'Сохраняем…':editingProject?'Сохранить':'Создать проект'))),feedback);

  if(screen==='task-form')return e('main',{class:'projects-screen'},
    e('button',{disabled:busy,onClick:()=>setScreen('project')},'← Назад'),
    e('section',{class:'card task-form'},e('h1',null,editingTask?'Редактировать задачу':'Новая задача'),
      e('form',{onSubmit:submitTask},
        e('label',null,'Название',e('input',{required:true,maxLength:200,value:taskTitle,onInput:(ev:Event)=>setTaskTitle((ev.target as HTMLInputElement).value)})),
        e('label',null,'Описание',e('textarea',{rows:5,maxLength:20000,value:taskDescription,onInput:(ev:Event)=>setTaskDescription((ev.target as HTMLTextAreaElement).value)})),
        e('label',null,'Проект',e('select',{value:taskProject,onChange:(ev:Event)=>setTaskProject((ev.target as HTMLSelectElement).value)},
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
          reminderChoice!=='none'&&reminderChoice!=='exact'&&e('p',{class:'hint'},'Stage 17 вычисляет абсолютное время при сохранении. Автоматический каскад при переносе сроков появится вместе с зависимостями и Гантом.')),
        e('button',{class:'primary',disabled:busy||readOnly},busy?'Сохраняем…':editingTask?'Сохранить задачу':'Создать задачу'))),feedback);


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
      e('div',{class:'section-heading'},e('h2',null,'Задачи'),!readOnly&&e('button',{class:'primary',onClick:()=>openTaskForm(undefined,selectedProject)},'+ Задача')),
      e('div',{class:'quick-filters'},([['all','Все'],['active','Активные'],['done','Завершённые'],['cancelled','Отменённые'],['unscheduled','Без срока']] as const)
        .map(([value,label])=>e('button',{class:taskFilter===value?'filter-chip selected':'filter-chip',onClick:()=>setTaskFilter(value)},label))),
      !visibleTasks.length&&e('p',{class:'muted'},'Нет задач по выбранному фильтру.'),
      visibleTasks.map(item=>{
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
      }))
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
      e('div',{class:'card-heading'},
        e('button',{disabled:busy,onClick:()=>{setScreen('projects');setSelectedProject('');}},'← Проекты'),
        e('button',{disabled:busy,onClick:()=>void load()},'Обновить')),
      e('section',{class:'card project-card-detail'},
        e('div',{class:'card-heading'},
          e('div',null,e('p',{class:'eyebrow'},selectedProject?'ПРОЕКТ':'СИСТЕМНАЯ ГРУППА'),e('h1',null,currentProjectName)),
          selectedProject&&currentProject?.value.project?.favorite&&e('span',{class:'project-favorite'},'★ Избранное')),
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
        feedback));
  }

  const normalized=query.trim().toLocaleLowerCase('ru');
  const source=projectFilter==='archive'?archivedProjects:projectFilter==='all'?[...activeProjects,...archivedProjects]:activeProjects;
  const filtered=source.filter(item=>projectFilter!=='favorite'||Boolean(item.value.project?.favorite))
    .filter(item=>!normalized||item.value.title.toLocaleLowerCase('ru').includes(normalized)||item.value.text.toLocaleLowerCase('ru').includes(normalized))
    .sort((a,b)=>Number(Boolean(b.value.project?.favorite))-Number(Boolean(a.value.project?.favorite))||byTitle(a,b));
  const unassignedTasks=projectTasks(''),unassignedNotes=projectNotes('');
  return e('main',{class:'projects-screen'},
    e('div',{class:'card-heading'},e('button',{onClick:onBack},'← К заметкам'),e('h1',null,'Проекты'),e('button',{disabled:busy,onClick:()=>void run(async()=>{})},'Синхронизировать')),
    e('section',{class:'card'},
      e('label',null,'Хранилище',e('select',{value:selectedVault,onChange:(ev:Event)=>void chooseVault((ev.target as HTMLSelectElement).value)},
        openedVaults.map(v=>e('option',{key:v.header.id,value:v.header.id},names[v.header.id]||'Хранилище')))),
      vault?.shared&&e('p',{class:'hint'},'Совместное хранилище · роль: '+(vault.role==='owner'?'владелец':vault.role==='editor'?'редактор':'просмотр')+
        '. Названия, статусы, сроки, исполнители и project links остаются внутри E2EE ciphertext.'),
      e('div',{class:'organization-tools'},e('label',{class:'search-field'},'Поиск проектов',e('input',{type:'search',value:query,placeholder:'Название или описание',onInput:(ev:Event)=>setQuery((ev.target as HTMLInputElement).value)})),
        e('label',null,'Показывать',e('select',{value:projectFilter,onChange:(ev:Event)=>setProjectFilter((ev.target as HTMLSelectElement).value as ProjectFilter)},
          e('option',{value:'active'},'Активные'),e('option',{value:'all'},'Все'),e('option',{value:'favorite'},'Избранные'),e('option',{value:'archive'},'Архив')))),
      e('div',{class:'section-heading'},e('h2',null,'Проекты внутри хранилища'),!readOnly&&e('button',{class:'primary',onClick:()=>openProjectForm()},'+ Проект')),
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
