import { randomUUID } from 'node:crypto';
import { fail } from './auth/accounts.mjs';

export function memberOf(db,user,id,active=true){
  const row=db.prepare(`SELECT v.*,m.role,v.user_id owner_id
    FROM vaults v JOIN vault_members m ON m.vault_id=v.id
    WHERE v.id=? AND m.user_id=?`).get(id,user.id);
  if(!row)fail('not_found',404);
  if(active&&row.deleted)fail('vault_deleted',410);
  return row;
}
export function ownerOf(db,user,id,active=true){
  const row=memberOf(db,user,id,active);if(row.role!=='owner')fail('owner_required',403);return row;
}
export function writerOf(db,user,id,active=true){
  const row=memberOf(db,user,id,active);if(row.role==='viewer')fail('read_only',403);return row;
}
export function pair(a,b){return a<b?[a,b]:[b,a];}
export function areContacts(db,a,b){
  const [userA,userB]=pair(a,b);return Boolean(db.prepare('SELECT 1 FROM contacts WHERE user_a=? AND user_b=?').get(userA,userB));
}
export function enqueueCollaborationPush(db,userId,eventType,vaultId,objectId,now){
  const subscriptions=db.prepare(`SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.id=p.session_id
    WHERE p.user_id=? AND s.revoked=0 AND s.refresh_expires>? AND s.absolute_expires>?`).all(userId,now,now);
  for(const sub of subscriptions)db.prepare(`INSERT INTO collaboration_deliveries
    (id,user_id,subscription_id,event_type,vault_id,object_id,created_at,due_at,expires_at,status)
    VALUES(?,?,?,?,?,?,?,?,?,'scheduled')`).run(randomUUID(),userId,sub.id,eventType,vaultId??null,objectId??null,now,now,now+3600000);
}
