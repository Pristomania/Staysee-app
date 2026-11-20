import test from "node:test";
import assert from "node:assert/strict";
import {
  BillingSnapshotController,
  parseBillingSnapshot,
} from "../src/lib/billingSnapshot.ts";
import {
  exhaustedReply,
  messageCounter,
  renewalLine,
} from "../src/lib/messageCounter.ts";
import { planRows } from "../src/lib/planCopy.ts";
import { PLANS } from "../src/lib/plans.ts";
const uid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverNow = "2026-11-20T12:00:00Z", end = "2026-11-20T12:00:30Z";
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId: uid,
    serverNow,
    usage: {
      tier: "basic",
      period_requests_used: 400,
      period_started_at: "2026-10-21T12:00:30Z",
      last_request_at: serverNow,
      unlimited_usage: false,
      max_conversations_override: null,
      access_source: "purchase",
      paid_access_until: end,
      first_real_purchase_at: "2026-10-21T12:00:30Z",
    },
    packs: [],
    ...overrides,
  };
}
function clock() {
  let mono = 0, wall = 1_000_000, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    host: {
      monotonicNow: () => mono,
      wallNow: () => wall,
      setTimer: (fn: () => void, ms: number) => {
        timers.set(++id, { at: mono + ms, fn });
        return id;
      },
      clearTimer: (key: unknown) => {
        timers.delete(key as number);
      },
    },
    advance: (ms: number) => {
      const stop = mono + ms;
      for (let step = 0; step < 10000; step++) {
        const due = [...timers].filter(([, t]) =>
          t.at <= stop
        ).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        wall += due[1].at - mono;
        mono = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      wall += stop - mono;
      mono = stop;
    },
    sleep: (ms: number) => {
      wall += ms;
    },
    size: () => timers.size,
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("snapshot validates owner, shape and calendar dates without accepting financial fields", () => {
  assert.equal(parseBillingSnapshot(snapshot(), uid).usage.tier, "basic");
  for (
    const raw of [
      { ...snapshot(), userId: "other" },
      { ...snapshot(), version: 2 },
      { ...snapshot(), serverNow: "2027-02-30T00:00:00Z" },
      { ...snapshot(), cost: 1 },
      {
        ...snapshot(),
        usage: { ...snapshot().usage, period_requests_used: -1 },
      },
    ]
  ) {
    assert.throws(
      () => parseBillingSnapshot(raw, uid),
      /invalid_billing_snapshot/,
    );
  }
});
test("purchased zero balance keeps paid tier until exact deadline, offline expiry does not renew it", async () => {
  const c = clock();
  let failing = false;
  const model = new BillingSnapshotController(uid, async () => {
    if (failing) throw Error("offline");
    return snapshot();
  }, c.host);
  await model.refresh();
  assert.equal(model.state.tier, "basic");
  assert.equal(model.state.counter?.remaining, 0);
  assert.equal(model.state.counter?.renewsAt, null);
  assert.match(renewalLine(model.state.counter!, "basic"), /^Оплачен до/);
  failing = true;
  c.advance(30_000);
  await flush();
  assert.equal(model.state.tier, "free");
  assert.equal(model.state.counter?.available, 0);
  assert.equal(model.state.counter?.renewsAt, null);
  assert.equal(renewalLine(model.state.counter!, "free"), "");
  model.dispose();
  assert.equal(c.size(), 0);
});
test("remaining initial trial survives a pack but no future free50 is promised", () => {
  const counter = messageCounter(
    {
      tier: "free",
      period_requests_used: 17,
      period_started_at: "2025-01-01T00:00:00Z",
      last_request_at: "2025-01-01T00:00:00Z",
      first_real_purchase_at: serverNow,
      access_source: "manual",
    },
    new Date(serverNow),
    [{
      messages_left: 100,
      expires_at: "2027-01-01T00:00:00Z",
      voided_at: null,
    }],
  );
  assert.equal(counter?.remaining, 33);
  assert.equal(counter?.available, 133);
  assert.equal(counter?.renewsAt, null);
  assert.equal(renewalLine(counter!, "free"), "");
  const empty = messageCounter({
    tier: "free",
    period_requests_used: 50,
    first_real_purchase_at: serverNow,
  }, new Date(serverNow));
  assert.equal(
    exhaustedReply(empty!, "free"),
    "Сообщения закончились. Беседа сохранена.",
  );
  assert.doesNotMatch(
    planRows(PLANS.free, { freeRenewable: false })[0].text,
    /новые|50|через 3/,
  );
  assert.equal(
    planRows(PLANS.free, { freeRenewable: null })[0].text,
    "Проверяем доступные сообщения",
  );
});
test("failure keeps known state, but null revokes it and another user cannot inherit it", async () => {
  const c = clock();
  let raw: unknown = snapshot(), fail = false;
  const model = new BillingSnapshotController(uid, async () => {
    if (fail) throw Error("offline");
    return raw;
  }, c.host);
  await model.refresh();
  fail = true;
  await model.refresh();
  assert.equal(model.state.tier, "basic");
  fail = false;
  raw = null;
  await model.refresh();
  assert.equal(model.state.loaded, false);
  assert.equal(model.state.tier, "free");
  raw = { ...snapshot(), userId: "other" };
  await model.refresh();
  assert.equal(model.state.loaded, false);
  model.dispose();
});
test("old snapshot replay cannot reset the expiry countdown", async () => {
  const c = clock();
  const model = new BillingSnapshotController(
    uid,
    async () => snapshot(),
    c.host,
  );
  await model.refresh();
  c.advance(20_000);
  await model.refresh();
  c.advance(10_000);
  await flush();
  assert.equal(model.state.tier, "free");
  model.dispose();
});
test("clock divergence and foreground verification fail closed without granting from device time", async () => {
  const c = clock();
  let fail = false, raw = snapshot();
  const model = new BillingSnapshotController(uid, async () => {
    if (fail) throw Error("offline");
    return raw;
  }, c.host);
  await model.refresh();
  fail = true;
  c.sleep(3_600_000);
  c.advance(1000);
  await flush();
  assert.equal(model.state.loaded, false);
  assert.equal(model.state.tier, "free");
  assert.equal(model.state.error, true);
  fail = false;
  await model.refresh();
  assert.equal(
    model.state.loaded,
    false,
    "stale reply is not fresh wake verification",
  );
  raw = { ...snapshot(), serverNow: "2026-11-20T12:00:01Z" };
  await model.refresh();
  assert.equal(model.state.tier, "basic");
  fail = true;
  await model.refresh({ requireFresh: true });
  assert.equal(model.state.loaded, false);
  model.dispose();
});
test("out-of-order responses, cancellation and bounded wait cannot expose late state", async () => {
  const c = clock();
  const releases: ((v: unknown) => void)[] = [];
  const model = new BillingSnapshotController(
    uid,
    () => new Promise((resolve) => releases.push(resolve)),
    c.host,
  );
  const old = model.refresh();
  const current = model.refresh();
  releases[1](null);
  await current;
  releases[0](snapshot());
  await old;
  assert.equal(model.state.loaded, false);
  const timeout = model.refresh();
  c.advance(15_001);
  await timeout;
  assert.equal(model.state.error, true);
  const late = model.refresh();
  model.dispose();
  releases[3](snapshot());
  await late;
  assert.equal(model.state.loaded, false);
  assert.equal(c.size(), 0);
});
test("packs expire by server-monotonic time independently of quota", async () => {
  const c = clock();
  const raw = snapshot({
    usage: {
      ...snapshot().usage,
      tier: "free",
      period_requests_used: 50,
      paid_access_until: "2026-11-19T00:00:00Z",
    },
    packs: [{
      messages_left: 5,
      expires_at: "2026-11-20T12:00:10Z",
      voided_at: null,
    }],
  });
  let fail = false;
  const model = new BillingSnapshotController(uid, async () => {
    if (fail) throw Error("offline");
    return raw;
  }, c.host);
  await model.refresh();
  assert.equal(model.state.counter?.available, 5);
  fail = true;
  c.advance(10_000);
  await flush();
  assert.equal(model.state.counter?.available, 0);
  model.dispose();
});

test("older snapshot cannot reverse an accepted downgrade or restore authority after null", async () => {
  const c = clock();
  let raw: unknown = snapshot();
  const model = new BillingSnapshotController(uid, async () => raw, c.host);
  await model.refresh();
  raw = snapshot({
    serverNow: "2026-11-20T12:00:01Z",
    usage: {
      ...snapshot().usage,
      tier: "free",
      period_requests_used: 50,
      paid_access_until: "2026-11-19T00:00:00Z",
    },
  });
  await model.refresh();
  assert.equal(model.state.tier, "free");
  raw = snapshot();
  await model.refresh();
  assert.notEqual(model.state.tier, "basic");
  raw = null;
  await model.refresh();
  raw = snapshot();
  await model.refresh();
  assert.equal(model.state.loaded, false);
  model.dispose();
});
test("null does not discard the monotonic server floor beyond a deadline", async () => {
  const c = clock();
  let raw: unknown = snapshot();
  const model = new BillingSnapshotController(uid, async () => raw, c.host);
  await model.refresh();
  c.advance(31_000);
  await flush();
  raw = null;
  await model.refresh();
  raw = snapshot();
  await model.refresh();
  assert.notEqual(model.state.tier, "basic");
  model.dispose();
});
test("response arriving after paused-clock sleep cannot erase discontinuity before heartbeat", async () => {
  const c = clock();
  let delayed = false;
  let release!: (v: unknown) => void;
  const model = new BillingSnapshotController(
    uid,
    () =>
      delayed
        ? new Promise((resolve) => {
          release = resolve;
        })
        : Promise.resolve(snapshot()),
    c.host,
  );
  await model.refresh();
  delayed = true;
  const pending = model.refresh();
  c.sleep(3_600_000);
  release(snapshot());
  await pending;
  assert.equal(model.state.loaded, false);
  c.advance(1000);
  await flush();
  assert.equal(model.state.loaded, false);
  model.dispose();
});
test("fresh server no-renewal refusal wins over a captured stale renewable counter", () => {
  const stale = messageCounter({
    tier: "free",
    period_requests_used: 50,
    period_started_at: serverNow,
    last_request_at: serverNow,
  }, new Date(serverNow));
  const reply = exhaustedReply(
    stale!,
    "free",
    new Date(serverNow),
    "Сообщения закончились. Беседа сохранена.",
  );
  assert.equal(reply, "Сообщения закончились. Беседа сохранена.");
});
