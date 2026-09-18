import { createHash, randomUUID } from 'node:crypto';
import { requireUser, AccountError, fail } from '../auth/accounts.mjs';
import { normalizeLogin, verifyPassword } from '../auth/password.mjs';
import { areContacts, enqueueCollaborationPush, pair } from '../collaboration.mjs';

const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const obj=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const b64=(min,max=min)=>({type:'string',pattern:'^[A-Za-z0-9_-]+$',minLength:min,maxLength:max});
const pub=obj({kty:{const:'EC'},crv:{const:'P-256'},x:b64(43),y:b64(43)});
const gcm=(purpose,max=65536)=>obj({v:{const:1},purpose:{const:purpose},alg:{const:'A256GCM'},iv:b64(16),ciphertext:b64(22,max)});
const passwordWrapper=obj({v:{const:1},purpose:{const:'collaboration-password'},alg:{const:'A256GCM'},
  iv:b64(16),ciphertext:b64(64),kdf:obj({name:{const:'PBKDF2-SHA256'},iterations:{type:'integer',minimum:600000,maximum:2000000},salt:b64(22)})});
const privateBox=gcm('collaboration-private-key',8192);
const sealed=obj({v:{const:2},key:b64(54),iv:b64(16),ciphertext:b64(22,1398123)});
const ownerBox=sealed;
const personalReminder=obj({v:{const:1},purpose:{const:'personal-reminder'},alg:{const:'A256GCM'},iv:b64(16),ciphertext:b64(22,16384)});
const envelope=obj({v:{const:1},purpose:{const:'vault-keyring-member'},alg:{const:'ECDH-P256+HKDF-SHA256+A256GCM'},
  ephemeralPublicKey:pub,salt:b64(43),iv:b64(16),ciphertext:b64(22,65536),recipientFingerprint:b64(43)});
const role={enum:['editor','viewer']};
const fingerprint=key=>createHash('sha256').update(JSON.stringify({kty:key.kty,crv:key.crv,x:key.x,y:key.y})).digest('base64url');
const identityRow=row=>row?{version:row.version,publicKey:JSON.parse(row.public_key),privateBox:JSON.parse(row.private_box),
  passwordWrapper:JSON.parse(row.password_wrapper),createdAt:row.created_at,updatedAt:row.updated_at}:null;
const publicIdentity=row=>row?{version:row.version,publicKey:JSON.parse(row.public_key),fingerprint:fingerprint(JSON.parse(row.public_key))}:null;

export function registerCollaboration(app,db,{guard,accessOf,clock,vaultAccess}){
  const {member,own,permit,action}=vaultAccess;
  const post=(path,schema,fn)=>app.post('/api/collaboration/'+path,{bodyLimit:1450000,preHandler:guard,schema:{body:schema}},action(fn));
  const passwordPost=(path,schema,fn)=>app.post('/api/collaboration/'+path,{bodyLimit:1450000,preHandler:guard,schema:{body:schema}},async(req,reply)=>{
    try{
      const user=requireUser(db,accessOf(req),clock(),{allowTemporary:true});if(req.headers['x-tasks-account']!==user.id)fail('account_mismatch',409);
      const credential=db.prepare('SELECT password_hash,credential_version FROM users WHERE id=?').get(user.id);
      if(!credential||!await verifyPassword(credential.password_hash,req.body.password))fail('wrong_password',403);
      db.exec('BEGIN IMMEDIATE');
      try{
        const current=requireUser(db,accessOf(req),clock(),{allowTemporary:true});
        if(current.id!==user.id||db.prepare('SELECT credential_version FROM users WHERE id=?').get(user.id).credential_version!==credential.credential_version)fail('account_changed',409);
        const result=fn(req,current);db.exec('COMMIT');return result;
      }catch(error){db.exec('ROLLBACK');throw error;}
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
  });
  const identity=user=>db.prepare('SELECT * FROM collaboration_identities WHERE user_id=?').get(user.id);
  const identityOf=id=>db.prepare('SELECT * FROM collaboration_identities WHERE user_id=?').get(id);
  const userPublic=id=>{const row=db.prepare('SELECT id,login FROM users WHERE id=?').get(id);return row?{id:row.id,login:row.login}:null;};

  app.get('/api/collaboration/identity',action((_req,user)=>({identity:identityRow(identity(user))})));
  passwordPost('identity/setup',obj({password:{type:'string',maxLength:256},version:{const:1},publicKey:pub,privateBox,passwordWrapper}),(req,user)=>{
    if(identity(user))fail('identity_exists',409);const now=clock();
    db.prepare('INSERT INTO collaboration_identities VALUES(?,?,?,?,?,?,?)').run(user.id,1,JSON.stringify(req.body.publicKey),
      JSON.stringify(req.body.privateBox),JSON.stringify(req.body.passwordWrapper),now,now);
    return{identity:identityRow(identity(user))};
  });
  passwordPost('identity/rewrap',obj({password:{type:'string',maxLength:256},expectedVersion:{type:'integer',minimum:1},passwordWrapper}),(req,user)=>{
    const row=identity(user);if(!row)fail('identity_missing',404);if(row.version!==req.body.expectedVersion)fail('identity_changed',409);
    db.prepare('UPDATE collaboration_identities SET password_wrapper=?,updated_at=? WHERE user_id=? AND version=?')
      .run(JSON.stringify(req.body.passwordWrapper),clock(),user.id,row.version);
    return{ok:true};
  });
  passwordPost('identity/replace',obj({password:{type:'string',maxLength:256},expectedVersion:{type:'integer',minimum:1},version:{type:'integer',minimum:2},publicKey:pub,privateBox,passwordWrapper,confirmed:{const:true}}),(req,user)=>{
    const row=identity(user);if(!row)fail('identity_missing',404);
    if(row.version!==req.body.expectedVersion||req.body.version!==row.version+1)fail('identity_changed',409);
    db.prepare('UPDATE collaboration_identities SET version=?,public_key=?,private_box=?,password_wrapper=?,updated_at=? WHERE user_id=? AND version=?')
      .run(req.body.version,JSON.stringify(req.body.publicKey),JSON.stringify(req.body.privateBox),JSON.stringify(req.body.passwordWrapper),clock(),user.id,row.version);
    // Recovery replacement creates a new collaboration root/private key. Old recipient envelopes and
    // personal reminder boxes are intentionally invalidated; memberships/contacts remain for explicit regrant.
    db.prepare('DELETE FROM vault_member_envelopes WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM vault_invites WHERE recipient_id=?').run(user.id);
    db.prepare('DELETE FROM personal_reminder_configs WHERE user_id=?').run(user.id);
    const contactIds=db.prepare('SELECT user_a,user_b FROM contacts WHERE user_a=? OR user_b=?').all(user.id,user.id)
      .map(x=>x.user_a===user.id?x.user_b:x.user_a);
    for(const contactId of new Set(contactIds))enqueueCollaborationPush(db,contactId,'key_changed',null,null,clock());
    return{identity:identityRow(identity(user))};
  });

  post('users/find',obj({login:{type:'string',maxLength:32}}),(req,user)=>{
    const login=normalizeLogin(req.body.login);if(!login)fail('account_not_found',404);
    const target=db.prepare('SELECT id,login FROM users WHERE login=?').get(login);
    if(!target||target.id===user.id)fail('account_not_found',404);
    return{user:target,identity:publicIdentity(identityOf(target.id))};
  });

  app.get('/api/collaboration/contacts',action((_req,user)=>{
    const contacts=db.prepare(`SELECT CASE WHEN user_a=? THEN user_b ELSE user_a END id,created_at FROM contacts
      WHERE user_a=? OR user_b=? ORDER BY created_at DESC`).all(user.id,user.id,user.id).map(row=>({
        ...userPublic(row.id),createdAt:row.created_at,identity:publicIdentity(identityOf(row.id))
      }));
    const incoming=db.prepare(`SELECT r.id,r.sender_id user_id,r.created_at,u.login FROM contact_requests r JOIN users u ON u.id=r.sender_id
      WHERE r.recipient_id=? ORDER BY r.created_at DESC`).all(user.id).map(r=>({id:r.id,user:{id:r.user_id,login:r.login},createdAt:r.created_at}));
    const outgoing=db.prepare(`SELECT r.id,r.recipient_id user_id,r.created_at,u.login FROM contact_requests r JOIN users u ON u.id=r.recipient_id
      WHERE r.sender_id=? ORDER BY r.created_at DESC`).all(user.id).map(r=>({id:r.id,user:{id:r.user_id,login:r.login},createdAt:r.created_at}));
    return{contacts,incoming,outgoing};
  }));
  post('contacts/request',obj({userId:uuid}),(req,user)=>{
    if(req.body.userId===user.id||!db.prepare('SELECT 1 FROM users WHERE id=?').get(req.body.userId))fail('account_not_found',404);
    if(areContacts(db,user.id,req.body.userId))return{ok:true};
    if(db.prepare('SELECT 1 FROM contact_requests WHERE sender_id=? AND recipient_id=?').get(req.body.userId,user.id))fail('incoming_request_exists',409);
    const existing=db.prepare('SELECT id FROM contact_requests WHERE sender_id=? AND recipient_id=?').get(user.id,req.body.userId);
    if(existing)return{ok:true,id:existing.id};
    const id=randomUUID();db.prepare('INSERT INTO contact_requests VALUES(?,?,?,?)').run(id,user.id,req.body.userId,clock());
    enqueueCollaborationPush(db,req.body.userId,'friend_request',null,null,clock());return{ok:true,id};
  });
  post('contacts/accept',obj({requestId:uuid}),(req,user)=>{
    const request=db.prepare('SELECT * FROM contact_requests WHERE id=? AND recipient_id=?').get(req.body.requestId,user.id);
    if(!request)fail('request_missing',404);const [a,b]=pair(request.sender_id,request.recipient_id);
    db.prepare('INSERT OR IGNORE INTO contacts VALUES(?,?,?)').run(a,b,clock());db.prepare('DELETE FROM contact_requests WHERE id=?').run(request.id);
    return{ok:true};
  });
  post('contacts/reject',obj({requestId:uuid}),(req,user)=>{
    const result=db.prepare('DELETE FROM contact_requests WHERE id=? AND recipient_id=?').run(req.body.requestId,user.id);
    if(!result.changes)fail('request_missing',404);return{ok:true};
  });
  post('contacts/cancel',obj({requestId:uuid}),(req,user)=>{
    const result=db.prepare('DELETE FROM contact_requests WHERE id=? AND sender_id=?').run(req.body.requestId,user.id);
    if(!result.changes)fail('request_missing',404);return{ok:true};
  });
  post('contacts/remove',obj({userId:uuid,confirmed:{const:true}}),(req,user)=>{
    const [a,b]=pair(user.id,req.body.userId);const result=db.prepare('DELETE FROM contacts WHERE user_a=? AND user_b=?').run(a,b);
    if(!result.changes)fail('contact_missing',404);return{ok:true};
  });

  post('vaults/keyring/setup',obj({vaultId:uuid,version:{const:1},currentEpoch:{const:0},ownerBox}),(req,user)=>{
    own(user,req.body.vaultId);if(db.prepare('SELECT 1 FROM vault_keyrings WHERE vault_id=?').get(req.body.vaultId))fail('keyring_exists',409);
    db.prepare('INSERT INTO vault_keyrings VALUES(?,?,?,?,?)').run(req.body.vaultId,1,0,JSON.stringify(req.body.ownerBox),clock());return{ok:true};
  });
  app.get('/api/collaboration/invites',action((_req,user)=>({invites:db.prepare(`SELECT i.*,u.login inviter_login,l.display_name
      FROM vault_invites i JOIN users u ON u.id=i.inviter_id LEFT JOIN vault_labels l ON l.vault_id=i.vault_id
      WHERE i.recipient_id=? ORDER BY i.created_at DESC`).all(user.id).map(i=>({
        id:i.id,vaultId:i.vault_id,inviter:{id:i.inviter_id,login:i.inviter_login},displayName:i.display_name??'Совместное хранилище',
        role:i.role,keyringVersion:i.keyring_version,identityVersion:i.identity_version,keyEnvelope:JSON.parse(i.key_envelope),createdAt:i.created_at
      }))})));
  post('vaults/invite',obj({vaultId:uuid,userId:uuid,role,keyringVersion:{type:'integer',minimum:1},identityVersion:{type:'integer',minimum:1},keyEnvelope:envelope}),(req,user)=>{
    const vault=own(user,req.body.vaultId);if(!areContacts(db,user.id,req.body.userId))fail('contact_required',409);
    if(db.prepare('SELECT 1 FROM vault_members WHERE vault_id=? AND user_id=?').get(vault.id,req.body.userId))fail('already_member',409);
    const ring=db.prepare('SELECT * FROM vault_keyrings WHERE vault_id=?').get(vault.id);if(!ring||ring.version!==req.body.keyringVersion)fail('keyring_changed',409);
    const target=identityOf(req.body.userId);if(!target||target.version!==req.body.identityVersion)fail('identity_changed',409);
    if(req.body.keyEnvelope.recipientFingerprint!==fingerprint(JSON.parse(target.public_key)))fail('identity_changed',409);
    db.prepare('DELETE FROM vault_invites WHERE vault_id=? AND recipient_id=?').run(vault.id,req.body.userId);
    const id=randomUUID();db.prepare('INSERT INTO vault_invites VALUES(?,?,?,?,?,?,?,?,?)').run(id,vault.id,user.id,req.body.userId,req.body.role,
      ring.version,target.version,JSON.stringify(req.body.keyEnvelope),clock());
    enqueueCollaborationPush(db,req.body.userId,'vault_invite',vault.id,null,clock());return{ok:true,id};
  });
  post('vaults/invite/accept',obj({inviteId:uuid}),(req,user)=>{
    const invite=db.prepare('SELECT * FROM vault_invites WHERE id=? AND recipient_id=?').get(req.body.inviteId,user.id);if(!invite)fail('invite_missing',404);
    const ring=db.prepare('SELECT * FROM vault_keyrings WHERE vault_id=?').get(invite.vault_id),current=identity(user);
    if(!ring||ring.version!==invite.keyring_version||!current||current.version!==invite.identity_version)fail('invite_stale',409);
    db.prepare('INSERT OR REPLACE INTO vault_members(vault_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(invite.vault_id,user.id,invite.role,clock());
    db.prepare('INSERT OR REPLACE INTO vault_member_envelopes VALUES(?,?,?,?,?,?)').run(invite.vault_id,user.id,ring.version,current.version,invite.key_envelope,clock());
    db.prepare('DELETE FROM vault_invites WHERE id=?').run(invite.id);return{ok:true,vaultId:invite.vault_id};
  });
  post('vaults/invite/reject',obj({inviteId:uuid}),(req,user)=>{
    const result=db.prepare('DELETE FROM vault_invites WHERE id=? AND recipient_id=?').run(req.body.inviteId,user.id);if(!result.changes)fail('invite_missing',404);return{ok:true};
  });
  post('vaults/invite/cancel',obj({inviteId:uuid}),(req,user)=>{
    const invite=db.prepare('SELECT * FROM vault_invites WHERE id=?').get(req.body.inviteId);if(!invite)fail('invite_missing',404);own(user,invite.vault_id);
    db.prepare('DELETE FROM vault_invites WHERE id=?').run(invite.id);return{ok:true};
  });
  app.get('/api/collaboration/vaults/:id/members',{schema:{params:obj({id:uuid})}},action((req,user)=>{
    member(user,req.params.id);return{members:db.prepare(`SELECT m.user_id,m.role,m.joined_at,u.login FROM vault_members m JOIN users u ON u.id=m.user_id
      WHERE m.vault_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,u.login`).all(req.params.id)
      .map(m=>({user:{id:m.user_id,login:m.login},role:m.role,joinedAt:m.joined_at,identity:publicIdentity(identityOf(m.user_id))}))};
  }));
  post('vaults/member/role',obj({vaultId:uuid,userId:uuid,role}),(req,user)=>{
    own(user,req.body.vaultId);const current=db.prepare('SELECT role FROM vault_members WHERE vault_id=? AND user_id=?').get(req.body.vaultId,req.body.userId);
    if(!current||current.role==='owner')fail('member_missing',404);db.prepare('UPDATE vault_members SET role=? WHERE vault_id=? AND user_id=?').run(req.body.role,req.body.vaultId,req.body.userId);
    enqueueCollaborationPush(db,req.body.userId,'role_changed',req.body.vaultId,null,clock());return{ok:true};
  });
  post('vaults/member/regrant',obj({vaultId:uuid,userId:uuid,keyringVersion:{type:'integer',minimum:1},identityVersion:{type:'integer',minimum:1},keyEnvelope:envelope}),(req,user)=>{
    own(user,req.body.vaultId);const m=db.prepare("SELECT role FROM vault_members WHERE vault_id=? AND user_id=? AND role<>'owner'").get(req.body.vaultId,req.body.userId);
    if(!m)fail('member_missing',404);const ring=db.prepare('SELECT * FROM vault_keyrings WHERE vault_id=?').get(req.body.vaultId),target=identityOf(req.body.userId);
    if(!ring||ring.version!==req.body.keyringVersion||!target||target.version!==req.body.identityVersion||req.body.keyEnvelope.recipientFingerprint!==fingerprint(JSON.parse(target.public_key)))fail('identity_changed',409);
    db.prepare(`INSERT INTO vault_member_envelopes VALUES(?,?,?,?,?,?) ON CONFLICT(vault_id,user_id) DO UPDATE SET
      keyring_version=excluded.keyring_version,identity_version=excluded.identity_version,key_envelope=excluded.key_envelope,updated_at=excluded.updated_at`)
      .run(req.body.vaultId,req.body.userId,ring.version,target.version,JSON.stringify(req.body.keyEnvelope),clock());
    enqueueCollaborationPush(db,req.body.userId,'key_changed',req.body.vaultId,null,clock());return{ok:true};
  });
  const rotationEnvelope=obj({userId:uuid,identityVersion:{type:'integer',minimum:1},keyEnvelope:envelope});
  post('vaults/member/remove',obj({vaultId:uuid,userId:uuid,expectedVersion:{type:'integer',minimum:1},newVersion:{type:'integer',minimum:2},
    currentEpoch:{type:'integer',minimum:1},ownerBox,envelopes:{type:'array',maxItems:100,items:rotationEnvelope},confirmed:{const:true}}),(req,user)=>{
    own(user,req.body.vaultId);const target=db.prepare("SELECT role FROM vault_members WHERE vault_id=? AND user_id=? AND role<>'owner'").get(req.body.vaultId,req.body.userId);
    if(!target)fail('member_missing',404);const ring=db.prepare('SELECT * FROM vault_keyrings WHERE vault_id=?').get(req.body.vaultId);
    if(!ring||ring.version!==req.body.expectedVersion||req.body.newVersion!==ring.version+1||req.body.currentEpoch!==ring.current_epoch+1)fail('keyring_changed',409);
    const remaining=db.prepare("SELECT user_id FROM vault_members WHERE vault_id=? AND role<>'owner' AND user_id<>? ORDER BY user_id").all(req.body.vaultId,req.body.userId).map(x=>x.user_id);
    const supplied=[...req.body.envelopes].sort((a,b)=>a.userId.localeCompare(b.userId));if(JSON.stringify(supplied.map(x=>x.userId))!==JSON.stringify(remaining))fail('invalid_rotation',400);
    for(const item of supplied){const targetIdentity=identityOf(item.userId);if(!targetIdentity||targetIdentity.version!==item.identityVersion||item.keyEnvelope.recipientFingerprint!==fingerprint(JSON.parse(targetIdentity.public_key)))fail('identity_changed',409);}
    enqueueCollaborationPush(db,req.body.userId,'member_removed',req.body.vaultId,null,clock());
    db.prepare('DELETE FROM vault_grants WHERE vault_id=? AND user_id=?').run(req.body.vaultId,req.body.userId);
    db.prepare('DELETE FROM vault_challenges WHERE vault_id=? AND user_id=?').run(req.body.vaultId,req.body.userId);
    db.prepare('DELETE FROM vault_member_envelopes WHERE vault_id=? AND user_id=?').run(req.body.vaultId,req.body.userId);
    db.prepare('DELETE FROM vault_members WHERE vault_id=? AND user_id=?').run(req.body.vaultId,req.body.userId);
    db.prepare('DELETE FROM vault_invites WHERE vault_id=?').run(req.body.vaultId);
    db.prepare('UPDATE vault_keyrings SET version=?,current_epoch=?,owner_box=?,updated_at=? WHERE vault_id=?')
      .run(req.body.newVersion,req.body.currentEpoch,JSON.stringify(req.body.ownerBox),clock(),req.body.vaultId);
    for(const item of supplied){db.prepare('UPDATE vault_member_envelopes SET keyring_version=?,identity_version=?,key_envelope=?,updated_at=? WHERE vault_id=? AND user_id=?')
      .run(req.body.newVersion,item.identityVersion,JSON.stringify(item.keyEnvelope),clock(),req.body.vaultId,item.userId);enqueueCollaborationPush(db,item.userId,'key_changed',req.body.vaultId,null,clock());}
    return{ok:true,version:req.body.newVersion,currentEpoch:req.body.currentEpoch};
  });
  post('vaults/leave',obj({vaultId:uuid,confirmed:{const:true}}),(req,user)=>{
    const row=member(user,req.body.vaultId);if(row.role==='owner')fail('owner_cannot_leave',409);
    db.prepare('DELETE FROM vault_grants WHERE vault_id=? AND user_id=?').run(req.body.vaultId,user.id);
    db.prepare('DELETE FROM vault_challenges WHERE vault_id=? AND user_id=?').run(req.body.vaultId,user.id);
    db.prepare('DELETE FROM vault_member_envelopes WHERE vault_id=? AND user_id=?').run(req.body.vaultId,user.id);
    db.prepare('DELETE FROM vault_members WHERE vault_id=? AND user_id=?').run(req.body.vaultId,user.id);
    return{ok:true};
  });

  app.get('/api/collaboration/reminder-configs/:vaultId',{schema:{params:obj({vaultId:uuid})}},action((req,user)=>{
    const vault=member(user,req.params.vaultId);permit(req,vault);
    return{items:db.prepare('SELECT object_id,revision_id,payload,updated_at FROM personal_reminder_configs WHERE user_id=? AND vault_id=? ORDER BY object_id')
      .all(user.id,req.params.vaultId).map(row=>({objectId:row.object_id,revisionId:row.revision_id,payload:JSON.parse(row.payload),updatedAt:row.updated_at}))};
  }));
  post('reminder-configs/set',obj({vaultId:uuid,objectId:uuid,revisionId:uuid,payload:personalReminder}),(req,user)=>{
    const vault=member(user,req.body.vaultId);permit(req,vault);
    if(!db.prepare('SELECT 1 FROM records WHERE vault_id=? AND object_id=?').get(req.body.vaultId,req.body.objectId))fail('note_missing',404);
    db.prepare(`INSERT INTO personal_reminder_configs(user_id,vault_id,object_id,revision_id,payload,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,vault_id,object_id) DO UPDATE SET
      revision_id=excluded.revision_id,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(user.id,req.body.vaultId,req.body.objectId,req.body.revisionId,JSON.stringify(req.body.payload),clock());
    return{ok:true};
  });
  post('reminder-configs/delete',obj({vaultId:uuid,objectId:uuid}),(req,user)=>{
    const vault=member(user,req.body.vaultId);permit(req,vault);
    db.prepare('DELETE FROM personal_reminder_configs WHERE user_id=? AND vault_id=? AND object_id=?').run(user.id,req.body.vaultId,req.body.objectId);
    return{ok:true};
  });

  app.get('/api/collaboration/comments/:vaultId/:objectId',{schema:{params:obj({vaultId:uuid,objectId:uuid})}},action((req,user)=>{
    const vault=member(user,req.params.vaultId);permit(req,vault);
    return{comments:db.prepare(`SELECT c.*,u.login FROM comments c JOIN users u ON u.id=c.author_user_id
      WHERE c.vault_id=? AND c.object_id=? ORDER BY c.created_at,c.id`).all(req.params.vaultId,req.params.objectId)
      .map(c=>({id:c.id,vaultId:c.vault_id,objectId:c.object_id,author:{id:c.author_user_id,login:c.login},keyEpoch:c.key_epoch,
        payload:JSON.parse(c.payload),createdAt:c.created_at,updatedAt:c.updated_at}))};
  }));
  post('comments/create',obj({id:uuid,vaultId:uuid,objectId:uuid,keyEpoch:{type:'integer',minimum:0},payload:sealed}),(req,user)=>{
    const vault=member(user,req.body.vaultId);permit(req,vault);
    if(!db.prepare('SELECT 1 FROM records WHERE vault_id=? AND object_id=?').get(req.body.vaultId,req.body.objectId))fail('note_missing',404);
    const ring=db.prepare('SELECT current_epoch FROM vault_keyrings WHERE vault_id=?').get(req.body.vaultId);if(req.body.keyEpoch!==(ring?.current_epoch??0))fail('stale_key_epoch',409);
    const existing=db.prepare('SELECT * FROM comments WHERE id=?').get(req.body.id);if(existing){if(existing.vault_id!==req.body.vaultId||existing.author_user_id!==user.id||existing.payload!==JSON.stringify(req.body.payload))fail('id_conflict',409);return{ok:true};}
    const now=clock();db.prepare('INSERT INTO comments VALUES(?,?,?,?,?,?,?,?,NULL)').run(req.body.id,req.body.vaultId,req.body.objectId,user.id,req.body.keyEpoch,JSON.stringify(req.body.payload),now,now);
    for(const m of db.prepare('SELECT user_id FROM vault_members WHERE vault_id=? AND user_id<>?').all(req.body.vaultId,user.id))enqueueCollaborationPush(db,m.user_id,'comment',req.body.vaultId,req.body.objectId,now);
    return{ok:true,createdAt:now};
  });
  post('comments/update',obj({id:uuid,vaultId:uuid,keyEpoch:{type:'integer',minimum:0},payload:sealed}),(req,user)=>{
    const vault=member(user,req.body.vaultId);permit(req,vault);const comment=db.prepare('SELECT * FROM comments WHERE id=? AND vault_id=?').get(req.body.id,req.body.vaultId);
    if(!comment)fail('comment_missing',404);if(comment.author_user_id!==user.id)fail('comment_author_required',403);
    const ring=db.prepare('SELECT current_epoch FROM vault_keyrings WHERE vault_id=?').get(req.body.vaultId);if(req.body.keyEpoch!==(ring?.current_epoch??0))fail('stale_key_epoch',409);
    db.prepare('UPDATE comments SET key_epoch=?,payload=?,updated_at=? WHERE id=?').run(req.body.keyEpoch,JSON.stringify(req.body.payload),clock(),req.body.id);return{ok:true};
  });
  post('comments/delete',obj({id:uuid,vaultId:uuid,confirmed:{const:true}}),(req,user)=>{
    const vault=member(user,req.body.vaultId);permit(req,vault);const comment=db.prepare('SELECT * FROM comments WHERE id=? AND vault_id=?').get(req.body.id,req.body.vaultId);
    if(!comment) return{ok:true};if(comment.author_user_id!==user.id&&vault.role!=='owner')fail('comment_author_required',403);
    db.prepare('DELETE FROM comments WHERE id=?').run(comment.id);return{ok:true};
  });
}
