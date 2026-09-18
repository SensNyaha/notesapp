import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireUser, AccountError, fail } from '../auth/accounts.mjs';
import { diskUsage } from '../diagnostics.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK_PLAIN=1024*1024;
const CHUNK_MAX=CHUNK_PLAIN+12+16;
const STALE_MS=2*60*60*1000;

function safeId(value){if(typeof value!=='string'||!UUID.test(value))fail('invalid_request',400);return value;}
function base(root,...parts){const value=resolve(root,...parts),prefix=resolve(root)+sep;if(value!==resolve(root)&&!value.startsWith(prefix))throw Error('unsafe_path');return value;}
function chunkName(kind,index){return (kind==='preview'?'p':'c')+'-'+String(index).padStart(8,'0')+'.bin';}
function parseIndex(value,max){const index=Number(value);if(!Number.isSafeInteger(index)||index<0||index>=max)fail('invalid_request',400);return index;}
export function fileDiskPolicy(availablePercent){if(!Number.isFinite(availablePercent))return 'block';return availablePercent<=5?'block':availablePercent<=15?'warn':'ok';}
export function attachmentIdsForObject(db,vaultId,objectId){
  return db.prepare('SELECT DISTINCT attachment_id FROM record_attachments WHERE vault_id=? AND object_id=?').all(vaultId,objectId).map(row=>row.attachment_id);
}
export function collectUnreferencedAttachments(db,dataDir,vaultId,attachmentIds){
  const completeRoot=join(dataDir,'files','complete'),unique=[...new Set(attachmentIds)];
  for(const attachmentId of unique){
    const item=db.prepare('SELECT id FROM attachments WHERE id=? AND vault_id=?').get(attachmentId,vaultId);if(!item)continue;
    if(db.prepare('SELECT 1 FROM record_attachments WHERE vault_id=? AND attachment_id=? LIMIT 1').get(vaultId,attachmentId))continue;
    db.prepare('DELETE FROM attachments WHERE id=? AND vault_id=?').run(attachmentId,vaultId);
    db.prepare("DELETE FROM file_uploads WHERE attachment_id=? AND vault_id=? AND state='complete'").run(attachmentId,vaultId);
    setImmediate(()=>{try{if(!db.prepare('SELECT 1 FROM attachments WHERE id=? AND vault_id=?').get(attachmentId,vaultId))rmSync(base(completeRoot,vaultId,attachmentId),{recursive:true,force:true});}catch{}});
  }
}
export function removeVaultFiles(db,dataDir,vaultId){
  const tempRoot=join(dataDir,'files','tmp'),completeRoot=join(dataDir,'files','complete'),uploads=db.prepare('SELECT id FROM file_uploads WHERE vault_id=?').all(vaultId);
  db.prepare('DELETE FROM file_uploads WHERE vault_id=?').run(vaultId);db.prepare('DELETE FROM attachments WHERE vault_id=?').run(vaultId);
  setImmediate(()=>{try{
    for(const upload of uploads)if(!db.prepare('SELECT 1 FROM file_uploads WHERE id=?').get(upload.id))rmSync(base(tempRoot,upload.id),{recursive:true,force:true});
    if(!db.prepare('SELECT 1 FROM attachments WHERE vault_id=? LIMIT 1').get(vaultId))rmSync(base(completeRoot,vaultId),{recursive:true,force:true});
  }catch{}});
}

export function registerFiles(app,db,{guard,accessOf,clock,dataDir,member,own,writer,permit}){
  const filesRoot=join(dataDir,'files'),tempRoot=join(filesRoot,'tmp'),completeRoot=join(filesRoot,'complete');
  mkdirSync(tempRoot,{recursive:true});mkdirSync(completeRoot,{recursive:true});

  const cleanup=()=>{
    const cutoff=clock()-STALE_MS;
    const rows=db.prepare("SELECT id FROM file_uploads WHERE state='uploading' AND updated_at<?").all(cutoff);
    for(const row of rows){rmSync(base(tempRoot,row.id),{recursive:true,force:true});db.prepare('DELETE FROM file_uploads WHERE id=?').run(row.id);}
    db.prepare("DELETE FROM file_uploads WHERE state='complete' AND updated_at<?").run(clock()-24*60*60*1000);
    // Temporary directories and completed directories can survive a crash between filesystem and DB commits.
    for(const name of readdirSync(tempRoot)){if(!UUID.test(name))continue;const path=base(tempRoot,name);try{if(statSync(path).mtimeMs<cutoff&&!db.prepare('SELECT 1 FROM file_uploads WHERE id=?').get(name))rmSync(path,{recursive:true,force:true});}catch{}}
    for(const vaultId of readdirSync(completeRoot)){if(!UUID.test(vaultId))continue;const vaultDir=base(completeRoot,vaultId);for(const attachmentId of readdirSync(vaultDir)){if(!UUID.test(attachmentId))continue;
      if(!db.prepare('SELECT 1 FROM attachments WHERE id=? AND vault_id=?').get(attachmentId,vaultId))rmSync(base(vaultDir,attachmentId),{recursive:true,force:true});}}
    const deleted=db.prepare('SELECT id FROM vaults WHERE deleted=1').all();
    for(const vault of deleted){
      const uploads=db.prepare('SELECT id FROM file_uploads WHERE vault_id=?').all(vault.id);for(const upload of uploads)rmSync(base(tempRoot,upload.id),{recursive:true,force:true});
      rmSync(base(completeRoot,vault.id),{recursive:true,force:true});db.prepare('DELETE FROM file_uploads WHERE vault_id=?').run(vault.id);db.prepare('DELETE FROM attachments WHERE vault_id=?').run(vault.id);
    }
    return rows.length;
  };
  cleanup();const timer=setInterval(()=>{try{cleanup();}catch(error){app.log.error(error);}},60*60*1000);timer.unref();app.addHook('onClose',async()=>clearInterval(timer));

  const actor=(req)=>{
    const user=requireUser(db,accessOf(req),clock());
    if(req.headers['x-tasks-account']!==user.id)fail('account_mismatch',409);
    return user;
  };
  const credentials=(req,row)=>permit(req,row);

  app.post('/api/files/start',{preHandler:guard,schema:{body:{type:'object',additionalProperties:false,required:['vaultId','objectId','attachmentId','chunkCount','previewChunks','keyEpoch'],properties:{
    vaultId:{type:'string',pattern:UUID.source},objectId:{type:'string',pattern:UUID.source},attachmentId:{type:'string',pattern:UUID.source},
    chunkCount:{type:'integer',minimum:1},previewChunks:{type:'integer',minimum:0,maximum:64},keyEpoch:{type:'integer',minimum:0,maximum:1000000}
  }}}},async(req,reply)=>{
    try{
      const user=actor(req),row=writer(user,req.body.vaultId);credentials(req,row);const disk=fileDiskPolicy(diskUsage(dataDir).availablePercent);
      if(!Number.isSafeInteger(req.body.chunkCount))fail('invalid_request',400);if(disk==='block')return reply.code(507).send({error:'disk_critical'});
      const ring=db.prepare('SELECT current_epoch FROM vault_keyrings WHERE vault_id=?').get(row.id),epoch=ring?.current_epoch??0;
      if(req.body.keyEpoch!==epoch)fail('stale_key_epoch',409);
      if(db.prepare('SELECT 1 FROM attachments WHERE id=?').get(req.body.attachmentId))fail('id_conflict',409);
      const old=db.prepare("SELECT id FROM file_uploads WHERE vault_id=? AND attachment_id=? AND state='uploading'").get(row.id,req.body.attachmentId);
      if(old){rmSync(base(tempRoot,old.id),{recursive:true,force:true});db.prepare('DELETE FROM file_uploads WHERE id=?').run(old.id);}
      const id=randomUUID(),now=clock();mkdirSync(base(tempRoot,id),{recursive:false});
      db.prepare("INSERT INTO file_uploads(id,vault_id,object_id,attachment_id,user_id,key_epoch,chunk_count,preview_chunks,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'uploading',?,?)")
        .run(id,row.id,req.body.objectId,req.body.attachmentId,user.id,req.body.keyEpoch,req.body.chunkCount,req.body.previewChunks,now,now);
      return{uploadId:id,chunkSize:CHUNK_PLAIN,warning:disk==='warn'};
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
  });

  app.put('/api/files/:uploadId/:kind/:index',{preHandler:guard,bodyLimit:CHUNK_MAX,schema:{params:{type:'object',additionalProperties:false,required:['uploadId','kind','index'],properties:{
    uploadId:{type:'string',pattern:UUID.source},kind:{type:'string',enum:['data','preview']},index:{type:'string',pattern:'^[0-9]{1,16}$'}
  }}}},async(req,reply)=>{
    try{
      const user=actor(req),id=safeId(req.params.uploadId),upload=db.prepare("SELECT * FROM file_uploads WHERE id=? AND state='uploading'").get(id);
      if(!upload||upload.user_id!==user.id)fail('upload_not_found',404);
      const row=writer(user,upload.vault_id);credentials(req,row);
      const max=req.params.kind==='data'?upload.chunk_count:upload.preview_chunks,index=parseIndex(req.params.index,max);
      if(!Buffer.isBuffer(req.body)||req.body.length<28||req.body.length>CHUNK_MAX)fail('invalid_request',400);
      const finalPath=base(tempRoot,id,chunkName(req.params.kind,index));
      if(existsSync(finalPath)){db.prepare('UPDATE file_uploads SET updated_at=? WHERE id=?').run(clock(),id);return{ok:true};}
      const partial=base(tempRoot,id,'.'+chunkName(req.params.kind,index)+'.'+randomUUID()+'.part');
      try{writeFileSync(partial,req.body,{flag:'wx'});renameSync(partial,finalPath);}
      catch(error){rmSync(partial,{force:true});if(error?.code==='EEXIST'||error?.code==='EPERM'&&existsSync(finalPath))return{ok:true};if(error?.code==='ENOSPC')return reply.code(507).send({error:'disk_critical'});throw error;}
      db.prepare('UPDATE file_uploads SET updated_at=? WHERE id=?').run(clock(),id);
      return{ok:true};
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
  });

  app.post('/api/files/complete',{preHandler:guard,schema:{body:{type:'object',additionalProperties:false,required:['uploadId'],properties:{uploadId:{type:'string',pattern:UUID.source}}}}},async(req,reply)=>{
    try{
      const user=actor(req),id=req.body.uploadId,upload=db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id);
      if(!upload||upload.user_id!==user.id)fail('upload_not_found',404);
      const row=writer(user,upload.vault_id);credentials(req,row);
      if(upload.state==='complete'){if(db.prepare('SELECT 1 FROM attachments WHERE id=? AND vault_id=?').get(upload.attachment_id,upload.vault_id))return{ok:true};fail('upload_not_found',404);}
      const dir=base(tempRoot,id),names=readdirSync(dir),dataNames=names.filter(name=>/^c-[0-9]+\.bin$/.test(name)),previewNames=names.filter(name=>/^p-[0-9]+\.bin$/.test(name));
      if(dataNames.length!==upload.chunk_count||previewNames.length!==upload.preview_chunks||names.length!==dataNames.length+previewNames.length)fail('upload_incomplete',409);
      let bytes=0;for(const [kind,list,max] of [['data',dataNames,upload.chunk_count],['preview',previewNames,upload.preview_chunks]]){
        const seen=new Set();for(const name of list){const raw=name.slice(2,-4),index=Number(raw);if(!Number.isSafeInteger(index)||index<0||index>=max||name!==chunkName(kind,index)||seen.has(index))fail('upload_incomplete',409);seen.add(index);
          const n=statSync(base(dir,name)).size;if(n<28||n>CHUNK_MAX)fail('upload_incomplete',409);bytes+=n;}
      }
      const destination=base(completeRoot,upload.vault_id,upload.attachment_id);mkdirSync(base(completeRoot,upload.vault_id),{recursive:true});
      if(existsSync(destination))fail('id_conflict',409);renameSync(dir,destination);
      try{
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO attachments(id,vault_id,object_id,key_epoch,chunk_count,preview_chunks,ciphertext_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(upload.attachment_id,upload.vault_id,upload.object_id,upload.key_epoch,upload.chunk_count,upload.preview_chunks,bytes,clock());
        db.prepare("UPDATE file_uploads SET state='complete',updated_at=? WHERE id=?").run(clock(),id);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');rmSync(destination,{recursive:true,force:true});throw error;}
      return{ok:true};
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
  });

  app.get('/api/files/:vaultId/:attachmentId/:kind/:index',{schema:{params:{type:'object',additionalProperties:false,required:['vaultId','attachmentId','kind','index'],properties:{
    vaultId:{type:'string',pattern:UUID.source},attachmentId:{type:'string',pattern:UUID.source},kind:{type:'string',enum:['data','preview']},index:{type:'string',pattern:'^[0-9]{1,16}$'}
  }}}},async(req,reply)=>{
    try{
      const user=actor(req),row=member(user,req.params.vaultId);credentials(req,row);const item=db.prepare('SELECT * FROM attachments WHERE id=? AND vault_id=?').get(req.params.attachmentId,row.id);
      if(!item)fail('file_not_found',404);const max=req.params.kind==='data'?item.chunk_count:item.preview_chunks,index=parseIndex(req.params.index,max);
      const path=base(completeRoot,row.id,item.id,chunkName(req.params.kind,index));if(!existsSync(path))fail('file_not_found',404);
      reply.type('application/octet-stream').header('Cache-Control','no-store');return reply.send(createReadStream(path));
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
  });

  app.post('/api/files/transfer',{preHandler:guard,schema:{body:{type:'object',additionalProperties:false,required:['source','target','attachmentIds'],properties:{
    source:{type:'string',pattern:UUID.source},target:{type:'string',pattern:UUID.source},attachmentIds:{type:'array',maxItems:500,uniqueItems:true,items:{type:'string',pattern:UUID.source}}
  }}}},async(req,reply)=>{
    try{
      const user=actor(req);if(req.body.source===req.body.target)fail('invalid_request',400);
      const source=own(user,req.body.source,false),target=own(user,req.body.target);credentials(req,source);credentials(req,target);
      mkdirSync(base(completeRoot,target.id),{recursive:true});
      for(const attachmentId of req.body.attachmentIds){
        const row=db.prepare('SELECT * FROM attachments WHERE id=?').get(attachmentId);if(!row)fail('file_not_found',404);
        const destination=base(completeRoot,target.id,attachmentId);
        if(row.vault_id===target.id){if(!existsSync(destination))fail('file_not_found',404);continue;}
        if(row.vault_id!==source.id)fail('id_conflict',409);
        const from=base(completeRoot,source.id,attachmentId);if(!existsSync(from))fail('file_not_found',404);
        if(existsSync(destination))fail('id_conflict',409);
        renameSync(from,destination);
        try{
          db.prepare('UPDATE attachments SET vault_id=? WHERE id=? AND vault_id=?').run(target.id,attachmentId,source.id);
          db.prepare("UPDATE file_uploads SET vault_id=? WHERE attachment_id=? AND vault_id=? AND state='complete'").run(target.id,attachmentId,source.id);
        }catch(error){try{renameSync(destination,from);}catch{}throw error;}
      }
      return{ok:true};
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
  });

  app.post('/api/files/move',{preHandler:guard,schema:{body:{type:'object',additionalProperties:false,required:['vaultId','attachmentId','objectId'],properties:{
    vaultId:{type:'string',pattern:UUID.source},attachmentId:{type:'string',pattern:UUID.source},objectId:{type:'string',pattern:UUID.source}
  }}}},async(req,reply)=>{try{const user=actor(req),row=writer(user,req.body.vaultId);credentials(req,row);const result=db.prepare('UPDATE attachments SET object_id=? WHERE id=? AND vault_id=?').run(req.body.objectId,req.body.attachmentId,row.id);if(!result.changes)fail('file_not_found',404);return{ok:true};}catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}});

  app.post('/api/files/delete',{preHandler:guard,schema:{body:{type:'object',additionalProperties:false,required:['vaultId','attachmentId'],properties:{
    vaultId:{type:'string',pattern:UUID.source},attachmentId:{type:'string',pattern:UUID.source}
  }}}},async(req,reply)=>{try{const user=actor(req),row=writer(user,req.body.vaultId);credentials(req,row);const item=db.prepare('SELECT id FROM attachments WHERE id=? AND vault_id=?').get(req.body.attachmentId,row.id);if(!item)return{ok:true};
    if(db.prepare('SELECT 1 FROM record_attachments WHERE vault_id=? AND attachment_id=? LIMIT 1').get(row.id,item.id))return{ok:true,retained:true};
    db.prepare('DELETE FROM attachments WHERE id=?').run(item.id);db.prepare("DELETE FROM file_uploads WHERE attachment_id=? AND vault_id=? AND state='complete'").run(item.id,row.id);
    rmSync(base(completeRoot,row.id,item.id),{recursive:true,force:true});return{ok:true,retained:false};}catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}});

  return{cleanup};
}
