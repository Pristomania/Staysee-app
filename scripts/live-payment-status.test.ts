/* eslint-disable @typescript-eslint/no-explicit-any --
   These tests change single fields of a deliberately loosely-typed DTO and record fake calls; the point is that the
   parser rejects what the type system would otherwise forbid. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLivePaymentStatusApi,
  parseLivePaymentStatus,
  paymentStatusCopy,
  readLivePaymentStatus,
} from "../src/lib/livePaymentStatus.ts";
const uid = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
const now = "2026-11-20T12:00:00.123456Z",
  started = "2026-11-19T12:00:00.123456Z",
  until = "2026-12-19T12:00:00.123456Z";
function dto() {
  return {
    version: 1,
    currentGrant: true,
    order: {
      id,
      productId: "basic",
      purchaseKind: "new_period",
      amountKopecks: 199000,
      status: "applied",
      expiresAt: "2026-11-19T13:00:00Z",
      paidAt: started,
      appliedAt: started,
      paidUntil: until,
    },
    billing: {
      version: 1,
      userId: uid,
      serverNow: now,
      usage: {
        tier: "basic",
        period_requests_used: 5,
        period_started_at: started,
        last_request_at: now,
        unlimited_usage: false,
        max_conversations_override: null,
        access_source: "purchase",
        paid_access_until: until,
        first_real_purchase_at: started,
      },
      packs: [],
    },
  };
}
test("only expected owner and order are accepted; response is copied, not kept by reference", () => {
  const raw = dto(), parsed = parseLivePaymentStatus(raw, uid, id);
  raw.order.status = "pending";
  assert.equal(parsed.order.status, "applied");
  assert.equal(parsed.currentGrant, true);
  assert.throws(() => parseLivePaymentStatus(dto(), id, id), /invalid/);
  assert.throws(() => parseLivePaymentStatus(dto(), uid, uid), /invalid/);
});
for (
  const [name, mutate] of [
    ["test mode flag", (v: any) => {
      v.mode = "test";
    }],
    ["extra secret field", (v: any) => {
      v.order.merchantSecret = "never accept";
    }],
    ["amount string", (v: any) => {
      v.order.amountKopecks = "199000";
    }],
    ["unknown status", (v: any) => {
      v.order.status = "success";
    }],
    ["pending with paid dates", (v: any) => {
      v.order.status = "pending";
    }],
    ["bad date", (v: any) => {
      v.order.paidUntil = "2026-02-30T12:00:00Z";
    }],
    ["wrong30day term", (v: any) => {
      v.order.paidUntil = "2027-01-19T12:00:00Z";
    }],
    ["manual current grant", (v: any) => {
      v.billing.usage.access_source = "manual";
      v.billing.usage.paid_access_until = null;
    }],
    ["replaced old grant", (v: any) => {
      v.billing.usage.tier = "premium";
    }],
    ["future payment", (v: any) => {
      v.order.paidAt = "2027-01-01T00:00:00Z";
    }],
    ["microsecond mismatch", (v: any) => {
      v.billing.usage.period_started_at = "2026-11-19T12:00:00.123457Z";
    }],
    ["bad snapshot", (v: any) => {
      v.billing.usage.period_requests_used = -1;
    }],
  ] as const
) {
  test(`invalid or optimistic DTO fails closed: ${name}`, () => {
    const v = dto();
    mutate(v);
    assert.throws(() => parseLivePaymentStatus(v, uid, id), /invalid/);
  });
}
test("historical Basic after upgrade does not produce an active-Basic greeting", () => {
  const v = dto();
  v.currentGrant = false;
  v.billing.usage.tier = "premium";
  const copy = paymentStatusCopy(parseLivePaymentStatus(v, uid, id));
  assert.equal(copy.kind, "historical");
  assert.equal(copy.benefits.length, 0);
});
test("current grant uses exact server time rather than device clock for greeting", () => {
  const r = parseLivePaymentStatus(dto(), uid, id), copy = paymentStatusCopy(r);
  assert.equal(copy.kind, "active");
  assert.ok(copy.benefits.length > 0);
});
test("canonical PostgreSQL UUIDs accept uppercase caller IDs and normalize the result", () => {
  const v = dto();
  const owner = "abcdefab-abcd-4abc-8abc-abcdefabcdef",
    order = "abcdefab-abcd-4abc-8abc-bbbbbbbbbbbb";
  v.billing.userId = owner;
  v.order.id = order;
  const parsed = parseLivePaymentStatus(
    v,
    owner.toUpperCase(),
    order.toUpperCase(),
  );
  assert.equal(parsed.order.id, order);
  assert.equal(parsed.billing.userId, owner);
});
test("positive submillisecond remainder never pairs active state with ended wording", () => {
  const v = dto();
  v.billing.serverNow = "2026-12-19T12:00:00.123455Z";
  const copy = paymentStatusCopy(parseLivePaymentStatus(v, uid, id));
  assert.equal(copy.kind, "active");
  assert.match(copy.title, /подключён/);
  assert.ok(copy.benefits.length > 0);
});
test("pack history never promises100 messages are still available", () => {
  const v = dto();
  Object.assign(v.order, {
    productId: "pack100",
    amountKopecks: 59000,
    paidUntil: null,
  });
  v.currentGrant = false;
  const copy = paymentStatusCopy(parseLivePaymentStatus(v, uid, id));
  assert.equal(copy.kind, "historical");
  assert.equal(copy.benefits.length, 0);
});
for (const state of ["pending", "expired", "paid_unfulfilled"]) {
  test(`status ${state} never implies active access or repeat payment`, () => {
    const v = dto();
    v.currentGrant = false;
    Object.assign(v.order, {
      status: state,
      appliedAt: null,
      paidUntil: null,
      paidAt: state === "paid_unfulfilled" ? started : null,
    });
    if (state === "pending") v.order.expiresAt = "2026-11-21T00:00:00Z";
    const copy = paymentStatusCopy(parseLivePaymentStatus(v, uid, id));
    assert.equal(copy.kind, state);
    assert.equal(copy.benefits.length, 0);
    assert.match(copy.body, /повторно/i);
  });
}
test("read binds signed session and expected order before and after response", async () => {
  const calls: unknown[] = [];
  const result = await readLivePaymentStatus({
    userId: uid,
    orderId: id,
    session: async () => ({ userId: uid, token: "dummy-token" }),
    read: async (order, token, signal) => {
      calls.push([order, token, signal.aborted]);
      return dto();
    },
    signal: new AbortController().signal,
  });
  assert.equal(result.currentGrant, true);
  assert.deepEqual(calls, [[id, "dummy-token", false]]);
});
test("wrong session cannot start a status read", async () => {
  let called = false;
  await assert.rejects(
    readLivePaymentStatus({
      userId: uid,
      orderId: id,
      session: async () => ({ userId: id, token: "x" }),
      read: async () => {
        called = true;
        return dto();
      },
      signal: new AbortController().signal,
    }),
    /session_changed/,
  );
  assert.equal(called, false);
});
test("session switch after response is discarded, even on same-user token change", async () => {
  let n = 0;
  await assert.rejects(
    readLivePaymentStatus({
      userId: uid,
      orderId: id,
      session: async () => ({
        userId: uid,
        token: ++n === 1 ? "before" : "after",
      }),
      read: async () => dto(),
      signal: new AbortController().signal,
    }),
    /session_changed/,
  );
});
test("hanging session and RPC both share bounded deadline; RPC gets abort signal", async () => {
  for (const hang of ["session", "read"]) {
    let seen: AbortSignal | undefined;
    await assert.rejects(
      readLivePaymentStatus({
        userId: uid,
        orderId: id,
        timeoutMs: 20,
        session: async () =>
          hang === "session"
            ? await new Promise(() => {})
            : { userId: uid, token: "x" },
        read: async (_, __, s) => {
          seen = s;
          return await new Promise(() => {});
        },
        signal: new AbortController().signal,
      }),
      /timeout/,
    );
    if (seen) assert.equal(seen.aborted, true);
  }
});
test("caller cancellation aborts the read and returns no late success", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    readLivePaymentStatus({
      userId: uid,
      orderId: id,
      session: async () => null,
      read: async () => {
        called = true;
        return dto();
      },
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.equal(called, false);
});
test("HTTP adapter pins Bearer to checked session and never sends userId as authorization input", async () => {
  const calls: any[] = [];
  const api = createLivePaymentStatusApi({
    baseUrl: "https://example.invalid/supabase",
    anonKey: "dummy-public",
    session: async () => ({ userId: uid, token: "dummy-token" }),
    fetch: async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(dto()), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await api(uid, id, new AbortController().signal);
  assert.equal(
    calls[0][0],
    "https://example.invalid/supabase/rest/v1/rpc/get_my_live_payment_status",
  );
  assert.equal(
    new Headers(calls[0][1].headers).get("authorization"),
    "Bearer dummy-token",
  );
  assert.deepEqual(JSON.parse(calls[0][1].body), { p_order_id: id });
});
test("HTTP error with never-ending body stops its transport instead of clearing the only deadline", async () => {
  let signal: AbortSignal | undefined, cancelled = false;
  const api = createLivePaymentStatusApi({
    baseUrl: "https://example.invalid",
    anonKey: "dummy",
    session: async () => ({ userId: uid, token: "dummy" }),
    fetch: async (_, init) => {
      signal = init?.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      );
    },
  });
  await assert.rejects(
    api(uid, id, new AbortController().signal),
    /payment_status_unavailable/,
  );
  assert.equal(cancelled || signal?.aborted, true);
});
for (
  const [label, reply] of [
    ["auth failure", () => new Response("sensitive-error", { status: 401 })],
    ["DB failure", () => new Response("sensitive-error", { status: 500 })],
    ["no owned order", () => new Response("null")],
    ["bad JSON", () => new Response("{")],
    ["oversized response", () => new Response("x".repeat(2 * 1024 * 1024 + 1))],
  ] as const
) {
  test(`HTTP response ${label} never produces a successful payment`, async () => {
    const api = createLivePaymentStatusApi({
      baseUrl: "https://example.invalid",
      anonKey: "dummy",
      session: async () => ({ userId: uid, token: "dummy" }),
      fetch: async () => reply(),
    });
    await assert.rejects(api(uid, id, new AbortController().signal));
  });
}
