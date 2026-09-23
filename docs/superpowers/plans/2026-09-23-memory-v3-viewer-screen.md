# Memory V3 Viewer Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Memory V3 visible and deletable from the account's existing memory screen: a new third section for existing accounts, and a swap of what the existing two sections show for new accounts (per the approved design).

**Architecture:** One new edge function (`memory-v3-viewer`) exposes a curated (no-hypothesis) read of both Memory V3 scopes and a delete mutation, both gated by verified-JWT ownership exactly like `weekly-reflection`. Two new SECURITY DEFINER RPCs back the delete. The frontend gets one new reusable list component and a client helper calling the edge function, wired into `MemoryScreen.tsx` behind an account-creation-date cohort check.

**Tech Stack:** Deno Edge Functions (TypeScript), Postgres/Supabase (SQL migration, SECURITY DEFINER RPCs), React/TypeScript frontend, Node's built-in test runner via `npx tsx --test`.

## Global Constraints

- Every new/changed `*.ts` edge-function file must type-check with `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config <file>` at the same error count as a clean `main` baseline — zero new errors.
- Every new `*.cases.test.ts` file runs via `npx tsx --test <file>`, fakes only, no live network/database.
- Never show a `kind: "hypothesis"` item to the user, anywhere in this feature — filtered server-side, not just hidden client-side.
- Never expose `updatedAt`, internal `status`/`revision` bookkeeping, or evidence rows to the client — the projected shape is `{ memoryKey, kind, claim, eventTimeStart, eventTimeEnd, sensitivity }` only.
- Delete is a direct row delete (relies on the already-existing `ON DELETE CASCADE` from items to evidence) — no `trustedForgetMemoryKeys` wiring, no guarantee against recurrence, matching the approved design's Non-goals.
- Do not add a free-text "add a new memory item" control anywhere in this feature (approved Non-goal).
- Do not touch `conversation_summary`/`user_memory` read/write behavior, the existing "Память беседы"/"Сквозная память" logic for existing accounts, or any Memory V3 write path (extractor/reducer/reconciler).
- This plan's last task stops at "PR opened" — no merge, no deploy, matching every prior task today.

---

### Task 1: Two delete RPCs for Memory V3 items

**Files:**
- Create: `supabase/migrations/20260923120000_042_memory_v3_viewer_delete.sql`
- Create: `supabase/functions/_shared/memoryV3/viewerDeleteMigration.cases.test.ts`

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces: `delete_memory_v3_lifecycle_item(p_user_id uuid, p_memory_key text) RETURNS boolean` and `delete_memory_v3_dialogue_item(p_user_id uuid, p_conversation_id uuid, p_memory_key text) RETURNS boolean`, both `SECURITY DEFINER`, `service_role`-only. Task 3 (the edge function's delete action) calls both by name.

Both tables' evidence rows already cascade-delete from their item row (`ON DELETE CASCADE`, verified in `034_memory_v3_lifecycle_shadow.sql` and `039_memory_v3_dialogue_isolation.sql` today) — deleting the item row is sufficient, no separate evidence delete needed.

- [ ] **Step 1: Write the failing structural test**

```typescript
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const MIGRATION_URL = new URL(
  "../../../migrations/20260923120000_042_memory_v3_viewer_delete.sql",
  import.meta.url,
);

function migrationSql(): string {
  assert.equal(existsSync(MIGRATION_URL), true, "migration 042 must exist");
  return readFileSync(MIGRATION_URL, "utf8");
}

function functionBlock(sql: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?\\$function\\$;`,
    "iu",
  ));
  assert.ok(match, `${name} function block must be extractable`);
  return match[0];
}

describe("Memory V3 viewer delete migration", () => {
  it("deletes a lifecycle item scoped strictly to its owning user", () => {
    const body = functionBlock(migrationSql(), "delete_memory_v3_lifecycle_item");
    assert.match(body, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_lifecycle_shadow_items/iu);
    assert.match(body, /WHERE user_id = p_user_id AND memory_key = p_memory_key/iu);
    assert.doesNotMatch(body, /memory_v3_lifecycle_shadow_evidence/iu);
  });

  it("deletes a dialogue item scoped strictly to its owning user and conversation", () => {
    const body = functionBlock(migrationSql(), "delete_memory_v3_dialogue_item");
    assert.match(body, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/iu);
    assert.match(body, /DELETE FROM public\.memory_v3_dialogue_items/iu);
    assert.match(
      body,
      /WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND memory_key = p_memory_key/iu,
    );
    assert.doesNotMatch(body, /memory_v3_dialogue_evidence/iu);
  });

  it("grants execute only to service_role for both functions", () => {
    const sql = migrationSql();
    for (const [name, args] of [
      ["delete_memory_v3_lifecycle_item", "uuid, text"],
      ["delete_memory_v3_dialogue_item", "uuid, uuid, text"],
    ] as const) {
      assert.match(
        sql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(${args}\\) FROM PUBLIC, anon, authenticated;`, "iu"),
      );
      assert.match(
        sql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${args}\\) TO service_role;`, "iu"),
      );
    }
  });

  it("adds no new table, no policy, and changes no other function", () => {
    const sql = migrationSql();
    assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE POLICY/iu);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/viewerDeleteMigration.cases.test.ts`
Expected: FAIL — migration file does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- Backs the new Memory V3 viewer screen's delete action. Direct row
-- delete only -- evidence cascades automatically (ON DELETE CASCADE,
-- already in place since migrations 034/039). No trustedForgetMemoryKeys
-- wiring: a deleted item could be independently re-derived by a future
-- extractor/reconciler run noticing the same thing again -- an accepted,
-- honest limitation of this first version, not solved here.

CREATE OR REPLACE FUNCTION public.delete_memory_v3_lifecycle_item(
  p_user_id uuid, p_memory_key text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_deleted boolean;
BEGIN
  DELETE FROM public.memory_v3_lifecycle_shadow_items
  WHERE user_id = p_user_id AND memory_key = p_memory_key
  RETURNING true INTO v_deleted;
  RETURN COALESCE(v_deleted, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_memory_v3_dialogue_item(
  p_user_id uuid, p_conversation_id uuid, p_memory_key text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_deleted boolean;
BEGIN
  DELETE FROM public.memory_v3_dialogue_items
  WHERE user_id = p_user_id AND conversation_id = p_conversation_id AND memory_key = p_memory_key
  RETURNING true INTO v_deleted;
  RETURN COALESCE(v_deleted, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_memory_v3_lifecycle_item(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_memory_v3_lifecycle_item(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.delete_memory_v3_dialogue_item(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_memory_v3_dialogue_item(uuid, uuid, text) TO service_role;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/viewerDeleteMigration.cases.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260923120000_042_memory_v3_viewer_delete.sql supabase/functions/_shared/memoryV3/viewerDeleteMigration.cases.test.ts
git commit -m "feat: add ownership-scoped delete RPCs for Memory V3 items"
```

---

### Task 2: `memory-v3-viewer` edge function — read action

**Files:**
- Create: `supabase/functions/memory-v3-viewer/index.ts`
- Create: `supabase/functions/_shared/memoryV3/viewerProjection.ts`
- Create: `supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`

**Interfaces:**
- Consumes: `_shared/authUser.ts`'s `resolveVerifiedChatUser` (unchanged, shared with `weekly-reflection`/`staysee-chat`); `_shared/cost.ts`'s `makeServiceClient` (unchanged, shared); `_shared/memoryV3/lifecycleReadStore.ts`'s `createMemoryV3LifecycleReadStore` (unchanged); `_shared/memoryV3/dialogueReadStore.ts`'s `createMemoryV3DialogueReadStore` (unchanged); `_shared/memoryV3/dialogueMode.ts`'s `resolveMemoryV3DialogueEligibility` (unchanged).
- Produces: `projectMemoryV3ViewerItems(items: Array<{kind, claim, status, sensitivity, eventTimeStart, eventTimeEnd, alternative, updatedAt, memoryKey?}>): Array<{memoryKey, kind, claim, eventTimeStart, eventTimeEnd, sensitivity}>` from the new `viewerProjection.ts` (a pure function, kept separate from the edge function so it is unit-testable under plain Node -- the edge function itself, like every other edge function in this codebase, cannot be). Note: `MemoryV3LifecycleReadContext`/`MemoryV3DialogueReadContext`'s item type does not currently include `memoryKey` in its projected shape (verify this by reading `lifecycleReadStore.ts`'s exact `MemoryV3LifecycleReadContext["items"]` type before writing this function) -- if `memoryKey` is not present on the read-store's output today, this task must also add it there (a one-field, backward-compatible addition to both read stores' projection, since deleting an item requires knowing its key and nothing currently returns it to a caller of `.load()`).

- [ ] **Step 1: Check whether the read stores already return `memoryKey`**

Run:
```bash
grep -n "memoryKey" supabase/functions/_shared/memoryV3/lifecycleReadStore.ts supabase/functions/_shared/memoryV3/dialogueReadStore.ts
```
If neither file's `items` projection includes `memoryKey` (expected, since today's only consumer is the AI prompt formatter, which must never see raw keys), add it: in both `projectMemoryV3LifecycleReadContext`/`projectMemoryV3DialogueReadContext` (read the exact current field lists first), add `memoryKey` to the projected item's allowed/output fields, sourced from the same `memory_key` column already selected by the underlying RPC. This is additive (new field on an existing type) -- confirm no existing caller destructures the item object in a way that would break (e.g. exact-key-count validation elsewhere) by re-running that file's existing test suite after the change.

- [ ] **Step 2: Write the failing test for the projection function**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectMemoryV3ViewerItems } from "./viewerProjection.ts";

describe("Memory V3 viewer projection", () => {
  it("keeps only event and recurrence kinds, dropping hypotheses", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, alternative: null, updatedAt: "2026-01-01T00:00:00Z" },
      { memoryKey: "b", kind: "hypothesis", claim: "Y", status: "supported", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, alternative: "Alt", updatedAt: "2026-01-01T00:00:00Z" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", status: "active", sensitivity: "sensitive", eventTimeStart: null, eventTimeEnd: null, alternative: null, updatedAt: "2026-01-01T00:00:00Z" },
    ] as never);
    assert.deepEqual(result, [
      { memoryKey: "a", kind: "event", claim: "X", eventTimeStart: null, eventTimeEnd: null, sensitivity: "normal" },
      { memoryKey: "c", kind: "recurrence", claim: "Z", eventTimeStart: null, eventTimeEnd: null, sensitivity: "sensitive" },
    ]);
  });

  it("never includes updatedAt, status, revision, or alternative in the output", () => {
    const result = projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "event", claim: "X", status: "active", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, alternative: null, updatedAt: "2026-01-01T00:00:00Z" },
    ] as never);
    for (const forbidden of ["updatedAt", "status", "revision", "alternative"]) {
      assert.equal(Object.hasOwn(result[0], forbidden), false, forbidden);
    }
  });

  it("returns an empty array for an empty or all-hypothesis input", () => {
    assert.deepEqual(projectMemoryV3ViewerItems([]), []);
    assert.deepEqual(projectMemoryV3ViewerItems([
      { memoryKey: "a", kind: "hypothesis", claim: "X", status: "supported", sensitivity: "normal", eventTimeStart: null, eventTimeEnd: null, alternative: "Alt", updatedAt: "2026-01-01T00:00:00Z" },
    ] as never), []);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 4: Write `viewerProjection.ts`**

```typescript
export interface MemoryV3ViewerSourceItem {
  memoryKey: string;
  kind: "event" | "recurrence" | "hypothesis";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
}

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: "event" | "recurrence";
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: "normal" | "sensitive";
}

/** Curates raw Memory V3 items for the user-facing viewer: confirmed
 * facts and patterns only, never a hypothesis, never internal bookkeeping
 * fields (status/revision/updatedAt/alternative). */
export function projectMemoryV3ViewerItems(
  items: MemoryV3ViewerSourceItem[],
): MemoryV3ViewerItem[] {
  return items
    .filter((item): item is MemoryV3ViewerSourceItem & { kind: "event" | "recurrence" } =>
      item.kind === "event" || item.kind === "recurrence")
    .map((item) => ({
      memoryKey: item.memoryKey,
      kind: item.kind,
      claim: item.claim,
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      sensitivity: item.sensitivity,
    }));
}
```

(Adjust the input type's field list to match exactly whatever `MemoryV3LifecycleReadContext["items"][number]`/`MemoryV3DialogueReadContext["items"][number]` actually is after Step 1's `memoryKey` addition — read the real type before finalizing this file, do not guess it a second time.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 6: Write `memory-v3-viewer/index.ts`'s read action**

Mirror `weekly-reflection/index.ts`'s full structure (imports, CORS headers, `Deno.serve`, JWT verification via `resolveVerifiedChatUser`) exactly. Request body: `{ action: "read"; conversationId?: string }`. Response: `{ accountWide: MemoryV3ViewerItem[]; dialogue: MemoryV3ViewerItem[] }`.

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveVerifiedChatUser } from "../_shared/authUser.ts";
import { makeServiceClient } from "../_shared/cost.ts";
import { createMemoryV3LifecycleReadStore } from "../_shared/memoryV3/lifecycleReadStore.ts";
import { createMemoryV3DialogueReadStore } from "../_shared/memoryV3/dialogueReadStore.ts";
import { resolveMemoryV3DialogueEligibility } from "../_shared/memoryV3/dialogueMode.ts";
import { projectMemoryV3ViewerItems } from "../_shared/memoryV3/viewerProjection.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json() as {
      action?: string; conversationId?: string; userId?: string;
      memoryKey?: string; scope?: string;
    };
    const authorizationHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const verifiedUser = await resolveVerifiedChatUser({
      authorizationHeader,
      requestedUserId: body.userId?.trim(),
      getUser: async (token) => {
        const authClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const { data, error } = await authClient.auth.getUser(token);
        return { user: data.user, error };
      },
    });
    if (!verifiedUser.ok) {
      return new Response(JSON.stringify({ error: verifiedUser.reason }), {
        status: verifiedUser.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = verifiedUser.userId;
    const svc = makeServiceClient();

    if (body.action === "delete") {
      // Implemented in Task 3.
      return new Response(JSON.stringify({ error: "not_implemented" }), {
        status: 501, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // action === "read" (default)
    const conversationId = body.conversationId?.trim();
    const lifecycleLoaded = await createMemoryV3LifecycleReadStore(svc).load(userId);
    const accountWide = lifecycleLoaded !== null
      ? projectMemoryV3ViewerItems(lifecycleLoaded.items as never)
      : [];

    let dialogue: ReturnType<typeof projectMemoryV3ViewerItems> = [];
    if (conversationId) {
      const eligibility = resolveMemoryV3DialogueEligibility({
        rawMode: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_MODE"),
        rawAllowedUserId: Deno.env.get("STAYSEE_MEMORY_V3_DIALOGUE_ALLOWED_USER_ID"),
        userId,
      });
      if (eligibility.eligible) {
        const dialogueLoaded = await createMemoryV3DialogueReadStore(svc).load(userId, conversationId);
        if (dialogueLoaded !== null) dialogue = projectMemoryV3ViewerItems(dialogueLoaded.items as never);
      }
    }

    return new Response(JSON.stringify({ accountWide, dialogue }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[memory-v3-viewer]", e);
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

- [ ] **Step 7: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/memory-v3-viewer/index.ts`
Expected: no new errors versus a clean baseline for this brand-new file (compare against the known pre-existing error patterns from importing the `lifecycleReadStore.ts`/`dialogueReadStore.ts`/`dialogueMode.ts` trees, already characterized earlier today -- if new, unfamiliar errors appear, they are real and must be fixed, not assumed baseline).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/memory-v3-viewer/index.ts supabase/functions/_shared/memoryV3/viewerProjection.ts supabase/functions/_shared/memoryV3/viewerProjection.cases.test.ts
git commit -m "feat: add memory-v3-viewer edge function's read action"
```

---

### Task 3: `memory-v3-viewer` edge function — delete action

**Files:**
- Modify: `supabase/functions/memory-v3-viewer/index.ts`

**Interfaces:**
- Consumes: Task 1's `delete_memory_v3_lifecycle_item`/`delete_memory_v3_dialogue_item` RPCs.
- Produces: `{ action: "delete"; scope: "account_wide" | "dialogue"; memoryKey: string; conversationId?: string }` request handling, responding `{ deleted: boolean }`.

- [ ] **Step 1: Replace the `not_implemented` delete stub**

```typescript
    if (body.action === "delete") {
      const memoryKey = body.memoryKey?.trim();
      if (!memoryKey || (body.scope !== "account_wide" && body.scope !== "dialogue")) {
        return new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (body.scope === "dialogue") {
        const conversationId = body.conversationId?.trim();
        if (!conversationId) {
          return new Response(JSON.stringify({ error: "invalid_request" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { data, error } = await svc.rpc("delete_memory_v3_dialogue_item", {
          p_user_id: userId, p_conversation_id: conversationId, p_memory_key: memoryKey,
        });
        if (error) {
          console.error("[memory-v3-viewer] delete_dialogue_item:", error.message);
          return new Response(JSON.stringify({ error: "internal" }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ deleted: Boolean(data) }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await svc.rpc("delete_memory_v3_lifecycle_item", {
        p_user_id: userId, p_memory_key: memoryKey,
      });
      if (error) {
        console.error("[memory-v3-viewer] delete_lifecycle_item:", error.message);
        return new Response(JSON.stringify({ error: "internal" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ deleted: Boolean(data) }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
```

- [ ] **Step 2: Type-check**

Run: `"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/memory-v3-viewer/index.ts`

- [ ] **Step 3: Write a structural wiring test**

Create `supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts` mirroring the source-grep style used for `stayseeChatWiring.cases.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX_URL = new URL("../../memory-v3-viewer/index.ts", import.meta.url);

describe("memory-v3-viewer wiring", () => {
  it("verifies the caller's JWT before doing anything else", () => {
    const source = readFileSync(INDEX_URL, "utf8");
    assert.match(source, /resolveVerifiedChatUser/);
    const verifyIndex = source.indexOf("resolveVerifiedChatUser");
    const rpcIndex = source.indexOf(".rpc(");
    assert.ok(verifyIndex < rpcIndex, "must verify identity before any RPC call");
  });

  it("scopes both delete RPC calls to the verified caller's own userId, never a client-supplied one", () => {
    const source = readFileSync(INDEX_URL, "utf8");
    assert.match(source, /p_user_id:\s*userId/g);
    assert.equal((source.match(/p_user_id:\s*userId/g) ?? []).length, 2);
  });

  it("never calls the dialogue read store without checking eligibility first", () => {
    const source = readFileSync(INDEX_URL, "utf8");
    const eligibilityIndex = source.indexOf("resolveMemoryV3DialogueEligibility");
    const dialogueLoadIndex = source.indexOf("createMemoryV3DialogueReadStore");
    assert.ok(eligibilityIndex >= 0 && eligibilityIndex < dialogueLoadIndex);
  });
});
```

- [ ] **Step 4: Run the wiring test**

Run: `npx tsx --test supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/memory-v3-viewer/index.ts supabase/functions/_shared/memoryV3/viewerWiring.cases.test.ts
git commit -m "feat: add memory-v3-viewer edge function's delete action"
```

---

### Task 4: Frontend client helper and reusable list component

**Files:**
- Create: `src/lib/memoryV3Viewer.ts`
- Create: `src/components/MemoryV3ItemList.tsx`

**Interfaces:**
- Consumes: `src/lib/supabase.ts`'s `supabase` client (unchanged); `src/lib/supabaseEnv.ts`'s `resolveSupabasePublicConfig` (unchanged); `ConfirmDeleteButton` (unchanged, already imported in `MemoryScreen.tsx`).
- Produces: `fetchMemoryV3Items(conversationId?: string): Promise<{ accountWide: MemoryV3ViewerItem[]; dialogue: MemoryV3ViewerItem[]; error: string | null }>`, `deleteMemoryV3Item(input: { scope: "account_wide" | "dialogue"; memoryKey: string; conversationId?: string }): Promise<{ deleted: boolean; error: string | null }>`, and the `<MemoryV3ItemList items theme cardBase onDelete />` component. Task 5 imports both.

- [ ] **Step 1: Write `src/lib/memoryV3Viewer.ts`**

Mirror `src/lib/weeklyReflection.ts`'s exact fetch/auth pattern:

```typescript
import { supabase } from './supabase';
import { resolveSupabasePublicConfig } from './supabaseEnv';

export interface MemoryV3ViewerItem {
  memoryKey: string;
  kind: 'event' | 'recurrence';
  claim: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  sensitivity: 'normal' | 'sensitive';
}

async function callMemoryV3Viewer<T>(body: Record<string, unknown>): Promise<T | { error: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const { url: supabaseUrl, anonKey } = resolveSupabasePublicConfig();
  if (!token || !supabaseUrl || !anonKey) return { error: 'no_session' };

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/memory-v3-viewer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? `http_${res.status}` };
    return data as T;
  } catch {
    return { error: 'network' };
  }
}

export async function fetchMemoryV3Items(
  conversationId?: string,
): Promise<{ accountWide: MemoryV3ViewerItem[]; dialogue: MemoryV3ViewerItem[]; error: string | null }> {
  const result = await callMemoryV3Viewer<{ accountWide: MemoryV3ViewerItem[]; dialogue: MemoryV3ViewerItem[] }>({
    action: 'read',
    conversationId,
  });
  if ('error' in result) return { accountWide: [], dialogue: [], error: result.error };
  return { ...result, error: null };
}

export async function deleteMemoryV3Item(input: {
  scope: 'account_wide' | 'dialogue';
  memoryKey: string;
  conversationId?: string;
}): Promise<{ deleted: boolean; error: string | null }> {
  const result = await callMemoryV3Viewer<{ deleted: boolean }>({ action: 'delete', ...input });
  if ('error' in result) return { deleted: false, error: result.error };
  return { ...result, error: null };
}
```

- [ ] **Step 2: Write `src/components/MemoryV3ItemList.tsx`**

Reuses `ConfirmDeleteButton` exactly as `MemoryScreen.tsx`'s existing lists already do (see `ConfirmDeleteButton` usage around line 260 today), and collapses `sensitivity: 'sensitive'` items behind a "показать" toggle per the approved design:

```typescript
import { useState } from 'react';
import type { Theme } from '../context/ThemeContext';
import { ConfirmDeleteButton } from './ConfirmDeleteButton';
import type { MemoryV3ViewerItem } from '../lib/memoryV3Viewer';

export function MemoryV3ItemList({
  items,
  theme,
  cardBase,
  onDelete,
  emptyMessage,
}: {
  items: MemoryV3ViewerItem[];
  theme: Theme;
  cardBase: string;
  onDelete: (item: MemoryV3ViewerItem) => void;
  emptyMessage: string;
}) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  if (items.length === 0) {
    return (
      <div className={`${cardBase} px-4 py-3.5`}>
        <p className={`${theme.textMuted} text-sm font-light leading-relaxed`}>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const isSensitive = item.sensitivity === 'sensitive';
        const isRevealed = revealed.has(item.memoryKey);
        return (
          <li key={item.memoryKey} className={`${cardBase} px-4 py-3 flex items-center justify-between gap-2`}>
            {isSensitive && !isRevealed ? (
              <button
                type="button"
                onClick={() => setRevealed((prev) => new Set(prev).add(item.memoryKey))}
                className={`${theme.textMuted} text-sm font-light text-left flex-1`}
              >
                Чувствительная запись — показать
              </button>
            ) : (
              <p className={`${theme.textPrimary} text-sm font-light flex-1`}>{item.claim}</p>
            )}
            <ConfirmDeleteButton theme={theme} onConfirm={() => onDelete(item)} />
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 3: Manual smoke check**

There is no test harness for React components in this codebase (confirmed earlier today). Run `npm run dev` (or the project's existing dev script), navigate to a screen importing `MemoryV3ItemList` once Task 5 wires it in, and visually confirm: empty state renders the message, a sensitive item starts collapsed, clicking "показать" reveals it, and the delete button's two-step confirm (from the existing `ConfirmDeleteButton`) works.

- [ ] **Step 4: Commit**

```bash
git add src/lib/memoryV3Viewer.ts src/components/MemoryV3ItemList.tsx
git commit -m "feat: add the Memory V3 viewer's client helper and list component"
```

---

### Task 5: Wire into `MemoryScreen.tsx`

**Files:**
- Modify: `src/components/screens/MemoryScreen.tsx`

**Interfaces:**
- Consumes: Task 4's `fetchMemoryV3Items`, `deleteMemoryV3Item`, `MemoryV3ItemList`.
- Produces: the finished screen. No later task depends on this.

- [ ] **Step 1: Add the cohort constant and state**

Near the top of the file (after existing imports), add:

```typescript
import { deleteMemoryV3Item, fetchMemoryV3Items, type MemoryV3ViewerItem } from '../../lib/memoryV3Viewer';
import { MemoryV3ItemList } from '../MemoryV3ItemList';

/** Accounts created on/after this date see Memory V3 in place of the old
 * simple systems; accounts created before it keep the old two sections
 * unchanged, with Memory V3 added as a third section instead. Set to this
 * feature's deploy date. */
const MEMORY_V3_VIEWER_LAUNCH_CUTOFF = new Date('2026-09-24T00:00:00Z');
```

Inside `MemoryScreen()`, after the existing `const { user, profile } = useAuth();` line, add:

```typescript
  const isNewAccount = Boolean(
    user?.created_at && new Date(user.created_at) >= MEMORY_V3_VIEWER_LAUNCH_CUTOFF,
  );
  const [memoryV3AccountWide, setMemoryV3AccountWide] = useState<MemoryV3ViewerItem[]>([]);
  const [memoryV3Dialogue, setMemoryV3Dialogue] = useState<MemoryV3ViewerItem[]>([]);
```

- [ ] **Step 2: Load Memory V3 items alongside the existing `load()` call**

Inside the existing `load` callback (the one already fetching `conversations`/`user_memory`), after the existing `setGlobalRows((mem ?? []) as UserMemory[]);` line and before the `catch` block, add:

```typescript
      const memoryV3 = await fetchMemoryV3Items(activeConvId ?? undefined);
      setMemoryV3AccountWide(memoryV3.accountWide);
      setMemoryV3Dialogue(memoryV3.dialogue);
```

- [ ] **Step 3: Add delete handlers**

Near the existing `deleteGlobalRow` function, add:

```typescript
  async function deleteMemoryV3AccountWideItem(item: MemoryV3ViewerItem) {
    const result = await deleteMemoryV3Item({ scope: 'account_wide', memoryKey: item.memoryKey });
    if (result.deleted) {
      setMemoryV3AccountWide((rows) => rows.filter((row) => row.memoryKey !== item.memoryKey));
    }
  }

  async function deleteMemoryV3DialogueItem(item: MemoryV3ViewerItem) {
    if (!selectedConvId) return;
    const result = await deleteMemoryV3Item({
      scope: 'dialogue', memoryKey: item.memoryKey, conversationId: selectedConvId,
    });
    if (result.deleted) {
      setMemoryV3Dialogue((rows) => rows.filter((row) => row.memoryKey !== item.memoryKey));
    }
  }
```

- [ ] **Step 4: Branch the JSX for existing accounts (add the third section)**

Immediately after the closing `</section>` of the existing "Сквозная память" section (the second `<section>` block), add, gated to existing accounts only:

```jsx
            {!isNewAccount && (
              <section className="mt-8">
                <p className={sectionLabel}>Умная память</p>
                <p className={`${theme.textMuted} text-xs font-light mb-3 leading-relaxed opacity-85`}>
                  Подтверждённые события и повторяющиеся паттерны, которые StaySee сама заметила.
                  Догадки, которые ещё не подтвердились, здесь не показываются.
                </p>
                {selectedConvId && memoryV3Dialogue.length > 0 && (
                  <div className="mb-4">
                    <p className={`${theme.textMuted} text-xs font-light mb-1.5 opacity-70`}>Эта беседа</p>
                    <MemoryV3ItemList
                      items={memoryV3Dialogue}
                      theme={theme}
                      cardBase={cardBase}
                      onDelete={(item) => void deleteMemoryV3DialogueItem(item)}
                      emptyMessage="Пока ничего не запомнено в этой беседе."
                    />
                  </div>
                )}
                <p className={`${theme.textMuted} text-xs font-light mb-1.5 opacity-70`}>Обо мне в целом</p>
                <MemoryV3ItemList
                  items={memoryV3AccountWide}
                  theme={theme}
                  cardBase={cardBase}
                  onDelete={(item) => void deleteMemoryV3AccountWideItem(item)}
                  emptyMessage="Пока ничего не запомнено."
                />
              </section>
            )}
```

- [ ] **Step 5: Branch the JSX for new accounts (replace section bodies)**

Wrap the existing "Память беседы" section's inner content (everything from `<div className="mb-4"><ConversationScopePicker ...` through the closing of the `{selectedConvId && (...)}` block) in `{!isNewAccount ? (...) : (...)}`, with the new-account branch being:

```jsx
                <MemoryV3ItemList
                  items={memoryV3Dialogue}
                  theme={theme}
                  cardBase={cardBase}
                  onDelete={(item) => void deleteMemoryV3DialogueItem(item)}
                  emptyMessage="Пока ничего не запомнено в этой беседе."
                />
```

(Keep the `<ConversationScopePicker>` visible for both branches -- new accounts still need to pick which dialogue's memory they're viewing -- only the content below it swaps.)

Similarly wrap the existing "Сквозная память" section's inner content (the `CrossMemoryToggle`, the add/edit controls, the `activeGlobalRows`/`deprecatedGlobalRows` list) in `{!isNewAccount ? (...) : (...)}`, with the new-account branch being:

```jsx
                <MemoryV3ItemList
                  items={memoryV3AccountWide}
                  theme={theme}
                  cardBase={cardBase}
                  onDelete={(item) => void deleteMemoryV3AccountWideItem(item)}
                  emptyMessage="Пока ничего не запомнено."
                />
```

(Read the full existing JSX for both sections in the actual current file before making this edit -- this plan's earlier research read lines 530-650 of a slightly older version of this file; re-read it fresh at execution time, since exact line numbers will have shifted, and confirm the exact boundaries of what to wrap before editing.)

- [ ] **Step 6: Manual smoke check**

Run the dev server. With a test account whose `created_at` is before the cutoff: confirm both old sections work exactly as before, and the new third section appears below them showing (likely empty, since dialogue-scoped writing is only active for Настя's own account) Memory V3 data. With `MEMORY_V3_VIEWER_LAUNCH_CUTOFF` temporarily set to a past date for testing purposes only (revert before commit): confirm a test account created "after" it sees only two sections, both now backed by Memory V3, both showing the empty-state message correctly, and that no free-text add control appears anywhere in either.

- [ ] **Step 7: Commit**

```bash
git add src/components/screens/MemoryScreen.tsx
git commit -m "feat: show Memory V3 in the account memory screen, split by account cohort"
```

---

### Task 6: Final regression sweep and PR

- [ ] **Step 1: Full backend regression sweep**

```bash
"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/staysee-chat/index.ts
"/c/Users/Я/.deno/bin/deno.exe" check --node-modules-dir=none --no-config supabase/functions/memory-v3-viewer/index.ts
npx tsx --test supabase/functions/_shared/memoryV3/*.cases.test.ts
```
Expected: `staysee-chat/index.ts` unchanged from today's established baseline (47); memoryV3 suite 100% pass including every new test from this plan.

- [ ] **Step 2: Confirm no accidental changes to out-of-scope files**

```bash
git diff main --stat
```
Expected: only files listed in Tasks 1-5 above, plus this plan/design doc.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin <branch-name>
gh pr create --base main --title "..." --body "..."
```

Do not merge. Report the PR link and stop.
