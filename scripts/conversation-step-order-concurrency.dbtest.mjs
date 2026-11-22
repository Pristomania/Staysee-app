// Real PostgreSQL sessions in a disposable, network-isolated container.
// Uses an already installed image; never connects to a shared/prod database.
import {execFileSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {archiveDatabase,uid,oldest as A,middle as B,top as C} from './lib/archive-access-test-db.mjs';
const container='staysee-step-order-qa-20261122';
const image='public.ecr.aws/supabase/postgres:17.6.1.121';
const sql=[];
const literal=value=>value===null?'NULL':`'${String(value).replaceAll("'","''")}'`;
await archiveDatabase({exec:async query=>{sql.push(query+';');},query:async(query,args=[])=>{sql.push(query.replace(/\$(\d+)/g,(_,n)=>literal(args[Number(n)-1]))+';');return {rows:[]};}});
const psql=query=>execFileSync('docker',['exec','-i','--user','postgres',container,'psql','-h','/tmp','-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:15000}).trim();
const auth=query=>`SET request.jwt.claim.sub='${uid}'; SET ROLE authenticated; ${query}`;
const move=`SELECT move_my_conversation_step('${A}','up','${B}');`;
function connection(query){return new Promise((resolve,reject)=>{
 const child=spawn('docker',['exec','-i','--user','postgres',container,'psql','-h','/tmp','-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
 let output='',error='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{error+=data;});child.on('error',reject);child.on('close',code=>resolve({code,output,error}));child.stdin.end(query);
});}
async function locked(mutator,second){
 let release;
 const ready=new Promise(resolve=>{release=resolve;});
 const child=spawn('docker',['exec','-i','--user','postgres',container,'psql','-h','/tmp','-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
 let output='',error='';child.stdout.on('data',data=>{output+=data;if(output.includes('LOCKED'))release();});child.stderr.on('data',data=>{error+=data;});
 const completed=new Promise(resolve=>child.on('close',code=>resolve({code,error})));
 child.stdin.write(`BEGIN; SET statement_timeout='10s'; SELECT 1 FROM user_usage_tiers WHERE user_id='${uid}' FOR UPDATE; ${mutator} SELECT 'LOCKED';\n`);
 const timer=setTimeout(()=>release(),6000);await ready;clearTimeout(timer);
 assert.ok(output.includes('LOCKED'),'first transaction failed before lock: '+error);
 const name=`step-order-second-${process.pid}`;
 const result=connection(`SET application_name='${name}'; SET statement_timeout='10s'; ${auth(second)}`);
 try{
  let observed=false;
  for(let i=0;i<40;i++){
   observed=psql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock');`)==='t';
   if(observed)break;await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(observed,'second backend must actually wait on the first transaction before COMMIT');
  // Commit ONLY after observing overlap. Delay also lands the expiry case past its deadline.
  child.stdin.end('SELECT pg_sleep(0.2); COMMIT;\n');
  assert.equal((await completed).code,0,error);return await result;
 }finally{if(!child.stdin.writableEnded)child.stdin.end('ROLLBACK;\n');}
}

function session(name){
 const child=spawn('docker',['exec','-i','--user','postgres',container,'psql','-h','/tmp','-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
 let output='',error='',settled=false;
 child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{error+=data;});
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{settled=true;resolve({code,output,error});});});
 child.stdin.write(`SET application_name='${name}'; SET statement_timeout='6s'; SET deadlock_timeout='100ms'; BEGIN;\n`);
 return {done,write:sql=>child.stdin.write(sql+'\n'),end:sql=>child.stdin.end(sql+'\n'),settled:()=>settled,
  marker:async marker=>{for(let n=0;n<100;n++){if(output.includes(marker))return;if(settled)break;await new Promise(r=>setTimeout(r,20));}assert.fail(name+' did not reach '+marker+': '+error);}};
}
async function observeLockOrCompletion(name,otherSession){
 for(let n=0;n<100;n++){
  if(otherSession.settled())return 'completed without row wait';
  if(psql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock');`)==='t')return 'observed Lock';
  await new Promise(r=>setTimeout(r,20));
 }
 assert.fail(name+' neither completed nor reached an observable lock');
}
async function rawChatVersusLegacy(first){
 const tag=`legacy-chat-${first}-${process.pid}`,chat=session(tag+'-chat'),legacy=session(tag+'-legacy');
 let observed;
 if(first==='chat'){
  // Hold the row immediately before an ordinary UPDATE would run its AFTER triggers.
  chat.write(`SELECT id FROM conversations WHERE id='${A}' FOR UPDATE; SELECT 'CHAT_ROW';`);await chat.marker('CHAT_ROW');
  legacy.end(auth(`SELECT move_my_conversation_to_top('${A}'); COMMIT;`));
  observed=await observeLockOrCompletion(tag+'-legacy',legacy);
  chat.end(`UPDATE conversations SET last_message_at=clock_timestamp() WHERE id='${A}'; COMMIT;`);
 }else{
  legacy.write(`SELECT 1 FROM user_usage_tiers WHERE user_id='${uid}' FOR UPDATE; SELECT 'LEGACY_USAGE';`);await legacy.marker('LEGACY_USAGE');
  chat.end(`UPDATE conversations SET last_message_at=clock_timestamp() WHERE id='${A}'; COMMIT;`);
  observed=await observeLockOrCompletion(tag+'-chat',chat);
  assert.equal(observed,'observed Lock','raw chat must overlap the held usage lock');
  legacy.end(auth(`SELECT move_my_conversation_to_top('${A}'); COMMIT;`));
 }
 const results={first,observed,chat:await chat.done,legacy:await legacy.done};
 console.log(JSON.stringify({scenario:'raw-chat-vs-legacy',...results}));
 assert.equal(results.chat.code,0,'chat session must commit: '+results.chat.error);
 assert.equal(results.legacy.code,0,'legacy session must commit: '+results.legacy.error);
 assert.doesNotMatch(results.chat.error+results.legacy.error,/deadlock detected|statement timeout/);
 assert.equal(JSON.parse(psql(auth('SELECT list_my_conversations();')))[0].id,A);
}
test('independent PostgreSQL sessions serialize adjacent moves, expiry, activity and deletion',async()=>{
 let created=false;
 try{
  // Refuse a missing image instead of silently downloading a large dependency.
  execFileSync('docker',['image','inspect',image,'--format','{{.Id}}'],{stdio:['ignore','pipe','pipe'],timeout:10000});
  // Bypass Supabase's account/bootstrap scripts: this fixture supplies its own schema/roles.
  execFileSync('docker',['run','-d','--name',container,'--network','none','--memory','512m','--user','postgres','--entrypoint','/bin/sh',image,'-c',"initdb -D /tmp/step-order-db --auth=trust && exec postgres -D /tmp/step-order-db -c shared_preload_libraries='' -c unix_socket_directories=/tmp -c listen_addresses='' -c max_connections=10 -c shared_buffers=16MB"],{stdio:['ignore','pipe','pipe'],timeout:30000});created=true;
  let ready=false,lastError='';for(let n=0;n<70;n++){try{psql('SELECT 1;');ready=true;break;}catch(error){lastError=String(error.stderr??error.message);await new Promise(r=>setTimeout(r,200));}}
  assert.ok(ready,'isolated PostgreSQL did not start: '+lastError);psql(sql.join('\n'));
  const reset=()=>psql(`UPDATE user_usage_tiers SET tier='premium',access_source='manual',paid_access_until=NULL,conversation_order=ARRAY['${C}','${B}','${A}']::uuid[] WHERE user_id='${uid}';`);
  reset();
  let result=await locked(auth(move),move);
  assert.notEqual(result.code,0);assert.match(result.error,/conversation_order_changed/);
  assert.deepEqual(JSON.parse(psql(auth('SELECT list_my_conversations();'))).map(r=>r.id),[C,A,B]);
  reset();result=await locked(`UPDATE user_usage_tiers SET access_source='purchase',paid_access_until=clock_timestamp()+interval '100 milliseconds' WHERE user_id='${uid}';`,move);
  assert.notEqual(result.code,0);assert.match(result.error,/conversation_locked/);
  reset();result=await locked(auth(`SELECT touch_my_conversation('${B}');`),move);
  assert.notEqual(result.code,0);assert.match(result.error,/conversation_order_changed/);
  reset();result=await locked(auth(`SELECT delete_my_conversation('${B}');`),move);
  assert.notEqual(result.code,0);assert.match(result.error,/conversation_order_changed/);
  const raceFailures=[];
  for(const first of ['chat','legacy']){reset();try{await rawChatVersusLegacy(first);}catch(error){raceFailures.push(error);}}
  if(raceFailures.length)throw new AggregateError(raceFailures,'raw chat and legacy must both commit in either lock order');
 }finally{if(created)execFileSync('docker',['rm','-f','-v',container],{stdio:['ignore','pipe','pipe'],timeout:15000});}
});
