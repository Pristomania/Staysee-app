# Conversation Archive Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, tests before implementation, one final fresh review.

**Goal:** Enforce archive locks across server content readers while preserving own deletion and new empty free conversation.

**Architecture:** Stored free anchor follows top while paid and freezes on expiry. Restrictive RLS protects content, safe RPCs expose list and mutations. UI only mounts protected screens after fresh access check; Edge guards and atomic conversation-aware quota protect service paths.

**Tech Stack:** PostgreSQL, Deno/TypeScript, React, Node tests/PGlite, browser fixture.

**Spec:** docs/superpowers/specs/2026-11-20-conversation-archive-access-design.md

## Global Constraints

- Isolated current branch only. No production, secrets, paid calls, commits, deploys, or memory algorithm changes.
- Fixed free ID, delete any own closed conversation, new empty after deletion, no archive stepping.
- Paid quota0 stays paid; real purchase term independent; legacy manual/unlimited/custom room grants preserved.
- Existing content stays unchanged except explicit user deletion on test fixtures.

## Review Focus

- RLS bypass through SECURITY DEFINER preview and service Edge clients.
- Closed-row metadata/summary, search and in-flight stale client results after expiry.
- Delete tombstone and create/reactivate cannot rotate into archived content.
- Concurrent quota/payment/create/delete lock ordering and exact deadline.
- Account switch/unknown billing/network failure never shows previous content or false mutation success.

## Task1: SQL anchor, policies and self RPC

Files: create migration098_conversation_archive_access.sql, scripts/conversation-archive-access.dbtest.mjs and fixture helper under scripts/lib.

Interfaces: exact self RPC contracts in spec; service-only reserve_ai_request_for_conversation(user,conversation) wraps existing reserve under usage lock; no new spending on locked ID.

- [x] Add actual PostgreSQL tests: free direct read/preview must reject older own rows; execute existing migrations first and observe behavioral RED.
- [x] Add remaining SQL cases/RPC contracts for new features; implement migration098, run full SQL acceptance GREEN.
- [x] Check ACLs, absent/malformed usage, deletion/error preservation, re-purchase, manual/unlimited and clock boundaries.

## Task2: Endpoint boundaries

Files: shared conversationAccess helper+cases, cost.ts/cases, staysee-chat, weekly-reflection, memory-v3-viewer (guards only).

Interfaces: user-bound get_my_conversation_access returns booleans; reserveAiRequest optional third conversationId selects atomic guarded RPC. Invalid/error denies before content/provider work. Delete actions bypass commercial locks, not ownership.

- [x] Write failing pure/fake-boundary tests for malformed/denied/error access and correct guard RPC selection. Implement minimum helper and endpoint wiring; do not touch prompts or memory construction.
- [x] Run helper tests and full offline suite; Deno check standalone helper, document old26 graph diagnostics rather than suppress them.

## Task3: Safe list and protected screens

Files: src/lib/conversationAccess.ts, MainScreen, protected-screen boundary and App wiring, types, PrivacyScreen; scripts/conversation-access-client.test.ts and UI tests.

Interfaces: safe list validator returns Conversation[] with can_read; delete/rename/reorder succeed only on true server return; boundary unmounts children when rights unknown/closed and clears global transcript on invalidation. Main list preserves menu for closed rows; create free counts accessible slot not archive count.

- [x] Add failing validator/mutation/SSR state tests. Implement transport, menu/locks/errors and protected routing.
- [x] Preserve title/date-only closed rows, delete confirmation and retry, move-to-top only verified paid; accessible label before expiry. Ignore late responses for old owner/version.
- [x] typecheck/offline/dummy build. No permanent frontend test hooks or live auth data.

## Task4: Browser acceptance and final review

- [x] Real local fixture with actual components and controlled data: paid→free, locked delete, accessible delete→new empty, network failure/retry, account switch, 390×844, keyboard and reorder fallback.
- [x] Run final SQL/offline/types/build/diff checks, capture results in docs/CONVERSATION_ARCHIVE_ACCESS.md and ignored progress ledger.
- [x] Fresh read-only final delta review; one Important RED→GREEN fix pass; report all remaining gaps, no deploy/merge.

Local completion20.11: docs/CONVERSATION_ARCHIVE_ACCESS.md. Full Edge Deno still fails on55 baseline-identical diagnostics; real Supabase/PostgREST/multi-session/touch/provider acceptance and production are not completed by this local plan.

