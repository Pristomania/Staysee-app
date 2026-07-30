# Atomic Chat Quota — Design

Date: 2026-07-30
Branch: `fix/atomic-chat-quota`
Base: `origin/main` @ `a374254e117b104e5f94e392741174edb0f76dc1`
Approach: A — atomic `reserve_ai_request` RPC (no reservation ledger)

## Goal

Close the parallel daily-limit bypass: atomically reserve exactly one daily request slot for the verified user **before any provider-backed work** (eager summary, life-memory refresh, main model, recovery, shadow).

## Non-goals

- Do not change frontend/client.
- Do not change prompt, model routing, or memory.
- Do not add a hard monthly token deny.
- Do not add a reservation ledger or `requestId` idempotency table.
- Do not return (refund) a daily slot after provider/network failure once reserve succeeded.
- Do not fix the repository-wide CI/typecheck baseline.
- Do not auto-change user tier limits as part of Variant B.

## Product semantics

- Auth, IP velocity, and in-memory dedup run before quota work.
- After verified auth and duplicate prevention, keep the existing early `checkRateLimit` as a **cheap preliminary filter** (defense in depth).
- Free message-only guards — safety `immediateResponse` (message-level) and explicit prompt-attack hard-stop — run **before** reserve and do **not** consume a daily slot.
- Authoritative `reserveAiRequest` runs exactly once after free guards and **before** any provider-backed seam.
- One user turn consumes one daily slot even when that turn later performs recovery, fallback, or shadow provider calls.
- Daily usage is incremented exactly once, and only inside `reserve_ai_request` on allow.
- After a successful reserve, the slot is never returned.
- Abort or early return **before** reserve does not consume a slot.
- Abort or provider failure **after** reserve consumes the slot (cost protection, not free retry).
- Monthly tokens are recorded via `recordTokenUsage` immediately after `totalTokens` is known, **independent of** `clientConnected` / `req.signal.aborted`.
- Memory/summary background work may still be skipped on disconnect; token accounting is not.

## Defense in depth: preliminary `checkRateLimit`

The current early `checkRateLimit` after verified auth + duplicate prevention is **kept**.

Purpose of the preliminary SELECT:

- immediately reject `suspended`;
- immediately reject an already exhausted daily limit;
- fail closed on missing row / SELECT error;
- prevent obviously blocked requests from doing memory / context / provider work.

Explicit limits of the preliminary check:

- the early SELECT is **not** a concurrency guarantee;
- two parallel requests can both pass the preliminary check when `remaining = 1`;
- authoritative enforcement is performed **only** by atomic `reserve_ai_request` before any provider-backed work.

## Architecture

Approach A only:

1. New SQL RPC `public.reserve_ai_request(p_user_id uuid) RETURNS jsonb`.
2. New SQL RPC `public.add_ai_token_usage(p_user_id uuid, p_tokens integer)`.
3. Wrappers in `supabase/functions/_shared/cost.ts`:
   - `reserveAiRequest`
   - `recordTokenUsage`
4. `staysee-chat` keeps `checkRateLimit` as the preliminary guard after auth/dedup.
5. Free message-only guards run before reserve.
6. `staysee-chat` calls `reserveAiRequest` exactly once after free guards and before any provider-backed work.
7. The chat-path post-call `incrementUsage` is replaced with `recordTokenUsage`.
8. Legacy `incrementUsage` remains exported for compatibility/rollback, but the chat-path no longer uses it.
9. Legacy `checkRateLimit` remains exported and continues to be used by `staysee-chat` as the preliminary guard only.
10. A late model-only gate seam is **not** part of the architecture (removed after provider-boundary review).

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
- Edge calls this best-effort after `totalTokens` is computed, independent of client disconnect.
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
5. free message-only guards (`evaluateTurnSafety(message, [])` immediateResponse; explicit prompt-attack hard-stop) — no reserve
6. atomic `reserveAiRequest` via service-role client (exactly once); deny via `mapQuotaDenyResponse` returns before any provider seam
7. durable memory / context / eager summary / post-context safety category+guidance (no second immediate-return)
8. provider / model (`callModel`, including recovery/shadow for the same reserved turn)
9. `recordTokenUsage` immediately after `totalTokens`, before `clientConnected` gating of memory/summary background work

### Error mapping

#### Preliminary `checkRateLimit`

| Reason | HTTP response |
|--------|----------------|
| `suspended` | existing suspended/rate calm body (429) |
| `daily_limit` | existing 429 calm rate-limit body |
| `missing_tier` | `503` `{ "error": "service_unavailable" }` (not a false 429) |
| SELECT / `limit_check_error` | `503` `{ "error": "service_unavailable" }` (not a false 429) |

Preliminary deny must skip memory/context/provider work and must not call provider.

#### Atomic `reserveAiRequest`

| Reason | HTTP response |
|--------|----------------|
| `suspended` | existing suspended/rate calm body (429) |
| `daily_limit` | existing 429 calm rate-limit body |
| `missing_tier` | `503` `{ "error": "service_unavailable" }` |
| RPC/DB / `limit_check_error` | `503` `{ "error": "service_unavailable" }` |

Atomic reserve is the **final** decision before any provider-backed work. Provider/model/eager summary must not be called on any reserve deny or reserve error.

## Concurrency guarantee

When `daily_request_limit - daily_requests_used = 1` for one user:

- two parallel requests may both pass preliminary `checkRateLimit`;
- two concurrent `reserve_ai_request` calls still yield exactly one `allowed: true`;
- the other returns `daily_limit`;
- the final `daily_requests_used` increases by exactly 1;
- the row lock is held only for the short SQL transaction and **not** during provider work.

## Testing

### Local RED/GREEN (tsx case tests, no Docker required)

- wrapper maps RPC allow payload;
- suspended / daily_limit / missing_tier deny mapping for reserve;
- RPC/transport error → fail-closed `limit_check_error`;
- `recordTokenUsage` calls only `add_ai_token_usage` and changes only monthly tokens;
- free guards + reserve precede every provider-backed seam;
- atomic deny block contains `mapQuotaDenyResponse` + `return new Response` and no provider seams;
- `recordTokenUsage` is unconditional `EdgeRuntime.waitUntil(...)` immediately after `totalTokens`;
- source wiring test includes mutation self-checks (provider-inside-deny and abort-gated accounting must fail validation);
- chat-path no longer invokes legacy post-call daily `increment_usage`.

### Staging

- mandatory read-only preflight audit (aggregate tier counts only; no userId/email);
- apply migration `031`;
- verify EXECUTE grants (service_role only);
- remaining=1 + two parallel reserves → one allow (RPC smoke);
- future authorized handler parallel check (temp user, one paid AI path max);
- expired day window → reset + one allow;
- token RPC changes monthly counters only;
- deny path never reaches AI;
- concurrency is proven by staging parallel smoke, not by the source wiring test alone.

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
- `supabase/functions/_shared/quotaDenyResponse.ts`
- `supabase/functions/_shared/stayseeChatAtomicQuotaWiring.cases.test.ts`
- `supabase/functions/staysee-chat/index.ts`
- `scripts/atomic-quota-staging-smoke.mts`

## Risks

- Double daily charge if legacy `incrementUsage` remains in the chat-path.
- Treating preliminary `checkRateLimit` as concurrency-safe would leave the race open; only `reserve_ai_request` is authoritative.
- Placing reserve too early would start charging safety/hard-stop responses (forbidden by this design).
- Placing reserve after the first provider-backed seam (eager summary included) would fail to close the race.
- Missing tier must deny; do not auto-insert rows in reserve.
- Migration grants must repeat the migration 025 security pattern, with `search_path = ''` on new SECURITY DEFINER RPCs.
- `TIER_CONFIG` client/Edge defaults may diverge from authoritative DB row limits; Variant B must not auto-rewrite tiers.
- Merge to `main` triggers frontend/VPS `deploy.yml` but does **not** deploy Supabase functions; Edge deploy remains an explicit step.

## Rollback

- Redeploy `staysee-chat` from the pre-Variant-B commit so the handler again uses preliminary `checkRateLimit` + post-call `incrementUsage`.
- New additive RPCs (`reserve_ai_request`, `add_ai_token_usage`) remain unused after Edge rollback.
- Do not require or automate `DROP FUNCTION` for those RPCs during emergency rollback; unused additive RPCs may remain until a later cleanup migration.
