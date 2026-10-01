# Memory V3 Data Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user download everything Memory V3 remembers about them — lifecycle (account-wide) and dialogue (per-conversation, across *all* conversations) facts and hypotheses — as a single PDF or JSON file, generated and downloaded synchronously in the browser.

**Architecture:** One new migration adds `alternative` to the two existing viewer RPCs and a new `load_memory_v3_dialogue_viewer_items_all` RPC; a new `projectMemoryV3ExportItems` projection keeps every item kind (including `hypothesis`) and the `alternative` field; a new `"export"` action on the `memory-v3-viewer` edge function calls both RPCs and projects the results; the frontend adds a button on the Память screen that fetches this data and writes it out as a downloaded `.json` or `.pdf` file, entirely client-side.

**Tech Stack:** Supabase Postgres (SQL migration, `SECURITY DEFINER` RPC), Deno edge function (TypeScript), React/Vite frontend (TypeScript), new `jspdf` dependency for client-side PDF generation.

**Spec:** `docs/superpowers/specs/2026-10-01-memory-v3-data-export-design.md` (committed locally at `0fa092b`, not yet pushed — push it together with this plan's feature branch).

## Global Constraints

- Export is memory only: lifecycle + dialogue facts and hypotheses. No raw conversation transcripts.
- No email delivery, no server-side temporary storage, no expiring links, no cleanup job. Everything is generated and downloaded synchronously, in one request, in the browser.
- The user is never asked to remember a PDF/JSON preference — asked every time, via one button that reveals an inline choice.
- Sensitive items appear in the export under their real claim text, unmasked — this is deliberate (see Task 6), not an oversight.
- The existing per-conversation viewer RPCs, `projectMemoryV3ViewerItems`, and the regular Память screen's day-to-day behavior must not change.
- Never touch `load_memory_v3_lifecycle_read_context` or `load_memory_v3_dialogue_read_context` (the hot-path RPCs that feed the AI's own prompt) — every migration test in this codebase asserts this, and this plan's new migration test does too.
- Frontend changes are verified with `npm run typecheck` and `npm run lint` — this project has no configured frontend unit-test runner (confirmed: no `vitest`/`jest`/`@testing-library` in `package.json`), so no new frontend automated test is invented for this plan. Backend changes (migration, projection function) get real Deno-based unit tests, matching every other backend change in this codebase.
- Running the Deno suite for `supabase/functions/_shared/memoryV3/` requires **both** `--allow-read` and `--allow-env` (React, imported by `memoryV3ItemList.cases.test.tsx`, reads `process.env.NODE_ENV` on import — without `--allow-env` that one file's suite silently fails to load, indistinguishable from a real failure). Use: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/`.

## Review Focus

- **An account with dialogue memory in more than one conversation**: the new "all conversations" RPC must return items from every conversation the user has, not just the most recently active one. Task 1's migration test checks the RPC has no `conversation_id` filter at all; a true multi-conversation check only happens by inspection of the SQL (no local Postgres to run it against), so the SQL itself must be read carefully against this requirement.
- **An account with zero memory in one or both scopes**: export must produce a valid empty-but-well-formed file (`{ accountWide: [], dialogue: [] }`), not an error or a crash in the PDF layout. Task 2 tests `projectMemoryV3ExportItems([])`, and Task 5's PDF layout function explicitly branches on an empty list to print "Пусто." instead of crashing on an empty loop producing no output.
- **A hypothesis item**: must appear in the export with its `alternative` text — the entire point of including hypotheses here. Task 2's tests check this at the projection layer; Task 6's manual click-through is the one place this is checked end-to-end.
- **A claim or alternative containing characters that could break PDF layout** (very long single claims, no whitespace to wrap on) must not crash `jspdf`. Task 5 uses `doc.splitTextToSize()` for every piece of rendered text (claim, alternative) specifically so long text wraps instead of overflowing or throwing, and adds a new page when the cursor runs past the page height instead of writing off the bottom edge.
- **The edge function's two RPC calls partially failing** (one succeeds, one errors): per the spec's error-handling section, export must fail loudly (`{ error: "internal" }`) rather than silently return partial data as if it were the whole truth. Task 3 deliberately makes the `"export"` action return early with an error on either RPC failure — unlike the existing `"read"` action, which logs and continues with an empty array. Task 3's wiring test pins this.

---

### Task 1: Migration — add `alternative` to existing viewer RPCs, add the new "all conversations" dialogue RPC

**Files:**
- Create: `supabase/migrations/20261001220000_062_memory_v3_export.sql`
- Create: `supabase/functions/_shared/memoryV3/exportMigration.cases.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first task).
- Produces: `public.load_memory_v3_dialogue_viewer_items_all(p_user_id uuid) RETURNS jsonb` — same field shape as the existing per-conversation RPC plus `alternative`, scoped by `user_id` only. Also: `public.load_memory_v3_lifecycle_viewer_items(p_user_id uuid)` and `public.load_memory_v3_dialogue_viewer_items(p_user_id uuid, p_conversation_id uuid)` now both additionally return `'alternative', i.alternative` in their JSON (their signatures are unchanged — same two functions, `CREATE OR REPLACE`). Task 2's backend code consumes all three RPCs' JSON shape, which now always includes `alternative: string | null`.

- [ ] **Step 1: Write the failing migration test**

Create `supabase/functions/_shared/memoryV3/exportMigration.cases.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "..", "..", "..", "migrations", "20261001220000_062_memory_v3_export.sql"),
  "utf8",
);

function bodyOf(fnName: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
  assert.notEqual(start, -1, `migration must define ${fnName}`);
  const rest = sql.slice(start + 1);
  const nextStart = rest.indexOf("CREATE OR REPLACE FUNCTION public.");
  return nextStart === -1 ? sql.slice(start) : sql.slice(start, start + 1 + nextStart);
}

describe("Memory V3 export migration", () => {
  it("adds alternative to load_memory_v3_lifecycle_viewer_items's returned JSON", () => {
    assert.match(bodyOf("load_memory_v3_lifecycle_viewer_items"), /'alternative', i\.alternative/);
  });

  it("adds alternative to load_memory_v3_dialogue_viewer_items's returned JSON", () => {
    assert.match(bodyOf("load_memory_v3_dialogue_viewer_items"), /'alternative', i\.alternative/);
  });

  it("keeps firstSeenAt and updatedAt from prior migrations on all three functions", () => {
    assert.equal((sql.match(/'firstSeenAt', i\.first_seen_at/g) ?? []).length, 3);
    assert.equal((sql.match(/'updatedAt', i\.updated_at/g) ?? []).length, 3);
  });

  it("defines load_memory_v3_dialogue_viewer_items_all with alternative and no conversation filter", () => {
    const body = bodyOf("load_memory_v3_dialogue_viewer_items_all");
    assert.match(body, /'alternative', i\.alternative/);
    assert.doesNotMatch(body, /p_conversation_id/);
    assert.doesNotMatch(body, /conversation_id = /);
    assert.match(body, /WHERE i\.user_id = p_user_id;/);
  });

  it("restricts the new function's EXECUTE to service_role only", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.load_memory_v3_dialogue_viewer_items_all\(uuid\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.load_memory_v3_dialogue_viewer_items_all\(uuid\) TO service_role;/);
  });

  it("never touches the hot-path read context RPCs", () => {
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_lifecycle_read_context/.test(sql), false);
    assert.equal(/CREATE OR REPLACE FUNCTION public\.load_memory_v3_dialogue_read_context/.test(sql), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/exportMigration.cases.test.ts`
Expected: FAIL — the migration file does not exist yet (`readFileSync` throws `ENOENT`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261001220000_062_memory_v3_export.sql`:

```sql
-- Adds `alternative` to the two existing Memory V3 viewer-read RPCs (a
-- hypothesis's alternative explanation, currently only used by the
-- lifecycle/dialogue read-context prompts, never by the viewer) and adds a
-- new load_memory_v3_dialogue_viewer_items_all RPC that returns a user's
-- dialogue memory across every conversation at once, for the data-export
-- feature -- the regular per-conversation Память screen keeps using the
-- existing load_memory_v3_dialogue_viewer_items unchanged. Adding a field
-- the existing viewer code doesn't read is additive and harmless: nothing
-- in projectMemoryV3ViewerItems looks at `alternative`, so the day-to-day
-- viewer's behavior does not change.
-- Same deliberate separation from the hot-path read RPCs as every prior
-- viewer migration -- this never touches load_memory_v3_lifecycle_read_context
-- or load_memory_v3_dialogue_read_context.

CREATE OR REPLACE FUNCTION public.load_memory_v3_lifecycle_viewer_items(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at,
      'alternative', i.alternative
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_lifecycle_shadow_items i
  WHERE i.user_id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items(
  p_user_id uuid, p_conversation_id uuid
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at,
      'alternative', i.alternative
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id AND i.conversation_id = p_conversation_id;
$function$;

CREATE OR REPLACE FUNCTION public.load_memory_v3_dialogue_viewer_items_all(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'memoryKey', i.memory_key,
      'kind', i.kind,
      'claim', i.claim,
      'sensitivity', i.sensitivity,
      'eventTimeStart', i.event_time_start,
      'eventTimeEnd', i.event_time_end,
      'topic', i.topic,
      'firstSeenAt', i.first_seen_at,
      'updatedAt', i.updated_at,
      'alternative', i.alternative
    ) ORDER BY i.updated_at DESC, i.memory_key COLLATE "C"
  ), '[]'::jsonb)
  FROM public.memory_v3_dialogue_items i
  WHERE i.user_id = p_user_id;
$function$;

REVOKE ALL ON FUNCTION public.load_memory_v3_dialogue_viewer_items_all(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_memory_v3_dialogue_viewer_items_all(uuid) TO service_role;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/exportMigration.cases.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261001220000_062_memory_v3_export.sql supabase/functions/_shared/memoryV3/exportMigration.cases.test.ts
git commit -m "feat: add Memory V3 export migration (alternative field + all-conversations dialogue RPC)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `projectMemoryV3ExportItems` projection function

**Files:**
- Modify: `supabase/functions/_shared/memoryV3/viewerProjection.ts`
- Modify: `supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`

**Interfaces:**
- Consumes: the RPC JSON shape from Task 1, now always including `alternative: string | null`.
- Produces: `export interface MemoryV3ExportItem { memoryKey: string; kind: "event" | "recurrence" | "hypothesis"; claim: string; eventTimeStart: string | null; eventTimeEnd: string | null; sensitivity: "normal" | "sensitive"; topic: string | null; firstSeenAt: string; updatedAt: string; alternative: string | null; }` and `export function projectMemoryV3ExportItems(items: MemoryV3ViewerSourceItem[]): MemoryV3ExportItem[]`. Task 3's edge function imports both.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts` with:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectMemoryV3ViewerItems, projectMemoryV3ExportItems } from "./viewerProjection.ts";

describe("Memory V3 viewer projection", () => {
  it("keeps only event and recurrence kinds, dropping hypotheses", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.deepEqual(result, [
      { memoryKey: "a", kind: "event", claim: "X", eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal", topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", eventTimeStart: null, eventTimeEnd: null, sensitivity: "sensitive", topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
    ]);
  });

  it("passes through dates and keeps the field set exact", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: "2026-01-01", eventTimeEnd: "2026-01-31", topic: "life_context", firstSeenAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-20T08:00:00Z", alternative: null },
    ]);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "claim", "eventTimeEnd", "eventTimeStart", "firstSeenAt", "kind", "memoryKey", "sensitivity", "topic", "updatedAt",
    ]);
    assert.equal(result[0].eventTimeStart, "2026-01-01");
    assert.equal(result[0].eventTimeEnd, "2026-01-31");
    assert.equal(result[0].firstSeenAt, "2026-08-01T00:00:00Z");
    assert.equal(result[0].updatedAt, "2026-09-20T08:00:00Z");
  });

  it("returns an empty array for an empty or all-hypothesis input", () => {
    assert.deepEqual(projectMemoryV3ViewerItems([]), []);
    assert.deepEqual(projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "hypothesis", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Y" },
    ]), []);
  });

  it("strips a leading 'пользователь'/'клиент' from already-stored claims and re-capitalizes", () => {
    const cases: Array<[string, string]> = [
      ["Пользователь любит утренние прогулки", "Любит утренние прогулки"],
      ["пользователь работает удалённо", "Работает удалённо"],
      ["Пользователь: переехала в Казань", "Переехала в Казань"],
      ["Клиент предпочитает переписку", "Предпочитает переписку"],
    ];
    for (const [input, expected] of cases) {
      const [result] = projectMemoryV3ViewerItems([
        { memoryKey: "a", kind: "event", claim: input, sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      ]);
      assert.equal(result.claim, expected, input);
    }
  });

  it("does not touch a claim that never had the word at the start, or one that's just the word alone", () => {
    const untouched = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Уважает мнение пользователя в группе", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(untouched[0].claim, "Уважает мнение пользователя в группе");

    const wordAlone = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "Пользователь", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(wordAlone[0].claim, "Пользователь");
  });

  it("passes topic through unchanged, including null", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "recurrence", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result[0].topic, "life_context");
    assert.equal(result[1].topic, null);
  });

  it("passes updatedAt through unchanged", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-15T12:30:00Z", alternative: null },
    ]);
    assert.equal(result[0].updatedAt, "2026-03-15T12:30:00Z");
  });

  it("passes firstSeenAt through unchanged, even when it differs from updatedAt", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result[0].firstSeenAt, "2026-01-01T00:00:00Z");
    assert.equal(result[0].updatedAt, "2026-06-01T00:00:00Z");
  });
});

describe("Memory V3 export projection", () => {
  it("keeps all three kinds, including hypothesis", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Альтернатива Y" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, topic: "life_context", firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((item) => item.kind).sort(), ["event", "hypothesis", "recurrence"]);
  });

  it("keeps the alternative field for a hypothesis", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "hypothesis", claim: "Возможно, часто тревожится перед встречами", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: "Или просто готовится заранее" },
    ]);
    assert.equal(result[0].alternative, "Или просто готовится заранее");
  });

  it("still strips the leading 'пользователь'/'клиент' word", () => {
    const [result] = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "Пользователь любит утренние прогулки", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.equal(result.claim, "Любит утренние прогулки");
  });

  it("keeps the field set exact, including alternative", () => {
    const result = projectMemoryV3ExportItems([
      { memoryKey: "a", kind: "event", claim: "X", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, topic: null, firstSeenAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", alternative: null },
    ]);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "alternative", "claim", "eventTimeEnd", "eventTimeStart", "firstSeenAt", "kind", "memoryKey", "sensitivity", "topic", "updatedAt",
    ]);
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(projectMemoryV3ExportItems([]), []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`
Expected: FAIL — `projectMemoryV3ExportItems` is not exported yet, and the existing tests' fixtures now include an `alternative` field the current `MemoryV3ViewerSourceItem` type doesn't declare (TypeScript error under `deno check`, or simply a missing-export runtime error).

- [ ] **Step 3: Implement**

Replace the full contents of `supabase/functions/_shared/memoryV3/viewerProjection.ts` with:

```ts
export interface MemoryV3ViewerSourceItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
  alternative: string | null;
}

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: "event" | "recurrence";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface MemoryV3ExportItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
  alternative: string | null;
}

// The extractor prompt now tells the model never to write "пользователь"/
// "клиент" as a claim's subject (see prompt.ts), so this only matters for
// claims already stored before that fix shipped. Display-only cleanup --
// never rewrites what's actually stored in the database.
const LEADING_SUBJECT_WORD_RE = /^(?:пользователь|клиент)\s*[:,-]?\s+(\S.*)$/iu;

function stripLeadingSubjectWord(claim: string): string {
  const match = LEADING_SUBJECT_WORD_RE.exec(claim);
  if (!match) return claim;
  const rest = match[1];
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Curates raw Memory V3 items for the user-facing viewer: confirmed
 * facts and patterns only, never a hypothesis. */
export function projectMemoryV3ViewerItems(
  items: MemoryV3ViewerSourceItem[],
): MemoryV3ViewerItem[] {
  return items
    .filter((item): item is MemoryV3ViewerSourceItem & { kind: "event" | "recurrence" } =>
      item.kind === "event" || item.kind === "recurrence")
    .map((item) => ({
      memoryKey: item.memoryKey,
      kind: item.kind,
      claim: stripLeadingSubjectWord(item.claim),
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      sensitivity: item.sensitivity,
      topic: item.topic,
      firstSeenAt: item.firstSeenAt,
      updatedAt: item.updatedAt,
    }));
}

/** Curates raw Memory V3 items for a full data export: every kind,
 * including hypotheses with their alternative explanation -- unlike the
 * day-to-day viewer, this is meant to be a complete, transparent copy of
 * what the account holds, not a curated read. */
export function projectMemoryV3ExportItems(
  items: MemoryV3ViewerSourceItem[],
): MemoryV3ExportItem[] {
  return items.map((item) => ({
    memoryKey: item.memoryKey,
    kind: item.kind,
    claim: stripLeadingSubjectWord(item.claim),
    eventTimeStart: item.eventTimeStart,
    eventTimeEnd: item.eventTimeEnd,
    sensitivity: item.sensitivity,
    topic: item.topic,
    firstSeenAt: item.firstSeenAt,
    updatedAt: item.updatedAt,
    alternative: item.alternative,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`
Expected: PASS (13 tests: 8 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/memoryV3/viewerProjection.ts supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts
git commit -m "feat: add projectMemoryV3ExportItems (keeps hypotheses and alternative for data export)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `memory-v3-viewer` edge function — new `"export"` action

**Files:**
- Modify: `supabase/functions/memory-v3-viewer/index.ts`
- Modify: `supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts`

**Interfaces:**
- Consumes: `projectMemoryV3ExportItems` and `MemoryV3ExportItem` from Task 2; `load_memory_v3_dialogue_viewer_items_all` and the updated RPCs from Task 1; the existing `resolveVerifiedChatUser`, `makeServiceClient`, `resolveMemoryV3DialogueEligibility` already wired into this file.
- Produces: POST body `{ action: "export", userId?: string }` → `200 { accountWide: MemoryV3ExportItem[], dialogue: MemoryV3ExportItem[] }` on success, or `{ error: "internal" }` (500) / `{ error: <auth reason> }` on failure. Task 4's frontend `exportMemoryV3Data()` calls this.

- [ ] **Step 1: Write the failing wiring tests**

In `supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts`, change the existing count assertion and add four new tests. The full file becomes:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX_URL = new URL("../../memory-v3-viewer/index.ts", import.meta.url);

function indexSource(): string {
  return readFileSync(INDEX_URL, "utf8");
}

describe("memory-v3-viewer wiring", () => {
  it("verifies the caller's JWT before doing anything else", () => {
    const source = indexSource();
    assert.match(source, /resolveVerifiedChatUser/);
    const verifyIndex = source.indexOf("resolveVerifiedChatUser");
    const rpcIndex = source.indexOf(".rpc(");
    assert.ok(verifyIndex >= 0 && rpcIndex > verifyIndex, "must verify identity before any RPC call");
  });

  it("scopes every RPC call to the verified caller's own userId, never a client-supplied one", () => {
    const source = indexSource();
    assert.equal((source.match(/p_user_id:\s*userId/g) ?? []).length, 7);
  });

  it("exposes delete_all for both Memory V3 scopes and rejects any other scope", () => {
    const source = indexSource();
    assert.match(source, /body\.action === "delete_all"/);
    assert.match(source, /delete_all_memory_v3_dialogue_data/);
    assert.match(source, /delete_all_memory_v3_lifecycle_data/);
    const deleteAllIndex = source.indexOf('body.action === "delete_all"');
    const scopeCheck = source.indexOf('scope !== "account_wide" && scope !== "dialogue"', deleteAllIndex);
    const invalidRequest = source.indexOf('error: "invalid_request"', deleteAllIndex);
    assert.ok(deleteAllIndex >= 0 && scopeCheck > deleteAllIndex && invalidRequest > scopeCheck);
  });

  it("never calls the dialogue read RPC without checking eligibility first", () => {
    const source = indexSource();
    const eligibilityIndex = source.indexOf("resolveMemoryV3DialogueEligibility");
    const dialogueLoadIndex = source.indexOf("load_memory_v3_dialogue_viewer_items");
    assert.ok(eligibilityIndex >= 0 && eligibilityIndex < dialogueLoadIndex);
  });

  it("never calls a dialogue delete without requiring a conversationId", () => {
    const source = indexSource();
    const dialogueScopeIndex = source.indexOf('body.scope === "dialogue"');
    const conversationCheckIndex = source.indexOf("conversationId", dialogueScopeIndex);
    const deleteCallIndex = source.indexOf("delete_memory_v3_dialogue_item");
    assert.ok(dialogueScopeIndex >= 0 && conversationCheckIndex > dialogueScopeIndex && conversationCheckIndex < deleteCallIndex);
  });

  it("filters out hypotheses on both read branches via projectMemoryV3ViewerItems", () => {
    const source = indexSource();
    assert.equal((source.match(/projectMemoryV3ViewerItems\(/g) ?? []).length, 2);
  });

  it("uses projectMemoryV3ExportItems (not the viewer projection) on both export branches", () => {
    const source = indexSource();
    assert.equal((source.match(/projectMemoryV3ExportItems\(/g) ?? []).length, 2);
  });

  it("never calls the all-conversations dialogue RPC without checking eligibility first", () => {
    const source = indexSource();
    const exportIndex = source.indexOf('body.action === "export"');
    const eligibilityIndex = source.indexOf("resolveMemoryV3DialogueEligibility", exportIndex);
    const dialogueAllIndex = source.indexOf("load_memory_v3_dialogue_viewer_items_all", exportIndex);
    assert.ok(exportIndex >= 0 && eligibilityIndex > exportIndex && eligibilityIndex < dialogueAllIndex);
  });

  it("export calls the all-conversations dialogue RPC, never the per-conversation one", () => {
    const source = indexSource();
    const exportIndex = source.indexOf('body.action === "export"');
    const readIndex = source.indexOf('action === "read" (default)');
    const exportBody = source.slice(exportIndex, readIndex);
    assert.doesNotMatch(exportBody, /"load_memory_v3_dialogue_viewer_items"/);
    assert.match(exportBody, /"load_memory_v3_dialogue_viewer_items_all"/);
  });

  it("fails loudly on an export RPC error instead of silently returning partial data", () => {
    const source = indexSource();
    const exportIndex = source.indexOf('body.action === "export"');
    const readIndex = source.indexOf('action === "read" (default)');
    const exportBody = source.slice(exportIndex, readIndex);
    assert.equal((exportBody.match(/error: "internal"/g) ?? []).length, 2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts`
Expected: FAIL — the `p_user_id: userId` count is still 5 (not 7 yet), and the four new `"export"`-specific tests find no `"export"` action in the source.

- [ ] **Step 3: Implement**

In `supabase/functions/memory-v3-viewer/index.ts`, change the import block (lines 6-9) from:

```ts
import {
  projectMemoryV3ViewerItems,
  type MemoryV3ViewerSourceItem,
} from "../_shared/memoryV3/viewerProjection.ts";
```

to:

```ts
import {
  projectMemoryV3ViewerItems,
  projectMemoryV3ExportItems,
  type MemoryV3ViewerSourceItem,
} from "../_shared/memoryV3/viewerProjection.ts";
```

Then insert a new `"export"` action block right after the `"delete_all"` block and before the `// action === "read" (default)` comment (i.e. right before the current line `const conversationId = body.conversationId?.trim();`):

```ts
    if (body.action === "export") {
      const { data: lifecycleRaw, error: lifecycleError } = await svc.rpc(
        "load_memory_v3_lifecycle_viewer_items",
        { p_user_id: userId },
      );
      if (lifecycleError) {
        console.error("[memory-v3-viewer] export load_lifecycle_viewer_items:", lifecycleError.message);
        return new Response(JSON.stringify({ error: "internal" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const accountWide = projectMemoryV3ExportItems(
        (Array.isArray(lifecycleRaw) ? lifecycleRaw : []) as MemoryV3ViewerSourceItem[],
      );

      let dialogue: ReturnType<typeof projectMemoryV3ExportItems> = [];
      const eligibility = resolveMemoryV3DialogueEligibility({
        rawMode: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_MODE"),
        rawAllowedUserId: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID"),
        userId,
      });
      if (eligibility.eligible) {
        const { data: dialogueRaw, error: dialogueError } = await svc.rpc(
          "load_memory_v3_dialogue_viewer_items_all",
          { p_user_id: userId },
        );
        if (dialogueError) {
          console.error("[memory-v3-viewer] export load_dialogue_viewer_items_all:", dialogueError.message);
          return new Response(JSON.stringify({ error: "internal" }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        dialogue = projectMemoryV3ExportItems(
          (Array.isArray(dialogueRaw) ? dialogueRaw : []) as MemoryV3ViewerSourceItem[],
        );
      }

      return new Response(JSON.stringify({ accountWide, dialogue }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // action === "read" (default)
```

Note: unlike the existing `"read"` action (which logs an RPC error and silently continues with an empty array), `"export"` returns an error response immediately on either RPC failure. This is deliberate — see Global Constraints and Review Focus above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts`
Expected: PASS (10 tests).

Also run the full shared directory to confirm nothing else broke:
Run: `deno test --allow-read --allow-env --no-config supabase/functions/_shared/memoryV3/`
Expected: PASS except the two pre-existing, unrelated `lifecycleTransport.cases.test.ts` / `dialogueTransport.cases.test.ts` timer-mocking failures (see Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/memory-v3-viewer/index.ts supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts
git commit -m "feat: add export action to memory-v3-viewer edge function

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend data layer — `exportMemoryV3Data()` and JSON download

**Files:**
- Modify: `src/lib/memoryV3Viewer.ts`

**Interfaces:**
- Consumes: the existing `callMemoryV3Viewer<T>` helper already in this file.
- Produces: `export interface MemoryV3ExportItem { memoryKey: string; kind: 'event' | 'recurrence' | 'hypothesis'; claim: string; eventTimeStart: string | null; eventTimeEnd: string | null; sensitivity: 'normal' | 'sensitive'; topic: string | null; firstSeenAt: string; updatedAt: string; alternative: string | null; }`, `export async function exportMemoryV3Data(): Promise<{ accountWide: MemoryV3ExportItem[]; dialogue: MemoryV3ExportItem[]; error: string | null }>`, `export function downloadMemoryV3ExportAsJson(data: { accountWide: MemoryV3ExportItem[]; dialogue: MemoryV3ExportItem[] }): void`. Task 5 and Task 6 both import `MemoryV3ExportItem`; Task 6 calls both exported functions.

- [ ] **Step 1: No automated test (documented constraint)**

This project has no frontend unit-test runner (confirmed: no `vitest`/`jest`/`@testing-library` in `package.json`, and the existing sibling functions `fetchMemoryV3Items`/`deleteMemoryV3Item`/`deleteAllMemoryV3Data` in this same file have no dedicated tests either). Verification for this task is `npm run typecheck` (Step 3) plus Task 6's manual click-through, which exercises this code for real.

- [ ] **Step 2: Implement**

Append to the end of `src/lib/memoryV3Viewer.ts` (after the existing `deleteAllMemoryV3Data` function):

```ts
export interface MemoryV3ExportItem {
  memoryKey: string;
  kind: 'event' | 'recurrence' | 'hypothesis';
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: 'normal' | 'sensitive';
  topic: string | null;
  firstSeenAt: string;
  updatedAt: string;
  alternative: string | null;
}

/** Выгрузка "всё, что ИИ обо мне помнит" -- и подтверждённые факты, и
 * гипотезы (с их альтернативой), по всем беседам сразу, в отличие от
 * fetchMemoryV3Items, который гипотезы никогда не показывает. */
export async function exportMemoryV3Data(): Promise<{
  accountWide: MemoryV3ExportItem[];
  dialogue: MemoryV3ExportItem[];
  error: string | null;
}> {
  const result = await callMemoryV3Viewer<{ accountWide: MemoryV3ExportItem[]; dialogue: MemoryV3ExportItem[] }>({
    action: 'export',
  });
  if ('error' in result) return { accountWide: [], dialogue: [], error: result.error };
  return { ...result, error: null };
}

export function downloadMemoryV3ExportAsJson(
  data: { accountWide: MemoryV3ExportItem[]; dialogue: MemoryV3ExportItem[] },
): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `staysee-memory-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 3: Run typecheck to verify it passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/memoryV3Viewer.ts
git commit -m "feat: add exportMemoryV3Data and JSON download helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: PDF generation

**Files:**
- Modify: `package.json` (add `jspdf` dependency)
- Modify: `src/components/MemoryV3ItemList.tsx` (export the two existing formatting helpers)
- Create: `src/lib/memoryV3ExportPdf.ts`

**Interfaces:**
- Consumes: `MemoryV3ExportItem` from Task 4; `formatMemoryAge`/`formatMemoryRecordedOrUpdated` (newly exported from `MemoryV3ItemList.tsx`, previously module-private).
- Produces: `export function downloadMemoryV3ExportAsPdf(data: { accountWide: MemoryV3ExportItem[]; dialogue: MemoryV3ExportItem[] }): void`. Task 6 calls this.

- [ ] **Step 1: Install the dependency**

```bash
npm install jspdf
```

Confirm it landed in `package.json`'s `"dependencies"` (not `devDependencies` — it runs in the browser, not just at build time).

- [ ] **Step 2: Export the two formatting helpers**

In `src/components/MemoryV3ItemList.tsx`, change:

```ts
function formatMemoryAge(isoDate: string): string | null {
```

to:

```ts
export function formatMemoryAge(isoDate: string): string | null {
```

and change:

```ts
function formatMemoryRecordedOrUpdated(item: { firstSeenAt: string; updatedAt: string }): string | null {
```

to:

```ts
export function formatMemoryRecordedOrUpdated(item: { firstSeenAt: string; updatedAt: string }): string | null {
```

No other change to this file — both functions keep their exact existing bodies and behavior, used by both the existing `MemoryV3ItemList` component and the new PDF layout.

- [ ] **Step 3: No automated test (documented constraint)**

Same as Task 4: no frontend unit-test runner exists in this project. Verification is `npm run typecheck` (Step 5) plus Task 6's manual click-through, where the generated PDF is actually opened and read.

- [ ] **Step 4: Implement the PDF layout**

Create `src/lib/memoryV3ExportPdf.ts`:

```ts
import { jsPDF } from 'jspdf';
import { formatMemoryRecordedOrUpdated } from '../components/MemoryV3ItemList';
import type { MemoryV3ExportItem } from './memoryV3Viewer';

const PAGE_MARGIN = 15;
const LINE_HEIGHT = 6;
const PAGE_BREAK_Y = 280;
const WRAP_WIDTH = 180;

function topicLabel(topic: string | null): string {
  return topic ?? 'Без темы';
}

function addLine(doc: jsPDF, cursor: { y: number }, text: string, x: number, muted = false): void {
  if (cursor.y > PAGE_BREAK_Y) {
    doc.addPage();
    cursor.y = PAGE_MARGIN;
  }
  if (muted) doc.setTextColor(120);
  doc.text(text, x, cursor.y);
  if (muted) doc.setTextColor(0);
  cursor.y += LINE_HEIGHT;
}

function writeSection(doc: jsPDF, cursor: { y: number }, title: string, items: MemoryV3ExportItem[]): void {
  doc.setFontSize(14);
  addLine(doc, cursor, title, PAGE_MARGIN);
  cursor.y += LINE_HEIGHT * 0.5;
  doc.setFontSize(10);

  if (items.length === 0) {
    addLine(doc, cursor, 'Пусто.', PAGE_MARGIN, true);
    cursor.y += LINE_HEIGHT;
    return;
  }

  for (const item of items) {
    const claimText = `• ${item.claim}${item.kind === 'hypothesis' ? ' (гипотеза)' : ''}`;
    for (const line of doc.splitTextToSize(claimText, WRAP_WIDTH) as string[]) {
      addLine(doc, cursor, line, PAGE_MARGIN);
    }

    const timing = formatMemoryRecordedOrUpdated(item);
    const metaParts = [topicLabel(item.topic), timing].filter((part): part is string => Boolean(part));
    if (metaParts.length > 0) {
      addLine(doc, cursor, metaParts.join(' · '), PAGE_MARGIN + 4, true);
    }

    if (item.alternative) {
      for (const line of doc.splitTextToSize(`Альтернатива: ${item.alternative}`, WRAP_WIDTH - 4) as string[]) {
        addLine(doc, cursor, line, PAGE_MARGIN + 4, true);
      }
    }

    cursor.y += LINE_HEIGHT * 0.5;
  }
}

/** Та же выгрузка, что downloadMemoryV3ExportAsJson, но версткой на бумагу --
 * разделы "Сквозная память" / "Память бесед", автоперенос длинного текста
 * (splitTextToSize) и новая страница при переполнении, чтобы ни один пункт
 * не обрезался и не падал при длинной формулировке. */
export function downloadMemoryV3ExportAsPdf(
  data: { accountWide: MemoryV3ExportItem[]; dialogue: MemoryV3ExportItem[] },
): void {
  const doc = new jsPDF();
  const cursor = { y: PAGE_MARGIN };
  doc.setFontSize(16);
  addLine(doc, cursor, 'StaySee — моя память', PAGE_MARGIN);
  cursor.y += LINE_HEIGHT;

  writeSection(doc, cursor, 'Сквозная память', data.accountWide);
  writeSection(doc, cursor, 'Память бесед', data.dialogue);

  doc.save(`staysee-memory-export-${new Date().toISOString().slice(0, 10)}.pdf`);
}
```

- [ ] **Step 5: Run typecheck and lint to verify they pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/components/MemoryV3ItemList.tsx src/lib/memoryV3ExportPdf.ts
git commit -m "feat: add client-side PDF export layout using jspdf

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: UI wiring — export button on the Память screen

**Files:**
- Modify: `src/components/screens/MemoryScreen.tsx`

**Interfaces:**
- Consumes: `exportMemoryV3Data`, `downloadMemoryV3ExportAsJson` from `../../lib/memoryV3Viewer` (Task 4); `downloadMemoryV3ExportAsPdf` from `../../lib/memoryV3ExportPdf` (Task 5).
- Produces: nothing consumed by a later task — this is the final task.

- [ ] **Step 1: No automated test (documented constraint); manual click-through is the real check here**

Same constraint as Tasks 4-5. This step's actual verification happens in Step 4 below (manual click-through), which is also where Review Focus items "hypothesis with alternative appears" and "sensitive item appears unmasked" get checked end-to-end — there is no automated test harness in this project that can render the live screen.

- [ ] **Step 2: Implement**

In `src/components/screens/MemoryScreen.tsx`, change the icon import (line 2) from:

```ts
import { Brain, ChevronDown, History, Pencil, Plus, Sparkles, Trash2, X, Check } from 'lucide-react';
```

to:

```ts
import { Brain, ChevronDown, Download, History, Pencil, Plus, Sparkles, Trash2, X, Check } from 'lucide-react';
```

Change the `memoryV3Viewer` import (line 50) from:

```ts
import { deleteMemoryV3Item, fetchMemoryV3Items, type MemoryV3ViewerItem } from '../../lib/memoryV3Viewer';
```

to:

```ts
import {
  deleteMemoryV3Item,
  downloadMemoryV3ExportAsJson,
  exportMemoryV3Data,
  fetchMemoryV3Items,
  type MemoryV3ViewerItem,
} from '../../lib/memoryV3Viewer';
import { downloadMemoryV3ExportAsPdf } from '../../lib/memoryV3ExportPdf';
```

Inside `MemoryScreen()`, add new state alongside the other `useState` declarations (right after the existing `const [sectionOpen, setSectionOpen] = useState(initialSectionOpenState);` line):

```ts
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
```

Add a new handler function near the other handler functions (e.g. right after `clearConversationMemory`):

```ts
  async function handleExport(format: 'json' | 'pdf') {
    setExportBusy(true);
    setExportError(null);
    try {
      const result = await exportMemoryV3Data();
      if (result.error) {
        setExportError('Не удалось сохранить. Нажмите ещё раз.');
        return;
      }
      if (format === 'json') {
        downloadMemoryV3ExportAsJson(result);
      } else {
        downloadMemoryV3ExportAsPdf(result);
      }
      setExportChoiceOpen(false);
    } catch {
      setExportError('Не удалось сохранить. Нажмите ещё раз.');
    } finally {
      setExportBusy(false);
    }
  }
```

Finally, add the button block as the first thing inside the `!loading` fragment, right after the `<>` that opens it and before `<section className="mb-8">` (i.e. right after line `) : (` and the opening `<>` of the ternary's else-branch, before the existing `<section className="mb-8">` for "Память этой беседы"):

```tsx
            <div className={`${cardBase} px-4 py-3.5 mb-4`}>
              {!exportChoiceOpen ? (
                <button
                  type="button"
                  onClick={() => setExportChoiceOpen(true)}
                  className={`inline-flex items-center gap-1.5 text-sm font-light ${theme.textSecondary}`}
                >
                  <Download className="w-4 h-4" strokeWidth={1.5} />
                  Скачать мои данные
                </button>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className={`${theme.textMuted} text-xs font-light`}>
                    Выгрузка памяти по всем беседам — выберите формат:
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={exportBusy}
                      onClick={() => void handleExport('pdf')}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.surfaceHover} ${theme.textSecondary} disabled:opacity-50`}
                    >
                      PDF
                    </button>
                    <button
                      type="button"
                      disabled={exportBusy}
                      onClick={() => void handleExport('json')}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.surfaceHover} ${theme.textSecondary} disabled:opacity-50`}
                    >
                      JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => { setExportChoiceOpen(false); setExportError(null); }}
                      className={`px-3 py-1.5 rounded-lg text-xs ${theme.textMuted}`}
                    >
                      Отмена
                    </button>
                  </div>
                  {exportError && (
                    <p className="text-red-400/80 text-xs font-light">{exportError}</p>
                  )}
                </div>
              )}
            </div>

            <section className="mb-8">
```

(This replaces the bare `<section className="mb-8">` line that currently follows `) : (` with the new `<div>` block above it, followed by the same `<section className="mb-8">` line, unchanged.)

- [ ] **Step 3: Run typecheck and lint to verify they pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual click-through (the real test for this task and the whole feature)**

Run `npm run dev`, open the app, sign in with a test account that has memory in more than one conversation (ideally including at least one hypothesis), navigate to Память, and:
1. Confirm the "Скачать мои данные" button appears above the conversation selector.
2. Click it — confirm the PDF/JSON choice appears inline, no modal.
3. Click JSON — confirm a `.json` file downloads; open it and confirm it contains `accountWide` and `dialogue` arrays, that a known hypothesis item appears with its `alternative` field populated, and that a known sensitive item's `claim` is the real text (not masked).
4. Repeat the button flow and click PDF — confirm a `.pdf` file downloads; open it and confirm both sections render, long claims wrap instead of overflowing, and the hypothesis's alternative text appears.
5. Test the empty case with an account that has no memory yet — confirm both formats still download successfully and show "Пусто." instead of erroring.

- [ ] **Step 5: Commit**

```bash
git add src/components/screens/MemoryScreen.tsx
git commit -m "feat: add data export button to the Память screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After all tasks: finish the branch

Push the already-committed spec (`0fa092b`, currently local-only on `main`) together with this plan's commits on a new feature branch, then open a PR — do not merge it. Use superpowers:finishing-a-development-branch for the mechanics (push, create PR), and write the PR description in plain Russian, matching PRs #92-98's style. The PR is the stopping point: merge, `supabase db push`, `supabase functions deploy`, and confirming the automatic GitHub Actions frontend deploy all remain separate post-merge steps, per this project's established pattern.
