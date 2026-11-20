import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { fetchBillingSnapshot } from '../lib/usageTier';
import { BillingSnapshotController, type BillingSnapshotState } from '../lib/billingSnapshot';
import {createAccessGeneration} from '../lib/accessGeneration';
import {planRetryDelayMs} from '../lib/accessGate';
import type { MessageCounter } from '../lib/messageCounter';
import { getMaxRooms } from '../lib/roomLimits';
import { isFeatureAvailable, normalizePlanId, planFor, type Plan, type PlanFeature, type PlanId } from '../lib/plans';

interface PlanContextType {
  ownerId: string | null;
  accessRevision: string;
  tier: PlanId;
  plan: Plan;
  /** Verified current session only; unknown/sleep-unverified never opens paid features. */
  loaded: boolean;
  has: (feature: PlanFeature) => boolean;
  counter: MessageCounter | null;
  maxConversations: number;
  freeRenewable: boolean;
  verificationError: boolean;
  checking: boolean;
  refresh: () => Promise<void>;
}
const PlanContext = createContext<PlanContextType | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return <PlanStateProvider userId={user?.id ?? null} readSnapshot={fetchBillingSnapshot}>{children}</PlanStateProvider>;
}

/** Session-bound state provider. Injected read boundary also supports isolated staging without authentication writes. */
export function PlanStateProvider({userId,readSnapshot,children}:{
  userId:string|null;readSnapshot:(signal:AbortSignal)=>Promise<unknown>;children:ReactNode;
}) {
  const [state,setState]=useState<(BillingSnapshotState&{generation:number})|null>(null);
  const generation=useRef(createAccessGeneration());
  const currentUserRef=useRef(userId);
  currentUserRef.current=userId;
  const modelRef=useRef<BillingSnapshotController|null>(null);
  const refresh=useCallback(async()=>{
    const model=modelRef.current;
    if(model&&model.userId===userId)await model.refresh();
  },[userId]);
  useEffect(()=>{
    setState(null);
    if(!userId)return;
    const model=new BillingSnapshotController(userId,readSnapshot);
    modelRef.current=model;
    const unsubscribe=model.subscribe(next=>{
      if (currentUserRef.current !== userId) return;
      const authority=JSON.stringify([next.userId,next.loaded,next.tier,next.row?.access_source,next.row?.paid_access_until,next.row?.unlimited_usage,next.row?.max_conversations_override]);
      setState({...next,generation:generation.current.observe(authority)});
    });
    void model.refresh();
    const verify=()=>{void model.refresh({requireFresh:true});};
    const visible=()=>{if(document.visibilityState==='visible')verify();};
    document.addEventListener('visibilitychange',visible);
    window.addEventListener('focus',verify);window.addEventListener('pageshow',verify);window.addEventListener('online',verify);
    return ()=>{
      unsubscribe();model.dispose();
      if(modelRef.current===model)modelRef.current=null;
      document.removeEventListener('visibilitychange',visible);
      window.removeEventListener('focus',verify);window.removeEventListener('pageshow',verify);window.removeEventListener('online',verify);
    };
  },[userId,readSnapshot]);
  // A plan read that failed or timed out is tried again by itself (2, 4, 8, 16, then every 30 seconds): a screen that waits for the plan
  // must recover from one bad request without the person having to do anything.
  const failures=useRef(0);
  useEffect(()=>{
    if(!userId||!state||state.userId!==userId)return;
    if(state.loaded){failures.current=0;return;}
    if(!state.error)return;
    const timer=setTimeout(()=>{void modelRef.current?.refresh();},planRetryDelayMs(failures.current));
    failures.current+=1;
    return()=>clearTimeout(timer);
  },[state,userId]);
  const value=useMemo<PlanContextType>(()=>{
    // This synchronous check prevents even one render of the previous person's plan.
    const current=state?.userId===userId?state:null;
    const row=current?.row ?? null;
    const loaded=current?.loaded ?? false;
    const tier=normalizePlanId(row?.tier);
    return {ownerId:userId,accessRevision:String(current?.generation??0),tier,plan:planFor(tier),loaded,
      has:feature=>loaded&&isFeatureAvailable(tier,feature),
      counter:current?.counter??null,
      maxConversations:getMaxRooms(tier, row?.max_conversations_override),
      freeRenewable:current?.freeRenewable??false,
      verificationError:current?.error??false,
      checking:current?.checking??!!userId,
      refresh,
    };
  },[state,userId,refresh]);
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}
export function usePlan(): PlanContextType {
  const context=useContext(PlanContext);
  if(!context)throw new Error('usePlan must be used inside PlanProvider');
  return context;
}
