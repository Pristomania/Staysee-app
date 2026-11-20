# Paid Access Backend Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, TDD, one fresh final reviewer. Continue approved isolated workflow, no live enablement.

**Goal:** Atomic, idempotent real-purchase entitlements with a true paid expiry, preserving legacy/manual access and packages.
**Architecture:** New gated private order ledger and purchase metadata in usage. Settlement and quota share usage-row serialization; server preliminary feature check computes effective purchased tier. Existing test callback remains isolated. No live HTTP adapter or UI switch in this phase.
**Tech Stack:** PostgreSQL PL/pgSQL, Deno TypeScript, node:test, isolated embedded PGlite.
**Spec:** docs/superpowers/specs/2026-11-20-paid-access-design.md

## Global Constraints
- No production DB, secrets, provider/model calls, commits/push/deploy or Claude/model/memory changes.
- Current live create gate default false; test payments never grant/history.
- Monthly purchase forfeits trial remainder; pack preserves current trial; any real purchase permanently stops future free renewals.
- Term and quota independent. Pack never resets paid_until or period/counters. Manual/unlimited unchanged.

## Review Focus
- Expired/invalid purchased metadata cannot leak paid functions before quota (Task1 cases).
- Replayed and second paid order cannot overwrite term/quota (Task2 SQL).
- Usage/order/pack lock ordering and rollback preserve exactly-once grants (Task2 SQL, independent DB concurrency explicitly unverified).
- Deleted/suspended/manual-assigned user at callback never resurrected (Task2 SQL).
- Package after expiry remains usable without a fresh trial or old-period cost blockage (Task2 SQL).

## Task1: Effective server tier
Files: supabase/functions/_shared/paidAccess.ts and .cases.test.ts; cost.ts and cost.cases.test.ts.
Produces: effectivePaidTier(row,serverNowMs=Date.now()) returning free/basic/premium, preserving legacy manual and unlimited. Missing/invalid purchased deadline=>free; exact deadline=>free. checkRateLimit uses this tier and its current default daily guard, no model configuration change.
- [x] RED legacy/manual, active0quota, exact expiry, malformed/absent deadline, unlimited examples; real checkRateLimit regression with purchased fields.
- [x] Implement helper/preliminary check and verify targeted tests GREEN.

## Task2: SQL ledger/settlement/expiry/quota
Files: migration20261120160000_100_paid_access_backend.sql; scripts/paid-access.dbtest.mjs; deletion inventory test explicit classification.
Produces: create_billing_live_order(user,product,key,merchant); confirm_billing_live_order(orderUUID,amountKopecks); expire_purchased_access(user) service-only. Settings gate defaultoff. Private ledger with preserved FK and service-only snapshots. Usage columns access_source,paid_access_until,first_real_purchase_at.
- [x] RED real PGlite tests for prices/defaultgate/RLS/idempotency, 30day grant/0messages, pack counters/term and trial preservation, monthly trial forfeiture/expiry/packs, no auto renewal for paid/neverpaid still renew, manual/unlimited, double-order/late-callback/inactive/deletion, rollback on pack error, exact amount/test isolation/limits.
- [x] Implement additive migration. Carry reserve090 forward mechanically with precise additions: expire before row read, suppress monthly auto-renew for purchase, suppress free renewal after real purchase. Preserve every existing guard. Carry set_user_plan089 with explicit manual metadata; historical first purchase stays. Review added period-scoped cumulative funding snapshot, strict ACLs, nonmutating pack callback replay.
- [x] Run SQL17/17 GREEN; classify new retained payment ledger explicitly; full existing testbase2745/2745 GREEN.

## Task3: Evidence and review
- [x] Fresh read-only review; accepted Important findings one RED→GREEN fix pass. No re-review. Minor independent rate-limit cases deferred explicitly.
- [x] Full offline2745/2745, typecheck, helper Deno GREEN, SQL17/17; full cost Deno graph fails26 baseline errors (diagnostics identical to unchanged HEAD), not falsely reported passing. Document unavailable full Supabase/concurrency and not-yet-wired UI/locks/provider.
- [x] Update payment report and leave branch unmerged/undeployed.
