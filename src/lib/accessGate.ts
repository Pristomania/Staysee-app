import type {ConversationAccess} from './conversationAccess';

/**
 * What the access gate of a conversation screen decides, apart from React. The gate asks the server whether a person may open a
 * room (or a paid screen). It used to wait for the answer on EVERY move between screens and showed a dark "checking" page meanwhile,
 * which flashed at each transition. Two things fix that without loosening the lock:
 *  - a fresh "yes" is remembered for a short time for the exact same person-state, room and screen kind, so a move inside one
 *    conversation opens at once while the gate checks again in the background (a real "no" from that check always wins);
 *  - the "checking" page appears only if the check takes noticeable time (see .gate-delayed in index.css).
 * The server stays the authority: the rows of a locked room are refused by the database whatever this screen shows.
 */

/** How long a "yes" is trusted before the gate has heard again. Short on purpose. */
export const ACCESS_YES_MS=20_000;

const remembered=new Map<string,number>();

/** The same key the gate uses for one question: who (and in which plan state), verified or not, which room, which kind of screen. */
export const accessGateKey=(identityKey:string,verified:boolean,conversationId:string|null,requirePaid:boolean)=>
  `${identityKey}:${verified}:${conversationId}:${requirePaid}`;

export function rememberAccessYes(key:string,now=Date.now()):void{
  for(const [k,at] of remembered) if(now-at>=ACCESS_YES_MS) remembered.delete(k);
  remembered.set(key,now);
}
export function forgetAccessYes(key:string):void{remembered.delete(key);}
export function isAccessRemembered(key:string,now=Date.now()):boolean{
  const at=remembered.get(key);
  return at!==undefined&&now-at<ACCESS_YES_MS;
}

/** Does this answer let the person into this room / this kind of screen? */
export function accessGrants(access:ConversationAccess|null,conversationId:string|null,requirePaid:boolean):boolean{
  return !!access&&(!conversationId||access.allowed)&&(!requirePaid||access.paidFeatures);
}

export type GateView='open'|'checking'|'denied'|'error';

/**
 * What to show. Nothing opens while the plan is unverified. The server's answer for this very question wins over any memory.
 * With no answer yet, a fresh remembered "yes" opens the screen at once; otherwise the gate says it is checking.
 */
export function gateView(input:{
  current:{access:ConversationAccess|null;error:boolean}|null;
  remembered:boolean;verified:boolean;conversationId:string|null;requirePaid:boolean;
  /** The plan snapshot could not be read (a failed or timed-out request), as opposed to still loading. */
  planFailed?:boolean;
}):GateView{
  if(!input.verified)return input.planFailed?'error':'checking';
  if(input.current){
    if(!input.current.access)return 'error';
    return accessGrants(input.current.access,input.conversationId,input.requirePaid)?'open':'denied';
  }
  return input.remembered?'open':'checking';
}

/** How long to wait before the plan snapshot is read again after a failure: 2, 4, 8, 16 seconds, then every 30. */
export function planRetryDelayMs(failures:number):number{
  return Math.min(2_000*2**Math.max(0,Math.min(failures,10)),30_000);
}

/**
 * A background re-check that fails (a network blip) must not throw out a person who was let in a moment ago; a real answer,
 * yes or no, is always applied.
 */
export function shouldApplyAccessResult(access:ConversationAccess|null,hadRecentYes:boolean):boolean{
  return access!==null||!hadRecentYes;
}
