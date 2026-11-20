/** User-JWT RPC only. No service-role lookup/fallback and no permissive cache. */
export interface ConversationAccess {allowed:boolean;paidFeatures:boolean;fullAccess:boolean}
export interface AccessRpcClient {
 rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:unknown}>;
}
export async function checkConversationAccess(client:AccessRpcClient,conversationId:string|null):Promise<ConversationAccess|null>{
 try {
  const {data,error}=await client.rpc('get_my_conversation_access',{p_conversation_id:conversationId});
  if(error||!data||typeof data!=='object'||Array.isArray(data))return null;
  const r=data as Record<string,unknown>;
  if(Object.keys(r).length!==3||typeof r.allowed!=='boolean'||typeof r.paidFeatures!=='boolean'||typeof r.fullAccess!=='boolean')return null;
  return {allowed:r.allowed,paidFeatures:r.paidFeatures,fullAccess:r.fullAccess};
 }catch{return null;}
}
