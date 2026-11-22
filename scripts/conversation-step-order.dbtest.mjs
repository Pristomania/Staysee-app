import assert from 'node:assert/strict';
import {test} from 'node:test';
import {archiveDatabase,asUser,rpc,uid,other,oldest as A,middle as B,top as C} from './lib/archive-access-test-db.mjs';
async function fixture(){
 const db=await archiveDatabase();
 await db.query("UPDATE user_usage_tiers SET access_source='manual',tier='premium',paid_access_until=NULL WHERE user_id=$1",[uid]);
 return db;
}
const ids=async db=>(await rpc(db,'list_my_conversations')).map(r=>r.id);

test('fixture includes actual recall migrations107/108/110/111 before ordering113',async()=>{
 const db=await fixture();try{
  assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='message_embeddings' AND column_name IN ('embedding_model','embedding_1024')")).rows[0].n,2);
  assert.ok((await db.query("SELECT to_regprocedure('public.match_conversation_embeddings_by_model(uuid,text,vector,integer,double precision,timestamp with time zone,integer)') IS NOT NULL AS present")).rows[0].present);
  assert.equal((await db.query("SELECT prosecdef FROM pg_proc WHERE oid='public.match_conversation_embeddings_by_model(uuid,text,vector,integer,double precision,timestamp with time zone,integer)'::regprocedure")).rows[0].prosecdef,true);
 }finally{await db.close();}
});
test('missing usage row retains only own active conversations in legacy order without granting access',async()=>{
 const db=await fixture();try{
  await db.query('DELETE FROM user_usage_tiers WHERE user_id=$1',[uid]);
  const rows=await rpc(db,'list_my_conversations');
  assert.deepEqual(rows.map(r=>r.id),[C,B,A]);
  assert.ok(rows.every(r=>r.user_id===uid&&r.can_read===false));
  assert.deepEqual(await rpc(db,'list_my_conversations',[],other),[]);
  await assert.rejects(rpc(db,'move_my_conversation_step',[B,'up',C]),/conversation_locked/);
  assert.equal((await db.query('SELECT count(*)::int n FROM user_usage_tiers WHERE user_id=$1',[uid])).rows[0].n,0);
 }finally{await db.close();}
});
test('adjacent swaps persist without rewriting historical dates or message content',async()=>{
 const db=await fixture();try{
  const before=(await db.query('SELECT id,last_message_at,manual_sort_at FROM conversations ORDER BY id')).rows;
  assert.deepEqual(await ids(db),[C,B,A]);
  assert.equal(await rpc(db,'move_my_conversation_step',[A,'up',B]),true);
  assert.deepEqual(await ids(db),[C,A,B]);
  assert.equal(await rpc(db,'move_my_conversation_step',[A,'down',B]),true);
  assert.deepEqual(await ids(db),[C,B,A]);
  assert.deepEqual((await db.query('SELECT id,last_message_at,manual_sort_at FROM conversations ORDER BY id')).rows,before);
  assert.equal((await db.query('SELECT count(*)::int n FROM messages')).rows[0].n,3);
 }finally{await db.close();}
});
test('rejects stale adjacency, edges, invalid direction, foreign caller and free access without mutation',async()=>{
 const db=await fixture();try{
  for(const args of [[A,'up',C],[C,'up',B],[A,'down',B]])await assert.rejects(rpc(db,'move_my_conversation_step',args),/conversation_order_changed/);
  await assert.rejects(rpc(db,'move_my_conversation_step',[A,'sideways',B]),/invalid_direction/);
  await assert.rejects(rpc(db,'move_my_conversation_step',[A,'up',B],other),/conversation_locked/);
  await db.query("UPDATE user_usage_tiers SET access_source='purchase',paid_access_until=clock_timestamp()-interval '1 day' WHERE user_id=$1",[uid]);
  await assert.rejects(rpc(db,'move_my_conversation_step',[A,'up',B]),/conversation_locked/);
  assert.deepEqual(await ids(db),[C,B,A]);
  await assert.rejects(asUser(db,()=>db.query('UPDATE user_usage_tiers SET conversation_order=$1 WHERE user_id=$2',[[A,B,C],uid])),/permission denied/);
 }finally{await db.close();}
});
test('activity and old move-top promote a room; insert/delete retain a normalized own active list',async()=>{
 const db=await fixture();try{
  await rpc(db,'move_my_conversation_step',[A,'up',B]);
  await rpc(db,'touch_my_conversation',[B]);assert.deepEqual(await ids(db),[B,C,A]);
  await rpc(db,'move_my_conversation_to_top',[A]);assert.deepEqual(await ids(db),[A,B,C]);
  const next=(await asUser(db,()=>db.query('INSERT INTO conversations(user_id) VALUES($1) RETURNING id',[uid]))).rows[0].id;
  assert.deepEqual(await ids(db),[next,A,B,C]);
  await rpc(db,'delete_my_conversation',[B]);assert.deepEqual(await ids(db),[next,A,C]);
  assert.deepEqual((await db.query('SELECT conversation_order FROM user_usage_tiers WHERE user_id=$1',[uid])).rows[0].conversation_order,[next,A,C]);
 }finally{await db.close();}
});
test('expiry freezes the actual chosen first room; deletion cannot expose an archived replacement',async()=>{
 const db=await fixture();try{
  await rpc(db,'move_my_conversation_step',[B,'up',C]);
  await db.query("UPDATE user_usage_tiers SET access_source='purchase',paid_access_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",[uid]);
  assert.deepEqual((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).map(r=>r.id),[B]);
  await rpc(db,'delete_my_conversation',[B]);
  assert.deepEqual((await rpc(db,'list_my_conversations')).map(r=>[r.id,r.can_read]),[[C,false],[A,false]]);
  const next=(await asUser(db,()=>db.query('INSERT INTO conversations(user_id) VALUES($1) RETURNING id',[uid]))).rows[0].id;
  assert.deepEqual((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).map(r=>r.id),[next]);
 }finally{await db.close();}
});
test('normalization removes duplicates and foreign/deleted ids, appending missing active rooms in legacy order',async()=>{
 const db=await fixture();try{
  await db.query('UPDATE user_usage_tiers SET conversation_order=$1 WHERE user_id=$2',[[C,C,other],uid]);
  assert.deepEqual(await ids(db),[C,B,A]);
  await rpc(db,'move_my_conversation_step',[A,'up',B]);
  assert.deepEqual((await db.query('SELECT conversation_order FROM user_usage_tiers WHERE user_id=$1',[uid])).rows[0].conversation_order,[C,A,B]);
  await db.query('UPDATE conversations SET is_active=false WHERE id=$1',[C]);assert.deepEqual(await ids(db),[A,B]);
  await assert.rejects(rpc(db,'normalized_conversation_order',[other]),/permission denied/);
  await assert.rejects(rpc(db,'move_my_conversation_step',[null,'up',B]),/conversation_locked/);
  await assert.rejects(rpc(db,'move_my_conversation_step',[A,null,B]),/invalid_direction/);
 }finally{await db.close();}
});
for(const [move,args] of [['move_my_conversation_step',[B,'up',C]],['move_my_conversation_to_top',[B]]]){
test(`${move}: a move accepted under the account lock freezes its chosen top even when expiry lands during the order write`,async()=>{
 const db=await fixture();try{
  await db.query("UPDATE user_usage_tiers SET access_source='purchase',paid_access_until=clock_timestamp()+interval '1 day' WHERE user_id=$1",[uid]);
  // Deterministically land the deadline at the write boundary, not by flaky wall-clock sleep.
  await db.exec(`CREATE FUNCTION expire_at_order_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
   NEW.paid_access_until:=clock_timestamp()-interval '1 second';RETURN NEW;END;$$;
   CREATE TRIGGER expire_at_order_write BEFORE UPDATE OF conversation_order ON user_usage_tiers
   FOR EACH ROW EXECUTE FUNCTION expire_at_order_write();`);
  assert.equal(await rpc(db,move,args),true);
  assert.deepEqual(await ids(db),[B,C,A]);
  assert.deepEqual((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).map(r=>r.id),[B]);
 }finally{await db.close();}
});
}
for(const [name,args] of [['move_my_conversation_step',[B,'up',C]],['move_my_conversation_to_top',[B]]]){
 test(`${name}: free multiroom reading override does not grant paid reorder rights`,async()=>{
  const db=await fixture();try{
   await db.query("UPDATE user_usage_tiers SET tier='free',access_source='manual',paid_access_until=NULL,max_conversations_override=5 WHERE user_id=$1",[uid]);
   assert.equal((await rpc(db,'list_my_conversations')).filter(r=>r.can_read).length,3);
   assert.equal((await rpc(db,'get_my_conversation_access',[B])).paidFeatures,false);
   await assert.rejects(rpc(db,name,args),/conversation_locked/);
   assert.deepEqual(await ids(db),[C,B,A]);
  }finally{await db.close();}
 });
}
