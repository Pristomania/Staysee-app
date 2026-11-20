export type LiveResultConfig = {
  enabled: boolean;
  merchantLogin: string;
  password2: string;
  testPasswords?: readonly string[];
};
export type LiveOrder = {
  id: string;
  invoiceId: string;
  merchantLogin: string;
  mode: "live";
  amountKopecks: number;
  status: "pending" | "applied" | "paid_unfulfilled";
};
export type LiveConfirmation = {
  status: "applied" | "paid_unfulfilled";
  duplicate: boolean;
  reason: string | null;
};
export type LiveResultStore = {
  get(invoiceId: string, signal: AbortSignal): Promise<LiveOrder | null>;
  confirm(
    order: LiveOrder,
    amountKopecks: number,
    signal: AbortSignal,
  ): Promise<LiveConfirmation>;
};
export type UnfulfilledEvent = {
  event: "robokassa_live_paid_unfulfilled";
  invoiceId: string;
  reason: string;
  duplicate: boolean;
};
import { isInvoiceId, parseRublesToKopecks } from "./robokassaTestProtocol.ts";

export function validLiveResultConfig(config: LiveResultConfig): boolean {
  return config.enabled === true &&
    /^[A-Za-z0-9_-]{1,100}$/.test(config.merchantLogin) &&
    typeof config.password2 === "string" &&
    config.password2.trim().length > 0 &&
    config.password2.length <= 256 &&
    !/[\r\n:]/.test(config.password2) &&
    !(config.testPasswords ?? []).includes(config.password2);
}
class InvalidCallback extends Error {
  constructor(readonly status = 400) {
    super("invalid_callback");
  }
}
const response = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
const protectedNames = [
  "outsum",
  "invid",
  "signaturevalue",
  "istest",
  "merchantlogin",
];

async function readForm(
  request: Request,
  signal: AbortSignal,
): Promise<URLSearchParams> {
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidCallback();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 8192) {
        cancel();
        throw new InvalidCallback(413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidCallback();
  }
  const pairs = text.split("&");
  if (!text || pairs.length > 24) throw new InvalidCallback();
  const params = new URLSearchParams();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new InvalidCallback();
    try {
      const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, " "));
      const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      if (!key || params.has(key)) throw new InvalidCallback();
      params.append(key, value);
    } catch {
      throw new InvalidCallback();
    }
  }
  return params;
}
async function checkedEnvelope(
  params: URLSearchParams,
  config: LiveResultConfig,
) {
  for (
    const key of ["OutSum", "InvId", "SignatureValue", "Shp_mode", "Shp_shop"]
  ) {
    if (params.getAll(key).length !== 1) throw new InvalidCallback();
  }
  for (const key of params.keys()) {
    const lower = key.toLowerCase();
    if (lower.startsWith("shp_") && key !== "Shp_mode" && key !== "Shp_shop") {
      throw new InvalidCallback();
    }
    if (
      protectedNames.includes(lower) &&
      !["OutSum", "InvId", "SignatureValue", "IsTest", "MerchantLogin"]
        .includes(key)
    ) throw new InvalidCallback();
  }
  const invoiceId = params.get("InvId")!;
  if (
    !isInvoiceId(invoiceId) || params.get("Shp_mode") !== "live" ||
    params.get("Shp_shop") !== config.merchantLogin ||
    (params.has("IsTest") && params.get("IsTest") !== "0") ||
    (params.has("MerchantLogin") &&
      params.get("MerchantLogin") !== config.merchantLogin)
  ) throw new InvalidCallback();
  let amountKopecks: number;
  try {
    amountKopecks = parseRublesToKopecks(params.get("OutSum")!);
  } catch {
    throw new InvalidCallback();
  }
  const actual = params.get("SignatureValue")!;
  if (!/^[a-fA-F0-9]{64}$/.test(actual)) throw new InvalidCallback();
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${
          params.get("OutSum")
        }:${invoiceId}:${config.password2}:Shp_mode=live:Shp_shop=${config.merchantLogin}`,
      ),
    ),
  );
  const expected = Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
    .join("");
  let difference = 0;
  const normalized = actual.toLowerCase();
  for (let i = 0; i < 64; i++) {
    difference |= normalized.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (difference !== 0) throw new InvalidCallback();
  return { invoiceId, amountKopecks };
}

export function createRobokassaLiveResult(
  input: {
    config: LiveResultConfig;
    store: LiveResultStore;
    timeoutMs?: number;
    report?: (event: UnfulfilledEvent) => void | Promise<void>;
  },
): (request: Request) => Promise<Response> {
  const config = {
    ...input.config,
    testPasswords: [...(input.config.testPasswords ?? [])],
  };
  const configured = validLiveResultConfig(config);
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 10000, 10000));
  return async (request) => {
    if (!configured) return response(503, "payments_disabled");
    if (request.method !== "POST") return response(405, "method_not_allowed");
    if (new URL(request.url).search) return response(400, "invalid_callback");
    if (
      !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i
        .test(request.headers.get("content-type") ?? "")
    ) return response(415, "unsupported_media_type");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      abortListener = () => {
        controller.abort();
        reject(new Error("callback_aborted"));
      };
      request.signal.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(abortListener, timeoutMs);
      if (request.signal.aborted) abortListener();
    });
    const work = async () => {
      const params = await readForm(request, controller.signal);
      const checked = await checkedEnvelope(params, config);
      controller.signal.throwIfAborted();
      const order = await input.store.get(checked.invoiceId, controller.signal);
      controller.signal.throwIfAborted();
      if (
        !order || order.mode !== "live" ||
        order.merchantLogin !== config.merchantLogin ||
        order.invoiceId !== checked.invoiceId ||
        order.amountKopecks !== checked.amountKopecks
      ) throw new InvalidCallback();
      const result = await input.store.confirm(
        order,
        checked.amountKopecks,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (
        !result || !["applied", "paid_unfulfilled"].includes(result.status) ||
        typeof result.duplicate !== "boolean" ||
        (result.status === "applied" && result.reason !== null) ||
        (result.status === "paid_unfulfilled" &&
          !["account_inactive", "active_plan", "manual_access"].includes(
            result.reason ?? "",
          ))
      ) throw new Error("invalid_confirmation");
      if (result.status === "paid_unfulfilled") {
        try {
          void Promise.resolve(
            input.report?.({
              event: "robokassa_live_paid_unfulfilled",
              invoiceId: checked.invoiceId,
              reason: result.reason!,
              duplicate: result.duplicate,
            }),
          ).catch(() => {});
        } catch { /* Already committed money must still be acknowledged. */ }
      }
      return response(200, `OK${checked.invoiceId}`);
    };
    try {
      return await Promise.race([deadline, work()]);
    } catch (error) {
      return error instanceof InvalidCallback
        ? response(error.status, "invalid_callback")
        : response(503, "temporarily_unavailable");
    } finally {
      clearTimeout(timer);
      if (abortListener) {
        request.signal.removeEventListener("abort", abortListener);
      }
    }
  };
}
