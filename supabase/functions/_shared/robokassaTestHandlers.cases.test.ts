import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createRobokassaTestHandlers,
  type PaymentStore,
  type StoredTestOrder,
} from "./robokassaTestHandlers.ts";

const uid = "11111111-1111-4111-8111-111111111111";
const stored: StoredTestOrder = {
  invoiceId: "123",
  merchantLogin: "StayseeAI",
  mode: "test",
  amountKopecks: 199000,
  userId: uid,
  productId: "basic",
  status: "pending",
  productName: "StaySee AI: Базовый, 30 дней",
  receiptJson: JSON.stringify({
    sno: "usn_income",
    items: [{
      name: "StaySee AI: Базовый, 30 дней",
      quantity: 1,
      sum: 1990,
      payment_method: "full_prepayment",
      payment_object: "service",
      tax: "none",
    }],
  }),
};
function harness(
  options: {
    mode?: string;
    user?: { id: string; active: boolean } | null;
    owner?: string;
    storeFail?: boolean;
    amount?: number;
    password1?: string;
    password2?: string;
    oldSnapshot?: boolean;
  } = {},
) {
  let row = {
    ...stored,
    userId: options.owner ?? uid,
    amountKopecks: options.amount ?? 199000,
  };
  if (options.oldSnapshot) {
    row = {
      ...row,
      amountKopecks: 100000,
      productName: "StaySee AI: Старый базовый",
      receiptJson: JSON.stringify({
        sno: "usn_income",
        items: [{
          name: "StaySee AI: Старый базовый",
          quantity: 1,
          sum: 1000,
          payment_method: "full_prepayment",
          payment_object: "service",
          tax: "none",
        }],
      }),
    };
  }
  let writes = 0;
  let operations = 0;
  const store: PaymentStore = {
    create: async (input) => {
      operations++;
      assert.equal(input.userId, uid);
      assert.equal(input.productId, "basic");
      assert.equal(
        input.idempotencyKey,
        "12345678-1234-4234-8234-123456789abc",
      );
      return { ...row };
    },
    get: async () => {
      operations++;
      return { ...row };
    },
    settle: async (invoice, amount) => {
      assert.equal(invoice, "123");
      assert.equal(amount, 199000);
      if (options.storeFail) throw new Error("private db secret");
      if (row.status === "pending") {
        writes++;
        row = { ...row, status: "test_paid" };
      }
      return { status: "test_paid" };
    },
  };
  const handlers = createRobokassaTestHandlers({
    config: {
      mode: options.mode ?? "test",
      merchantLogin: "StayseeAI",
      password1: options.password1 ?? "password-1",
      password2: options.password2 ?? "password-2",
      allowedUserIds: [uid],
      allowedOrigins: ["https://staysee.ru"],
    },
    store,
    authenticate: async () =>
      options.user === undefined ? { id: uid, active: true } : options.user,
  });
  return { ...handlers, writes: () => writes, operations: () => operations };
}
function createRequest(
  body: unknown = {
    productId: "basic",
    idempotencyKey: "12345678-1234-4234-8234-123456789abc",
  },
  origin = "https://staysee.ru",
) {
  return new Request("https://example.invalid/create", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}
function notice(amount = "1990.000000") {
  const params = new URLSearchParams({
    OutSum: amount,
    InvId: "123",
    Shp_mode: "test",
    Shp_shop: "StayseeAI",
  });
  params.set(
    "SignatureValue",
    createHash("sha256").update(
      `${amount}:123:password-2:Shp_mode=test:Shp_shop=StayseeAI`,
    ).digest("hex"),
  );
  return new Request("https://example.invalid/result", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
}

test("disabled/live configs never authorize checkout or settle callbacks", async () => {
  for (const mode of ["disabled", "live", ""]) {
    const h = harness({ mode });
    assert.equal((await h.create(createRequest())).status, 503);
    assert.equal((await h.result(notice())).status, 503);
    assert.equal(h.writes(), 0);
  }
});
test("authentication, account state and exact origin are enforced", async () => {
  for (
    const user of [null, { id: "other", active: true }, {
      id: uid,
      active: false,
    }]
  ) {
    assert.ok(
      [401, 403].includes(
        (await harness({ user }).create(createRequest())).status,
      ),
    );
  }
  assert.equal(
    (await harness().create(
      createRequest(undefined, "https://staysee.ru.evil.invalid"),
    )).status,
    403,
  );
});
test("checkout uses server-owned order and returns only test POST fields", async () => {
  const r = await harness().create(createRequest());
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.mode, "test");
  assert.equal(body.invoiceId, "123");
  assert.equal(body.checkout.fields.OutSum, "1990.00");
  assert.equal(body.checkout.fields.IsTest, "1");
  assert.equal(JSON.stringify(body).includes("password-"), false);
  assert.equal(r.headers.get("cache-control"), "no-store");
});
test("forged prices/owners, oversized JSON and catalog drift are rejected", async () => {
  assert.equal(
    (await harness().create(
      createRequest({
        productId: "basic",
        idempotencyKey: "12345678-1234-4234-8234-123456789abc",
        userId: "victim",
        amount: 1,
      }),
    )).status,
    400,
  );
  assert.equal(
    (await harness().create(
      createRequest({
        productId: "constructor",
        idempotencyKey: "12345678-1234-4234-8234-123456789abc",
      }),
    )).status,
    400,
  );
  assert.equal(
    (await harness().create(
      createRequest({ productId: "basic", idempotencyKey: "x".repeat(5000) }),
    )).status,
    413,
  );
  assert.equal(
    (await harness({ amount: 1 }).create(createRequest())).status,
    503,
  );
});
test("status requires ownership and never exposes another user or checkout secrets", async () => {
  const h = harness();
  const r = await h.status(
    new Request("https://example.invalid/status?invoiceId=123"),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    invoiceId: "123",
    status: "pending",
    mode: "test",
    grantsAccess: false,
  });
  assert.equal(
    (await harness({ owner: "other" }).status(
      new Request("https://example.invalid/status?invoiceId=123"),
    )).status,
    404,
  );
});
test("capabilities are allowlisted and test-only without any ledger lookup", async () => {
  const h = harness();
  const r = await h.status(
    new Request("https://example.invalid/status?capabilities=1"),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    mode: "test",
    allowed: true,
    grantsAccess: false,
  });
  assert.equal(h.operations(), 0);
  assert.equal(
    (await harness({ user: null }).status(
      new Request("https://example.invalid/status?capabilities=1"),
    )).status,
    401,
  );
  assert.equal(
    (await harness({ user: { id: "other", active: true } }).status(
      new Request("https://example.invalid/status?capabilities=1"),
    )).status,
    403,
  );
  assert.equal(
    (await harness({ mode: "disabled" }).status(
      new Request("https://example.invalid/status?capabilities=1"),
    )).status,
    503,
  );
  assert.equal(
    (await h.status(
      new Request(
        "https://example.invalid/status?capabilities=1&invoiceId=123",
      ),
    )).status,
    400,
  );
  assert.equal(
    (await h.status(
      new Request(
        "https://example.invalid/status?capabilities=1&capabilities=1",
      ),
    )).status,
    400,
  );
});

test("only verified callback commits and returns OK, repeats do not settle twice", async () => {
  const h = harness();
  assert.equal((await h.result(notice("1.00"))).status, 400);
  assert.equal(h.writes(), 0);
  assert.equal(await (await h.result(notice())).text(), "OK123");
  assert.equal(await (await h.result(notice())).text(), "OK123");
  assert.equal(h.writes(), 1);
});
test("DB failure is retryable, never claims OK and never prints private exception", async () => {
  const h = harness({ storeFail: true });
  const r = await h.result(notice());
  assert.equal(r.status, 503);
  assert.equal(await r.text(), "temporarily_unavailable");
  assert.equal(h.writes(), 0);
});
test("GET result, query mixing, duplicate fields and malformed forms cannot settle", async () => {
  const h = harness();
  assert.equal(
    (await h.result(new Request("https://example.invalid/result?OutSum=1990")))
      .status,
    405,
  );
  const duplicate = notice();
  const raw = await duplicate.text();
  for (
    const [url, body] of [
      ["https://example.invalid/result", raw + "&InvId=123"],
      ["https://example.invalid/result?InvId=123", raw],
      ["https://example.invalid/result", "OutSum=%QQ"],
    ] as const
  ) {
    assert.equal(
      (await h.result(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      )).status,
      400,
    );
  }
  assert.equal(h.writes(), 0);
});
test("malformed credentials fail closed before order storage for every route", async () => {
  for (
    const credentials of [{ password1: "bad\n" }, { password2: "bad\n" }, {
      password1: "same",
      password2: "same",
    }, { password2: "bad:delimiter" }]
  ) {
    const h = harness(credentials);
    assert.equal((await h.create(createRequest())).status, 503);
    assert.equal((await h.result(notice())).status, 503);
    assert.equal(
      (await h.status(
        new Request("https://example.invalid/status?invoiceId=123"),
      )).status,
      503,
    );
    assert.equal(h.operations(), 0);
  }
});
test("an unsigned public callback cannot trigger a database lookup", async () => {
  const h = harness();
  const r = await h.result(
    new Request("https://example.invalid/result", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "InvId=123",
    }),
  );
  assert.equal(r.status, 400);
  assert.equal(h.operations(), 0);
});
test("a checkout retry uses the stored price and exact receipt, not the current catalog", async () => {
  const r = await harness({ oldSnapshot: true }).create(createRequest());
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.checkout.fields.OutSum, "1000.00");
  assert.equal(
    JSON.parse(decodeURIComponent(body.checkout.fields.Receipt)).items[0].name,
    "StaySee AI: Старый базовый",
  );
});
test("ambiguous JSON, malformed UTF8 and repeated metadata fail before database access", async () => {
  const h = harness();
  const duplicate = new Request("https://example.invalid/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body:
      '{"productId":"premium","productId":"basic","idempotencyKey":"12345678-1234-4234-8234-123456789abc"}',
  });
  assert.equal((await h.create(duplicate)).status, 400);
  const raw = await notice().text();
  for (const suffix of ["&Fee=1&Fee=2", "&EMail=%C0%AF"]) {
    assert.equal(
      (await h.result(
        new Request("https://example.invalid/result", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: raw + suffix,
        }),
      )).status,
      400,
    );
  }
  assert.equal(h.operations(), 0);
});
