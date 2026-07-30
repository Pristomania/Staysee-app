# Atomic Chat Quota — Design

Date: 2026-07-30  
Branch: `fix/atomic-chat-quota`  
Base: `origin/main` @ `a374254e117b104e5f94e392741174edb0f76dc1`  
Approach: A — atomic `reserve_ai_request` RPC (no reservation ledger)

## Goal

Close the parallel daily-limit bypass: before the first model/provider call, atomically reserve exactly one daily request slot for the verified user.

## Non-goals

- Do not change frontend/client.
- Do not change prompt, model routing, or memory.
- Do not add a hard monthly token deny.
- Do not add a reservation ledger or `requestId` idempotency table.
- Do not return (refund) a daily slot after provider/network failure once reserve succeeded.
- Do not fix the repository-wide CI/typecheck baseline.

## Product semantics

- Auth, IP velocity, and in-memory dedup run before quota.
- Safety `immediateResponse` and explicit prompt-attack hard-stop paths do **not** consume a daily slot.
- Atomic reserve runs **immediately before the first provider/model call** (`callModel`).
- One user turn consumes one daily slot even when that turn later performs recovery, fallback, or shadow provider calls.
- After a successful reserve, the slot is never returned.
- Abort or early return **before** reserve does not consume a slot.
- Abort or provider failure **after** reserve consumes the slot (cost protection, not free retry).
- Monthly tokens are recorded from actual usage after the model response path.

## Architecture

Approach A only:

1. New SQL RPC `public.reserve_ai_request(p_user_id uuid) RETURNS jsonb`.
2. New SQL RPC `public.add_ai_token_usage(p_user_id uuid, p_tokens integer)`.
3. Wrappers in `supabase/functions/_shared/cost.ts`:
   - `reserveAiRequest`
   - `recordTokenUsage`
4. `staysee-chat` calls `reserveAiRequest` exactly once, immediately before the first `callModel`.
5. The chat-path post-call `incrementUsage` is replaced with `recordTokenUsage`.
6. Legacy `checkRateLimit` and `incrementUsage` remain in the codebase for compatibility/rollback in this change, but `staysee-chat` stops using them.

Approaches B (reservation ledger) and C (advisory lock across check+increment) are out of implementation scope.

## Migration file

Create one additive migration immediately after the latest applied version `20260701120000_030_protocol_events`:

- `supabase/migrations/20260730120000_031_atomic_chat_quota.sql`

The migration must:

- define both RPCs with schema-qualified `public.*` names;
- set a safe `search_path` (`public` only, matching existing SECURITY DEFINER pattern);
- `REVOKE ALL` from `PUBLIC`, `anon`, and `authenticated`;
- `GRANT EXECUTE` to `service_role` only (same security pattern as migration 025 for `increment_usage`);
- not drop or alter legacy `increment_usage` in this PR.

## `reserve_ai_request` contract

### Security

- `SECURITY DEFINER`
- schema-qualified `public.*`
- safe `search_path`
- `EXECUTE` for `service_role` only
- revoked from `PUBLIC` / `anon` / `authenticated`

### Behavior (single transaction)

1. `SELECT ... FROM public.user_usage_tiers WHERE user_id = p_user_id FOR UPDATE`.
2. Missing row → `{ "allowed": false, "tier": "free", "reason": "missing_tier" }` (do not auto-create).
3. `is_suspended` → `{ "allowed": false, "tier": <current>, "reason": "suspended" }` with no increment.
4. Day window reset uses the **same operator/interval as current `increment_usage`**:
   - expire when `v_now - day_reset_at > interval '24 hours'`
   - on expire: set `daily_requests_used` to the reserved unit (`1` on allow path after reset) and set `day_reset_at = v_now`
5. If not expired and `daily_requests_used >= daily_request_limit` → `{ "allowed": false, "tier": <current>, "reason": "daily_limit" }` with no increment.
6. On allow: set `daily_requests_used = daily_requests_used + 1` (or `1` after day reset), update `updated_at`, return `{ "allowed": true, "tier": <current tier> }`.
7. Do **not** check monthly token limits.
8. Unexpected SQL failures are not rewritten inside the RPC into a soft allow; the Edge wrapper maps Supabase/RPC transport errors to fail-closed `limit_check_error`.

### Day-window compatibility note

Existing `public.increment_usage` (migrations 007 / 021) uses:

```sql
v_now - user_usage_tiers.day_reset_at > interval '24 hours'
```

`reserve_ai_request` must use that exact comparison so product day boundaries do not change relative to post-call token accounting / historical counters.

## `add_ai_token_usage` contract

### Security

- `SECURITY DEFINER`
- schema-qualified `public.*`
- safe `search_path`
- `EXECUTE` for `service_role` only
- revoked from `PUBLIC` / `anon` / `authenticated`

### Behavior

- Input: verified `p_user_id`, non-negative `p_tokens`.
- Lock the user tier row (`FOR UPDATE` / equivalent conflict update on the same primary key).
- Missing row or negative `p_tokens` → SQL error (Edge treats as best-effort accounting failure).
- Month window reset uses the **same operator/interval as current `increment_usage`**:
  - expire when `v_now - month_reset_at > interval '30 days'`
  - on expire: set `monthly_tokens_used` from this call’s tokens and set `month_reset_at = v_now`
- Otherwise add `p_tokens` to `monthly_tokens_used`.
- Never modify `daily_requests_used`.
- Edge calls this best-effort after the model response path.
- Token-accounting failure does not refund the daily slot and does not alter the already-built HTTP response.

## Edge wrappers (`cost.ts`)

### `reserveAiRequest(serviceSupabase, userId)`

- Calls `rpc('reserve_ai_request', { p_user_id: userId })`.
- On RPC/transport/parse error → `{ allowed: false, tier: "free", reason: "limit_check_error" }`.
- On JSON payload with `allowed: false` → pass through `reason` / `tier`.
- On `allowed: true` → return `{ allowed: true, tier }`.

### `recordTokenUsage(serviceSupabase, userId, tokens)`

- Calls `rpc('add_ai_token_usage', { p_user_id: userId, p_tokens: tokens })`.
- Logs errors; does not throw into the user response path.
- Must not call legacy `increment_usage`.

Legacy `checkRateLimit` / `incrementUsage` remain exported for rollback compatibility but are unused by `staysee-chat` after this change.

## Handler wiring (`staysee-chat/index.ts`)

Keep current order through auth and early free paths:

1. IP velocity
2. verified auth (`resolveVerifiedChatUser`)
3. duplicate prevention
4. durable memory / context / safety evaluation
5. safety `immediateResponse` return (no reserve)
6. explicit prompt-attack hard-stop return (no reserve)
7. build prompts / budgets
8. **`reserveAiRequest` via service-role client**
9. on deny/error → respond without provider
10. first `callModel` (and any recovery/shadow calls for the same turn)
11. replace post-call `incrementUsage(...)` with `recordTokenUsage(...)`

### Handler responses for reserve outcomes

| Reason | HTTP response |
|--------|----------------|
| `suspended` | existing suspended/rate calm body (same mapping as today’s rate-limit path) |
| `daily_limit` | existing 429 calm rate-limit body |
| `missing_tier` | `503` `{ "error": "service_unavailable" }` |
| RPC/DB / `limit_check_error` | `503` `{ "error": "service_unavailable" }` |

Provider/model must not be called on any reserve deny or reserve error.

Remove the early read-only `checkRateLimit` call that currently runs before memory/context; quota enforcement moves to the pre-`callModel` reserve. Auth/IP/dedup remain before that work as today.

## Concurrency guarantee

When `daily_request_limit - daily_requests_used = 1` for one user, two concurrent `reserve_ai_request` calls:

- exactly one returns `allowed: true`;
- the other returns `daily_limit`;
- the final `daily_requests_used` increases by exactly 1;
- the row lock is held only for the short SQL transaction and **not** during the model call.

## Testing

### Local RED/GREEN (tsx case tests, no Docker required)

- wrapper maps RPC allow payload;
- suspended / daily_limit / missing_tier deny mapping;
- RPC/transport error → fail-closed `limit_check_error`;
- `recordTokenUsage` calls only `add_ai_token_usage`;
- handler seam: reserve deny/error → provider fetch count stays 0;
- chat-path no longer invokes legacy post-call daily `increment_usage`.

### Staging

- apply migration `031`;
- verify EXECUTE grants (service_role only);
- remaining=1 + two parallel reserves → one allow;
- expired day window → reset + one allow;
- token RPC changes monthly counters only;
- deny path never reaches AI;
- after concurrency fixtures restore, one valid authorized model smoke.

### Production

- counts/preflight;
- migration first;
- Edge `staysee-chat` deploy second;
- security smokes + one authorized smoke;
- rollback plan: redeploy Edge to the pre-B commit; additive SQL functions may remain unused temporarily (no automatic `DROP FUNCTION` as part of rollback).

## Required files

- `supabase/migrations/20260730120000_031_atomic_chat_quota.sql`
- `supabase/functions/_shared/cost.ts`
- `supabase/functions/_shared/cost.cases.test.ts`
- `supabase/functions/staysee-chat/index.ts`
- optional local case-test only for the handler/provider seam if wiring cannot be covered from `cost.cases.test.ts` alone
- staging concurrency smoke script only after SQL/Edge GREEN (not part of the first RED patch)

## Risks

- Double daily charge if legacy `incrementUsage` remains in the chat-path.
- Placing reserve too early would start charging safety/hard-stop responses (forbidden by this design).
- Placing reserve after the first provider call would fail to close the race.
- Missing tier must deny; do not auto-insert rows in reserve.
- Migration grants must repeat the migration 025 security pattern.
- Merge to `main` triggers frontend/VPS `deploy.yml` but does **not** deploy Supabase functions; Edge deploy remains an explicit step.

## Rollback

- Redeploy `staysee-chat` from the pre-Variant-B commit so the handler again uses legacy `checkRateLimit` + `incrementUsage`.
- Do not require or automate `DROP FUNCTION` for `reserve_ai_request` / `add_ai_token_usage` during emergency rollback; unused additive RPCs may remain until a later cleanup migration.
