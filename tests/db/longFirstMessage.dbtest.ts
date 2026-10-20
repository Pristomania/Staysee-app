import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { runMemoryV3DialogueShadow } from "../../supabase/functions/_shared/memoryV3/dialogueShadowRunner.ts";
import { createMemoryV3DialogueStore } from "../../supabase/functions/_shared/memoryV3/dialogueStore.ts";
import { runMemoryV3LifecycleShadow } from "../../supabase/functions/_shared/memoryV3/lifecycleShadowRunner.ts";
import { createMemoryV3LifecycleStore } from "../../supabase/functions/_shared/memoryV3/lifecycleStore.ts";
import { createMemoryV3MessageLoader } from "../../supabase/functions/_shared/memoryV3/messages.ts";
import { adminClient, createConversation, createUser, deleteUser } from "./helpers.ts";

// A message may be up to 10,000 characters, but the first memory run of a conversation could read only
// about 7,000 Russian characters in one go (the instruction takes 6 KB of the 20 KB request cap), so a
// longer first message made the run fail with invalid_source and raised an alert. These tests send a
// 9,500-character first message through the real loader and store and expect the run to succeed.

const EMPTY_EXTRACTION = JSON.stringify({
  layerDecisions: [
    { kind: "event", decision: "omit", itemRefs: [] },
    { kind: "recurrence", decision: "omit", itemRefs: [] },
    { kind: "hypothesis", decision: "omit", itemRefs: [] },
  ],
  items: [],
  evidence: [],
});
const BIG = "Я люблю утренние прогулки. ".repeat(350);
const failIfReconcilerRuns = () => async () => {
  throw new Error("the reconciler must not run for an empty extraction");
};

describe("a 9,500-character first message on the real database", () => {
  let client: SupabaseClient;
  let userId: string;

  before(async () => {
    client = adminClient();
    userId = await createUser(client, "long-first-message");
  });

  after(async () => {
    await deleteUser(client, userId);
  });

  async function conversationWithBigMessage(): Promise<string> {
    const conversationId = await createConversation(client, userId);
    const { error } = await client.from("messages").insert([
      { id: randomUUID(), conversation_id: conversationId, sender: "user", content: BIG, created_at: "2026-10-01T10:00:00+00:00" },
      { id: randomUUID(), conversation_id: conversationId, sender: "ai", content: "Я слышу тебя.", created_at: "2026-10-01T10:00:05+00:00" },
    ]);
    if (error) throw new Error(error.message);
    return conversationId;
  }

  async function runCount(table: string, conversationId: string, status: string) {
    const { data, error } = await client.from(table).select("id").eq("conversation_id", conversationId).eq("status", status);
    if (error) throw new Error(error.message);
    return (data ?? []).length;
  }

  for (const pipeline of [
    {
      name: "dialogue",
      table: "memory_v3_dialogue_runs",
      run: (conversationId: string, requests: unknown[]) => runMemoryV3DialogueShadow({
        userId,
        conversationId,
        apiKey: "test-key",
        loadMessages: createMemoryV3MessageLoader(client as never),
        store: createMemoryV3DialogueStore(client as never),
        extractorAdapterFactory: () => async (request: unknown) => {
          requests.push(request);
          return { content: EMPTY_EXTRACTION, usage: null };
        },
        reconcilerAdapterFactory: failIfReconcilerRuns,
      } as never),
    },
    {
      name: "lifecycle",
      table: "memory_v3_lifecycle_shadow_runs",
      run: (conversationId: string, requests: unknown[]) => runMemoryV3LifecycleShadow({
        rawMode: "lifecycle_shadow",
        rawAllowedUserId: userId,
        userId,
        conversationId,
        apiKey: "test-key",
        loadMessages: createMemoryV3MessageLoader(client as never),
        store: createMemoryV3LifecycleStore(client as never),
        extractorAdapterFactory: () => async (request: unknown) => {
          requests.push(request);
          return { content: EMPTY_EXTRACTION, usage: null };
        },
        reconcilerAdapterFactory: failIfReconcilerRuns,
      } as never),
    },
  ]) {
    it(`${pipeline.name}: reads it in pieces and the run succeeds`, async () => {
      const conversationId = await conversationWithBigMessage();
      const requests: unknown[] = [];
      const original = console.warn;
      console.warn = () => {};
      let result: { status: string; diagnosticCode?: string };
      try {
        result = await pipeline.run(conversationId, requests) as { status: string; diagnosticCode?: string };
      } finally {
        console.warn = original;
      }
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(requests.length > 1, true, "more than one piece was read");
      assert.equal(await runCount(pipeline.table, conversationId, "succeeded"), 1);
      assert.equal(await runCount(pipeline.table, conversationId, "failed"), 0);
    });
  }
});
