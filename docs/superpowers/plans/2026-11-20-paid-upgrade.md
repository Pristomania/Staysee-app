# Paid Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans inline; RED→GREEN and one fresh final reviewer.

**Goal:** Full-price basic→premium replaces the current included quota; bought packs remain separate.

**Architecture:** Migration100 replaces create/confirm bodies with a narrowly defined purchased-basic→premium eligibility exception. Existing grant branch, ledger, prices and callback stay unchanged; no new API signature.

Review fix: add private ledger purchase_kind to remember upgrade intent and respect later manual/free revocation; create order timestamps explicitly use the same post-lock clock. No RPC signature or live activation change.

**Tech Stack:** PostgreSQL/PGlite, node:test, existing TypeScript ResultURL.

**Spec:** docs/superpowers/specs/2026-11-20-paid-upgrade-design.md

## Global Constraints

- Local only, no production/checkout/key/merchant changes or commits, no memory work.
- Premium490000kopecks, new30days; no old included balance transfer, bought-pack lifetime/balance unchanged.
- Preserve manual/unlimited exceptions, money ledger and callback idempotency; new-order gate independent of confirmation.

## Review Focus

- Two pending payments arriving out of order cannot downgrade an already granted Premium.
- Manual/unlimited/suspended/deleted state changed after checkout remains respected.
- Pack funding or first-purchase history must not reset to create new trial/budget.
- Expiry during transaction/lock wait must use actual post-lock clock.
- Old included balance and bought packs must not be conflated or lose purchased lifetime.

## Task1: Upgrade backend and acceptance

Files: supabase/migrations/20261120210000_105_paid_upgrade.sql; scripts/paid-upgrade.dbtest.mjs.

Interfaces unchanged: create_billing_live_order(uid,product,key,merchant)→jsonb; confirm_billing_live_order(orderUUID,exactKopecks)→jsonb. Consume actual095–099 fixture, no external DB. New fixture applies100 only after tests exist.

- [x] Add real-SQL tests for full-price new-period replacement and independent pack/history survival, no duplicate grant. Run `node --import tsx --test scripts/paid-upgrade.dbtest.mjs`; Expected RED monthly_plan_not_purchasable.
- [x] Copy only create095/confirm099 into100, add purchased-basic→premium exception to both active-plan guards and post-usage-lock create clock. Preserve SQL ACL. Expected GREEN same command.
- [x] Test changed/manual/premium state at settlement remains paid_unfulfilled, no downgrade; post-expiry renewal still possible, client roles cannot invoke/mutate. Expected GREEN.
- [x] Run `npm run test:offline` and all local billing/archive SQL including new migration; Expected no failures. No deploy/commit.

## Task2: Review/report

- [x] One fresh read-only review of100 + tests; one Important/Critical RED→GREEN pass; minor notes deferred.
- [x] Document actual counts, full-price30day policy and unverified production/checkout/fiscal gates in docs/PAID_UPGRADE.md and knowledge/README.md.
