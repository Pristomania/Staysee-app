// Optional isolated embedded PostgreSQL test. No connection settings or production access.
// npm install --prefix tmp/robokassa-test/runtime --ignore-scripts --no-package-lock @electric-sql/pglite
// node --test scripts/robokassa-test-orders.dbtest.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createRobokassaTestHandlers } from "../supabase/functions/_shared/robokassaTestHandlers.ts";
const { PGlite } = await import(
  new URL(
    "../tmp/robokassa-test/runtime/node_modules/@electric-sql/pglite/dist/index.js",
    import.meta.url,
  ).href
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261119220000_094_robokassa_test_orders.sql",
    import.meta.url,
  ),
  "utf8",
);
const uid = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const key = "12345678-1234-4234-8234-123456789abc";
async function database() {
  const db = new PGlite();
  await db.exec(
    `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,room_deletion_requested_at timestamptz);
    CREATE TABLE public.user_usage_tiers(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,is_suspended boolean DEFAULT false,tier text DEFAULT 'free',period_requests_used int DEFAULT 17);
    INSERT INTO auth.users VALUES ('${uid}'),('${other}');
    INSERT INTO profiles(id) SELECT id FROM auth.users;
    INSERT INTO user_usage_tiers(user_id) SELECT id FROM auth.users;`,
  );
  await db.exec(migration);
  return db;
}
async function create(db, id = key, product = "basic", user = uid) {
  const { rows } = await db.query(
    "select public.create_robokassa_test_order($1,$2,$3,$4) AS value",
    [user, product, id, "StayseeAI"],
  );
  return rows[0].value;
}
test("SQL order creation selects its own price, retries idempotently, rejects changing product", async () => {
  const db = await database();
  try {
    const first = await create(db);
    assert.equal(first.amountKopecks, 199000);
    assert.equal(first.mode, "test");
    assert.equal((await create(db)).invoiceId, first.invoiceId);
    await assert.rejects(create(db, key, "premium"), /idempotency_conflict/);
    await assert.rejects(create(db, key, "unknown"), /unknown_product/);
  } finally {
    await db.close();
  }
});
test("SQL repeated/parallel settlement changes only test ledger, never account/quota", async () => {
  const db = await database();
  try {
    const o = await create(db);
    await assert.rejects(
      db.query("select public.settle_robokassa_test_order($1,$2)", [
        o.invoiceId,
        1,
      ]),
      /amount_mismatch/,
    );
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        db.query("select public.settle_robokassa_test_order($1,$2) AS value", [
          o.invoiceId,
          199000,
        ])
      ),
    );
    assert.equal(
      results.filter((r) => r.rows[0].value.duplicate === false).length,
      1,
    );
    assert.equal(
      results.filter((r) => r.rows[0].value.duplicate === true).length,
      2,
    );
    const { rows } = await db.query(
      "select tier,period_requests_used from user_usage_tiers where user_id=$1",
      [uid],
    );
    assert.deepEqual(rows, [{ tier: "free", period_requests_used: 17 }]);
  } finally {
    await db.close();
  }
});
test("SQL rejects deleted/suspended users but preserves a paid test record after auth deletion", async () => {
  const db = await database();
  try {
    const o = await create(db);
    await db.query(
      "update user_usage_tiers set is_suspended=true where user_id=$1",
      [uid],
    );
    await assert.rejects(
      create(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      /account_unavailable/,
    );
    await db.query("delete from auth.users where id=$1", [uid]);
    const { rows } = await db.query(
      "select user_id from robokassa_test_orders where invoice_id=$1",
      [o.invoiceId],
    );
    assert.equal(rows[0].user_id, null);
    await db.query("select public.settle_robokassa_test_order($1,$2)", [
      o.invoiceId,
      199000,
    ]);
    assert.equal(
      (await db.query("select count(*)::int as n from auth.users where id=$1", [
        uid,
      ])).rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
test("SQL ledger is service-only; customers cannot bypass the gated status endpoint", async () => {
  const db = await database();
  try {
    await create(db);
    await create(db, key, "pack100", other);
    await db.exec(
      `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uid}',false);`,
    );
    await assert.rejects(
      db.query("select count(*)::int as n from robokassa_test_orders"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("delete from robokassa_test_orders"),
      /permission denied/,
    );
    await assert.rejects(create(db), /permission denied/);
    await db.exec("RESET ROLE; SET ROLE anon");
    await assert.rejects(create(db), /permission denied/);
  } finally {
    await db.close();
  }
});
test("SQL bounds order creation and a deleted-room marker refuses checkout", async () => {
  const db = await database();
  try {
    await create(db);
    await create(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "pack100");
    await create(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "pack100");
    await assert.rejects(
      create(db, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "pack100"),
      /too_many_orders/,
    );
    await db.query(
      "update profiles set room_deletion_requested_at=now() where id=$1",
      [other],
    );
    await assert.rejects(
      create(db, key, "basic", other),
      /account_unavailable/,
    );
  } finally {
    await db.close();
  }
});
test("abandoned old test orders do not block all future tests forever", async () => {
  const db = await database();
  try {
    await create(db);
    await create(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "pack100");
    await create(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "pack100");
    await db.exec(
      "update robokassa_test_orders set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'",
    );
    assert.equal(
      (await create(db, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")).status,
      "pending",
    );
    assert.equal((await create(db)).status, "expired");
  } finally {
    await db.close();
  }
});
test("only one pending monthly order exists while packs remain independent", async () => {
  const db = await database();
  try {
    await create(db);
    await assert.rejects(
      create(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "premium"),
      /monthly_order_pending/,
    );
    assert.equal(
      (await create(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "pack100"))
        .status,
      "pending",
    );
  } finally {
    await db.close();
  }
});
test("service-only cleanup may remove test fixtures, customers may not", async () => {
  const db = await database();
  try {
    await create(db);
    await db.exec(
      "SET ROLE service_role; DELETE FROM robokassa_test_orders; RESET ROLE",
    );
    assert.equal(
      (await db.query("select count(*)::int as n from robokassa_test_orders"))
        .rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
test("HTTP create, signed POST result and owned status work against the real SQL ledger", async () => {
  const db = await database();
  try {
    const store = {
      create: async (input) =>
        create(db, input.idempotencyKey, input.productId, input.userId),
      get: async (invoice) =>
        (await db.query(
          "select public.robokassa_test_order_json(o) as value from public.robokassa_test_orders o where invoice_id=$1",
          [invoice],
        )).rows[0]?.value ?? null,
      settle: async (invoice, amount) =>
        (await db.query(
          "select public.settle_robokassa_test_order($1,$2) as value",
          [invoice, amount],
        )).rows[0].value,
    };
    const h = createRobokassaTestHandlers({
      config: {
        mode: "test",
        merchantLogin: "StayseeAI",
        password1: "first-test-secret",
        password2: "second-test-secret",
        allowedUserIds: [uid],
        allowedOrigins: ["https://staysee.ru"],
      },
      store,
      authenticate: async () => ({ id: uid, active: true }),
    });
    const req = () =>
      new Request("https://example.invalid/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: "basic", idempotencyKey: key }),
      });
    const response = await h.create(req());
    assert.equal(response.status, 200);
    const checkout = await response.json();
    const retried = await (await h.create(req())).json();
    assert.deepEqual(retried, checkout);
    const receipt = JSON.parse(
      decodeURIComponent(checkout.checkout.fields.Receipt),
    );
    assert.equal(receipt.items[0].name, "StaySee AI: Базовый, 30 дней");
    assert.equal(receipt.items[0].sum, 1990);
    const params = new URLSearchParams({
      InvId: checkout.invoiceId,
      OutSum: "1990.000000",
      Shp_mode: "test",
      Shp_shop: "StayseeAI",
    });
    params.set(
      "SignatureValue",
      createHash("sha256").update(
        `1990.000000:${checkout.invoiceId}:second-test-secret:Shp_mode=test:Shp_shop=StayseeAI`,
      ).digest("hex"),
    );
    const notify = () =>
      new Request("https://example.invalid/result", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params,
      });
    assert.equal(
      await (await h.result(notify())).text(),
      `OK${checkout.invoiceId}`,
    );
    assert.equal(
      await (await h.result(notify())).text(),
      `OK${checkout.invoiceId}`,
    );
    const status = await (await h.status(
      new Request(
        `https://example.invalid/status?invoiceId=${checkout.invoiceId}`,
      ),
    )).json();
    assert.equal(status.status, "test_paid");
    assert.equal(status.grantsAccess, false);
    assert.equal(
      (await db.query(
        "select period_requests_used from user_usage_tiers where user_id=$1",
        [uid],
      )).rows[0].period_requests_used,
      17,
    );
  } finally {
    await db.close();
  }
});
