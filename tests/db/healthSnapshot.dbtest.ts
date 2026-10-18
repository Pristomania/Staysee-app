import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { after, before, describe, it } from "node:test";

import { evaluateMemoryV3Health } from "../../supabase/functions/_shared/memoryV3/healthCheck.ts";
import { adminClient, addMessages, createConversation, createUser, deleteUser, messageId, must, sha256hex } from "./helpers.ts";

// memory_v3_health_snapshot(): the aggregate the hourly health check reads.
// Counts only -- no account, conversation or message text -- and callable by the
// service role alone. The last test feeds its real output to the TypeScript
// rules, so the SQL and the code cannot drift apart unnoticed.

type Pipeline = { succeeded: number; failed: number; stuck: number; failedByCode: Record<string, number> };
type Snapshot = { windowMinutes: number; userMessages: number; dialogue: Pipeline; lifecycle: Pipeline };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("Memory V3 health snapshot on real Postgres", () => {
  let client: SupabaseClient;
  let userId: string;
  let conversationId: string;
  let seq = 0;

  before(async () => {
    client = adminClient();
    userId = await createUser(client, "health-snapshot");
    conversationId = await createConversation(client, userId);
    // Source message every run points at; far in the past so it is outside every window.
    await addMessages(client, conversationId, [{ id: messageId("c3000000", 0), at: "2026-01-01T00:00:00+00:00" }]);
  });

  after(async () => {
    await deleteUser(client, userId);
  });

  async function snapshot(windowMinutes = 120): Promise<Snapshot> {
    return await must(client.rpc("memory_v3_health_snapshot", { p_window_minutes: windowMinutes }), "snapshot") as Snapshot;
  }

  async function seedRun(
    pipeline: "dialogue" | "lifecycle",
    status: "succeeded" | "failed" | "reserved",
    createdAt: string,
    code?: string,
  ): Promise<void> {
    seq += 1;
    const version = pipeline === "dialogue" ? "memory-v3-dialogue-v1" : "memory-v3-lifecycle-shadow-v1";
    const identities = pipeline === "dialogue" ? "memory_v3_dialogue_identities" : "memory_v3_lifecycle_shadow_identities";
    const runs = pipeline === "dialogue" ? "memory_v3_dialogue_runs" : "memory_v3_lifecycle_shadow_runs";
    const inputHash = sha256hex(`health-${pipeline}-${seq}`);
    await must(client.from(identities).insert({
      user_id: userId, conversation_id: conversationId, pipeline_version: version, input_hash: inputHash,
    }), "seed identity");
    const common = {
      user_id: userId, conversation_id: conversationId, pipeline_version: version, input_hash: inputHash,
      extractor_version: "e", reconciler_version: "r", model: "google/gemini-3.7-flash", status,
      source_last_message_id: messageId("c3000000", 0), source_last_created_at: "2026-01-01T00:00:00+00:00",
      message_count: 1, user_message_count: 1, expected_state_revision: 0, created_at: createdAt,
    };
    const terminal = status === "succeeded"
      ? { resulting_state_revision: 0, extraction: {}, operations: {}, transitions: {}, item_count: 0, evidence_count: 0, transition_count: 0, completed_at: createdAt }
      : status === "failed"
        ? { diagnostic_code: code, completed_at: createdAt }
        : {};
    await must(client.from(runs).insert({ ...common, ...terminal }), `seed ${pipeline} ${status}`);
  }

  const diff = (after: Pipeline, before: Pipeline) => ({
    succeeded: after.succeeded - before.succeeded,
    failed: after.failed - before.failed,
    stuck: after.stuck - before.stuck,
    byCode: (code: string) => (after.failedByCode[code] ?? 0) - (before.failedByCode[code] ?? 0),
  });

  it("counts runs by outcome inside the window, with stuck runs and failure codes, and ignores older ones", async () => {
    const before = await snapshot();
    await addMessages(client, conversationId, [
      { id: messageId("c3000000", 1), at: minutesAgo(5) },
      { id: messageId("c3000000", 2), at: minutesAgo(20) },
      { id: messageId("c3000000", 3), at: minutesAgo(60) },
      { id: messageId("c3000000", 4), at: minutesAgo(30), sender: "ai" },
      { id: messageId("c3000000", 5), at: minutesAgo(180) },
    ]);
    await seedRun("dialogue", "succeeded", minutesAgo(10));
    await seedRun("dialogue", "succeeded", minutesAgo(40));
    await seedRun("dialogue", "failed", minutesAgo(15), "state_write_failed");
    await seedRun("dialogue", "failed", minutesAgo(25), "extractor_transport_failed");
    await seedRun("dialogue", "failed", minutesAgo(35), "extractor_transport_failed");
    await seedRun("dialogue", "reserved", minutesAgo(45)); // stuck: reserved for 45 minutes
    await seedRun("dialogue", "reserved", minutesAgo(1)); // still running normally: not stuck
    await seedRun("dialogue", "failed", minutesAgo(180), "state_write_failed"); // outside the window
    await seedRun("lifecycle", "succeeded", minutesAgo(12));
    await seedRun("lifecycle", "failed", minutesAgo(18), "reservation_failed");

    const after = await snapshot();
    assert.equal(after.windowMinutes, 120);
    assert.equal(after.userMessages - before.userMessages, 3, "3 user messages in the window; the AI reply and the old one do not count");
    const dialogue = diff(after.dialogue, before.dialogue);
    assert.deepEqual([dialogue.succeeded, dialogue.failed, dialogue.stuck], [2, 3, 1]);
    assert.equal(dialogue.byCode("extractor_transport_failed"), 2);
    assert.equal(dialogue.byCode("state_write_failed"), 1);
    const lifecycle = diff(after.lifecycle, before.lifecycle);
    assert.deepEqual([lifecycle.succeeded, lifecycle.failed, lifecycle.stuck], [1, 1, 0]);
    assert.equal(lifecycle.byCode("reservation_failed"), 1);
  });

  it("returns only aggregate numbers: nothing that names an account, conversation or message", async () => {
    const text = JSON.stringify(await snapshot());
    assert.equal(text.includes(userId), false);
    assert.equal(text.includes(conversationId), false);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("is readable by the TypeScript health rules exactly as the database returns it", async () => {
    const real = await snapshot();
    assert.doesNotThrow(() => evaluateMemoryV3Health(real));
  });

  it("refuses a window that is too short or too long", async () => {
    for (const minutes of [5, 2000]) {
      const { error } = await client.rpc("memory_v3_health_snapshot", { p_window_minutes: minutes });
      assert.match(String(error?.message), /invalid health window/);
    }
  });

  it("is not callable by signed-in users or the public key", async (t) => {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) return t.skip("SUPABASE_ANON_KEY is not set");
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data, error } = await anon.rpc("memory_v3_health_snapshot", { p_window_minutes: 120 });
    assert.notEqual(error, null);
    assert.equal(data, null);
  });
});
