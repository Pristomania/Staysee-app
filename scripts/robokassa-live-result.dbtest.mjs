// No env, network, provider accounts or real money: signed HTTP -> actual PostgreSQL functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { archiveDatabase, uid } from "./lib/archive-access-test-db.mjs";
import { createRobokassaLiveResult } from "../supabase/functions/_shared/robokassaLiveResult.ts";
const config = {
  enabled: true,
  merchantLogin: "StayseeAI",
  password2: "isolated-live-test-password",
};
async function database() {
  const db = await archiveDatabase();
  // archiveDatabase applies the full current billing chain in migration order.
  await db.exec("UPDATE billing_live_settings SET create_enabled=true");
  return db;
}
const value = async (db, sql, args = []) =>
  (await db.query(sql, args)).rows[0].value;
const create = (db, product = "basic") =>
  value(db, "SELECT create_billing_live_order($1,$2,$3,$4) AS value", [
    uid,
    product,
    randomUUID(),
    "StayseeAI",
  ]);
const usage = (db) =>
  value(
    db,
    "SELECT to_jsonb(u) AS value FROM user_usage_tiers u WHERE user_id=$1",
    [uid],
  );
function http(db, events = [], loseConfirmationReply = false) {
  return createRobokassaLiveResult({
    config,
    timeoutMs: loseConfirmationReply ? 100 : 10000,
    report: (event) => {
      events.push(event);
    },
    store: {
      async get(invoiceId, signal) {
        signal.throwIfAborted();
        const row = (await db.query(
          "SELECT id,invoice_id,mode,merchant_login,amount_kopecks,status FROM billing_live_orders WHERE invoice_id=$1",
          [invoiceId],
        )).rows[0];
        return row
          ? {
            id: row.id,
            invoiceId: String(row.invoice_id),
            mode: row.mode,
            merchantLogin: row.merchant_login,
            amountKopecks: row.amount_kopecks,
            status: row.status,
          }
          : null;
      },
      async confirm(order, amount, signal) {
        signal.throwIfAborted();
        const result = await value(
          db,
          "SELECT confirm_billing_live_order($1,$2) AS value",
          [order.id, amount],
        );
        if (loseConfirmationReply) return await new Promise(() => {});
        return result;
      },
    },
  });
}
function request(order, mode = "live", password = config.password2) {
  const sum = (order.amount_kopecks / 100).toFixed(6),
    id = String(order.invoice_id);
  const signature = createHash("sha256").update(
    `${sum}:${id}:${password}:Shp_mode=${mode}:Shp_shop=StayseeAI`,
  ).digest("hex");
  return new Request("https://example.invalid/result", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      OutSum: sum,
      InvId: id,
      SignatureValue: signature,
      Shp_mode: mode,
      Shp_shop: "StayseeAI",
    }),
  });
}

test("signed real callback grants once, preserves paid period on replay and still settles with new orders disabled", async () => {
  const db = await database();
  try {
    const order = await create(db);
    const handler = http(db);
    await db.exec("UPDATE billing_live_settings SET create_enabled=false");
    assert.equal(
      await (await handler(request(order))).text(),
      `OK${order.invoice_id}`,
    );
    const granted = await usage(db);
    assert.equal(granted.tier, "basic");
    assert.equal(granted.period_requests_used, 0);
    assert.ok(granted.first_real_purchase_at);
    assert.equal(
      await (await handler(request(order))).text(),
      `OK${order.invoice_id}`,
    );
    assert.deepEqual(await usage(db), granted);
    const ledger = await value(
      db,
      "SELECT to_jsonb(o) AS value FROM billing_live_orders o WHERE id=$1",
      [order.id],
    );
    assert.equal(ledger.status, "applied");
    assert.ok(ledger.paid_at);
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      db.query("SELECT confirm_billing_live_order($1,$2)", [
        order.id,
        order.amount_kopecks,
      ]),
      /permission denied/,
    );
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});
test("database commit followed by lost HTTP response is safe to retry without a second grant", async () => {
  const db = await database();
  try {
    const order = await create(db, "pack100");
    assert.equal((await http(db, [], true)(request(order))).status, 503);
    const afterCommit = await usage(db);
    assert.equal((await http(db)(request(order))).status, 200);
    assert.deepEqual(await usage(db), afterCommit);
    assert.equal(
      Number(
        await value(
          db,
          "SELECT count(*) AS value FROM message_packs WHERE user_id=$1",
          [uid],
        ),
      ),
      1,
    );
  } finally {
    await db.close();
  }
});
test("test callbacks never grant live rights; pack repeats grant only one funded package", async () => {
  const db = await database();
  try {
    const order = await create(db, "pack100");
    const handler = http(db);
    const before = await usage(db);
    assert.equal(
      (await handler(request(order, "test", "test-password"))).status,
      400,
    );
    assert.deepEqual(await usage(db), before);
    assert.equal((await handler(request(order))).status, 200);
    assert.equal((await handler(request(order))).status, 200);
    const packs = (await db.query(
      "SELECT messages_total,messages_left FROM message_packs WHERE user_id=$1",
      [uid],
    )).rows;
    assert.deepEqual(packs, [{ messages_total: 100, messages_left: 100 }]);
  } finally {
    await db.close();
  }
});
test("inactive account money is acknowledged and flagged without restoring room or issuing quota", async () => {
  const db = await database();
  try {
    const order = await create(db);
    const events = [];
    const handler = http(db, events);
    await db.query(
      "UPDATE profiles SET room_deletion_requested_at=clock_timestamp() WHERE id=$1",
      [uid],
    );
    const before = await usage(db);
    assert.equal((await handler(request(order))).status, 200);
    assert.equal((await handler(request(order))).status, 200);
    const after = await usage(db);
    assert.equal(after.tier, before.tier);
    assert.equal(after.paid_access_until, before.paid_access_until);
    const row = (await db.query(
      "SELECT status,fulfillment_reason FROM billing_live_orders WHERE id=$1",
      [order.id],
    )).rows[0];
    assert.deepEqual(row, {
      status: "paid_unfulfilled",
      fulfillment_reason: "account_inactive",
    });
    assert.equal(events[0].reason, "account_inactive");
    assert.equal(events[1].duplicate, true);
  } finally {
    await db.close();
  }
});
test("confirmation uses post-lock wall clock, not transaction start, for eligibility and full 30-day term", async () => {
  const db = await database();
  try {
    const order = await create(db);
    await db.exec("BEGIN");
    await db.query(
      "UPDATE user_usage_tiers SET tier='premium',access_source='purchase',paid_access_until=clock_timestamp()+interval '30 milliseconds' WHERE user_id=$1",
      [uid],
    );
    await new Promise((resolve) => setTimeout(resolve, 65));
    const response = await http(db)(request(order));
    assert.equal(response.status, 200);
    const row = (await db.query(
      "SELECT status,fulfillment_reason FROM billing_live_orders WHERE id=$1",
      [order.id],
    )).rows[0];
    assert.deepEqual(row, { status: "applied", fulfillment_reason: null });
    const remaining = await value(
      db,
      "SELECT extract(epoch FROM paid_access_until-clock_timestamp()) AS value FROM user_usage_tiers WHERE user_id=$1",
      [uid],
    );
    assert.ok(Number(remaining) > 30 * 86400 - 1);
    await db.exec("COMMIT");
  } finally {
    await db.close();
  }
});
