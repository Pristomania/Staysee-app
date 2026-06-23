# Reply pipeline: removed post-generation role truncation

## What was removed

StaySee previously had hidden post-generation paths that shortened or replaced
full provider output after the model had already generated a reply:

- `relationalLifeTurn` char/sentence cap (`truncateToMaxSentences` + `slice(0, 720)`)
- `userFrustrationAtBot` char cap (`slice(0, 520)`)
- `BOUNDARY_FALLBACK_REPLACEMENT_ENABLED` branches: mustPivot fallback replacement,
  bounded-category caps (400/480/520 chars)

These could break contact and present a backend-trimmed answer as if the model
had answered that way, with `generation_status=success`.

Commits: `1a8afe7`, `0c909f7`, and the cleanup that removed dead flag branches.

## Current architecture

**Post-generation (`enforceRoleBoundedReply`):** pass-through only (`content.trim()`).

**Role/boundary protection:** pre-generation — `evaluateTurnSafety` system guidance,
thread escalation hints, role reset guidance. Not output scissors.

**Technical repair (kept):** auto-continue on `finish_reason=length`, finalize for
clearly incomplete replies, `ensurePublishableReply` for broken/unpublishable endings.

**Output ceiling:** token `max_tokens` (~1600 deep tier ceiling) is a technical
boundary, not a target length. Minimal runtime guidance only.

## Next track

`ROLE PROTECTION REDESIGN` — if stronger role protection is needed, implement via
pre-generation routing / explicit fallback responses, not post-generation truncation.
