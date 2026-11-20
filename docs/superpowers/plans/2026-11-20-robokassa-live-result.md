# Robokassa Live Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Tests RED→GREEN; one fresh final review, no re-review.

**Goal:** Default-disabled verified ResultURL adapter for existing live ledger without enabling purchases.

**Architecture:** Pure protocol validates envelope before storage, bounded HTTP callback uses injected store, thin Supabase adapter invokes idempotent SQL confirmation;099 captures grant time after locks.

**Tech Stack:** TypeScript/WebCrypto/Fetch, Deno/Supabase, PostgreSQL/PGlite, node:test/tsx.

**Spec:** docs/superpowers/specs/2026-11-20-robokassa-live-result-design.md

## Global Constraints

- No production, keys, real charges, checkout/button activation, deploy/commit/push or Claude changes.
- Test path remains test-only; no SuccessURL grants, no automatic recurring/refunds.
- Existing ledger/status/catalog/pack/trial policy preserved; callback config independent of new-order creation gate.

## Review Focus

- Live/test credential, namespace and stored mode isolation.
- Same money with different raw amount precision, duplicates/case aliases and raw body encoding.
- Commit succeeded but HTTP failed; repeated callback never reapplies rights.
- Delete/suspend user or active/manual plan between creation/settlement; valid money still ACK and flagged unfulfilled.
- Captured clock before lock wait, hanging body/DB and disabled creation while callback still needed.

## Task1: Protocol and handler

Files: _shared/robokassaLiveResult.ts and .cases.test.ts. Interface createRobokassaLiveResult({config,store,timeoutMs?,report?}) returns Request→Response. Store.get(invoiceId,signal), store.confirm(order,amountKopecks,signal); types and statuses per spec.

- [x] Write independent crypto vectors and real Request cases; observe RED.
- [x] Implement only POST ResultURL with safe disabled config, strict validation, no lookup before signature, bounded deadline and committed-status ACK.
- [x] Run focused tests GREEN and npm run test:offline; no old test protocol refactor unless test demonstrates need.

## Task2: Real SQL integration and thin runtime

Files: migration099_live_confirmation_clock.sql, scripts/robokassa-live-result.dbtest.mjs, _shared/robokassaLiveResultRuntime.ts, robokassa-live-result/index.ts.

- [x] Add signed HTTP→real SQL integration and transaction expiry regression; watch the old callback-clock failure.
- [x] Implement099 post-lock clock preserving confirm signature/ACL/grants; runtime default-off, explicit live credentials, abortable queries and sanitized operational event only.
- [x] Run focused SQL plus existing money tests, full offline/types/dummybuild and Deno new endpoint.

## Task3: Final review and handoff

- [x] Fresh read-only review of this whole phase; one Critical/Important RED→GREEN fix pass; Minor documented.
- [x] Save docs/ROBOKASSA_LIVE_RESULT.md with sources, exact tests, go-live gaps and deployment/secret-name checklist without values. Keep checkout, live flag, account settings and production unchanged.
