import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAccessGeneration,readIfCurrent,commitIfCurrent,requirePersistedTurn} from '../src/lib/accessGeneration';
import {createConversationClient} from '../src/lib/conversationAccess';
const uid='11111111-1111-4111-8111-111111111111';
test('authority generations never reuse a previous paid verification after unknown or account ABA',()=>{
 const epoch=createAccessGeneration();const first=epoch.observe('A:paid');
 epoch.observe('A:unknown');const again=epoch.observe('A:paid');
 assert.ok(again>first);assert.equal(epoch.observe('A:paid'),again);
 epoch.observe('B:paid');assert.ok(epoch.observe('A:paid')>again);
});
test('late reads and shared/download handoffs are discarded after authority revocation',async()=>{
 let current=true,resolve!:(value:string)=>void;
 const pending=readIfCurrent(()=>new Promise<string>(done=>{resolve=done;}),()=>current);
 current=false;resolve('old private text');assert.equal(await pending,null);
 const published:string[]=[];
 assert.equal(commitIfCurrent('old export',()=>current,value=>published.push(value)),false);
 assert.deepEqual(published,[]);
});
test('delete-all includes the owner that opened confirmation, never a parameterless current-account delete',async()=>{
 const calls:unknown[]=[];
 const client=createConversationClient(async(name,args)=>{calls.push([name,args]);return {data:null,error:null};});
 await client.removeAll(uid);
 assert.deepEqual(calls,[['delete_all_my_conversations',{p_expected_user_id:uid}]]);
});
test('missing persistence cannot masquerade as a saved user/assistant turn',()=>{
 assert.throws(()=>requirePersistedTurn({message:{id:'user'},error:null},{message:null,error:'denied'}),/turn_not_saved/);
 assert.throws(()=>requirePersistedTurn({message:null,error:null},{message:{id:'ai'},error:null}),/turn_not_saved/);
 assert.doesNotThrow(()=>requirePersistedTurn({message:{id:'user'},error:null},{message:{id:'ai'},error:null}));
});
