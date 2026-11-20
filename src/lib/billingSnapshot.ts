import { parseServerTimestamp } from "./serverTime";
import {
  type MessageCounter,
  messageCounter,
  type PackRow,
  type UsageRow,
} from "./messageCounter";
import type { PlanId } from "./plans";

export interface BillingSnapshot {
  version: 1;
  userId: string;
  serverNow: string;
  usage: UsageRow;
  packs: PackRow[];
}
export interface BillingSnapshotState {
  userId: string;
  loaded: boolean;
  checking: boolean;
  error: boolean;
  tier: PlanId;
  row: UsageRow | null;
  counter: MessageCounter | null;
  freeRenewable: boolean;
}
interface Host {
  monotonicNow: () => number;
  wallNow: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647;
const date = (v: unknown) => Number.isFinite(parseServerTimestamp(v));
const nullableDate = (v: unknown) => v === null || date(v);
const fail = (): never => {
  throw Error("invalid_billing_snapshot");
};
export function parseBillingSnapshot(
  raw: unknown,
  userId: string,
): BillingSnapshot {
  if (
    !object(raw) || Object.keys(raw).length !== 5 || raw.version !== 1 ||
    raw.userId !== userId || !date(raw.serverNow) || !object(raw.usage) ||
    !Array.isArray(raw.packs) || raw.packs.length > 5000
  ) return fail();
  const r = raw.usage;
  if (
    Object.keys(r).length !== 9 ||
    !["free", "basic", "premium"].includes(r.tier as string) ||
    !count(r.period_requests_used) || !date(r.period_started_at) ||
    !nullableDate(r.last_request_at) ||
    typeof r.unlimited_usage !== "boolean" ||
    !(r.max_conversations_override === null ||
      count(r.max_conversations_override) &&
        Number(r.max_conversations_override) > 0) ||
    !["manual", "purchase"].includes(r.access_source as string) ||
    !nullableDate(r.paid_access_until) ||
    !nullableDate(r.first_real_purchase_at)
  ) return fail();
  if (
    r.access_source === "purchase" &&
    (r.paid_access_until === null || r.first_real_purchase_at === null)
  ) return fail();
  if (r.access_source === "manual" && r.paid_access_until !== null) {
    return fail();
  }
  const packs = raw.packs.map((p) => {
    if (
      !object(p) || Object.keys(p).length !== 3 || !count(p.messages_left) ||
      !date(p.expires_at) || !nullableDate(p.voided_at)
    ) return fail();
    return {
      messages_left: p.messages_left as number,
      expires_at: p.expires_at as string,
      voided_at: p.voided_at as string | null,
    };
  });
  return {
    version: 1,
    userId,
    serverNow: raw.serverNow as string,
    usage: { ...r } as UsageRow,
    packs,
  };
}

export class BillingSnapshotController {
  private lastServerStamp: bigint | null = null;
  private hasAnchor = false;
  private lowerBase = 0;
  private lowerAnchor = 0;
  state: BillingSnapshotState;
  private host: Host;
  private listeners = new Set<(state: BillingSnapshotState) => void>();
  private snapshot: BillingSnapshot | null = null;
  private trusted = false;
  private needsFresh = false;
  private disposed = false;
  private serial = 0;
  private anchor = 0;
  private base = 0;
  private lastMono = 0;
  private lastWall = 0;
  private deadline: unknown;
  private heartbeat: unknown;
  private abort?: AbortController;
  constructor(
    readonly userId: string,
    private read: (signal: AbortSignal) => Promise<unknown>,
    host: Partial<Host> = {},
  ) {
    this.host = {
      monotonicNow: () => performance.now(),
      wallNow: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      ...host,
    };
    this.state = this.empty();
    this.lastMono = this.host.monotonicNow();
    this.lastWall = this.host.wallNow();
    this.watchClock();
  }
  private empty(): BillingSnapshotState {
    return {
      userId: this.userId,
      loaded: false,
      checking: false,
      error: false,
      tier: "free",
      row: null,
      counter: null,
      freeRenewable: false,
    };
  }
  subscribe(listener: (state: BillingSnapshotState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private serverNow(mono = this.host.monotonicNow()) {
    return this.base + Math.max(0, mono - this.anchor);
  }
  private emit(checking = this.state.checking, error = this.state.error) {
    if (this.disposed) return;
    let next = { ...this.empty(), checking, error };
    if (this.trusted && this.snapshot) {
      const now = this.serverNow();
      let row = { ...this.snapshot.usage };
      if (
        row.access_source === "purchase" && !row.unlimited_usage &&
        parseServerTimestamp(row.paid_access_until) <= now
      ) row = { ...row, tier: "free", period_requests_used: 50 };
      const tier = row.tier as PlanId;
      next = {
        userId: this.userId,
        checking,
        error,
        loaded: true,
        tier,
        row,
        counter: messageCounter(row, new Date(now), this.snapshot.packs),
        freeRenewable: !row.first_real_purchase_at &&
          row.access_source !== "purchase",
      };
    }
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
    this.schedule();
  }
  private schedule() {
    this.host.clearTimer(this.deadline);
    this.deadline = undefined;
    if (!this.trusted || !this.snapshot || this.disposed) return;
    const now = this.serverNow(), deadlines: number[] = [];
    const row = this.snapshot.usage;
    if (row.access_source === "purchase" && !row.unlimited_usage) {
      deadlines.push(parseServerTimestamp(row.paid_access_until));
    }
    for (const p of this.snapshot.packs) {
      if (!p.voided_at && (p.messages_left ?? 0) > 0) {
        deadlines.push(parseServerTimestamp(p.expires_at));
      }
    }
    if (this.state.counter?.renewsAt) {
      deadlines.push(this.state.counter.renewsAt.getTime());
    }
    const future = deadlines.filter((n) => Number.isFinite(n) && n > now);
    if (future.length) {
      this.deadline = this.host.setTimer(() => {
        this.deadline = undefined;
        this.emit();
        void this.refresh();
      }, Math.min(2147000000, Math.max(1, Math.min(...future) - now)));
    }
  }
  private watchClock() {
    if (this.disposed) return;
    this.heartbeat = this.host.setTimer(() => {
      const mono = this.host.monotonicNow(), wall = this.host.wallNow();
      const changed =
        Math.abs((wall - this.lastWall) - (mono - this.lastMono)) > 2000;
      this.lastMono = mono;
      this.lastWall = wall;
      if (changed) void this.refresh({ requireFresh: true });
      this.watchClock();
    }, 1000);
  }
  async refresh(options: { requireFresh?: boolean } = {}) {
    if (this.disposed) return;
    const serial = ++this.serial;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const start = this.host.monotonicNow(), wallStart = this.host.wallNow();
    const clockChanged =
      Math.abs((wallStart - this.lastWall) - (start - this.lastMono)) > 2000;
    if (options.requireFresh || clockChanged) {
      this.trusted = false;
      this.needsFresh = true;
    }
    const floor = this.hasAnchor ? this.serverNow(start) : 0;
    const lowerFloor = this.hasAnchor
      ? this.lowerBase + Math.max(0, start - this.lowerAnchor)
      : 0;
    this.emit(true, false);
    let timeout: unknown;
    let cancel = () => {};
    try {
      const raw = await Promise.race([
        this.read(abort.signal),
        new Promise<never>((_, reject) => {
          cancel = () => reject(Error("cancelled"));
          abort.signal.addEventListener("abort", cancel, { once: true });
          timeout = this.host.setTimer(() => {
            reject(Error("network"));
            abort.abort();
          }, 15000);
        }),
      ]);
      if (this.disposed || serial !== this.serial) return;
      const receiptMono = this.host.monotonicNow(),
        receiptWall = this.host.wallNow();
      if (Math.abs((receiptWall - wallStart) - (receiptMono - start)) > 2000) {
        this.trusted = false;
        this.needsFresh = true;
        throw Error("clock_discontinuity");
      }
      if (raw === null) {
        this.trusted = false;
        this.needsFresh = true;
        this.emit(false, true);
        return;
      }
      const parsed = parseBillingSnapshot(raw, this.userId),
        at = parseServerTimestamp(parsed.serverNow);
      // Preserve microsecond ordering, which Date.parse truncates. Revocation must not discard history.
      const fraction = (/\.(\d{1,6})/.exec(parsed.serverNow)?.[1] ?? "").padEnd(
        6,
        "0",
      );
      const stamp = BigInt(at) * 1000n + BigInt(fraction.slice(3) || "0");
      if (
        this.lastServerStamp !== null && (stamp < this.lastServerStamp ||
          this.needsFresh &&
            (stamp <= this.lastServerStamp || at + 1 < lowerFloor))
      ) throw Error("invalid_billing_snapshot");
      this.base = Math.max(at, floor);
      this.anchor = start;
      this.hasAnchor = true;
      this.lastServerStamp = stamp;
      this.lowerBase = Math.max(at, lowerFloor);
      this.lowerAnchor = receiptMono;
      this.snapshot = parsed;
      this.trusted = true;
      this.needsFresh = false;
      this.lastMono = receiptMono;
      this.lastWall = receiptWall;
      this.emit(false, false);
    } catch (error) {
      if (!this.disposed && serial === this.serial) {
        if (
          error instanceof Error && error.message === "invalid_billing_snapshot"
        ) {
          this.trusted = false;
          this.needsFresh = true;
        }
        this.emit(false, true);
      }
    } finally {
      this.host.clearTimer(timeout);
      abort.signal.removeEventListener("abort", cancel);
      if (this.abort === abort) this.abort = undefined;
    }
  }
  dispose() {
    this.disposed = true;
    ++this.serial;
    this.abort?.abort();
    this.host.clearTimer(this.deadline);
    this.host.clearTimer(this.heartbeat);
    this.listeners.clear();
  }
}
