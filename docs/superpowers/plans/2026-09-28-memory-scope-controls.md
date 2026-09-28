# StaySee Memory Scope Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make profile memory the all-conversation management center while allowing each conversation to independently enable or disable cross-memory without affecting dialogue memory.

**Architecture:** Store the profile default/bulk value on `profiles` and the effective value on every `conversations` row. Database RPCs perform the bulk and single-conversation mutations, while every live server read/write path consults the conversation value. The Memory screen has two explicit modes selected by its existing navigation origin.

**Tech Stack:** React 18, TypeScript, Supabase/PostgreSQL, Supabase Edge Functions/Deno, Node test runner through `tsx`, Vite.

**Spec:** `docs/superpowers/specs/2026-09-28-memory-scope-controls-design.md`

## Global Constraints

- Dialogue memory must remain readable and writable regardless of either cross-memory switch.
- Profile toggle is a bulk action and the default for new conversations; it is not a hard runtime gate after a per-conversation exception is created.
- Chat-origin Memory must never list or silently select another conversation.
- Cross-memory off for a conversation blocks both cross-memory reads and cross-memory writes for that conversation.
- No migration, log, diagnostic, or UI error may expose memory text, message text, user IDs, conversation IDs, tokens, or secrets.
- No memory contents are deleted, rebuilt, or backfilled by this feature.
- No paid provider run is required or permitted by this plan.

---

### Task 1: Database contract for profile bulk control and conversation exceptions

**Files:**
- Create: `supabase/migrations/20260928120000_057_conversation_cross_memory_controls.sql`
- Create: `supabase/functions/_shared/memoryV3/conversationCrossMemoryControlsMigration.cases.test.ts`

**Interfaces:**
- Produces: `conversations.cross_memory_enabled boolean NOT NULL`
- Produces: `public.set_cross_memory_enabled_for_all(p_enabled boolean) RETURNS void`
- Produces: `public.set_conversation_cross_memory_enabled(p_conversation_id uuid, p_enabled boolean) RETURNS void`
- Produces: insert trigger that copies `profiles.cross_memory_enabled` to a new conversation

- [ ] **Step 1: Write the failing migration contract tests**

Create tests that read the migration as text and assert the durable contract:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migration = await readFile(
  new URL("../../../migrations/20260928120000_057_conversation_cross_memory_controls.sql", import.meta.url),
  "utf8",
);

describe("conversation cross-memory controls migration", () => {
  it("adds and backfills the conversation setting from the profile", () => {
    assert.match(migration, /ADD COLUMN IF NOT EXISTS cross_memory_enabled boolean/iu);
    assert.match(migration, /UPDATE public\.conversations[\s\S]*public\.profiles/iu);
    assert.match(migration, /COALESCE\(p\.cross_memory_enabled, true\)/iu);
    assert.match(migration, /ALTER COLUMN cross_memory_enabled SET NOT NULL/iu);
  });

  it("inherits the profile default for new conversations", () => {
    assert.match(migration, /BEFORE INSERT ON public\.conversations/iu);
    assert.match(migration, /NEW\.cross_memory_enabled/iu);
  });

  it("provides authenticated bulk and one-conversation mutations", () => {
    assert.match(migration, /set_cross_memory_enabled_for_all\(p_enabled boolean\)/iu);
    assert.match(migration, /UPDATE public\.profiles[\s\S]*UPDATE public\.conversations/iu);
    assert.match(migration, /set_conversation_cross_memory_enabled\(p_conversation_id uuid, p_enabled boolean\)/iu);
    assert.match(migration, /user_id = auth\.uid\(\)/iu);
    assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/iu);
    assert.match(migration, /REVOKE ALL[\s\S]*FROM PUBLIC, anon/iu);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npx tsx --test supabase/functions/_shared/memoryV3/conversationCrossMemoryControlsMigration.cases.test.ts
```

Expected: FAIL because the migration file does not exist.

- [ ] **Step 3: Implement the migration**

The migration must:

```sql
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS cross_memory_enabled boolean;

UPDATE public.conversations AS c
SET cross_memory_enabled = COALESCE(p.cross_memory_enabled, true)
FROM public.profiles AS p
WHERE p.id = c.user_id
  AND c.cross_memory_enabled IS NULL;

UPDATE public.conversations
SET cross_memory_enabled = true
WHERE cross_memory_enabled IS NULL;

ALTER TABLE public.conversations
  ALTER COLUMN cross_memory_enabled SET DEFAULT true,
  ALTER COLUMN cross_memory_enabled SET NOT NULL;
```

Add a `BEFORE INSERT` trigger that always copies the owner's current profile default. Add two `SECURITY DEFINER SET search_path = ''` functions. Both must reject unauthenticated calls, use `auth.uid()` as ownership authority, reject null inputs, and raise a stable error when no owned row was changed. The bulk function updates the profile and all owned conversations in one transaction. Revoke execution from `PUBLIC` and `anon`; grant it to `authenticated`.

- [ ] **Step 4: Run migration tests and SQL privacy checks**

Run:

```powershell
npx tsx --test supabase/functions/_shared/memoryV3/conversationCrossMemoryControlsMigration.cases.test.ts
rg -n "memory text|message text|email|OPENROUTER|service_role" supabase/migrations/20260928120000_057_conversation_cross_memory_controls.sql
```

Expected: tests PASS; privacy search returns no sensitive payload handling.

- [ ] **Step 5: Commit Task 1**

```powershell
git add supabase/migrations/20260928120000_057_conversation_cross_memory_controls.sql supabase/functions/_shared/memoryV3/conversationCrossMemoryControlsMigration.cases.test.ts
git commit -m "[agent] feat: add conversation cross-memory controls"
```

---

### Task 2: One server-side source of truth for effective cross-memory

**Files:**
- Modify: `supabase/functions/_shared/profilePrefs.ts`
- Create: `supabase/functions/_shared/profilePrefs.cases.test.ts`
- Modify: `supabase/functions/_shared/context.ts`
- Modify: `supabase/functions/_shared/context.cases.test.ts`
- Modify: `supabase/functions/_shared/userLifeMemory.ts`
- Create: `supabase/functions/_shared/userLifeMemory.cases.test.ts`

**Interfaces:**
- Produces: `fetchConversationCrossMemoryEnabled(supabase, userId, conversationId): Promise<boolean>`
- Preserves: `fetchCrossMemoryEnabled(supabase, userId): Promise<boolean>` for profile-default and non-conversation maintenance flows

- [ ] **Step 1: Write failing preference-reader tests**

Cover these behaviors with a small recording Supabase client:

```ts
it("returns the owned conversation value even when the profile default is false", async () => {
  const client = conversationPreferenceClient({ cross_memory_enabled: true });
  assert.equal(
    await fetchConversationCrossMemoryEnabled(client, "user-1", "conversation-1"),
    true,
  );
  assert.deepEqual(client.filters, [
    ["id", "conversation-1"],
    ["user_id", "user-1"],
  ]);
});

it("falls back to the profile default on a rollout-compatible read error", async () => {
  const client = failingConversationPreferenceClient({ profileEnabled: false });
  assert.equal(
    await fetchConversationCrossMemoryEnabled(client, "user-1", "conversation-1"),
    false,
  );
});
```

Add source/behavior assertions that `buildContextPacket` passes `input.conversationId`, and `refreshUserLifeMemory` uses the conversation reader whenever `conversationId` is present.

- [ ] **Step 2: Run targeted tests and verify RED**

```powershell
npx tsx --test supabase/functions/_shared/profilePrefs.cases.test.ts supabase/functions/_shared/context.cases.test.ts supabase/functions/_shared/userLifeMemory.cases.test.ts
```

Expected: FAIL because the conversation reader and gating do not exist.

- [ ] **Step 3: Implement the preference reader**

Add:

```ts
export async function fetchConversationCrossMemoryEnabled(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("conversations")
    .select("cross_memory_enabled")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!error && data) return data.cross_memory_enabled !== false;
  console.warn("[profilePrefs] conversation cross-memory preference unavailable");
  return fetchCrossMemoryEnabled(supabase, userId);
}
```

The diagnostic must not include raw error text or identifiers.

- [ ] **Step 4: Wire legacy prompt injection and legacy refresh**

In `buildContextPacket`, replace the profile-only lookup with the conversation reader. In `refreshUserLifeMemory`, use the conversation reader when `conversationId` is non-null; retain the profile reader only for explicit maintenance calls without a conversation.

- [ ] **Step 5: Run targeted and nearby regression tests**

```powershell
npx tsx --test supabase/functions/_shared/profilePrefs.cases.test.ts supabase/functions/_shared/context.cases.test.ts supabase/functions/_shared/userLifeMemory.cases.test.ts supabase/functions/_shared/crossMemoryBuild.cases.test.ts supabase/functions/_shared/crossMemoryRetention.cases.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add supabase/functions/_shared/profilePrefs.ts supabase/functions/_shared/profilePrefs.cases.test.ts supabase/functions/_shared/context.ts supabase/functions/_shared/context.cases.test.ts supabase/functions/_shared/userLifeMemory.ts supabase/functions/_shared/userLifeMemory.cases.test.ts
git commit -m "[agent] fix: scope cross-memory runtime preference"
```

---

### Task 3: Gate Memory V3 lifecycle reads and writes per conversation

**Files:**
- Modify: `supabase/functions/staysee-chat/index.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts`
- Modify: `supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts`
- Modify: `supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts`

**Interfaces:**
- Consumes: `fetchConversationCrossMemoryEnabled(...)` from Task 2
- Preserves: dialogue memory execution independent of cross-memory

- [ ] **Step 1: Write failing lifecycle wiring tests**

Require both read and write stages to call the conversation preference with `userId` and `conversationId`:

```ts
assert.match(
  stayseeChat,
  /fetchConversationCrossMemoryEnabled\([\s\S]*?userId,[\s\S]*?conversationId[\s\S]*?\)/u,
);
assert.doesNotMatch(
  dialogueBlock,
  /crossMemoryOnFor(Read|Write)[\s\S]*?dialogueMemoryPromise/u,
);
```

Add a behavioral/source-order assertion proving the preference is resolved before lifecycle loading or lifecycle background execution, while the dialogue branch remains outside the gate.

- [ ] **Step 2: Run Memory V3 wiring tests and verify RED**

```powershell
npx tsx --test supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts
```

Expected: FAIL because `staysee-chat` still reads the profile-only value.

- [ ] **Step 3: Replace the two profile-only checks**

At lifecycle read and lifecycle write stages call:

```ts
const crossMemoryOnForRead = conversationId
  ? await fetchConversationCrossMemoryEnabled(service, userId, conversationId)
  : await fetchCrossMemoryEnabled(service, userId);
```

Use the equivalent `crossMemoryOnForWrite` expression for background work. Keep dialogue load and dialogue background extraction outside these conditions.

- [ ] **Step 4: Run targeted Memory V3 tests**

```powershell
npx tsx --test supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add supabase/functions/staysee-chat/index.ts supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts
git commit -m "[agent] fix: gate lifecycle memory per conversation"
```

---

### Task 4: Frontend settings APIs and explicit toggle components

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/profileSettings.ts`
- Create: `src/lib/conversationMemorySettings.ts`
- Create: `src/lib/memoryScopeControls.cases.test.ts`
- Modify: `src/components/CrossMemoryToggle.tsx`
- Create: `src/components/ConversationCrossMemoryToggle.tsx`

**Interfaces:**
- Produces: `setCrossMemoryEnabledForAll(enabled: boolean): Promise<{ ok: boolean }>` through the profile RPC wrapper
- Produces: `setConversationCrossMemoryEnabled(conversationId: string, enabled: boolean): Promise<{ ok: boolean }>`
- Produces: `Conversation.cross_memory_enabled?: boolean`
- Produces: profile bulk component callback `onChanged?: () => void`
- Produces: conversation component callback `onChanged(enabled: boolean): void`

- [ ] **Step 1: Write failing API contract tests**

Use injected/recording Supabase calls or pure exported request builders to assert exact RPC boundaries:

```ts
it("bulk control calls only the bulk RPC", async () => {
  const rpc = recordingRpc();
  await setCrossMemoryEnabledForAll(false, rpc);
  assert.deepEqual(rpc.calls, [["set_cross_memory_enabled_for_all", { p_enabled: false }]]);
});

it("conversation control changes only one conversation", async () => {
  const rpc = recordingRpc();
  await setConversationCrossMemoryEnabled("conversation-1", true, rpc);
  assert.deepEqual(rpc.calls, [["set_conversation_cross_memory_enabled", {
    p_conversation_id: "conversation-1",
    p_enabled: true,
  }]]);
});
```

- [ ] **Step 2: Run the tests and verify RED**

```powershell
npx tsx --test src/lib/memoryScopeControls.cases.test.ts
```

Expected: FAIL because the scoped APIs do not exist.

- [ ] **Step 3: Implement API wrappers and types**

Keep Supabase-specific calls in the two library modules. Return `{ ok: false }` without exposing raw backend messages to the UI. Add the conversation boolean to `Conversation`.

- [ ] **Step 4: Implement the two controls**

`CrossMemoryToggle` becomes explicitly bulk/profile scoped and uses the approved copy. Create `ConversationCrossMemoryToggle` with props:

```ts
interface ConversationCrossMemoryToggleProps {
  conversationId: string;
  enabled: boolean;
  profileDefaultEnabled: boolean;
  cardClass: string;
  onChanged(enabled: boolean): void;
}
```

It keeps the confirmed value on failure, displays a local retry message, and renders the exception hint when `profileDefaultEnabled === false && enabled === true`.

- [ ] **Step 5: Run unit checks, typecheck, and lint on touched files**

```powershell
npx tsx --test src/lib/memoryScopeControls.cases.test.ts
npm run typecheck
npx eslint src/types/index.ts src/lib/profileSettings.ts src/lib/conversationMemorySettings.ts src/components/CrossMemoryToggle.tsx src/components/ConversationCrossMemoryToggle.tsx
```

Expected: all exit 0.

- [ ] **Step 6: Commit Task 4**

```powershell
git add src/types/index.ts src/lib/profileSettings.ts src/lib/conversationMemorySettings.ts src/lib/memoryScopeControls.cases.test.ts src/components/CrossMemoryToggle.tsx src/components/ConversationCrossMemoryToggle.tsx
git commit -m "[agent] feat: add scoped memory controls"
```

---

### Task 5: Split the Memory screen into profile and chat modes

**Files:**
- Create: `src/lib/memoryScreenMode.ts`
- Create: `src/lib/memoryScreenMode.cases.test.ts`
- Modify: `src/components/screens/MemoryScreen.tsx`
- Modify: `src/components/screens/ProfileScreen.tsx`

**Interfaces:**
- Produces: `resolveMemoryScreenCapabilities(origin: 'profile' | 'chat')`
- Consumes: scoped toggle components from Task 4
- Preserves: `memoryReturnScreen` as the navigation-origin authority

- [ ] **Step 1: Write failing mode tests**

```ts
assert.deepEqual(resolveMemoryScreenCapabilities("profile"), {
  canChooseConversation: true,
  showAccountWideMemory: true,
  showProfileBulkControl: true,
  showConversationControl: false,
});

assert.deepEqual(resolveMemoryScreenCapabilities("chat"), {
  canChooseConversation: false,
  showAccountWideMemory: false,
  showProfileBulkControl: false,
  showConversationControl: true,
});
```

- [ ] **Step 2: Run the mode test and verify RED**

```powershell
npx tsx --test src/lib/memoryScreenMode.cases.test.ts
```

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement the pure mode resolver**

Return frozen/static capabilities with no React or Supabase dependency. `MemoryScreen` must consume these booleans rather than duplicate origin conditionals.

- [ ] **Step 4: Restrict chat-origin loading**

For `memoryReturnScreen === 'chat'`:

```ts
const convId = currentConversation?.id ?? null;
```

Query only that owned conversation, including `cross_memory_enabled`. Do not query the conversation list and do not fall back to `list[0]`. If no current conversation exists, navigate back instead of displaying another chat.

- [ ] **Step 5: Keep profile-origin management behavior**

For `memoryReturnScreen === 'profile'`, load the active conversation list with `id, title, cross_memory_enabled`, keep `ConversationScopePicker`, render account-wide memory, and use the profile bulk control. Reload conversation settings after a successful bulk change.

- [ ] **Step 6: Render chat-origin content**

Render the current chat title, its dialogue memory, and `ConversationCrossMemoryToggle`. Do not render `ConversationScopePicker`, the account-wide fact editor, or the profile bulk control. Keep `ConversationHubNav` and back navigation consistent with the current chat.

- [ ] **Step 7: Run tests and frontend verification**

```powershell
npx tsx --test src/lib/memoryScreenMode.cases.test.ts src/lib/memoryScopeControls.cases.test.ts
npm run typecheck
npm run lint
npm run build
```

Expected: all exit 0 and the production bundle verifier passes.

- [ ] **Step 8: Commit Task 5**

```powershell
git add src/lib/memoryScreenMode.ts src/lib/memoryScreenMode.cases.test.ts src/components/screens/MemoryScreen.tsx src/components/screens/ProfileScreen.tsx
git commit -m "[agent] feat: separate profile and chat memory views"
```

---

### Task 6: Full regression, review, and safe rollout

**Files:**
- No planned file changes; any correction must remain within the files listed in Tasks 1-5

**Interfaces:**
- Verifies the complete spec before deployment

- [ ] **Step 1: Run every offline test relevant to memory**

Build an explicit file list rather than relying on shell glob expansion:

```powershell
$tests = Get-ChildItem supabase/functions/_shared,src/lib -Recurse -File -Include *.cases.test.ts,*.test.ts | ForEach-Object FullName
npx tsx --test $tests
```

Expected: zero failures.

- [ ] **Step 2: Run static and production checks**

```powershell
npm run typecheck
npm run lint
npm run build
git diff --check
git status --short
```

Expected: all commands exit 0; status contains only intentional files.

- [ ] **Step 3: Review requirements against the spec**

Confirm with code/test evidence:

- profile view alone lists conversations and edits account-wide facts;
- chat view is locked to its current conversation;
- profile bulk off followed by one chat on leaves the profile default off;
- new chats inherit the profile default;
- cross-memory read and write share one conversation preference;
- dialogue memory remains active in every cross-memory state;
- no memory contents are deleted or migrated.

- [ ] **Step 4: Commit any verified final corrections**

If and only if verification required corrections, stage the complete in-scope set; unchanged paths are ignored by Git:

```powershell
git add supabase/migrations/20260928120000_057_conversation_cross_memory_controls.sql supabase/functions/_shared/profilePrefs.ts supabase/functions/_shared/profilePrefs.cases.test.ts supabase/functions/_shared/context.ts supabase/functions/_shared/context.cases.test.ts supabase/functions/_shared/userLifeMemory.ts supabase/functions/_shared/userLifeMemory.cases.test.ts supabase/functions/staysee-chat/index.ts supabase/functions/_shared/memoryV3/lifecycleReadWiring.cases.test.ts supabase/functions/_shared/memoryV3/lifecycleWiring.cases.test.ts supabase/functions/_shared/memoryV3/dialogueLiveWiring.cases.test.ts src/types/index.ts src/lib/profileSettings.ts src/lib/conversationMemorySettings.ts src/lib/memoryScopeControls.cases.test.ts src/components/CrossMemoryToggle.tsx src/components/ConversationCrossMemoryToggle.tsx src/lib/memoryScreenMode.ts src/lib/memoryScreenMode.cases.test.ts src/components/screens/MemoryScreen.tsx src/components/screens/ProfileScreen.tsx
git commit -m "[agent] fix: complete scoped memory controls"
```

- [ ] **Step 5: Push branch and open the PR**

```powershell
git push -u origin codex/memory-scope-controls
gh pr create --base main --head codex/memory-scope-controls --title "Separate profile and conversation memory controls" --body "Separates profile-wide bulk/default controls from per-conversation cross-memory exceptions. Keeps dialogue memory independent and adds migration, server, UI, and regression coverage. No memory content migration and no paid provider run."
```

Attach the PR to the Codex task after creation. Merge only after required checks are green and final review finds no blocker.

- [ ] **Step 6: Apply the database migration**

After merge, deploy migrations to the linked production project using the repository's established Supabase workflow. Verify the new column, trigger, and both RPC signatures with read-only SQL. Do not print user rows or memory contents.

- [ ] **Step 7: Deploy `staysee-chat`**

```powershell
npx supabase functions deploy staysee-chat --project-ref jnxrildlwvtxhtiwucbt
```

Verify the deployed function is ACTIVE and uses the new version. This deployment does not call a paid model.

- [ ] **Step 8: Verify frontend deployment and perform non-paid UI smoke checks**

In an authenticated test session:

1. From Profile → Memory, confirm the conversation picker and bulk control are present.
2. Bulk-disable cross-memory and confirm all listed conversations report off.
3. Enter one chat → Memory, confirm no conversation picker or account-wide editor appears.
4. Enable cross-memory for this chat and confirm the profile default remains off.
5. Create a new chat and confirm it starts off.
6. Return to the exception chat and confirm it remains on.
7. Confirm dialogue memory remains visible in both chats.

Do not send a model message during this smoke check, so no provider cost is incurred.

- [ ] **Step 9: Record rollout evidence**

Update the project progress/memory notes with commit, PR, migration, function version, test totals, and the exact UI smoke results. Do not record account identifiers, conversation identifiers, memory text, or secrets.
