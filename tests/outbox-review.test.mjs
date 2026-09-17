import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { writeState, changes } from '../src/storage.ts';
import { generateVaultKey } from '../src/crypto/vault.ts';
import { seal } from '../src/crypto/records.ts';
import { outboxReviewItems, requireOutboxReview, context } from '../src/planner.ts';

const user={id:randomUUID(),login:'outbox-review',role:'user',mustChangePassword:false};

test('outbox review ignores internal vault metadata revisions',async t=>{
 globalThis.window=new EventTarget();
 t.after(()=>changes?.close());
 const key=await generateVaultKey(),vaultId=randomUUID(),keyId=randomUUID(),revisionId=randomUUID();
 const header={id:vaultId,keyId,kdf:{name:'PBKDF2',hash:'SHA-256',iterations:1,salt:'AAAAAAAAAAAAAAAAAAAAAA'},wrap:{name:'AES-KW',key:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}};
 const sealed=await seal(key,context(user.id,header,vaultId,revisionId),null,{kind:'tag-catalog',title:'',text:'',tags:[]});
 await writeState({user,vaults:[{header,key,records:[{id:revisionId,objectId:vaultId,parent:null,sealed,pending:true}]}],stash:[]});
 await requireOutboxReview(user);
 assert.deepEqual(await outboxReviewItems(user),[]);
});
