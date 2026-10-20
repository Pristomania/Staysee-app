import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { runMemoryV3DialogueShadow } from "../../supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts";
import { createMemoryV3DialogueStore } from "../../supabase/functions/_shared/memoryV3/dialogueStore.ts";
import { runMemoryV3LifecycleShadow } from "../../supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts";
import { createMemoryV3LifecycleStore } from "../../supabase/functions/_shared/memoryV3/lifecycleStore.ts";
import { createMemoryV3MessageLoader } from "../../supabase/functions/_shared/memoryV3/messages.ts";
import { runWithOneConflictRetry } from "../../supabase/functions/_shared/memoryV3/retry.ts";
import { addMessages, adminClient, createConversation, createUser, deleteUser, messageId } from "./helpers.ts";

// When two memory runs overlap, the one that finishes second finds the state changed and its write is
// refused. The database function that refuses it ALSO closes the run as failed/state_conflict. The app
// used to try to close it a second time, the database answered "this run is not open any more", and the
// app reported that as state_write_failed: a Telegram alert for what is a normal overlap, and no
// automatic rerun (the rerun only starts on state_conflict). These tests use the real database to prove
// that an overlap stays a state_conflict and raises no alert.
//
// The rerun itself does nothing useful today: the database remembers every analysed window and answers
// "duplicate" for the identical one. That is fine, because a failed run never moves the conversation's
// cursor, so the next reply's run reads the missed messages again (the last test proves it).

const PREFIX = "c3000001";
const EMPTY_EXTRACTION = JSON.stringify({
  layerDecisions: [
    { kind: "event", decision: "omit", itemRefs: [] },
    { kind: "recurrence", decision: "omit", itemRefs: [] },
    { kind: "hypothesis", decision: "omit", itemRefs: [] },
  ],
  items: [],
  evidence: [],
});

const noPause = { sleep: async () => {} };

type Pipeline = {
  name: string;
  runsTable: string;
  headsTable: string;
  run: (client: SupabaseClient, userId: string, conversationId: string, onExtractorCall: () => Promise<void>) => Promise<unknown>;
  bumpHead: (client: SupabaseClient, userId: string, conversationId: string) => Promise<void>;
};

// What another run finishing first does to this run: it moves the memory state on by one revision.
async function bumpRevision(client: SupabaseClient, table: string, userId: string, conversationId: string | null): Promise<void> {
  let read = client.from(table).select("state_revision").eq("user_id", userId);
  if (conversationId !== null) read = read.eq("conversation_id", conversationId);
  const { data, error } = await read.single();
  if (error) throw new Error(`read ${table}: ${error.message}`);
  let write = client.from(table).update({ state_revision: Number(data.state_revision) + 1 }).eq("user_id", userId);
  if (conversationId !== null) write = write.eq("conversation_id", conversationId);
  const { error: writeError } = await write;
  if (writeError) throw new Error(`bump ${table}: ${writeError.message}`);
}

const failIfReconcilerRuns = () => async () => {
  throw new Error("the reconciler must not run for an empty extraction");
};

const pipelines: Pipeline[] = [
  {
    name: "dialogue",
    runsTable: "memory_v3_dialogue_runs",
    headsTable: "memory_v3_dialogue_heads",
    run: (client, userId, conversationId, onExtractorCall) => runMemoryV3DialogueShadow({
      userId,
      conversationId,
      apiKey: "test-key",
      loadMessages: createMemoryV3MessageLoader(client as never),
      store: createMemoryV3DialogueStore(client as never),
      extractorAdapterFactory: () => async () => {
        await onExtractorCall();
        return { content: EMPTY_EXTRACTION, usage: null };
      },
      reconcilerAdapterFactory: failIfReconcilerRuns,
    } as never),
    bumpHead: (client, userId, conversationId) => bumpRevision(client, "memory_v3_dialogue_heads", userId, conversationId),
  },
  {
    name: "lifecycle",
    runsTable: "memory_v3_lifecycle_shadow_runs",
    headsTable: "memory_v3_lifecycle_shadow_heads",
    run: (client, userId, conversationId, onExtractorCall) => runMemoryV3LifecycleShadow({
      rawMode: "lifecycle_shadow",
      rawAllowedUserId: userId,
      userId,
      conversationId,
      apiKey: "test-key",
      loadMessages: createMemoryV3MessageLoader(client as never),
      store: createMemoryV3LifecycleStore(client as never),
      extractorAdapterFactory: () => async () => {
        await onExtractorCall();
        return { content: EMPTY_EXTRACTION, usage: null };
      },
      reconcilerAdapterFactory: failIfReconcilerRuns,
    } as never),
    bumpHead: (client, userId) => bumpRevision(client, "memory_v3_lifecycle_shadow_heads", userId, null),
  },
];

describe("Memory V3 overlapping runs on the real database", () => {
  let client: SupabaseClient;
  let userId: string;
  let counter = 0;

  before(async () => {
    client = adminClient();
    userId = await createUser(client, "conflict-recovery");
  });

  after(async () => {
    await deleteUser(client, userId);
  });

  // A fresh conversation per test: the database remembers every analysed window, so reusing one would
  // make the second test's first run a "duplicate".
  async function freshConversation(): Promise<string> {
    counter += 1;
    const conversationId = await createConversation(client, userId);
    await addMessages(client, conversationId, [
      { id: messageId(PREFIX, counter * 10 + 1), at: "2026-10-01T10:00:00+00:00", sender: "user" },
      { id: messageId(PREFIX, counter * 10 + 2), at: "2026-10-01T10:00:05+00:00", sender: "ai" },
    ]);
    return conversationId;
  }

  for (const pipeline of pipelines) {
    describe(`${pipeline.name} pipeline`, () => {
      async function runRows(conversationId: string) {
        const { data, error } = await client
          .from(pipeline.runsTable)
          .select("id,status,diagnostic_code,message_count")
          .eq("user_id", userId)
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true });
        if (error) throw new Error(error.message);
        return data as Array<{ id: string; status: string; diagnostic_code: string | null; message_count: number }>;
      }

      type Outcome = { status: string; runId?: string | null; diagnosticCode?: string; reason?: string };

      it("reports an overlap as state_conflict, not as state_write_failed", async () => {
        const conversationId = await freshConversation();
        // The "other run" finishes while this one is still waiting for the model.
        const result = await pipeline.run(client, userId, conversationId, () => pipeline.bumpHead(client, userId, conversationId)) as Outcome;
        assert.equal(result.status, "failed");
        assert.equal(result.diagnosticCode, "state_conflict");
        const rows = await runRows(conversationId);
        assert.equal(rows.length, 1);
        assert.deepEqual({ status: rows[0].status, code: rows[0].diagnostic_code }, { status: "failed", code: "state_conflict" });
        assert.equal(result.runId, rows[0].id);
      });

      it("raises no failure after an overlap, and the next reply's run picks the missed messages up", async () => {
        const conversationId = await freshConversation();
        let attempt = 0;
        const outcomes: Outcome[] = [];
        const afterRerun = await runWithOneConflictRetry(async () => {
          attempt += 1;
          const outcome = await pipeline.run(
            client, userId, conversationId,
            // Only the first attempt is overlapped by another run.
            async () => { if (attempt === 1) await pipeline.bumpHead(client, userId, conversationId); },
          ) as Outcome;
          outcomes.push(outcome);
          return outcome;
        }, noPause);
        assert.equal(attempt, 2, `attempt outcomes: ${JSON.stringify(outcomes)}`);
        // Not a failure: nothing here may reach the owner as an alert.
        assert.notEqual(afterRerun.status, "failed", JSON.stringify(outcomes));
        assert.deepEqual((await runRows(conversationId)).map((row) => `${row.status}/${row.diagnostic_code ?? "-"}`), ["failed/state_conflict"]);

        // The person writes again: that reply's run reads the whole conversation, including what the
        // overlapped run never got to analyse.
        await addMessages(client, conversationId, [
          { id: messageId(PREFIX, counter * 10 + 3), at: "2026-10-01T10:01:00+00:00", sender: "user" },
        ]);
        const next = await pipeline.run(client, userId, conversationId, async () => {}) as Outcome;
        assert.equal(next.status, "succeeded", JSON.stringify(next));
        const rows = await runRows(conversationId);
        assert.deepEqual(rows.map((row) => `${row.status}/${row.diagnostic_code ?? "-"}`), ["failed/state_conflict", "succeeded/-"]);
        assert.equal(rows[1].message_count, 3);
      });
    });
  }
});
