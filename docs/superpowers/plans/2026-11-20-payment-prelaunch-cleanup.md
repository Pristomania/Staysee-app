# Payment Prelaunch Cleanup

> Execute inline with superpowers:executing-plans/TDD, one final fresh review. Existing purchase-review design remains authority; this closes its two deferred minor findings.

**Goal:** No known small UI defects left in test purchase review; inspect merchant settings without unsafe activation.
**Architecture:** Restore repeat disclosure before focus, keep free allowance copy sourced from catalog. Merchant read-only checks separately recorded.
**Spec:** docs/superpowers/specs/2026-11-20-purchase-review-design.md plus user request to finish preparation before shop approval.

- [x] Failing tests for disclosure-before-focus and changing free.messages reflected in copy. Add restoreReviewFocus helper and use it in panel; replace literal50. Focused GREEN.
- [x] Browser repeat paid→review→cancel returns visible focus; full offline/types/build GREEN; existing SQL unchanged (prior70/70).
- [x] Inspect correct StaySeeAI store/card/technical/fiscal settings. Never reveal or rotate passwords. Do not enable live mode, choose fiscal classification, submit activation again, accept contracts or save callbacks to undeployed endpoints. User separately approved saving knownSNO/VAT/hash/POST; done without other changes.
- [x] One fresh read-only review of narrow cleanup, report safe configured/blocked gates with official sources. No production deployment/commit.

Review focus: focus must target a visible button after repeat cancel; no render/cancel API side effects; copy tracks catalog; merchant changes cannot silently alter security/fiscal/money behavior.
