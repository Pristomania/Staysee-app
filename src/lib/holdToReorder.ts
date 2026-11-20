interface Host {schedule:(fn:()=>void)=>number;cancel:(id:number)=>void;isTop:(y:number)=>boolean;onMove:(id:string)=>void;onArmed:(id:string|null)=>void}
/** A quick vertical move remains scrolling; only hold then drop on the top row reorders. */
export function createHoldToReorder(host:Host){
 let pending:{id:string;x:number;y:number}|null=null,timer:number|undefined,armed=false;
 const reset=()=>{if(timer!==undefined)host.cancel(timer);timer=undefined;pending=null;armed=false;host.onArmed(null);};
 return {
  start(id:string,x:number,y:number,allowed:boolean){reset();if(!allowed)return;pending={id,x,y};timer=host.schedule(()=>{timer=undefined;if(pending){armed=true;host.onArmed(id);}});},
  move(x:number,y:number){if(pending&&!armed&&Math.hypot(x-pending.x,y-pending.y)>8)reset();},
  end(y:number){const held=armed,id=pending?.id;reset();if(held&&id&&host.isTop(y))host.onMove(id);return held;},
  cancel:reset,isArmed:()=>armed,
 };
}
