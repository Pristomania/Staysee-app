# Atomic Chat Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically reserve one daily AI request before any provider-backed work, while preserving the preliminary quota filter and recording actual monthly tokens separately (disconnect-independent).

**Architecture:** Keep the existing read-only `checkRateLimit` as an early defense-in-depth filter. Free message-only guards run before reserve. Call `reserveAiRequest` exactly once before eager summary / memory refresh / main model / recovery / shadow. Record monthly tokens via `recordTokenUsage` immediately after `totalTokens`, independent of `clientConnected`.

**Tech Stack:** Supabase PostgreSQL/PLpgSQL, Supabase Edge Functions/Deno TypeScript, Node `tsx` case tests, Supabase CLI.

## Global Constraints

- Do not change frontend/client.
- Do not change prompt, model routing, or memory.
- Do not add a hard monthly token deny.
- Do not refund/return a daily slot after a successful reserve (even on provider/network failure).
- Do not treat preliminary `checkRateLimit` as concurrency-safe; only `reserve_ai_request` is authoritative.
- Do not write production code until the matching RED test has been witnessed failing for the intended reason.
- Do not create a git commit until Nastya gives an explicit separate commit authorization for that exact change set.
- Do not push, open a PR, or deploy without a separate explicit authorization for that exact external action.
- Do not deploy to staging or production without an exact `--project-ref` and a separate explicit deploy authorization.
- Staging always before production.
- Before any production Supabase command, re-link with the exact production project ref and verify `supabase/.temp/project-ref`.
- Never print secrets, JWTs, service-role keys, or raw user/PII payloads in logs, reports, or commits.
- One task = one independently verifiable TDD deliverable.
- Spec source of truth: `docs/superpowers/specs/2026-07-30-atomic-chat-quota-design.md`.
- Work only in worktree `D:\Staisy-main Приложение\Staysee-app-atomic-chat-quota` on branch `fix/atomic-chat-quota`.
- Do not run `npm audit fix` / dependency upgrades as part of this plan.

## Delivery order (full pipeline)

Every external step requires its own separate authorization. Do not combine permissions.

1. Local RED/GREEN (Tasks 1-9)
2. Commit (only after explicit commit authorization)
3. Push (only after explicit push authorization)
4. Draft PR (only after explicit PR authorization)
5. Staging migration (Task 10; staging ref only)
6. Staging Edge deploy (separate authorization)
7. Staging concurrency smoke via `scripts/atomic-quota-staging-smoke.mts`
8. Review / Ready / merge (separate authorizations)
9. Production migration (Task 11; re-link production ref first)
10. Production Edge deploy (separate authorization)
11. Production smoke (separate authorization)

Rollback (authorized only): redeploy Edge to pre-Variant-B commit (preliminary `checkRateLimit` + post-call `incrementUsage`); leave additive RPCs unused (no emergency `DROP FUNCTION`).

---

## File map

| File | Responsibility |
|------|----------------|
| `supabase/migrations/20260730120000_031_atomic_chat_quota.sql` | Additive `reserve_ai_request` + `add_ai_token_usage` RPCs |
| `supabase/functions/_shared/cost.ts` | `reserveAiRequest`, `recordTokenUsage`; keep legacy `checkRateLimit` / `incrementUsage` |
| `supabase/functions/_shared/cost.cases.test.ts` | Wrapper contracts including malformed payload fail-closed cases |
| `supabase/functions/_shared/quotaDenyResponse.ts` | Shared HTTP mapping for preliminary + atomic denies |
| `supabase/functions/_shared/quotaDenyResponse.cases.test.ts` | 429 vs 503 mapping contract |
| `supabase/functions/_shared/atomicQuotaMigration.cases.test.ts` | Static contract over migration `031` SQL text |
| `supabase/functions/_shared/stayseeChatAtomicQuotaWiring.cases.test.ts` | Architecture regression + mutation self-checks over real handler source |
| `supabase/functions/staysee-chat/index.ts` | Preliminary check; free guards; early reserve; `recordTokenUsage` after `totalTokens` |
| `scripts/atomic-quota-staging-smoke.mts` | Tracked staging concurrency smoke (no secrets in source or output) |

Out of scope: everything under `src/`, prompts, model router, memory modules, package.json / lockfile (already has `tsx`), rewriting legacy `increment_usage` SQL body.

Important: `stayseeChatAtomicQuotaWiring.cases.test.ts` is an **architecture regression test**. It proves handler source order, deny-block integrity, disconnect-independent accounting shape, and mutation self-checks. It does **not** prove concurrent atomicity; concurrency is proven only by SQL `FOR UPDATE` + staging parallel smoke.

---

### Task 1: Isolated baseline

**Files:**
- Verify only (no create/modify)
- Test: Variant A suites listed below

**Interfaces:**
- Consumes: existing Variant A artifacts on `fix/atomic-chat-quota`
- Produces: written baseline evidence for later tasks (no code artifacts)

- [ ] **Step 1: Confirm worktree / branch / base**

Run from `D:\Staisy-main Приложение\Staysee-app-atomic-chat-quota`:

```powershell
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git merge-base HEAD origin/main
git log --oneline -5
```

Expected:

- toplevel = `D:/Staisy-main Приложение/Staysee-app-atomic-chat-quota` (or Windows equivalent of that exact worktree)
- branch = `fix/atomic-chat-quota`
- merge-base with `origin/main` = `a374254e117b104e5f94e392741174edb0f76dc1`
- HEAD includes design commits (`53610ff`, `d9e5e70` or later docs-only)

If wrong worktree/branch/base -> **STOP**.

- [ ] **Step 2: Install deps**

```powershell
npm ci
```

Expected: exit `0`. Do not run `npm audit fix`. Do not upgrade packages.

- [ ] **Step 3: Run three Variant A case suites**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/cost.cases.test.ts
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/authUser.cases.test.ts
.\node_modules\.bin\tsx.cmd src/lib/ai/client.cases.test.ts
```

Expected: all three exit `0` with their existing OK banners.

- [ ] **Step 4: Capture known-bad typecheck/lint baseline**

```powershell
npm run typecheck
npm run lint
```

Expected (known baseline, do **not** fix in this plan):

- `typecheck` fails with pre-existing frontend `src/` errors (historically ~17 TS errors; record exact summary)
- `lint` may warn/fail with pre-existing issues; record exact summary
- No unexpected new failures in Variant B target files beyond docs-only HEAD

If Variant A suites fail, or typecheck/lint shows unexpected new failures in this branch's owned paths -> **STOP**.

- [ ] **Step 5: Confirm no local Deno**

```powershell
deno --version
```

Expected: command not found / not available. Local verification stays on `tsx` case tests. Do not install Deno for this plan.

- [ ] **Step 6: Git status (no commit)**

```powershell
git status -sb
git status --porcelain
```

Expected: clean for code; plan doc may be untracked/modified. **Do not commit** in Task 1.

---

### Task 2: RED - Edge RPC wrappers (`reserveAiRequest` / `recordTokenUsage`)

**Files:**
- Modify: `supabase/functions/_shared/cost.cases.test.ts`
- Do **not** modify `cost.ts` yet

**Interfaces:**
- Consumes: existing `RateLimitResult` / `UsageTier` from `cost.ts`
- Produces (desired, still missing -> RED):

```ts
export async function reserveAiRequest(
  supabase: SupabaseClient,
  userId: string,
): Promise<RateLimitResult>

export async function recordTokenUsage(
  supabase: SupabaseClient,
  userId: string,
  tokens: number,
): Promise<void>
```

Strict `reserveAiRequest` contract:

- allowed tiers only: `free` | `basic` | `premium`
- allowed deny reasons only: `suspended` | `daily_limit` | `missing_tier`
- unknown tier, unknown reason, `null`, or malformed payload -> fail-closed `{ allowed: false, tier: "free", reason: "limit_check_error" }`
- RPC/transport error -> same fail-closed `limit_check_error`

- [ ] **Step 1: Extend `cost.cases.test.ts` with failing wrapper contracts**

Keep existing `checkRateLimit` cases. Replace the dynamic import to also pull new symbols once they exist:

```ts
const {
  checkRateLimit,
  reserveAiRequest,
  recordTokenUsage,
  incrementUsage,
} = await import("./cost.ts");
```

Add a fake RPC client and cases:

```ts
type RpcCall = { fn: string; args: Record<string, unknown> };

function makeFakeRpcClient(handlers: {
  reserve?: { data: unknown; error: { message: string } | null };
  tokens?: { data: unknown; error: { message: string } | null };
}) {
  const calls: RpcCall[] = [];
  return {
    calls,
    client: {
      async rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        if (fn === "reserve_ai_request") {
          return handlers.reserve ?? { data: null, error: { message: "missing handler" } };
        }
        if (fn === "add_ai_token_usage") {
          return handlers.tokens ?? { data: null, error: { message: "missing handler" } };
        }
        if (fn === "increment_usage") {
          return { data: null, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      },
    },
  };
}

// allow payload
{
  const fake = makeFakeRpcClient({
    reserve: { data: { allowed: true, tier: "basic" }, error: null },
  });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === true, "allow: allowed");
  assert(result.tier === "basic", "allow: tier");
  assert(fake.calls.length === 1 && fake.calls[0].fn === "reserve_ai_request", "allow: rpc");
}

// deny reasons pass-through
for (const reason of ["suspended", "daily_limit", "missing_tier"] as const) {
  const fake = makeFakeRpcClient({
    reserve: { data: { allowed: false, tier: "free", reason }, error: null },
  });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === false, `${reason}: allowed`);
  assert(result.reason === reason, `${reason}: reason`);
}

// transport error
{
  const fake = makeFakeRpcClient({
    reserve: { data: null, error: { message: "boom" } },
  });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === false && result.reason === "limit_check_error", "rpc error");
}

// malformed / unknown payloads -> limit_check_error
const malformed = [
  null,
  { allowed: true, tier: "enterprise" },
  { allowed: false, tier: "free", reason: "weekly_limit" },
  { allowed: false, tier: "free" },
  { allowed: "yes", tier: "free" },
  "not-json-object",
  { allowed: true },
];
for (const [i, data] of malformed.entries()) {
  const fake = makeFakeRpcClient({ reserve: { data, error: null } });
  const result = await reserveAiRequest(fake.client as never, USER_ID);
  assert(result.allowed === false, `malformed[${i}] allowed`);
  assert(result.reason === "limit_check_error", `malformed[${i}] reason`);
  assert(result.tier === "free", `malformed[${i}] tier`);
}

// recordTokenUsage calls only add_ai_token_usage
{
  const fake = makeFakeRpcClient({ tokens: { data: null, error: null } });
  await recordTokenUsage(fake.client as never, USER_ID, 42);
  assert(fake.calls.length === 1, "tokens: one rpc");
  assert(fake.calls[0].fn === "add_ai_token_usage", "tokens: fn");
  assert(fake.calls[0].args.p_tokens === 42, "tokens: arg");
  assert(fake.calls.every((c) => c.fn !== "increment_usage"), "tokens: no increment_usage");
}

// recordTokenUsage swallows RPC error
{
  const fake = makeFakeRpcClient({
    tokens: { data: null, error: { message: "token write failed" } },
  });
  await recordTokenUsage(fake.client as never, USER_ID, 7);
}

assert(typeof incrementUsage === "function", "legacy incrementUsage export remains");
```

- [ ] **Step 2: Run RED and witness failure**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/cost.cases.test.ts
```

Expected: FAIL because `reserveAiRequest` / `recordTokenUsage` are not exported. Save the exact error text.

Do **not** implement `cost.ts` in this task.

- [ ] **Step 3: Stop for commit authorization**

Suggested commit (only after Nastya explicitly authorizes this RED):

```text
[agent] test: red atomic quota wrappers
```

Files: only `cost.cases.test.ts`.

---

### Task 3: GREEN - implement Edge wrappers in `cost.ts`

**Files:**
- Modify: `supabase/functions/_shared/cost.ts`
- Test: `supabase/functions/_shared/cost.cases.test.ts`

**Interfaces:**
- Consumes: Task 2 RED contracts
- Produces: working `reserveAiRequest` + `recordTokenUsage`

- [ ] **Step 1: Add minimal implementations after `incrementUsage`**

```ts
const ALLOWED_TIERS = new Set<UsageTier>(["free", "basic", "premium"]);
const ALLOWED_DENY_REASONS = new Set([
  "suspended",
  "daily_limit",
  "missing_tier",
]);

function failClosedLimitCheck(): RateLimitResult {
  return { allowed: false, tier: "free", reason: "limit_check_error" };
}

export async function reserveAiRequest(
  supabase: SupabaseClient,
  userId: string,
): Promise<RateLimitResult> {
  const { data, error } = await supabase.rpc("reserve_ai_request", {
    p_user_id: userId,
  });

  if (error) return failClosedLimitCheck();
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return failClosedLimitCheck();
  }

  const payload = data as {
    allowed?: unknown;
    tier?: unknown;
    reason?: unknown;
  };

  if (typeof payload.tier !== "string" || !ALLOWED_TIERS.has(payload.tier as UsageTier)) {
    return failClosedLimitCheck();
  }
  const tier = payload.tier as UsageTier;

  if (payload.allowed === true) {
    return { allowed: true, tier };
  }

  if (payload.allowed !== false) return failClosedLimitCheck();
  if (typeof payload.reason !== "string" || !ALLOWED_DENY_REASONS.has(payload.reason)) {
    return failClosedLimitCheck();
  }

  return { allowed: false, tier, reason: payload.reason };
}

export async function recordTokenUsage(
  supabase: SupabaseClient,
  userId: string,
  tokens: number,
): Promise<void> {
  const { error } = await supabase.rpc("add_ai_token_usage", {
    p_user_id: userId,
    p_tokens: tokens,
  });
  if (error) console.error("[cost] recordTokenUsage:", error.message);
}
```

Rules:

- Do not remove or change `checkRateLimit` / `incrementUsage` exports.
- Do not call `increment_usage` from `recordTokenUsage`.
- Do not add monthly hard-deny logic.

- [ ] **Step 2: Re-run wrapper suite**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/cost.cases.test.ts
```

Expected: exit `0`.

- [ ] **Step 3: Re-run Variant A siblings**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/authUser.cases.test.ts
.\node_modules\.bin\tsx.cmd src/lib/ai/client.cases.test.ts
```

Expected: exit `0`.

- [ ] **Step 4: Stop for commit authorization**

Suggested message:

```text
[agent] feat: add atomic quota edge wrappers
```

---

### Task 4: RED/GREEN - shared quota deny HTTP mapping

**Files:**
- Create: `supabase/functions/_shared/quotaDenyResponse.ts`
- Create: `supabase/functions/_shared/quotaDenyResponse.cases.test.ts`

**Interfaces:**
- Consumes: deny reason strings
- Produces:

```ts
export type QuotaDenyHttp = {
  status: number;
  body: Record<string, unknown>;
};

export function mapQuotaDenyResponse(
  reason: string | undefined,
  calm: { suspended: string; rateLimit: string },
): QuotaDenyHttp
```

| reason | status | body |
|--------|--------|------|
| `suspended` | 429 | `{ content: calm.suspended }` |
| `daily_limit` | 429 | `{ content: calm.rateLimit }` |
| `missing_tier` | 503 | `{ error: "service_unavailable" }` |
| `limit_check_error` / other / undefined | 503 | `{ error: "service_unavailable" }` |

- [ ] **Step 1: Write RED tests**

```ts
import { mapQuotaDenyResponse } from "./quotaDenyResponse.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const calm = { suspended: "S", rateLimit: "R" };

{
  const r = mapQuotaDenyResponse("suspended", calm);
  assert(r.status === 429 && r.body.content === "S", "suspended");
}
{
  const r = mapQuotaDenyResponse("daily_limit", calm);
  assert(r.status === 429 && r.body.content === "R", "daily");
}
{
  const r = mapQuotaDenyResponse("missing_tier", calm);
  assert(r.status === 503 && r.body.error === "service_unavailable", "missing");
}
{
  const r = mapQuotaDenyResponse("limit_check_error", calm);
  assert(r.status === 503 && r.body.error === "service_unavailable", "error");
}
{
  const r = mapQuotaDenyResponse(undefined, calm);
  assert(r.status === 503, "undefined");
}

console.log("=== quotaDenyResponse.cases.test.ts OK ===");
```

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/quotaDenyResponse.cases.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement GREEN**

```ts
export type QuotaDenyHttp = {
  status: number;
  body: Record<string, unknown>;
};

export function mapQuotaDenyResponse(
  reason: string | undefined,
  calm: { suspended: string; rateLimit: string },
): QuotaDenyHttp {
  if (reason === "suspended") {
    return { status: 429, body: { content: calm.suspended } };
  }
  if (reason === "daily_limit") {
    return { status: 429, body: { content: calm.rateLimit } };
  }
  return { status: 503, body: { error: "service_unavailable" } };
}
```

- [ ] **Step 4: Run GREEN**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/quotaDenyResponse.cases.test.ts
```

Expected: exit `0`.

- [ ] **Step 5: Stop for commit authorization**

Suggested message:

```text
[agent] feat: map quota denies to 429/503
```

---

### Task 5: Retired after provider-boundary review

**Status:** retired (do not recreate).

Late model-only gate seam was an incorrect architecture: it reserved immediately before the first `callModel` while earlier provider-backed paths (eager conversation summary / related AI work) could still run without an authoritative daily slot. After review, the handler uses an early `reserveAiRequest` barrier before **all** provider-backed seams. The gate module and its case suite were removed; do not add Task/code/commands that recreate it.

---

### Task 6: RED - migration contract test (before SQL exists)

**Files:**
- Create: `supabase/functions/_shared/atomicQuotaMigration.cases.test.ts`
- Do **not** create migration `031` yet

**Interfaces:**
- Consumes: filesystem path to `supabase/migrations/20260730120000_031_atomic_chat_quota.sql`
- Produces: static SQL architecture assertions (not a live DB concurrency proof)

- [ ] **Step 1: Write RED test that fails because migration is missing**

```ts
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Extract one CREATE FUNCTION ... $$ ... $$; block by function name. */
function extractFunctionSql(sql: string, fnName: string): string {
  const re = new RegExp(
    String.raw`CREATE OR REPLACE FUNCTION public\.${fnName}\s*\([\s\S]*?\$\$;`,
    "i",
  );
  const match = sql.match(re)?.[0] ?? "";
  assert(match.length > 0, `function ${fnName} block must be extractable`);
  return match;
}

/** Body between the first AS $$ and the closing $$; of that function block. */
function extractFunctionBody(fnSql: string): string {
  const start = fnSql.search(/AS\s*\$\$/i);
  assert(start >= 0, "AS $$ marker required");
  const after = fnSql.slice(start + fnSql.slice(start).match(/AS\s*\$\$/i)![0].length);
  const end = after.lastIndexOf("$$");
  assert(end >= 0, "closing $$ required");
  return after.slice(0, end);
}

const migrationPath = resolve(
  "supabase/migrations/20260730120000_031_atomic_chat_quota.sql",
);

assert(existsSync(migrationPath), "migration 031 must exist");

const sql = readFileSync(migrationPath, "utf8");

const reserveSql = extractFunctionSql(sql, "reserve_ai_request");
const tokenSql = extractFunctionSql(sql, "add_ai_token_usage");
const reserveBody = extractFunctionBody(reserveSql);
const tokenBody = extractFunctionBody(tokenSql);

// Per-function security + search_path (header of each CREATE block, not whole file)
assert(/SECURITY DEFINER/i.test(reserveSql), "reserve SECURITY DEFINER");
assert(/SET search_path\s*=\s*''/i.test(reserveSql), "reserve empty search_path");
assert(!/SET search_path\s*=\s*public/i.test(reserveSql), "reserve must not use search_path public");

assert(/SECURITY DEFINER/i.test(tokenSql), "token SECURITY DEFINER");
assert(/SET search_path\s*=\s*''/i.test(tokenSql), "token empty search_path");
assert(!/SET search_path\s*=\s*public/i.test(tokenSql), "token must not use search_path public");

// Signature / schema qualification
assert(/reserve_ai_request\s*\(\s*p_user_id\s+uuid\s*\)/i.test(reserveSql), "reserve signature");
assert(/add_ai_token_usage\s*\(\s*p_user_id\s+uuid\s*,\s*p_tokens\s+integer\s*\)/i.test(tokenSql), "token signature");
assert(/FROM public\.user_usage_tiers/i.test(reserveBody), "reserve schema-qualified table");
assert(/UPDATE public\.user_usage_tiers/i.test(tokenBody), "token schema-qualified table");
assert(/FOR UPDATE/i.test(reserveBody), "reserve locks with FOR UPDATE");

// daily_requests_used only in reserve body
assert(/daily_requests_used/i.test(reserveBody), "reserve body owns daily_requests_used");
assert(
  /daily_requests_used\s*=\s*daily_requests_used\s*\+\s*1/i.test(reserveBody),
  "daily increment only in reserve body",
);
assert(!/daily_requests_used/i.test(tokenBody), "token body must not contain daily_requests_used");

// token guards + no monthly hard deny inside token body only
assert(/p_tokens\s+IS NULL\s+OR\s+p_tokens\s*<\s*0/i.test(tokenBody), "null/negative token guard");
assert(
  !/monthly_token_limit|hard\s+deny|RAISE[\s\S]*monthly/i.test(tokenBody),
  "no monthly hard deny in token body",
);

// Grants (file-level, both RPCs)
assert(/REVOKE ALL ON FUNCTION public\.reserve_ai_request\(uuid\) FROM PUBLIC/i.test(sql), "revoke public reserve");
assert(/REVOKE ALL ON FUNCTION public\.reserve_ai_request\(uuid\) FROM anon/i.test(sql), "revoke anon reserve");
assert(/REVOKE ALL ON FUNCTION public\.reserve_ai_request\(uuid\) FROM authenticated/i.test(sql), "revoke auth reserve");
assert(/GRANT EXECUTE ON FUNCTION public\.reserve_ai_request\(uuid\) TO service_role/i.test(sql), "grant reserve service_role");

assert(/REVOKE ALL ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) FROM PUBLIC/i.test(sql), "revoke public tokens");
assert(/REVOKE ALL ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) FROM anon/i.test(sql), "revoke anon tokens");
assert(/REVOKE ALL ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) FROM authenticated/i.test(sql), "revoke auth tokens");
assert(/GRANT EXECUTE ON FUNCTION public\.add_ai_token_usage\(uuid,\s*integer\) TO service_role/i.test(sql), "grant tokens service_role");

assert(!/DROP\s+FUNCTION\s+.*increment_usage/i.test(sql), "must not drop legacy increment_usage");
assert(!/CREATE OR REPLACE FUNCTION public\.increment_usage/i.test(sql), "031 must not rewrite increment_usage");

console.log("=== atomicQuotaMigration.cases.test.ts OK ===");
```

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/atomicQuotaMigration.cases.test.ts
```

Expected: FAIL with `migration 031 must exist` (or equivalent existsSync assertion).

- [ ] **Step 3: Stop for commit authorization** (optional RED-only commit)

Suggested message:

```text
[agent] test: red atomic quota migration contract
```

---

### Task 7: GREEN - create migration `031`

**Files:**
- Create: `supabase/migrations/20260730120000_031_atomic_chat_quota.sql`
- Test: `supabase/functions/_shared/atomicQuotaMigration.cases.test.ts`

**Interfaces:**
- Consumes: Task 6 RED contract
- Produces: additive SQL RPCs

- [ ] **Step 1: Write migration SQL**

```sql
-- 031_atomic_chat_quota
-- Additive only. Does not alter legacy public.increment_usage.

CREATE OR REPLACE FUNCTION public.reserve_ai_request(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_row public.user_usage_tiers%ROWTYPE;
BEGIN
  SELECT *
  INTO v_row
  FROM public.user_usage_tiers
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'tier', 'free',
      'reason', 'missing_tier'
    );
  END IF;

  IF v_row.is_suspended THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'suspended'
    );
  END IF;

  IF v_now - v_row.day_reset_at > interval '24 hours' THEN
    UPDATE public.user_usage_tiers
    SET
      daily_requests_used = 1,
      day_reset_at = v_now,
      updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'allowed', true,
      'tier', v_row.tier
    );
  END IF;

  IF v_row.daily_requests_used >= v_row.daily_request_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'tier', v_row.tier,
      'reason', 'daily_limit'
    );
  END IF;

  UPDATE public.user_usage_tiers
  SET
    daily_requests_used = daily_requests_used + 1,
    updated_at = v_now
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'tier', v_row.tier
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.add_ai_token_usage(p_user_id uuid, p_tokens integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_tokens IS NULL OR p_tokens < 0 THEN
    RAISE EXCEPTION 'p_tokens must be non-null and non-negative';
  END IF;

  UPDATE public.user_usage_tiers
  SET
    monthly_tokens_used = CASE
      WHEN v_now - month_reset_at > interval '30 days' THEN p_tokens
      ELSE monthly_tokens_used + p_tokens
    END,
    month_reset_at = CASE
      WHEN v_now - month_reset_at > interval '30 days' THEN v_now
      ELSE month_reset_at
    END,
    updated_at = v_now
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing user_usage_tiers row for %', p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_ai_request(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_request(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.add_ai_token_usage(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_ai_token_usage(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.add_ai_token_usage(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.add_ai_token_usage(uuid, integer) TO service_role;
```

- [ ] **Step 2: Run migration contract GREEN**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/atomicQuotaMigration.cases.test.ts
```

Expected: exit `0`.

- [ ] **Step 3: Stop for commit authorization**

Suggested message:

```text
[agent] feat: add atomic chat quota SQL RPCs
```

Do **not** apply to staging/production in this task.

---

### Task 8: RED - staysee-chat architecture wiring test

**Files:**
- Create / harden: `supabase/functions/_shared/stayseeChatAtomicQuotaWiring.cases.test.ts`
- Do **not** edit `staysee-chat/index.ts` in the RED step

**Interfaces:**
- Consumes: real source text of `supabase/functions/staysee-chat/index.ts`
- Produces: `validateAtomicQuotaWiring(source)` + mutation self-checks

This test is **not** proof of concurrent atomicity. Concurrency is proven by staging parallel smoke.

Required architecture assertions (comment-stripped `Deno.serve` handler body):

- preliminary `checkRateLimit` before exactly one `reserveAiRequest`
- free guards (`safety.immediateResponse`, prompt-attack hard-stop) before reserve
- every provider seam (`runConversationSummaryRefresh(`, `callModel(`, `callModelStructured(`) after reserve
- balanced `{ ... }` for `if (!reserveResult.allowed)` contains `mapQuotaDenyResponse` + `return new Response`, contains no provider seam, and ends before the first provider seam
- exactly one `recordTokenUsage` as direct `EdgeRuntime.waitUntil(...)` argument immediately after `totalTokens` (whitespace-only gap; no `if` / ternary / `&&` / `clientConnected` / `req.signal.aborted`)
- `incrementUsage(` absent from chat-path
- mutation A: inject `callModel(...)` into deny block -> validator must reject
- mutation B: wrap `recordTokenUsage` in `if (!req.signal.aborted)` -> validator must reject

- [ ] **Step 1: Implement / harden the wiring suite as above**
- [ ] **Step 2: Run against handler until GREEN**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/stayseeChatAtomicQuotaWiring.cases.test.ts
```

Expected: real handler PASS; both mutations rejected; exit `0`.

- [ ] **Step 3: Stop for commit authorization**

Suggested message:

```text
[agent] fix: reserve quota before all provider work
```

---

### Task 9: GREEN - early reserve wiring + tracked staging smoke script

**Files:**
- Modify: `supabase/functions/staysee-chat/index.ts`
- Create: `scripts/atomic-quota-staging-smoke.mts`
- Test: wiring suite + remaining local suites

**Interfaces:**
- Consumes: `checkRateLimit`, `mapQuotaDenyResponse`, `reserveAiRequest`, `recordTokenUsage`, `makeServiceClient`
- Produces: handler order from design; tracked smoke entrypoint with **no secrets in code or output**

Fixed handler order:

1. IP velocity
2. verified auth
3. duplicate prevention
4. preliminary `checkRateLimit`
5. free message-only guards (immediateResponse + prompt-attack)
6. authoritative `reserveAiRequest` (exactly once) + deny map
7. durable memory / context / eager summary / category+guidance safety
8. main model / recovery / shadow (same reserved turn)
9. `recordTokenUsage` immediately after `totalTokens` (disconnect-independent)

- [ ] **Step 1: Wire early reserve after free guards; restore direct `callModel`**

Do **not** introduce a late model-only gate. Service-client create failure -> `503 { error: "service_unavailable" }`.

- [ ] **Step 2: Keep preliminary deny mapping**

- [ ] **Step 3: Move `recordTokenUsage` before `clientConnected` memory/summary background gating**

- [ ] **Step 4: Tracked smoke script**

`scripts/atomic-quota-staging-smoke.mts`:

- env-only credentials; staging URL must match `hdmoetcvlszrdukqpiia`
- never hardcode secrets
- print only booleans/counts/reasons
- never print JWTs, keys, emails, message bodies
- never call staysee-chat / AI providers in the RPC smoke

- [ ] **Step 5: Run local GREEN suites**

```powershell
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/cost.cases.test.ts
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/authUser.cases.test.ts
.\node_modules\.bin\tsx.cmd src/lib/ai/client.cases.test.ts
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/quotaDenyResponse.cases.test.ts
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/atomicQuotaMigration.cases.test.ts
.\node_modules\.bin\tsx.cmd supabase/functions/_shared/stayseeChatAtomicQuotaWiring.cases.test.ts
.\node_modules\.bin\tsx.cmd scripts/atomic-quota-staging-smoke.mts --dry-run
```

Expected: all exit `0`.

- [ ] **Step 6: Stop for commit authorization**

---

### Task 10: Staging validation (separate authorizations)

**Files:**
- Use migration `031`
- Use tracked `scripts/atomic-quota-staging-smoke.mts`

Hard gates before any staging command:

- Explicit Nastya authorization for that exact command class (link / db push / functions deploy / smoke)
- Exact staging project ref: `hdmoetcvlszrdukqpiia`
- No production ref in this task

- [ ] **Step 0: Mandatory read-only preflight audit (no PII)**

Before deploy/migration apply, run a **read-only** aggregate audit:

- count rows grouped by `tier` + `daily_request_limit` + `monthly_token_limit`
- never print `user_id`, email, or other PII
- treat real DB row limits as authoritative for enforcement
- Variant B must **not** automatically rewrite / normalize tariffs
- record the known `TIER_CONFIG` vs DB defaults discrepancy before deploy:
  - Edge `TIER_CONFIG.free.monthlyTokenLimit` = `200_000`
  - DB table default `monthly_token_limit` = `500000` (migrations 006/021)
  - free daily defaults currently both `50`; basic/premium exist in `TIER_CONFIG` but row values come from DB

- [ ] **Step 1: Link staging and verify project-ref**

```powershell
npx.cmd supabase link --project-ref hdmoetcvlszrdukqpiia
Get-Content supabase/.temp/project-ref
```

Expected: file contents exactly `hdmoetcvlszrdukqpiia`. If not -> **STOP**.

- [ ] **Step 2: Dry-run migration**

```powershell
npx.cmd supabase db push --linked --dry-run
```

Manually confirm the pending migration set contains **only** `20260730120000_031_atomic_chat_quota.sql` (or only the expected additive 031 if earlier heads already match). If anything else appears -> **STOP**.

- [ ] **Step 3: Apply migration (separate authorization)**

```powershell
npx.cmd supabase db push --linked
```

Verify on staging:

- both RPCs exist
- `SECURITY DEFINER`
- `search_path` empty
- EXECUTE for `service_role` only
- revoked from `PUBLIC` / `anon` / `authenticated`

- [ ] **Step 4: Deploy Edge to staging (separate authorization)**

```powershell
npx.cmd supabase functions deploy staysee-chat --project-ref hdmoetcvlszrdukqpiia
```

Re-check `supabase/.temp/project-ref` is still staging before deploy if link state could have drifted.

- [ ] **Step 5: RPC concurrency smoke (separate authorization)**

```powershell
.\node_modules\.bin\tsx.cmd scripts/atomic-quota-staging-smoke.mts
```

Required checks:

- remaining=1 + two parallel reserves -> exactly one allow
- expired day window -> reset + one allow
- token RPC changes monthly counters only
- deny path never reaches AI
- restore fixtures

No secrets in script output.

- [ ] **Step 6: Future handler parallel check (do not run without separate authorization)**

Separate future check (not part of the RPC smoke; requires explicit permission for one paid provider call):

- authenticated temp user
- remaining daily slot = 1
- two parallel handler (`staysee-chat`) requests
- expect exactly one allowed AI path and one quota deny
- at most one billable main model request
- requires separate explicit authorization for that single provider call
- cleanup temp user/rows afterward

Do **not** run Step 6 in this cleanup or without that authorization.

---

### Task 11: Production checklist (separate authorizations; staging must be GREEN)

Hard gates:

- Explicit production authorization per action
- Exact production project ref: `jnxrildlwvtxhtiwucbt`
- Staging evidence from Task 10 complete
- Draft/Ready/merge already handled under Delivery order before this task, unless production hotfix authorization says otherwise

- [ ] **Step 1: Re-link production and verify project-ref**

```powershell
npx.cmd supabase link --project-ref jnxrildlwvtxhtiwucbt
Get-Content supabase/.temp/project-ref
```

Expected: exactly `jnxrildlwvtxhtiwucbt`. If not -> **STOP**.

- [ ] **Step 2: Dry-run then apply migration (separate authorization)**

```powershell
npx.cmd supabase db push --linked --dry-run
```

Manually confirm only `031` is pending, then:

```powershell
npx.cmd supabase db push --linked
```

- [ ] **Step 3: Deploy Edge (separate authorization)**

```powershell
npx.cmd supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

- [ ] **Step 4: Production smoke (separate authorization)**

- Variant A auth/security still holds
- one authorized AI smoke
- no secret/JWT dumps

- [ ] **Step 5: Rollback readiness (do not execute unless authorized)**

1. Redeploy `staysee-chat` from pre-Variant-B commit -> preliminary `checkRateLimit` + post-call `incrementUsage`
2. Leave additive RPCs unused (no emergency `DROP FUNCTION`)

---

## Self-review checklist (plan author)

- Spec coverage: preliminary keep, free guards before reserve, early reserve before all provider seams, monthly-only tokens, disconnect-independent accounting, `search_path=''`, grants, error mapping 429/503, concurrency caveat, rollback, non-goals -> each has a task.
- Handler proof is source wiring regression (`validateAtomicQuotaWiring`) with mutation self-checks; concurrency is staging parallel smoke only.
- Migration has its own RED before SQL exists; each RPC body is extracted separately for SECURITY DEFINER / `search_path=''` / daily vs monthly checks.
- `add_ai_token_usage` null/negative guard is explicit.
- `reserveAiRequest` rejects unknown tier/reason/malformed payloads.
- Late model-only gate retired after provider-boundary review (Task 5).
- Staging preflight requires read-only aggregate tier-limit audit without PII; DB row limits are authoritative; no automatic tariff rewrites.
- Staging checklist includes a future authorized handler parallel check (not run by default).
- Staging flow uses exact `link` / `.temp/project-ref` / dry-run / push commands.
- Delivery order includes commit/push/Draft PR/staging/prod gates as separately authorized steps.
- Tracked smoke path is `scripts/atomic-quota-staging-smoke.mts`.
- No TBD/TODO placeholders.
- Document encoding uses plain ASCII arrows (`->`) and exact worktree path `D:\Staisy-main Приложение\Staysee-app-atomic-chat-quota`.
