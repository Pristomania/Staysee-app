// Isolated SQL acceptance only: no network, env, real accounts or provider calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import {applyArchiveFixture} from './lib/apply-archive-fixture.mjs';
const { PGlite } = await import(
  new URL(
    "../tmp/robokassa-test/runtime/node_modules/@electric-sql/pglite/dist/index.js",
    import.meta.url,
  ).href
);
const dir = new URL("../supabase/migrations/", import.meta.url);
const migration = readFileSync(
  new URL("20261120160000_100_paid_access_backend.sql", dir),
  "utf8",
);
const uid = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  key2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function database(enabled = true, permissiveDefaults = false) {
  const db = new PGlite();
  await db.exec(
    `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,room_deletion_requested_at timestamptz);
    CREATE TABLE user_usage_tiers(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,tier text DEFAULT 'free',daily_request_limit int DEFAULT 50,monthly_token_limit int DEFAULT 500000,daily_requests_used int DEFAULT 0,monthly_tokens_used int DEFAULT 0,day_reset_at timestamptz DEFAULT now(),month_reset_at timestamptz DEFAULT now(),is_suspended boolean DEFAULT false,updated_at timestamptz DEFAULT now());
    CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,is_active boolean DEFAULT true);
    CREATE TABLE ai_usage_logs(user_id uuid,cost numeric,created_at timestamptz DEFAULT now());
    INSERT INTO auth.users VALUES('${uid}'),('${other}'); INSERT INTO profiles(id) SELECT id FROM auth.users; INSERT INTO user_usage_tiers(user_id) SELECT id FROM auth.users;`,
  );
  for (
    const name of readdirSync(dir).filter((n) => /_08[5-9]_|_090_/.test(n))
      .sort()
  ) await db.exec(readFileSync(new URL(name, dir), "utf8"));
  await db.exec(`UPDATE user_usage_tiers SET period_requests_used=17;`);
  if (permissiveDefaults) {
    await db.exec(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;",
    );
  }
  await db.exec(migration);
  await db.exec(snapshotMigration);
  await db.exec(readFileSync(new URL('20261120180000_102_conversation_creation_expiry.sql', dir), 'utf8'));
  await applyArchiveFixture(db);
  if (enabled) {
    await db.exec("UPDATE billing_live_settings SET create_enabled=true");
  }
  return db;
}
async function value(db, sql, args = []) {
  return (await db.query(sql, args)).rows[0].value;
}
const create = (db, product = "basic", attempt = key, user = uid) =>
  value(db, "select public.create_billing_live_order($1,$2,$3,$4) as value", [
    user,
    product,
    attempt,
    "StayseeAI",
  ]);
const confirm = (db, order, amount = order.amount_kopecks) =>
  value(db, "select public.confirm_billing_live_order($1,$2) as value", [
    order.id,
    amount,
  ]);
const usage = (db, user = uid) =>
  value(
    db,
    "select to_jsonb(u) as value from user_usage_tiers u where user_id=$1",
    [user],
  );
const reserve = (db, user = uid) =>
  value(db, "select public.reserve_ai_request($1) as value", [user]);

const snapshotMigration = readFileSync(
  new URL("20261120170000_101_billing_snapshot.sql", dir),
  "utf8",
);
const own = async (db, user = uid) => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec("SET ROLE authenticated");
  try {
    return await value(db, "select get_my_billing_snapshot() as value");
  } finally {
    await db.exec("RESET ROLE");
  }
};
test("authenticated RPC is self-only, safe and closed to guests", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db, "pack100"));
    const snapshot = await own(db);
    assert.equal(snapshot.userId, uid);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.usage.period_requests_used, 17);
    assert.equal(snapshot.packs[0].messages_left, 100);
    assert.equal(JSON.stringify(snapshot).includes("cost"), false);
    assert.equal(JSON.stringify(snapshot).includes("payment_ref"), false);
    const otherSnapshot = await own(db, other);
    assert.equal(otherSnapshot.packs.length, 0);
    await db.exec("SET ROLE anon");
    await assert.rejects(
      db.query("select get_my_billing_snapshot()"),
      /permission denied/,
    );
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});
test("snapshot read does not change expired usage, yet projects free trial0 and retained packages", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    await confirm(db, await create(db, "pack100", key2));
    await db.exec(
      "UPDATE user_usage_tiers SET paid_access_until=now()-interval '1 second',period_requests_used=17 WHERE user_id='" +
        uid + "'",
    );
    const before = await usage(db),
      result = await own(db),
      after = await usage(db);
    assert.deepEqual(after, before);
    assert.equal(result.usage.tier, "free");
    assert.equal(result.usage.period_requests_used, 50);
    assert.equal(result.packs[0].messages_left, 100);
  } finally {
    await db.close();
  }
});
test("manual/unlimited and active zero balance project correctly; inactive snapshot clears authority", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    await db.exec(
      "UPDATE user_usage_tiers SET period_requests_used=400 WHERE user_id='" +
        uid + "'",
    );
    assert.equal((await own(db)).usage.tier, "basic");
    assert.equal((await own(db)).usage.period_requests_used, 400);
    await db.query("select set_user_plan($1,'premium')", [other]);
    await db.exec(
      "UPDATE user_usage_tiers SET unlimited_usage=true WHERE user_id='" +
        other + "'",
    );
    assert.equal((await own(db, other)).usage.unlimited_usage, true);
    await db.exec(
      "UPDATE profiles SET room_deletion_requested_at=now() WHERE id='" + uid +
        "'",
    );
    assert.equal(await own(db), null);
  } finally {
    await db.close();
  }
});
test("real quota response distinguishes renewable free from previously paid and purchased month", async () => {
  const db = await database();
  try {
    await db.exec("UPDATE user_usage_tiers SET period_requests_used=50");
    assert.equal((await reserve(db, other)).can_renew_messages, true);
    await confirm(db, await create(db, "pack100"));
    await db.exec("UPDATE message_packs SET messages_left=0");
    assert.equal((await reserve(db)).can_renew_messages, false);
    await confirm(db, await create(db, "basic", key2));
    await db.exec(
      "UPDATE user_usage_tiers SET period_requests_used=400 WHERE user_id='" +
        uid + "'",
    );
    const denied = await reserve(db);
    assert.equal(denied.reason, "period_limit");
    assert.equal(denied.can_renew_messages, false);
  } finally {
    await db.close();
  }
});
