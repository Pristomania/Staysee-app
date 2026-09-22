# Memory V3 Full Product Rollout Design

## Goal

Enable the existing Memory V3 lifecycle writer and reader for every authenticated
StaySEE account while preserving the current exact-account canary modes, legacy
fallback, privacy boundary, and deterministic lifecycle contracts. Notify the
operator through Telegram when Memory V3 fails and the reply path falls back to
legacy memory.

## Audience modes

The writer keeps `off`, `shadow`, and `lifecycle_shadow` unchanged and adds the
exact mode `lifecycle_all`. The reader keeps `off` and `canary` unchanged and adds
the exact mode `all`.

`lifecycle_shadow` and `canary` continue to require one exact canonical UUID.
`lifecycle_all` and `all` accept every canonical authenticated `userId`; they do
not accept anonymous, malformed, wrapper-object, wildcard, list, email, or
non-canonical identifiers. Unknown mode strings fail closed to `off`.

The existing allowlist secret remains available for rollback to canary. It is not
interpreted as a list or wildcard in any mode.

## Product behavior

Every eligible reply first attempts to read that account's own lifecycle state.
A missing lifecycle head preserves the legacy memory prompt. A valid lifecycle
head, including an authoritative empty state, replaces only legacy
cross-conversation memory; conversation summaries and technical fallbacks stay
unchanged.

After a successful ordinary reply, the lifecycle writer runs in the background
for that same authenticated account and conversation. The extractor, reconciler,
deterministic reducer, evidence rules, privacy fields, sequential execution, and
no-application-retry rule remain unchanged.

Existing imported state for the primary account remains untouched. Other existing
accounts start learning from new eligible messages. This rollout does not perform
historical backfill for those accounts and does not create test accounts.

## Safety and cost boundary

The temporary development allowance of five lifecycle reservations per UTC day
per account is restored to one before broad rollout. Duplicate reservations do
not consume another slot. Each reservation retains the existing maximum of one
extractor call and one reconciler call, sequentially, with no application retry
or repair.

At the observed production price this bounds an active account to roughly USD
0.02 per day for Memory V3. The database remains the authoritative enforcement
point.

## Telegram alerts

Alerts use two Supabase secrets:

- `STAYSEE_MEMORY_V3_ALERT_TELEGRAM_BOT_TOKEN`
- `STAYSEE_MEMORY_V3_ALERT_TELEGRAM_CHAT_ID`

No secret is committed, logged, returned to the client, or stored in a table.
The alert body contains only a fixed product label, `read` or `write`, an
allowlisted diagnostic code, and a fixed UTC timestamp. It contains no user ID,
conversation ID, message, claim, evidence, prompt, model body, stack trace, raw
error, URL, or credential.

Before sending, a service-role RPC reserves one global hourly window for the
exact path/code pair. Duplicate alerts inside the same UTC hour are suppressed.
Reservation and Telegram failures never affect the user reply and never cause a
retry. Missing Telegram secrets disable delivery but preserve safe Supabase logs.
Alert-window rows contain no user data and rows older than fourteen days are
removed during later reservations.

## Database migration

Migration 038 replaces the lifecycle reservation function only to restore the
per-account daily threshold from five to one. All other validation, locking,
deduplication, state loading, and privileges stay equivalent to migration 035.

The same migration creates `memory_v3_alert_windows`, enables RLS, denies direct
access to `PUBLIC`, `anon`, and `authenticated`, and exposes only a
`SECURITY DEFINER` service-role reservation function. The function accepts only
the closed alert keys used by the application.

## Verification

Automated tests use multiple synthetic UUIDs to prove all-user eligibility,
account isolation, canary rollback, malformed-input rejection, missing-state
legacy fallback, authoritative-empty behavior, failure alerts, hourly
deduplication, no secret/PII leakage, and the one-run daily cap.

After offline gates pass, the change is committed, pushed, reviewed, merged,
migrated, and deployed. Production secrets are changed from canary modes to
`lifecycle_all` and `all`. A short smoke check uses an already existing secondary
account; no new real account is required. A separate provider/model benchmark is
not part of rollout and still requires explicit paid-run authorization.

## Rollback

Rollback requires no data deletion. Set both modes back to the existing canary
values for the primary account, or to `off`, and redeploy/restart secrets. Stored
lifecycle state remains isolated by account and can be reused after correction.

## Non-goals

- No mass historical backfill for secondary accounts.
- No wildcard or comma-separated allowlist.
- No user-visible memory error.
- No automatic provider retry, repair, or paid benchmark.
- No change to lifecycle extraction, reconciliation, reducer, or evidence semantics.
