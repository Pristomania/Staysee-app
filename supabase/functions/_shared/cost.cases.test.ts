/**
 * Fail-closed rate-limit regression (variant A) + Variant B atomic quota wrappers.
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/cost.cases.test.ts
 */

import { register } from "node:module";

// cost.ts (and its transitive Edge imports) use Deno-style `npm:` specifiers.
// Remap them to bare package names so local tsx can load checkRateLimit without
// changing production code or package.json.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === "string" && specifier.startsWith("npm:")) {
    const rest = specifier.slice(4);
    const bare = rest.startsWith("@")
      ? "@" + rest.slice(1).split("@")[0]
      : rest.split("@")[0];
    return nextResolve(bare, context);
  }
  return nextResolve(specifier, context);
}
`)}`,
);

// Transitive Edge modules read Deno.env at import time; stub only for local tsx.
const g = globalThis as typeof globalThis & {
  Deno?: { env: { get: (key: string) => string | undefined } };
};
if (!g.Deno) {
  g.Deno = {
    env: {
      get() {
        return undefined;
      },
    },
  };
}

const {
  checkRateLimit,
  reserveAiRequest,
  recordTokenUsage,
  incrementUsage,
} = await import("./cost.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type FakeRow = {
  tier: string;
  daily_request_limit: number;
  daily_requests_used: number;
  month_reset_at: string;
  day_reset_at: string;
  is_suspended: boolean;
};

type FakeResult = {
  data: FakeRow | null;
  error: { message: string } | null;
};

/** Minimal chain: from → select → eq → maybeSingle */
function makeFakeClient(result: FakeResult) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return result;
                },
              };
            },
          };
        },
      };
    },
  };
}

const USER_ID = "00000000-0000-4000-8000-000000000001";
const recentDayReset = new Date().toISOString();

// ── 1. SELECT error → fail-closed ─────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: null,
      error: { message: "forced select failure" },
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "1.error: allowed must be false");
  assert(
    result.reason === "limit_check_error",
    `1.error: reason expected limit_check_error, got ${String(result.reason)}`,
  );
  console.log("✓ SELECT error → allowed:false, reason:limit_check_error");
}

// ── 2. Missing row → fail-closed ──────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: null,
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "2.missing: allowed must be false");
  assert(
    result.reason === "missing_tier",
    `2.missing: reason expected missing_tier, got ${String(result.reason)}`,
  );
  console.log("✓ missing tier row → allowed:false, reason:missing_tier");
}

// ── 3. Suspended ──────────────────────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: {
        tier: "free",
        daily_request_limit: 50,
        daily_requests_used: 0,
        month_reset_at: recentDayReset,
        day_reset_at: recentDayReset,
        is_suspended: true,
      },
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "3.suspended: allowed must be false");
  assert(
    result.reason === "suspended",
    `3.suspended: reason expected suspended, got ${String(result.reason)}`,
  );
  console.log("✓ suspended → allowed:false, reason:suspended");
}

// ── 4. Daily limit exhausted ──────────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: {
        tier: "free",
        daily_request_limit: 50,
        daily_requests_used: 50,
        month_reset_at: recentDayReset,
        day_reset_at: recentDayReset,
        is_suspended: false,
      },
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === false, "4.daily_limit: allowed must be false");
  assert(
    result.reason === "daily_limit",
    `4.daily_limit: reason expected daily_limit, got ${String(result.reason)}`,
  );
  console.log("✓ daily limit exhausted → allowed:false, reason:daily_limit");
}

// ── 5. Within limit ───────────────────────────────────────────────────────────

{
  const result = await checkRateLimit(
    makeFakeClient({
      data: {
        tier: "basic",
        daily_request_limit: 200,
        daily_requests_used: 3,
        month_reset_at: recentDayReset,
        day_reset_at: recentDayReset,
        is_suspended: false,
      },
      error: null,
    }) as never,
    USER_ID,
  );
  assert(result.allowed === true, "5.ok: allowed must be true");
  assert(result.tier === "basic", `5.ok: tier expected basic, got ${result.tier}`);
  console.log("✓ within limit → allowed:true, tier:basic");
}

// ── Variant B regression: reserveAiRequest / recordTokenUsage ────────────────

type RpcCall = { fn: string; args: Record<string, unknown> };

type RpcResult = { data: unknown; error: { message: string } | null };

function makeFakeRpcClient(handlers: {
  reserve?: RpcResult;
  tokens?: RpcResult;
  reserveThrow?: Error;
  tokensThrow?: Error;
}) {
  const calls: RpcCall[] = [];
  return {
    calls,
    client: {
      async rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        if (fn === "reserve_ai_request") {
          if (handlers.reserveThrow) throw handlers.reserveThrow;
          return handlers.reserve ?? {
            data: null,
            error: { message: "missing handler" },
          };
        }
        if (fn === "add_ai_token_usage") {
          if (handlers.tokensThrow) throw handlers.tokensThrow;
          return handlers.tokens ?? {
            data: null,
            error: { message: "missing handler" },
          };
        }
        if (fn === "increment_usage") {
          return { data: null, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      },
    },
  };
}

// ── 6. reserve allow for free / basic / premium ───────────────────────────────

for (const tier of ["free", "basic", "premium"] as const) {
  const fake = makeFakeRpcClient({
    reserve: { data: { allowed: true, tier }, error: null },
  });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === true, `6.allow.${tier}: allowed`);
  assert(result.tier === tier, `6.allow.${tier}: tier`);
  assert(fake.calls.length === 1, `6.allow.${tier}: one rpc`);
  assert(fake.calls[0].fn === "reserve_ai_request", `6.allow.${tier}: fn`);
  assert(fake.calls[0].args.p_user_id === USER_ID, `6.allow.${tier}: user`);
  console.log(`✓ reserve allow → allowed:true, tier:${tier}`);
}

// ── 7–9. reserve deny reasons ─────────────────────────────────────────────────

for (const reason of ["suspended", "daily_limit", "missing_tier"] as const) {
  const fake = makeFakeRpcClient({
    reserve: { data: { allowed: false, tier: "free", reason }, error: null },
  });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === false, `7-9.${reason}: allowed`);
  assert(result.reason === reason, `7-9.${reason}: reason`);
  assert(result.tier === "free", `7-9.${reason}: tier`);
  console.log(`✓ reserve deny → ${reason}`);
}

// ── 10. RPC/transport error → limit_check_error ───────────────────────────────

{
  const fake = makeFakeRpcClient({
    reserve: { data: null, error: { message: "boom" } },
  });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === false, "10.rpc_error: allowed");
  assert(result.reason === "limit_check_error", "10.rpc_error: reason");
  assert(result.tier === "free", "10.rpc_error: tier");
  console.log("✓ reserve RPC error → limit_check_error");
}

// ── 11–17. malformed / unknown payloads → limit_check_error ───────────────────

const malformedCases: Array<{ label: string; data: unknown }> = [
  { label: "null_payload", data: null },
  { label: "unknown_tier", data: { allowed: true, tier: "enterprise" } },
  {
    label: "unknown_reason",
    data: { allowed: false, tier: "free", reason: "weekly_limit" },
  },
  { label: "missing_reason", data: { allowed: false, tier: "free" } },
  { label: "allowed_not_boolean", data: { allowed: "yes", tier: "free" } },
  { label: "allowed_true_without_tier", data: { allowed: true } },
  { label: "array_payload", data: [{ allowed: true, tier: "free" }] },
  { label: "string_payload", data: "not-json-object" },
  {
    label: "allow_with_unexpected_reason",
    data: { allowed: true, tier: "basic", reason: "unexpected" },
  },
];

for (const { label, data } of malformedCases) {
  const fake = makeFakeRpcClient({ reserve: { data, error: null } });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === false, `malformed.${label}: allowed`);
  assert(
    result.reason === "limit_check_error",
    `malformed.${label}: reason expected limit_check_error, got ${String(result.reason)}`,
  );
  assert(result.tier === "free", `malformed.${label}: tier`);
  console.log(`✓ reserve malformed ${label} → limit_check_error`);
}

// ── reserve RPC throw → fail-closed, no throw out ─────────────────────────────

{
  const fake = makeFakeRpcClient({
    reserveThrow: new Error("transport exploded"),
  });
  let threw = false;
  let result: Awaited<ReturnType<typeof reserveAiRequest>> | null = null;
  try {
    result = await reserveAiRequest(fake.client as never, USER_ID);
  } catch {
    threw = true;
  }
  assert(threw === false, "reserve_throw: must not throw");
  assert(result !== null, "reserve_throw: must resolve");
  assert(result!.allowed === false, "reserve_throw: allowed");
  assert(result!.reason === "limit_check_error", "reserve_throw: reason");
  assert(result!.tier === "free", "reserve_throw: tier");
  assert(fake.calls.length === 1, "reserve_throw: one rpc attempt");
  console.log("✓ reserve RPC throw → limit_check_error, no throw out");
}

// ── 18. recordTokenUsage → exactly one add_ai_token_usage ─────────────────────

{
  const fake = makeFakeRpcClient({
    tokens: { data: null, error: null },
  });
  await recordTokenUsage(fake.client as never, USER_ID, 42);
  assert(fake.calls.length === 1, "18.tokens: one rpc");
  assert(fake.calls[0].fn === "add_ai_token_usage", "18.tokens: fn");
  assert(fake.calls[0].args.p_user_id === USER_ID, "18.tokens: p_user_id");
  assert(fake.calls[0].args.p_tokens === 42, "18.tokens: p_tokens");
  assert(
    fake.calls.every((c) => c.fn !== "increment_usage"),
    "18.tokens: must not call increment_usage",
  );
  console.log("✓ recordTokenUsage → add_ai_token_usage only");
}

// ── 19. recordTokenUsage RPC error is best-effort (does not throw) ────────────

{
  const fake = makeFakeRpcClient({
    tokens: { data: null, error: { message: "token write failed" } },
  });
  let threw = false;
  try {
    await recordTokenUsage(fake.client as never, USER_ID, 7);
  } catch {
    threw = true;
  }
  assert(threw === false, "19.tokens_error: must not throw");
  assert(fake.calls.length === 1, "19.tokens_error: one rpc");
  assert(fake.calls[0].fn === "add_ai_token_usage", "19.tokens_error: fn");
  assert(
    fake.calls.every((c) => c.fn !== "increment_usage"),
    "19.tokens_error: must not call increment_usage",
  );
  console.log("✓ recordTokenUsage error is non-throwing");
}

// ── recordTokenUsage RPC throw → best-effort, one attempt ─────────────────────

{
  const fake = makeFakeRpcClient({
    tokensThrow: new Error("transport exploded"),
  });
  let threw = false;
  try {
    await recordTokenUsage(fake.client as never, USER_ID, 9);
  } catch {
    threw = true;
  }
  assert(threw === false, "tokens_throw: must not throw");
  assert(fake.calls.length === 1, "tokens_throw: exactly one rpc attempt");
  assert(fake.calls[0].fn === "add_ai_token_usage", "tokens_throw: fn");
  console.log("✓ recordTokenUsage RPC throw → non-throwing, one attempt");
}

// ── 20. legacy incrementUsage remains exported ────────────────────────────────

assert(typeof incrementUsage === "function", "20.legacy: incrementUsage export remains");
console.log("✓ legacy incrementUsage export remains");

console.log("=== cost.cases.test.ts OK ===");
