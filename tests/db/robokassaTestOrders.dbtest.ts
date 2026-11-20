import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { adminClient, createUser, deleteUser, must } from "./helpers.ts";

test("real local Supabase: parallel test callbacks settle once without changing account usage", async () => {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(process.env.SUPABASE_URL ?? "https://unconfigured.invalid").hostname,
    ),
    "This test may only create/delete data in a local Supabase",
  );
  const db = adminClient();
  const uid = await createUser(db, "robokassa-orders");
  let invoice: string | undefined;
  try {
    await must(
      db.from("user_usage_tiers").upsert({
        user_id: uid,
        tier: "free",
        is_suspended: false,
      }),
      "seed usage",
    );
    await must(db.from("profiles").upsert({ id: uid }), "seed profile");
    const before = await must(
      db.from("user_usage_tiers").select("*").eq("user_id", uid).single(),
      "usage before",
    );
    const args = {
      p_user_id: uid,
      p_product_id: "basic",
      p_idempotency_key: randomUUID(),
      p_merchant_login: "StayseeAI",
    };
    const created = await must(
      db.rpc("create_robokassa_test_order", args),
      "create order",
    ) as { invoiceId: string; amountKopecks: number };
    invoice = created.invoiceId;
    assert.equal(created.amountKopecks, 199000);
    const repeated = await must(
      db.rpc("create_robokassa_test_order", args),
      "retry order",
    ) as { invoiceId: string };
    assert.equal(repeated.invoiceId, invoice);
    const changed = await db.rpc("create_robokassa_test_order", {
      ...args,
      p_product_id: "premium",
    });
    assert.ok(changed.error?.message.includes("idempotency_conflict"));
    const settled = await Promise.all(
      [1, 2, 3].map(() =>
        must(
          db.rpc("settle_robokassa_test_order", {
            p_invoice_id: invoice,
            p_amount_kopecks: 199000,
          }),
          "settle",
        )
      ),
    );
    assert.equal(
      settled.filter((v) => (v as { duplicate: boolean }).duplicate === false)
        .length,
      1,
    );
    assert.equal(
      settled.filter((v) => (v as { duplicate: boolean }).duplicate === true)
        .length,
      2,
    );
    const after = await must(
      db.from("user_usage_tiers").select("*").eq("user_id", uid).single(),
      "usage after",
    );
    assert.deepEqual(after, before);
  } finally {
    // Local harness refuses non-local Supabase; clean only this test's invoice and generated user.
    if (invoice) {
      await must(
        db.from("robokassa_test_orders").delete().eq("invoice_id", invoice),
        "cleanup order",
      );
    }
    await deleteUser(db, uid);
  }
});
