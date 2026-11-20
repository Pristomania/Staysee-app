/** Test payments only. No provider credentials, entitlement changes or trusted return flags. */
export type TestProduct = "basic" | "premium" | "pack100";
export type TestCheckout = {
  action: string;
  method: "POST";
  fields: Record<string, string>;
};
export type TestStatus = {
  invoiceId: string;
  mode: "test";
  grantsAccess: false;
  status: "pending" | "test_paid" | "expired";
};
export type TestCreated = Omit<TestStatus, "status"> & {
  checkout?: TestCheckout;
  status?: TestStatus["status"];
};
export interface PaymentTestApi {
  capabilities(): Promise<void>;
  create(productId: TestProduct, idempotencyKey: string): Promise<TestCreated>;
  status(invoiceId: string): Promise<TestStatus>;
}
type SavedAttempt = {
  productId: TestProduct;
  idempotencyKey: string;
  invoiceId?: string;
};
export type PaymentTestStorage = Pick<Storage, "getItem" | "setItem">;
export type PaymentTestState = {
  phase:
    | "loading"
    | "unavailable"
    | "ready"
    | "creating"
    | "pending"
    | "test_paid"
    | "expired"
    | "error";
  attempt?: SavedAttempt;
  checkout?: TestCheckout;
  error?: string;
};
const endpoint = "https://auth.robokassa.ru/Merchant/Index.aspx";
const invoice = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9]\d{0,15}$/.test(v) &&
  BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const product = (v: unknown): v is TestProduct =>
  v === "basic" || v === "premium" || v === "pack100";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const bad = (): never => {
  throw Error("invalid_response");
};

type TestSession = { userId: string; token: string } | null;
export async function authorizeTestCheckout(
  userId: string,
  raw: TestCheckout,
  session: () => Promise<TestSession>,
  signal: AbortSignal,
  timeoutMs = 15000,
): Promise<TestCheckout> {
  const checkout = validateCheckout(raw);
  if (signal.aborted) throw Error("cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  try {
    const current = await Promise.race([
      session(),
      new Promise<never>((_, reject) => {
        cancel = () => reject(Error("cancelled"));
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => reject(Error("network")), timeoutMs);
      }),
    ]);
    if (signal.aborted) throw Error("cancelled");
    if (!current || current.userId !== userId) throw Error("session_changed");
    return checkout;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

export function validateCheckout(raw: unknown): TestCheckout {
  if (
    !record(raw) || raw.action !== endpoint || raw.method !== "POST" ||
    !record(raw.fields)
  ) return bad();
  const f = raw.fields;
  const fields = [
    "MerchantLogin",
    "OutSum",
    "InvId",
    "Receipt",
    "IsTest",
    "Culture",
    "Encoding",
    "Shp_mode",
    "Shp_shop",
    "SignatureValue",
  ];
  if (
    Object.keys(f).length !== fields.length ||
    fields.some((k) =>
      typeof f[k] !== "string" || (f[k] as string).length > 16000
    )
  ) return bad();
  if (
    f.IsTest !== "1" || f.Culture !== "ru" || f.Encoding !== "utf-8" ||
    f.Shp_mode !== "test" || f.Shp_shop !== f.MerchantLogin ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(f.MerchantLogin as string) ||
    !invoice(f.InvId) ||
    !/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(f.OutSum as string) ||
    !/^[a-f0-9]{64}$/i.test(f.SignatureValue as string)
  ) return bad();
  const amount = Number(f.OutSum);
  if (amount <= 0 || amount > 10_000_000) return bad();
  try {
    const text = decodeURIComponent(f.Receipt as string);
    if (text.length > 2048) return bad();
    const receipt: unknown = JSON.parse(text);
    if (
      !record(receipt) || Object.keys(receipt).length !== 2 ||
      receipt.sno !== "usn_income" || !Array.isArray(receipt.items) ||
      receipt.items.length !== 1
    ) return bad();
    const item: unknown = receipt.items[0];
    if (
      !record(item) || Object.keys(item).length !== 6 ||
      typeof item.name !== "string" || !item.name.length ||
      item.name.length > 160 || item.quantity !== 1 || item.sum !== amount ||
      item.payment_method !== "full_prepayment" ||
      item.payment_object !== "service" || item.tax !== "none"
    ) return bad();
  } catch {
    return bad();
  }
  // Copy only allowlisted data; never preserve arbitrary response properties.
  return {
    action: endpoint,
    method: "POST",
    fields: Object.fromEntries(fields.map((k) => [k, f[k] as string])),
  };
}
function validated(raw: unknown, expectedId?: string): TestCreated {
  if (
    !record(raw) || raw.mode !== "test" || raw.grantsAccess !== false ||
    !invoice(raw.invoiceId) || (expectedId && raw.invoiceId !== expectedId)
  ) return bad();
  if (raw.checkout !== undefined) {
    if (raw.status !== undefined || Object.keys(raw).length !== 4) return bad();
    const checkout = validateCheckout(raw.checkout);
    if (checkout.fields.InvId !== raw.invoiceId) return bad();
    return {
      invoiceId: raw.invoiceId,
      mode: "test",
      grantsAccess: false,
      checkout,
    };
  }
  if (
    Object.keys(raw).length !== 4 ||
    raw.status !== "pending" && raw.status !== "test_paid" &&
      raw.status !== "expired"
  ) return bad();
  return {
    invoiceId: raw.invoiceId,
    mode: "test",
    grantsAccess: false,
    status: raw.status,
  };
}

export function createPaymentTestApi(options: {
  baseUrl: string;
  anonKey: string;
  userId: string;
  session: () => Promise<{ userId: string; token: string } | null>;
  fetcher?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
}): PaymentTestApi {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(base.hostname))
  ) throw Error("invalid_api_url");
  if (base.username || base.password || base.search || base.hash) {
    throw Error("invalid_api_url");
  }
  const request = async (route: string, body?: unknown): Promise<unknown> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async () => {
      const session = await options.session();
      if (abort.signal.aborted) throw Error("network");
      if (!session || session.userId !== options.userId) {
        throw Error("session_changed");
      }
      const res = await (options.fetcher ?? fetch)(
        new Request(
          `${
            base.href.replace(/\/$/, "")
          }/functions/v1/robokassa-test-${route}`,
          {
            method: body === undefined ? "GET" : "POST",
            signal: abort.signal,
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            headers: {
              Authorization: `Bearer ${session.token}`,
              apikey: options.anonKey,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        ),
      );
      if ([401, 403, 503].includes(res.status)) throw Error("unavailable");
      if (route === "create" && [409, 429].includes(res.status)) {
        const failure: unknown = await res.json();
        if (
          record(failure) && Object.keys(failure).length === 1 &&
          ((res.status === 409 && failure.error === "monthly_order_pending") ||
            (res.status === 429 && failure.error === "too_many_orders"))
        ) {
          throw new NoTestOrderCreated(failure.error as string);
        }
      }
      if (!res.ok) throw Error("request_failed");
      return res.json();
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(Error("network"));
          }, options.timeoutMs ?? 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  };
  return {
    async capabilities() {
      const raw = await request("status?capabilities=1");
      if (
        !record(raw) || raw.mode !== "test" || raw.allowed !== true ||
        raw.grantsAccess !== false
      ) bad();
    },
    async create(productId, idempotencyKey) {
      if (!product(productId) || !uuid(idempotencyKey)) {
        throw Error("invalid_attempt");
      }
      const result = validated(
        await request("create", { productId, idempotencyKey }),
      );
      if (result.status === "pending") return bad();
      return result;
    },
    async status(invoiceId) {
      if (!invoice(invoiceId)) throw Error("invalid_attempt");
      const result = validated(
        await request(`status?invoiceId=${invoiceId}`),
        invoiceId,
      );
      if (!result.status || result.checkout) return bad();
      return result as TestStatus;
    },
  };
}

class NoTestOrderCreated extends Error {}

function savedAttempt(
  userId: string,
  storage: PaymentTestStorage,
): SavedAttempt | undefined {
  const text = storage.getItem(`staysee:payment-test:${userId}`);
  if (text === null) return undefined;
  const raw: unknown = JSON.parse(text);
  if (raw === null) return undefined;
  if (
    !record(raw) || !product(raw.productId) || !uuid(raw.idempotencyKey) ||
    (raw.invoiceId !== undefined && !invoice(raw.invoiceId))
  ) throw Error("storage");
  return {
    productId: raw.productId,
    idempotencyKey: raw.idempotencyKey,
    ...(raw.invoiceId ? { invoiceId: raw.invoiceId } : {}),
  };
}
export function shouldResumePayment(
  search: string,
  userId: string,
  recovery: boolean,
  storage: PaymentTestStorage,
): boolean {
  const q = new URLSearchParams(search);
  if (recovery) return false;
  try {
    const attempt = savedAttempt(userId, storage);
    if (!attempt) return false;
    const providerFields = ["IsTest", "InvId", "Shp_mode", "Shp_shop"];
    if (!providerFields.some((name) => q.has(name))) {
      return q.getAll("payment_test_return").length === 1 &&
        q.get("payment_test_return") === "1";
    }
    // GET return URLs cannot contain merchant-defined query parameters.
    // This only resumes an owned saved attempt; the server verifies payment.
    return providerFields.every(
      (name) => q.getAll(name).length === 1,
    ) && q.get("IsTest") === "1" && q.get("Shp_mode") === "test" &&
      q.get("Shp_shop") === "StayseeAI" && !!attempt.invoiceId &&
      q.get("InvId") === attempt.invoiceId;
  } catch {
    return false;
  }
}

export class PaymentTestController {
  state: PaymentTestState = { phase: "loading" };
  private disposed = false;
  private busy = false;
  private allowed = false;
  private listeners = new Set<(state: PaymentTestState) => void>();
  constructor(
    private userId: string,
    private api: PaymentTestApi,
    private storage: PaymentTestStorage,
    private newKey: () => string,
  ) {}
  subscribe(listener: (state: PaymentTestState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
  private update(next: PaymentTestState) {
    if (!this.disposed) {
      this.state = next;
      this.listeners.forEach((listener) => listener(next));
    }
  }
  private save(attempt: SavedAttempt) {
    this.storage.setItem(
      `staysee:payment-test:${this.userId}`,
      JSON.stringify(attempt),
    );
  }
  async init() {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      await this.api.capabilities();
      if (this.disposed) return;
      this.allowed = true;
      const attempt = savedAttempt(this.userId, this.storage);
      this.update(
        attempt
          ? { phase: attempt.invoiceId ? "pending" : "error", attempt }
          : { phase: "ready" },
      );
    } catch {
      this.update({ phase: "unavailable" });
    } finally {
      this.busy = false;
    }
    if (this.state.attempt?.invoiceId) await this.check();
  }
  async start(productId: TestProduct) {
    if (
      !this.allowed || this.busy || this.disposed ||
      !["ready", "test_paid", "expired"].includes(this.state.phase)
    ) return;
    try {
      const attempt = { productId, idempotencyKey: this.newKey() };
      if (!product(productId) || !uuid(attempt.idempotencyKey)) {
        throw Error("invalid_attempt");
      }
      this.save(attempt);
      this.update({ phase: "creating", attempt });
    } catch {
      this.update({ ...this.state, phase: "error", error: "storage" });
      return;
    }
    await this.retry();
  }
  async retry() {
    if (!this.allowed || this.disposed || this.busy || !this.state.attempt) {
      return;
    }
    const attempt = this.state.attempt;
    const previous = this.state;
    this.busy = true;
    this.update({ phase: "creating", attempt });
    try {
      const result = await this.api.create(
        attempt.productId,
        attempt.idempotencyKey,
      );
      if (this.disposed) return;
      if (attempt.invoiceId && result.invoiceId !== attempt.invoiceId) {
        throw Error("invalid_response");
      }
      const next = { ...attempt, invoiceId: result.invoiceId };
      this.save(next);
      this.update({
        phase: result.status ?? "pending",
        attempt: next,
        checkout: result.checkout,
      });
    } catch (error) {
      if (error instanceof NoTestOrderCreated && !attempt.invoiceId) {
        try {
          this.storage.setItem(`staysee:payment-test:${this.userId}`, "null");
          this.update({ phase: "ready", error: error.message });
        } catch {
          this.update({ phase: "error", attempt, error: "storage" });
        }
      } else {this.update({
          ...previous,
          phase: "error",
          attempt,
          error: "request",
        });}
    } finally {
      this.busy = false;
    }
  }
  async check() {
    if (
      !this.allowed || this.disposed || this.busy ||
      !this.state.attempt?.invoiceId
    ) return;
    const previous = this.state;
    const attempt = previous.attempt!;
    this.busy = true;
    try {
      const status = await this.api.status(attempt.invoiceId!);
      this.update({
        phase: status.status,
        attempt,
        ...(status.status === "pending" ? { checkout: previous.checkout } : {}),
      });
    } catch {
      this.update({ ...previous, phase: "error", attempt, error: "request" });
    } finally {
      this.busy = false;
    }
  }
}
