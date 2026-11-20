import type {Conversation} from '../types';
import {parseServerTimestamp} from './serverTime';
export {checkConversationAccess} from '../../supabase/functions/_shared/conversationAccess';
export type {ConversationAccess} from '../../supabase/functions/_shared/conversationAccess';
export type ListedConversation=Conversation&{can_read:boolean};
type Rpc=(name:string,args:Record<string,unknown>,signal?:AbortSignal)=>Promise<{data:unknown;error:unknown}>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys=['id','user_id','title','is_active','created_at','last_message_at','can_read'];
export function parseConversationList(data:unknown,owner:string):ListedConversation[]|null {
 if(!Array.isArray(data))return null;
 const seen=new Set<string>();
 for(const item of data){
  if(!item||typeof item!=='object'||Array.isArray(item))return null;
  const r=item as Record<string,unknown>;
  if(Object.keys(r).length!==keys.length||keys.some(key=>!(key in r))||typeof r.id!=='string'||!uuid.test(r.id)||seen.has(r.id)||r.user_id!==owner||
   typeof r.title!=='string'||r.is_active!==true||typeof r.can_read!=='boolean'||!Number.isFinite(parseServerTimestamp(r.created_at))||!Number.isFinite(parseServerTimestamp(r.last_message_at)))return null;
  seen.add(r.id);
 }
 return data as ListedConversation[];
}
export function createConversationClient(rpc:Rpc){
 const mutate=async(name:string,id:string,extra:Record<string,unknown>={})=>{
  if(!uuid.test(id))throw Error('conversation_operation_failed');
  const {data,error}=await rpc(name,{p_conversation_id:id,...extra});
  if(error||data!==true)throw Error('conversation_operation_failed');
 };
 return {
  async previews(ids:string[]){
   if(ids.length===0)return {} as Record<string,string>;
   const {data,error}=await rpc('load_conversation_last_messages',{p_conversation_ids:ids});
   if(error||!data||typeof data!=='object'||Array.isArray(data)||Object.entries(data).some(([id,value])=>!ids.includes(id)||typeof value!=='string'))throw Error('conversation_list_unavailable');
   return data as Record<string,string>;
  },
  async list(owner:string,signal?:AbortSignal){
   const {data,error}=await rpc('list_my_conversations',{},signal);
   const rows=error?null:parseConversationList(data,owner);
   if(!rows)throw Error('conversation_list_unavailable');return rows;
  },
  remove:(id:string)=>mutate('delete_my_conversation',id),
  rename:(id:string,title:string)=>{
   if(title.length>200)return Promise.reject(Error('invalid_title'));
   return mutate('rename_my_conversation',id,{p_title:title});
  },
  moveTop:(id:string)=>mutate('move_my_conversation_to_top',id),
  touch:(id:string)=>mutate('touch_my_conversation',id),
  async removeAll(owner:string){if(!uuid.test(owner))throw Error('account_changed');const {error}=await rpc('delete_all_my_conversations',{p_expected_user_id:owner});if(error)throw Error('conversation_operation_failed');},
 };
}
