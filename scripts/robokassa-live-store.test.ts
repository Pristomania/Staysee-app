import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createLiveResultStore } from "../supabase/functions/_shared/robokassaLiveResultStore.ts";
const id = "11111111-1111-4111-8111-111111111111";
const row = {
  id,
  invoice_id: 2000000000001,
  mode: "live",
  merchant_login: "StayseeAI",
  amount_kopecks: 199000,
  status: "pending",
};
function fixture(data: unknown = row) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const db = createClient("https://database.invalid", "dummy-non-secret", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        return new Response(
          JSON.stringify(
            url.includes("/rpc/")
              ? { status: "applied", duplicate: false, reason: null }
              : data,
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  });
  return { store: createLiveResultStore(db), calls };
}
test("real Supabase client reads only minimal live ledger fields and confirms stored UUID with exact amount", async () => {
  const { store, calls } = fixture();
  const signal = new AbortController().signal;
  const order = await store.get("2000000000001", signal);
  assert.deepEqual(order, {
    id,
    invoiceId: "2000000000001",
    merchantLogin: "StayseeAI",
    mode: "live",
    amountKopecks: 199000,
    status: "pending",
  });
  assert.equal(new URL(calls[0].url).pathname, "/rest/v1/billing_live_orders");
  assert.equal(
    new URL(calls[0].url).searchParams.get("invoice_id"),
    "eq.2000000000001",
  );
  assert.equal(new URL(calls[0].url).searchParams.get("mode"), "eq.live");
  assert.equal(
    new URL(calls[0].url).searchParams.get("select"),
    "id,invoice_id,mode,merchant_login,amount_kopecks,status",
  );
  assert.equal(calls[0].init?.signal, signal);
  assert.deepEqual(await store.confirm(order!, 199000, signal), {
    status: "applied",
    duplicate: false,
    reason: null,
  });
  assert.equal(
    new URL(calls[1].url).pathname,
    "/rest/v1/rpc/confirm_billing_live_order",
  );
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    p_order_id: id,
    p_amount_kopecks: 199000,
  });
  assert.equal(calls[1].init?.signal, signal);
});
for (
  const data of [
    { ...row, id: "not-a-uuid" },
    { ...row, invoice_id: 2.5 },
    { ...row, mode: "test" },
    { ...row, status: "test_paid" },
    { ...row, amount_kopecks: "199000" },
  ]
) {
  test(
    "malformed database row is not passed to confirmation: " +
      JSON.stringify(data),
    async () => {
      await assert.rejects(
        fixture(data).store.get("2000000000001", new AbortController().signal),
        /invalid_live_order/,
      );
    },
  );
}
test("missing order remains missing, and aborted calls cannot create network work", async () => {
  assert.equal(
    await fixture(null).store.get(
      "2000000000001",
      new AbortController().signal,
    ),
    null,
  );
  const { store, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.get("2000000000001", controller.signal));
  assert.equal(calls.length, 0);
});
