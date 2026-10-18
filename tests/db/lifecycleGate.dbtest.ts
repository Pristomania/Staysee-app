import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { adminClient, addMessages, createConversation, createUser, deleteUser, messageId, must, sha256hex } from "./helpers.ts";

// The lifecycle (cross-conversation) memory trigger gate, reserve_memory_v3_lifecycle_shadow_run:
// a conversation reaches the extractor only after 10 messages that are NEW
// relative to its last SUCCEEDED run. "New" compares the pair (created_at, id),
// because two messages can share a timestamp (migration 078).
// The offline suite can only read the SQL text; this runs it in real Postgres.

const PIPELINE = "memory-v3-lifecycle-shadow-v1";
const T0 = "2026-10-01T10:00:00+00:00";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString().replace(".000Z", "+00:00");

describe("Memory V3 lifecycle trigger gate on real Postgres", () => {
  let client: SupabaseClient;
  let userId: string;
  let calls = 0;

  before(async () => {
    client = adminClient();
    userId = await createUser(client, "lifecycle-gate");
  });

  after(async () => {
    await deleteUser(client, userId);
  });

  async function reserve(conversationId: string, lastMessageId: string, lastAt: string): Promise<string> {
    calls += 1;
    const rows = await must(
      client.rpc("reserve_memory_v3_lifecycle_shadow_run", {
        p_user_id: userId,
        p_conversation_id: conversationId,
        p_pipeline_version: PIPELINE,
        p_extractor_version: "e",
        p_reconciler_version: "r",
        p_model: "google/gemini-3.7-flash",
        p_input_hash: sha256hex(`call-${calls}`),
        p_source_last_message_id: lastMessageId,
        p_source_last_created_at: lastAt,
        p_message_count: 10,
        p_user_message_count: 5,
      }),
      "reserve",
    ) as Array<{ result: string }>;
    return rows[0].result;
  }

  // A conversation whose last succeeded run ended at the cursor message.
  async function conversationWithCursor(prefix: string, cursorAt: string): Promise<string> {
    const conversationId = await createConversation(client, userId);
    const cursorId = messageId(prefix, 0);
    await addMessages(client, conversationId, [{ id: cursorId, at: cursorAt }]);
    const inputHash = sha256hex(`seed-${prefix}`);
    await must(client.from("memory_v3_lifecycle_shadow_identities").insert({
      user_id: userId, conversation_id: conversationId, pipeline_version: PIPELINE, input_hash: inputHash,
    }), "seed identity");
    await must(client.from("memory_v3_lifecycle_shadow_runs").insert({
      user_id: userId, conversation_id: conversationId, pipeline_version: PIPELINE, input_hash: inputHash,
      extractor_version: "e", reconciler_version: "r", model: "google/gemini-3.7-flash", status: "succeeded",
      source_last_message_id: cursorId, source_last_created_at: cursorAt,
      message_count: 1, user_message_count: 1, expected_state_revision: 0, resulting_state_revision: 0,
      extraction: {}, operations: {}, transitions: {}, item_count: 0, evidence_count: 0, transition_count: 0,
      completed_at: new Date().toISOString(),
    }), "seed succeeded run");
    return conversationId;
  }

  it("lets a conversation with no succeeded run yet through (first run)", async () => {
    const conversationId = await createConversation(client, userId);
    await addMessages(client, conversationId, [{ id: messageId("a1000001", 1), at: T0 }]);
    assert.equal(await reserve(conversationId, messageId("a1000001", 1), T0), "reserved");
  });

  it("holds the run back until 10 new messages exist, then opens it", async () => {
    const prefix = "a1000002";
    const conversationId = await conversationWithCursor(prefix, T0);
    await addMessages(client, conversationId,
      Array.from({ length: 9 }, (_, i) => ({ id: messageId(prefix, i + 1), at: at(i + 1) })));
    assert.equal(await reserve(conversationId, messageId(prefix, 9), at(9)), "daily_cap", "9 new messages are not enough");
    await addMessages(client, conversationId, [{ id: messageId(prefix, 10), at: at(10) }]);
    assert.equal(await reserve(conversationId, messageId(prefix, 10), at(10)), "reserved", "the 10th new message opens the gate");
  });

  it("counts messages that share the cursor's timestamp but have a larger id (migration 078)", async () => {
    const prefix = "a1000003";
    const conversationId = await conversationWithCursor(prefix, T0);
    // 8 messages strictly after the cursor + 2 sharing its exact timestamp with larger ids = 10 by
    // (created_at, id) order, but only 8 by timestamp alone.
    await addMessages(client, conversationId, [
      ...Array.from({ length: 8 }, (_, i) => ({ id: messageId(prefix, i + 1), at: at(i + 1) })),
      { id: messageId(prefix, 51), at: T0 },
      { id: messageId(prefix, 52), at: T0 },
    ]);
    assert.equal(await reserve(conversationId, messageId(prefix, 8), at(8)), "reserved");
  });

  it("does not count messages at the cursor's timestamp with a smaller id", async () => {
    const prefix = "a1000004";
    const conversationId = await createConversation(client, userId);
    // The cursor sits at id 50; id 40 shares its timestamp but comes BEFORE it.
    const cursorId = messageId(prefix, 50);
    await addMessages(client, conversationId, [{ id: cursorId, at: T0 }, { id: messageId(prefix, 40), at: T0 }]);
    const inputHash = sha256hex(`seed-${prefix}`);
    await must(client.from("memory_v3_lifecycle_shadow_identities").insert({
      user_id: userId, conversation_id: conversationId, pipeline_version: PIPELINE, input_hash: inputHash,
    }), "seed identity");
    await must(client.from("memory_v3_lifecycle_shadow_runs").insert({
      user_id: userId, conversation_id: conversationId, pipeline_version: PIPELINE, input_hash: inputHash,
      extractor_version: "e", reconciler_version: "r", model: "google/gemini-3.7-flash", status: "succeeded",
      source_last_message_id: cursorId, source_last_created_at: T0,
      message_count: 1, user_message_count: 1, expected_state_revision: 0, resulting_state_revision: 0,
      extraction: {}, operations: {}, transitions: {}, item_count: 0, evidence_count: 0, transition_count: 0,
      completed_at: new Date().toISOString(),
    }), "seed succeeded run");
    await addMessages(client, conversationId,
      Array.from({ length: 9 }, (_, i) => ({ id: messageId(prefix, 60 + i), at: at(i + 1) })));
    // 9 after the cursor; the earlier-id message at the same timestamp must not make it 10.
    assert.equal(await reserve(conversationId, messageId(prefix, 68), at(9)), "daily_cap");
  });
});
