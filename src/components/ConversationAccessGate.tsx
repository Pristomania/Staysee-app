import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {ConversationAccess} from '../lib/conversationAccess';
import {accessGateKey,accessGrants,forgetAccessYes,gateView,isAccessRemembered,rememberAccessYes,shouldApplyAccessResult} from '../lib/accessGate';
export function ConversationAccessGate({identityKey,verified,conversationId,requirePaid,readAccess,onInvalidate,onBack,onPlans,children}:{
 identityKey:string;verified:boolean;conversationId:string|null;requirePaid:boolean;
 readAccess:(id:string|null,signal:AbortSignal)=>Promise<ConversationAccess|null>;
 onInvalidate:()=>void;onBack:()=>void;onPlans:()=>void;children:ReactNode;
}){
 const key=accessGateKey(identityKey,verified,conversationId,requirePaid);
 const currentKey=useRef(key);currentKey.current=key;
 const [state,setState]=useState<{key:string;access:ConversationAccess|null;error:boolean}|null>(null);
 const [retry,setRetry]=useState(0);
 useEffect(()=>{
  onInvalidate();
  if(!verified)return;
  // A "yes" heard a moment ago for this very question lets the screen open at once; this check still runs and can take it back.
  const hadRecentYes=isAccessRemembered(key);
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),8000);
  let active=true;
  const settle=(access:ConversationAccess|null)=>{
   if(abort.signal.aborted&&access!==null)return;
   clearTimeout(timer);
   if(!(active&&currentKey.current===key))return;
   if(!shouldApplyAccessResult(access,hadRecentYes))return;
   if(accessGrants(access,conversationId,requirePaid))rememberAccessYes(key);else forgetAccessYes(key);
   setState({key,access,error:access===null});
  };
  void readAccess(conversationId,abort.signal).then(settle,()=>settle(null));
  const timeout=()=>settle(null);abort.signal.addEventListener('abort',timeout,{once:true});
  return()=>{active=false;clearTimeout(timer);abort.abort();};
 },[key,verified,conversationId,requirePaid,readAccess,onInvalidate,retry]);
 const current=state?.key===key?state:null;
 const view=gateView({current,remembered:isAccessRemembered(key),verified,conversationId,requirePaid});
 if(view==='open')return <>{children}</>;
 const denied=view==='denied';
 const failed=view==='error';
 // Only the "checking" page is delayed (a fast check is never seen); a locked room or a failed check is shown at once.
 return <div className={`min-h-screen bg-[#111e19] text-[#e5e4da] flex items-center justify-center p-6${view==='checking'?' gate-delayed':''}`}><section className="max-w-sm space-y-4 text-center" aria-live="polite">
  <p>{denied?'Ваши данные сохранены. Беседа будет доступна после оплаты.':failed?'Не удалось проверить доступ. Проверьте интернет и попробуйте снова.':'Проверяем доступ…'}</p>
  {denied&&<button type="button" className="underline block mx-auto p-2" onClick={onPlans}>Посмотреть тарифы</button>}
  {failed&&<button type="button" className="underline block mx-auto p-2" onClick={()=>{setState(null);setRetry(v=>v+1);}}>Повторить проверку</button>}
  <button type="button" className="underline p-2" onClick={onBack}>К беседам</button>
 </section></div>;
}
