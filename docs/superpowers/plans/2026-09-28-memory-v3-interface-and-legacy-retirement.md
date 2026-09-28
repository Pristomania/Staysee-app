# Memory V3 Interface And Legacy Retirement — Implementation Plan

**Goal:** Make Memory V3 the only visible and actively maintained memory system for every account except the Pristomania compatibility account, while preserving the legacy conversation summary until its remaining context dependencies are replaced.

## Constraints

- No paid model runs.
- Do not delete existing legacy memory rows or conversation summaries.
- Keep the legacy comparison available only to the explicitly flagged Pristomania profile.
- New and existing profiles default to Memory V3-only behavior.
- Keep profile-wide and per-conversation cross-memory controls unchanged.
- Fail closed: a missing profile flag or database read error must not start legacy synthesis.

## Task 1 — Compatibility flag

- Add `profiles.legacy_memory_compat_enabled boolean NOT NULL DEFAULT false`.
- Enable it only for the Pristomania profile.
- Add frontend and server-side readers with tests.

## Task 2 — Stop the duplicate legacy engine

- Gate `refreshUserLifeMemory` before any legacy table read or model request.
- Preserve `conversation_summary` generation because it still supplies rolling dialogue context and archive consumers.
- Tag future legacy summary and legacy cross-memory usage rows with distinct `call_kind` values.
- Test fail-closed behavior and source wiring.

## Task 3 — Memory interface

- Remove the account-creation-date rollout rule.
- Load and render legacy data only when the compatibility flag is true.
- Make Memory V3 the primary view for both profile and chat entry points.
- Profile view: status/control, conversation picker, selected dialogue memory, account-wide memory.
- Chat view: current conversation, per-chat cross-memory control, dialogue memory only.
- Put Pristomania legacy data in a visually secondary collapsed comparison panel.
- Improve hierarchy, spacing, labels, empty states, and responsive layout without changing the established StaySee theme.

## Task 4 — Verification and rollout

- Run focused tests, typecheck, lint, full relevant test glob, and production build.
- Review the rendered screen at desktop and mobile widths.
- Apply the migration, deploy `staysee-chat`, deploy the frontend, and run read-only production checks.
- Verify legacy UI is absent for a non-compatibility account and retained only for Pristomania.
- Verify no paid model request is executed during deployment or smoke checks.
