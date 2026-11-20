# Payment Outcome Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline with TDD. Approved small design, continue existing native workflow without another implementation-method question.

**Goal:** Show a truthful result and a way back to conversations after payment.
**Architecture:** Pure outcome-to-copy model plus themed React result component. Existing test panel consumes only the test result; live result variants stay isolated until an authoritative fulfillment endpoint exists.
**Tech Stack:** TypeScript, React, existing planRows catalog, node:test/tsx.
**Spec:** docs/superpowers/specs/2026-11-20-payment-outcome-design.md

## Global Constraints

- Test payment never claims real access; PAYMENT_AVAILABLE=false unchanged.
- Never infer payment/access/paid-until from query or client clock. Expired/malformed date cannot claim current access.
- CTA goes to main conversations list, creates no conversation and spends no message.
- No backend/Claude/model/memory/config changes, commits or deploy.

## Review Focus

- Paid notice before fulfillment must not show opened benefits (unit/SSR).
- Pack must not claim tier or paid_until (unit/SSR).
- AI voice not yet built must not be promised (unit).
- Expired/malformed paid_until must not claim active tier (unit).
- Test result and CTA readable at 390px and keyboard-operable (browser).

## Task 1: Outcome view model and real component

Files: src/lib/paymentOutcome.ts, src/components/payments/PaymentOutcomeCard.tsx, scripts/payment-outcome.test.ts.
Interface: PaymentOutcome discriminated union: test_paid; live paid awaiting fulfillment; live applied plan with server paidUntil; live applied pack. paymentOutcomeCopy returns title/body/benefits/date, no side effects. PaymentOutcomeCard({result,onConversations}) renders model and button.
- [x] RED tests assert basic400/3, premium1000/6, real available features only, package100 not plan, connecting no benefits, test no real grant, invalid/expired date no active claim; SSR CTA present.
- [x] Implement smallest pure model and themed component, run targeted command `node --import tsx --test scripts/payment-outcome.test.ts` until PASS. After review, require fresh server verifiedAt, no device clock; strict zoned calendar timestamps.

## Task 2: Wire only actual existing test result

Files: PaymentTestPanel.tsx, PaymentTestEntry.tsx, scripts/payment-test-panel.test.ts and ignored local harness.
Interface: panel receives onConversations callback; entry calls existing AppContext navigate('main'). Render result card after confirmed test_paid, keep optional new test action separate, never show success on pending.
- [x] RED behavioral/SSR test for rendered test result and CTA; implement wiring. Browser observed missing CTA before implementation, then card/CTA appeared; initial SSR guards no premature success.
- [x] Verify browser test-paid card + CTA from actual test panel, 390px. Live variants shown only in labeled isolated fixture.
- [x] Full offline2742/2742, typecheck, dummy-config build, one fresh read-only review and TDD fixes. Update payment report, preserve branch. Minor automated mounted transition test deferred explicitly; real browser scenario passed.
