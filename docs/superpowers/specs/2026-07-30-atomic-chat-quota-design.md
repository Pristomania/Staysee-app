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

- Auth, IP velocity, and in-memory dedup run before quota work.
- After verified auth and duplicate prevention, keep the existing early `checkRateLimit` as a **cheap preliminary filter** (defense in depth).
- Safety `immediateResponse` and explicit prompt-attack hard-stop paths do **not** consume a daily slot.
- Authoritative atomic reserve runs **immediately before the first provider/model call** (`callModel`).
- One user turn consumes one daily slot even when that turn later performs recovery, fallback, or shadow provider calls.
- Daily usage is incremented exactly once, and only inside `reserve_ai_request` on allow.
- After a successful reserve, the slot is never returned.
- Abort or early return **before** reserve does not consume a slot.
- Abort or provider failure **after** reserve consumes the slot (cost protection, not free retry).
- Monthly tokens are recorded from actual usage after the model response path.

## Defense in depth: preliminary `checkRateLimit`

The current early `checkRateLimit` after verified auth + duplicate prevention is **kept**.

Purpose of the preliminary SELECT:

- immediately reject `suspended`;
- immediately reject an already exhausted daily limit;
- fail closed on missing row / SELECT error;
- prevent obviously blocked requests from doing memory / context / safety work.

Explicit limits of the preliminary check:

- the early SELECT is **not** a concurrency guarantee;
- two parallel requests can both pass the preliminary check when `remaining = 1`;
- authoritative enforcement is performed **only** by atomic `reserve_ai_request` immediately before the first model call.

## Architecture

Approach A only:

1. New SQL RPC `public.reserve_ai_request(p_user_id uuid) RETURNS jsonb`.
2. New SQL RPC `public.add_ai_token_usage(p_user_id uuid, p_tokens integer)`.
3. Wrappers in `supabase/functions/_shared/cost.ts`:
   - `reserveAiRequest`
   - `recordTokenUsage`
4. `staysee-chat` keeps `checkRateLimit` as the preliminary guard after auth/dedup.
5. `staysee-chat` calls `reserveAiRequest` exactly once, immediately before the first `callModel`.
6. The chat-path post-call `incrementUsage` is replaced with `recordTokenUsage`.
7. Legacy `incrementUsage` remains exported for compatibility/rollback, but the chat-path no longer uses it.
8. Legacy `checkRateLimit` remains exported and continues to be used by `staysee-chat` as the preliminary guard only.

Approaches B (reservation ledger) and C (advisory lock across check+increment) are out of implementation scope.

## Migration file

Create one additive migration immediately after the latest applied version `20260701120000_030_protocol_events`:

- `supabase/migrations/20260730120000_031_atomic_chat_quota.sql`

The migration must:

- define both RPCs with schema-qualified `public.*` names;
- set `search_path = ''` on each new `SECURITY DEFINER` function (all objects are schema-qualified; do not use `search_path = public`);
- `REVOKE ALL` from `PUBLIC`, `anon`, and `authenticated`;
- `GRANT EXECUTE` to `service_role` only (same security pattern as migration 025 for `increment_usage`);
- not drop or alter legacy `increment_usage` in this PR.

## `reserve_ai_request` contract

### Security

- `SECURITY DEFINER`
- schema-qualified `public.*`
- `SET search_path = ''`
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
- `SET search_path = ''`
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

Legacy `checkRateLimit` remains the preliminary SELECT helper used by `staysee-chat`.
Legacy `incrementUsage` remains exported for rollback compatibility but is unused by the chat-path after this change.

## Handler wiring (`staysee-chat/index.ts`)

Fixed order:

1. IP velocity
2. verified auth (`resolveVerifiedChatUser`)
3. duplicate prevention
4. preliminary `checkRateLimit`
5. memory / context / safety evaluation
6. free early responses (safety `immediateResponse`, explicit prompt-attack hard-stop) — no reserve
7. build prompts / budgets
8. atomic `reserveAiRequest` via service-role client, immediately before the first model call
9. provider / model (`callModel`, including any recovery/shadow calls for the same turn)
10. `recordTokenUsage` (monthly tokens only; never a second daily charge)

### Error mapping

#### Preliminary `checkRateLimit`

| Reason | HTTP response |
|--------|----------------|
| `suspended` | existing suspended/rate calm body (429) |
| `daily_limit` | existing 429 calm rate-limit body |
| `missing_tier` | `503` `{ "error": "service_unavailable" }` (not a false 429) |
| SELECT / `limit_check_error` | `503` `{ "error": "service_unavailable" }` (not a false 429) |

Preliminary deny must skip memory/context/safety work and must not call provider.

#### Atomic `reserveAiRequest`

| Reason | HTTP response |
|--------|----------------|
| `suspended` | existing suspended/rate calm body (429) |
| `daily_limit` | existing 429 calm rate-limit body |
| `missing_tier` | `503` `{ "error": "service_unavailable" }` |
| RPC/DB / `limit_check_error` | `503` `{ "error": "service_unavailable" }` |

Atomic reserve is the **final** decision before AI. Provider/model must not be called on any reserve deny or reserve error.

## Concurrency guarantee

When `daily_request_limit - daily_requests_used = 1` for one user:

- two parallel requests may both pass preliminary `checkRateLimit`;
- two concurrent `reserve_ai_request` calls still yield exactly one `allowed: true`;
- the other returns `daily_limit`;
- the final `daily_requests_used` increases by exactly 1;
- the row lock is held only for the short SQL transaction and **not** during the model call.

## Testing

### Local RED/GREEN (tsx case tests, no Docker required)

- wrapper maps RPC allow payload;
- suspended / daily_limit / missing_tier deny mapping for reserve;
- RPC/transport error → fail-closed `limit_check_error`;
- `recordTokenUsage` calls only `add_ai_token_usage` and changes only monthly tokens;
- preliminary deny → context/provider seam is not invoked;
- preliminary allow + atomic deny under race → provider is not invoked;
- preliminary allow + atomic allow → exactly one provider path;
- neither preliminary check nor reserve performs a post-call daily increment;
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
- rollback plan: redeploy Edge to the pre-B commit so the handler returns to preliminary `checkRateLimit` + post-call `incrementUsage`; additive SQL functions may remain unused temporarily (no automatic `DROP FUNCTION` as part of rollback).

## Required files

- `supabase/migrations/20260730120000_031_atomic_chat_quota.sql`
- `supabase/functions/_shared/cost.ts`
- `supabase/functions/_shared/cost.cases.test.ts`
- `supabase/functions/staysee-chat/index.ts`
- optional local case-test only for the handler/provider seam if wiring cannot be covered from `cost.cases.test.ts` alone
- staging concurrency smoke script only after SQL/Edge GREEN (not part of the first RED patch)

## Risks

- Double daily charge if legacy `incrementUsage` remains in the chat-path.
- Treating preliminary `checkRateLimit` as concurrency-safe would leave the race open; only `reserve_ai_request` is authoritative.
- Placing reserve too early would start charging safety/hard-stop responses (forbidden by this design).
- Placing reserve after the first provider call would fail to close the race.
- Missing tier must deny; do not auto-insert rows in reserve.
- Migration grants must repeat the migration 025 security pattern, with `search_path = ''` on new SECURITY DEFINER RPCs.
- Merge to `main` triggers frontend/VPS `deploy.yml` but does **not** deploy Supabase functions; Edge deploy remains an explicit step.

## Rollback

- Redeploy `staysee-chat` from the pre-Variant-B commit so the handler again uses preliminary `checkRateLimit` + post-call `incrementUsage`.
- New additive RPCs (`reserve_ai_request`, `add_ai_token_usage`) remain unused after Edge rollback.
- Do not require or automate `DROP FUNCTION` for those RPCs during emergency rollback; unused additive RPCs may remain until a later cleanup migration.
