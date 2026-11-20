import {supabase} from './supabase';
import {createConversationClient} from './conversationAccess';
export const conversationClient=createConversationClient(async(name,args,signal)=>{
 const query=supabase.rpc(name,args);
 return await (signal?query.abortSignal(signal):query);
});
