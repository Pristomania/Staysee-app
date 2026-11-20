import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  archiveDatabase,
  other,
  rpc,
  uid,
} from "./lib/archive-access-test-db.mjs";
import { parseLivePaymentStatus } from "../src/lib/livePaymentStatus.ts";
const file = new URL(
  "../supabase/migrations/20261120220000_106_live_payment_status.sql",
  import.meta.url,
);
async function database() {
  const db = await archiveDatabase();
  if (existsSync(file)) await db.exec(readFileSync(file, "utf8"));
  await db.exec("UPDATE billing_live_settings SET create_enabled=true");
  await db.query("SELECT set_user_plan($1,'free')", [uid]);
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
const confirm = (db, o) =>
  value(db, "SELECT confirm_billing_live_order($1,$2) AS value", [
    o.id,
    o.amount_kopecks,
  ]);
const status = async (db, id, user = uid) => {
  const raw = await rpc(db, "get_my_live_payment_status", [id], user);
  return raw === null ? null : parseLivePaymentStatus(raw, user, id);
};
const stored = (db) =>
  value(
    db,
    "SELECT jsonb_build_object('usage',(SELECT to_jsonb(u) FROM user_usage_tiers u WHERE user_id=$1),'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM billing_live_orders o),'packs',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM message_packs p)) AS value",
    [uid],
  );

test("status is owner-only and returns exactly the minimal DTO; reads never grant or consume", async () => {
  const db = await database();
  try {
    const order = await create(db), before = await stored(db);
    const result = await status(db, order.id);
    assert.deepEqual(Object.keys(result).sort(), [
      "billing",
      "currentGrant",
      "order",
      "version",
    ]);
    assert.deepEqual(Object.keys(result.order).sort(), [
      "amountKopecks",
      "appliedAt",
      "expiresAt",
      "id",
      "paidAt",
      "paidUntil",
      "productId",
      "purchaseKind",
      "status",
    ]);
    assert.equal(result.order.id, order.id);
    assert.equal(result.order.amountKopecks, 199000);
    assert.equal(result.order.status, "pending");
    assert.equal(result.currentGrant, false);
    assert.equal(result.billing.userId, uid);
    assert.ok(result.billing.serverNow);
    assert.equal(await status(db, order.id, other), null);
    assert.equal(await status(db, randomUUID()), null);
    assert.deepEqual(await stored(db), before);
    for (const role of ["anon", "service_role"]) {
      await db.exec("SET ROLE " + role);
      await assert.rejects(
        db.query("SELECT get_my_live_payment_status($1)", [order.id]),
        /permission denied/,
      );
      await db.exec("RESET ROLE");
    }
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      db.query("SELECT get_my_live_payment_status($1)", [order.id]),
      /not_authenticated/,
    );
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});
test("pending expiry is a read-only projection and a late verified confirmation still applies", async () => {
  const db = await database();
  try {
    const order = await create(db);
    await db.query(
      "UPDATE billing_live_orders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [order.id],
    );
    const before = await stored(db);
    assert.equal((await status(db, order.id)).order.status, "expired");
    assert.deepEqual(await stored(db), before);
    await db.exec("UPDATE billing_live_settings SET create_enabled=false");
    await confirm(db, order);
    const result = await status(db, order.id);
    assert.equal(result.order.status, "applied");
    assert.equal(result.currentGrant, true);
    assert.equal(result.billing.usage.tier, "basic");
    assert.equal(
      Date.parse(result.order.paidUntil) - Date.parse(result.order.appliedAt),
      30 * 86400000,
    );
  } finally {
    await db.close();
  }
});
test("old Basic after Premium upgrade remains history, never claims Basic is active again", async () => {
  const db = await database();
  try {
    const first = await create(db);
    await confirm(db, first);
    const firstStatus = await status(db, first.id);
    const premium = await create(db, "premium");
    await confirm(db, premium);
    const before = await stored(db),
      old = await status(db, first.id),
      current = await status(db, premium.id);
    assert.equal(old.order.status, "applied");
    assert.equal(old.order.paidUntil, firstStatus.order.paidUntil);
    assert.equal(old.currentGrant, false);
    assert.equal(old.billing.usage.tier, "premium");
    assert.equal(current.currentGrant, true);
    assert.equal(current.order.purchaseKind, "upgrade");
    assert.deepEqual(await stored(db), before);
  } finally {
    await db.close();
  }
});
test("expired/monthly/manual replacement never promises a current purchased grant", async () => {
  const db = await database();
  try {
    const order = await create(db);
    await confirm(db, order);
    await db.query(
      "UPDATE user_usage_tiers SET paid_access_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [uid],
    );
    assert.equal((await status(db, order.id)).currentGrant, false);
    assert.equal((await status(db, order.id)).billing.usage.tier, "free");
    await db.query("SELECT set_user_plan($1,'basic')", [uid]);
    const r = await status(db, order.id);
    assert.equal(r.currentGrant, false);
    assert.equal(r.order.status, "applied");
    assert.equal(r.billing.usage.access_source, "manual");
  } finally {
    await db.close();
  }
});
test("consumed bought pack is payment history, not100 new spendable messages", async () => {
  const db = await database();
  try {
    const order = await create(db, "pack100");
    await confirm(db, order);
    await db.query(
      "UPDATE message_packs SET messages_left=0 WHERE user_id=$1",
      [uid],
    );
    const before = await stored(db), r = await status(db, order.id);
    assert.equal(r.order.status, "applied");
    assert.equal(r.order.paidUntil, null);
    assert.equal(r.currentGrant, false);
    assert.deepEqual(r.billing.packs, []);
    assert.deepEqual(await stored(db), before);
  } finally {
    await db.close();
  }
});
test("paid_unfulfilled remains recognized payment and inactive profiles reveal no status", async () => {
  const db = await database();
  try {
    const order = await create(db);
    await db.query("SELECT set_user_plan($1,'premium')", [uid]);
    await confirm(db, order);
    const r = await status(db, order.id);
    assert.equal(r.order.status, "paid_unfulfilled");
    assert.ok(r.order.paidAt);
    assert.equal(r.order.appliedAt, null);
    assert.equal(r.currentGrant, false);
    await db.query(
      "UPDATE user_usage_tiers SET is_suspended=true WHERE user_id=$1",
      [uid],
    );
    assert.equal(await status(db, order.id), null);
    await db.query(
      "UPDATE user_usage_tiers SET is_suspended=false WHERE user_id=$1",
      [uid],
    );
    await db.query(
      "UPDATE profiles SET room_deletion_requested_at=clock_timestamp() WHERE id=$1",
      [uid],
    );
    assert.equal(await status(db, order.id), null);
  } finally {
    await db.close();
  }
});
test("settlement and status use the same720-hour term across DST and reader time zones", async () => {
  const db = await database();
  try {
    // Isolated DB only: deterministic server wall clock crosses US DST without changing the host clock.
    await db.exec(
      "CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$SELECT '2026-03-01T12:00:00Z'::timestamptz$$",
    );
    await db.exec("SET timezone='America/New_York'");
    const order = await create(db);
    await confirm(db, order);
    const end = await value(
      db,
      "SELECT extract(epoch FROM paid_access_until) AS value FROM user_usage_tiers WHERE user_id=$1",
      [uid],
    );
    assert.equal(Number(end), Date.parse("2026-03-31T12:00:00Z") / 1000);
    const first = await status(db, order.id);
    assert.equal(first.currentGrant, true);
    assert.equal(
      Date.parse(first.order.paidUntil),
      Date.parse("2026-03-31T12:00:00Z"),
    );
    await db.exec("SET timezone='UTC'");
    const second = await status(db, order.id);
    assert.equal(second.currentGrant, true);
    assert.equal(
      Date.parse(second.order.paidUntil),
      Date.parse(first.order.paidUntil),
    );
  } finally {
    await db.close();
  }
});
