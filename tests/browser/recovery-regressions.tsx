import React,{StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {AuthProvider,useAuth} from '../../src/context/AuthContext';
import {ThemeProvider} from '../../src/context/ThemeContext';
import {ConversationListScreen} from '../../src/components/screens/MainScreen';
import {clearPasswordRecoveryPending,markPasswordRecoveryPending,shouldStartInPasswordRecovery} from '../../src/lib/passwordRecovery';
import {supabase} from '../../src/lib/supabase';
import {ConversationAccessGate} from '../../src/components/ConversationAccessGate';
import {accessGateKey,rememberAccessYes,forgetAccessYes} from '../../src/lib/accessGate';
import {forgetRoomDeletedNotice,peekRoomDeletedNotice} from '../../src/lib/roomDeletedNotice';
import '../../src/index.css';

const fixture=document.querySelector('#fixture')!;
const output=document.querySelector('#results')!;
const pause=(ms=35)=>new Promise<void>(done=>setTimeout(done,ms));
const check=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
let root:Root|null=null;
const render=(node:React.ReactNode)=>{root?.unmount();root=createRoot(fixture);root.render(node);};
function Probe(){const a=useAuth();return <><output id="auth-state" data-user={a.user?.id??'none'} data-profile={a.profile?.id??'none'} data-loading={String(a.loading)} data-recovery={String(a.passwordRecoveryPending)}>User:{a.user?.id??'none'}; profile:{a.profile?.id??'none'}; recovery:{String(a.passwordRecoveryPending)}</output><button id="refresh-profile" onClick={()=>void a.refreshProfile()}>Refresh profile</button><button id="explicit-sign-in" onClick={()=>void a.signIn('alpha@example.invalid','fictional-test-only')}>Explicit sign-in</button></>;}
const state=(attribute:string)=>fixture.querySelector('#auth-state')?.getAttribute(attribute);
const user=(id:string)=>({id,email:`${id}@example.invalid`,app_metadata:{},user_metadata:{},aud:'authenticated',created_at:'2026-01-01T00:00:00Z'});
const session=(id:string)=>({user:user(id),expires_at:Math.floor(Date.now()/1000)+3600,access_token:'fictional-test-only',refresh_token:'fictional-test-only',token_type:'bearer',expires_in:3600});

async function withAuthBoundary(run:(boundary:{emit:(event:string,id:string|null)=>void;restore:(id:string|null)=>void;failRestore:()=>void;flushSignOut:()=>void;finishSignIn:()=>void;remount:()=>void;signOutCalls:()=>number;failProfile:(id:string)=>void;resolveProfile:(id:string,deleted?:boolean)=>void})=>Promise<void>,deferProfiles=false,deferSignOut=false,deferSignIn=false,persistedRecovery=false){
 const auth=supabase.auth as unknown as Record<string,unknown>;
 const originals={getSession:auth.getSession,onAuthStateChange:auth.onAuthStateChange,getUser:auth.getUser,signOut:auth.signOut,signInWithPassword:auth.signInWithPassword,from:supabase.from};
 const callbacks=new Set<(event:string,session:unknown)=>void>();
 const profileReads=new Map<string,((value:unknown)=>void)[]>();
 let restored!:(value:unknown)=>void,current:string|null=null,signOutCalls=0,finishSignOut:(()=>void)|null=null,finishSignIn:(()=>void)|null=null;
 const restoring=new Promise(done=>{restored=done;});
 auth.getSession=()=>restoring;
 auth.onAuthStateChange=(callback:(event:string,session:unknown)=>void)=>{callbacks.add(callback);return {data:{subscription:{unsubscribe:()=>callbacks.delete(callback)}}};};
 auth.getUser=async()=>({data:{user:current?user(current):null},error:null});
 auth.signOut=async()=>{signOutCalls++;if(deferSignOut)await new Promise<void>(done=>{finishSignOut=done;});current=null;for(const callback of [...callbacks])callback('SIGNED_OUT',null);return {error:null};};
 auth.signInWithPassword=async()=>{current='alpha';for(const callback of [...callbacks])callback('SIGNED_IN',session('alpha'));if(deferSignIn)await new Promise<void>(done=>{finishSignIn=done;});return {data:{user:user('alpha'),session:session('alpha')},error:null};};
 supabase.from=((table:string)=>{check(table==='profiles','unexpected backend write/query');let id='';const query={select:()=>query,eq:(_key:string,value:string)=>{id=value;return query;},maybeSingle:()=>deferProfiles?new Promise(done=>{const list=profileReads.get(id)??[];list.push(done);profileReads.set(id,list);}):Promise.resolve({data:{id,room_deletion_requested_at:null,room_purge_after:null},error:null})};return query;}) as never;
 try{
  clearPasswordRecoveryPending();sessionStorage.removeItem('staysee:deleted-room-owners');forgetRoomDeletedNotice();if(persistedRecovery)markPasswordRecoveryPending();render(<StrictMode><AuthProvider><Probe/></AuthProvider></StrictMode>);await pause();
  await run({
   emit(event,id){if(event!=='INITIAL_SESSION')current=id;for(const callback of [...callbacks])callback(event,id?session(id):null);},
   restore(id){restored({data:{session:id?session(id):null},error:null});},
   failRestore(){restored({data:{session:null},error:Error('controlled restore failure')});},
   flushSignOut(){finishSignOut?.();},finishSignIn(){finishSignIn?.();},remount(){render(<StrictMode><AuthProvider><Probe/></AuthProvider></StrictMode>);},signOutCalls(){return signOutCalls;},
   failProfile(id){for(const done of profileReads.get(id)??[])done({data:null,error:Error('controlled profile failure')});},
   resolveProfile(id,deleted=false){for(const done of profileReads.get(id)??[])done({data:{id,room_deletion_requested_at:deleted?'2026-01-01T00:00:00Z':null,room_purge_after:deleted?'2026-04-01T00:00:00Z':null},error:null});},
  });
 }finally{root?.unmount();root=null;Object.assign(auth,{getSession:originals.getSession,onAuthStateChange:originals.onAuthStateChange,getUser:originals.getUser,signOut:originals.signOut,signInWithPassword:originals.signInWithPassword});supabase.from=originals.from;clearPasswordRecoveryPending();sessionStorage.removeItem('staysee:deleted-room-owners');forgetRoomDeletedNotice();}
}

const tests:[string,()=>Promise<void>][]=[
 ['deleted owner cannot reappear on refresh or remount while profile is unavailable; another owner still enters',()=>withAuthBoundary(async b=>{
  b.restore('alpha');await pause();b.resolveProfile('alpha',true);await pause();check(state('data-user')==='none','initial deletion rejection missing');
  b.emit('TOKEN_REFRESHED','alpha');await pause();check(state('data-user')==='none','refresh republished known deleted owner before profile');b.failProfile('alpha');await pause();check(state('data-user')==='none','failed profile revived deleted owner');
  b.remount();await pause();check(state('data-user')==='none','remount restored rejected owner');b.emit('SIGNED_IN','alpha');await pause();check(state('data-user')==='none','same-owner login reopened deleted room');b.emit('PASSWORD_RECOVERY','alpha');await pause();check(state('data-recovery')==='false','known deleted owner reopened password reset');
  b.emit('SIGNED_IN','beta');await pause();b.resolveProfile('beta');await pause();check(state('data-user')==='beta','rejection blocked legitimate different owner');b.emit('PASSWORD_RECOVERY','beta');await pause();b.emit('INITIAL_SESSION','alpha');await pause();check(state('data-recovery')==='true','stale rejected initial snapshot erased another owner recovery');
 },true)],
 ...['SIGNED_IN','TOKEN_REFRESHED'].map(first=>[`persisted recovery binds on early ${first} and survives later same-owner refocus`,()=>withAuthBoundary(async b=>{
  b.emit(first,'alpha');b.restore(null);await pause();b.emit('SIGNED_IN','alpha');await pause();check(state('data-recovery')==='true','early auth event lost restored recovery');check(shouldStartInPasswordRecovery(),'persisted recovery cleared');
 },false,false,false,true)] as [string,()=>Promise<void>]),
 ['persisted recovery remains owner-bound after remount and does not apply to another account',()=>withAuthBoundary(async b=>{
  b.emit('PASSWORD_RECOVERY','alpha');b.restore(null);await pause();b.remount();await pause();b.emit('SIGNED_IN','alpha');await pause();check(state('data-recovery')==='true','own recovery lost on remount');b.emit('SIGNED_IN','beta');await pause();check(state('data-user')==='beta','new account blocked');check(state('data-recovery')==='false','another account inherited recovery');
 })],
 ...['alpha','beta'].map(owner=>[`a suspended explicit sign-in cannot consume a newer recovery episode for ${owner}`,()=>withAuthBoundary(async b=>{
  b.restore(null);await pause();fixture.querySelector<HTMLButtonElement>('#explicit-sign-in')!.click();await pause();b.emit('PASSWORD_RECOVERY',owner);await pause();b.finishSignIn();await pause();
  check(state('data-user')===owner,'late sign-in replaced recovery owner');check(state('data-recovery')==='true','late sign-in consumed newer recovery');check(shouldStartInPasswordRecovery(),'new recovery no longer persisted');
 },false,false,true)] as [string,()=>Promise<void>]),
 ['sign-in during restore is not lost to an older empty snapshot',()=>withAuthBoundary(async b=>{
  b.emit('SIGNED_IN','alpha');b.restore(null);await pause();
  check(state('data-user')==='alpha',`expected alpha after callback, got ${state('data-user')}`);
 })],
 ['late INITIAL_SESSION cannot erase a later authoritative sign-in',()=>withAuthBoundary(async b=>{
  b.restore('alpha');await pause();b.emit('SIGNED_IN','beta');b.emit('INITIAL_SESSION',null);await pause();
  check(state('data-user')==='beta',`stale initial snapshot erased beta: ${state('data-user')}`);
 })],
 ['sign-out beats a pending restored session',()=>withAuthBoundary(async b=>{
  b.emit('SIGNED_OUT',null);b.restore('alpha');await pause();check(state('data-user')==='none','restoration resurrected signed-out user');
 })],
 ['late profile of the previous owner cannot overwrite the current profile',()=>withAuthBoundary(async b=>{
  b.restore('alpha');await pause();b.emit('SIGNED_IN','beta');await pause();b.resolveProfile('beta');await pause();b.resolveProfile('alpha');await pause();
  check(state('data-user')==='beta','current user changed');check(state('data-profile')==='beta',`late old profile published: ${state('data-profile')}`);
 },true)],
 ['password recovery is retained while restoring the authenticated user',()=>withAuthBoundary(async b=>{
  b.emit('PASSWORD_RECOVERY','alpha');b.restore(null);await pause();check(state('data-recovery')==='true','recovery flag was cleared');check(state('data-user')==='alpha','recovery session was lost');
 })],
 ['a failed restore must not launch a global logout that can erase a new sign-in',()=>withAuthBoundary(async b=>{
  b.failRestore();await pause();b.emit('SIGNED_IN','beta');b.flushSignOut();await pause();
  check(state('data-user')==='beta','failed restore logged out the newer user');check(b.signOutCalls()===0,'an unverified restore launched SDK signOut');
 },false,true)],
 ['public refreshProfile cannot publish a previous owner after account switch',()=>withAuthBoundary(async b=>{
  b.restore('alpha');await pause();b.resolveProfile('alpha');await pause();fixture.querySelector<HTMLButtonElement>('#refresh-profile')!.click();await pause();
  b.emit('SIGNED_IN','beta');await pause();b.resolveProfile('beta');await pause();b.resolveProfile('alpha');await pause();check(state('data-profile')==='beta',`old public refresh replaced beta: ${state('data-profile')}`);
 },true)],
 ['same-owner SIGNED_IN on refocus cannot cancel password recovery before completion',()=>withAuthBoundary(async b=>{
  b.restore('alpha');await pause();b.emit('PASSWORD_RECOVERY','alpha');await pause();b.emit('SIGNED_IN','alpha');await pause();
  check(state('data-recovery')==='true','generic sign-in cleared recovery');check(shouldStartInPasswordRecovery(),'recovery would be lost on reload');
 })],
 ['late explicit-signIn deleted-profile response cannot log out a newer owner',()=>withAuthBoundary(async b=>{
  b.restore(null);await pause();fixture.querySelector<HTMLButtonElement>('#explicit-sign-in')!.click();await pause();b.emit('SIGNED_IN','beta');await pause();b.resolveProfile('beta');await pause();b.resolveProfile('alpha',true);await pause();
  check(state('data-user')==='beta','old sign-in deletion check logged out beta');
 },true)],
 ['a current deleted profile closes the view and preserves its availability notice without SDK logout',()=>withAuthBoundary(async b=>{
  b.restore('alpha');await pause();b.resolveProfile('alpha',true);await pause();
  check(state('data-user')==='none','deleted owner stayed in the UI');check(state('data-profile')==='none','deleted profile stayed visible');check(peekRoomDeletedNotice()?.availableFrom==='2026-04-01T00:00:00Z','deleted-room notice lost its date');check(b.signOutCalls()===0,'profile rejection launched an owner-unsafe SDK logout');
 },true)],
 ['an explicit sign-in to a deleted room closes the view and retains the availability date',()=>withAuthBoundary(async b=>{
  b.restore(null);await pause();fixture.querySelector<HTMLButtonElement>('#explicit-sign-in')!.click();await pause();b.resolveProfile('alpha',true);await pause();check(state('data-user')==='none','explicit deleted login stayed open');check(peekRoomDeletedNotice()?.availableFrom==='2026-04-01T00:00:00Z','explicit deleted login lost its date');check(b.signOutCalls()===0,'explicit deleted login launched unsafe global logout');
 },true)],
 ['late explicit-signIn completion cannot clear a newer recovery event for the same owner',()=>withAuthBoundary(async b=>{
  b.restore(null);await pause();fixture.querySelector<HTMLButtonElement>('#explicit-sign-in')!.click();await pause();b.emit('PASSWORD_RECOVERY','alpha');await pause();b.resolveProfile('alpha');await pause();
  check(state('data-recovery')==='true','old sign-in completion cleared newer recovery');check(shouldStartInPasswordRecovery(),'recovery was not persisted');
 },true)],
 ['failed initial plan gives a retry without reading or rendering private rows',async()=>{
  let lists=0,retries=0;
  const props={userId:'alpha',tier:'free' as const,planLoaded:false,maxConversations:1,planFailed:true,onRetryPlan:()=>{retries++;},navigateTo:()=>{},setMessages:()=>{},conversations:[{id:'private',user_id:'alpha',title:'PRIVATE OLD TITLE',is_active:true,created_at:'2026-01-01',can_read:true}],setConversations:()=>{},client:{list:async()=>{lists++;return[];},previews:async()=>({})} as never};
  render(<ThemeProvider><ConversationListScreen {...props}/></ThemeProvider>);await pause();
  check(fixture.textContent?.includes('Не удалось проверить доступ'),'missing failed-plan explanation');
  const retry=[...fixture.querySelectorAll('button')].find(b=>b.textContent==='Повторить проверку');check(retry,'missing retry button');retry!.click();await pause();
  check(retries===1,'retry did not call the plan reader');check(lists===0,'unverified plan read private list');check(!fixture.textContent?.includes('PRIVATE OLD TITLE'),'unverified plan leaked an old title');
 }],
 ['slow initial plan gives a retry after eight seconds and opens nothing',async()=>{
  const props={userId:'alpha',tier:'free' as const,planLoaded:false,maxConversations:1,navigateTo:()=>{},setMessages:()=>{},conversations:[],setConversations:()=>{},client:{list:async()=>{throw Error('private list must not be read');},previews:async()=>({})} as never};
  render(<ThemeProvider><ConversationListScreen {...props}/></ThemeProvider>);await pause();check(!fixture.textContent?.includes('Проверка идёт дольше обычного'),'slow hint appeared immediately');await pause(8100);
  check(fixture.textContent?.includes('Проверка идёт дольше обычного'),'missing slow-plan explanation after eight seconds');check([...fixture.querySelectorAll('button')].some(b=>b.textContent==='Повторить проверку'),'missing slow-plan retry');
 }],
 ['a slow access gate first becomes visible around450ms, never while opacity is zero',async()=>{
  const identity='browser-css-delay',room='css-room',key=accessGateKey(identity,true,room,false);forgetAccessYes(key);
  let mountedAt:number|null=null;
  const observer=new MutationObserver(()=>{if(mountedAt===null&&[...fixture.querySelectorAll('p')].some(e=>e.textContent==='Проверяем доступ…'))mountedAt=performance.now();});
  observer.observe(fixture,{childList:true,subtree:true});
  render(<ConversationAccessGate identityKey={identity} verified={true} conversationId={room} requirePaid={false} readAccess={()=>new Promise(()=>{})} onInvalidate={()=>{}} onBack={()=>{}} onPlans={()=>{}}><p>PRIVATE GATE CHILD</p></ConversationAccessGate>);
  const mountWait=performance.now();while(mountedAt===null&&performance.now()-mountWait<1000)await pause(10);
  if(mountedAt===null){observer.disconnect();throw Error('access gate did not mount');}
  const start=mountedAt;let firstVisible:number|null=null,samples=0;
  while(performance.now()-start<900){
   await pause(50);samples++;
   const p=[...fixture.querySelectorAll('p')].find(e=>e.textContent==='Проверяем доступ…');
   if(p){let opacity=1;for(let a:HTMLElement|null=p;a;a=a.parentElement)opacity*=Number(getComputedStyle(a).opacity);if(opacity>0.05&&firstVisible===null)firstVisible=performance.now()-start;}
  }
  observer.disconnect();
  check(!fixture.textContent?.includes('PRIVATE GATE CHILD'),'unverified child rendered');
  check(firstVisible!==null&&firstVisible>=400&&firstVisible<850,`visible onset ${firstVisible}ms, samples${samples}`);
  output.setAttribute('data-gate-onset-ms',String(Math.round(firstVisible!)));
 }],
 ['a protected screen explains an unverified plan after eight seconds and retries only the plan',async()=>{
  let retries=0,reads=0;
  render(<ConversationAccessGate identityKey="gate-slow-plan" verified={false} conversationId="closed-room" requirePaid={false} readAccess={()=>{reads++;return Promise.resolve(null);}} onRetryPlan={()=>{retries++;}} onInvalidate={()=>{}} onBack={()=>{}} onPlans={()=>{}}><p>PRIVATE SLOW CHILD</p></ConversationAccessGate>);
  await pause();check(!fixture.textContent?.includes('дольше обычного'),'protected slow hint appeared immediately');await pause(8100);
  check(fixture.textContent?.includes('Проверка идёт дольше обычного'),'protected slow hint missing after eight seconds');
  const retry=[...fixture.querySelectorAll('button')].find(b=>b.textContent==='Повторить проверку');check(retry,'protected slow retry missing');retry!.click();await pause();
  check(retries===1,'protected retry did not refresh the plan');check(reads===0,'unverified plan attempted a private access read');check(!fixture.textContent?.includes('PRIVATE SLOW CHILD'),'protected slow child leaked');
 }],
 ['a protected screen explains a failed plan immediately without rendering its child',async()=>{
  let retries=0;
  render(<ConversationAccessGate identityKey="gate-failed-plan" verified={false} planFailed={true} conversationId="closed-room" requirePaid={false} readAccess={()=>Promise.resolve(null)} onRetryPlan={()=>{retries++;}} onInvalidate={()=>{}} onBack={()=>{}} onPlans={()=>{}}><p>PRIVATE FAILED CHILD</p></ConversationAccessGate>);
  await pause();check(fixture.textContent?.includes('Не удалось проверить доступ'),'protected error missing');const retry=[...fixture.querySelectorAll('button')].find(b=>b.textContent==='Повторить проверку');check(retry,'protected error retry missing');retry!.click();await pause();check(retries===1,'protected error retry did not refresh plan');check(!fixture.textContent?.includes('PRIVATE FAILED CHILD'),'protected failed child leaked');
 }],
 ['a cached access grant opens immediately at19s but a remount after21s must wait for the server',async()=>{
  const identity='browser-cache-boundary',room='cache-room',key=accessGateKey(identity,true,room,false);forgetAccessYes(key);rememberAccessYes(key);
  const gate=()=> <ConversationAccessGate identityKey={identity} verified={true} conversationId={room} requirePaid={false} readAccess={()=>new Promise(()=>{})} onInvalidate={()=>{}} onBack={()=>{}} onPlans={()=>{}}><p>PRIVATE CACHE CHILD</p></ConversationAccessGate>;
  try{
   render(gate());await pause();check(fixture.textContent?.includes('PRIVATE CACHE CHILD'),'fresh yes did not open');await pause(19000);
   render(gate());await pause();check(fixture.textContent?.includes('PRIVATE CACHE CHILD'),'19s grant expired too soon');await pause(2100);
   render(gate());await pause();check(!fixture.textContent?.includes('PRIVATE CACHE CHILD'),'expired grant opened without server verification');check(fixture.textContent?.includes('Проверяем доступ'),'expired grant did not ask again');
  }finally{forgetAccessYes(key);}
 }],
];
async function runTests(selected=tests){
 const button=document.querySelector<HTMLButtonElement>('#run')!;if(button.disabled)return;const timingButton=document.querySelector<HTMLButtonElement>('#run-timing')!;button.disabled=true;timingButton.disabled=true;const results:{name:string;status:string;ms:number;message?:string}[]=[];
 for(const [name,run] of selected){const at=performance.now();try{await run();results.push({name,status:'PASS',ms:Math.round(performance.now()-at)});}catch(error){results.push({name,status:'FAIL',message:error instanceof Error?error.message:'unknown',ms:Math.round(performance.now()-at)});}finally{root?.unmount();root=null;}output.textContent=JSON.stringify(results,null,2);}
 document.querySelector('#summary')!.textContent=`Завершено: ${results.filter(r=>r.status==='PASS').length}/${results.length} PASS; ошибок: ${results.filter(r=>r.status==='FAIL').length}.`;
 button.disabled=false;timingButton.disabled=false;
}
document.querySelector<HTMLButtonElement>('#run')!.onclick=()=>void runTests();
document.querySelector<HTMLButtonElement>('#run-timing')!.onclick=()=>void runTests(tests.filter(([name])=>name.startsWith('a slow access gate first')));
