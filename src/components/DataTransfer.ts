import { h } from 'preact';
import { useEffect,useState } from 'preact/hooks';
import type { User } from '../types/auth';
import { readState,changes } from '../storage';
import { exportVaultSnapshot,importVaultSnapshot,importPortableNote,noteImportIsDuplicate,validateVaultSnapshot,vaultName,synchronize,type PortableVaultSnapshot } from '../planner';
import { backupFileName,decryptVaultBackup,downloadBytes,encryptVaultBackup,parseNoteImportFile,type PortableNotePackage } from '../portable';
import { InfoTip,PageHeader,UiIcon } from './ui.ts';

const e=h;
interface VaultChoice{id:string;name:string;open:boolean}

export function DataTransfer({user,onBack}:{user:User;onBack:()=>void}){
  const [vaults,setVaults]=useState<VaultChoice[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  const [exportVault,setExportVault]=useState(''),[backupPassword,setBackupPassword]=useState(''),[backupRepeat,setBackupRepeat]=useState('');
  const [backupFile,setBackupFile]=useState<File>(),[restorePassword,setRestorePassword]=useState('');
  const [backupPreview,setBackupPreview]=useState<PortableVaultSnapshot>(),[restoreName,setRestoreName]=useState('');
  const [restorePhrase,setRestorePhrase]=useState(''),[restoreRepeat,setRestoreRepeat]=useState('');
  const [noteTarget,setNoteTarget]=useState(''),[noteFile,setNoteFile]=useState<File>(),[notePreview,setNotePreview]=useState<PortableNotePackage>();
  const [noteDuplicate,setNoteDuplicate]=useState(false),[duplicatePolicy,setDuplicatePolicy]=useState<'skip'|'copy'>('skip');

  async function refresh(){
    const state=await readState(user.id),next:VaultChoice[]=[];
    for(const vault of state?.vaults??[])if(!vault.deleted)next.push({id:vault.header.id,name:await vaultName(user.id,vault),open:Boolean(vault.key)});
    setVaults(next);const opened=next.find(item=>item.open)?.id??'';
    setExportVault(current=>next.some(item=>item.id===current&&item.open)?current:opened);
    setNoteTarget(current=>next.some(item=>item.id===current&&item.open)?current:opened);
  }
  useEffect(()=>{void refresh();const changed=()=>void refresh();changes?.addEventListener('message',changed);window.addEventListener('tasks-data',changed);return()=>{changes?.removeEventListener('message',changed);window.removeEventListener('tasks-data',changed);};},[user.id]);
  useEffect(()=>()=>{if(notePreview?.cleanup)void notePreview.cleanup();},[notePreview]);
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setStatus('');try{await fn();await refresh();}catch(caught){setError(caught instanceof Error?caught.message:'Не удалось выполнить операцию');}finally{setBusy(false);}}

  const opened=vaults.filter(item=>item.open);
  const backupObjects=backupPreview?new Set(backupPreview.revisions.map(item=>item.objectId)):new Set<string>();
  const backupHeads=backupPreview?backupPreview.revisions.filter(item=>!backupPreview.revisions.some(other=>other.parent===item.revisionId||other.resolves.includes(item.revisionId))):[];
  const backupReminders=new Set(backupHeads.filter(item=>item.note.reminder).map(item=>item.objectId)).size;

  async function exportBackup(){
    if(!exportVault)throw Error('Выберите открытое хранилище.');
    if(backupPassword!==backupRepeat)throw Error('Пароль резервной копии и повтор не совпадают.');
    const snapshot=await exportVaultSnapshot(user,exportVault),bytes=await encryptVaultBackup(snapshot,backupPassword);
    downloadBytes(bytes,backupFileName(snapshot.name));setBackupPassword('');setBackupRepeat('');
    setStatus('Зашифрованная резервная копия создана. Храните пароль отдельно от файла.');
  }
  async function previewBackup(){
    if(!backupFile)throw Error('Выберите файл .tasks-backup.');
    const decoded=await decryptVaultBackup(new Uint8Array(await backupFile.arrayBuffer()),restorePassword),snapshot=validateVaultSnapshot(decoded);
    setBackupPreview(snapshot);setRestoreName(snapshot.name+' — восстановлено');setRestorePassword('');
    setStatus('Файл расшифрован локально. Проверьте состав и задайте новую фразу.');
  }
  async function restoreBackup(){
    if(!backupPreview)throw Error('Сначала проверьте резервную копию.');
    if(restorePhrase!==restoreRepeat)throw Error('Фраза и повтор не совпадают.');
    await importVaultSnapshot(user,backupPreview,restoreName,restorePhrase);
    setBackupPreview(undefined);setBackupFile(undefined);setRestorePhrase('');setRestoreRepeat('');
    setStatus('Новое хранилище восстановлено локально. Напоминания импортированы выключенными.');
    void synchronize(user).catch(()=>{});
  }
  async function previewNote(){
    if(!noteFile)throw Error('Выберите .zip из Tasks или .md.');
    const parsed=await parseNoteImportFile(noteFile);setNotePreview(parsed);
    const duplicate=noteTarget&&parsed.source?await noteImportIsDuplicate(user,noteTarget,parsed):false;
    setNoteDuplicate(duplicate);setDuplicatePolicy(duplicate?'skip':'copy');
    setStatus(duplicate?'В целевом хранилище уже есть импорт этой Tasks-заметки.':'Файл проверен локально и готов к импорту.');
  }
  async function importNote(){
    if(!notePreview||!noteTarget)throw Error('Сначала выберите открытое хранилище и проверьте файл.');
    const result=await importPortableNote(user,noteTarget,notePreview,duplicatePolicy);
    if(!result.imported){setStatus('Дубликат пропущен.');return;}
    setNotePreview(undefined);setNoteFile(undefined);
    setStatus(result.duplicate?'Импортирована ещё одна копия заметки.':'Заметка импортирована. Напоминание, если было, оставлено выключенным.');
    void synchronize(user).catch(()=>{});
  }

  return e('main',{class:'settings-screen data-transfer'},
    e(PageHeader,{eyebrow:'Данные',title:'Импорт, экспорт и восстановление',description:'Операции выполняются локально: сервер не получает открытый текст заметок, пароль резервной копии или новую фразу хранилища.',back:onBack}),

    error&&e('div',{class:'inline-alert danger',role:'alert'},e(UiIcon,{name:'warning',size:18}),error),
    status&&e('div',{class:'inline-alert success',role:'status'},e(UiIcon,{name:'check',size:18}),status),

    e('section',{class:'transfer-grid'},
      e('article',{class:'settings-panel transfer-panel'},
        e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Резервная копия хранилища'),e('p',null,'Создать зашифрованный файл .tasks-backup из открытого хранилища.')),e('span',{class:'transfer-icon'},e(UiIcon,{name:'database',size:22}))),
        e('div',{class:'form-grid'},
          e('label',null,e('span',null,'Открытое хранилище'),e('select',{value:exportVault,onChange:(ev:Event)=>setExportVault((ev.target as HTMLSelectElement).value)},e('option',{value:''},opened.length?'Выберите хранилище':'Нет открытых хранилищ'),opened.map(item=>e('option',{value:item.id,key:item.id},item.name)))),
          e('label',null,e('span',null,'Пароль резервной копии'),e('input',{type:'password',autoComplete:'new-password',value:backupPassword,onInput:(ev:Event)=>setBackupPassword((ev.target as HTMLInputElement).value),placeholder:'Отдельный пароль'})),
          e('label',null,e('span',null,'Повторите пароль'),e('input',{type:'password',autoComplete:'new-password',value:backupRepeat,onInput:(ev:Event)=>setBackupRepeat((ev.target as HTMLInputElement).value)}))),
        e('div',{class:'form-actions'},e('button',{class:'primary',disabled:busy||!exportVault,onClick:()=>void run(exportBackup)},busy?'Подождите…':'Создать копию')),
        e('p',{class:'settings-footnote'},'Пароль копии независим от пароля аккаунта и фразы хранилища. Если данные нельзя сохранить полностью, экспорт остановится вместо создания неполной копии.')),

      e('article',{class:'settings-panel transfer-panel'},
        e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Восстановить резервную копию'),e('p',null,'Проверить файл и создать новое отдельное хранилище.')),e('span',{class:'transfer-icon'},e(UiIcon,{name:'archive',size:22}))),
        e('div',{class:'form-grid'},e('label',null,e('span',null,'Файл .tasks-backup'),e('input',{type:'file',accept:'.tasks-backup,application/octet-stream',onChange:(ev:Event)=>{setBackupFile((ev.target as HTMLInputElement).files?.[0]);setBackupPreview(undefined);}})),
          e('label',null,e('span',null,'Пароль резервной копии'),e('input',{type:'password',value:restorePassword,onInput:(ev:Event)=>setRestorePassword((ev.target as HTMLInputElement).value)}))),
        e('div',{class:'form-actions'},e('button',{class:'secondary-button',disabled:busy||!backupFile,onClick:()=>void run(previewBackup)},'Проверить файл')),
        backupPreview&&e('div',{class:'import-preview'},e('div',{class:'preview-heading'},e('strong',null,backupPreview.name),e('span',{class:'badge accent'},'Проверено')),
          e('div',{class:'preview-stats'},e('span',null,'Объектов ',e('strong',null,String(backupObjects.size))),e('span',null,'Версий ',e('strong',null,String(backupPreview.revisions.length))),e('span',null,'Напоминаний ',e('strong',null,String(backupReminders)))),
          e(InfoTip,{label:'О напоминаниях после импорта'},'Импортированные напоминания останутся выключенными до ручной проверки.'),
          e('div',{class:'form-grid'},e('label',null,e('span',null,'Название нового хранилища'),e('input',{value:restoreName,maxLength:200,onInput:(ev:Event)=>setRestoreName((ev.target as HTMLInputElement).value)})),
            e('label',null,e('span',null,'Новая фраза хранилища'),e('input',{type:'password',autoComplete:'new-password',value:restorePhrase,onInput:(ev:Event)=>setRestorePhrase((ev.target as HTMLInputElement).value)})),
            e('label',null,e('span',null,'Повторите фразу'),e('input',{type:'password',autoComplete:'new-password',value:restoreRepeat,onInput:(ev:Event)=>setRestoreRepeat((ev.target as HTMLInputElement).value)}))),
          e('button',{class:'primary',disabled:busy,onClick:()=>void run(restoreBackup)},'Создать новое хранилище')))),

    e('section',{class:'settings-panel'},
      e('div',{class:'settings-panel-heading'},e('div',null,e('h2',null,'Импорт заметки'),e('p',null,'Tasks ZIP восстанавливает структуру и вложения; Markdown создаёт новую текстовую заметку.'))),
      e('div',{class:'form-grid two'},e('label',null,e('span',null,'Целевое хранилище'),e('select',{value:noteTarget,onChange:(ev:Event)=>{setNoteTarget((ev.target as HTMLSelectElement).value);setNotePreview(undefined);}},e('option',{value:''},opened.length?'Выберите хранилище':'Нет открытых хранилищ'),opened.map(item=>e('option',{value:item.id,key:item.id},item.name)))),
        e('label',null,e('span',null,'Файл заметки'),e('input',{type:'file',accept:'.zip,.md,text/markdown,application/zip',onChange:(ev:Event)=>{setNoteFile((ev.target as HTMLInputElement).files?.[0]);setNotePreview(undefined);}}))),
      e('div',{class:'form-actions'},e('button',{class:'secondary-button',disabled:busy||!noteFile||!noteTarget,onClick:()=>void run(previewNote)},'Проверить файл')),
      notePreview&&e('div',{class:'import-preview'},e('div',{class:'preview-heading'},e('strong',null,notePreview.note.title||'Без заголовка'),e('span',{class:'badge accent'},'Готово к импорту')),
        e('p',null,'Вложения: ',notePreview.files?.length??0,' · чек-лист: ',notePreview.note.checklist?.length??0,' · напоминание: ',notePreview.note.reminder?'есть, будет выключено':'нет'),
        noteDuplicate&&e('fieldset',{class:'duplicate-choice'},e('legend',null,'Такая Tasks-заметка уже импортировалась'),e('label',{class:'check-row'},e('input',{type:'radio',name:'duplicate',checked:duplicatePolicy==='skip',onChange:()=>setDuplicatePolicy('skip')}),'Пропустить'),e('label',{class:'check-row'},e('input',{type:'radio',name:'duplicate',checked:duplicatePolicy==='copy',onChange:()=>setDuplicatePolicy('copy')}),'Создать ещё одну копию')),
        e('button',{class:'primary',disabled:busy,onClick:()=>void run(importNote)},noteDuplicate&&duplicatePolicy==='skip'?'Пропустить':'Импортировать'))),

    e(InfoTip,{label:'О резервном копировании'},'Резервное копирование базы сервера остаётся административной операцией. Оно не заменяет пользовательскую зашифрованную копию и не восстанавливает неизвестную фразу.'));
}
