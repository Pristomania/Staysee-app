/** Test-only protocol. Nothing here changes an account, calls a model or authorizes live payments. */
import { PACK, PLANS } from "./plans.ts";

export type PaymentProductId = "basic" | "premium" | "pack100";
export type PaymentProduct = Readonly<
  { id: PaymentProductId; amountKopecks: number; name: string }
>;
export type TestPaymentOrder = {
  invoiceId: string;
  merchantLogin: string;
  mode: "test";
  amountKopecks: number;
};

const catalog: Record<PaymentProductId, PaymentProduct> = {
  basic: Object.freeze({
    id: "basic",
    amountKopecks: PLANS.basic.priceRub * 100,
    name: `StaySee AI: ${PLANS.basic.label}, 30 дней`,
  }),
  premium: Object.freeze({
    id: "premium",
    amountKopecks: PLANS.premium.priceRub * 100,
    name: `StaySee AI: ${PLANS.premium.label}, 30 дней`,
  }),
  pack100: Object.freeze({
    id: "pack100",
    amountKopecks: PACK.priceRub * 100,
    name: `StaySee AI: ${PACK.messages} сообщений`,
  }),
};

export function getPaymentProduct(id: unknown): PaymentProduct {
  if (id !== "basic" && id !== "premium" && id !== "pack100") {
    throw new Error("unknown_product");
  }
  return catalog[id];
}

export function parseRublesToKopecks(raw: string): number {
  const match = typeof raw === "string" &&
    /^(0|[1-9]\d{0,12})(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) throw new Error("invalid_amount");
  const decimals = match[2] ?? "";
  if (/[1-9]/.test(decimals.slice(2))) throw new Error("invalid_amount");
  const cents = BigInt(match[1]) * 100n +
    BigInt(decimals.padEnd(2, "0").slice(0, 2));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("invalid_amount");
  }
  return Number(cents);
}

export function isInvoiceId(raw: unknown): raw is string {
  return typeof raw === "string" && /^[1-9]\d{0,15}$/.test(raw) &&
    BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function configValid(merchantLogin: string, password: string): boolean {
  return typeof merchantLogin === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(merchantLogin) &&
    typeof password === "string" && password.length > 0 &&
    password.length <= 256 && !/[\r\n:]/.test(password);
}

export function validTestCredentials(
  merchantLogin: string,
  password1: string,
  password2: string,
): boolean {
  return configValid(merchantLogin, password1) &&
    configValid(merchantLogin, password2) && password1 !== password2;
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function equalDigest(a: string, b: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(a)) return false;
  let different = 0;
  for (let i = 0; i < 64; i++) {
    different |= a.toLowerCase().charCodeAt(i) ^ b.charCodeAt(i);
  }
  return different === 0;
}

export async function buildTestCheckout(input: {
  merchantLogin: string;
  password1: string;
  invoiceId: string;
  product: PaymentProduct;
  receiptJson?: string;
}): Promise<
  { action: string; method: "POST"; fields: Record<string, string> }
> {
  if (!configValid(input.merchantLogin, input.password1)) {
    throw new Error("invalid_config");
  }
  if (!isInvoiceId(input.invoiceId)) throw new Error("invalid_invoice");
  getPaymentProduct(input.product.id); // Known product ID only; stored historical price/name need not equal today's catalog.
  const product = input.product;
  if (
    !Number.isSafeInteger(product.amountKopecks) ||
    product.amountKopecks <= 0 || product.amountKopecks > 1_000_000_000 ||
    typeof product.name !== "string" || product.name.length < 1 ||
    product.name.length > 160
  ) throw new Error("invalid_product_snapshot");
  const amount = (product.amountKopecks / 100).toFixed(2);
  // Technical TEST example only: fiscal treatment/second receipt must be approved before live billing exists.
  const receiptJson = input.receiptJson ??
    JSON.stringify({
      sno: "usn_income",
      items: [{
        name: product.name,
        quantity: 1,
        sum: product.amountKopecks / 100,
        payment_method: "full_prepayment",
        payment_object: "service",
        tax: "none",
      }],
    });
  if (receiptJson.length > 2048) throw new Error("invalid_receipt_snapshot");
  const saved = JSON.parse(receiptJson);
  const item = saved?.items?.[0];
  if (
    !saved || Object.keys(saved).length !== 2 || saved.sno !== "usn_income" ||
    !Array.isArray(saved.items) || saved.items.length !== 1 ||
    !item || Object.keys(item).length !== 6 || item.name !== product.name ||
    item.quantity !== 1 || item.sum !== product.amountKopecks / 100 ||
    item.payment_method !== "full_prepayment" ||
    item.payment_object !== "service" || item.tax !== "none"
  ) throw new Error("invalid_receipt_snapshot");
  const receipt = encodeURIComponent(receiptJson);
  const signature = await sha256(
    `${input.merchantLogin}:${amount}:${input.invoiceId}:${receipt}:${input.password1}:Shp_mode=test:Shp_shop=${input.merchantLogin}`,
  );
  return {
    action: "https://auth.robokassa.ru/Merchant/Index.aspx",
    method: "POST",
    fields: {
      MerchantLogin: input.merchantLogin,
      OutSum: amount,
      InvId: input.invoiceId,
      Receipt: receipt,
      IsTest: "1",
      Culture: "ru",
      Encoding: "utf-8",
      Shp_mode: "test",
      Shp_shop: input.merchantLogin,
      SignatureValue: signature,
    },
  };
}

export async function verifyTestResult(input: {
  merchantLogin: string;
  password2: string;
  order: TestPaymentOrder;
  params: URLSearchParams;
}): Promise<boolean> {
  const { order, params } = input;
  if (
    order.mode !== "test" || order.merchantLogin !== input.merchantLogin ||
    !(await verifyTestEnvelope(input))
  ) return false;
  if (
    !isInvoiceId(params.get("InvId")) ||
    params.get("InvId") !== order.invoiceId ||
    params.get("Shp_mode") !== "test" ||
    params.get("Shp_shop") !== order.merchantLogin
  ) return false;
  const rawAmount = params.get("OutSum")!;
  try {
    if (parseRublesToKopecks(rawAmount) !== order.amountKopecks) return false;
  } catch {
    return false;
  }
  return true;
}

/** Verify the public callback before using its invoice ID for any database lookup. */
export async function verifyTestEnvelope(
  input: { merchantLogin: string; password2: string; params: URLSearchParams },
): Promise<boolean> {
  const { params } = input;
  if (!configValid(input.merchantLogin, input.password2)) return false;
  for (
    const key of ["OutSum", "InvId", "SignatureValue", "Shp_mode", "Shp_shop"]
  ) if (params.getAll(key).length !== 1) return false;
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1) return false;
    if (key.startsWith("Shp_") && key !== "Shp_mode" && key !== "Shp_shop") {
      return false;
    }
  }
  const invoice = params.get("InvId");
  if (
    !isInvoiceId(invoice) || params.get("Shp_mode") !== "test" ||
    params.get("Shp_shop") !== input.merchantLogin
  ) return false;
  try {
    parseRublesToKopecks(params.get("OutSum")!);
  } catch {
    return false;
  }
  const expected = await sha256(
    `${
      params.get("OutSum")
    }:${invoice}:${input.password2}:Shp_mode=test:Shp_shop=${input.merchantLogin}`,
  );
  return equalDigest(params.get("SignatureValue")!, expected);
}
