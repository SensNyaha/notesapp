import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'fake-indexeddb/auto';
import { eraseState, readState, changes } from '../src/storage.ts';
import { archiveNote, createTag, createVault, exportVaultSnapshot, heads, importPortableNote, importVaultSnapshot,
  noteImportIsDuplicate, readNote, readTags, saveNote, validateVaultSnapshot } from '../src/planner.ts';
import { MAX_PORTABLE_BYTES, createNoteZip, decryptVaultBackup, encryptVaultBackup, parseNoteImport } from '../src/portable.ts';

const user={id:'91000000-0000-4000-8000-000000000001',login:'portable-user',role:'user'};
function installLocks(){
  globalThis.window=new EventTarget();const queues=new Map();
  Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request(name,fn){
    const next=(queues.get(name)??Promise.resolve()).then(fn);queues.set(name,next.catch(()=>{}));return next;
  }}});
}
test.before(installLocks);
test.afterEach(async()=>{await eraseState(user.id);});
test.after(()=>changes?.close());

const sourceId='92000000-0000-4000-8000-000000000002';
const objectId='93000000-0000-4000-8000-000000000003';
const revisionId='94000000-0000-4000-8000-000000000004';
function snapshot(){
  return{format:'tasks-vault-snapshot',version:1,sourceVaultId:sourceId,name:'Portable vault',exportedAt:1760000000000,
    tags:[],pushMode:'neutral',revisions:[{revisionId,objectId,parent:null,resolves:[],note:{title:'Secret',text:'PRIVATE BACKUP 5517'}}]};
}

test('encrypted portable backup authenticates password, metadata and ciphertext without exposing plaintext',async()=>{
  assert.equal(MAX_PORTABLE_BYTES,64*1024*1024);
  const value=validateVaultSnapshot(snapshot()),bytes=await encryptVaultBackup(value,'Backup-pass-123');
  assert.equal(new TextDecoder().decode(bytes).includes('PRIVATE BACKUP 5517'),false);
  assert.deepEqual(validateVaultSnapshot(await decryptVaultBackup(bytes,'Backup-pass-123')),value);
  await assert.rejects(decryptVaultBackup(bytes,'wrong-password'),/Неверный пароль/);
  const tampered=Uint8Array.from(bytes);tampered[tampered.length-1]^=1;
  await assert.rejects(decryptVaultBackup(tampered,'Backup-pass-123'),/повреждён/);
});

test('portable vault validation rejects broken graphs and orders dependencies before descendants',()=>{
  const parent=randomUUID(),child=randomUUID(),base={...snapshot(),revisions:[
    {revisionId:child,objectId,parent,resolves:[],note:{title:'Child',text:'2'}},
    {revisionId:parent,objectId,parent:null,resolves:[],note:{title:'Parent',text:'1'}},
  ]};
  const ordered=validateVaultSnapshot(base);assert.equal(ordered.revisions[0].revisionId,parent);assert.equal(ordered.revisions[1].revisionId,child);
  const cycle={...base,revisions:[
    {revisionId:parent,objectId,parent:child,resolves:[],note:{title:'A',text:'1'}},
    {revisionId:child,objectId,parent:parent,resolves:[],note:{title:'B',text:'2'}},
  ]};
  assert.throws(()=>validateVaultSnapshot(cycle),/цикл/);
  assert.throws(()=>validateVaultSnapshot({...base,revisions:[{...base.revisions[0],parent:randomUUID()}]}),/повреждённые связи/);
});

test('Tasks note ZIP keeps attachments and source identity while ordinary Markdown imports as a new text note',()=>{
  const attachment={id:randomUUID(),name:'proof.txt',type:'text/plain',size:5,data:'data:text/plain;base64,SGVsbG8='};
  const tag={id:randomUUID(),name:'Импорт',color:'#356AE6',deleted:false,op:'000000000001-test'};
  const pkg={source:{kind:'tasks-note-v1',vaultId:sourceId,objectId},tags:[tag],
    note:{title:'ZIP note',text:'Body',attachments:[attachment],tagIds:[tag.id],checklist:[{id:randomUUID(),text:'Check',done:true}]}};
  const bytes=createNoteZip(pkg),parsed=parseNoteImport(bytes,'note.zip');
  assert.equal(parsed.note.title,'ZIP note');assert.equal(parsed.note.attachments[0].data,attachment.data);
  assert.deepEqual(parsed.source,pkg.source);assert.equal(parsed.tags[0].name,'Импорт');
  const markdown=parseNoteImport(new TextEncoder().encode('# Plain title\n\nPlain body'),'plain.md');
  assert.equal(markdown.note.title,'Plain title');assert.equal(markdown.note.text,'Plain body');assert.equal(markdown.source,undefined);
});

test('vault backup restore creates a new vault, preserves history/tags/attachments and disables reminders',async()=>{
  const source=await createVault(user,'Источник','abcdef'),tagId=await createTag(user,source,'Backup tag','#123456'),oid=randomUUID();
  const reminder={id:randomUUID(),state:'active',local:'2026-12-20T09:30',mode:'custom',text:'PRIVATE PUSH'};
  const attachment={id:randomUUID(),name:'a.txt',type:'text/plain',size:5,data:'data:text/plain;base64,SGVsbG8='};
  const first=await saveNote(user,source,oid,null,{title:'Версия 1',text:'body',tagIds:[tagId],attachments:[attachment],reminder});
  await saveNote(user,source,oid,first.id,{title:'Версия 2',text:'body 2',tagIds:[tagId],attachments:[attachment],reminder});
  await archiveNote(user,source,oid);
  const exported=await exportVaultSnapshot(user,source);
  assert.equal(exported.revisions.length,3);assert.equal(exported.revisions.filter(item=>item.note.reminder).length,3);
  const target=await importVaultSnapshot(user,exported,'Восстановлено','ghijkl');assert.notEqual(target,source);
  const state=await readState(user.id),vault=state.vaults.find(item=>item.header.id===target),versions=vault.records.filter(item=>item.objectId!==vault.header.id);
  assert.equal(versions.length,3);const targetHeads=heads(vault);assert.equal(targetHeads.length,1);
  const restored=await readNote(user.id,vault,targetHeads[0]);assert.equal(restored.title,'Версия 2');
  assert.equal(restored.lifecycle.state,'archived');assert.equal(restored.reminder.state,'off');assert.notEqual(restored.reminder.id,reminder.id);
  assert.equal(restored.attachments[0].data,attachment.data);assert.ok((await readTags(user.id,vault)).some(tag=>tag.name==='Backup tag'));
});

test('Tasks note duplicate detection can skip or create another copy and imported reminders stay off',async()=>{
  const target=await createVault(user,'Target','abcdef'),tag={id:randomUUID(),name:'Imported tag',color:'#AABBCC',deleted:false,op:'000000000001-test'};
  const source={kind:'tasks-note-v1',vaultId:sourceId,objectId},reminder={id:randomUUID(),state:'active',local:'2026-12-20T09:30',mode:'neutral',text:''};
  const pkg={source,tags:[tag],note:{title:'Imported',text:'Body',tagIds:[tag.id],reminder}};
  assert.equal(await noteImportIsDuplicate(user,target,pkg),false);
  assert.deepEqual(await importPortableNote(user,target,pkg,'copy'),{imported:true,duplicate:false});
  assert.equal(await noteImportIsDuplicate(user,target,pkg),true);
  assert.deepEqual(await importPortableNote(user,target,pkg,'skip'),{imported:false,duplicate:true});
  assert.deepEqual(await importPortableNote(user,target,pkg,'copy'),{imported:true,duplicate:true});
  const state=await readState(user.id),vault=state.vaults.find(item=>item.header.id===target),current=heads(vault);
  assert.equal(current.length,2);
  for(const revision of current){const note=await readNote(user.id,vault,revision);assert.equal(note.reminder.state,'off');assert.deepEqual(note.importSource,source);}
  assert.ok((await readTags(user.id,vault)).some(item=>item.name==='Imported tag'));
});
