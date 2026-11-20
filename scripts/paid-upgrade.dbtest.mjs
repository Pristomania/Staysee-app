// Actual SQL only; no environment, network or live payment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { archiveDatabase, uid } from "./lib/archive-access-test-db.mjs";
async function database() {
  const db = await archiveDatabase();
  await db.exec("UPDATE billing_live_settings SET create_enabled=true");
  return db;
}
const value = async (db, sql, args = []) =>
  (await db.query(sql, args)).rows[0].value;
const create = (db, product = "basic", key = randomUUID()) =>
  value(db, "SELECT create_billing_live_order($1,$2,$3,$4) AS value", [
    uid,
    product,
    key,
    "StayseeAI",
  ]);
const confirm = (db, order) =>
  value(db, "SELECT confirm_billing_live_order($1,$2) AS value", [
    order.id,
    order.amount_kopecks,
  ]);
const usage = (db) =>
  value(
    db,
    "SELECT to_jsonb(u) AS value FROM user_usage_tiers u WHERE user_id=$1",
    [uid],
  );
const packs = (db) =>
  db.query("SELECT * FROM message_packs WHERE user_id=$1 ORDER BY id", [uid])
    .then((r) => r.rows);
const reserve = (db) =>
  value(db, "SELECT reserve_ai_request($1) AS value", [uid]);

test("full-price upgrade replaces included balance with1000 Premium, starts new30days, preserves bought pack and purchase history", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    await confirm(db, await create(db, "pack100"));
    await db.query(
      "UPDATE message_packs SET messages_left=75 WHERE user_id=$1",
      [uid],
    );
    await db.query(
      "UPDATE user_usage_tiers SET period_requests_used=125,paid_access_until=clock_timestamp()+interval '4 days' WHERE user_id=$1",
      [uid],
    );
    const before = await usage(db),
      savedPacks = await packs(db),
      key = randomUUID();
    const order = await create(db, "premium", key);
    assert.equal(order.amount_kopecks, 490000);
    assert.equal((await create(db, "premium", key)).id, order.id);
    assert.equal((await usage(db)).tier, "basic"); // Creating a checkout is not payment.
    assert.equal((await confirm(db, order)).status, "applied");
    const after = await usage(db);
    assert.equal(after.tier, "premium");
    assert.equal(after.access_source, "purchase");
    assert.equal(after.period_requests_used, 0);
    assert.equal(after.first_real_purchase_at, before.first_real_purchase_at);
    assert.notEqual(after.period_started_at, before.period_started_at);
    assert.equal(
      Number(
        await value(
          db,
          "SELECT extract(epoch FROM paid_access_until-period_started_at)/86400 AS value FROM user_usage_tiers WHERE user_id=$1",
          [uid],
        ),
      ),
      30,
    );
    assert.ok(
      Number(
        await value(
          db,
          "SELECT extract(epoch FROM paid_access_until-clock_timestamp()) AS value FROM user_usage_tiers WHERE user_id=$1",
          [uid],
        ),
      ) > 30 * 86400 - 1,
    );
    assert.deepEqual(await packs(db), savedPacks);
    assert.equal((await confirm(db, order)).duplicate, true);
    assert.deepEqual(await usage(db), after);
    await db.query(
      "UPDATE user_usage_tiers SET period_requests_used=999 WHERE user_id=$1",
      [uid],
    );
    assert.equal((await reserve(db)).from_pack, undefined);
    assert.equal((await reserve(db)).from_pack, true); // No275 included Basic messages added to Premium.
    assert.equal((await packs(db))[0].messages_left, 74);
  } finally {
    await db.close();
  }
});
test("active paid basic only permits upward purchase; no renew-in-place/downgrade before expiry", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    await assert.rejects(create(db, "basic"), /monthly_plan_not_purchasable/);
    const upgrade = await create(db, "premium");
    await assert.rejects(create(db, "premium"), /monthly_order_pending/);
    await confirm(db, upgrade);
    await assert.rejects(create(db, "basic"), /monthly_plan_not_purchasable/);
    await assert.rejects(create(db, "premium"), /monthly_plan_not_purchasable/);
    await db.query(
      "UPDATE user_usage_tiers SET paid_access_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [uid],
    );
    assert.equal(
      (await confirm(db, await create(db, "basic"))).status,
      "applied",
    );
  } finally {
    await db.close();
  }
});
for (
  const scenario of [
    "manual",
    "manual_free",
    "unlimited",
    "suspended",
    "deleted",
    "premium",
  ]
) {
  test(`state changed after upgrade checkout is respected: ${scenario}`, async () => {
    const db = await database();
    try {
      await confirm(db, await create(db));
      const order = await create(db, "premium");
      if (scenario === "manual") {
        await db.query("SELECT set_user_plan($1,'basic')", [uid]);
      }
      if (scenario === "manual_free") {
        await db.query("SELECT set_user_plan($1,'free')", [uid]);
      }
      if (scenario === "unlimited") {
        await db.query(
          "UPDATE user_usage_tiers SET unlimited_usage=true WHERE user_id=$1",
          [uid],
        );
      }
      if (scenario === "suspended") {
        await db.query(
          "UPDATE user_usage_tiers SET is_suspended=true WHERE user_id=$1",
          [uid],
        );
      }
      if (scenario === "deleted") {
        await db.query(
          "UPDATE profiles SET room_deletion_requested_at=clock_timestamp() WHERE id=$1",
          [uid],
        );
      }
      if (scenario === "premium") {
        await db.query(
          "UPDATE user_usage_tiers SET tier='premium' WHERE user_id=$1",
          [uid],
        );
      }
      const before = await usage(db), result = await confirm(db, order);
      assert.equal(result.status, "paid_unfulfilled");
      assert.equal(
        result.reason,
        ["suspended", "deleted"].includes(scenario)
          ? "account_inactive"
          : ["manual", "manual_free"].includes(scenario)
          ? "manual_access"
          : "active_plan",
      );
      assert.deepEqual(await usage(db), before);
      assert.equal((await confirm(db, order)).duplicate, true);
    } finally {
      await db.close();
    }
  });
}
test("late lower-plan callback cannot downgrade a paid Premium or change its period", async () => {
  const db = await database();
  try {
    const old = await create(db);
    await db.query(
      "UPDATE billing_live_orders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [old.id],
    );
    await confirm(db, await create(db, "premium"));
    const before = await usage(db), result = await confirm(db, old);
    assert.deepEqual(result, {
      status: "paid_unfulfilled",
      duplicate: false,
      reason: "active_plan",
    });
    assert.deepEqual(await usage(db), before);
  } finally {
    await db.close();
  }
});
test("manual plan never enables upgrade and authenticated role cannot grant it", async () => {
  const db = await database();
  try {
    await db.query("SELECT set_user_plan($1,'basic')", [uid]);
    await assert.rejects(create(db, "premium"), /monthly_plan_not_purchasable/);
    await db.exec("SET ROLE authenticated");
    await assert.rejects(create(db, "premium"), /permission denied/);
    await assert.rejects(
      db.query("SELECT confirm_billing_live_order($1,490000)", [randomUUID()]),
      /permission denied/,
    );
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});
test("new checkout eligibility uses the clock after a transaction-crossing expiry", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db, "premium"));
    await db.exec("BEGIN");
    await db.query(
      "UPDATE user_usage_tiers SET paid_access_until=clock_timestamp()+interval '30 milliseconds' WHERE user_id=$1",
      [uid],
    );
    await new Promise((resolve) => setTimeout(resolve, 65));
    const afterWait = await value(db, "SELECT clock_timestamp() AS value");
    const renewal = await create(db, "basic");
    assert.equal(
      await value(
        db,
        "SELECT created_at >= $2::timestamptz AS value FROM billing_live_orders WHERE id=$1",
        [renewal.id, afterWait],
      ),
      true,
    );
    assert.equal(
      Number(
        await value(
          db,
          "SELECT extract(epoch FROM expires_at-created_at) AS value FROM billing_live_orders WHERE id=$1",
          [renewal.id],
        ),
      ),
      3600,
    );
    assert.equal((await confirm(db, renewal)).status, "applied");
    assert.equal((await usage(db)).tier, "basic");
    await db.exec("COMMIT");
  } finally {
    await db.close();
  }
});
test("normal first purchase on manual Free remains allowed", async () => {
  const db = await database();
  try {
    await db.query("SELECT set_user_plan($1,'free')", [uid]);
    const order = await create(db, "premium");
    assert.equal((await confirm(db, order)).status, "applied");
    assert.equal((await usage(db)).tier, "premium");
  } finally {
    await db.close();
  }
});
test("natural expiry after upgrade checkout is not confused with manual revocation", async () => {
  const db = await database();
  try {
    await confirm(db, await create(db));
    const order = await create(db, "premium");
    await db.query(
      "UPDATE user_usage_tiers SET paid_access_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [uid],
    );
    await db.query("SELECT expire_purchased_access($1)", [uid]);
    assert.equal((await usage(db)).tier, "free");
    assert.equal((await confirm(db, order)).status, "applied");
    assert.equal((await usage(db)).tier, "premium");
  } finally {
    await db.close();
  }
});
