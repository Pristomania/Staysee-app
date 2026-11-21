import {ArrowUp,ArrowDown} from 'lucide-react';
import {useLayoutEffect,useRef} from 'react';

export function ConversationOrderControls({first,last,saving,onMove,onDone}:{
 first:boolean;last:boolean;saving:boolean;onMove:(direction:'up'|'down')=>void;onDone:()=>void;
}){
 const up=useRef<HTMLButtonElement>(null),down=useRef<HTMLButtonElement>(null),done=useRef<HTMLButtonElement>(null);
 const pendingFocus=useRef<'up'|'down'|null>(null);
 useLayoutEffect(()=>{
  if(saving||!pendingFocus.current)return;
  const requested=pendingFocus.current==='up'?up.current:down.current;
  const alternative=pendingFocus.current==='up'?down.current:up.current;
  pendingFocus.current=null;
  (requested&&!requested.disabled?requested:alternative&&!alternative.disabled?alternative:done.current)?.focus({preventScroll:true});
 },[saving,first,last]);
 function move(direction:'up'|'down'){pendingFocus.current=direction;onMove(direction);}
 const button='min-w-[44px] min-h-[44px] p-2 rounded-lg border border-current/20 disabled:opacity-35 disabled:cursor-default touch-manipulation';
 return <div role="group" aria-label="Порядок беседы" className="flex items-center justify-end gap-2 px-2 py-2" onClick={event=>event.stopPropagation()}>
  <button ref={up} type="button" aria-label="Переместить беседу на одну позицию вверх" disabled={first||saving} className={button} onClick={()=>move('up')}><ArrowUp aria-hidden="true" className="w-4 h-4 mx-auto"/></button>
  <button ref={down} type="button" aria-label="Переместить беседу на одну позицию вниз" disabled={last||saving} className={button} onClick={()=>move('down')}><ArrowDown aria-hidden="true" className="w-4 h-4 mx-auto"/></button>
  <button ref={done} type="button" disabled={saving} className={`${button} text-sm px-3`} onClick={onDone}>Готово</button>
  <span role="status" className="sr-only">{saving?'Сохраняю порядок…':''}</span>
 </div>;
}
