import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildTestCheckout,
  getPaymentProduct,
  parseRublesToKopecks,
  verifyTestResult,
} from "./robokassaTestProtocol.ts";

const order = {
  invoiceId: "123",
  merchantLogin: "StayseeAI",
  mode: "test" as const,
  amountKopecks: 199000,
};
function result(
  amount = "1990.000000",
  overrides: Record<string, string> = {},
) {
  const p = new URLSearchParams({
    OutSum: amount,
    InvId: "123",
    Shp_mode: "test",
    Shp_shop: "StayseeAI",
    ...overrides,
  });
  p.set(
    "SignatureValue",
    createHash("sha256").update(
      `${p.get("OutSum")}:${p.get("InvId")}:test-password-2:Shp_mode=${
        p.get("Shp_mode")
      }:Shp_shop=${p.get("Shp_shop")}`,
    ).digest("hex"),
  );
  return p;
}

test("money accepts documented 2/6 decimals without floats and rejects hidden fractional kopecks", () => {
  for (
    const [input, want] of [
      ["1990", 199000],
      ["1990.00", 199000],
      ["1990.000000", 199000],
      ["0.01", 1],
      ["1.100000", 110],
    ] as const
  ) {
    assert.equal(parseRublesToKopecks(input), want);
  }
  for (
    const input of [
      "-1",
      "0",
      "0.000001",
      "1.001",
      "1e3",
      " 1",
      "1,00",
      "NaN",
      "01.00",
      "1.0000000",
      "9007199254740992",
      "1.",
    ]
  ) {
    assert.throws(() => parseRublesToKopecks(input), /invalid_amount/);
  }
});

test("catalog never accepts client supplied prices or prototype properties", () => {
  assert.equal(getPaymentProduct("basic").amountKopecks, 199000);
  assert.equal(getPaymentProduct("premium").amountKopecks, 490000);
  assert.equal(getPaymentProduct("pack100").amountKopecks, 59000);
  for (
    const id of ["free", "constructor", "__proto__", "toString", null, {
      id: "basic",
      amount: 1,
    }]
  ) {
    assert.throws(() => getPaymentProduct(id), /unknown_product/);
  }
});

test("checkout is always test-only, signed for POST with a complete receipt and no secret fields", async () => {
  const checkout = await buildTestCheckout({
    merchantLogin: "StayseeAI",
    password1: "not-returned-secret",
    invoiceId: "123",
    product: getPaymentProduct("basic"),
  });
  assert.equal(
    checkout.action,
    "https://auth.robokassa.ru/Merchant/Index.aspx",
  );
  assert.equal(checkout.method, "POST");
  assert.equal(checkout.fields.IsTest, "1");
  assert.equal(checkout.fields.OutSum, "1990.00");
  assert.equal(checkout.fields.Shp_mode, "test");
  assert.equal(checkout.fields.Shp_shop, "StayseeAI");
  const receipt = JSON.parse(decodeURIComponent(checkout.fields.Receipt));
  assert.deepEqual(receipt, {
    sno: "usn_income",
    items: [{
      name: "StaySee AI: Базовый, 30 дней",
      quantity: 1,
      sum: 1990,
      payment_method: "full_prepayment",
      payment_object: "service",
      tax: "none",
    }],
  });
  const raw =
    `StayseeAI:1990.00:123:${checkout.fields.Receipt}:not-returned-secret:Shp_mode=test:Shp_shop=StayseeAI`;
  assert.equal(
    checkout.fields.SignatureValue,
    createHash("sha256").update(raw).digest("hex"),
  );
  assert.equal(JSON.stringify(checkout).includes("not-returned-secret"), false);
  const wire = new URLSearchParams(checkout.fields);
  assert.equal(wire.get("Receipt"), checkout.fields.Receipt);
});

test("unsafe invoice IDs and missing/same-value placeholders fail closed", async () => {
  for (
    const invoiceId of ["0", "-1", "1.0", "001", "9007199254740992", "a", "1:2"]
  ) {
    await assert.rejects(
      buildTestCheckout({
        merchantLogin: "StayseeAI",
        password1: "test-secret",
        invoiceId,
        product: getPaymentProduct("basic"),
      }),
      /invalid_invoice/,
    );
  }
  await assert.rejects(
    buildTestCheckout({
      merchantLogin: "",
      password1: "",
      invoiceId: "1",
      product: getPaymentProduct("basic"),
    }),
    /invalid_config/,
  );
});

test("callback verifies original six-decimal amount and case-insensitive hex digest", async () => {
  const p = result();
  p.set("SignatureValue", p.get("SignatureValue")!.toUpperCase());
  assert.equal(
    await verifyTestResult({
      merchantLogin: "StayseeAI",
      password2: "test-password-2",
      order,
      params: p,
    }),
    true,
  );
  assert.equal(
    await verifyTestResult({
      merchantLogin: "StayseeAI",
      password2: "wrong",
      order,
      params: p,
    }),
    false,
  );
});

test("a valid signature cannot disguise underpayment, wrong order, shop or mode", async () => {
  for (
    const p of [
      result("1.00"),
      result("1991.00"),
      result("1990.000001"),
      result("1990.00", { InvId: "124" }),
      result("1990.00", { Shp_shop: "other" }),
      result("1990.00", { Shp_mode: "live" }),
    ]
  ) {
    assert.equal(
      await verifyTestResult({
        merchantLogin: "StayseeAI",
        password2: "test-password-2",
        order,
        params: p,
      }),
      false,
    );
  }
  assert.equal(
    await verifyTestResult({
      merchantLogin: "another",
      password2: "test-password-2",
      order,
      params: result(),
    }),
    false,
  );
  assert.equal(
    await verifyTestResult({
      merchantLogin: "StayseeAI",
      password2: "test-password-2",
      order: { ...order, mode: "live" } as never,
      params: result(),
    }),
    false,
  );
});

test("duplicate parameters and unsigned custom parameters are rejected, harmless provider metadata allowed", async () => {
  for (
    const name of ["OutSum", "InvId", "SignatureValue", "Shp_mode", "Shp_shop"]
  ) {
    const p = result();
    p.append(name, p.get(name)!);
    assert.equal(
      await verifyTestResult({
        merchantLogin: "StayseeAI",
        password2: "test-password-2",
        order,
        params: p,
      }),
      false,
    );
  }
  const custom = result();
  custom.set("Shp_extra", "attack");
  assert.equal(
    await verifyTestResult({
      merchantLogin: "StayseeAI",
      password2: "test-password-2",
      order,
      params: custom,
    }),
    false,
  );
  const metadata = result();
  metadata.set("Fee", "2.00");
  metadata.set("EMail", "test@example.invalid");
  assert.equal(
    await verifyTestResult({
      merchantLogin: "StayseeAI",
      password2: "test-password-2",
      order,
      params: metadata,
    }),
    true,
  );
});
