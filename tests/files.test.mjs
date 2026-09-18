import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { fileDiskPolicy } from '../server/routes/files.mjs';
import { generateVaultKey } from '../src/crypto/vault.ts';
import { rememberKey } from '../src/crypto/records.ts';
import { createFileKey,encryptFileChunk,decryptFileChunk,unwrapFileKey,rewrapFileKey,FILE_CHUNK_BYTES } from '../src/crypto/files.ts';

test('file disk policy warns below 15%, blocks at 5%, and recovers after space is freed',()=>{
  assert.equal(fileDiskPolicy(40),'ok');assert.equal(fileDiskPolicy(15),'warn');assert.equal(fileDiskPolicy(5),'block');assert.equal(fileDiskPolicy(6),'warn');assert.equal(fileDiskPolicy(20),'ok');assert.equal(fileDiskPolicy(Number.NaN),'block');
});

test('streaming file crypto authenticates vault, attachment, kind and chunk index',async()=>{
  const accountId=randomUUID(),vaultId=randomUUID(),attachmentId=randomUUID(),root=await rememberKey(await generateVaultKey());
  const {key,wrappedKey}=await createFileKey(root),unwrapped=await unwrapFileKey(root,wrappedKey),plain=new TextEncoder().encode('PRIVATE FILE BODY 1801');
  const encrypted=await encryptFileChunk(key,accountId,vaultId,attachmentId,'data',0,plain);
  assert.equal(encrypted.length,plain.length+28);assert.deepEqual(await decryptFileChunk(unwrapped,accountId,vaultId,attachmentId,'data',0,encrypted),plain);
  const targetRoot=await rememberKey(await generateVaultKey()),rewrapped=await rewrapFileKey(root,targetRoot,wrappedKey),targetKey=await unwrapFileKey(targetRoot,rewrapped);
  assert.deepEqual(await decryptFileChunk(targetKey,accountId,vaultId,attachmentId,'data',0,encrypted),plain);
  await assert.rejects(decryptFileChunk(unwrapped,accountId,vaultId,randomUUID(),'data',0,encrypted));
  await assert.rejects(decryptFileChunk(unwrapped,accountId,vaultId,attachmentId,'preview',0,encrypted));
  await assert.rejects(decryptFileChunk(unwrapped,accountId,vaultId,attachmentId,'data',1,encrypted));
  const damaged=encrypted.slice();damaged.at(-1);damaged[damaged.length-1]^=1;await assert.rejects(decryptFileChunk(unwrapped,accountId,vaultId,attachmentId,'data',0,damaged));
  const largest=new Uint8Array(FILE_CHUNK_BYTES);const sealed=await encryptFileChunk(key,accountId,vaultId,attachmentId,'data',3,largest);assert.equal(sealed.length,FILE_CHUNK_BYTES+28);
});

test('file API exposes only complete opaque attachments and cleans abandoned uploads',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tasks-files-')),credentials={login:'FilesAdmin',password:'Secret9Files'};let now=Date.now(),app;
  const jar=new Map();
  const startApp=async()=>createApp({dataDir:dir,logger:false,clock:()=>now,auth:{origin:'http://localhost:3100',secure:false,bootstrap:credentials}});
  const send=async(path,options={})=>{
    const cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
    const response=await app.inject({url:path,method:options.method??'GET',headers:{origin:'http://localhost:3100',cookie,...options.headers},payload:options.body});
    for(const c of response.cookies){if(c.value)jar.set(c.name,c.value);else jar.delete(c.name);}return response;
  };
  const csrf=async()=> (await send('/api/auth/csrf')).json().csrf;
  const post=async(path,body,account)=>send(path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':await csrf(),...(account?{'x-tasks-account':account}:{})},body:JSON.stringify(body)});
  try{
    app=await startApp();const user=(await post('/api/auth/login',credentials)).json().user,vid=randomUUID(),objectId=randomUUID(),attachmentId=randomUUID();
    const header={id:vid,keyId:randomUUID(),revisionId:randomUUID(),wrapper:{v:1,alg:'A256GCM',purpose:'phrase',iv:'A'.repeat(16),ciphertext:'B'.repeat(64),kdf:{name:'PBKDF2-SHA256',iterations:600000,salt:'C'.repeat(22)}},
      name:{v:2,key:'D'.repeat(54),iv:'E'.repeat(16),ciphertext:'F'.repeat(22)},displayName:'Files'};
    assert.equal((await post('/api/vaults/create',header,user.id)).statusCode,200);
    let started=await post('/api/files/start',{vaultId:vid,objectId,attachmentId,chunkCount:2,previewChunks:1,keyEpoch:0},user.id);assert.equal(started.statusCode,200);let uploadId=started.json().uploadId;
    const opaque0=Buffer.alloc(128,0xa1),opaque1=Buffer.alloc(64,0xb2),preview=Buffer.alloc(40,0xc3);
    const put=async(kind,index,body)=>send('/api/files/'+uploadId+'/'+kind+'/'+index,{method:'PUT',headers:{'content-type':'application/octet-stream','x-csrf-token':await csrf(),'x-tasks-account':user.id},body});
    assert.equal((await put('data',0,opaque0)).statusCode,200);
    assert.equal((await post('/api/files/complete',{uploadId},user.id)).statusCode,409);
    let db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM attachments').get().n,0);assert.equal(db.prepare("SELECT state FROM file_uploads WHERE id=?").get(uploadId).state,'uploading');db.close();
    assert.equal((await put('data',1,opaque1)).statusCode,200);assert.equal((await put('preview',0,preview)).statusCode,200);
    assert.equal((await post('/api/files/complete',{uploadId},user.id)).statusCode,200);
    assert.equal((await post('/api/files/complete',{uploadId},user.id)).statusCode,200,'complete is idempotent after a lost response');
    const getHeaders={'x-tasks-account':user.id};
    const downloaded=await send('/api/files/'+vid+'/'+attachmentId+'/data/0',{headers:getHeaders});assert.equal(downloaded.statusCode,200);assert.deepEqual(downloaded.rawPayload,opaque0);
    db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});const row=db.prepare('SELECT * FROM attachments WHERE id=?').get(attachmentId);assert.equal(row.object_id,objectId);assert.equal(row.chunk_count,2);assert.equal(row.preview_chunks,1);db.close();
    const target=randomUUID();assert.equal((await post('/api/files/move',{vaultId:vid,attachmentId,objectId:target},user.id)).statusCode,200);
    db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT object_id FROM attachments WHERE id=?').get(attachmentId).object_id,target);db.close();
    const targetVault=randomUUID(),targetHeader={...header,id:targetVault,keyId:randomUUID(),revisionId:randomUUID(),displayName:'Target files'};
    assert.equal((await post('/api/vaults/create',targetHeader,user.id)).statusCode,200);
    assert.equal((await post('/api/files/transfer',{source:vid,target:targetVault,attachmentIds:[attachmentId]},user.id)).statusCode,200);
    assert.equal((await post('/api/files/transfer',{source:vid,target:targetVault,attachmentIds:[attachmentId]},user.id)).statusCode,200,'file transfer is idempotent');
    const transferred=await send('/api/files/'+targetVault+'/'+attachmentId+'/data/0',{headers:getHeaders});assert.equal(transferred.statusCode,200);assert.deepEqual(transferred.rawPayload,opaque0);
    db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT vault_id FROM attachments WHERE id=?').get(attachmentId).vault_id,targetVault);db.close();

    // Immutable history/copies can share one physical ciphertext file. Purging one object must
    // keep the file while another synced record references it, then GC it after the last ref.
    const copyObject=randomUUID(),recordA={id:randomUUID(),objectId:target,parent:null,sealed:header.name},recordB={id:randomUUID(),objectId:copyObject,parent:null,sealed:header.name};
    assert.equal((await post('/api/vaults/record',{vaultId:targetVault,record:recordA,attachmentIds:[attachmentId]},user.id)).statusCode,200);
    assert.equal((await post('/api/vaults/record',{vaultId:targetVault,record:recordB,attachmentIds:[attachmentId]},user.id)).statusCode,200);
    db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM record_attachments WHERE attachment_id=?').get(attachmentId).n,2);db.close();
    assert.equal((await post('/api/vaults/object-state',{vaultId:targetVault,objectId:target,recordId:recordA.id,expected:null,state:'trash'},user.id)).statusCode,200);
    assert.equal((await post('/api/vaults/purge-object',{vaultId:targetVault,objectId:target,expected:recordA.id,confirmed:true},user.id)).statusCode,200);
    assert.equal((await send('/api/files/'+targetVault+'/'+attachmentId+'/data/0',{headers:getHeaders})).statusCode,200);
    let retained=await post('/api/files/delete',{vaultId:targetVault,attachmentId},user.id);assert.equal(retained.statusCode,200);assert.equal(retained.json().retained,true);
    assert.equal((await post('/api/vaults/object-state',{vaultId:targetVault,objectId:copyObject,recordId:recordB.id,expected:null,state:'trash'},user.id)).statusCode,200);
    assert.equal((await post('/api/vaults/purge-object',{vaultId:targetVault,objectId:copyObject,expected:recordB.id,confirmed:true},user.id)).statusCode,200);
    db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT 1 FROM attachments WHERE id=?').get(attachmentId),undefined);assert.equal(db.prepare('SELECT count(*) n FROM record_attachments WHERE attachment_id=?').get(attachmentId).n,0);db.close();

    const abandoned=randomUUID();started=await post('/api/files/start',{vaultId:vid,objectId,attachmentId:abandoned,chunkCount:1_000_001,previewChunks:0,keyEpoch:0},user.id);uploadId=started.json().uploadId;
    assert.equal((await put('data',0,Buffer.alloc(32,7))).statusCode,200);await app.close();app=null;now+=3*60*60*1000;app=await startApp();await post('/api/auth/login',credentials);
    db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT 1 FROM file_uploads WHERE id=?').get(uploadId),undefined);db.close();
    await assert.rejects(stat(join(dir,'files','tmp',uploadId)));
    const deletedAgain=await post('/api/files/delete',{vaultId:targetVault,attachmentId},user.id);assert.equal(deletedAgain.statusCode,200);assert.equal(deletedAgain.json().ok,true);
    db=new DatabaseSync(join(dir,'tasks.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT 1 FROM attachments WHERE id=?').get(attachmentId),undefined);db.close();
  }finally{if(app)await app.close();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:75});}
});
