import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { generateVaultKey, wrapWithPhrase } from '../src/crypto/vault.ts';
import { rememberKey, seal } from '../src/crypto/records.ts';
import {
  createCollaborationIdentity, createCollaborationPasswordWrapper, createOwnerKeyringBox,
  encryptVaultKeyring, keyringFromRaw, sealPersonalReminder,
} from '../src/crypto/collaboration.ts';

const admin={login:'CollabAdmin',password:'Admin9Collab'};
const temporary='Temporary9Collab',memberPassword='Member9Permanent';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'tasks-collaboration-')),origin='http://localhost:3100';
  let now=Date.now();
  const app=await createApp({dataDir:dir,logger:false,clock:()=>now,auth:{origin,secure:false,bootstrap:admin},push:{interval:0}});
  const db=new DatabaseSync(join(dir,'tasks.sqlite'),{enableForeignKeyConstraints:true});
  t.after(async()=>{db.close();await app.close();await rm(dir,{recursive:true,force:true});});
  function browser(){
    const jar=new Map();let accountId='';
    const cookies=()=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
    const absorb=response=>{for(const c of response.cookies){if(c.value)jar.set(c.name,c.value);else jar.delete(c.name);}return response;};
    const csrf=async()=>absorb(await app.inject({url:'/api/auth/csrf',headers:{cookie:cookies()}})).json().csrf;
    async function request(method,url,payload){
      const token=method!=='GET'?await csrf():undefined;
      const headers={cookie:cookies(),...(accountId?{'x-tasks-account':accountId}:{})};
      if(method!=='GET')Object.assign(headers,{origin,'x-csrf-token':token,'content-type':'application/json'});
      return absorb(await app.inject({method,url,headers,...(payload===undefined?{}:{payload})}));
    }
    async function authPost(path,payload){const r=await request('POST','/api/auth/'+path,payload);const user=r.json()?.user;if(user?.id&&['login','change-password','refresh'].includes(path))accountId=user.id;return r;}
    const authGet=path=>request('GET','/api/auth/'+path);
    const get=url=>request('GET',url);
    const post=(url,payload)=>request('POST',url,payload);
    return{authPost,authGet,get,post,jar,cookies,get accountId(){return accountId;},setAccount:id=>{accountId=id;}};
  }
  const owner=browser(),login=await owner.authPost('login',admin);assert.equal(login.statusCode,200);
  return{dir,db,app,owner,browser,ownerUser:login.json().user,advance:ms=>{now+=ms;}};
}
async function makeVault(ownerId,name='Shared family'){
  const root=await generateVaultKey(),id=randomUUID(),keyId=randomUUID(),revisionId=randomUUID();
  const context={accountId:ownerId,vaultId:id,keyId,objectId:keyId,revisionId};
  const header={id,keyId,revisionId,wrapper:await wrapWithPhrase(root,context,'abcdef'),
    name:await seal(root,{...context,objectId:id},null,name)};
  const raw=new Uint8Array(await crypto.subtle.exportKey('raw',root));
  const ring=keyringFromRaw(1,0,[raw]);
  const ownerBox=await createOwnerKeyringBox(await rememberKey(root),context,ring);
  raw.fill(0);
  return{root,context,header,ring,ownerBox};
}
async function sealedNote(root,ownerId,header,objectId,revisionId,parent,text){
  return seal(root,{accountId:ownerId,vaultId:header.id,keyId:header.keyId,objectId,revisionId},parent,{title:'Shared note',text});
}
async function sealedComment(root,ownerId,header,objectId,id,text){
  return seal(root,{accountId:ownerId,vaultId:header.id,keyId:header.keyId,objectId,revisionId:id},null,{kind:'note-comment-v1',text});
}

test('contacts, shared-vault roles, E2EE comments and key rotation enforce the agreed collaboration model',async t=>{
  const f=await fixture(t),member=f.browser();
  const created=(await f.owner.authPost('users/create',{login:'FamilyMember',password:temporary})).json().user;
  let login=await member.authPost('login',{login:'FamilyMember',password:temporary});assert.equal(login.statusCode,200);member.setAccount(created.id);
  assert.equal((await member.authPost('change-password',{currentPassword:temporary,password:memberPassword,repeatPassword:memberPassword,revokeOthers:true})).statusCode,200);

  const ownerIdentity=await createCollaborationIdentity(f.ownerUser.id,admin.password);
  let r=await f.owner.post('/api/collaboration/identity/setup',{password:'Wrong9Password',...ownerIdentity.identity});assert.equal(r.statusCode,403);
  assert.equal(f.db.prepare('SELECT count(*) n FROM collaboration_identities WHERE user_id=?').get(f.ownerUser.id).n,0);
  r=await f.owner.post('/api/collaboration/identity/setup',{password:admin.password,...ownerIdentity.identity});assert.equal(r.statusCode,200);

  const memberIdentity=await createCollaborationIdentity(created.id,memberPassword);
  r=await member.post('/api/collaboration/identity/setup',{password:memberPassword,...memberIdentity.identity});assert.equal(r.statusCode,200);
  const storedIdentity=JSON.stringify(f.db.prepare('SELECT public_key,private_box,password_wrapper FROM collaboration_identities WHERE user_id=?').get(created.id));
  assert.ok(!storedIdentity.includes(memberPassword));assert.ok(!storedIdentity.includes('d:'));

  assert.equal((await f.owner.post('/api/collaboration/users/find',{login:'FamilyMember'})).json().user.id,created.id);
  assert.equal((await f.owner.post('/api/collaboration/users/find',{login:'Family'})).statusCode,404);

  const vault=await makeVault(f.ownerUser.id);
  assert.equal((await f.owner.post('/api/vaults/create',{...vault.header,displayName:'Shared family'})).statusCode,200);
  assert.equal((await f.owner.post('/api/collaboration/vaults/keyring/setup',{vaultId:vault.header.id,version:1,currentEpoch:0,ownerBox:vault.ownerBox})).statusCode,200);
  const memberEnvelope=await encryptVaultKeyring(vault.header.id,vault.ring,created.id,1,memberIdentity.identity.publicKey);
  r=await f.owner.post('/api/collaboration/vaults/invite',{vaultId:vault.header.id,userId:created.id,role:'viewer',keyringVersion:1,identityVersion:1,keyEnvelope:memberEnvelope});
  assert.equal(r.statusCode,409);assert.equal(r.json().error,'contact_required');

  const memberSession=f.db.prepare('SELECT id FROM sessions WHERE user_id=? AND revoked=0 ORDER BY rowid DESC LIMIT 1').get(created.id).id;
  f.db.prepare('INSERT INTO push_subscriptions(id,user_id,session_id,device_id,endpoint,p256dh,auth) VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(),created.id,memberSession,randomUUID(),'https://example.invalid/push/'+randomUUID(),'p256dh','auth');
  const request=await f.owner.post('/api/collaboration/contacts/request',{userId:created.id});assert.equal(request.statusCode,200);
  const delivery=f.db.prepare("SELECT event_type,vault_id,object_id FROM collaboration_deliveries WHERE user_id=? ORDER BY rowid DESC LIMIT 1").get(created.id);
  assert.equal(delivery.event_type,'friend_request');assert.equal(delivery.vault_id,null);assert.equal(delivery.object_id,null);
  const incoming=(await member.get('/api/collaboration/contacts')).json().incoming;assert.equal(incoming.length,1);
  assert.equal((await member.post('/api/collaboration/contacts/accept',{requestId:incoming[0].id})).statusCode,200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM contacts').get().n,1);

  r=await f.owner.post('/api/collaboration/vaults/invite',{vaultId:vault.header.id,userId:created.id,role:'viewer',keyringVersion:1,identityVersion:1,keyEnvelope:memberEnvelope});
  assert.equal(r.statusCode,200);const inviteId=r.json().id;
  assert.equal((await member.post('/api/collaboration/vaults/invite/accept',{inviteId})).statusCode,200);
  let memberVault=(await member.get('/api/vaults')).json().vaults.find(v=>v.id===vault.header.id);
  assert.equal(memberVault.role,'viewer');assert.equal(memberVault.ownerId,f.ownerUser.id);assert.equal(memberVault.keyring.currentEpoch,0);
  assert.equal(memberVault.envelope.identityVersion,1);

  const objectId=randomUUID(),revision1=randomUUID(),sealed1=await sealedNote(vault.root,f.ownerUser.id,vault.header,objectId,revision1,null,'Owner content');
  assert.equal((await f.owner.post('/api/vaults/record',{vaultId:vault.header.id,record:{id:revision1,objectId,parent:null,sealed:sealed1,keyEpoch:0}})).statusCode,200);
  const viewerRevision=randomUUID(),viewerSealed=await sealedNote(vault.root,f.ownerUser.id,vault.header,objectId,viewerRevision,revision1,'Viewer edit');
  r=await member.post('/api/vaults/record',{vaultId:vault.header.id,record:{id:viewerRevision,objectId,parent:revision1,sealed:viewerSealed,keyEpoch:0}});
  assert.equal(r.statusCode,403);assert.equal(r.json().error,'read_only');

  const commentId=randomUUID(),secret='PRIVATE COMMENT 84721',commentPayload=await sealedComment(vault.root,f.ownerUser.id,vault.header,objectId,commentId,secret);
  r=await member.post('/api/collaboration/comments/create',{id:commentId,vaultId:vault.header.id,objectId,keyEpoch:0,payload:commentPayload});
  assert.equal(r.statusCode,200);
  const rawComment=f.db.prepare('SELECT payload,author_user_id FROM comments WHERE id=?').get(commentId);
  assert.equal(rawComment.author_user_id,created.id);assert.ok(!rawComment.payload.includes(secret));
  const commentList=(await f.owner.get('/api/collaboration/comments/'+vault.header.id+'/'+objectId)).json().comments;
  assert.equal(commentList[0].author.id,created.id);assert.equal(commentList[0].author.login,'familymember');assert.ok(!JSON.stringify(commentList).includes(secret));

  const updated=await sealedComment(vault.root,f.ownerUser.id,vault.header,objectId,commentId,'Updated encrypted comment');
  assert.equal((await member.post('/api/collaboration/comments/update',{id:commentId,vaultId:vault.header.id,keyEpoch:0,payload:updated})).statusCode,200);
  assert.equal((await f.owner.post('/api/collaboration/comments/delete',{id:commentId,vaultId:vault.header.id,confirmed:true})).statusCode,200);

  assert.equal((await f.owner.post('/api/collaboration/vaults/member/role',{vaultId:vault.header.id,userId:created.id,role:'editor'})).statusCode,200);
  memberVault=(await member.get('/api/vaults')).json().vaults.find(v=>v.id===vault.header.id);assert.equal(memberVault.role,'editor');
  const revision2=randomUUID(),sealed2=await sealedNote(vault.root,f.ownerUser.id,vault.header,objectId,revision2,revision1,'Editor content');
  assert.equal((await member.post('/api/vaults/record',{vaultId:vault.header.id,record:{id:revision2,objectId,parent:revision1,sealed:sealed2,keyEpoch:0}})).statusCode,200);
  const author=f.db.prepare('SELECT author_user_id FROM records WHERE id=?').get(revision2);assert.equal(author.author_user_id,created.id);

  const comment2=randomUUID(),comment2Payload=await sealedComment(vault.root,f.ownerUser.id,vault.header,objectId,comment2,'Will be purged');
  assert.equal((await member.post('/api/collaboration/comments/create',{id:comment2,vaultId:vault.header.id,objectId,keyEpoch:0,payload:comment2Payload})).statusCode,200);
  const reminderRevision=randomUUID(),plan={id:randomUUID(),state:'active',local:'2026-09-18T12:00',mode:'neutral',text:'',repeat:{type:'once'},end:{type:'never'},allDay:false,important:false};
  const reminderBox=await sealPersonalReminder(created.id,vault.header.id,objectId,reminderRevision,memberIdentity.runtime.root,plan);
  assert.equal((await member.post('/api/collaboration/reminder-configs/set',{vaultId:vault.header.id,objectId,revisionId:reminderRevision,payload:reminderBox})).statusCode,200);

  assert.equal((await member.post('/api/vaults/object-state',{vaultId:vault.header.id,objectId,recordId:revision2,expected:null,state:'trash'})).statusCode,200);
  r=await member.post('/api/vaults/purge-object',{vaultId:vault.header.id,objectId,expected:revision2,confirmed:true});
  assert.equal(r.statusCode,403);assert.equal(r.json().error,'owner_required');
  assert.equal((await f.owner.post('/api/vaults/purge-object',{vaultId:vault.header.id,objectId,expected:revision2,confirmed:true})).statusCode,200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM records WHERE vault_id=? AND object_id=?').get(vault.header.id,objectId).n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM comments WHERE vault_id=? AND object_id=?').get(vault.header.id,objectId).n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM personal_reminder_configs WHERE vault_id=? AND object_id=?').get(vault.header.id,objectId).n,0);

  const rootRaw=new Uint8Array(await crypto.subtle.exportKey('raw',vault.root)),nextRaw=new Uint8Array(32);crypto.getRandomValues(nextRaw);
  const ring2=keyringFromRaw(2,1,[rootRaw,nextRaw]),ownerBox2=await createOwnerKeyringBox(await rememberKey(vault.root),vault.context,ring2);
  rootRaw.fill(0);nextRaw.fill(0);
  r=await f.owner.post('/api/collaboration/vaults/member/remove',{vaultId:vault.header.id,userId:created.id,expectedVersion:1,newVersion:2,currentEpoch:1,ownerBox:ownerBox2,envelopes:[],confirmed:true});
  assert.equal(r.statusCode,200);assert.equal(r.json().currentEpoch,1);
  assert.equal((await member.get('/api/vaults')).json().vaults.some(v=>v.id===vault.header.id),false);
  assert.equal((await member.get('/api/vaults/'+vault.header.id)).statusCode,404);
  const rotated=f.db.prepare('SELECT version,current_epoch FROM vault_keyrings WHERE vault_id=?').get(vault.header.id);
  assert.equal(rotated.version,2);assert.equal(rotated.current_epoch,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM vault_members WHERE vault_id=? AND user_id=?').get(vault.header.id,created.id).n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM vault_member_envelopes WHERE vault_id=? AND user_id=?').get(vault.header.id,created.id).n,0);
});

test('password change and admin reset never disclose or silently destroy the account-wide collaboration identity',async t=>{
  const f=await fixture(t),user=f.browser();
  const row=(await f.owner.authPost('users/create',{login:'RecoveryUser',password:temporary})).json().user;
  assert.equal((await user.authPost('login',{login:'RecoveryUser',password:temporary})).statusCode,200);user.setAccount(row.id);
  assert.equal((await user.authPost('change-password',{currentPassword:temporary,password:memberPassword,repeatPassword:memberPassword,revokeOthers:true})).statusCode,200);
  const identity=await createCollaborationIdentity(row.id,memberPassword);
  assert.equal((await user.post('/api/collaboration/identity/setup',{password:memberPassword,...identity.identity})).statusCode,200);

  let change=await user.authPost('change-password',{currentPassword:memberPassword,password:'Member8Next',repeatPassword:'Member8Next',revokeOthers:false});
  assert.equal(change.statusCode,409);assert.equal(change.json().error,'collaboration_rewrap_required');
  const wrapper=await createCollaborationPasswordWrapper(row.id,1,identity.identity.publicKey,identity.runtime.root,'Member8Next');
  change=await user.authPost('change-password',{currentPassword:memberPassword,password:'Member8Next',repeatPassword:'Member8Next',revokeOthers:false,
    collaborationRewrap:{identityVersion:1,passwordWrapper:wrapper}});
  assert.equal(change.statusCode,200);
  let serverIdentity=f.db.prepare('SELECT * FROM collaboration_identities WHERE user_id=?').get(row.id);
  assert.equal(serverIdentity.password_wrapper,JSON.stringify(wrapper));
  const preserved={version:serverIdentity.version,public_key:serverIdentity.public_key,private_box:serverIdentity.private_box,password_wrapper:serverIdentity.password_wrapper};

  const latest=(await f.owner.authGet('users')).json().users.find(x=>x.id===row.id);
  assert.equal((await f.owner.authPost('users/reset',{id:row.id,expectedVersion:latest.credentialVersion,password:'Reset9Temporary',confirmed:true})).statusCode,200);
  serverIdentity=f.db.prepare('SELECT * FROM collaboration_identities WHERE user_id=?').get(row.id);
  for(const [key,value] of Object.entries(preserved))assert.equal(serverIdentity[key],value);
  assert.equal((await user.authPost('login',{login:'RecoveryUser',password:'Reset9Temporary'})).statusCode,200);user.setAccount(row.id);

  change=await user.authPost('change-password',{currentPassword:'Reset9Temporary',password:'Recovered7Password',repeatPassword:'Recovered7Password',revokeOthers:true});
  assert.equal(change.statusCode,200,'mandatory post-reset change must not destroy an unrecoverable E2EE identity');
  serverIdentity=f.db.prepare('SELECT * FROM collaboration_identities WHERE user_id=?').get(row.id);
  assert.equal(serverIdentity.password_wrapper,preserved.password_wrapper,'old E2EE wrapper is retained for trusted-device PRF recovery');

  const recoveredWrapper=await createCollaborationPasswordWrapper(row.id,1,identity.identity.publicKey,identity.runtime.root,'Recovered7Password');
  assert.equal((await user.post('/api/collaboration/identity/rewrap',{password:'Wrong9Password',expectedVersion:1,passwordWrapper:recoveredWrapper})).statusCode,403);
  assert.equal((await user.post('/api/collaboration/identity/rewrap',{password:'Recovered7Password',expectedVersion:1,passwordWrapper:recoveredWrapper})).statusCode,200);
  serverIdentity=f.db.prepare('SELECT * FROM collaboration_identities WHERE user_id=?').get(row.id);
  assert.equal(serverIdentity.password_wrapper,JSON.stringify(recoveredWrapper));
  assert.equal(serverIdentity.public_key,preserved.public_key);assert.equal(serverIdentity.private_box,preserved.private_box);
});
