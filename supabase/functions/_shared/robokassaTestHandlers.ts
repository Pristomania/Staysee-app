import {
  buildTestCheckout,
  getPaymentProduct,
  isInvoiceId,
  type PaymentProductId,
  type TestPaymentOrder,
  validTestCredentials,
  verifyTestEnvelope,
  verifyTestResult,
} from "./robokassaTestProtocol.ts";

export type StoredTestOrder = TestPaymentOrder & {
  userId: string | null;
  productId: PaymentProductId;
  status: "pending" | "test_paid" | "expired";
  productName: string;
  receiptJson: string;
};
export interface PaymentStore {
  create(
    input: {
      userId: string;
      productId: PaymentProductId;
      idempotencyKey: string;
    },
  ): Promise<StoredTestOrder>;
  get(invoiceId: string): Promise<StoredTestOrder | null>;
  /** Atomic database transition. Test ledger ONLY; never a grant of any paid access. */
  settle(
    invoiceId: string,
    amountKopecks: number,
  ): Promise<{ status: "test_paid" }>;
}
export interface TestPaymentConfig {
  mode: string;
  merchantLogin: string;
  password1: string;
  password2: string;
  allowedUserIds: readonly string[];
  allowedOrigins: readonly string[];
}
export class PaymentStoreConflict extends Error {}
export class PaymentStoreRateLimit extends Error {}
export class PaymentMonthlyOrderPending extends Error {}

function available(config: TestPaymentConfig): boolean {
  return config.mode === "test" &&
    validTestCredentials(
      config.merchantLogin,
      config.password1,
      config.password2,
    ) &&
    config.allowedUserIds.length > 0 && config.allowedOrigins.length > 0;
}

class InputError extends Error {
  status: number;
  constructor(status: number) {
    super("invalid_request");
    this.status = status;
  }
}
async function boundedBody(req: Request): Promise<string> {
  const length = req.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 4096)) {
    throw new InputError(413);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new InputError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new InputError(413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400);
  } finally {
    reader.releaseLock();
  }
}

export function createRobokassaTestHandlers(deps: {
  config: TestPaymentConfig;
  store: PaymentStore;
  authenticate: (
    req: Request,
  ) => Promise<{ id: string; active: boolean } | null>;
}) {
  const { config, store } = deps;
  function response(
    req: Request,
    status: number,
    body: unknown,
    callback = false,
  ): Response {
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-type": callback
        ? "text/plain; charset=utf-8"
        : "application/json; charset=utf-8",
    });
    const origin = req.headers.get("origin");
    if (!callback && origin && config.allowedOrigins.includes(origin)) {
      headers.set("access-control-allow-origin", origin);
      headers.set("vary", "Origin");
      headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
      headers.set(
        "access-control-allow-headers",
        "authorization, apikey, content-type, x-client-info",
      );
    }
    return new Response(callback ? String(body) : JSON.stringify(body), {
      status,
      headers,
    });
  }
  async function browserUser(req: Request): Promise<{ id: string } | Response> {
    const origin = req.headers.get("origin");
    if (origin && !config.allowedOrigins.includes(origin)) {
      return response(req, 403, { error: "origin_not_allowed" });
    }
    const user = await deps.authenticate(req);
    if (!user) return response(req, 401, { error: "authentication_required" });
    if (!user.active || !config.allowedUserIds.includes(user.id)) {
      return response(req, 403, { error: "test_account_required" });
    }
    return user;
  }
  function failed(req: Request, error: unknown, callback = false): Response {
    if (error instanceof InputError) {
      return response(
        req,
        error.status,
        callback ? "invalid_notice" : { error: "invalid_request" },
        callback,
      );
    }
    if (!callback && error instanceof PaymentStoreConflict) {
      return response(req, 409, { error: "idempotency_conflict" });
    }
    if (!callback && error instanceof PaymentStoreRateLimit) {
      return response(req, 429, { error: "too_many_orders" });
    }
    if (!callback && error instanceof PaymentMonthlyOrderPending) {
      return response(req, 409, { error: "monthly_order_pending" });
    }
    return response(
      req,
      503,
      callback
        ? "temporarily_unavailable"
        : { error: "temporarily_unavailable" },
      callback,
    );
  }
  function preflight(req: Request): Response | null {
    if (req.method !== "OPTIONS") return null;
    if (
      !req.headers.get("origin") ||
      !config.allowedOrigins.includes(req.headers.get("origin")!)
    ) return response(req, 403, { error: "origin_not_allowed" });
    const r = response(req, 200, {});
    return new Response(null, { status: 204, headers: r.headers });
  }
  return {
    async create(req: Request): Promise<Response> {
      if (!available(config)) {
        return response(req, 503, { error: "payments_disabled" });
      }
      const options = preflight(req);
      if (options) return options;
      if (req.method !== "POST") {
        return response(req, 405, { error: "method_not_allowed" });
      }
      try {
        const user = await browserUser(req);
        if (user instanceof Response) return user;
        if (
          req.headers.get("content-type")?.split(";")[0].trim() !==
            "application/json"
        ) return response(req, 415, { error: "unsupported_content_type" });
        // Only two flat string fields are accepted. Explicit parsing rejects duplicate keys/escaped aliases.
        const raw = await boundedBody(req);
        const pairs =
          // eslint-disable-next-line no-control-regex -- control characters inside the strings are rejected on purpose (strict JSON)
          /^\s*\{\s*"(productId|idempotencyKey)"\s*:\s*"([^"\\\x00-\x1f]*)"\s*,\s*"(productId|idempotencyKey)"\s*:\s*"([^"\\\x00-\x1f]*)"\s*\}\s*$/
            .exec(raw);
        if (!pairs || pairs[1] === pairs[3]) throw new InputError(400);
        const fields: Record<string, unknown> = {
          [pairs[1]]: pairs[2],
          [pairs[3]]: pairs[4],
        };
        if (
          Object.keys(fields).some((k) =>
            k !== "productId" && k !== "idempotencyKey"
          ) || typeof fields.idempotencyKey !== "string" ||
          !(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/)
            .test(fields.idempotencyKey)
        ) throw new InputError(400);
        let product;
        try {
          product = getPaymentProduct(fields.productId);
        } catch {
          throw new InputError(400);
        }
        const order = await store.create({
          userId: user.id,
          productId: product.id,
          idempotencyKey: fields.idempotencyKey,
        });
        if (
          order.userId !== user.id || order.mode !== "test" ||
          order.merchantLogin !== config.merchantLogin ||
          order.productId !== product.id
        ) throw new Error("order_mismatch");
        if (order.status !== "pending") {
          return response(req, 200, {
            invoiceId: order.invoiceId,
            status: order.status,
            mode: "test",
            grantsAccess: false,
          });
        }
        const checkout = await buildTestCheckout({
          merchantLogin: config.merchantLogin,
          password1: config.password1,
          invoiceId: order.invoiceId,
          product: {
            id: order.productId,
            amountKopecks: order.amountKopecks,
            name: order.productName,
          },
          receiptJson: order.receiptJson,
        });
        return response(req, 200, {
          invoiceId: order.invoiceId,
          mode: "test",
          grantsAccess: false,
          checkout,
        });
      } catch (error) {
        return failed(req, error);
      }
    },
    async status(req: Request): Promise<Response> {
      if (!available(config)) {
        return response(req, 503, { error: "payments_disabled" });
      }
      const options = preflight(req);
      if (options) return options;
      if (req.method !== "GET") {
        return response(req, 405, { error: "method_not_allowed" });
      }
      try {
        const user = await browserUser(req);
        if (user instanceof Response) return user;
        const p = new URL(req.url).searchParams;
        if (p.has("capabilities")) {
          if (Array.from(p).length !== 1 || p.get("capabilities") !== "1") {
            throw new InputError(400);
          }
          return response(req, 200, {
            mode: "test",
            allowed: true,
            grantsAccess: false,
          });
        }
        const id = p.get("invoiceId");
        if (p.getAll("invoiceId").length !== 1 || !isInvoiceId(id)) {
          throw new InputError(400);
        }
        const order = await store.get(id);
        if (
          !order || order.userId !== user.id || order.mode !== "test" ||
          order.merchantLogin !== config.merchantLogin
        ) return response(req, 404, { error: "order_not_found" });
        return response(req, 200, {
          invoiceId: id,
          status: order.status,
          mode: "test",
          grantsAccess: false,
        });
      } catch (error) {
        return failed(req, error);
      }
    },
    async result(req: Request): Promise<Response> {
      if (!available(config)) {
        return response(req, 503, "payments_disabled", true);
      }
      if (req.method !== "POST") {
        return response(req, 405, "method_not_allowed", true);
      }
      try {
        if (new URL(req.url).search) throw new InputError(400);
        if (
          req.headers.get("content-type")?.split(";")[0].trim() !==
            "application/x-www-form-urlencoded"
        ) return response(req, 415, "unsupported_content_type", true);
        const raw = await boundedBody(req);
        try {
          decodeURIComponent(raw.replace(/\+/g, " "));
        } catch {
          throw new InputError(400);
        }
        const params = new URLSearchParams(raw);
        if (Array.from(params).length > 24) throw new InputError(400);
        if (
          !(await verifyTestEnvelope({
            merchantLogin: config.merchantLogin,
            password2: config.password2,
            params,
          }))
        ) throw new InputError(400);
        const id = params.get("InvId");
        if (!isInvoiceId(id)) throw new InputError(400);
        const order = await store.get(id);
        if (
          !order ||
          !(await verifyTestResult({
            merchantLogin: config.merchantLogin,
            password2: config.password2,
            order,
            params,
          }))
        ) throw new InputError(400);
        const settled = await store.settle(id, order.amountKopecks);
        if (settled.status !== "test_paid") {
          throw new Error("settlement_not_committed");
        }
        return response(req, 200, `OK${id}`, true);
      } catch (error) {
        return failed(req, error, true);
      }
    },
  };
}
