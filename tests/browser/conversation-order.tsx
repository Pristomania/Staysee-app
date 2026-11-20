import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationListScreen} from '../../src/components/screens/MainScreen';
import {ThemeProvider} from '../../src/context/ThemeContext';
import {createConversationClient,type ListedConversation} from '../../src/lib/conversationAccess';
import '../../src/index.css';
const owner='11111111-1111-4111-8111-111111111111';
const makeRows=(n:number)=>Array.from({length:n},(_,i)=>({id:`aaaaaaaa-aaaa-4aaa-8aaa-${String(i+1).padStart(12,'0')}`,user_id:owner,title:`Тестовая беседа ${i+1}`,is_active:true as const,created_at:'2026-01-01T00:00:00Z',last_message_at:'2026-02-01T00:00:00Z',can_read:true}));
let stored=makeRows(3), fail:boolean|'locked'|'changed'=false,delay=0,failList=false,showPreviews=false;
let calls=0,listReads=0,planRetries=0;
const client=createConversationClient(async(name,args)=>{
 if(name==='list_my_conversations'){listReads++;return failList?{data:null,error:{message:'list unavailable'}}:{data:stored.map(r=>({...r})),error:null};}
 if(name==='load_conversation_last_messages')return {data:showPreviews?Object.fromEntries((args.p_conversation_ids as string[]).map(id=>[id,'СЕКРЕТНОЕ ПРЕВЬЮ'])):{},error:null};
 if(name==='move_my_conversation_step'){
  calls++;if(delay)await new Promise(r=>setTimeout(r,delay));
  if(fail)return {data:null,error:{message:fail==='locked'?'conversation_locked':fail==='changed'?'conversation_order_changed':'network'}};
  const i=stored.findIndex(r=>r.id===args.p_conversation_id),j=i+(args.p_direction==='up'?-1:1);
  if(!stored[j]||stored[j].id!==args.p_expected_neighbor)return {data:null,error:{message:'conversation_order_changed'}};
  [stored[i],stored[j]]=[stored[j],stored[i]];return {data:true,error:null};
 }
 return {data:false,error:{message:'unexpected operation'}};
});
function Harness(){
 const [rows,setRows]=useState<ListedConversation[]>([]),[key,setKey]=useState(0),[revision,setRevision]=useState('first'),[tier,setTier]=useState<'free'|'premium'>('premium'),[result,setResult]=useState(''),[opened,setOpened]=useState('none'),[panel,setPanel]=useState(true);
 function reset(n:number,free=false){stored=makeRows(n).map((r,i)=>({...r,can_read:!free||i===0}));fail=false;delay=0;failList=false;showPreviews=false;calls=0;setRows([]);setTier(free?'free':'premium');setKey(k=>k+1);setOpened('none');setResult('');}
 function geometry(){const buttons=[...document.querySelectorAll('#fixture button')];const last=buttons.at(-1)?.getBoundingClientRect();setResult(JSON.stringify({viewport:[innerWidth,innerHeight],height:document.documentElement.scrollHeight,lastBottom:last?last.bottom+scrollY:null,scroll:scrollY,opened,calls,order:rows.map(r=>r.title)}));}
 async function regressions(){
  const pause=()=>new Promise(r=>setTimeout(r,80));
  const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('#fixture button')].find(b=>b.textContent?.trim()===label||b.getAttribute('aria-label')===label||b.querySelector('p')?.textContent===label);
  const click=async(label:string)=>{const b=button(label);if(!b||b.disabled)throw Error('Missing/enabled button: '+label);b.click();await pause();};
  const order=()=>[...document.querySelectorAll('#fixture button p:first-child')].map(p=>p.textContent);
  const check=(yes:unknown,message:string)=>{if(!yes)throw Error(message);};
  const results:string[]=[];
  try{
   reset(3);await pause();await click('Меню беседы «Тестовая беседа 2»');await click('Изменить порядок');
   const targets=[...document.querySelectorAll('#fixture [aria-label="Порядок беседы"] button')].map(b=>b.getBoundingClientRect());
   check(targets.length===3&&targets.every(r=>r.width>=44&&r.height>=44),'touch target smaller than44px');results.push('44px touch targets PASS');
   button('Переместить беседу на одну позицию вверх')!.focus();await click('Переместить беседу на одну позицию вверх');
   check(document.querySelector('#fixture [aria-label="Порядок беседы"]')?.contains(document.activeElement),'reorder lost keyboard focus');check(document.activeElement?.getAttribute('aria-label')==='Переместить беседу на одну позицию вниз','edge focus did not choose the enabled direction');results.push('focus retained after DOM reorder PASS');
   check(JSON.stringify(order())===JSON.stringify(['Тестовая беседа 2','Тестовая беседа 1','Тестовая беседа 3']),'one-step up');check(button('Переместить беседу на одну позицию вверх')?.disabled,'first up enabled');check(document.querySelector('#fixture')?.getAttribute('data-opened')==='none','arrow opened chat');results.push('up/first edge/no chat propagation PASS');
   await click('Переместить беседу на одну позицию вниз');await click('Переместить беседу на одну позицию вниз');check(JSON.stringify(order())===JSON.stringify(['Тестовая беседа 1','Тестовая беседа 3','Тестовая беседа 2']),'repeated down');check(button('Переместить беседу на одну позицию вниз')?.disabled,'last down enabled');results.push('repeat/down/last edge PASS');
   fail=true;await click('Переместить беседу на одну позицию вверх');check(order()[2]==='Тестовая беседа 2','network failure changed order');check(!!document.querySelector('#fixture [role="alert"]'),'failure invisible');results.push('failure keeps server order PASS');
   fail=false;delay=1000;const count=calls;const up=button('Переместить беседу на одну позицию вверх')!;up.click();up.click();await pause();check(calls===count+1,'rapid click submitted twice');check(button('Готово')?.disabled,'saving controls enabled');await new Promise(r=>setTimeout(r,1100));results.push('one in-flight request PASS');
   setKey(k=>k+1);await pause();check(JSON.stringify(order())===JSON.stringify(['Тестовая беседа 1','Тестовая беседа 2','Тестовая беседа 3']),'remount lost saved order');results.push('remount reads confirmed order PASS');
   reset(3);await pause();delay=1000;await click('Меню беседы «Тестовая беседа 2»');await click('Изменить порядок');button('Переместить беседу на одну позицию вверх')!.click();await pause();setRevision('second');await pause();setRevision('first');await pause();
   const reads=listReads;await new Promise(r=>setTimeout(r,1100));check(listReads===reads,'old entitlement generation refreshed the new screen after A→B→A');results.push('stale entitlement completion ignored PASS');
   reset(3);await pause();delay=1000;await click('Меню беседы «Тестовая беседа 2»');await click('Изменить порядок');button('Переместить беседу на одну позицию вверх')!.click();await pause();setKey(k=>k+1);await pause();
   const afterRemount=listReads;await new Promise(r=>setTimeout(r,1100));check(listReads===afterRemount,'unmounted screen published a late move completion');results.push('unmounted completion ignored PASS');
   reset(3);await pause();await click('Меню беседы «Тестовая беседа 2»');await click('Изменить порядок');const planBefore=planRetries;fail='locked';await click('Переместить беседу на одну позицию вверх');check(!button('Готово'),'expired ordering mode stayed open');check(planRetries===planBefore+1,'expired response did not request plan recheck');check(document.querySelector('#fixture [role="alert"]')?.textContent?.includes('действующим тарифом'),'expired refusal not explained');results.push('server expiry closes ordering and rechecks plan PASS');
   reset(3);showPreviews=true;await pause();await pause();check(document.querySelector('#fixture')?.textContent?.includes('СЕКРЕТНОЕ ПРЕВЬЮ'),'fixture preview not loaded');await click('Меню беседы «Тестовая беседа 2»');await click('Изменить порядок');fail='locked';failList=true;await click('Переместить беседу на одну позицию вверх');const revokedSafe=!document.querySelector('#fixture')?.textContent?.includes('СЕКРЕТНОЕ ПРЕВЬЮ')&&!button('Тестовая беседа 2');results.push('revoked rights + failed list hides old content '+(revokedSafe?'PASS':'FAIL'));
   reset(3);await pause();await click('Меню беседы «Тестовая беседа 2»');await click('Изменить порядок');fail='changed';failList=true;await click('Переместить беседу на одну позицию вверх');check(!document.querySelector('#fixture [role="alert"]')?.textContent?.includes('Список обновлён'),'failed refresh claimed success');results.push('conflict + failed list never claims refresh PASS');check(revokedSafe,'failed refresh retained revoked preview/rows');failList=false;await click('Обновить список');check(!!button('Тестовая беседа 2'),'explicit list retry did not restore confirmed rows');
   reset(3,true);await pause();await click('Меню беседы «Тестовая беседа 2»');check(!button('Изменить порядок'),'free reorder available');check(!!button('Переименовать')&&!!button('Удалить'),'free actions lost');await click('Тестовая беседа 2');check(!!document.querySelector('#fixture [role="alert"]'),'locked row opened');check(document.querySelector('#fixture')?.getAttribute('data-opened')==='none','locked chat navigation occurred');await click('Тестовая беседа 1');check(document.querySelector('#fixture')?.getAttribute('data-opened')==='aaaaaaaa-aaaa-4aaa-8aaa-000000000001','normal tap did not open readable chat');results.push('free locks/rename/delete/normal tap PASS');
   setResult(results.join('\n')+'\nAll browser regressions PASS');
  }catch(error){setResult(results.join('\n')+'\nFAIL '+String(error));}
 }
 return <>{panel&&<div style={{position:'fixed',bottom:0,left:0,zIndex:100,background:'white',color:'black',fontSize:12,maxWidth:'100%',display:'flex',flexWrap:'wrap'}}>
  <button onClick={()=>reset(1)}>1 беседа</button><button onClick={()=>reset(3)}>3 беседы</button><button onClick={()=>reset(30)}>30 бесед</button><button onClick={()=>reset(3,true)}>Бесплатный</button>
  <button onClick={()=>{fail=!fail;setResult(`Сбой ${fail}`);}}>Сбой</button><button onClick={()=>{delay=1000;setResult('Задержка 1с');}}>Задержка</button><button onClick={geometry}>Замер</button><button onClick={()=>setKey(k=>k+1)}>Перечитать</button>
  <button onClick={()=>void regressions()}>Запустить регрессии</button>
  <button onClick={()=>setPanel(false)}>Скрыть проверочную панель</button>
  <output id="result" style={{maxWidth:'100%',overflowWrap:'anywhere'}}>{result}</output>
 </div>}<div id="fixture" data-opened={opened}><ThemeProvider><ConversationListScreen key={key} userId={owner} tier={tier} revision={revision} planLoaded maxConversations={50} conversations={rows} setConversations={setRows} client={client} onRetryPlan={()=>{planRetries++;}} navigateTo={(_screen,args)=>setOpened(args?.conversation?.id??'other')} setMessages={()=>{}}/></ThemeProvider></div></>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
