# Memory V3 Full Product Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Memory V3 lifecycle read/write for every authenticated StaySEE account with one-run-per-day cost control and privacy-safe Telegram fallback alerts.

**Architecture:** Extend the existing closed eligibility gates with explicit all-account modes while retaining exact-account canary rollback. Add a service-role hourly alert reservation plus a dependency-injected Telegram sender, then wire both read and write failures into background alerts without changing the reply path.

**Tech Stack:** TypeScript, Deno/Supabase Edge Functions, PostgreSQL/PLpgSQL, pgTAP, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-22-memory-v3-full-product-rollout-design.md`

## Global Constraints

- Preserve `off`, `shadow`, `lifecycle_shadow`, and `canary` behavior exactly.
- New writer mode is exactly `lifecycle_all`; new reader mode is exactly `all`.
- Unknown modes fail closed to `off`.
- All-account modes require a canonical authenticated UUID and never accept wildcards or lists.
- Restore the database daily lifecycle reservation cap to one per UTC day per account.
- Telegram alerts contain only fixed labels, closed diagnostics, and UTC time; no PII, dialogue, memory, raw error, or secret.
- Suppress the same path/code alert globally for one UTC hour.
- Alert failures never affect replies and never retry.
- Do not modify lifecycle extractor, reconciler, reducer, evidence semantics, or historical artifacts.
- Do not stage `supabase/.temp/cli-latest`, `narrativeEngine.cases.test.ts`, `.superpowers/`, `supabase/.branches/`, or any `_tmp-*` file.
- No paid/provider benchmark without a new explicit authorization.

---

### Task 1: Explicit all-account eligibility modes

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/mode.ts`
- Modify: `supabase/functions/_shared/memoryV3/mode.cases.test.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReadMode.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts`

**Interfaces:**
- Produces: `MemoryV3ShadowMode = "off" | "shadow" | "lifecycle_shadow" | "lifecycle_all"`.
- Produces: `MemoryV3LifecycleReadMode = "off" | "canary" | "all"`.
- Preserves the existing resolver input shapes and error brands.

- [ ] **Step 1: Write failing mode tests**

Add tests proving `lifecycle_all` and `all` accept two different canonical UUIDs
without an allowlist, while existing canary modes still require an exact match.
Add negative cases for malformed user IDs, wrapper strings, wildcard/list mode
values, accessors, symbols, inherited fields, and unknown modes.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npx tsx --test supabase/functions/_shared/memoryV3/mode.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts
```

Expected: the new all-account assertions fail because both parsers currently
return `off`.

- [ ] **Step 3: Implement minimal closed-mode logic**

Implement exact parsing and branch the resolvers after canonical `userId`
validation:

```ts
if (mode === "lifecycle_all") {
  return { eligible: true, mode, userId: projected.userId };
}
```

and:

```ts
if (mode === "all") {
  return { eligible: true, mode, userId: projected.userId };
}
```

Keep the exact-account checks for `shadow`, `lifecycle_shadow`, and `canary`.

- [ ] **Step 4: Verify GREEN and regressions**

Run the targeted command from Step 2 and the existing lifecycle wiring tests.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/memoryV3/mode.ts supabase/functions/_shared/memoryV3/mode.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReadMode.ts supabase/functions/_shared/memoryV3/lifecycleReadMode.cases.test.ts
git commit -m "[agent] feat: add full-audience Memory V3 modes"
```

### Task 2: Database cap and alert reservation

**Files:**
- Create: `supabase/migrations/20260922120000_038_memory_v3_full_rollout_alerts.sql`
- Create: `supabase/tests/database/038_memory_v3_full_rollout_alerts.test.sql`
- Create: `supabase/functions/_shared/memoryV3/fullRolloutMigration.cases.test.ts`

**Interfaces:**
- Produces RPC: `reserve_memory_v3_alert_window(p_alert_key text) RETURNS boolean`.
- Accepts only `read:load_failed`, `read:invalid_shape`, `read:too_large`, and `write:<closed lifecycle diagnostic>` keys.
- Replaces `reserve_memory_v3_lifecycle_shadow_run(...)` with the same signature and behavior except `v_daily_count >= 1`.

- [ ] **Step 1: Write failing source and pgTAP contracts**

The TypeScript source test must require migration/test files, threshold one,
security-definer/search-path hardening, RLS, closed alert keys, one-hour UTC
windowing, fourteen-day cleanup, and service-role-only execution. pgTAP must
prove the first reservation is true, the duplicate is false, a different key is
true, invalid keys fail, and public roles lack table/function access.

- [ ] **Step 2: Verify RED**

```powershell
npx tsx --test supabase/functions/_shared/memoryV3/fullRolloutMigration.cases.test.ts
```

Expected: fail because migration 038 and its pgTAP file do not exist.

- [ ] **Step 3: Implement migration 038**

Create the private window table with `(alert_key, window_start)` primary key and
an RPC that computes `date_trunc('hour', now() AT TIME ZONE 'UTC')`, deletes rows
older than fourteen days, inserts with `ON CONFLICT DO NOTHING`, and returns
whether insertion occurred. Copy the full reservation function from migration
035 and change only its daily-cap comparison from five to one.

- [ ] **Step 4: Verify GREEN**

Run the source test. If a local Supabase database is available, run the new pgTAP
file through the established database test command; otherwise retain the source
contract and run pgTAP during production migration verification before activation.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260922120000_038_memory_v3_full_rollout_alerts.sql supabase/tests/database/038_memory_v3_full_rollout_alerts.test.sql supabase/functions/_shared/memoryV3/fullRolloutMigration.cases.test.ts
git commit -m "[agent] feat: add Memory V3 rollout safety controls"
```

### Task 3: Privacy-safe Telegram alert boundary

**Files:**
- Create: `supabase/functions/_shared/memoryV3/telegramAlert.ts`
- Create: `supabase/functions/_shared/memoryV3/telegramAlert.cases.test.ts`

**Interfaces:**
- Produces `sendMemoryV3TelegramAlertSafely(options): Promise<void>`.
- Injects `reserveAlertKey(key): Promise<boolean>` and `fetchImpl`.
- Consumes primitive token/chat ID, `path: "read" | "write"`, and closed diagnostic.

- [ ] **Step 1: Write failing sender tests**

Cover sent, deduplicated, missing-secret, reservation failure, HTTP failure,
malformed response, thrown/revoked/proxy inputs, fixed URL/body construction,
and proof that token, chat ID, UUID, dialogue, raw error, and arbitrary sentinels
never appear in returned values or logs.

- [ ] **Step 2: Verify RED**

```powershell
npx tsx --test supabase/functions/_shared/memoryV3/telegramAlert.cases.test.ts
```

Expected: module-not-found RED.

- [ ] **Step 3: Implement the minimal sender**

Validate options through own enumerable data descriptors, reserve the fixed
path/code key, and perform one POST to Telegram `sendMessage`. Use a fixed message
template and swallow every error without exposing a cause. Never retry.

- [ ] **Step 4: Verify GREEN**

Run the targeted sender test and `node --check` through the repository's existing
TypeScript execution path.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/memoryV3/telegramAlert.ts supabase/functions/_shared/memoryV3/telegramAlert.cases.test.ts
git commit -m "[agent] feat: alert on Memory V3 fallback"
```

### Task 4: Product wiring and multi-account isolation

**Files:**
- Modify: `supabase/functions/staysee-chat/index.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts`
- Create: `supabase/functions/_shared/memoryV3/fullRolloutWiring.cases.test.ts`

**Interfaces:**
- `STAYSEE_MEMORY_V3_MODE=lifecycle_all` selects the lifecycle writer for every canonical authenticated account.
- `STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE=all` selects the lifecycle reader for every canonical authenticated account.
- Telegram secrets are read only in the Edge Function composition root.

- [ ] **Step 1: Write failing source/wiring tests**

Use at least three synthetic UUIDs. Prove each account loads/writes only its own
state, missing state preserves legacy memory, authoritative empty suppresses
legacy resurrection, read errors and write failures schedule one alert, daily-cap
and duplicate skips do not alert, and absent Telegram secrets preserve logging.

- [ ] **Step 2: Verify RED**

Run the three wiring tests. Expected failures: `lifecycle_all` is not routed to
the lifecycle runner, `all` is not routed to the reader, and no alert is scheduled.

- [ ] **Step 3: Implement composition-root wiring**

Route both lifecycle writer modes to the existing runner. Build a service-role
reservation callback for `reserve_memory_v3_alert_window`. On read diagnostic or
write failure, log the existing safe code and schedule the safe sender with
`EdgeRuntime.waitUntil`. Do not await alert delivery in the reply path.

- [ ] **Step 4: Verify GREEN and full offline gate**

Run targeted wiring, all Memory V3 TypeScript tests, all Memory V3 MJS tests,
typecheck, lint, production build/verifier, `git diff --check`, secret/privacy
scans, and confirm protected/untracked files are excluded.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/staysee-chat/index.ts supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts supabase/functions/_shared/memoryV3/fullRolloutWiring.cases.test.ts
git commit -m "[agent] feat: enable guarded Memory V3 product rollout"
```

### Task 5: Documentation, integration, deployment, and proof

**Files:**
- Modify: `scripts/memory-v3-pilot/README.md`
- Verify: all files from Tasks 1-4

**Interfaces:**
- Documents exact activation and rollback values.
- Does not authorize a separate provider benchmark.

- [ ] **Step 1: Write a failing documentation contract**

Require the README to state all-account modes, one-run daily cap, missing-head
legacy behavior, Telegram hourly deduplication, privacy exclusions, secondary
existing-account smoke, and rollback to canary/off.

- [ ] **Step 2: Verify RED, update README, verify GREEN**

Run the documentation contract before and after the README edit.

- [ ] **Step 3: Run final verification before integration**

Repeat the full offline gate, inspect `git status`, `git diff`, every staged path,
and verify no secret or `_tmp-*` artifact is staged.

- [ ] **Step 4: Integrate**

Push the feature branch, open a PR to `main`, attach it to the task, review the PR,
merge only after green evidence, and fetch the exact merge SHA.

- [ ] **Step 5: Deploy in safe order**

Apply migration 038 and run read-only structural checks. Configure Telegram token
and chat ID as Supabase secrets without printing their values. Deploy only
`staysee-chat`. Activate `STAYSEE_MEMORY_V3_MODE=lifecycle_all` and
`STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE=all`, retaining the canary UUID secrets for
rollback.

- [ ] **Step 6: Production proof**

Confirm the function is ACTIVE, migration 038 is recorded, cap and alert RPC are
present, and no new failure diagnostics appear. Use one existing secondary account
for a short message sequence, then verify account-isolated state and read behavior
without exposing its content. Trigger only a synthetic injected alert test if it
does not call a model; a separate paid/provider test requires explicit approval.

- [ ] **Step 7: Final record**

Record merge SHA, function version, migration version, activation modes, test
totals, secondary-account proof, Telegram delivery proof, rollback command, and
the fact that no extra paid benchmark was run.

## Self-review

- Spec coverage: audience, fallback, cost cap, Telegram privacy/deduplication,
  migration, tests, activation, smoke, and rollback each map to a task.
- Placeholder scan: no deferred implementation markers or unspecified error handling.
- Type consistency: `lifecycle_all`, `all`, alert path/code, and RPC names are stable across tasks.
- Scope: extractor/reconciler/reducer/history artifacts remain frozen.
