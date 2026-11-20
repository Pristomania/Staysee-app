// Real PostgreSQL sessions in a disposable, network-isolated container.
// Uses an already installed image; never connects to a shared/prod database.
import {execFileSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {archiveDatabase,uid,oldest as A,middle as B,top as C} from './lib/archive-access-test-db.mjs';
const container='staysee-step-order-qa-20261121';
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
 child.stdin.end(`BEGIN; SET statement_timeout='5s'; SELECT 1 FROM user_usage_tiers WHERE user_id='${uid}' FOR UPDATE; ${mutator} SELECT 'LOCKED'; SELECT pg_sleep(0.4); COMMIT;`);
 const timer=setTimeout(()=>release(),6000);await ready;clearTimeout(timer);
 assert.ok(output.includes('LOCKED'),'first transaction failed before lock: '+error);
 const result=await connection(`SET statement_timeout='5s'; ${auth(second)}`);
 assert.equal((await completed).code,0,error);return result;
}
test('independent PostgreSQL sessions serialize adjacent moves, expiry, activity and deletion',async()=>{
 let created=false;
 try{
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
 }finally{if(created)execFileSync('docker',['rm','-f','-v',container],{stdio:['ignore','pipe','pipe'],timeout:15000});}
});
