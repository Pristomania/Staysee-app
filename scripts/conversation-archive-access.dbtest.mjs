import assert from 'node:assert/strict';
import {test} from 'node:test';
import {archiveDatabase,asUser,rpc,uid,other,oldest,middle,top} from './lib/archive-access-test-db.mjs';

test('expired raw premium cannot directly read older summary, messages or definer preview',async()=>{
 const db=await archiveDatabase();try{
  const rows=await asUser(db,()=>db.query('SELECT id,summary FROM conversations ORDER BY id'));
  assert.deepEqual(rows.rows.map(r=>r.id),[top]);
  const messages=await asUser(db,()=>db.query('SELECT content FROM messages'));
  assert.deepEqual(messages.rows.map(r=>r.content),['secret-2026-03-01']);
  assert.deepEqual(await rpc(db,'load_conversation_last_messages',[[oldest,middle]]),{});
 }finally{await db.close();}
});

test('safe list exposes all own titles/dates with locks, never summary or metadata',async()=>{
 const db=await archiveDatabase();try{
  const list=await rpc(db,'list_my_conversations');
  assert.deepEqual(list.map(r=>r.id),[top,middle,oldest]);
  assert.deepEqual(list.map(r=>r.can_read),[true,false,false]);
  assert.deepEqual(Object.keys(list[0]).sort(),['can_read','created_at','id','is_active','last_message_at','title','user_id']);
  assert.deepEqual(await rpc(db,'list_my_conversations',[],other),[]);
 }finally{await db.close();}
});

test('delete locked is self-only and preserves accessible room; delete accessible never opens archive',async()=>{
 const db=await archiveDatabase();try{
  assert.equal(await rpc(db,'delete_my_conversation',[oldest],other),false);
  assert.equal(await rpc(db,'delete_my_conversation',[oldest]),true);
  assert.equal(await rpc(db,'delete_my_conversation',[top]),true);
  assert.deepEqual((await rpc(db,'list_my_conversations')).map(r=>[r.id,r.can_read]),[[middle,false]]);
  const created=await asUser(db,()=>db.query('INSERT INTO conversations(user_id) VALUES($1) RETURNING id',[uid]));
  const next=created.rows[0].id;
  assert.equal((await rpc(db,'get_my_conversation_access',[next])).allowed,true);
  assert.equal((await rpc(db,'get_my_conversation_access',[middle])).allowed,false);
  await assert.rejects(asUser(db,()=>db.query('INSERT INTO conversations(user_id) VALUES($1)',[uid])),/conversation_limit_reached/);
 }finally{await db.close();}
});

test('free cannot reorder or patch anchor; paid quota0 can move top and expiry freezes selection',async()=>{
 const db=await archiveDatabase();try{
  await assert.rejects(rpc(db,'move_my_conversation_to_top',[oldest]),/conversation_locked/);
  await assert.rejects(asUser(db,()=>db.query('UPDATE conversations SET manual_sort_at=clock_timestamp() WHERE id=$1',[middle])),/permission denied/);
  await db.query("UPDATE user_usage_tiers SET paid_access_until=clock_timestamp()+interval '1 day',period_requests_used=1000 WHERE user_id=$1",[uid]);
  assert.equal(await rpc(db,'move_my_conversation_to_top',[oldest]),true);
  assert.equal((await rpc(db,'list_my_conversations'))[0].id,oldest);
  await db.query("UPDATE user_usage_tiers SET paid_access_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",[uid]);
  assert.deepEqual((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).map(r=>r.id),[oldest]);
  assert.equal(await rpc(db,'rename_my_conversation',[middle,'renamed safely']),true);
 }finally{await db.close();}
});

test('atomic conversation reserve refuses archived id without spending quota',async()=>{
 const db=await archiveDatabase();try{
  const before=(await db.query('SELECT period_requests_used FROM user_usage_tiers WHERE user_id=$1',[uid])).rows[0];
  const denied=(await db.query('SELECT reserve_ai_request_for_conversation($1,$2) AS value',[uid,oldest])).rows[0].value;
  assert.equal(denied.allowed,false);assert.equal(denied.reason,'conversation_locked');
  assert.deepEqual((await db.query('SELECT period_requests_used FROM user_usage_tiers WHERE user_id=$1',[uid])).rows[0],before);
  await assert.rejects(rpc(db,'reserve_ai_request_for_conversation',[uid,top]),/permission denied/);
 }finally{await db.close();}
});

test('orphaned notes from deleted locked room do not become readable global notes',async()=>{
 const db=await archiveDatabase();try{
  await db.query('INSERT INTO progress_entries(user_id,conversation_id,content) VALUES($1,$2,$3)',[uid,oldest,'private archived note']);
  await db.query('INSERT INTO progress_entries(user_id,content) VALUES($1,$2)',[uid,'global note']);
  await rpc(db,'delete_my_conversation',[oldest]);
  const notes=await asUser(db,()=>db.query('SELECT content FROM progress_entries ORDER BY content'));
  assert.deepEqual(notes.rows.map(r=>r.content),['global note']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM progress_entries')).rows[0].n,2);
 }finally{await db.close();}
});

test('repurchase opens retained archive; unavailable profile closes reads, deletion remains possible',async()=>{
 const db=await archiveDatabase();try{
  await db.query("UPDATE user_usage_tiers SET access_source='manual',paid_access_until=NULL,tier='basic' WHERE user_id=$1",[uid]);
  assert.equal((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).length,3);
  assert.equal((await rpc(db,'get_my_conversation_access',[oldest])).paidFeatures,true);
  await db.query('UPDATE user_usage_tiers SET is_suspended=true WHERE user_id=$1',[uid]);
  assert.equal((await rpc(db,'get_my_conversation_access',[top])).allowed,false);
  assert.equal(await rpc(db,'delete_my_conversation',[oldest]),true);
 }finally{await db.close();}
});

test('real billing confirmation reopens retained conversations without deleting messages',async()=>{
 const db=await archiveDatabase();try{
  await db.exec('UPDATE billing_live_settings SET create_enabled=true');
  const order=(await db.query("SELECT create_billing_live_order($1,'basic',$2,'StayseeAI') AS value",[uid,'dddddddd-dddd-4ddd-8ddd-dddddddddddd'])).rows[0].value;
  await db.query('SELECT confirm_billing_live_order($1,$2)',[order.id,order.amount_kopecks]);
  assert.equal((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).length,3);
  assert.equal((await asUser(db,()=>db.query('SELECT content FROM messages'))).rows.length,3);
 }finally{await db.close();}
});

test('private helpers, anchor/order columns and foreign deletes remain closed; delete-all works on free',async()=>{
 const db=await archiveDatabase();try{
  await assert.rejects(rpc(db,'conversation_full_access_for',[other]),/permission denied/);
  await assert.rejects(rpc(db,'reserve_ai_request_at',[uid,'2000-01-01T00:00:00Z']),/permission denied/);
  await assert.rejects(asUser(db,()=>db.query('UPDATE user_usage_tiers SET free_conversation_id=$1 WHERE user_id=$2',[oldest,uid])),/permission denied/);
  await assert.rejects(asUser(db,()=>db.query('DELETE FROM conversations WHERE id=$1',[oldest])),/permission denied/);
  await rpc(db,'delete_all_my_conversations',[uid]);
  assert.deepEqual(await rpc(db,'list_my_conversations'),[]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n,0);
 }finally{await db.close();}
});

test('delete-all confirmation refuses a mismatched expected owner without deleting current account',async()=>{
 const db=await archiveDatabase();try{
  await assert.rejects(rpc(db,'delete_all_my_conversations',[other]),/account_changed/);
  assert.equal((await rpc(db,'list_my_conversations')).length,3);
 }finally{await db.close();}
});

test('post-lock expiry settlement cannot return paid tier from frozen transaction now',async()=>{
 const db=await archiveDatabase();try{
  await db.query("SELECT grant_message_pack($1,100,'expiry-race-test')",[uid]);
  await db.exec('BEGIN');
  await db.query("UPDATE user_usage_tiers SET paid_access_until=now()+interval '5 milliseconds' WHERE user_id=$1",[uid]);
  await new Promise(resolve=>setTimeout(resolve,30));
  const result=(await db.query('SELECT reserve_ai_request_for_conversation($1,$2) AS value',[uid,top])).rows[0].value;
  assert.equal(result.tier,'free');
  await db.exec('ROLLBACK');
 }finally{await db.close();}
});

test('nullable historical metadata does not break the entire safe list',async()=>{
 const db=await archiveDatabase();try{
  await db.query('UPDATE conversations SET title=NULL,created_at=NULL,last_message_at=NULL WHERE id=$1',[oldest]);
  const list=await rpc(db,'list_my_conversations');const row=list.find(r=>r.id===oldest);
  assert.equal(typeof row.title,'string');assert.equal(typeof row.created_at,'string');assert.equal(typeof row.last_message_at,'string');
 }finally{await db.close();}
});

test('paid global correction and opted-in legacy summary edit remain available through scoped paths',async()=>{
 const db=await archiveDatabase();try{
  await db.query("UPDATE user_usage_tiers SET access_source='manual',paid_access_until=NULL,tier='basic' WHERE user_id=$1",[uid]);
  await db.query("INSERT INTO memory_corrections(user_id,subject_key,correction_text,display_text,scope) VALUES($1,'family','Живёт отдельно','Живёт отдельно','global')",[uid]);
  assert.equal((await asUser(db,()=>db.query('SELECT correction_text FROM memory_corrections'))).rows.length,1);
  assert.equal(await rpc(db,'save_my_conversation_summary',[oldest,'explicit legacy edit']),true);
  assert.equal((await db.query('SELECT conversation_summary FROM conversations WHERE id=$1',[oldest])).rows[0].conversation_summary,'explicit legacy edit');
 }finally{await db.close();}
});

test('legacy account-content wipe obtains usage lock before any conversation row deletion',async()=>{
 const db=await archiveDatabase();try{
  await db.exec(`CREATE FUNCTION assert_wipe_lock() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
   IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.user_usage_tiers'::regclass AND mode='RowShareLock') THEN RAISE EXCEPTION 'usage_lock_missing_before_delete'; END IF;
   RETURN OLD; END;$$;
   CREATE TRIGGER assert_wipe_lock BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION assert_wipe_lock();`);
  await db.query('SELECT _wipe_account_content($1)',[uid]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM conversations')).rows[0].n,0);
 }finally{await db.close();}
});

test('free cross-memory and archived embeddings/notes cannot be read; manual/unlimited rooms preserved',async()=>{
 const db=await archiveDatabase();try{
  await db.query('INSERT INTO user_memory(user_id,content) VALUES($1,$2)',[uid,'private cross-memory']);
  await db.query('INSERT INTO message_embeddings(message_id,conversation_id,user_id) SELECT id,conversation_id,$1 FROM messages',[uid]);
  assert.equal((await asUser(db,()=>db.query('SELECT content FROM user_memory'))).rows.length,0);
  assert.equal((await asUser(db,()=>db.query('SELECT * FROM message_embeddings'))).rows.length,1);
  await db.query('UPDATE user_usage_tiers SET unlimited_usage=true WHERE user_id=$1',[uid]);
  assert.equal((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).length,3);
  await db.query("UPDATE user_usage_tiers SET unlimited_usage=false,access_source='manual',tier='free',paid_access_until=NULL,max_conversations_override=5 WHERE user_id=$1",[uid]);
  assert.equal((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).length,3);
  assert.equal((await rpc(db,'get_my_conversation_access',[oldest])).paidFeatures,false);
 }finally{await db.close();}
});
