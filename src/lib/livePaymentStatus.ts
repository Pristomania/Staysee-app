import { type BillingSnapshot, parseBillingSnapshot } from "./billingSnapshot";
import { paymentOutcomeCopy } from "./paymentOutcome";
import { parseServerTimestampMicros as stamp } from "./serverTime";

type Product = "basic" | "premium" | "pack100";
type Status = "pending" | "expired" | "applied" | "paid_unfulfilled";
export interface LivePaymentStatus {
  version: 1;
  currentGrant: boolean;
  order: {
    id: string;
    productId: Product;
    purchaseKind: "new_period" | "upgrade";
    amountKopecks: number;
    status: Status;
    expiresAt: string;
    paidAt: string | null;
    appliedAt: string | null;
    paidUntil: string | null;
  };
  billing: BillingSnapshot;
}
type Session = { userId: string; token: string } | null;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const bad = (): never => {
  throw Error("invalid_payment_status");
};
const term = 30n * 86400n * 1000000n;

/** Decodes the self-only RPC, never a provider URL/query or arbitrary checkout response. */
export function parseLivePaymentStatus(
  raw: unknown,
  userId: string,
  orderId: string,
): LivePaymentStatus {
  if (
    !uuid(userId) || !uuid(orderId) || !object(raw) ||
    Object.keys(raw).length !== 4 || raw.version !== 1 ||
    typeof raw.currentGrant !== "boolean" || !object(raw.order)
  ) return bad();
  userId = userId.toLowerCase();
  orderId = orderId.toLowerCase();
  const o = raw.order;
  const keys = [
    "id",
    "productId",
    "purchaseKind",
    "amountKopecks",
    "status",
    "expiresAt",
    "paidAt",
    "appliedAt",
    "paidUntil",
  ];
  if (
    Object.keys(o).length !== keys.length || keys.some((k) => !(k in o)) ||
    !uuid(o.id) || o.id.toLowerCase() !== orderId ||
    !["basic", "premium", "pack100"].includes(o.productId as string) ||
    !["new_period", "upgrade"].includes(o.purchaseKind as string) ||
    (o.purchaseKind === "upgrade" && o.productId !== "premium") ||
    typeof o.amountKopecks !== "number" ||
    !Number.isSafeInteger(o.amountKopecks) || o.amountKopecks <= 0 ||
    o.amountKopecks > 1000000000 ||
    !["pending", "expired", "applied", "paid_unfulfilled"].includes(
      o.status as string,
    )
  ) return bad();
  let billing: BillingSnapshot;
  try {
    if (!object(raw.billing) || !uuid(raw.billing.userId)) return bad();
    billing = parseBillingSnapshot({
      ...raw.billing,
      userId: raw.billing.userId.toLowerCase(),
    }, userId);
  } catch {
    return bad();
  }
  const now = stamp(billing.serverNow)!,
    expires = stamp(o.expiresAt),
    paid = stamp(o.paidAt),
    applied = stamp(o.appliedAt),
    until = stamp(o.paidUntil);
  if (expires === null) return bad();
  if (o.status === "pending" || o.status === "expired") {
    if (
      o.paidAt !== null || o.appliedAt !== null || o.paidUntil !== null ||
      (o.status === "expired") !== (expires <= now)
    ) return bad();
  } else {
    if (paid === null || paid > now) return bad();
    if (o.status === "paid_unfulfilled") {
      if (o.appliedAt !== null || o.paidUntil !== null) return bad();
    } else {
      if (applied === null || applied !== paid) return bad();
      if (
        o.productId === "pack100"
          ? o.paidUntil !== null
          : until === null || until !== applied + term
      ) return bad();
    }
  }
  const u = billing.usage;
  const matches = o.status === "applied" && o.productId !== "pack100" &&
    u.access_source === "purchase" && !u.unlimited_usage &&
    u.tier === o.productId && stamp(u.period_started_at) === applied &&
    stamp(u.paid_access_until) === until && until !== null && until > now;
  if (raw.currentGrant !== matches) return bad();
  return {
    version: 1,
    currentGrant: matches,
    order: {
      id: orderId,
      productId: o.productId as Product,
      purchaseKind: o.purchaseKind as "new_period" | "upgrade",
      amountKopecks: o.amountKopecks,
      status: o.status as Status,
      expiresAt: o.expiresAt as string,
      paidAt: o.paidAt as string | null,
      appliedAt: o.appliedAt as string | null,
      paidUntil: o.paidUntil as string | null,
    },
    billing,
  };
}

export function paymentStatusCopy(
  result: LivePaymentStatus,
): {
  kind: "active" | "historical" | "pending" | "expired" | "paid_unfulfilled";
  title: string;
  body: string;
  benefits: string[];
  dateLine?: string;
} {
  const o = result.order;
  if (o.status === "pending") {
    return {
      kind: "pending",
      title: "Проверяем оплату",
      body:
        "Подтверждение оплаты пока не получено. Если деньги списаны, повторно платить не нужно — проверьте статус позже.",
      benefits: [],
    };
  }
  if (o.status === "expired") {
    return {
      kind: "expired",
      title: "Срок заказа истёк",
      body:
        "Подтверждение оплаты пока не получено. Если деньги списаны, не платите повторно: позднее подтверждение ещё может поступить.",
      benefits: [],
    };
  }
  if (o.status === "paid_unfulfilled") {
    return {
      kind: "paid_unfulfilled",
      title: "Оплата получена — нужна проверка",
      body:
        "Оплата учтена, но покупку не удалось применить. Повторно платить не нужно. Обратитесь в поддержку с номером заказа.",
      benefits: [],
    };
  }
  if (result.currentGrant && o.productId !== "pack100") {
    return {
      kind: "active",
      ...paymentOutcomeCopy({
        mode: "live",
        status: "applied",
        productId: o.productId,
        paidUntil: o.paidUntil!,
        verifiedAt: result.billing.serverNow,
      }),
    };
  }
  return {
    kind: "historical",
    title: "Этот платёж обработан",
    body: o.productId === "pack100"
      ? "Пакет сообщений был добавлен. Актуальный остаток и срок сообщений смотрите в кабинете."
      : "Это запись об обработанном платеже, а не новое подключение тарифа. Текущий доступ смотрите в кабинете.",
    benefits: [],
  };
}

export async function readLivePaymentStatus(options: {
  userId: string;
  orderId: string;
  session: () => Promise<Session>;
  read: (
    orderId: string,
    token: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<LivePaymentStatus> {
  if (!uuid(options.userId) || !uuid(options.orderId)) return bad();
  const userId = options.userId.toLowerCase(),
    orderId = options.orderId.toLowerCase();
  if (options.signal.aborted) throw Error("cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const guard = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(Error("cancelled"));
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    const ms = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(10000, options.timeoutMs!))
      : 10000;
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("timeout"));
    }, ms);
  });
  const work = async () => {
    const before = await options.session();
    controller.signal.throwIfAborted();
    if (
      !before || before.userId.toLowerCase() !== userId || !before.token.trim()
    ) {
      throw Error("session_changed");
    }
    const raw = await options.read(
      orderId,
      before.token,
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const after = await options.session();
    controller.signal.throwIfAborted();
    if (
      !after || after.userId.toLowerCase() !== userId ||
      after.token !== before.token
    ) throw Error("session_changed");
    return parseLivePaymentStatus(raw, userId, orderId);
  };
  try {
    return await Promise.race([guard, work()]);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    // Also stop an unread/non-2xx response body; clearing the timer alone would leave it unbounded.
    controller.abort();
  }
}

export function createLivePaymentStatusApi(
  options: {
    baseUrl: string;
    anonKey: string;
    session: () => Promise<Session>;
    fetch?: typeof fetch;
  },
) {
  const endpoint = `${
    options.baseUrl.replace(/\/$/, "")
  }/rest/v1/rpc/get_my_live_payment_status`;
  const fetcher = options.fetch ?? fetch;
  return (userId: string, orderId: string, signal: AbortSignal) =>
    readLivePaymentStatus({
      userId,
      orderId,
      signal,
      session: options.session,
      read: async (id, token, abort) => {
        const response = await fetcher(endpoint, {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          headers: {
            "content-type": "application/json",
            apikey: options.anonKey,
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ p_order_id: id }),
          signal: abort,
        });
        if (!response.ok) {
          throw Error(
            response.status === 401
              ? "session_changed"
              : "payment_status_unavailable",
          );
        }
        const reader = response.body?.getReader();
        if (!reader) throw Error("invalid_payment_status");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        abort.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            abort.throwIfAborted();
            const next = await reader.read();
            abort.throwIfAborted();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 2 * 1024 * 1024) {
              cancel();
              throw Error("invalid_payment_status");
            }
            chunks.push(next.value);
          }
        } finally {
          abort.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown;
      },
    });
}
