# Robokassa test payment foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution. Steps use checkbox syntax. User explicitly requested implementation in this isolated checkout, without interfering with parallel Claude.

**Goal:** Implement a deployable but default-disabled test payment backend, with no real charges and no actual entitlement grants.

**Architecture:** Pure signing/validation and request handlers surround a service-only Postgres test-order ledger. Supabase adapters remain thin. Only signed ResultURL callbacks settle test orders, never browser returns. Existing model, memory, quota and conversation files remain untouched.

**Tech Stack:** TypeScript, Web Crypto SHA-256, Fetch Request/Response, Supabase Edge Functions, PostgreSQL RPC; node:test/tsx and local-only DB tests.

**Spec:** `docs/superpowers/specs/2026-11-19-robokassa-test-payments-design.md` including user clarifications and parallel-agent boundary.

## Global Constraints

- Scope is the isolated transport/ledger phase, not the entire billing, renewal, retention or conversation-lock project. Those requirements are retained in the spec and MUST NOT be claimed implemented.
- Default disabled; only `test` mode, IsTest=1, account allowlist; live mode rejected.
- Test callbacks never call set_user_plan/grant_message_pack or affect paid history, message counters or real permissions.
- No production DB writes, secrets inspection, paid requests, deployments, merge or changes to Claude's checkout.
- UСН Доходы, tax none. Test-only Receipt uses a documented technical example; actual accounting treatment remains a go-live gate.
- Do not commit/push without a new explicit instruction; preserve working-tree changes for review. This overrides skill commit steps.

## Review Focus

1. Repeated keys with changed products: reject; don't silently switch an existing order.
2. Callback amount may have six decimal digits: signature uses original text, monetary validation rejects nonzero sub-kopeck digits.
3. Delete/suspend account between creation and callback: don't recreate or grant; retain minimal test ledger with owner set null on auth deletion.
4. Duplicate parameters, oversized requests and hostile encodings: reject before storing or using secrets.
5. Valid callback before/after config rotation: choose by saved order mode; missing/mismatched config fails closed, never alternate to live credentials.

## Task 1: Payment protocol

Files: `_shared/robokassaTestProtocol.ts`, matching `.cases.test.ts`.

Interfaces: getPaymentProduct(unknown); parseRublesToKopecks(string); buildTestCheckout({merchantLogin,password1,invoiceId,product}); verifyTestResult({merchantLogin,password2,order,params}). Checkout returns fixed HTTPS action and POST fields, not a secret.

- [ ] Write tests with independent SHA256 vectors, real URLSearchParams, malformed/duplicate parameters, under/overpayment, invoice/mode/shop mismatches, unicode Receipt, all three server-selected products and no live path.
- [ ] Run focused node/tsx test; observe missing feature failure.
- [ ] Implement strict validators, signed URL-encoded Receipt and original-text callback digest with Shp_shop/Shp_mode binding.
- [ ] Rerun focused test, verify all cases pass.

## Task 2: HTTP boundary

Files: `_shared/robokassaTestHandlers.ts`, matching `.cases.test.ts`.

Interfaces: createRobokassaTestHandlers({config,store,authenticate}) -> {create,result,status}. PaymentStore.create({userId,productId,idempotencyKey}), get(invoiceId), settle(invoiceId,amountKopecks) are database operations, not in-memory production locking.

- [ ] Write Request/Response tests: disabled, missing config, unauthorized/not-allowlisted, forged user/amount, unknown product, body too large, idempotency conflicts, status ownership, signed callback success, DB failure yields retryable non-OK, repeated callback and test-only output.
- [ ] Observe RED; implement handlers with strict origin allowlist on authenticated browser routes, no CORS on callback, no secret-bearing error details.
- [ ] Rerun tests, check adapter inputs and observable Response behavior.

## Task 3: Database and deployment adapters

Files: new migration `20261119220000_094_robokassa_test_orders.sql`; `tests/db/robokassaTestOrders.dbtest.ts`; `_shared/robokassaTestRuntime.ts`; `robokassa-test-create/index.ts`, `robokassa-test-result/index.ts`, `robokassa-test-status/index.ts`.

- [ ] Add local-only DB integration tests: idempotent create, conflict, owner deletion, parallel settle, per-user RLS, cannot call RPC as authenticated/anon, no quota/paid history changes.
- [ ] Run DB test harness and record a skip if no localhost DB (not a pass). Do not run DB tests against production.
- [ ] Add test-only table and service-role RPCs. Numeric invoice ID unique/safe; per-user lock for creation/rate limits; same idempotency key returns same product/order. Limit burst/hour/open orders. Snapshot amount selected in SQL from the same fixed initial product mapping; protocol rejects drift before checkout.
- [ ] Add runtime auth via Supabase getUser; refuse room-deletion/suspended accounts on create. Always return minimal order DTO. Functions disabled unless explicitly configured. Callback verify_jwt=false is a deployment flag, not a bypass of signature verification.
- [ ] Check Deno adapter types; no edits to existing model/memory/quota sources or active configs.

## Task 4: Verify and hand off

Files: `docs/ROBOKASSA_TEST_PAYMENTS.md`, progress ledger in plan-local ignored workspace.

- [ ] Document endpoint URLs, SHA256, POST, separate test password secrets and allowlist; don't insert placeholders into real merchant settings. Explain fiscal/deletion/domain go-live gates and unimplemented live access/subscription/locks/retention.
- [ ] Run focused tests, npm run test:offline, npm run typecheck, npm run build, npm run test:db (local-only); report exact pre-existing failures/skips.
- [ ] Independent review of new payment files, fix important findings with RED→GREEN.
- [ ] Leave isolated branch unmerged/undeployed, with exact changed file list and manual external test still pending.
