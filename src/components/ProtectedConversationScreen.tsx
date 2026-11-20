import {useCallback,type ReactNode} from 'react';
import {useApp} from '../context/AppContext';
import {usePlan} from '../context/PlanContext';
import {supabase} from '../lib/supabase';
import {checkConversationAccess} from '../lib/conversationAccess';
import {ConversationAccessGate} from './ConversationAccessGate';
const readAccess=(id:string|null,signal:AbortSignal)=>checkConversationAccess({rpc:(name,args)=>supabase.rpc(name,args).abortSignal(signal)},id);
export function ProtectedConversationScreen({paid=false,children}:{paid?:boolean;children:ReactNode}){
 const {ownerId,tier,loaded,accessRevision}=usePlan();
 const {currentConversation,setMessages,navigateTo}=useApp();
 const invalidate=useCallback(()=>setMessages([]),[setMessages]);
 return <ConversationAccessGate identityKey={`${ownerId}:${tier}:${accessRevision}`} verified={loaded} conversationId={currentConversation?.id??null} requirePaid={paid}
  readAccess={readAccess} onInvalidate={invalidate} onBack={()=>navigateTo('main',{conversation:null})} onPlans={()=>navigateTo('tariffs')}>
  {children}
 </ConversationAccessGate>;
}
