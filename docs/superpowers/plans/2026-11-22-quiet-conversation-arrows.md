# Quiet Conversation Arrows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved borderless14px arrows without changing44px targets or ordering behavior.
**Architecture:** Presentation-only changes in existing controls; preserve callbacks, refs and focus effect. Existing browser harness renders the actual component against a controlled RPC boundary.
**Tech Stack:** Existing React, Tailwind and Lucide, no dependencies.
**Spec:** docs/superpowers/specs/2026-11-22-quiet-conversation-arrows-design.md

## Global Constraints

At least44×44px hit areas, thin14px icons, quiet12px done text, transparent borderless buttons, row height<=46px. No production/SQL/API changes. Update draft219 only.

## Review Focus

1. Edges: disabled arrow remains disabled and focus picks enabled alternative (existing browser scenario).
2. Saving: single in-flight click, all controls disabled (existing scenario).
3. Small screens:44px targets without overflow (new appearance check +12geometry cases).
4. Theme: inherited secondary text remains visible in deep/light/mist (browser inspection).
5. Keyboard: focus retained after DOM reorder, no preventScroll regression (existing scenario).

### Task 1: Borderless presentation and verification

**Files:** Modify src/components/ConversationOrderControls.tsx and tests/browser/conversation-order.tsx; document final results in this plan/PR.
**Interfaces:** Preserve first,last,saving,onMove,onDone unchanged.

- [x] Add computed-style browser check: border0,14px icons,stroke1.5,12px done,row<=46px; keep existing44px target check.
- [x] Build isolated static QA pages and run RED on current control styling.
- [x] Adjust only classes/icon stroke attributes. Run GREEN14component cases and12geometry cases, inspect390×844 and inherited theme color.
- [x] Run complete offline suite,typecheck,full lint,QA build/verify/smoke. One read-only review of the small delta; update draft219 only, never deploy.

Verification22.11: RED «quiet controls still have visible button borders» after44pxPASS; GREEN14/14 and12/12geometry. Actual390×844 metrics: button44×44/44×44/55.19×44,icon14px,stroke1.5px,border0,row46px,Done12px; button colors equal the parent's secondary color. Native focus/ref restoration and all prior13behavior cases passed.3097/3097offline(1660+54+470+913),typecheck/lint/build/bundle-check/smoke exit0; existing11lint warnings and bundle-size warning retained. Fresh read-only delta review: no findings. SQL/API/full-stack not rerun for this presentation-only change; prior113acceptance remains separate. Physical phones,all-theme device contrast and original iPhone blank space not claimed checked.

Self-review: all five risks map to existing browser scenarios or the new appearance check. No new behavior/API or hardware-acceptance claim.
