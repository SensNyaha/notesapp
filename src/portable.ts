import { gzipSync, gunzipSync, strFromU8, strToU8, unzipSync, zipSync, Zip, ZipPassThrough, Unzip, UnzipInflate } from 'fflate';
import { encode64, PBKDF2_ITERATIONS } from './crypto/vault.ts';
import type { Note, TagDefinition, PortableVaultSnapshot } from './planner.ts';

export const MAX_BACKUP_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = MAX_BACKUP_CONTENT_BYTES + 4 * 1024 * 1024;
const MAX_LEGACY_NOTE_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_METADATA_BYTES = 8 * 1024 * 1024;
const MAGIC = strToU8('TASKS-BACKUP-V1\n');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export interface NoteSource { kind:'tasks-note-v1';vaultId:string;objectId:string }
export interface PortableAttachmentFile { sourceId:string;name:string;type:string;size:number;bytes?:Uint8Array;blob?:Blob }
export interface PortableAttachmentStream { size:number;chunks:AsyncIterable<Uint8Array> }
export interface PortableNotePackage { note:Note;tags:TagDefinition[];source?:NoteSource;files?:PortableAttachmentFile[];coverAttachmentId?:string;cleanup?:()=>Promise<void> }
interface BackupHeader {
  format:'tasks-vault-backup';version:1;alg:'A256GCM';compression:'gzip';
  kdf:{name:'PBKDF2-SHA256';iterations:number;salt:string};iv:string;
}
interface NoteManifest {
  format:'tasks-note-export';version:1;exportedAt:number;source:NoteSource;
  note:Omit<Note,'attachments'>;tags:TagDefinition[];
  attachments:{id:string;name:string;type:string;size:number;path:string}[];
}

function invalid(message='Некорректный формат файла'):never{throw Error(message);}
function exactObject(value:unknown,fields:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==fields.length||fields.some(field=>!Object.hasOwn(row,field)))invalid();
  return row;
}
function decode64(value:unknown,length:number){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))invalid();
  let decoded:string;try{decoded=atob(value.replace(/-/g,'+').replace(/_/g,'/'));}catch{return invalid();}
  const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
  if(bytes.length!==length||encode64(bytes)!==value)invalid();
  return bytes;
}
function random(length:number){const bytes=new Uint8Array(length);crypto.getRandomValues(bytes);return bytes;}
function concat(...parts:Uint8Array[]){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;}
function passwordBytes(password:string){
  if(typeof password!=='string'||Array.from(password).length<8||/[\uD800-\uDFFF]/u.test(password))throw Error('Пароль резервной копии: минимум 8 символов.');
  const bytes=encoder.encode(password);if(bytes.length>4096)throw Error('Пароль резервной копии слишком длинный.');return bytes;
}
async function backupKey(password:string,kdf:BackupHeader['kdf']){
  const bytes=passwordBytes(password);
  try{
    const material=await crypto.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:kdf.iterations,salt:decode64(kdf.salt,16)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }finally{bytes.fill(0);}
}
function headerBytes(header:BackupHeader){return strToU8(JSON.stringify(header));}
function parseHeader(bytes:Uint8Array):BackupHeader{
  let value:unknown;try{value=JSON.parse(strFromU8(bytes));}catch{return invalid();}
  const row=exactObject(value,['format','version','alg','compression','kdf','iv']);
  if(row.format!=='tasks-vault-backup'||row.version!==1||row.alg!=='A256GCM'||row.compression!=='gzip')invalid();
  const kdf=exactObject(row.kdf,['name','iterations','salt']);
  if(kdf.name!=='PBKDF2-SHA256'||!Number.isSafeInteger(kdf.iterations)||(kdf.iterations as number)<PBKDF2_ITERATIONS||(kdf.iterations as number)>2_000_000)invalid();
  decode64(kdf.salt,16);decode64(row.iv,12);
  return row as unknown as BackupHeader;
}
export async function encryptVaultBackup(snapshot:PortableVaultSnapshot,password:string){
  const raw=strToU8(JSON.stringify(snapshot));
  if(raw.length>MAX_BACKUP_CONTENT_BYTES)throw Error('Резервная копия превышает лимит 64 МиБ.');
  const compressed=gzipSync(raw,{level:6});raw.fill(0);
  const header:BackupHeader={format:'tasks-vault-backup',version:1,alg:'A256GCM',compression:'gzip',
    kdf:{name:'PBKDF2-SHA256',iterations:PBKDF2_ITERATIONS,salt:encode64(random(16))},iv:encode64(random(12))};
  const hb=headerBytes(header),aad=concat(MAGIC,hb),key=await backupKey(password,header.kdf);
  const input=Uint8Array.from(compressed);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:decode64(header.iv,12),additionalData:aad,tagLength:128},key,input));
  input.fill(0);compressed.fill(0);
  const len=new Uint8Array(4);new DataView(len.buffer).setUint32(0,hb.length,false);
  return concat(MAGIC,len,hb,encrypted);
}
export async function decryptVaultBackup(file:Uint8Array,password:string):Promise<unknown>{
  if(file.length>MAX_BACKUP_FILE_BYTES)throw Error('Файл резервной копии превышает допустимый размер.');
  if(file.length<MAGIC.length+4+16||MAGIC.some((byte,i)=>file[i]!==byte))invalid();
  const headerLength=new DataView(file.buffer,file.byteOffset+MAGIC.length,4).getUint32(0,false);
  if(headerLength<32||headerLength>4096||MAGIC.length+4+headerLength+16>file.length)invalid();
  const hb=file.slice(MAGIC.length+4,MAGIC.length+4+headerLength),header=parseHeader(hb);
  const ciphertext=file.slice(MAGIC.length+4+headerLength),key=await backupKey(password,header.kdf),aad=concat(MAGIC,hb);
  let compressed:Uint8Array;
  try{compressed=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(header.iv,12),additionalData:aad,tagLength:128},key,ciphertext));}
  catch{throw Error('Неверный пароль резервной копии или файл повреждён.');}
  const raw=gunzipSync(compressed);compressed.fill(0);
  if(raw.length>MAX_BACKUP_CONTENT_BYTES){raw.fill(0);throw Error('Содержимое резервной копии превышает лимит 64 МиБ.');}
  try{return JSON.parse(strFromU8(raw));}catch{return invalid();}finally{raw.fill(0);}
}
function safeName(name:string,fallback:string){
  const cleaned=name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').trim().slice(0,120);
  return cleaned||fallback;
}
function dataUrlBytes(data:string,type:string){
  const match=data.match(/^data:([^;,]{1,100});base64,([A-Za-z0-9+/=]+)$/);if(!match||match[1]!==type)invalid('Повреждено вложение заметки');
  let decoded:string;try{decoded=atob(match[2]);}catch{return invalid('Повреждено вложение заметки');}
  return Uint8Array.from(decoded,c=>c.charCodeAt(0));
}
function noteMarkdown(note:Note,attachments:NoteManifest['attachments']){
  const lines=['# '+(note.title||'Без заголовка'),''];
  if(note.text)lines.push(note.text,'');
  if(note.checklist?.length){lines.push('## Чек-лист','',...note.checklist.map(item=>'- ['+(item.done?'x':' ')+'] '+item.text),'');}
  if(attachments.length){lines.push('## Вложения','',...attachments.map(item=>'- ['+item.name+']('+item.path+')'),'');}
  if(note.reminder)lines.push('> Напоминание: '+note.reminder.local+'; при импорте оно будет выключено.','');
  return lines.join('\n');
}

function noteManifest(pkg:PortableNotePackage){
  if(!pkg.source||!UUID.test(pkg.source.vaultId)||!UUID.test(pkg.source.objectId))throw Error('Для Tasks ZIP нужен источник заметки.');
  const used=new Set<string>();
  const attachments=(pkg.note.attachments??[]).map((item,index)=>{
    let name=safeName(item.name,'attachment-'+(index+1)),path='attachments/'+String(index+1).padStart(3,'0')+'-'+name;
    while(used.has(path))path='attachments/'+String(index+1).padStart(3,'0')+'-'+crypto.randomUUID().slice(0,8)+'-'+name;used.add(path);
    return{id:item.id,name:item.name,type:item.type,size:item.size,path};
  });
  const {attachments:_,...note}=pkg.note;
  return{manifest:{format:'tasks-note-export',version:1,exportedAt:Date.now(),source:pkg.source,note,tags:pkg.tags,attachments} as NoteManifest,attachments};
}
function parsedManifest(bytes:Uint8Array){
  if(bytes.length>MAX_ZIP_METADATA_BYTES)invalid('manifest.json слишком велик');
  let parsed:unknown;try{parsed=JSON.parse(strFromU8(bytes));}catch{return invalid();}
  const row=exactObject(parsed,['format','version','exportedAt','source','note','tags','attachments']);
  if(row.format!=='tasks-note-export'||row.version!==1||!Number.isSafeInteger(row.exportedAt)||!Array.isArray(row.tags)||!Array.isArray(row.attachments)||row.attachments.length>500)invalid();
  const source=exactObject(row.source,['kind','vaultId','objectId']);if(source.kind!=='tasks-note-v1'||!UUID.test(String(source.vaultId))||!UUID.test(String(source.objectId)))invalid();
  const note=row.note;if(!note||typeof note!=='object'||Array.isArray(note)||!('title'in note)||typeof note.title!=='string'||!('text'in note)||typeof note.text!=='string')invalid();
  const rawNote=note as Note,coverAttachmentId=rawNote.cover?.attachmentId,{attachments:_,cover:__,...core}=rawNote;
  const attachments=(row.attachments as unknown[]).map(raw=>{const item=exactObject(raw,['id','name','type','size','path']);
    if(typeof item.id!=='string'||!UUID.test(item.id)||typeof item.name!=='string'||!item.name.trim()||item.name.length>200
      ||typeof item.type!=='string'||item.type.length>100||!Number.isSafeInteger(item.size)||(item.size as number)<0
      ||typeof item.path!=='string'||!/^attachments\/[^/\\\u0000-\u001f]{1,180}$/.test(item.path))invalid();
    return{id:item.id,name:item.name,type:item.type,size:item.size as number,path:item.path};
  });
  if(new Set(attachments.map(item=>item.path)).size!==attachments.length)invalid('ZIP содержит повторяющиеся пути вложений');
  if(coverAttachmentId!==undefined&&(!UUID.test(coverAttachmentId)||!attachments.some(item=>item.id===coverAttachmentId&&item.type.startsWith('image/'))))invalid('Некорректная обложка заметки');
  return{note:core as Note,tags:row.tags as TagDefinition[],source:source as unknown as NoteSource,attachments,coverAttachmentId};
}
function opfs(){return (navigator.storage as StorageManager&{getDirectory?:()=>Promise<any>}).getDirectory?.();}
async function cleanupOpfs(directory:any,prefix:string,maxAge=24*60*60*1000){
  if(typeof directory.entries!=='function')return;
  try{for await(const [name,handle] of directory.entries())if(name.startsWith(prefix)&&handle?.kind==='file'){
    try{const file=await handle.getFile();if(Date.now()-file.lastModified>maxAge)await directory.removeEntry(name);}catch{}
  }}catch{}
}
async function pushZipEntry(zip:Zip,path:string,chunks:AsyncIterable<Uint8Array>|Uint8Array,wait:()=>Promise<void>){
  const entry=new ZipPassThrough(path);zip.add(entry);
  if(chunks instanceof Uint8Array){entry.push(chunks,true);await wait();return;}
  let pending:Uint8Array|undefined;
  for await(const chunk of chunks){if(pending){entry.push(pending,false);await wait();}pending=Uint8Array.from(chunk);}
  entry.push(pending??new Uint8Array(),true);await wait();
}
export async function createNoteZipBlob(pkg:PortableNotePackage,streams=new Map<string,PortableAttachmentStream>(),onProgress?:(done:number,total:number)=>void){
  const directory=await opfs();if(!directory)throw Error('Этот браузер не поддерживает потоковый экспорт больших файлов.');
  await cleanupOpfs(directory,'tasks-note-export-');
  const temp='tasks-note-export-'+crypto.randomUUID()+'.zip',handle=await directory.getFileHandle(temp,{create:true}),writer=await handle.createWritable();
  const {manifest,attachments}=noteManifest(pkg),byId=new Map((pkg.note.attachments??[]).map(item=>[item.id,item]));
  let write=Promise.resolve(),failure:unknown,done=0,total=attachments.reduce((sum,item)=>sum+item.size,0);
  const zip=new Zip((error,chunk)=>{if(error){failure=error;return;}write=write.then(()=>writer.write(chunk));});
  const wait=async()=>{await write;if(failure)throw failure;};
  try{
    await pushZipEntry(zip,'manifest.json',strToU8(JSON.stringify(manifest)),wait);
    await pushZipEntry(zip,'note.md',strToU8(noteMarkdown(pkg.note,attachments)),wait);
    for(const descriptor of attachments){
      const item=byId.get(descriptor.id)!;
      if(item.data){const bytes=dataUrlBytes(item.data,item.type);if(bytes.length!==item.size)throw Error('Размер вложения не совпадает с данными.');
        await pushZipEntry(zip,descriptor.path,bytes,wait);done+=bytes.length;onProgress?.(done,total);continue;}
      const source=streams.get(item.id);if(!source||source.size!==item.size)throw Error('Потоковое вложение не было подготовлено для экспорта.');const prepared=source;
      async function* progress(){let current=0;for await(const chunk of prepared.chunks){current+=chunk.length;if(current>item.size)throw Error('Размер вложения превышает manifest.');done+=chunk.length;onProgress?.(done,total);yield chunk;}if(current!==item.size)throw Error('Размер вложения не совпадает с manifest.');}
      await pushZipEntry(zip,descriptor.path,progress(),wait);
    }
    zip.end();await wait();await writer.close();const file=await handle.getFile();let cleaned=false;
    return{blob:file as Blob,cleanup:async()=>{if(cleaned)return;cleaned=true;await directory.removeEntry(temp).catch(()=>{});}};
  }catch(error){zip.terminate();await writer.abort().catch(()=>{});await directory.removeEntry(temp).catch(()=>{});throw error;}
}
export function createNoteZip(pkg:PortableNotePackage,external=new Map<string,Uint8Array>()){
  if(!pkg.source||!UUID.test(pkg.source.vaultId)||!UUID.test(pkg.source.objectId))throw Error('Для Tasks ZIP нужен источник заметки.');
  const files:Record<string,Uint8Array>={},used=new Set<string>();
  const attachments=(pkg.note.attachments??[]).map((item,index)=>{
    let name=safeName(item.name,'attachment-'+(index+1));let path='attachments/'+String(index+1).padStart(3,'0')+'-'+name;
    while(used.has(path))path='attachments/'+String(index+1).padStart(3,'0')+'-'+crypto.randomUUID().slice(0,8)+'-'+name;used.add(path);
    const bytes=item.data?dataUrlBytes(item.data,item.type):external.get(item.id);
    if(!bytes)throw Error('Потоковое вложение не было расшифровано для экспорта.');
    if(bytes.length!==item.size)throw Error('Размер вложения не совпадает с данными.');
    files[path]=Uint8Array.from(bytes);return{id:item.id,name:item.name,type:item.type,size:item.size,path};
  });
  const {attachments:_,...note}=pkg.note;
  const manifest:NoteManifest={format:'tasks-note-export',version:1,exportedAt:Date.now(),source:pkg.source,note,tags:pkg.tags,attachments};
  files['manifest.json']=strToU8(JSON.stringify(manifest));files['note.md']=strToU8(noteMarkdown(pkg.note,attachments));
  const total=Object.values(files).reduce((sum,item)=>sum+item.length,0);if(total>MAX_LEGACY_NOTE_ZIP_BYTES)throw Error('Для ZIP больше 64 МиБ используйте потоковый экспорт.');
  return zipSync(files,{level:6});
}
function zipDeclaredSize(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let eocd=-1;
  for(let i=Math.max(0,bytes.length-65557);i<=bytes.length-22;i++)if(view.getUint32(i,true)===0x06054b50)eocd=i;
  if(eocd<0)invalid('Некорректный ZIP-файл');
  const count=view.getUint16(eocd+10,true),size=view.getUint32(eocd+12,true),offset=view.getUint32(eocd+16,true);
  if(count>1000||offset+size>eocd)invalid('Некорректный ZIP-файл');
  let at=offset,total=0;
  for(let n=0;n<count;n++){
    if(at+46>bytes.length||view.getUint32(at,true)!==0x02014b50)invalid('Некорректный ZIP-файл');
    const unpacked=view.getUint32(at+24,true),name=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true);
    if(unpacked===0xffffffff)invalid('ZIP64 обрабатывается только потоковым импортом');total+=unpacked;if(total>MAX_LEGACY_NOTE_ZIP_BYTES)throw Error('Большой ZIP должен импортироваться потоковым способом.');
    at+=46+name+extra+comment;
  }return total;
}
function genericMarkdown(bytes:Uint8Array,fileName:string):PortableNotePackage{
  if(bytes.length>MAX_LEGACY_NOTE_ZIP_BYTES)throw Error('Markdown превышает допустимый размер заметки.');
  const text=strFromU8(bytes).replace(/\r\n?/g,'\n'),lines=text.split('\n');let title=safeName(fileName.replace(/\.md$/i,''),'Импортированная заметка');
  if(/^#\s+/.test(lines[0]??'')){title=lines.shift()!.replace(/^#\s+/,'').trim()||title;if(lines[0]==='')lines.shift();}
  return{note:{title,text:lines.join('\n')},tags:[]};
}
export function parseNoteImport(bytes:Uint8Array,fileName:string):PortableNotePackage{
  if(/\.md$/i.test(fileName))return genericMarkdown(bytes,fileName);
  if(!/\.zip$/i.test(fileName))throw Error('Поддерживаются .zip из Tasks и обычные .md.');
  if(bytes.length>MAX_LEGACY_NOTE_ZIP_BYTES)throw Error('Большой ZIP должен импортироваться потоковым способом.');zipDeclaredSize(bytes);
  const files=unzipSync(bytes),manifestBytes=files['manifest.json'];if(!manifestBytes)invalid('В ZIP отсутствует manifest.json');
  const parsed=parsedManifest(manifestBytes),portableFiles:PortableAttachmentFile[]=[];
  for(const item of parsed.attachments){const data=files[item.path];if(!data||data.length!==item.size)invalid('Вложение отсутствует или повреждено');
    portableFiles.push({sourceId:item.id,name:item.name,type:item.type,size:item.size,bytes:Uint8Array.from(data)});}
  return{note:parsed.note,tags:parsed.tags,source:parsed.source,...(portableFiles.length?{files:portableFiles}:{}),...(parsed.coverAttachmentId?{coverAttachmentId:parsed.coverAttachmentId}:{})};
}
export async function parseNoteImportFile(file:File):Promise<PortableNotePackage>{
  if(/\.md$/i.test(file.name)){if(file.size>MAX_LEGACY_NOTE_ZIP_BYTES)throw Error('Markdown слишком велик для заметки.');return genericMarkdown(new Uint8Array(await file.arrayBuffer()),file.name);}
  if(!/\.zip$/i.test(file.name))throw Error('Поддерживаются .zip из Tasks и обычные .md.');
  if(file.size<=MAX_LEGACY_NOTE_ZIP_BYTES)return parseNoteImport(new Uint8Array(await file.arrayBuffer()),file.name);
  const directory=await opfs();if(!directory)throw Error('Этот браузер не поддерживает потоковый импорт больших ZIP.');await cleanupOpfs(directory,'tasks-note-import-');
  const tempPrefix='tasks-note-import-'+crypto.randomUUID()+'-',states:{path:string;handle:any;pending:Promise<void>;bytes:number;expected:number}[]=[];
  let parsed:ReturnType<typeof parsedManifest>|undefined,failure:unknown,first=true,count=0,manifestParts:Uint8Array[]=[],manifestBytes=0;
  const unzip=new Unzip(entry=>{
    if(failure){entry.terminate();return;}count++;if(count>502){failure=Error('ZIP содержит слишком много файлов.');entry.terminate();return;}
    const name=entry.name;if(first&&name!=='manifest.json'){failure=Error('Большой Tasks ZIP должен начинаться с manifest.json.');entry.terminate();return;}first=false;
    if(name==='manifest.json'){
      entry.ondata=(error,chunk,final)=>{if(error){failure=error;return;}manifestBytes+=chunk.length;if(manifestBytes>MAX_ZIP_METADATA_BYTES){failure=Error('manifest.json слишком велик');return;}
        if(chunk.length)manifestParts.push(Uint8Array.from(chunk));if(final&&!failure){const bytes=concat(...manifestParts);parsed=parsedManifest(bytes);manifestParts=[];}};
      entry.start();return;
    }
    if(name==='note.md'){let bytes=0;entry.ondata=(error,chunk)=>{if(error)failure=error;bytes+=chunk.length;if(bytes>MAX_ZIP_METADATA_BYTES)failure=Error('note.md слишком велик');};entry.start();return;}
    if(!parsed){failure=Error('manifest.json должен предшествовать вложениям в большом Tasks ZIP.');entry.terminate();return;}
    const expected=parsed.attachments.find(item=>item.path===name);if(!expected){failure=Error('ZIP содержит неожиданный файл: '+name);entry.terminate();return;}
    const state={path:name,handle:null as any,pending:Promise.resolve(),bytes:0,expected:expected.size};states.push(state);
    const ready=directory.getFileHandle(tempPrefix+expected.id,{create:true}).then(async(handle:any)=>{state.handle=handle;return handle.createWritable();});
    let chain=ready.then(()=>{});
    entry.ondata=(error,chunk,final)=>{if(error){failure=error;return;}state.bytes+=chunk.length;if(state.bytes>state.expected){failure=Error('Размер вложения превышает manifest.');entry.terminate();return;}
      if(chunk.length)chain=chain.then(async()=>{const writer=await ready;await writer.write(chunk);});
      if(final)chain=chain.then(async()=>{const writer=await ready;await writer.close();if(state.bytes!==state.expected)throw Error('Размер вложения не совпадает с manifest.');});
      state.pending=chain.catch(error=>{failure=error;});
    };entry.start();
  });
  unzip.register(UnzipInflate);
  try{
    const reader=file.stream().getReader();while(true){const part=await reader.read();if(part.done)break;unzip.push(new Uint8Array(part.value),false);await Promise.all(states.map(state=>state.pending));if(failure)throw failure;}
    unzip.push(new Uint8Array(),true);await Promise.all(states.map(state=>state.pending));if(failure)throw failure;if(!parsed)throw Error('В ZIP отсутствует manifest.json');
    const portableFiles:PortableAttachmentFile[]=[];
    for(const item of parsed.attachments){const state=states.find(value=>value.path===item.path);if(!state?.handle||state.bytes!==item.size)throw Error('Вложение отсутствует или повреждено: '+item.name);
      portableFiles.push({sourceId:item.id,name:item.name,type:item.type,size:item.size,blob:await state.handle.getFile()});}
    let cleaned=false;const cleanup=async()=>{if(cleaned)return;cleaned=true;for(const item of parsed!.attachments)await directory.removeEntry(tempPrefix+item.id).catch(()=>{});};
    return{note:parsed.note,tags:parsed.tags,source:parsed.source,...(portableFiles.length?{files:portableFiles}:{}),...(parsed.coverAttachmentId?{coverAttachmentId:parsed.coverAttachmentId}:{}),cleanup};
  }catch(error){for(const state of states){await state.pending.catch(()=>{});const id=parsed?.attachments.find(item=>item.path===state.path)?.id;if(id)await directory.removeEntry(tempPrefix+id).catch(()=>{});}throw error;}
}
export function downloadBytes(bytes:Uint8Array,fileName:string,type='application/octet-stream'){
  const blob=new Blob([bytes as BlobPart],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=safeName(fileName,'export');
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);
}
export function backupFileName(name:string){return safeName(name,'vault')+'.tasks-backup';}
export function noteZipFileName(name:string){return safeName(name,'note')+'.zip';}
