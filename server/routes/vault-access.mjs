import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { requireUser, AccountError, fail } from '../auth/accounts.mjs';
import { verifyPassword } from '../auth/password.mjs';
const hash = token => createHash('sha256').update(token).digest('hex');
export function registerVaultAccess(app, db, { own, action, post, obj, uuid, b64, sealed, guard, accessOf, clock }) {
  const pub = obj({ kty: { const: 'EC' }, crv: { const: 'P-256' }, x: b64(43), y: b64(43) });
  post('access/setup', obj({ vaultId: uuid, pack: obj({ publicKey: pub, box: sealed }) }), (req, user) => {
    const row = own(user, req.body.vaultId);
    if (!row.access_pack) {
      try { createPublicKey({ key: req.body.pack.publicKey, format: 'jwk' }); } catch { fail('invalid_request', 400); }
      db.prepare('UPDATE vaults SET access_pack=? WHERE id=?').run(JSON.stringify(req.body.pack),row.id);
    }
    return { pack: JSON.parse(db.prepare('SELECT access_pack FROM vaults WHERE id=?').get(row.id).access_pack) };
  });
  post('access/challenge', obj({ vaultId: uuid, deviceId: uuid }), (req, user) => {
    const row=own(user,req.body.vaultId); if(!row.access_pack)fail('access_not_ready',409);
    db.prepare('DELETE FROM vault_challenges WHERE expires<=?').run(clock());
    if(db.prepare('SELECT count(*) n FROM vault_challenges WHERE vault_id=?').get(row.id).n>=100)fail('rate_limited',429);
    const id=randomUUID(), nonce=randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO vault_challenges VALUES(?,?,?,?,?,?)').run(id,row.id,req.body.deviceId,row.lock_epoch,nonce,clock()+60000);
    return { challenge: ['tasks-vault-access',1,user.id,row.id,row.lock_epoch,req.body.deviceId,id,nonce] };
  });
  post('access/grant', obj({ vaultId:uuid, deviceId:uuid, challengeId:uuid, signature:b64(86) }), (req,user)=>{
    const row=own(user,req.body.vaultId), c=db.prepare('SELECT * FROM vault_challenges WHERE id=?').get(req.body.challengeId);
    if(!c||c.vault_id!==row.id||c.device_id!==req.body.deviceId||c.epoch!==row.lock_epoch||c.expires<=clock())fail('invalid_challenge',403);
    const message=JSON.stringify(['tasks-vault-access',1,user.id,row.id,row.lock_epoch,c.device_id,c.id,c.nonce]);
    const signature=Buffer.from(req.body.signature,'base64url');
    let valid=false;
    try { valid=signature.length===64&&signature.toString('base64url')===req.body.signature&&verify('sha256',Buffer.from(message),
      { key:createPublicKey({key:JSON.parse(row.access_pack).publicKey,format:'jwk'}), dsaEncoding:'ieee-p1363' },signature); } catch {}
    if(!valid)fail('invalid_proof',403);
    const token=randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM vault_challenges WHERE id=?').run(c.id);
    db.prepare('DELETE FROM vault_grants WHERE vault_id=? AND device_id=?').run(row.id,c.device_id);
    db.prepare('INSERT INTO vault_grants VALUES(?,?,?,?)').run(hash(token),row.id,c.device_id,row.lock_epoch);
    return {token,epoch:row.lock_epoch};
  });
  const counters=new Map();let inFlight=0;
  app.post('/api/vaults/close-all',{preHandler:guard,schema:{body:obj({vaultId:uuid,operationId:uuid,password:{type:'string',maxLength:256},confirmed:{const:true}})}},async(req,reply)=>{
    let occupied=false;
    try {
      const user=requireUser(db,accessOf(req),clock());
      if(req.headers['x-tasks-account']!==user.id)fail('account_mismatch',409);
      own(user,req.body.vaultId);
      for(const [key,entry] of counters)if(entry.until<=clock())counters.delete(key);
      const count=counters.get(user.id)??{count:0,until:clock()+15*60000};count.count++;counters.set(user.id,count);
      if(inFlight>=2||count.count>10)fail('rate_limited',429);
      inFlight++;occupied=true;
      const credential=db.prepare('SELECT password_hash,credential_version FROM users WHERE id=?').get(user.id);
      if(!await verifyPassword(credential.password_hash,req.body.password))fail('wrong_password',400);
      return action((request,actor)=>{
        if(actor.id!==user.id||db.prepare('SELECT credential_version FROM users WHERE id=?').get(user.id).credential_version!==credential.credential_version)fail('account_changed',409);
        const row=own(actor,request.body.vaultId);
        if(!row.access_pack)fail('access_not_ready',409);
        const old=db.prepare('SELECT * FROM vault_closures WHERE id=?').get(request.body.operationId);
        if(old){if(old.vault_id!==row.id)fail('id_conflict',409);return{epoch:row.lock_epoch};}
        const epoch=row.lock_epoch+1;
        db.prepare('UPDATE vaults SET lock_epoch=? WHERE id=?').run(epoch,row.id);
        db.prepare('DELETE FROM vault_grants WHERE vault_id=?').run(row.id);
        db.prepare('DELETE FROM vault_challenges WHERE vault_id=?').run(row.id);
        db.prepare('INSERT INTO vault_closures VALUES(?,?,?)').run(request.body.operationId,row.id,epoch);
        return{epoch};
      })(req,reply);
    }catch(error){if(error instanceof AccountError)return reply.code(error.status).send({error:error.code});throw error;}
    finally{if(occupied)inFlight--;}
  });
  return function permit(req,row,required=false){
    if(!required&&row.lock_epoch===0)return;
    let grants;try{const text=req.headers['x-vault-grants'];if(typeof text!=='string'||text.length>1024)throw Error();grants=JSON.parse(text);}catch{fail('vault_locked',423);}
    const token=grants?.[row.id];
    if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token))fail('vault_locked',423);
    if(!db.prepare('SELECT 1 FROM vault_grants WHERE token_hash=? AND vault_id=? AND epoch=? AND device_id=?').get(hash(token),row.id,row.lock_epoch,req.headers['x-tasks-device']??''))fail('vault_locked',423);
  };
}
