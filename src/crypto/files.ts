import { encode64 } from './vault.ts';

export const FILE_CHUNK_BYTES=1024*1024;
const enc=new TextEncoder();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function decode64(value:string){if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('invalid_file_key');const text=atob(value.replace(/-/g,'+').replace(/_/g,'/'));const bytes=Uint8Array.from(text,c=>c.charCodeAt(0));if(encode64(bytes)!==value)throw Error('invalid_file_key');return bytes;}
function validIds(accountId:string,vaultId:string,attachmentId:string){if(!uuid.test(accountId)||!uuid.test(vaultId)||!uuid.test(attachmentId))throw Error('invalid_file_context');}
function aad(accountId:string,vaultId:string,attachmentId:string,kind:'data'|'preview',index:number){validIds(accountId,vaultId,attachmentId);if(!Number.isSafeInteger(index)||index<0)throw Error('invalid_file_context');return enc.encode(JSON.stringify(['tasks-file',1,accountId,vaultId,attachmentId,kind,index]));}

export async function createFileKey(root:CryptoKey){
  if(root.algorithm.name!=='AES-KW')throw Error('invalid_vault_key');
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const wrapped=new Uint8Array(await crypto.subtle.wrapKey('raw',key,root,'AES-KW'));
  return{key,wrappedKey:encode64(wrapped)};
}
export async function unwrapFileKey(root:CryptoKey,wrappedKey:string){
  if(root.algorithm.name!=='AES-KW')throw Error('invalid_vault_key');
  const wrapped=decode64(wrappedKey);if(wrapped.length!==40)throw Error('invalid_file_key');
  return crypto.subtle.unwrapKey('raw',wrapped,root,'AES-KW','AES-GCM',false,['encrypt','decrypt']);
}
export async function rewrapFileKey(sourceRoot:CryptoKey,targetRoot:CryptoKey,wrappedKey:string){
  if(sourceRoot.algorithm.name!=='AES-KW'||targetRoot.algorithm.name!=='AES-KW')throw Error('invalid_vault_key');
  const wrapped=decode64(wrappedKey);if(wrapped.length!==40)throw Error('invalid_file_key');
  const key=await crypto.subtle.unwrapKey('raw',wrapped,sourceRoot,'AES-KW','AES-GCM',true,['encrypt','decrypt']);
  return encode64(new Uint8Array(await crypto.subtle.wrapKey('raw',key,targetRoot,'AES-KW')));
}
export async function encryptFileChunk(key:CryptoKey,accountId:string,vaultId:string,attachmentId:string,kind:'data'|'preview',index:number,plain:Uint8Array){
  if(!(plain instanceof Uint8Array)||plain.byteLength>FILE_CHUNK_BYTES)throw Error('invalid_file_chunk');
  const iv=crypto.getRandomValues(new Uint8Array(12)),snapshot=Uint8Array.from(plain),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(accountId,vaultId,attachmentId,kind,index),tagLength:128},key,snapshot));
  const out=new Uint8Array(iv.length+cipher.length);out.set(iv);out.set(cipher,iv.length);return out;
}
export async function decryptFileChunk(key:CryptoKey,accountId:string,vaultId:string,attachmentId:string,kind:'data'|'preview',index:number,bytes:Uint8Array){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<28||bytes.byteLength>FILE_CHUNK_BYTES+28)throw Error('invalid_file_chunk');
  const iv=bytes.slice(0,12),cipher=bytes.slice(12);try{return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(accountId,vaultId,attachmentId,kind,index),tagLength:128},key,cipher));}
  catch{throw Error('file_authentication_failed');}
}
