import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseConversationList,createConversationClient} from '../src/lib/conversationAccess';
import {checkConversationAccess} from '../supabase/functions/_shared/conversationAccess';
import {canCreateFromConversationList} from '../src/lib/roomLimits';
const uid='11111111-1111-4111-8111-111111111111', id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row={id,user_id:uid,title:'Закрытая беседа',is_active:true,created_at:'2026-01-01T00:00:00Z',last_message_at:'2026-02-01T00:00:00Z',can_read:false};
test('locked archives do not occupy the one free replacement slot; unknown access never permits creation',()=>{
 assert.equal(canCreateFromConversationList([{can_read:false},{can_read:false}],1),true);
 assert.equal(canCreateFromConversationList([{can_read:false},{can_read:true}],1),false);
 assert.equal(canCreateFromConversationList([{}],1),false);
});
test('safe list rejects foreign owner, summary-bearing or malformed rows, retaining server order',()=>{
 assert.deepEqual(parseConversationList([row],uid),[row]);
 for(const candidate of [[{...row,summary:'secret'}],[{...row,user_id:id}],[{...row,can_read:'false'}],[{...row,created_at:'yesterday'}],[row,row],{}]) {
  assert.equal(parseConversationList(candidate,uid),null);
 }
});
test('failed delete/rename never report success and request only scoped RPC',async()=>{
 const calls:unknown[]=[];
 const client=createConversationClient(async(name,args)=>{calls.push([name,args]);return {data:true,error:{message:'network'}};});
 await assert.rejects(client.remove(id),/conversation_operation_failed/);
 await assert.rejects(client.rename(id,'new'),/conversation_operation_failed/);
 assert.deepEqual(calls,[['delete_my_conversation',{p_conversation_id:id}],['rename_my_conversation',{p_conversation_id:id,p_title:'new'}]]);
});
test('list and mutation transport validate payload rather than optimistic local success',async()=>{
 const client=createConversationClient(async(name)=>({data:name==='list_my_conversations'?[row]:false,error:null}));
 assert.equal((await client.list(uid))[0].can_read,false);
 await assert.rejects(client.remove(id),/conversation_operation_failed/);
 await assert.rejects(client.moveTop(id),/conversation_operation_failed/);
});
test('preview payload cannot smuggle unrequested conversation content',async()=>{
 const client=createConversationClient(async()=>({data:{[id]:'own preview',unexpected:'secret'},error:null}));
 await assert.rejects(client.previews([id]),/conversation_list_unavailable/);
});
test('access boundary rejects malformed and failed RPC responses, and never retries denied id',async()=>{
 for(const data of [null,{},true,{allowed:true},{allowed:true,paidFeatures:'yes',fullAccess:true}]) {
  assert.equal(await checkConversationAccess({rpc:async()=>({data,error:null})},id),null);
 }
 const calls:unknown[]=[];
 const access=await checkConversationAccess({rpc:async(name,args)=>{calls.push([name,args]);return {data:{allowed:false,paidFeatures:false,fullAccess:false},error:null};}},id);
 assert.deepEqual(access,{allowed:false,paidFeatures:false,fullAccess:false});
 assert.deepEqual(calls,[['get_my_conversation_access',{p_conversation_id:id}]]);
 assert.equal(await checkConversationAccess({rpc:async()=>{throw Error('offline');}},id),null);
});
