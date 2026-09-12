import { seal, unseal, type Sealed } from './records.ts';
import { encode64, type Context } from './vault.ts';
export interface AccessPack { publicKey: {kty:'EC';crv:'P-256';x:string;y:string}; box:Sealed }
export async function createAccess(root:CryptoKey,context:Context):Promise<AccessPack>{
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);
  const raw=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
  try{return{publicKey:{kty:'EC',crv:'P-256',x:publicKey.x!,y:publicKey.y!},
    box:await seal(root,context,null,{kind:'sync-access-v1',privateKey:encode64(raw)})};}
  finally{raw.fill(0);}
}
export async function signAccess(root:CryptoKey,context:Context,pack:AccessPack,challenge:unknown[]):Promise<string>{
  const value=await unseal(root,context,null,pack.box) as {kind:string;privateKey:string};
  if(value?.kind!=='sync-access-v1'||typeof value.privateKey!=='string'||value.privateKey.length>2048||! /^[A-Za-z0-9_-]+$/.test(value.privateKey))throw Error('Повреждено разрешение синхронизации');
  const raw=Uint8Array.from(atob(value.privateKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  try{
    const privateKey=await crypto.subtle.importKey('pkcs8',raw,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
    return encode64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,new TextEncoder().encode(JSON.stringify(challenge)))));
  }finally{raw.fill(0);}
}
