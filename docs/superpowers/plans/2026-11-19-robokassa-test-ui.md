# Robokassa test UI — implementation plan

> **For agentic workers:** Use superpowers:executing-plans, inline with TDD. Continuation explicitly requested by user. No production deployments or real charges.

**Goal:** Connect an explicitly test-only payment panel to the existing test backend; recover the same order after navigation/reload without claiming paid access.

**Architecture:** A backend capabilities probe gates a default-off UI. A pure transport/controller owns retries, per-user session-storage breadcrumbs and server-confirmed status. A separate React panel is inserted into tariffs; a small return router in App returns authenticated users to tariffs only when a valid same-user pending breadcrumb exists.

**Tech Stack:** TypeScript, React, native Fetch/Form/AbortController, node:test/tsx, existing Supabase client for the user's current session.

**Spec:** `docs/superpowers/specs/2026-11-19-robokassa-test-payments-design.md`, test-only phase. All live entitlement, optional recurring, archive locks and annual retention work remains explicitly separate.

## Global constraints

- Existing PAYMENT_AVAILABLE=false remains unchanged. Add VITE_ROBOKASSA_TEST_UI=1 as a public visual flag only, never server authorization.
- Only authenticated/allowlisted accounts can get capabilities or use the APIs. Never read/save Robokassa passwords in the frontend.
- No JWT or email in URLs/session breadcrumbs. Persist only product/attempt UUID/invoice ID under a per-user session-storage key before creating a checkout.
- Test-paid always says money was not charged and tariff was not changed. Never grant real rights based on return query flags.
- No model/memory/Claude-checkout/config changes, paid API calls, commits/push/merge/deploy.

## Review focus

1. Network error after server creation: same UUID retry survives reload; no new attempt automatically.
2. Sign-out/user switch during request: ignore stale results and never submit another user's attempt.
3. Forged action/IsTest/fields: reject before form submission; no JWT forwarded to Robokassa.
4. Fake success return/pending callback: display server status only.
5. Blocked storage/hanging API: safe failure; never create an order without first saving its retry key.

## Task 1: Capability and pure client/controller

Files: `_shared/robokassaTestHandlers.ts` and tests; `src/lib/paymentTestClient.ts`, `src/lib/paymentTestClient.cases.test.ts`.

- [x] RED capability tests: allowlisted GET ?capabilities=1 returns test-only permission without store access; disabled/guest/other/duplicate query fail.
- [x] Implement exact capability branch behind existing gates.
- [x] RED client/controller tests for headers, checkout validation, timeout, stored UUID reuse, disposal and recovery (Node tests under scripts to avoid browser Node typings).
- [x] Implement injected transport/storage and current-session browser adapter.

## Task 2: React panel and return

Files: `src/components/payments/PaymentTestPanel.tsx`, `src/components/payments/PaymentTestReturnRouter.tsx`, `src/lib/paymentTestBrowser.ts`, `src/components/screens/TariffsScreen.tsx`, `src/App.tsx`.

- [x] Add separate default-off panel, capability gate and test warnings; real payment buttons remain disabled.
- [x] Add explicit checkout action, manual check/retry and bounded non-overlapping polling. Unknown payment never discarded automatically.
- [x] Add return handling requiring same-user breadcrumb and session, preserving auth/password recovery.
- [x] POST only validated safe fields to fixed Robokassa URL; JWT stays on own backend.

## Task 3: Verification and handoff

- [x] Focused/full offline tests, typecheck, test-config build and relevant DB regression; no production. 2734 offline +9 isolated SQL; full local Supabase unavailable, not claimed passed.
- [x] Browser check real component/controller in isolated local harness with controlled responses, no provider submission: recovery, statuses, keyboard and phone-sized view.
- [x] Independent review and RED→GREEN fixes; update report with remaining external gates. One minor return-marker URL cleanup deferred explicitly.
- [x] Leave branch unmerged/undeployed and Claude files untouched.
