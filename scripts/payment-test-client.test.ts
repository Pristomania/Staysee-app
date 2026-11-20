import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeTestCheckout,
  createPaymentTestApi,
  type PaymentTestApi,
  PaymentTestController,
  shouldResumePayment,
  type TestCheckout,
  type TestCreated,
  validateCheckout,
} from "../src/lib/paymentTestClient.ts";

const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const checkout = (): TestCheckout => ({
  action: "https://auth.robokassa.ru/Merchant/Index.aspx",
  method: "POST",
  fields: {
    MerchantLogin: "StayseeAI",
    OutSum: "1990.00",
    InvId: "1000000000000",
    Receipt: encodeURIComponent(
      JSON.stringify({
        sno: "usn_income",
        items: [{
          name: "Исторический тариф StaySee AI",
          quantity: 1,
          sum: 1990,
          payment_method: "full_prepayment",
          payment_object: "service",
          tax: "none",
        }],
      }),
    ),
    IsTest: "1",
    Culture: "ru",
    Encoding: "utf-8",
    Shp_mode: "test",
    Shp_shop: "StayseeAI",
    SignatureValue: "a".repeat(64),
  },
});
const pending = (): TestCreated => ({
  invoiceId: "1000000000000",
  mode: "test",
  grantsAccess: false,
  checkout: checkout(),
});
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
}
function api(overrides: Partial<PaymentTestApi> = {}): PaymentTestApi {
  return {
    capabilities: async () => {},
    create: async () => pending(),
    status: async () => ({
      invoiceId: "1000000000000",
      status: "pending",
      mode: "test",
      grantsAccess: false,
    }),
    ...overrides,
  };
}

test("transport confines JWT to own API headers and validates test checkout", async () => {
  const requests: Request[] = [];
  const client = createPaymentTestApi({
    baseUrl: "https://staysee.ru/supabase",
    anonKey: "public",
    userId: user,
    session: async () => ({ userId: user, token: "private-token" }),
    fetcher: async (request) => {
      requests.push(request);
      return Response.json(
        request.method === "POST"
          ? pending()
          : { mode: "test", allowed: true, grantsAccess: false },
      );
    },
  });
  await client.capabilities();
  const result = await client.create("basic", key);
  assert.equal(
    requests[0].url,
    "https://staysee.ru/supabase/functions/v1/robokassa-test-status?capabilities=1",
  );
  assert.equal(
    requests[1].headers.get("authorization"),
    "Bearer private-token",
  );
  assert.deepEqual(await requests[1].json(), {
    productId: "basic",
    idempotencyKey: key,
  });
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  assert.throws(
    () =>
      validateCheckout({ ...checkout(), action: "https://attacker.example/" }),
    /invalid_response/,
  );
  assert.throws(
    () =>
      validateCheckout({
        ...checkout(),
        fields: { ...checkout().fields, IsTest: "0" },
      }),
    /invalid_response/,
  );
  assert.throws(
    () =>
      validateCheckout({
        ...checkout(),
        fields: { ...checkout().fields, Authorization: "secret" },
      }),
    /invalid_response/,
  );
});

test("transport rejects changed user, wrong invoice, live response and times out a stalled fetch", async () => {
  const options = {
    baseUrl: "https://staysee.ru/supabase",
    anonKey: "public",
    userId: user,
    session: async () => ({ userId: user, token: "x" }),
  };
  const changed = createPaymentTestApi({
    ...options,
    session: async () => ({ userId: "other", token: "x" }),
    fetcher: async () => {
      throw Error("must not fetch");
    },
  });
  await assert.rejects(changed.capabilities(), /session_changed/);
  const wrong = createPaymentTestApi({
    ...options,
    fetcher: async () =>
      Response.json({
        invoiceId: "2",
        status: "test_paid",
        mode: "test",
        grantsAccess: false,
      }),
  });
  await assert.rejects(wrong.status("1"), /invalid_response/);
  const live = createPaymentTestApi({
    ...options,
    fetcher: async () =>
      Response.json({ mode: "live", allowed: true, grantsAccess: true }),
  });
  await assert.rejects(live.capabilities(), /invalid_response/);
  const stalled = createPaymentTestApi({
    ...options,
    timeoutMs: 10,
    fetcher: async () => new Promise(() => {}),
  });
  await assert.rejects(stalled.capabilities(), /network/);
});

test("unknown create result survives reload and reuses persisted key before contacting server", async () => {
  const saved = storage();
  let calls = 0;
  const service = api({
    create: async (product, attemptKey) => {
      assert.equal(product, "basic");
      assert.equal(attemptKey, key);
      assert.ok(saved.getItem(`staysee:payment-test:${user}`)?.includes(key));
      if (++calls === 1) throw Error("network");
      return pending();
    },
  });
  const first = new PaymentTestController(user, service, saved, () => key);
  await first.init();
  await first.start("basic");
  assert.equal(first.state.phase, "error");
  first.dispose();
  const second = new PaymentTestController(user, service, saved, () => {
    throw Error("new UUID forbidden");
  });
  await second.init();
  assert.equal(second.state.phase, "error");
  await second.retry();
  assert.equal(second.state.phase, "pending");
  assert.equal(second.state.attempt?.invoiceId, "1000000000000");
  await second.start("premium");
  assert.equal(calls, 2);
});

test("blocked storage fails closed; disposal ignores late creation; other user never resumes", async () => {
  let calls = 0;
  const blocked = new PaymentTestController(
    user,
    api({
      create: async () => {
        calls++;
        return pending();
      },
    }),
    {
      getItem: () => null,
      setItem: () => {
        throw Error("blocked");
      },
    },
    () => key,
  );
  await blocked.init();
  await blocked.start("basic");
  assert.equal(calls, 0);
  assert.equal(blocked.state.phase, "error");
  const saved = storage();
  let release!: (value: ReturnType<typeof pending>) => void;
  const late = new PaymentTestController(
    user,
    api({
      create: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    saved,
    () => key,
  );
  await late.init();
  const request = late.start("basic");
  late.dispose();
  release(pending());
  await request;
  assert.equal(late.state.checkout, undefined);
  const other = new PaymentTestController("other", api(), saved, () => key);
  await other.init();
  assert.equal(other.state.phase, "ready");
});

test("return flags grant nothing; only own saved attempt resumes, never password recovery", async () => {
  const saved = storage();
  const controller = new PaymentTestController(user, api(), saved, () => key);
  await controller.init();
  await controller.start("basic");
  controller.dispose();
  // Robokassa GET return URLs cannot contain our own query parameters.
  // Provider parameters are navigation hints only, never evidence of payment.
  const providerReturn =
    "?OutSum=1990.00&InvId=1000000000000&Shp_mode=test&Shp_shop=StayseeAI&IsTest=1";
  assert.equal(shouldResumePayment(providerReturn, user, false, saved), true);
  assert.equal(
    shouldResumePayment(providerReturn, "other", false, saved),
    false,
  );
  assert.equal(shouldResumePayment(providerReturn, user, true, saved), false);
  assert.equal(
    shouldResumePayment(
      providerReturn.replace("1000000000000", "1000000000001"),
      user,
      false,
      saved,
    ),
    false,
  );
  assert.equal(
    shouldResumePayment(
      providerReturn + "&InvId=1000000000000",
      user,
      false,
      saved,
    ),
    false,
  );
  assert.equal(
    shouldResumePayment(
      providerReturn.replace("IsTest=1", "IsTest=0"),
      user,
      false,
      saved,
    ),
    false,
  );
  assert.equal(
    shouldResumePayment(
      providerReturn.replace("StayseeAI", "other"),
      user,
      false,
      saved,
    ),
    false,
  );
  assert.equal(
    shouldResumePayment(
      providerReturn.replace("1000000000000", "1000000000001") +
        "&payment_test_return=1",
      user,
      false,
      saved,
    ),
    false,
  );
  assert.equal(
    shouldResumePayment(
      providerReturn + "&InvId=1000000000000&payment_test_return=1",
      user,
      false,
      saved,
    ),
    false,
  );
  assert.equal(
    shouldResumePayment("?payment_test_return=1", user, false, saved),
    true,
  );
  assert.equal(
    shouldResumePayment("?payment_test_return=1", "other", false, saved),
    false,
  );
  assert.equal(
    shouldResumePayment("?payment_test_return=1", user, true, saved),
    false,
  );
  assert.equal(
    shouldResumePayment(
      "?payment_test_return=1&payment_test_return=1",
      user,
      false,
      saved,
    ),
    false,
  );
  const resumed = new PaymentTestController(
    user,
    api({
      status: async () => ({
        invoiceId: "1000000000000",
        status: "test_paid",
        mode: "test",
        grantsAccess: false,
      }),
    }),
    saved,
    () => key,
  );
  await resumed.init();
  assert.equal(resumed.state.phase, "test_paid");
});

test("session lookup that finishes after timeout cannot send a late create request", async () => {
  let release!: (value: { userId: string; token: string }) => void;
  let requests = 0;
  const client = createPaymentTestApi({
    baseUrl: "https://staysee.ru/supabase",
    anonKey: "public",
    userId: user,
    timeoutMs: 5,
    session: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    fetcher: async () => {
      requests++;
      return Response.json(pending());
    },
  });
  await assert.rejects(client.create("basic", key), /network/);
  release({ userId: user, token: "late" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
});

test("pending checkout can resume explicitly after reload and survives a transient poll error", async () => {
  const saved = storage();
  let fail = true;
  const model = new PaymentTestController(
    user,
    api({
      status: async () => {
        if (fail) {
          fail = false;
          throw Error("lost poll");
        }
        return {
          invoiceId: "1000000000000",
          mode: "test",
          grantsAccess: false,
          status: "pending",
        };
      },
    }),
    saved,
    () => key,
  );
  await model.init();
  await model.start("basic");
  await model.check();
  await model.check();
  assert.ok(model.state.checkout);
  model.dispose();
  const resumed = new PaymentTestController(user, api(), saved, () => {
    throw Error("no new key");
  });
  await resumed.init();
  assert.equal(resumed.state.phase, "pending");
  assert.equal(resumed.state.checkout, undefined);
  await resumed.retry();
  assert.ok(resumed.state.checkout);
  assert.equal(resumed.state.attempt?.idempotencyKey, key);
});

test("replaying known invoice must not replace it with a different invoice", async () => {
  const saved = storage();
  const first = new PaymentTestController(user, api(), saved, () => key);
  await first.init();
  await first.start("basic");
  first.dispose();
  const wrong = pending();
  wrong.invoiceId = "1000000000001";
  wrong.checkout!.fields.InvId = wrong.invoiceId;
  const resumed = new PaymentTestController(
    user,
    api({ create: async () => wrong }),
    saved,
    () => key,
  );
  await resumed.init();
  await resumed.retry();
  assert.equal(resumed.state.phase, "error");
  assert.equal(resumed.state.attempt?.invoiceId, "1000000000000");
});

test("checkout authorization is bounded and canceled when its screen is abandoned", async () => {
  const abort = new AbortController();
  let release!: (value: { userId: string; token: string }) => void;
  const delayed = authorizeTestCheckout(
    user,
    checkout(),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    abort.signal,
    100,
  );
  abort.abort();
  await assert.rejects(delayed, /cancelled/);
  release({ userId: user, token: "late" });
  await assert.rejects(
    authorizeTestCheckout(
      user,
      checkout(),
      () => new Promise(() => {}),
      new AbortController().signal,
      5,
    ),
    /network/,
  );
  const ready = await authorizeTestCheckout(
    user,
    checkout(),
    async () => ({ userId: user, token: "secret" }),
    new AbortController().signal,
  );
  assert.deepEqual(ready, checkout());
  assert.equal(JSON.stringify(ready).includes("secret"), false);
});

test("contradictory terminal checkout and inconsistent receipts fail closed without rewriting signed bytes", async () => {
  const client = createPaymentTestApi({
    baseUrl: "https://staysee.ru/supabase",
    anonKey: "public",
    userId: user,
    session: async () => ({ userId: user, token: "x" }),
    fetcher: async () => Response.json({ ...pending(), status: "expired" }),
  });
  await assert.rejects(client.create("basic", key), /invalid_response/);
  for (
    const receipt of [
      "",
      "%7B%7D",
      encodeURIComponent(
        JSON.stringify({
          sno: "usn_income",
          items: [{
            name: "x",
            quantity: 1,
            sum: 1,
            payment_method: "full_prepayment",
            payment_object: "service",
            tax: "none",
          }],
        }),
      ),
    ]
  ) {
    assert.throws(
      () =>
        validateCheckout({
          ...checkout(),
          fields: { ...checkout().fields, Receipt: receipt },
        }),
      /invalid_response/,
    );
  }
  const historical = checkout();
  historical.fields.OutSum = "19.50";
  historical.fields.Receipt = encodeURIComponent(
    JSON.stringify({
      sno: "usn_income",
      items: [{
        name: "Старое название & пробел",
        quantity: 1,
        sum: 19.5,
        payment_method: "full_prepayment",
        payment_object: "service",
        tax: "none",
      }],
    }),
  );
  assert.equal(
    validateCheckout(historical).fields.Receipt,
    historical.fields.Receipt,
  );
});

test("authoritative no-create conflict returns product selection, unlike uncertain network error", async () => {
  const service = createPaymentTestApi({
    baseUrl: "https://staysee.ru/supabase",
    anonKey: "public",
    userId: user,
    session: async () => ({ userId: user, token: "x" }),
    fetcher: async (request) => {
      if (request.method === "GET") {
        return Response.json({
          mode: "test",
          allowed: true,
          grantsAccess: false,
        });
      }
      return Response.json({ error: "monthly_order_pending" }, { status: 409 });
    },
  });
  const saved = storage();
  const model = new PaymentTestController(user, service, saved, () => key);
  await model.init();
  await model.start("premium");
  assert.equal(model.state.phase, "ready");
  assert.equal(model.state.attempt, undefined);
  assert.equal(model.state.error, "monthly_order_pending");
  model.dispose();
  const restored = new PaymentTestController(user, api(), saved, () => key);
  await restored.init();
  assert.equal(restored.state.phase, "ready");
});
