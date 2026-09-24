# Privacy Screen — Two Separate Memory Delete Buttons Implementation Plan

**Goal:** Split the Privacy screen's single "Удалить память AI" button into two real, independently-working buttons: one that keeps clearing the OLD memory system exactly as today (renamed for clarity), and a NEW one that actually clears Memory V3 (both account-wide/lifecycle and per-dialogue data) — which the current button does not touch at all.

**Why this is needed:** verified today against the current code (not the old July audit) that the existing "Удалить память AI" button only deletes from `user_memory` (the old table, still actively used by the manual "general notes about yourself" section of the Memory screen — confirmed still live and user-editable, not dead code). It does not delete anything from Memory V3 (`memory_v3_lifecycle_shadow_items`, `memory_v3_dialogue_items`, and their related tables). A user clicking "delete AI memory" today would reasonably expect everything gone, but Memory V3 data would silently remain. Настя confirmed there is no hidden schedule re-populating the old table (checked pg_cron entries, GitHub Actions, `weekly-reflection`, `staysee-chat` — none reference the old consolidation function; Настя also confirmed she personally never configured a schedule for it).

**Division of labor (non-negotiable):** Cursor implements and tests everything with synthetic/local data only. Nobody runs the real migration against production, and nobody clicks the real button against production data, until Настя explicitly says so after reviewing the finished PR. Claude (this session) reviews Cursor's diff before it's presented to Настя for the real deploy decision.

## Step 0 — Required reading before writing any code

Read these files in full first — this plan describes the target shape, not a line-by-line diff, and getting the exact current schema wrong here would silently fail to delete real user data:

- `supabase/functions/memory-v3-viewer/index.ts` (current viewer/delete Edge Function — already read in full while writing this plan, reproduced below for reference)
- `supabase/migrations/20260923120000_042_memory_v3_viewer_delete.sql` (existing single-item delete RPCs — the pattern to mirror)
- `supabase/migrations/20260914220000_034_memory_v3_lifecycle_shadow.sql` **in full** — this defines FIVE lifecycle-scope tables: `memory_v3_lifecycle_shadow_heads`, `memory_v3_lifecycle_shadow_items`, `memory_v3_lifecycle_shadow_evidence`, `memory_v3_lifecycle_shadow_identities`, `memory_v3_lifecycle_shadow_runs`. Confirm which of these five have `ON DELETE CASCADE` from `memory_v3_lifecycle_shadow_items`/`memory_v3_lifecycle_shadow_heads` (migration 042's own comment claims evidence already cascades — verify this claim against the actual table definition, don't take the comment on faith) and which do not.
- `supabase/migrations/20260922130000_039_memory_v3_dialogue_isolation.sql` **in full** — defines `memory_v3_dialogue_heads`, `memory_v3_dialogue_items`, `memory_v3_dialogue_evidence` and their cascade relationships.
- `src/components/screens/PrivacyScreen.tsx` (current button, lines ~50, 75-93, ~180-220 — read the file to get exact current line numbers, they will have shifted).
- `src/lib/memoryV3Viewer.ts` (the frontend client for the viewer function — already read in full while writing this plan, reproduced below).

### Open question Step 0 must resolve (judgment call, not pre-decided)

`memory_v3_lifecycle_shadow_identities` and `memory_v3_lifecycle_shadow_runs` — read their actual column definitions and any comments in migration 034 to determine: are these **user-facing memory content** (should be wiped by a "delete my smart memory" button) or **internal operational/audit bookkeeping** (extraction run history, identity-resolution bookkeeping — arguably out of scope for a user-facing "delete my data" action, the same way this project's historical-backfill audit tables were never meant to be user-deletable)? Make a judgment call, document it in the PR description with your reasoning, and if genuinely ambiguous, default to **not** deleting them and flag it clearly for Настя's own review rather than guessing wrong on real user data.

## Step 1 — New migration: two bulk-delete RPCs

Create `supabase/migrations/<timestamp>_recent_number_memory_v3_delete_all.sql` (check the latest existing migration number under `supabase/migrations/` and use the next sequential number — do not reuse or renumber an existing one). Mirror migration 042's exact style (`SECURITY DEFINER`, `SET search_path = ''`, `REVOKE ALL ... GRANT EXECUTE ... TO service_role` only):

```sql
CREATE OR REPLACE FUNCTION public.delete_all_memory_v3_lifecycle_data(
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  -- Delete items first (evidence cascades, per migration 034 -- confirm
  -- this in Step 0 before relying on it). Delete the head last so a
  -- concurrent live write can't recreate items against an already-gone
  -- head in a strange order.
  DELETE FROM public.memory_v3_lifecycle_shadow_items WHERE user_id = p_user_id;
  -- Add explicit DELETE statements here for memory_v3_lifecycle_shadow_identities
  -- and/or memory_v3_lifecycle_shadow_runs ONLY if Step 0's investigation
  -- concludes they hold user-facing memory content, not operational bookkeeping.
  DELETE FROM public.memory_v3_lifecycle_shadow_heads WHERE user_id = p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_all_memory_v3_dialogue_data(
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  -- Scoped by user_id only, across ALL of that user's conversations at
  -- once -- this is a full reset, not a per-conversation operation.
  DELETE FROM public.memory_v3_dialogue_items WHERE user_id = p_user_id;
  DELETE FROM public.memory_v3_dialogue_heads WHERE user_id = p_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_all_memory_v3_lifecycle_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_all_memory_v3_lifecycle_data(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.delete_all_memory_v3_dialogue_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_all_memory_v3_dialogue_data(uuid) TO service_role;
```

Add a structural test mirroring this repo's existing `*.cases.test.ts` pattern for migration files (pure regex/text assertions against the raw SQL, no live DB — see `supabase/functions/_shared/memoryV3/*.cases.test.ts` for the established style in this repo) confirming: both functions exist, both are scoped by `p_user_id` only (no other filter), both grant EXECUTE to `service_role` only, and REVOKE from `PUBLIC, anon, authenticated`.

## Step 2 — Edge Function: new `delete_all` action

In `supabase/functions/memory-v3-viewer/index.ts`, add a new branch alongside the existing `action === "delete"` branch:

```typescript
if (body.action === "delete_all") {
  const scope = body.scope;
  if (scope !== "account_wide" && scope !== "dialogue") {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const rpcName = scope === "dialogue"
    ? "delete_all_memory_v3_dialogue_data"
    : "delete_all_memory_v3_lifecycle_data";
  const { error } = await svc.rpc(rpcName, { p_user_id: userId });
  if (error) {
    console.error(`[memory-v3-viewer] ${rpcName}:`, error.message);
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ deleted: true }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
```

Confirm this repo has an existing test file for `memory-v3-viewer` (search for it — Deno edge functions in this repo are typically tested via `*.cases.test.ts` files under `supabase/functions/_shared/` or a dedicated test alongside the function). If one exists, extend it with cases for `delete_all` (both scopes, missing/invalid scope, RPC error path). If none exists, do not invent a new testing convention — check how `staysee-chat`'s own tests are structured and mirror that, or ask Claude before improvising.

## Step 3 — Frontend client (`src/lib/memoryV3Viewer.ts`)

Add:

```typescript
export async function deleteAllMemoryV3Data(
  scope: 'account_wide' | 'dialogue',
): Promise<{ deleted: boolean; error: string | null }> {
  const result = await callMemoryV3Viewer<{ deleted: boolean }>({ action: 'delete_all', scope });
  if ('error' in result) return { deleted: false, error: result.error };
  return { ...result, error: null };
}
```

Note this calls it once per scope — the Privacy screen button (Step 4) needs to call it twice (once for `account_wide`, once for `dialogue`) to actually clear everything, since the backend keeps the two scopes as separate operations (matching how every other Memory V3 operation in this codebase treats the two scopes as genuinely separate, never a single combined call).

## Step 4 — Privacy screen: two buttons

In `src/components/screens/PrivacyScreen.tsx`:

1. Rename the existing button's visible label from "Удалить память AI" to "Удалить старую память" (or Настя's preferred exact wording — ask her for the final copy before shipping, don't guess Russian UX copy). **Do not change `handleDeleteMemory`'s logic at all** — it already correctly does exactly what this button should keep doing.
2. Add a new button "Удалить данные умной памяти" (exact wording: confirm with Настя) with its own confirm-before-delete state (mirror `handleDeleteMemory`'s existing `idle → confirming → loading → done/error` state machine shape — do not invent a different UX pattern for the second button, keep both buttons feeling identical to the user):

```typescript
const [deleteMemoryV3State, setDeleteMemoryV3State] = useState<DeleteState>('idle');

async function handleDeleteMemoryV3() {
  if (!user) return;
  if (deleteMemoryV3State === 'idle') {
    setDeleteMemoryV3State('confirming');
    return;
  }
  if (deleteMemoryV3State !== 'confirming') return;
  setDeleteMemoryV3State('loading');
  try {
    const [lifecycleResult, dialogueResult] = await Promise.all([
      deleteAllMemoryV3Data('account_wide'),
      deleteAllMemoryV3Data('dialogue'),
    ]);
    if (lifecycleResult.error || dialogueResult.error) throw new Error('delete_all_failed');
    setDeleteMemoryV3State('done');
  } catch {
    setDeleteMemoryV3State('error');
  }
}
```

Import `deleteAllMemoryV3Data` from `../../lib/memoryV3Viewer`. Place the new button visually next to the existing one, matching the existing button's styling exactly (read the JSX around the current button to copy its exact class names/layout, don't introduce a new visual style).

## Step 5 — Testing (Cursor's own verification, before handing back)

- Frontend: if this repo has component/unit tests for `PrivacyScreen.tsx` or similar screens, add one exercising the new button's state machine (mock `deleteAllMemoryV3Data`, assert idle→confirming→loading→done, and the error path). If no such test convention exists for screens in this repo, say so explicitly in the report rather than inventing one.
- Backend: the new migration's structural test (Step 1) must pass. If a `memory-v3-viewer` test file exists or gets created (Step 2), it must pass with fakes/mocks only — no real Supabase connection, no real user data, matching every other test in this codebase.
- Run this repo's normal `npm run typecheck` and `npm run lint` on the touched files and report the results — the July audit already found the baseline `typecheck`/`lint` failing repo-wide for unrelated pre-existing reasons (`AllowedCrossMemoryType not found`, etc.); confirm your changes don't add NEW errors beyond that pre-existing baseline, the same way today's Memory V3 work always checked for "no new failures beyond the known baseline."

## Step 6 — Report back, do not deploy

Write a report covering: the exact judgment call made in Step 0 (identities/runs tables), the new migration file's exact name, all files changed, test results, and any open questions. Commit and push to a new branch, open a PR (same style as today's other PRs — plain-Russian description explaining what changed and why, in terms Настя can follow). **Do not merge. Do not run `supabase db push` against production. Do not click the real button.** Those are Настя's own steps once she's reviewed the PR.
