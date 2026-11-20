import { createClient } from "npm:@supabase/supabase-js@2.107.0";
import {
  createRobokassaTestHandlers,
  PaymentMonthlyOrderPending,
  type PaymentStore,
  PaymentStoreConflict,
  PaymentStoreRateLimit,
  type StoredTestOrder,
  type TestPaymentConfig,
} from "./robokassaTestHandlers.ts";

/** Deno deployment adapter. Not imported by the frontend; never reads model/provider secrets. */
export function serveRobokassaTestRoute(
  route: "create" | "result" | "status",
): void {
  const config: TestPaymentConfig = {
    mode: Deno.env.get("STAYSEE_PAYMENTS_MODE") ?? "disabled",
    merchantLogin: Deno.env.get("ROBOKASSA_TEST_MERCHANT_LOGIN") ?? "",
    password1: Deno.env.get("ROBOKASSA_TEST_PASSWORD_1") ?? "",
    password2: Deno.env.get("ROBOKASSA_TEST_PASSWORD_2") ?? "",
    allowedUserIds: (Deno.env.get("ROBOKASSA_TEST_USER_IDS") ?? "").split(",")
      .map((s) => s.trim()).filter(Boolean),
    allowedOrigins: (Deno.env.get("ROBOKASSA_TEST_ORIGINS") ?? "").split(",")
      .map((s) => s.trim()).filter(Boolean),
  };
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Fail closed even if only the deployment exists. Do not instantiate an invalid client at cold start.
  if (config.mode !== "test" || !url || !key) {
    Deno.serve(() =>
      new Response("payments_disabled", {
        status: 503,
        headers: { "cache-control": "no-store" },
      })
    );
    return;
  }
  const db = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  function orderFromUnknown(data: unknown): StoredTestOrder {
    if (!data || typeof data !== "object") {
      throw new Error("invalid_order_response");
    }
    const o = data as Record<string, unknown>;
    if (
      typeof o.invoiceId !== "string" || typeof o.amountKopecks !== "number" ||
      !Number.isSafeInteger(o.amountKopecks) ||
      o.mode !== "test" ||
      (o.productId !== "basic" && o.productId !== "premium" &&
        o.productId !== "pack100") ||
      (o.status !== "pending" && o.status !== "test_paid" &&
        o.status !== "expired") ||
      typeof o.merchantLogin !== "string" ||
      typeof o.productName !== "string" || typeof o.receiptJson !== "string" ||
      (o.userId !== null && typeof o.userId !== "string")
    ) throw new Error("invalid_order_response");
    return o as StoredTestOrder;
  }
  const store: PaymentStore = {
    async create(input) {
      const { data, error } = await db.rpc("create_robokassa_test_order", {
        p_user_id: input.userId,
        p_product_id: input.productId,
        p_idempotency_key: input.idempotencyKey,
        p_merchant_login: config.merchantLogin,
      });
      if (error) {
        if (error.message === "idempotency_conflict") {
          throw new PaymentStoreConflict();
        }
        if (error.message === "too_many_orders") {
          throw new PaymentStoreRateLimit();
        }
        if (error.message === "monthly_order_pending") {
          throw new PaymentMonthlyOrderPending();
        }
        throw new Error("order_create_failed");
      }
      return orderFromUnknown(data);
    },
    async get(invoiceId) {
      const { data, error } = await db.from("robokassa_test_orders")
        .select(
          "invoice_id,user_id,merchant_login,mode,product_id,amount_kopecks,status,product_name,receipt_json,expires_at",
        ).eq("invoice_id", invoiceId).maybeSingle();
      if (error) throw new Error("order_read_failed");
      if (!data) return null;
      return orderFromUnknown({
        invoiceId: String(data.invoice_id),
        userId: data.user_id,
        merchantLogin: data.merchant_login,
        mode: data.mode,
        productId: data.product_id,
        amountKopecks: data.amount_kopecks,
        status:
          data.status === "pending" && Date.parse(data.expires_at) <= Date.now()
            ? "expired"
            : data.status,
        productName: data.product_name,
        receiptJson: data.receipt_json,
      });
    },
    async settle(invoiceId, amountKopecks) {
      const { data, error } = await db.rpc("settle_robokassa_test_order", {
        p_invoice_id: invoiceId,
        p_amount_kopecks: amountKopecks,
      });
      if (error || data?.status !== "test_paid") {
        throw new Error("order_settle_failed");
      }
      return { status: "test_paid" };
    },
  };
  const handlers = createRobokassaTestHandlers({
    config,
    store,
    authenticate: async (req) => {
      const match = /^Bearer\s+(\S+)$/i.exec(
        req.headers.get("authorization") ?? "",
      );
      if (!match) return null;
      const { data, error } = await db.auth.getUser(match[1]);
      if (error || !data.user) return null;
      const userId = data.user.id;
      // Skip extra account queries for anyone outside the explicit test allowlist.
      if (!config.allowedUserIds.includes(userId)) {
        return { id: userId, active: false };
      }
      const [profile, usage] = await Promise.all([
        db.from("profiles").select("room_deletion_requested_at").eq(
          "id",
          userId,
        ).maybeSingle(),
        db.from("user_usage_tiers").select("is_suspended").eq("user_id", userId)
          .maybeSingle(),
      ]);
      return {
        id: userId,
        active: !profile.error && !usage.error && !!profile.data &&
          !!usage.data &&
          profile.data.room_deletion_requested_at === null &&
          usage.data.is_suspended === false,
      };
    },
  });
  Deno.serve(handlers[route]);
}
