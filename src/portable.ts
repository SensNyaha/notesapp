import { gzipSync, gunzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { encode64, PBKDF2_ITERATIONS } from './crypto/vault.ts';
import type { Note, TagDefinition, PortableVaultSnapshot } from './planner.ts';

export const MAX_PORTABLE_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = MAX_PORTABLE_BYTES + 4 * 1024 * 1024;
const MAGIC = strToU8('TASKS-BACKUP-V1\n');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export interface NoteSource { kind:'tasks-note-v1';vaultId:string;objectId:string }
export interface PortableNotePackage { note:Note;tags:TagDefinition[];source?:NoteSource }
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
  if(raw.length>MAX_PORTABLE_BYTES)throw Error('Резервная копия превышает лимит 64 МиБ.');
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
  if(raw.length>MAX_PORTABLE_BYTES){raw.fill(0);throw Error('Содержимое резервной копии превышает лимит 64 МиБ.');}
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
export function createNoteZip(pkg:PortableNotePackage){
  if(!pkg.source||!UUID.test(pkg.source.vaultId)||!UUID.test(pkg.source.objectId))throw Error('Для Tasks ZIP нужен источник заметки.');
  const files:Record<string,Uint8Array>={},used=new Set<string>();
  const attachments=(pkg.note.attachments??[]).map((item,index)=>{
    let name=safeName(item.name,'attachment-'+(index+1));let path='attachments/'+String(index+1).padStart(2,'0')+'-'+name;
    while(used.has(path))path='attachments/'+String(index+1).padStart(2,'0')+'-'+crypto.randomUUID().slice(0,8)+'-'+name;used.add(path);
    const bytes=dataUrlBytes(item.data,item.type);if(bytes.length!==item.size)throw Error('Размер вложения не совпадает с данными.');
    files[path]=bytes;return{id:item.id,name:item.name,type:item.type,size:item.size,path};
  });
  const {attachments:_,...note}=pkg.note;
  const manifest:NoteManifest={format:'tasks-note-export',version:1,exportedAt:Date.now(),source:pkg.source,note,tags:pkg.tags,attachments};
  files['manifest.json']=strToU8(JSON.stringify(manifest));files['note.md']=strToU8(noteMarkdown(pkg.note,attachments));
  const total=Object.values(files).reduce((sum,item)=>sum+item.length,0);if(total>MAX_PORTABLE_BYTES)throw Error('Экспорт заметки превышает лимит 64 МиБ.');
  return zipSync(files,{level:6});
}
function zipDeclaredSize(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let eocd=-1;
  for(let i=Math.max(0,bytes.length-65557);i<=bytes.length-22;i++)if(view.getUint32(i,true)===0x06054b50)eocd=i;
  if(eocd<0)invalid('Некорректный ZIP-файл');
  const count=view.getUint16(eocd+10,true),size=view.getUint32(eocd+12,true),offset=view.getUint32(eocd+16,true);
  if(count>100||offset+size>eocd)invalid('Некорректный ZIP-файл');
  let at=offset,total=0;
  for(let n=0;n<count;n++){
    if(at+46>bytes.length||view.getUint32(at,true)!==0x02014b50)invalid('Некорректный ZIP-файл');
    const unpacked=view.getUint32(at+24,true),name=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true);
    if(unpacked===0xffffffff)invalid('ZIP64 пока не поддерживается');total+=unpacked;if(total>MAX_PORTABLE_BYTES)throw Error('ZIP превышает лимит 64 МиБ.');
    at+=46+name+extra+comment;
  }return total;
}
function genericMarkdown(bytes:Uint8Array,fileName:string):PortableNotePackage{
  if(bytes.length>MAX_PORTABLE_BYTES)throw Error('Markdown превышает лимит 64 МиБ.');
  const text=strFromU8(bytes).replace(/\r\n?/g,'\n'),lines=text.split('\n');let title=safeName(fileName.replace(/\.md$/i,''),'Импортированная заметка');
  if(/^#\s+/.test(lines[0]??'')){title=lines.shift()!.replace(/^#\s+/,'').trim()||title;if(lines[0]==='')lines.shift();}
  return{note:{title,text:lines.join('\n')},tags:[]};
}
export function parseNoteImport(bytes:Uint8Array,fileName:string):PortableNotePackage{
  if(/\.md$/i.test(fileName))return genericMarkdown(bytes,fileName);
  if(!/\.zip$/i.test(fileName))throw Error('Поддерживаются .zip из Tasks и обычные .md.');
  if(bytes.length>MAX_BACKUP_FILE_BYTES)throw Error('ZIP превышает лимит 64 МиБ.');zipDeclaredSize(bytes);
  const files=unzipSync(bytes);const manifestBytes=files['manifest.json'];if(!manifestBytes)invalid('В ZIP отсутствует manifest.json');
  let parsed:unknown;try{parsed=JSON.parse(strFromU8(manifestBytes));}catch{return invalid();}
  const row=exactObject(parsed,['format','version','exportedAt','source','note','tags','attachments']);
  if(row.format!=='tasks-note-export'||row.version!==1||!Number.isSafeInteger(row.exportedAt)||!Array.isArray(row.tags)||!Array.isArray(row.attachments)||row.attachments.length>15)invalid();
  const source=exactObject(row.source,['kind','vaultId','objectId']);if(source.kind!=='tasks-note-v1'||!UUID.test(String(source.vaultId))||!UUID.test(String(source.objectId)))invalid();
  const note=row.note;if(!note||typeof note!=='object'||Array.isArray(note)||!('title'in note)||typeof note.title!=='string'||!('text'in note)||typeof note.text!=='string')invalid();
  const attachments=[] as NonNullable<Note['attachments']>;
  for(const raw of row.attachments){const item=exactObject(raw,['id','name','type','size','path']);
    if(typeof item.id!=='string'||typeof item.name!=='string'||typeof item.type!=='string'||!Number.isSafeInteger(item.size)||typeof item.path!=='string'||!item.path.startsWith('attachments/'))invalid();
    const data=files[item.path];if(!data||data.length!==item.size)invalid('Вложение отсутствует или повреждено');
    let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));
    attachments.push({id:item.id,name:item.name,type:item.type,size:item.size,data:'data:'+item.type+';base64,'+btoa(binary)});
  }
  return{note:{...(note as Note),...(attachments.length?{attachments}:{})},tags:row.tags as TagDefinition[],source:source as unknown as NoteSource};
}
export function downloadBytes(bytes:Uint8Array,fileName:string,type='application/octet-stream'){
  const blob=new Blob([bytes as BlobPart],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=safeName(fileName,'export');
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);
}
export function backupFileName(name:string){return safeName(name,'vault')+'.tasks-backup';}
export function noteZipFileName(name:string){return safeName(name,'note')+'.zip';}
