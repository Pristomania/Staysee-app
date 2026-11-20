# Auth and plan-check recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline implementation with RED→GREEN regression checks.

**Goal:** Correct the two browser acceptance findings and finish previously unverified access checks without deploying or modifying another agent's workspace.

**Architecture:** Preserve the existing Supabase authentication and server-authoritative access model. Diagnose authentication ordering with secret-free boundary traces before selecting the minimal fix. Add missing initial-plan status/retry presentation without granting unverified access. A loopback-only browser QA dashboard exercises actual components and instruments DOM/network boundaries, rather than changing application state through read-only browser evaluate.

**Tech stack:** React18, TypeScript, Supabase SDK, Vite, node:test, real browser via CUA.

**Spec:** User instruction to fix both findings and check the unchecked items; `D:/Project/GPT JARVIS/knowledge/codex-prompt-browser-lock-quality-2026-11-20.md` and its browser report define expectations. Their former no-code-change restriction is superseded only for local fixes, not deployments or production data writes.

## Global constraints

- Existing isolated worktree, branch `codex/auth-plan-check-recovery-20261120`, base32aa1299e762695906c18f1d343f192f2032a4ea.
- No deployment, main changes, production account mutations, paid/model requests, real purchases or new chat messages. No secrets in output/files. Local disposable data only, clean up afterward. Do not stop local Supabase8100.
- Keep locks and visible closed titles as requested; never render unverified private content. Do not fix unrelated memory/model/tariff code.
- Report unverified hardware touch honestly. Check synthetic events in real local browser if production tools cannot provide them; distinguish environments.

## Review focus

- Sign-in arriving during session restoration must not be lost or overwritten by an older snapshot; sign-out/account switch must beat late profile reads.
- Recovery must remain password-recovery-only; no magic-link fix may clear valid recovery state.
- Failed/slow initial billing must have explanation and retry, with no previous account/conversation text.
- Repeated focus/visibility/pageshow/online must not invalidate verified UI or accumulate listeners/timers.
- Component unmount/StrictMode cleanup and stale async responses must not publish state for a discarded owner.

### Task1: Root cause and red regressions

Files: existing AuthContext/MainScreen and browser QA scratch; new regression tests appropriate to the proven root cause.

- [ ] Run full safe offline baseline; adapt command invocation only if Windows command-length limit prevents the stock runner.
- [ ] Trace actual auth events/getSession/user visibility on a disposable callback in real browser, recording only booleans/timing.
- [ ] Reproduce each bug with actual components before fixing. Record the specific bad ordering/branch; no speculative auth rewrites.

### Task2: Minimal fixes, RED→GREEN

Interfaces: existing AuthContext public contract, usePlan verificationError/loaded/refresh; list waits for verified plan before fetching/rendering private rows.

- [ ] Fix only the proven auth ordering issue; add coverage for stale restore/sign-out/profile owner and recovery protection as applicable.
- [ ] Add initial-plan error/slow/retry UI to MainScreen, preserving quiet background refresh.
- [ ] Run focused tests, then the full offline set and typecheck/build. Record any baseline failures rather than hiding them.

### Task3: Browser closure and handoff

- [ ] Real browser:3 fresh callback logins without reload; initial HTTP500/delay recovery, retry button and old-content absence.
- [ ] Browser dashboard: synthetic focus/visibility/pageshow/online on list and chat, per-event request counts, rAF/MutationObserver opacity observation,450ms onset,20s cache boundary; distinguish real local stack vs controlled component fixture.
- [ ] Repeat lock/deletion/mobile regressions; independently revoke unlimited and override where feasible; no model calls.
- [ ] Clean up only created local accounts/processes. Keep8100 running. Save follow-up report outside application Git with exact results and limitations.
- [ ] Independent whole-change review; no merge/push/deployment without separate approval.

## Progress

- Baseline stock `npm run test:offline` could not launch shared tests: Windows ENAMETOOLONG from202 absolute file paths. Temporary runner invokes the same discovered four groups with relative paths; no application runner change.
- Prior acceptance showed MainScreen's initial `!planLoaded` spinner hiding error/slow state. Auth cause still under investigation; no product changes made yet.
- Baseline: stock runner hit Windows ENAMETOOLONG; after npm ci, temporary relative-path invocation ran all347 offline test files successfully:2972 tests. No product runner changes.
- Initial RED browser run:7/7 failed (early sign-in, stale INITIAL_SESSION, sign-out resurrection, stale profile, recovery session, missing error/retry, missing slow hint). Minimal fixes then made7/7 GREEN.
- Independent reviewer found3 Important adjacent auth issues. Four additional real-component tests reproduced them RED: deferred automatic logout erasing a new login; public profile refresh overwriting a switched owner; same-user refocus clearing recovery; stale explicit-signIn deletion check signing out a newer owner.
- Fix pass: one shared owner/revision across all profile writers and explicit login completion; no automatic SDK global logout based on an unverified or superseded read; same-owner recovery survives generic SIGNED_IN. All11 browser regressions GREEN before adding CSS/cache observations.
- Ruling: an invalid/expired/deleted-owner read fails the React view closed instead of invoking SDK signOut on mutable credentials. Explicit logout remains unchanged and backend deletion/RLS remains authoritative. Cost if wrong: obsolete SDK credentials may remain until SDK/explicit logout, but unverified UI must stay closed; browser tests cover the view and no new owner is revoked.
- Actual disposable callback loop after fixes:3/3 successful without reload (3162,3210,3199ms including helper redirect). Production not deployed/retested as fixed.
- A3 closure on actual local stack: focus, hidden-visible, pageshow, online on both list and chat:8/8 intervals each exactly1 snapshot request,631 observed animation frames,0 visible checking frames, fixture text retained throughout. This is not a claim about the still-unmodified live site.
- Task3 completed locally:17/17 browser regressions PASS, computed-opacity onset494ms,19s cached grant opens and21s remount requires verification. Embedded-browser rAF throttling invalidated intermediate timing measurements; final measurement uses MutationObserver plus50ms computed-opacity samples without changing product thresholds.
- Real local initial slow/error state and retry verified. Individual override/unlimited revocations closed the open view after15691/17129ms without reload.390px deletion/new-empty flow passed; pointerType=touch drag passed as emulation, not physical touch.
- Final offline groups:2974 tests,0 failures. Typecheck/build passed. Independent review's Important findings reproduced RED and fixed GREEN; no second independent review or production deployment claimed.
- Disposable fixture deleted and verified absent, conversations0/messages0. QA processes stopped; existing local Supabase8100 left running. Diagnostic dashboard/probe archived outside Git; reusable17-case browser regression page retained.
