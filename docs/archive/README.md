# StaySee AI — rollback archive (pre–v3-cognitive)

Active production stack (`surgery1-v3-cognitive-v1`):

```
IDENTITY → VOICE V3 → CONSTITUTION V3 Beta → COGNITIVE SIGNATURE V1 → CONSTRAINTS
```

Implemented in `supabase/functions/_shared/surgery1Prompt.ts`.

## Rollback to V2.1 layered stack

If an explicit rollback is needed, restore prompt assembly from:

| Layer | Source |
|-------|--------|
| Identity | `supabase/functions/_shared/identity.ts` |
| Gestalt | `supabase/functions/_shared/gestalt.ts` |
| Methodology | `supabase/functions/_shared/methodology.ts` |
| Safety | `supabase/functions/_shared/safety.ts` (buildSafetyPrompt) |
| Constitution (short) | `supabase/functions/_shared/constitution.ts` |
| Presence | `supabase/functions/_shared/presence.ts` |
| Stance (runtime) | `supabase/functions/_shared/stance.ts` |
| Constitution full | `docs/CONSTITUTION_FULL_V2_1.md` |

Regenerate V2.1 edge block (rollback only):

```bash
node scripts/generate-prompt-blocks.mjs --rollback-v21
```

Do **not** import `constitutionV21.ts` in production until rollback is decided.
