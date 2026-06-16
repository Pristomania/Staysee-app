# StaySee V3 — stable baseline

Stable return point for production AI stack after runtime cleanup (June 2026).

## Tag

| Field | Value |
|-------|-------|
| Tag | `staysee-v3-stable` |
| Commit | `2d15df15d4042dcebf9353699c5c86a9926367ee` (`2d15df1`) |
| Branch | `main` |
| Message | `fix(ai): remove legacy brief hold runtime shortcuts` |

## Key commits (V3 arc)

| Hash | Summary |
|------|---------|
| `71c5348` | `fix(ai): add v3 cognitive prompt stack and runtime closure guidance` |
| `1bd94fd` | `fix(ai): disable deterministic boundary fallback replacement` |
| `2d15df1` | `fix(ai): remove legacy brief hold runtime shortcuts` |

## Active prompt stack

Implemented in `supabase/functions/_shared/surgery1Prompt.ts`:

```
surgery1-v3-cognitive-v1
  → Voice V3
  → Constitution V3 Beta
  → Cognitive Signature V1
  → Constraints
```

## Runtime (active)

| Module | Role |
|--------|------|
| `uncertaintyTurnGuidance` | Active conversation process for uncertainty turns |
| `explicitClosureTurnGuidance` | Closure / arc guidance |
| `responseDepthTrajectory` | Depth routing (brief / medium / deep) |
| `roleEnforcement` | Role guard; boundary replacement **disabled** |

## Removed (runtime cleanup)

- `continue_redo` — user “продолжай / допиши / еще” no longer forces brief
- `holdThreadRole` — no brief override + 300-token cap on escalated threads
- `brief300` — no hard 300-token ceiling via hold
- Deterministic boundary fallback replacement
- Legal runtime penalties (`legal_financial_boundary` no longer affects depth/budget/hold)

## Preserved

- Crisis `immediateResponse` (model skipped)
- Medical `medical_boundary` (brief via `safety_brief`, ~380 tokens)
- `autoContinue` for `finishReason=length` only
- Deep → Sonnet routing (`modelRouter.ts`)

## Prod verification (2026-06-10)

Deploy: `staysee-chat` on project `jnxrildlwvtxhtiwucbt` after `2d15df1`.

Smoke (all PASS):

1. **Egor-like** — Sonnet, deep, no brief300 stub
2. **Continue phrases** — context replies, no forced brief
3. **Legal words** — no runtime penalty
4. **Medical** — boundary intact
5. **Crisis** — `immediateResponse` intact

## Rollback to this stable version

```bash
git fetch origin
git checkout staysee-v3-stable
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

To return to latest `main` after inspection:

```bash
git checkout main
```

### Rollback to pre-cleanup (boundary fallback still disabled)

```bash
git checkout 1bd94fd
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

### Rollback to pre–V3 cognitive stack

See `docs/archive/README.md` (V2.1 layered stack).

## Related files

| Path | Purpose |
|------|---------|
| `supabase/functions/_shared/surgery1Prompt.ts` | Prompt assembly |
| `supabase/functions/_shared/responseDepthTrajectory.ts` | Depth routing |
| `supabase/functions/_shared/roleEnforcement.ts` | Safety + role |
| `supabase/functions/staysee-chat/index.ts` | Edge function entry |
| `supabase/functions/_shared/runtimeCleanup.cases.test.ts` | Regression tests |
