import { requireUser, AccountError, fail } from '../auth/accounts.mjs';
import { registerVaultAccess } from './vault-access.mjs';
import { registerReminders } from './reminders.mjs';
import { memberOf, ownerOf, writerOf } from '../collaboration.mjs';
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const obj = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const b64 = (min, max = min) => ({ type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: min, maxLength: max });
const sealed = obj({ v: { const: 2 }, key: b64(54), iv: b64(16), ciphertext: b64(22, 1398123) });
const wrapper = obj({ v: { const: 1 }, alg: { const: 'A256GCM' }, purpose: { const: 'phrase' },
  iv: b64(16), ciphertext: b64(64), kdf: obj({ name: { const: 'PBKDF2-SHA256' },
    iterations: { type: 'integer', minimum: 600000, maximum: 2000000 }, salt: b64(22) }) });
const header = obj({ id: uuid, keyId: uuid, revisionId: uuid, wrapper, name: sealed });
const displayName = { type:'string',minLength:1,maxLength:200,pattern:'\\S' };
const record = obj({ id: uuid, objectId: uuid, parent: { anyOf: [uuid, { type: 'null' }] }, sealed });
record.properties.resolves = { type:'array',minItems:1,maxItems:100,uniqueItems:true,items:uuid };
record.properties.keyEpoch = { type:'integer',minimum:0,maximum:1000000 };

export function registerVaults(app, db, { guard, accessOf, clock }) {
  const purgeExpired=()=>{
    const expired=db.prepare("SELECT vault_id,object_id,record_id FROM note_lifecycle WHERE state='trash' AND purge_after<=?").all(clock());
    for(const item of expired){
      db.prepare('DELETE FROM reminders WHERE vault_id=? AND object_id=?').run(item.vault_id,item.object_id);
      db.prepare('DELETE FROM comments WHERE vault_id=? AND object_id=?').run(item.vault_id,item.object_id);
      db.prepare('DELETE FROM personal_reminder_configs WHERE vault_id=? AND object_id=?').run(item.vault_id,item.object_id);
      db.prepare('DELETE FROM records WHERE vault_id=? AND object_id=?').run(item.vault_id,item.object_id);
      db.prepare("UPDATE note_lifecycle SET state='purged',changed_at=?,purge_after=NULL WHERE vault_id=? AND object_id=?").run(clock(),item.vault_id,item.object_id);
    }
    return expired.length;
  };
  purgeExpired();
  const cleanup=setInterval(()=>{try{db.exec('BEGIN IMMEDIATE');purgeExpired();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');app.log.error(error);}},3600000);
  cleanup.unref();app.addHook('onClose',async()=>clearInterval(cleanup));
  const member=(user,id,active=true)=>memberOf(db,user,id,active);
  const own=(user,id,active=true)=>ownerOf(db,user,id,active);
  const writer=(user,id,active=true)=>writerOf(db,user,id,active);
  function action(fn) { return (req, reply) => {
    try {
      const user = requireUser(db, accessOf(req), clock());
      if (req.headers['x-tasks-account'] !== user.id) fail('account_mismatch', 409);
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(req, user); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) { if (error instanceof AccountError) return reply.code(error.status).send({ error: error.code }); throw error; }
  }; }
  const post = (path, schema, fn) => app.post('/api/vaults/' + path,
    { bodyLimit: 1450000, preHandler: guard, schema: { body: schema } }, action(fn));
  const permit=registerVaultAccess(app,db,{member,own,action,post,obj,uuid,b64,sealed,guard,accessOf,clock});
  registerReminders(app,db,{action,guard,member,permit,clock});
  app.get('/api/vaults', action((_req, user) => ({ vaults: db.prepare(`SELECT v.*,m.role,v.user_id owner_id
      FROM vaults v JOIN vault_members m ON m.vault_id=v.id WHERE m.user_id=? ORDER BY v.id`).all(user.id)
    .map(v => {const ring=db.prepare('SELECT version,current_epoch,owner_box FROM vault_keyrings WHERE vault_id=?').get(v.id);
      const envelope=v.role==='owner'?null:db.prepare('SELECT keyring_version,identity_version,key_envelope FROM vault_member_envelopes WHERE vault_id=? AND user_id=?').get(v.id,user.id);
      return { id:v.id, deleted:Boolean(v.deleted), replacement:v.replacement, header:v.header?JSON.parse(v.header):null,
        displayName:v.deleted?null:db.prepare('SELECT display_name FROM vault_labels WHERE vault_id=?').get(v.id)?.display_name??null,
        epoch:v.lock_epoch,access:v.access_pack?JSON.parse(v.access_pack):null,role:v.role,ownerId:v.owner_id,
        shared:Boolean(ring),keyring:ring?{version:ring.version,currentEpoch:ring.current_epoch,...(v.role==='owner'?{ownerBox:JSON.parse(ring.owner_box)}:{})}:null,
        envelope:envelope?{keyringVersion:envelope.keyring_version,identityVersion:envelope.identity_version,keyEnvelope:JSON.parse(envelope.key_envelope)}:null};} ) })));
  app.get('/api/vaults/:id', { schema: { params: obj({ id: uuid }), querystring: { type: 'object', additionalProperties: false,
    properties: { after: { type: 'string', pattern: '^[0-9]{1,15}$' } } } } }, action((req, user) => {
    permit(req,member(user, req.params.id));
    const rows = db.prepare('SELECT rowid,payload,author_user_id,created_at FROM records WHERE vault_id=? AND rowid>? ORDER BY rowid LIMIT 5').all(req.params.id, Number(req.query.after ?? 0));
    return { records: rows.map(r => ({...JSON.parse(r.payload),authorUserId:r.author_user_id,createdAt:r.created_at})), next: rows.length === 5 ? rows.at(-1).rowid : null };
  }));
  app.get('/api/vaults/:id/objects',{schema:{params:obj({id:uuid})}},action((req,user)=>{
    permit(req,member(user,req.params.id));purgeExpired();
    return{objects:db.prepare('SELECT object_id,state,record_id,changed_at,purge_after FROM note_lifecycle WHERE vault_id=? ORDER BY object_id').all(req.params.id)
      .map(row=>({objectId:row.object_id,state:row.state,recordId:row.record_id,changedAt:row.changed_at,...(row.state==='trash'?{trashedAt:row.changed_at,purgeAfter:row.purge_after}:{} )}))};
  }));
  post('create', { ...header, properties: { ...header.properties, transferSource: uuid, displayName } }, (req, user) => {
    const { transferSource, displayName:label, ...value } = req.body;
    if (transferSource) permit(req,own(user, transferSource));
    const text = JSON.stringify(value), old = db.prepare('SELECT * FROM vaults WHERE id=?').get(req.body.id);
    if (old) {
      if (old.user_id !== user.id) fail('id_conflict', 409);
      if (old.deleted) fail('vault_deleted', 410);
      if (old.header !== text) fail('id_conflict', 409);
    } else {
      const count = db.prepare('SELECT count(*) n FROM vaults WHERE user_id=? AND deleted=0').get(user.id).n;
      if (count >= (transferSource ? 101 : 100)) fail('vault_limit', 409);
      db.prepare('INSERT INTO vaults(id,user_id,header) VALUES(?,?,?)').run(req.body.id, user.id, text);
      db.prepare("INSERT INTO vault_members(vault_id,user_id,role,joined_at) VALUES(?,?,'owner',?)").run(req.body.id,user.id,clock());
    }
    if(label)db.prepare('INSERT OR IGNORE INTO vault_labels(vault_id,display_name) VALUES(?,?)').run(value.id,label);
    return { ok: true };
  });
  post('label',obj({vaultId:uuid,displayName}),(req,user)=>{
    permit(req,own(user,req.body.vaultId));
    db.prepare('INSERT OR IGNORE INTO vault_labels(vault_id,display_name) VALUES(?,?)').run(req.body.vaultId,req.body.displayName);
    return {ok:true};
  });
  post('record', obj({ vaultId: uuid, record }), (req, user) => {
    const { vaultId, record: r } = req.body; const membership=writer(user,vaultId);permit(req,membership);
    const ring=db.prepare('SELECT current_epoch FROM vault_keyrings WHERE vault_id=?').get(vaultId),keyEpoch=r.keyEpoch??0;
    if(keyEpoch!==(ring?.current_epoch??0))fail('stale_key_epoch',409);
    if(db.prepare("SELECT 1 FROM note_lifecycle WHERE vault_id=? AND object_id=? AND state='purged'").get(vaultId,r.objectId))fail('object_deleted',410);
    const text = JSON.stringify(r), old = db.prepare('SELECT * FROM records WHERE id=?').get(r.id);
    if (old) {
      if (old.vault_id !== vaultId || old.payload !== text) fail('id_conflict', 409);
      return { ok: true };
    }
    if (r.parent) {
      const parent = db.prepare('SELECT * FROM records WHERE id=? AND vault_id=? AND object_id=?').get(r.parent, vaultId, r.objectId);
      if (!parent) fail('missing_parent', 409);
    }
    if(r.resolves){
      if(!r.parent||r.resolves.includes(r.parent)||r.resolves.includes(r.id))fail('invalid_request',400);
      for(const parent of r.resolves)if(!db.prepare('SELECT 1 FROM records WHERE id=? AND vault_id=? AND object_id=?').get(parent,vaultId,r.objectId))fail('missing_parent',409);
    }
    if (db.prepare('SELECT count(*) n FROM records WHERE vault_id=?').get(vaultId).n >= 10000) fail('record_limit', 409);
    if (db.prepare('SELECT coalesce(sum(length(payload)),0) n FROM records WHERE vault_id=?').get(vaultId).n + text.length > 64 * 1024 * 1024) fail('record_limit', 409);
    db.prepare('INSERT INTO records(id,vault_id,object_id,parent_id,payload,author_user_id,created_at) VALUES(?,?,?,?,?,?,?)').run(r.id,vaultId,r.objectId,r.parent,text,user.id,clock());
    return { ok: true };
  });
  post('object-state',obj({vaultId:uuid,objectId:uuid,recordId:uuid,expected:{anyOf:[uuid,{type:'null'}]},state:{enum:['active','trash']}}),(req,user)=>{
    const {vaultId,objectId,recordId,expected,state}=req.body;permit(req,writer(user,vaultId));purgeExpired();
    if(objectId===vaultId)fail('invalid_request',400);
    if(!db.prepare('SELECT 1 FROM records WHERE id=? AND vault_id=? AND object_id=?').get(recordId,vaultId,objectId))fail('missing_parent',409);
    const current=db.prepare('SELECT * FROM note_lifecycle WHERE vault_id=? AND object_id=?').get(vaultId,objectId);
    if(current?.state==='purged')fail('object_deleted',410);
    if(current?.record_id===recordId&&current.state===state)return{ok:true,object:{objectId,state,recordId,...(state==='trash'?{trashedAt:current.changed_at,purgeAfter:current.purge_after}:{})}};
    if((current?.record_id??null)!==expected)fail('object_state_conflict',409);
    const now=clock(),purgeAfter=state==='trash'?now+30*86400000:null;
    db.prepare(`INSERT INTO note_lifecycle(vault_id,object_id,state,record_id,changed_at,purge_after) VALUES(?,?,?,?,?,?)
      ON CONFLICT(vault_id,object_id) DO UPDATE SET state=excluded.state,record_id=excluded.record_id,changed_at=excluded.changed_at,purge_after=excluded.purge_after`)
      .run(vaultId,objectId,state,recordId,now,purgeAfter);
    if(state==='trash'){
      db.prepare("UPDATE reminders SET plan_state='off',paused=0 WHERE vault_id=? AND object_id=?").run(vaultId,objectId);
      db.prepare('DELETE FROM reminder_deliveries WHERE reminder_id IN(SELECT id FROM reminders WHERE vault_id=? AND object_id=?)').run(vaultId,objectId);
    }
    return{ok:true,object:{objectId,state,recordId,...(state==='trash'?{trashedAt:now,purgeAfter}:{})}};
  });
  post('purge-object',obj({vaultId:uuid,objectId:uuid,expected:uuid,confirmed:{const:true}}),(req,user)=>{
    const {vaultId,objectId,expected}=req.body;permit(req,own(user,vaultId));purgeExpired();
    if(objectId===vaultId)fail('invalid_request',400);
    const current=db.prepare('SELECT * FROM note_lifecycle WHERE vault_id=? AND object_id=?').get(vaultId,objectId);
    if(current?.state==='purged')return{ok:true};
    if(!current||current.state!=='trash'||current.record_id!==expected)fail('object_state_conflict',409);
    db.prepare('DELETE FROM reminders WHERE vault_id=? AND object_id=?').run(vaultId,objectId);
    db.prepare('DELETE FROM comments WHERE vault_id=? AND object_id=?').run(vaultId,objectId);
    db.prepare('DELETE FROM personal_reminder_configs WHERE vault_id=? AND object_id=?').run(vaultId,objectId);
    db.prepare('DELETE FROM records WHERE vault_id=? AND object_id=?').run(vaultId,objectId);
    db.prepare("UPDATE note_lifecycle SET state='purged',changed_at=?,purge_after=NULL WHERE vault_id=? AND object_id=?").run(clock(),vaultId,objectId);
    return{ok:true};
  });
  post('delete',obj({vaultId:uuid,confirmed:{const:true}}),(req,user)=>{
    const row=own(user,req.body.vaultId,false);
    if(row.deleted)return{ok:true};
    permit(req,row,true);
    db.prepare('DELETE FROM records WHERE vault_id=?').run(row.id);
    db.prepare('DELETE FROM note_lifecycle WHERE vault_id=?').run(row.id);
    db.prepare('UPDATE vaults SET deleted=1,header=NULL,access_pack=NULL,replacement=NULL WHERE id=?').run(row.id);
    db.prepare('DELETE FROM vault_grants WHERE vault_id=?').run(row.id);
    db.prepare('DELETE FROM vault_challenges WHERE vault_id=?').run(row.id);
    return{ok:true};
  });
  post('transfer', obj({ source: uuid, target: uuid, revisions: { type: 'array', maxItems: 10000, uniqueItems: true, items: uuid }, confirmed: { const: true } }), (req, user) => {
    const { source, target, revisions } = req.body;
    if (source === target) fail('invalid_request', 400);
    const from = own(user, source, false); permit(req,own(user, target));
    if (from.deleted) {
      if (from.replacement !== target) fail('id_conflict', 409);
      return { ok: true };
    }
    permit(req,from);
    for (const id of revisions) if (!db.prepare('SELECT 1 FROM records WHERE id=? AND vault_id=?').get(id, target)) fail('transfer_incomplete', 409);
    db.prepare('DELETE FROM records WHERE vault_id=?').run(source);
    db.prepare('UPDATE vaults SET deleted=1,header=NULL,access_pack=NULL,replacement=? WHERE id=?').run(target, source);
    db.prepare('DELETE FROM vault_grants WHERE vault_id=?').run(source);
    db.prepare('DELETE FROM vault_challenges WHERE vault_id=?').run(source);
    return { ok: true };
  });
  return{member,own,writer,permit,action,post,obj,uuid,b64,sealed};
}
