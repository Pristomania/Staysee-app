/** Monotonic authority identity prevents A→unknown→A approvals from becoming reusable. */
export function createAccessGeneration(){let last:string|undefined,generation=0;return {observe(signature:string){if(signature!==last){last=signature;generation++;}return generation;}};}
export async function readIfCurrent<T>(load:()=>Promise<T>,isCurrent:()=>boolean):Promise<T|null>{
 if(!isCurrent())return null;
 const value=await load();return isCurrent()?value:null;
}
export function commitIfCurrent<T>(value:T,isCurrent:()=>boolean,commit:(value:T)=>void):boolean{
 if(!isCurrent())return false;commit(value);return true;
}
export function requirePersistedTurn<T,U>(user:{message:T|null;error:unknown},ai:{message:U|null;error:unknown}):{user:T;ai:U}{
 if(user.error||ai.error||!user.message||!ai.message)throw Error('turn_not_saved');
 return {user:user.message,ai:ai.message};
}
