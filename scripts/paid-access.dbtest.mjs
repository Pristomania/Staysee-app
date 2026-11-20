// Isolated SQL acceptance only: no network, env, real accounts or provider calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { applyArchiveFixture } from "./lib/apply-archive-fixture.mjs";
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

test("default-off creation, catalog, idempotency and private tables/functions", async () => {
  const db = await database(false);
  try {
    await assert.rejects(create(db), /live_creation_disabled/);
    await db.exec("UPDATE billing_live_settings SET create_enabled=true");
    const order = await create(db);
    assert.equal(order.amount_kopecks, 199000);
    assert.equal(order.product_id, "basic");
    assert.equal((await create(db)).id, order.id);
    await assert.rejects(create(db, "premium"), /idempotency_conflict/);
    await assert.rejects(create(db, "unknown", key2), /unknown_product/);
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      db.query("SELECT * FROM billing_live_orders"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("UPDATE billing_live_settings SET create_enabled=true"),
      /permission denied/,
    );
    await assert.rejects(confirm(db, order), /permission denied/);
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});
test("monthly grant is thirty days, exactly once, with real history; zero quota does not end tier", async () => {
  const db = await database();
  try {
    const order = await create(db);
    const result = await confirm(db, order);
    assert.equal(result.status, "applied");
    const first = await usage(db);
    assert.equal(first.tier, "basic");
    assert.equal(first.access_source, "purchase");
    assert.ok(first.first_real_purchase_at);
    assert.equal(first.period_requests_used, 0);
    const days = await value(
      db,
      "select extract(epoch from paid_access_until-period_started_at)/86400 as value from user_usage_tiers where user_id=$1",
      [uid],
    );
    assert.equal(Number(days), 30);
    await db.exec(
      `UPDATE user_usage_tiers SET period_requests_used=400 WHERE user_id='${uid}'`,
    );
    assert.equal((await reserve(db)).reason, "period_limit");
    assert.equal((await usage(db)).tier, "basic");
    assert.equal((await confirm(db, order)).duplicate, true);
    const repeated = await usage(db);
    assert.equal(repeated.paid_access_until, first.paid_access_until);
    assert.equal(repeated.period_requests_used, 400);
    await assert.rejects(confirm(db, order, 1), /amount_mismatch/);
  } finally {
    await db.close();
  }
});
test("pack while paid restores messages without changing term, tier or period counters", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    await db.exec(
      `UPDATE user_usage_tiers SET period_requests_used=400 WHERE user_id='${uid}'`,
    );
    const before = await usage(db);
    const pack = await create(db, "pack100", key2);
    assert.equal(pack.amount_kopecks, 59000);
    await confirm(db, pack);
    const after = await usage(db);
    for (
      const field of [
        "tier",
        "paid_access_until",
        "period_started_at",
        "period_requests_used",
        "day_reset_at",
        "daily_requests_used",
      ]
    ) assert.equal(after[field], before[field], field);
    assert.equal((await reserve(db)).from_pack, true);
    assert.equal((await confirm(db, pack)).duplicate, true);
    assert.equal(
      Number(
        await value(
          db,
          "select sum(messages_left) as value from message_packs",
        ),
      ),
      99,
    );
  } finally {
    await db.close();
  }
});
test("pack alone preserves initial trial, disables future free replenishment, manual pack is not purchase", async () => {
  const db = await database();
  try {
    await db.query("select grant_message_pack($1,100,$2)", [
      other,
      "manual-test",
    ]);
    assert.equal((await usage(db, other)).first_real_purchase_at, null);
    const before = await usage(db);
    await confirm(db, await create(db, "pack100"));
    const after = await usage(db);
    assert.equal(after.period_requests_used, 17);
    assert.equal(after.period_started_at, before.period_started_at);
    assert.equal(after.tier, "free");
    assert.ok(after.first_real_purchase_at);
    await db.exec(
      `UPDATE user_usage_tiers SET period_requests_used=50,last_request_at=now()-interval '4 months',period_started_at=now()-interval '4 months' WHERE user_id='${uid}'`,
    );
    assert.equal((await reserve(db)).from_pack, true);
    assert.equal((await usage(db)).period_requests_used, 50);
    await db.exec(
      `UPDATE user_usage_tiers SET period_requests_used=50,last_request_at=now()-interval '4 months' WHERE user_id='${other}'`,
    );
    assert.equal((await reserve(db, other)).from_pack, undefined);
    assert.equal((await usage(db, other)).period_requests_used, 1);
  } finally {
    await db.close();
  }
});
test("expiry forfeits trial, keeps packs usable and never rolls unpaid month or free trial", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    await confirm(db, await create(db, "pack100", key2));
    await db.exec(
      `UPDATE user_usage_tiers SET paid_access_until=now()-interval '1 second',period_started_at=now()-interval '31 days',last_request_at=now()-interval '4 months' WHERE user_id='${uid}'; INSERT INTO ai_usage_logs(user_id,cost,created_at) VALUES('${uid}',10,now()-interval '1 day');`,
    );
    const reserved = await reserve(db);
    assert.equal(reserved.tier, "free");
    assert.equal(reserved.from_pack, true);
    const row = await usage(db);
    assert.equal(row.period_requests_used, 50);
    assert.equal(row.tier, "free");
    assert.ok(row.first_real_purchase_at);
    assert.equal(
      Number(
        await value(
          db,
          "select sum(messages_left) as value from message_packs",
        ),
      ),
      99,
    );
    await db.exec("UPDATE message_packs SET messages_left=0");
    assert.equal((await reserve(db)).reason, "period_limit");
  } finally {
    await db.close();
  }
});
test("manual assignments and unlimited keep access; manual setters never clear purchase history", async () => {
  const db = await database();
  try {
    await db.query("select set_user_plan($1,'premium')", [other]);
    await db.exec(
      `UPDATE user_usage_tiers SET unlimited_usage=true,period_requests_used=1500,period_started_at=now()-interval '40 days' WHERE user_id='${other}'`,
    );
    assert.equal((await reserve(db, other)).tier, "premium");
    assert.equal((await usage(db, other)).access_source, "manual");
    await confirm(db, await create(db));
    const first = await usage(db);
    await db.query("select set_user_plan($1,'premium')", [uid]);
    const manual = await usage(db);
    assert.equal(manual.access_source, "manual");
    assert.equal(manual.paid_access_until, null);
    assert.equal(manual.first_real_purchase_at, first.first_real_purchase_at);
  } finally {
    await db.close();
  }
});
test("second Premium payment upgrades a first Basic grant; duplicate cannot grant again", async () => {
  const db = await database();
  try {
    const first = await create(db);
    await assert.rejects(create(db, "premium", key2), /monthly_order_pending/);
    await db.query(
      "UPDATE billing_live_orders SET expires_at=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const second = await create(db, "premium", key2);
    assert.equal((await confirm(db, first)).status, "applied");
    const row = await usage(db);
    assert.equal((await confirm(db, second)).status, "applied");
    const after = await usage(db);
    assert.ok(
      Date.parse(after.paid_access_until) >= Date.parse(row.paid_access_until),
    );
    assert.equal(after.first_real_purchase_at, row.first_real_purchase_at);
    assert.equal(after.tier, "premium");
    assert.equal((await confirm(db, second)).duplicate, true);
    assert.deepEqual(await usage(db), after);
  } finally {
    await db.close();
  }
});
test("inactive or deleted account never resurrects on real confirmation; journal retains minimal trace", async () => {
  const db = await database();
  try {
    const order = await create(db);
    await db.exec(
      `UPDATE user_usage_tiers SET is_suspended=true WHERE user_id='${uid}'`,
    );
    assert.equal((await confirm(db, order)).status, "paid_unfulfilled");
    assert.equal((await usage(db)).tier, "free");
    const deleted = await create(db, "basic", key2, other);
    await db.exec(`DELETE FROM auth.users WHERE id='${other}'`);
    assert.equal((await confirm(db, deleted)).status, "paid_unfulfilled");
    assert.equal(
      (await db.query("select * from user_usage_tiers where user_id=$1", [
        other,
      ])).rows.length,
      0,
    );
    assert.equal(
      await value(
        db,
        "select user_id as value from billing_live_orders where id=$1",
        [deleted.id],
      ),
      null,
    );
  } finally {
    await db.close();
  }
});
test("failure during package grant rolls back payment and history, then retry grants once", async () => {
  const db = await database();
  try {
    const order = await create(db, "pack100");
    await db.exec(
      "ALTER TABLE message_packs ADD CONSTRAINT fixture_reject CHECK(messages_total<>100)",
    );
    await assert.rejects(confirm(db, order), /fixture_reject/);
    assert.equal((await usage(db)).first_real_purchase_at, null);
    assert.equal(
      await value(
        db,
        "select status as value from billing_live_orders where id=$1",
        [order.id],
      ),
      "pending",
    );
    await db.exec("ALTER TABLE message_packs DROP CONSTRAINT fixture_reject");
    assert.equal((await confirm(db, order)).status, "applied");
    assert.equal(
      Number(await value(db, "select count(*) as value from message_packs")),
      1,
    );
  } finally {
    await db.close();
  }
});
test("creating is bounded and confirmed orders remain replayable when creation is turned off", async () => {
  const db = await database();
  try {
    const first = await create(db, "pack100");
    await create(db, "pack100", key2);
    await create(db, "pack100", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await assert.rejects(
      create(db, "pack100", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      /too_many_orders/,
    );
    await db.exec("UPDATE billing_live_settings SET create_enabled=false");
    assert.equal((await confirm(db, first)).status, "applied");
    assert.equal((await confirm(db, first)).duplicate, true);
    await assert.rejects(
      db.query("select confirm_billing_live_order($1,199000)", [
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ]),
      /order_not_found/,
    );
  } finally {
    await db.close();
  }
});

test("actual payment remains purchase history when suspended; manual free reset cannot recreate trial", async () => {
  const db = await database();
  try {
    const order = await create(db);
    await db.exec(
      `UPDATE user_usage_tiers SET is_suspended=true WHERE user_id='${uid}'`,
    );
    await confirm(db, order);
    assert.ok(
      (await usage(db)).first_real_purchase_at,
      "real payment is history even without fulfillment",
    );
    await db.exec(
      `UPDATE user_usage_tiers SET is_suspended=false WHERE user_id='${uid}'`,
    );
    await db.query("select set_user_plan($1,'free')", [uid]);
    assert.equal(
      (await usage(db)).period_requests_used,
      50,
      "manual switch cannot manufacture a trial after payment",
    );
  } finally {
    await db.close();
  }
});

test("test settlement cannot grant live access or become real purchase history", async () => {
  const db = await database();
  try {
    await db.exec(
      readFileSync(
        new URL("20261119220000_094_robokassa_test_orders.sql", dir),
        "utf8",
      ),
    );
    const before = await usage(db);
    const order = await value(
      db,
      "select create_robokassa_test_order($1,$2,$3,$4) as value",
      [uid, "basic", key, "StayseeAI"],
    );
    await db.query("select settle_robokassa_test_order($1,$2)", [
      order.invoiceId,
      order.amountKopecks,
    ]);
    const after = await usage(db);
    assert.deepEqual(after, before);
    const testId = await value(
      db,
      "select id as value from robokassa_test_orders where invoice_id=$1",
      [order.invoiceId],
    );
    await assert.rejects(
      db.query("select confirm_billing_live_order($1,$2)", [
        testId,
        order.amountKopecks,
      ]),
      /order_not_found/,
    );
    assert.equal(
      Number(
        await value(db, "select count(*) as value from billing_live_orders"),
      ),
      0,
    );
  } finally {
    await db.close();
  }
});

test("live ledger and invoice sequence stay RPC-only under permissive default ACLs", async () => {
  const db = await database(true, true);
  try {
    for (const operation of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      assert.equal(
        await value(
          db,
          "select has_table_privilege('service_role','public.billing_live_orders',$1) as value",
          [operation],
        ),
        false,
        operation,
      );
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(
        await value(db, "select has_sequence_privilege($1,$2,$3) as value", [
          role,
          "public.billing_live_orders_invoice_id_seq",
          "USAGE",
        ]),
        false,
        role,
      );
      assert.equal(
        await value(db, "select has_sequence_privilege($1,$2,$3) as value", [
          role,
          "public.billing_live_orders_invoice_id_seq",
          "UPDATE",
        ]),
        false,
        role,
      );
    }
    assert.equal(
      await value(
        db,
        "select has_table_privilege('service_role','billing_live_settings','DELETE') as value",
      ),
      false,
    );
    await db.exec("SET ROLE service_role");
    const order = await create(db);
    assert.equal((await confirm(db, order)).status, "applied");
    assert.equal(
      Number(
        await value(db, "select count(*) as value from billing_live_orders"),
      ),
      1,
    );
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});

test("package creation, application and callback replay never mutate an expired plan or its counters", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    await db.exec(
      `UPDATE user_usage_tiers SET paid_access_until=now()-interval '1 second',period_requests_used=17 WHERE user_id='${uid}'`,
    );
    const before = await usage(db);
    const pack = await create(db, "pack100", key2);
    await confirm(db, pack);
    await confirm(db, pack);
    const after = await usage(db);
    for (
      const field of [
        "tier",
        "access_source",
        "paid_access_until",
        "period_started_at",
        "period_requests_used",
        "daily_requests_used",
        "day_reset_at",
      ]
    ) assert.equal(after[field], before[field], field);
  } finally {
    await db.close();
  }
});

test("successive bought packs retain funded spending without disabling the money guard", async () => {
  const db = await database();
  try {
    const first = await create(db, "pack100");
    await confirm(db, first);
    await db.exec(
      `UPDATE user_usage_tiers SET period_requests_used=50 WHERE user_id='${uid}'`,
    );
    assert.equal((await reserve(db)).from_pack, true); // Initializes current-period funding for the first pack.
    await db.exec(
      `UPDATE message_packs SET messages_left=0; INSERT INTO ai_usage_logs(user_id,cost) VALUES('${uid}',6.01);`,
    );
    const second = await create(db, "pack100", key2);
    await confirm(db, second);
    assert.equal(
      (await reserve(db)).from_pack,
      true,
      "new funded pack must be usable",
    );
    await db.exec(
      `INSERT INTO ai_usage_logs(user_id,cost) VALUES('${uid}',100);`,
    );
    assert.equal(
      (await reserve(db)).reason,
      "cost_cap",
      "guard still exists above cumulative funded budget",
    );
  } finally {
    await db.close();
  }
});

test("prior-period depleted packs cannot inflate new-period funding", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db, "pack100"));
    await db.exec(
      `UPDATE message_packs SET messages_left=0; UPDATE user_usage_tiers SET period_requests_used=50,period_started_at=now()+interval '1 second' WHERE user_id='${uid}'`,
    );
    const second = await create(db, "pack100", key2);
    await confirm(db, second);
    // Put new pack after the phase boundary, old pack before it; fixed server timestamps for this fixture only.
    await db.exec(
      `UPDATE message_packs SET purchased_at=now()+interval '2 seconds' WHERE messages_left>0; INSERT INTO ai_usage_logs(user_id,cost,created_at) VALUES('${uid}',6.01,now()+interval '2 seconds');`,
    );
    assert.equal((await reserve(db)).reason, "cost_cap");
  } finally {
    await db.close();
  }
});

test("deletion requested or manual premium assigned after checkout records refusal without resetting rights", async () => {
  const db = await database();
  try {
    const deleted = await create(db);
    await db.exec(
      `UPDATE profiles SET room_deletion_requested_at=now() WHERE id='${uid}'`,
    );
    assert.equal((await confirm(db, deleted)).status, "paid_unfulfilled");
    assert.equal((await usage(db)).tier, "free");
    const manual = await create(db, "basic", key2, other);
    await db.query("select set_user_plan($1,'premium')", [other]);
    await db.exec(
      `UPDATE user_usage_tiers SET period_requests_used=37 WHERE user_id='${other}'`,
    );
    const result = await confirm(db, manual);
    assert.equal(result.reason, "manual_access");
    const row = await usage(db, other);
    assert.equal(row.tier, "premium");
    assert.equal(row.period_requests_used, 37);
    assert.equal(row.access_source, "manual");
  } finally {
    await db.close();
  }
});
