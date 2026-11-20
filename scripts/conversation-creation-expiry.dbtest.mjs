// Offline acceptance against actual PostgreSQL trigger migrations. No env/network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
const { PGlite } = await import(new URL(
  '../tmp/robokassa-test/runtime/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url,
).href);
const migrations = new URL('../supabase/migrations/', import.meta.url);
const next = new URL('20261120180000_102_conversation_creation_expiry.sql', migrations);
const uid = '11111111-1111-4111-8111-111111111111';
async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE usage_tier_limits(tier text PRIMARY KEY,period_kind text,
      period_request_limit int,cost_cap_usd numeric);
    INSERT INTO usage_tier_limits VALUES ('free','quarter',50,2.50),('basic','month',400,12);
    CREATE TABLE user_usage_tiers(user_id uuid PRIMARY KEY,tier text DEFAULT 'free',
      access_source text NOT NULL DEFAULT 'manual',paid_access_until timestamptz,
      unlimited_usage boolean DEFAULT false,period_requests_used int DEFAULT 0);
    INSERT INTO user_usage_tiers(user_id) VALUES('${uid}');
    CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,
      is_active boolean DEFAULT true,title text DEFAULT '');
    GRANT SELECT,INSERT,UPDATE ON conversations TO authenticated;
  `);
  await db.exec(readFileSync(new URL('20261101190000_087_plan_features.sql', migrations), 'utf8'));
  // Before implementation this deliberately exercises087, yielding behavioral RED, not a missing-file error.
  if (existsSync(next)) await db.exec(readFileSync(next, 'utf8'));
  return db;
}
async function insert(db, active = true) {
  await db.exec('SET ROLE authenticated');
  try {
    return (await db.query('INSERT INTO conversations(user_id,is_active) VALUES($1,$2) RETURNING id',
      [uid, active])).rows[0].id;
  } finally { await db.exec('RESET ROLE'); }
}
const denied = (operation) => assert.rejects(operation, (e) =>
  e.code === 'P0001' && e.message.includes('conversation_limit_reached'));
const state = async (db) => (await db.query('SELECT to_jsonb(u) AS value FROM user_usage_tiers u')).rows;

test('expired purchased raw tier cannot create second active conversation before quota settlement', async () => {
  const db = await database();
  try {
    await db.exec("UPDATE user_usage_tiers SET tier='premium',access_source='purchase',paid_access_until=clock_timestamp()-interval '1 second',period_requests_used=12");
    const before = await state(db);
    await insert(db);
    await denied(() => insert(db));
    assert.deepEqual(await state(db), before, 'guard must not settle quota or mutate tier');
  } finally { await db.close(); }
});

for (const [tier, limit] of [['basic', 3], ['premium', 6]]) {
  test(`active purchased ${tier} keeps ${limit} places with exhausted message quota`, async () => {
    const db = await database();
    try {
      await db.query("UPDATE user_usage_tiers SET tier=$1,access_source='purchase',paid_access_until=clock_timestamp()+interval '1 day',period_requests_used=1000", [tier]);
      for (let i = 0; i < limit; i++) await insert(db);
      await denied(() => insert(db));
    } finally { await db.close(); }
  });
}

test('manual tier, unlimited assignment and explicit override retain their independent limits', async () => {
  const db = await database();
  try {
    await db.exec("UPDATE user_usage_tiers SET tier='basic'");
    for (let i = 0; i < 3; i++) await insert(db);
    await denied(() => insert(db));
    await db.exec("UPDATE user_usage_tiers SET tier='premium',unlimited_usage=true,access_source='purchase',paid_access_until=clock_timestamp()-interval '1 day'");
    for (let i = 3; i < 6; i++) await insert(db);
    await denied(() => insert(db));
    await db.exec('UPDATE user_usage_tiers SET max_conversations_override=7');
    await insert(db);
    await denied(() => insert(db));
  } finally { await db.close(); }
});

test('inactive rows do not consume places but reactivation after purchased expiry is denied', async () => {
  const db = await database();
  try {
    await db.exec("UPDATE user_usage_tiers SET tier='basic',access_source='purchase',paid_access_until=clock_timestamp()-interval '1 day'");
    await insert(db);
    const inactive = await insert(db, false);
    await denied(() => db.query('UPDATE conversations SET is_active=true WHERE id=$1', [inactive]));
    assert.equal((await db.query('SELECT is_active FROM conversations WHERE id=$1', [inactive])).rows[0].is_active, false);
  } finally { await db.close(); }
});

test('expiry during an open transaction uses current server time, not transaction start', async () => {
  const db = await database();
  try {
    await db.exec('BEGIN');
    await db.exec("UPDATE user_usage_tiers SET tier='basic',access_source='purchase',paid_access_until=now()+interval '5 milliseconds'");
    // Deliberately advance wall time in a transaction whose now() remains frozen.
    await new Promise(resolve => setTimeout(resolve, 30));
    await insert(db);
    await denied(() => db.query('INSERT INTO conversations(user_id) VALUES($1)', [uid]));
    await db.exec('ROLLBACK');
  } finally { await db.close(); }
});

test('existing over-limit archive survives expiry and ordinary active-row updates', async () => {
  const db = await database();
  try {
    await db.exec("UPDATE user_usage_tiers SET tier='basic'");
    for (let i = 0; i < 3; i++) await insert(db);
    await db.exec("UPDATE user_usage_tiers SET access_source='purchase',paid_access_until=clock_timestamp()-interval '1 day'");
    await db.exec("UPDATE conversations SET title='kept',is_active=true");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM conversations WHERE title='kept' AND is_active")).rows[0].n, 3);
    await denied(() => insert(db));
  } finally { await db.close(); }
});

test('missing usage or unknown tier falls back to one place', async () => {
  const db = await database();
  try {
    await db.exec("UPDATE user_usage_tiers SET tier='unknown'");
    await insert(db);
    await denied(() => insert(db));
    await db.exec('DELETE FROM user_usage_tiers');
    await denied(() => insert(db));
  } finally { await db.close(); }
});

test('missing usage remains strict one even when known free accounts are allowed two', async () => {
  const db = await database();
  try {
    await db.exec("UPDATE usage_tier_limits SET max_conversations=2 WHERE tier='free'");
    await insert(db);
    await insert(db); // A known free account follows the server catalog.
    await denied(() => insert(db));
    await db.exec('DELETE FROM conversations; DELETE FROM user_usage_tiers');
    await insert(db);
    await denied(() => insert(db)); // No usage row must not inherit catalog expansion.
  } finally { await db.close(); }
});
