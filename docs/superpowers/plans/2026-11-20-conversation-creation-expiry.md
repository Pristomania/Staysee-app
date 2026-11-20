# Conversation Creation Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Work inline with RED→GREEN tests, then one fresh review.

**Goal:** Закрыть создание лишних бесед по истёкшему сырому тарифу без изменения квоты.

**Architecture:** Replace existing SQL trigger function only; reuse087 trigger. Read/lock usage, calculate effective tier against clock_timestamp after lock, count active conversations.

**Tech Stack:** PostgreSQL PL/pgSQL, Node test, isolated PGlite already available in tmp.

**Spec:** docs/superpowers/specs/2026-11-20-conversation-creation-expiry-design.md

## Global Constraints

- No production, secrets, model calls, deploys, commits or memory changes.
- Paid term independent of quota; legacy manual/unlimited/override preserved.
- Existing conversations and usage values remain unchanged.
- This is creation only, not completed archive access control.

## Review Focus

- Expiry without quota settlement: second insert denied while raw tier remains paid.
- Expiry after transaction start: use server clock after usage lock.
- Deactivation/reactivation cannot bypass count.
- Existing over-limit data remains intact; ordinary updates do not fail.
- Fallback and explicit override remain bounded and match previous semantics.

## Task1: SQL creation guard

**Files:** create scripts/conversation-creation-expiry.dbtest.mjs and supabase/migrations/20261120180000_102_conversation_creation_expiry.sql.

**Interfaces:** consumes usage columns095 and existing trigger087; produces same enforce_conversation_limit() trigger/error conversation_limit_reached.

- [ ] Add SQL regressions executing existing087, optionally097; require at least expired purchase test fail before new migration exists, not import/file error.
- [ ] Run node --test scripts/conversation-creation-expiry.dbtest.mjs; inspect expected assertion failures.
- [ ] Implement minimal097 function with usage lock before clock comparison; leave existing trigger and data intact.
- [ ] Run SQL tests, existing paid-access and snapshot SQL tests, npm run test:offline, git diff --check.
- [ ] Fresh read-only final review of this delta; Important fixes get one RED→GREEN pass. Report limitations; do not commit/deploy without authority.
