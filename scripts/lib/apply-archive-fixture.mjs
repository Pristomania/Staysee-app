import {readFileSync,existsSync} from 'node:fs';
/** Extend older minimal billing fixtures, then execute real098 so existing money tests exercise upgraded quota. */
export async function applyArchiveFixture(db){
 await db.exec(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title text DEFAULT '',ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),ADD COLUMN IF NOT EXISTS last_message_at timestamptz DEFAULT now(),ADD COLUMN IF NOT EXISTS cross_memory_enabled boolean DEFAULT true,ADD COLUMN IF NOT EXISTS conversation_summary text;
 CREATE TABLE IF NOT EXISTS messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations ON DELETE CASCADE,content text,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS user_memory(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,content text);
 CREATE TABLE IF NOT EXISTS progress_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,conversation_id uuid REFERENCES conversations ON DELETE SET NULL,entry_type text DEFAULT 'note',content text);
 ALTER TABLE messages ENABLE ROW LEVEL SECURITY; ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY; ALTER TABLE progress_entries ENABLE ROW LEVEL SECURITY;`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261120190000_103_conversation_archive_access.sql',import.meta.url),'utf8'));
 for(const name of ['20261120200000_104_live_confirmation_clock.sql','20261120210000_105_paid_upgrade.sql']){
  const file=new URL('../../supabase/migrations/'+name,import.meta.url); if(existsSync(file))await db.exec(readFileSync(file,'utf8'));
 }
}
