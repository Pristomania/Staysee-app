import {createContext,useContext,useEffect,useMemo,useRef,type ReactNode} from 'react';
import {usePlan} from './PlanContext';
interface Lease {signal:AbortSignal;isCurrent:()=>boolean;getDraft:(id:string)=>string;setDraft:(id:string,value:string)=>void}
const Context=createContext<Lease|null>(null);
/** Authority survives navigation; only owner/verified entitlement changes revoke in-flight work. Drafts are memory-only. */
export function ConversationLeaseProvider({children}:{children:ReactNode}){
 const {ownerId,tier,loaded,accessRevision}=usePlan();
 const key=`${ownerId}:${tier}:${loaded}:${accessRevision}`;
 const current=useRef(key);current.current=key;
 const drafts=useMemo(()=>new Map<string,string>(),[ownerId]);
 const lease=useMemo(()=>{
  let controller=new AbortController();
  return {get signal(){return controller.signal;},abort:()=>controller.abort(),renew:()=>{if(controller.signal.aborted)controller=new AbortController();},isCurrent:()=>current.current===key&&!controller.signal.aborted,
   getDraft:(id:string)=>drafts.get(id)??'',setDraft:(id:string,value:string)=>{if(value)drafts.set(id,value);else drafts.delete(id);},
  };
 },[key,drafts]);
 useEffect(()=>{lease.renew();return()=>lease.abort();},[lease]);
 return <Context.Provider value={lease}>{children}</Context.Provider>;
}
export const useConversationLease=()=>useContext(Context);
