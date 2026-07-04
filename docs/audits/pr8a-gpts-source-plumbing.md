# PR8a — GPTs source snapshots + v2 plumbing

**Status:** plumbing only — no deploy, no env/secrets, no v2 core text authored by agent  
**Branch:** `feat/pr8a-gpts-source-plumbing`  
**Baseline:** production @ PR7a (`staysee-chat` v112, `STAYSEE_PROMPT_CORE=v1`)

---

## What was extracted

| Snapshot | Source docx | PR8a status |
|----------|-------------|-------------|
| `docs/gpts-source/01-promt.md` | `Промт.docx` | **INTERIM** — body from working draft; re-extract when docx placed in `_source/` |
| `docs/gpts-source/02-instrukciya-obshcheniya.md` | `Инструкция общения.docx` | **INTERIM** — same |
| `docs/gpts-source/03-rukovodstvo-gpts.md` | `Руководство для GPTs.docx` | **PENDING** — no docx on disk at commit time |
| `docs/gpts-source/04-unac-metodologiya.md` | `Унак Методология Стэйси.docx` | **PENDING** |
| `docs/gpts-source/05-protokol-sessij.md` | `Протокол организации сессий.docx` | **PENDING** |

Mechanical extractor: `scripts/extract-gpts-source-docx.mjs`  
Drop originals in `docs/gpts-source/_source/` (see README there) and re-run.

---

## What plumbing was added

| File | Purpose |
|------|---------|
| `supabase/functions/_shared/promptCore/stayseeCorePromptV2GptsSource.ts` | v2 layer id + builder with **placeholder only** |
| `supabase/functions/_shared/promptCore/promptCoreMode.ts` | accepts `STAYSEE_PROMPT_CORE=v2` |
| `supabase/functions/_shared/surgery1Prompt.ts` | routes `v2` → v2 builder |
| `supabase/functions/_shared/aiAuditVersions.ts` | unchanged — already uses `resolveActivePromptLayerId` |
| `supabase/functions/_shared/gptsSourceSnapshots.cases.test.ts` | snapshot + anchor tests |
| `supabase/functions/_shared/stayseeCorePrompt.cases.test.ts` | extended with v2 plumbing cases |
| `scripts/pr8-staging-gpts-source-smoke.mjs` | skeleton smoke (do not run until v2 core inserted) |

**v2 layer id:** `staysee-core-v2-gpts-source`  
**v2 env:** `STAYSEE_PROMPT_CORE=v2` (not set anywhere in this PR)

---

## Explicit note: core text not authored by agent

The v2 module contains only:

```
TODO_APPROVED_GPTS_SOURCE_CORE_TEXT_WILL_BE_INSERTED_SEPARATELY
```

No Stacey Core V2 prose was invented, rewritten, or composed in this PR.

---

## Not changed

- `stayseeCorePrompt.ts` (v1)
- PR7a protocol/safety modules (`protocolSignalPrompt`, hard-stops, etc.)
- Frontend
- Migrations
- `.env` / secrets
- Production / staging runtime config

---

## Next step

1. Product owner places five `.docx` in `docs/gpts-source/_source/`
2. Run `node scripts/extract-gpts-source-docx.mjs` → full verbatim snapshots
3. Product owner/chat inserts approved GPTs core text into `stayseeCorePromptV2GptsSource.ts`
4. PR8b: flip staging `STAYSEE_PROMPT_CORE=v2`, run `PR8_SMOKE_RUN=1 node scripts/pr8-staging-gpts-source-smoke.mjs`

---

## Tests

```bash
npx tsx supabase/functions/_shared/stayseeCorePrompt.cases.test.ts
npx tsx supabase/functions/_shared/gptsSourceSnapshots.cases.test.ts
node scripts/pr8-staging-gpts-source-smoke.mjs   # skeleton only, no network
```
