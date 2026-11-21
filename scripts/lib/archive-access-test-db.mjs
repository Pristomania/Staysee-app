// Isolated PostgreSQL fixture, never reads env or connects to an external DB.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
export const uid='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
export const oldest='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', middle='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', top='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const dir=new URL('../../supabase/migrations/',import.meta.url);
export async function archiveDatabase(database) {
 let db=database;
 if(!db){
  const {PGlite}=await import(new URL('../../tmp/robokassa-test/runtime/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url).href);
  const {vector}=await import(new URL('../../tmp/robokassa-test/runtime/node_modules/@electric-sql/pglite-pgvector/dist/index.js',import.meta.url).href);
  db=new PGlite({extensions:{vector}});
 }
 await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,room_deletion_requested_at timestamptz);
 CREATE TABLE user_usage_tiers(user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,tier text DEFAULT 'free',daily_request_limit int DEFAULT 50,monthly_token_limit int DEFAULT 500000,daily_requests_used int DEFAULT 0,monthly_tokens_used int DEFAULT 0,day_reset_at timestamptz DEFAULT now(),month_reset_at timestamptz DEFAULT now(),is_suspended boolean DEFAULT false,updated_at timestamptz DEFAULT now());
 CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES auth.users ON DELETE CASCADE,is_active boolean DEFAULT true,title text DEFAULT '',created_at timestamptz DEFAULT now(),last_message_at timestamptz DEFAULT now(),cross_memory_enabled boolean DEFAULT true,conversation_summary text,summary text DEFAULT 'SECRET SUMMARY',metadata jsonb DEFAULT '{"secret":true}');
 CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations ON DELETE CASCADE,sender text DEFAULT 'user',content text,created_at timestamptz DEFAULT now());
 CREATE TABLE user_memory(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,content text);
 CREATE TABLE progress_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,conversation_id uuid REFERENCES conversations ON DELETE SET NULL,entry_type text DEFAULT 'note',content text,entry_date date DEFAULT CURRENT_DATE,created_at timestamptz DEFAULT now());
 CREATE TABLE message_embeddings(message_id uuid REFERENCES messages ON DELETE CASCADE,conversation_id uuid,user_id uuid,embedding vector(1536) NOT NULL);
 CREATE TABLE ai_usage_logs(user_id uuid,cost numeric,created_at timestamptz DEFAULT now());
 CREATE VIEW v_analytics_cost_by_user AS SELECT 1 AS n; CREATE VIEW v_analytics_top_conversations AS SELECT 1 AS n;
 INSERT INTO auth.users VALUES('${uid}'),('${other}'); INSERT INTO profiles(id) SELECT id FROM auth.users; INSERT INTO user_usage_tiers(user_id,tier) SELECT id,'premium' FROM auth.users;
 ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
 CREATE POLICY own_conversations ON conversations TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
 ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY; CREATE POLICY own_memory ON user_memory TO authenticated USING(user_id=auth.uid());
 ALTER TABLE progress_entries ENABLE ROW LEVEL SECURITY; CREATE POLICY own_progress ON progress_entries TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
 ALTER TABLE message_embeddings ENABLE ROW LEVEL SECURITY; CREATE POLICY own_embeddings ON message_embeddings TO authenticated USING(user_id=auth.uid());
 GRANT SELECT,INSERT,UPDATE,DELETE ON conversations,messages,user_memory,progress_entries,message_embeddings TO authenticated;
 GRANT SELECT ON profiles,user_usage_tiers TO authenticated;
 ALTER TABLE profiles ENABLE ROW LEVEL SECURITY; CREATE POLICY own_profile ON profiles FOR SELECT TO authenticated USING(id=auth.uid());
 ALTER TABLE user_usage_tiers ENABLE ROW LEVEL SECURITY; CREATE POLICY own_usage ON user_usage_tiers FOR SELECT TO authenticated USING(user_id=auth.uid());
 `);
 for(const name of readdirSync(dir).filter(n=>/_08[5-9]_|_090_|_100_|_101_|_102_/.test(n)).sort())await db.exec(readFileSync(new URL(name,dir),'utf8'));
 await db.exec(readFileSync(new URL('20260617160000_024_secure_messages_rls_and_analytics.sql',dir),'utf8'));
 await db.exec(readFileSync(new URL('20261002000000_063_conversation_last_messages.sql',dir),'utf8'));
 await db.exec(readFileSync(new URL('20260628120000_029_memory_corrections.sql',dir),'utf8'));
 const deletion=readFileSync(new URL('20261103010000_092_room_and_data_deletion.sql',dir),'utf8');
 for(const name of ['_wipe_memory','_wipe_account_content']){
  const start=deletion.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end=deletion.indexOf('$$;',start)+3;
  await db.exec(deletion.slice(start,end));
  await db.exec(`REVOKE ALL ON FUNCTION public.${name}(uuid) FROM PUBLIC,anon,authenticated`);
 }
 await db.exec('GRANT SELECT ON memory_corrections TO authenticated');
 for(const [id,day] of [[oldest,'2026-01-01'],[middle,'2026-02-01'],[top,'2026-03-01']]) {
   await db.query("INSERT INTO conversations(id,user_id,title,last_message_at) VALUES($1,$2,$3,$4)",[id,uid,`room-${day}`,day]);
   await db.query('INSERT INTO messages(conversation_id,content) VALUES($1,$2)',[id,`secret-${day}`]);
 }
 await db.query("UPDATE user_usage_tiers SET tier='premium',access_source='purchase',paid_access_until=clock_timestamp()-interval '1 day' WHERE user_id=$1",[uid]);
 const archive=new URL('20261120190000_103_conversation_archive_access.sql',dir);
 if(existsSync(archive))await db.exec(readFileSync(archive,'utf8'));
 for(const name of ['20261120200000_104_live_confirmation_clock.sql','20261120210000_105_paid_upgrade.sql','20261121000000_107_embeddings_by_model.sql','20261121010000_108_match_user_lines_min_length.sql','20261121030000_109_conversation_step_order.sql']){
  const file=new URL(name,dir); if(existsSync(file))await db.exec(readFileSync(file,'utf8'));
 }
 return db;
}
export async function asUser(db,operation,user=uid) {
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user]);
 await db.exec('SET ROLE authenticated');
 try {return await operation();} finally {await db.exec('RESET ROLE');}
}
export const rpc=(db,name,args=[],user=uid)=>asUser(db,async()=>
 (await db.query(`SELECT public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) AS value`,args)).rows[0].value,user);
