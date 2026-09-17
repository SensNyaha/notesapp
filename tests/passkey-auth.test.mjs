import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { WEBAUTHN_CHALLENGE_MS } from '../server/auth/webauthn.mjs';

const origin='http://localhost:3100';
const admin={login:'PasskeyAdmin',password:'Example9Pass',repeatPassword:'Example9Pass'};
const permanent='Changed9Password';
const temporary='Temporary9Password';
const credentialA='A'.repeat(32),credentialB='B'.repeat(32);

function mockWebAuthn(){
  let sequence=0;
  const registrations=[],authentications=[];
  return { registrations,authentications,
    async generateRegistrationOptions(options){
      registrations.push({kind:'options',options});
      return {challenge:'register-'+(++sequence),rp:{id:options.rpID,name:options.rpName},
        user:{id:'test-user',name:options.userName,displayName:options.userDisplayName},pubKeyCredParams:[],
        authenticatorSelection:options.authenticatorSelection,extensions:options.extensions};
    },
    async verifyRegistrationResponse(options){
      registrations.push({kind:'verify',options});
      const r=options.response;
      if(r.challenge!==options.expectedChallenge||r.origin!==options.expectedOrigin||r.rpId!==options.expectedRPID||r.signature==='bad')return{verified:false};
      return {verified:true,registrationInfo:{userVerified:r.uv!==false,credential:{id:r.id,publicKey:Uint8Array.from([1,2,3,4]),counter:0},
        credentialDeviceType:'multiDevice',credentialBackedUp:true}};
    },    async generateAuthenticationOptions(options){
      authentications.push({kind:'options',options});
      return {challenge:'authenticate-'+(++sequence),rpId:options.rpID,userVerification:options.userVerification};
    },
    async verifyAuthenticationResponse(options){
      authentications.push({kind:'verify',options});
      const r=options.response;
      if(r.challenge!==options.expectedChallenge||r.origin!==options.expectedOrigin||r.rpId!==options.expectedRPID||r.signature==='bad')return{verified:false};
      return {verified:true,authenticationInfo:{credentialID:r.id,newCounter:options.credential.counter+1,
        userVerified:r.uv!==false,credentialDeviceType:'multiDevice',credentialBackedUp:true,
        origin:r.origin,rpID:r.rpId}};
    },
  };
}

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'tasks-webauthn-'));let now=Date.now();const webauthn=mockWebAuthn();
  const app=await createApp({dataDir:dir,auth:{origin,rpId:'localhost',secure:false},clock:()=>now,logger:false,webauthn});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  function browser(){
    const jar=new Map(),cookies=()=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
    const absorb=response=>{for(const c of response.cookies){if(c.value)jar.set(c.name,c.value);else jar.delete(c.name);}return response;};
    const get=async path=>absorb(await app.inject({url:'/api/auth/'+path,headers:{cookie:cookies()}}));
    const post=async(path,body={})=>{const csrf=(await get('csrf')).json().csrf;return absorb(await app.inject({method:'POST',url:'/api/auth/'+path,payload:body,
      headers:{origin,cookie:cookies(),'x-csrf-token':csrf}}));};
    return{get,post,jar};
  }
  return{app,webauthn,browser,now:()=>now,advance:ms=>{now+=ms;}};
}const response=(id,challenge,patch={})=>({id,challenge,origin,rpId:'localhost',uv:true,signature:'ok',response:{transports:['internal']},...patch});
async function enroll(browser,id=credentialA,name='Основной ключ'){
  const begin=await browser.post('passkeys/register/options',{});assert.equal(begin.statusCode,200);
  const body=begin.json();
  const finish=await browser.post('passkeys/register/finish',{challengeId:body.challengeId,displayName:name,response:response(id,body.options.challenge)});
  return{begin,finish};
}
async function passkeyLogin(browser,id=credentialA,patch={}){
  const begin=await browser.post('passkeys/login/options',{});assert.equal(begin.statusCode,200);
  const body=begin.json();
  const finish=await browser.post('passkeys/login/finish',{challengeId:body.challengeId,response:response(id,body.options.challenge,patch)});
  return{begin,finish};
}

test('password authentication remains available before, during and after Passkey enrollment',async t=>{
  const f=await fixture(t),b=f.browser();
  assert.equal((await b.post('bootstrap',admin)).statusCode,200);
  const enrolled=await enroll(b);assert.equal(enrolled.finish.statusCode,200);
  assert.equal(enrolled.begin.json().options.authenticatorSelection.userVerification,'required');
  assert.equal((await b.post('logout',{})).statusCode,200);
  assert.equal((await b.post('login',{login:admin.login,password:admin.password})).statusCode,200);
  const list=(await b.get('passkeys')).json().passkeys;assert.equal(list.length,1);
  assert.equal((await b.post('passkeys/delete',{id:list[0].id})).statusCode,200);
  assert.equal((await b.post('logout',{})).statusCode,200);
  assert.equal((await b.post('login',{login:admin.login,password:admin.password})).statusCode,200);
});

test('valid Passkey authentication creates an ordinary session and challenge is one-time',async t=>{
  const f=await fixture(t),b=f.browser();await b.post('bootstrap',admin);await enroll(b);await b.post('logout',{});
  const result=await passkeyLogin(b);assert.equal(result.finish.statusCode,200);assert.equal(result.finish.json().user.login,admin.login.toLowerCase());
  assert.equal(result.begin.json().options.userVerification,'required');
  const reused=await b.post('passkeys/login/finish',{challengeId:result.begin.json().challengeId,
    response:response(credentialA,result.begin.json().options.challenge)});
  assert.equal(reused.statusCode,401);assert.equal(reused.json().error,'invalid_credentials');
  assert.equal((await b.get('session')).statusCode,200);
});
test('unknown, deleted and expired Passkeys fail without credential enumeration',async t=>{
  const f=await fixture(t),b=f.browser();await b.post('bootstrap',admin);const enrolled=await enroll(b);assert.equal(enrolled.finish.statusCode,200);
  await b.post('logout',{});
  assert.equal((await passkeyLogin(b,'Z'.repeat(32))).finish.statusCode,401);
  assert.equal((await b.post('login',{login:admin.login,password:admin.password})).statusCode,200);
  const id=(await b.get('passkeys')).json().passkeys[0].id;await b.post('passkeys/delete',{id});await b.post('logout',{});
  assert.equal((await passkeyLogin(b,credentialA)).finish.statusCode,401);
  await b.post('login',{login:admin.login,password:admin.password});await enroll(b);await b.post('logout',{});
  const begin=await b.post('passkeys/login/options',{}),body=begin.json();f.advance(WEBAUTHN_CHALLENGE_MS+1);
  const expired=await b.post('passkeys/login/finish',{challengeId:body.challengeId,response:response(credentialA,body.options.challenge)});
  assert.equal(expired.statusCode,401);assert.equal(expired.json().error,'invalid_credentials');
});

test('wrong challenge, origin, RP ID, signature and missing user verification are rejected',async t=>{
  const f=await fixture(t),b=f.browser();await b.post('bootstrap',admin);await enroll(b);await b.post('logout',{});
  const cases=[{challenge:'wrong'},{origin:'https://evil.invalid'},{rpId:'evil.invalid'},{signature:'bad'},{uv:false}];
  for(const patch of cases){
    const result=await passkeyLogin(b,credentialA,patch);
    assert.equal(result.finish.statusCode,401,JSON.stringify(patch));
    assert.equal(result.finish.json().error,'invalid_credentials');
  }
  assert.equal((await b.get('session')).statusCode,401);
});

test('Passkeys remain account-isolated for listing, deletion and discoverable login',async t=>{
  const f=await fixture(t),adminBrowser=f.browser(),userBrowser=f.browser();await adminBrowser.post('bootstrap',admin);
  await enroll(adminBrowser,credentialA,'Администратор');
  const created=await adminBrowser.post('users/create',{login:'OtherUser',password:temporary});assert.equal(created.statusCode,200);
  assert.equal((await userBrowser.post('login',{login:'OtherUser',password:temporary})).statusCode,200);
  assert.equal((await userBrowser.post('change-password',{currentPassword:temporary,password:permanent,repeatPassword:permanent,revokeOthers:true})).statusCode,200);
  await enroll(userBrowser,credentialB,'Другой пользователь');
  const adminList=(await adminBrowser.get('passkeys')).json().passkeys,userList=(await userBrowser.get('passkeys')).json().passkeys;
  assert.deepEqual(adminList.map(x=>x.credentialId),[credentialA]);assert.deepEqual(userList.map(x=>x.credentialId),[credentialB]);
  assert.equal((await userBrowser.post('passkeys/delete',{id:adminList[0].id})).statusCode,404);
  await adminBrowser.post('logout',{});await userBrowser.post('logout',{});
  assert.equal((await passkeyLogin(adminBrowser,credentialA)).finish.json().user.login,admin.login.toLowerCase());
  assert.equal((await passkeyLogin(userBrowser,credentialB)).finish.json().user.login,'otheruser');
});