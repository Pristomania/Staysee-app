# Purchase Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans inline and TDD; one fresh final review.

**Goal:** Show price/terms before creating a TEST order; close two status presentation gaps before UI use.
**Architecture:** Pure PLANS/PACK review model, themed inline card, identity-bound selection in existing test panel; no new purchase authority.
**Tech Stack:** React/TypeScript/node:test, local Vite browser fixture.
**Spec:** docs/superpowers/specs/2026-11-20-purchase-review-design.md

## Global Constraints

- Local/test only, merchant pending and RoboChecks selected; no real charges, secrets, fiscal settings, production, commit or deployment.
- Prices/limits from PLANS/PACK. Full-price30day Premium replaces old included balance; purchased messages retained.
- Keep existing test auth/allowlist and PAYMENT_AVAILABLE=false; no auto-subscription promise.

## Review Focus

- Cancel or render must never create a purchase/attempt.
- Identity/controller/API change cannot confirm a previous session's review.
- Fast double confirmation never produces a second invoice.
- Test-paid screen must still permit reviewing another product without skipping terms.
- Mobile and keyboard users must see warning, price and an unambiguous test-only action.

## Task1: Close status presentation gaps

- [x] Add uppercase UUID and submillisecond active-copy tests to scripts/live-payment-status.test.ts; Expected RED current decoder/copy.
- [x] Normalize validated IDs, keep currentGrant/copy time consistent in src/lib/livePaymentStatus.ts; focused GREEN plus full offline.

## Task2: Test purchase review

Files src/lib/purchaseReview.ts; src/components/payments/PurchaseReviewCard.tsx; existing PaymentTestPanel.tsx; scripts/purchase-review.test.ts.
- [x] Add business-copy/static render tests RED; implement model/card, no side effects on render.
- [x] Integrate identity-bound selection before controller.start; cancel clears selection only.
- [x] Local browser fixture tests real panel transitions/390px; full offline/current70SQL/types/dummybuild all green.
- [x] One final fresh read-only review, one Important/Critical fix pass, minors recorded; docs/PURCHASE_REVIEW.md and knowledge index, no publish.
