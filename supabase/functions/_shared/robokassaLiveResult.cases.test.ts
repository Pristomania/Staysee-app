import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createRobokassaLiveResult,
  type LiveOrder,
  type LiveResultConfig,
  type LiveResultStore,
  validLiveResultConfig,
} from "./robokassaLiveResult.ts";

const config: LiveResultConfig = {
  enabled: true,
  merchantLogin: "StayseeAI",
  password2: "live-only-password2",
  testPasswords: ["test-one", "test-two"],
};
const invoiceId = "2000000000001";
const order: LiveOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  invoiceId,
  merchantLogin: "StayseeAI",
  mode: "live",
  amountKopecks: 199000,
  status: "pending",
};
function signed(
  amount = "1990.000000",
  mode = "live",
  shop = "StayseeAI",
  password = config.password2,
) {
  const SignatureValue = createHash("sha256").update(
    `${amount}:${invoiceId}:${password}:Shp_mode=${mode}:Shp_shop=${shop}`,
  ).digest("hex");
  return new URLSearchParams({
    OutSum: amount,
    InvId: invoiceId,
    SignatureValue,
    Shp_mode: mode,
    Shp_shop: shop,
  });
}
function request(
  body: string | URLSearchParams = signed(),
  headers: Record<string, string> = {},
) {
  return new Request("https://example.invalid/result", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: String(body),
  });
}
function fixture(
  overrides: Partial<LiveResultStore> = {},
  options: Record<string, unknown> = {},
) {
  const calls: unknown[] = [];
  const store: LiveResultStore = {
    async get(id, signal) {
      calls.push(["get", id]);
      assert.equal(signal.aborted, false);
      return order;
    },
    async confirm(saved, amount, signal) {
      calls.push(["confirm", saved.id, amount]);
      assert.equal(signal.aborted, false);
      return { status: "applied", duplicate: false, reason: null };
    },
    ...overrides,
  };
  const handler = createRobokassaLiveResult({ config, store, ...options });
  return { handler, calls };
}

test("independent SHA256 six-decimal callback confirms stored UUID and acknowledges only after confirmation", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `OK${invoiceId}`);
  assert.deepEqual(calls, [["get", invoiceId], ["confirm", order.id, 199000]]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

for (const amount of ["1990", "1990.00", "1990.000000"]) {
  test(`signature uses received precision ${amount}`, async () => {
    assert.equal(
      (await fixture().handler(request(signed(amount)))).status,
      200,
    );
  });
}
for (
  const [name, change] of [
    [
      "forgery",
      (p: URLSearchParams) => p.set("SignatureValue", "0".repeat(64)),
    ],
    [
      "changed precision after signing",
      (p: URLSearchParams) => p.set("OutSum", "1990.00"),
    ],
    [
      "duplicate required",
      (p: URLSearchParams) => p.append("InvId", invoiceId),
    ],
    ["duplicate optional", (p: URLSearchParams) => {
      p.append("Fee", "1");
      p.append("Fee", "1");
    }],
    ["case alias", (p: URLSearchParams) => p.set("outsum", "1")],
    ["Shp case alias", (p: URLSearchParams) => p.set("shp_mode", "live")],
    ["unknown Shp", (p: URLSearchParams) => p.set("Shp_user", "x")],
    ["explicit test", (p: URLSearchParams) => p.set("IsTest", "1")],
    ["invalid IsTest", (p: URLSearchParams) => p.set("IsTest", "false")],
    [
      "wrong optional merchant",
      (p: URLSearchParams) => p.set("MerchantLogin", "Other"),
    ],
  ] as const
) {
  test(`rejects ${name} before lookup`, async () => {
    const params = signed();
    change(params);
    const { handler, calls } = fixture();
    assert.equal((await handler(request(params))).status, 400);
    assert.deepEqual(calls, []);
  });
}
for (
  const params of [
    signed("1990.000001"),
    signed("0"),
    signed("01"),
    signed("1990", "test"),
    signed("1990", "live", "Other"),
    signed("1990", "live", "StayseeAI", "test-two"),
  ]
) {
  test(`rejects independently signed invalid envelope ${params.get("OutSum")}/${params.get("Shp_mode")}/${params.get("Shp_shop")}`, async () => {
    const { handler, calls } = fixture();
    assert.equal((await handler(request(params))).status, 400);
    assert.deepEqual(calls, []);
  });
}
test("provider optional metadata and uppercase signature are accepted but not stored", async () => {
  const p = signed();
  p.set("SignatureValue", p.get("SignatureValue")!.toUpperCase());
  p.set("EMail", "private@example.invalid");
  p.set("Fee", "10.00");
  p.set("IsTest", "0");
  assert.equal((await fixture().handler(request(p))).status, 200);
});
test("quoted UTF-8 charset is a valid callback, other charsets remain rejected before lookup", async () => {
  const { handler, calls } = fixture();
  assert.equal(
    (await handler(
      request(signed(), {
        "content-type": 'application/x-www-form-urlencoded; charset="UTF-8"',
      }),
    )).status,
    200,
  );
  assert.equal(
    (await handler(
      request(signed(), {
        "content-type":
          'application/x-www-form-urlencoded; charset="windows-1251"',
      }),
    )).status,
    415,
  );
  assert.equal(calls.length, 2);
});
test("whitespace-only password cannot enable callback, but nonblank literal password is never trimmed", async () => {
  for (const password2 of [" ", "\t", " \t "]) {
    const { handler, calls } = fixture({}, {
      config: { ...config, password2 },
    });
    assert.equal(
      (await handler(
        request(signed("1990.000000", "live", "StayseeAI", password2)),
      )).status,
      503,
    );
    assert.deepEqual(calls, []);
  }
  const password2 = " live-secret-with-spaces ";
  const { handler } = fixture({}, { config: { ...config, password2 } });
  assert.equal(
    (await handler(
      request(signed("1990.000000", "live", "StayseeAI", password2)),
    )).status,
    200,
  );
  assert.equal(
    (await handler(
      request(signed("1990.000000", "live", "StayseeAI", password2.trim())),
    )).status,
    400,
  );
});
for (const bad of ["%FF", "%E0%A4%A"]) {
  test(`bad percent UTF8 in optional field cannot bypass a valid signed envelope: ${bad}`, async () => {
    const { handler, calls } = fixture();
    assert.equal(
      (await handler(request(`${signed()}&EMail=${bad}`))).status,
      400,
    );
    assert.deepEqual(calls, []);
  });
}
test("raw bad UTF8 in optional field is rejected even with an otherwise valid signed envelope", async () => {
  const { handler, calls } = fixture();
  const prefix = new TextEncoder().encode(`${signed()}&EMail=`);
  const body = new Uint8Array(prefix.length + 1);
  body.set(prefix);
  body[prefix.length] = 255;
  const req = new Request("https://example.invalid/result", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal((await handler(req)).status, 400);
  assert.deepEqual(calls, []);
});
for (
  const saved of [
    null,
    { ...order, mode: "test" },
    { ...order, merchantLogin: "Other" },
    { ...order, invoiceId: "2000000000002" },
    { ...order, amountKopecks: 1 },
  ]
) {
  test(`stored order mismatch is never confirmed: ${JSON.stringify(saved)}`, async () => {
    const { handler, calls } = fixture({
      get: async () => saved as LiveOrder | null,
    });
    assert.equal((await handler(request())).status, 400);
    assert.deepEqual(calls, []);
  });
}
test("database failure has no ACK or leaked error", async () => {
  const { handler } = fixture({
    confirm: async () => {
      throw new Error("sensitive-database-detail");
    },
  });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "temporarily_unavailable");
});
test("pending confirmation is not acknowledged", async () => {
  const { handler } = fixture({
    confirm: async () => ({ status: "pending" } as never),
  });
  assert.equal((await handler(request())).status, 503);
});
test("committed duplicate acknowledges without a new grant", async () => {
  const { handler } = fixture({
    confirm: async () => ({ status: "applied", duplicate: true, reason: null }),
  });
  assert.equal(await (await handler(request())).text(), `OK${invoiceId}`);
});
test("paid_unfulfilled ACK survives reporting failure and reports only safe identifiers", async () => {
  const events: unknown[] = [];
  const { handler } = fixture({
    confirm: async () => ({
      status: "paid_unfulfilled",
      duplicate: false,
      reason: "account_inactive",
    }),
  }, {
    report: (event: unknown) => {
      events.push(event);
      throw new Error("logger failed");
    },
  });
  assert.equal(await (await handler(request())).text(), `OK${invoiceId}`);
  assert.deepEqual(events, [{
    event: "robokassa_live_paid_unfulfilled",
    invoiceId,
    reason: "account_inactive",
    duplicate: false,
  }]);
});
test("async reporting rejection cannot cause an unhandled rejection after committed ACK", async () => {
  const { handler } = fixture({
    confirm: async () => ({
      status: "paid_unfulfilled",
      duplicate: false,
      reason: "active_plan",
    }),
  }, {
    report: async () => {
      throw new Error("async logger failed");
    },
  });
  assert.equal(await (await handler(request())).text(), `OK${invoiceId}`);
  await new Promise((resolve) => setTimeout(resolve, 5));
});
test("unresponsive database is aborted within deadline and never ACKed", async () => {
  let signal: AbortSignal | undefined;
  const { handler } = fixture({
    get: async (_, s) => {
      signal = s;
      return await new Promise(() => {});
    },
  }, { timeoutMs: 25 });
  assert.equal((await handler(request())).status, 503);
  assert.equal(signal?.aborted, true);
});
test("hanging request body is cancelled at the same deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request(
    "https://example.invalid/result",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit,
  );
  assert.equal((await fixture({}, { timeoutMs: 25 }).handler(req)).status, 503);
  assert.equal(cancelled, true);
});
for (
  const body of [
    "bad=%XX",
    "bad=%FF",
    "bad=%E0%A4%A",
    `${signed()}&${Array.from({ length: 25 }, (_, i) => `k${i}=x`).join("&")}`,
  ]
) {
  test(`malformed or excessive form fails closed: ${body.slice(-25)}`, async () => {
    const { handler, calls } = fixture();
    assert.equal((await handler(request(body))).status, 400);
    assert.deepEqual(calls, []);
  });
}
test("raw invalid UTF8 fails closed", async () => {
  const req = new Request("https://example.invalid/result", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new Uint8Array([255]),
  });
  assert.equal((await fixture().handler(req)).status, 400);
});
test("oversized streamed body is bounded without Content-Length", async () => {
  assert.equal(
    (await fixture().handler(request("a".repeat(8193)))).status,
    413,
  );
});
test("query, method and media type cannot bypass the callback boundary", async () => {
  const { handler, calls } = fixture();
  assert.equal(
    (await handler(new Request("https://example.invalid/result"))).status,
    405,
  );
  assert.equal(
    (await handler(
      new Request("https://example.invalid/result?x=1", request()),
    )).status,
    400,
  );
  assert.equal(
    (await handler(request(signed(), { "content-type": "application/json" })))
      .status,
    415,
  );
  assert.deepEqual(calls, []);
});
test("default-off, invalid credentials and any reused test password cannot touch storage", async () => {
  for (
    const c of [
      { ...config, enabled: false },
      { ...config, password2: "" },
      { ...config, merchantLogin: "bad:shop" },
      { ...config, password2: "test-one" },
      { ...config, password2: "test-two" },
    ]
  ) {
    assert.equal(validLiveResultConfig(c), false);
    const { handler, calls } = fixture({}, { config: c });
    assert.equal((await handler(request())).status, 503);
    assert.deepEqual(calls, []);
  }
  assert.equal(validLiveResultConfig(config), true);
});
