# Live Payment Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans inline with TDD; one final fresh reviewer.

**Goal:** Authenticated owner-only payment verification independent of provider redirects, without granting rights on reads.
**Architecture:** Self-only SQL RPC joins current snapshot with minimal order history; strict client decoder and bounded session-aware read; no service-role endpoint or new purchase UI.
**Tech Stack:** PostgreSQL/PGlite, TypeScript/tsx, existing Supabase SDK.
**Spec:** docs/superpowers/specs/2026-11-20-live-payment-status-design.md

## Global Constraints

- Local only, no production/merchant/key changes, charges, deploy/commit or memory edits.
- New RPC authenticated only; ownership auth.uid, no caller-supplied userId for DB access.
- Reading never grants/consumes/extends rights; currentGrant must not confuse historical payment with current access.

## Review Focus

- Expired or upgraded old orders cannot claim an active old plan.
- Wrong-user/order response or account switch mid-read cannot reach new session.
- Late callback after projected expiry stays valid and may become applied.
- Concurrent confirmation and read serialize on usage in compatible order.
- Lost or hanging requests remain bounded; no retry purchases or optimistic grant from query flags.

## Task1: SQL verification and client contract

Files: migration20261120220000_106_live_payment_status.sql; scripts/live-payment-status.dbtest.mjs; src/lib/livePaymentStatus.ts; src/lib/livePaymentStatusBrowser.ts; scripts/live-payment-status.test.ts.
Interface: SQL get_my_live_payment_status(orderUUID)→version1 DTO orNULL. TS parseLivePaymentStatus(raw,userId,orderId), readLivePaymentStatus({userId,orderId,session,read,signal,timeoutMs?}), paymentStatusCopy(dto).

- [x] Write real SQL tests and see missing-RPC RED, implement minimal self-only RPC, focused GREEN.
- [x] Write decoder/read/copy tests RED, implement client contract+thin browser adapter, focused GREEN.
- [x] Run full offline, prior63SQL+new cases, typecheck/dummybuild. Expected all green, no secret reads.

## Task2: Review and evidence

- [x] One fresh read-only final review current phase, single Important/Critical RED→GREEN pass, minor deferred.
- [x] docs/LIVE_PAYMENT_STATUS.md records verification/remaining checkout gates; preserve worktree, no commit/deploy.
