# Billing Snapshot UI Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with TDD; continue user's explicit request, one fresh final reviewer.

**Goal:** Connect server billing state to the cabinet without fake renewals, stale-user data or device-clock grants.
**Architecture:** Self-only read-only PostgreSQL snapshot, validated transport/controller with monotonic time, PlanProvider subscription, metadata-aware counter/refusal copy. No fallback to raw unsafe clock-based state. Archive RLS/provider remain future phases.
**Tech Stack:** PostgreSQL096, TypeScript/React, node:test/tsx, PGlite.
**Spec:** docs/superpowers/specs/2026-11-20-billing-snapshot-ui-design.md

## Global Constraints
- No memory/model changes, deploy/secrets/provider calls, commits or other-agent checkout changes.
- Authoritative own RPC snapshot only. No dollars in UI payload, no reset of usage on snapshot read.
- First purchase suppresses future free renewal. Purchased month never auto-renews quota. Unknown/sleep-unverified has no paid features or payment upsell.
- Keep technical manual/unlimited assignments and initial free remainder after pack.

## Review Focus
- Foreign/stale/null/invalid response never grants or mixes users (Task1).
- Offline and replayed snapshot cannot extend exact term/pack expiry (Task1).
- Monotonic-paused sleep/clock manipulation requires new verification, no paid upsell (Task1,3).
- Snapshot must be read-only/self-scoped without leaking financial metadata (Task2).
- No fake renewal in every counter, tariff card or server denial path (Task1,2,3).

## Task1: Validated state, time, counter
Files: src/lib/serverTime.ts (extract existing strict parser), billingSnapshot.ts, messageCounter.ts, scripts/billing-snapshot.test.ts. Existing paymentOutcome uses extracted parser unchanged.
Interfaces: BillingSnapshot(version1,userId,serverNow,usage,packs); BillingSnapshotController(userId,read(signal),host?) with state/subscribe/refresh({requireFresh?})/dispose; state's row/counter/loaded/error bound to user. Host monotonic/wall/timer injection. messageCounter metadata source/paid_until/first_paid plus renewalDisabled/paidUntil.
- [x] RED tests shape/owner/time, paid0/exact-expiry/pack/free-paid-no-renew, clock/failure/replay/out-of-order/dispose/timeout, paused sleep.
- [x] Implement pure validator/controller and counter/copy; extract strict timestamp parser; targeted tests GREEN and existing outcome/counter tests unchanged except new cases. Review added immutable timestamp history, null floor preservation and mid-request sleep rejection.

## Task2: SQL snapshot + accurate server denial
Files: migration096_billing_snapshot.sql, scripts/billing-snapshot.dbtest.mjs; cost.ts/result parser/tests and staysee-chat minimal billing refusal selection.
Interfaces: get_my_billing_snapshot() auth.uid only, read usage lock and safe pack fields, clock_timestamp after lock, null inactive; reserve returns can_renew_messages boolean metadata without changing quota algorithm. RateLimitResult optional canRenewMessages; false chooses calm fixed no-renew refusal.
- [x] RED PGlite self/guest/other owner/no-money/read-only/expiry/manual/pack and real quota marker tests; parser/denial regressions.
- [x] Add snapshot and carried reserve095 with metadata only; validate optional boolean fail-closed; tiny atomic-denial object selection only, no prompts/models.
- [x] Targeted SQL4/4 + offline tests GREEN, Deno26 baseline failures explicitly unchanged.

## Task3: Provider and UI
Files: PlanContext.tsx, usageTier.ts browser adapter, PaywallContext.tsx, TariffsScreen.tsx, planCopy.ts, new BillingCheckNotice component, targeted tests/local harness; old brittle wiring checks replaced by real controller behavioral coverage where structure legitimately changes.
Interfaces: provider context keeps original tier/plan/counter/has/maxConversations/refresh and adds freeRenewable/verificationError; state from current user only. on wake requireFresh; notification/unknown dialog offers verification, never payment.
- [x] RED actual mounted browser path and SSR safe copy; integrate provider/adapter, initial has=false, single active controller per auth lifecycle and cleanup.
- [x] Check actual provider/controller through controlled RPC boundary: zero quota retains paid has, deadline disables, failed foreground verification notice, account switch,390px. No actual provider or DB network.
- [x] Full offline2758/2758/typecheck/dummy build, SQL4/4 acceptance, fresh review and one TDD fix pass; update report and preserve isolated branch. Minor intermediate-timer extra RPC deferred explicitly.
