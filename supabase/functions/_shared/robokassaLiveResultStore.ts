import type {
  LiveConfirmation,
  LiveOrder,
  LiveResultStore,
} from "./robokassaLiveResult.ts";
import { isInvoiceId } from "./robokassaTestProtocol.ts";
type Reply = PromiseLike<{ data: unknown; error: unknown }>;
type Abortable = { abortSignal(signal: AbortSignal): Reply };
export type LiveResultDatabase = {
  from(
    table: string,
  ): {
    select(
      columns: string,
    ): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: string,
        ): { abortSignal(signal: AbortSignal): { maybeSingle(): Reply } };
      };
    };
  };
  rpc(name: string, args: Record<string, string | number>): Abortable;
};
export function createLiveResultStore(db: LiveResultDatabase): LiveResultStore {
  return {
    async get(invoiceId, signal) {
      signal.throwIfAborted();
      const { data, error } = await db.from("billing_live_orders")
        .select("id,invoice_id,mode,merchant_login,amount_kopecks,status")
        .eq("invoice_id", invoiceId).eq("mode", "live").abortSignal(signal)
        .maybeSingle();
      if (error) throw new Error("live_order_read_failed");
      if (data === null) return null;
      if (!data || typeof data !== "object") {
        throw new Error("invalid_live_order");
      }
      const row = data as Record<string, unknown>;
      const invoice = String(row.invoice_id);
      if (
        typeof row.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          row.id,
        ) ||
        !isInvoiceId(invoice) || row.mode !== "live" ||
        typeof row.merchant_login !== "string" ||
        typeof row.amount_kopecks !== "number" ||
        !Number.isSafeInteger(row.amount_kopecks) || row.amount_kopecks <= 0 ||
        !["pending", "applied", "paid_unfulfilled"].includes(String(row.status))
      ) throw new Error("invalid_live_order");
      return {
        id: row.id,
        invoiceId: invoice,
        mode: "live",
        merchantLogin: row.merchant_login,
        amountKopecks: row.amount_kopecks,
        status: row.status,
      } as LiveOrder;
    },
    async confirm(order, amountKopecks, signal) {
      signal.throwIfAborted();
      const { data, error } = await db.rpc("confirm_billing_live_order", {
        p_order_id: order.id,
        p_amount_kopecks: amountKopecks,
      }).abortSignal(signal);
      if (error || !data || typeof data !== "object") {
        throw new Error("live_order_confirm_failed");
      }
      const result = data as Record<string, unknown>;
      if (
        !["applied", "paid_unfulfilled"].includes(String(result.status)) ||
        typeof result.duplicate !== "boolean" ||
        (result.reason !== null && typeof result.reason !== "string")
      ) throw new Error("live_order_confirm_failed");
      return {
        status: result.status,
        duplicate: result.duplicate,
        reason: result.reason,
      } as LiveConfirmation;
    },
  };
}
