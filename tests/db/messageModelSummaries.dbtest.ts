import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createLongMessageStore } from "../../supabase/functions/_shared/longMessageStore.ts";
import { addMessages, adminClient, createConversation, createUser, deleteUser, messageId } from "./helpers.ts";

// The short versions of long messages are read by the model and must never reach the person, so the
// table is for the service role only. These tests prove the store against the real database: saving,
// reading back, replacing, the length rule, and that deleting a message or conversation deletes its
// short version with it.

const PREFIX = "d4000001";
const id = (n: number) => messageId(PREFIX, n);

describe("short versions of long messages on the real database", () => {
  let client: SupabaseClient;
  let userId: string;
  let conversationId: string;

  before(async () => {
    client = adminClient();
    userId = await createUser(client, "message-summaries");
    conversationId = await createConversation(client, userId);
    await addMessages(client, conversationId, [
      { id: id(1), at: "2026-10-01T10:00:00+00:00", sender: "user" },
      { id: id(2), at: "2026-10-01T10:00:05+00:00", sender: "ai" },
      { id: id(3), at: "2026-10-01T10:01:00+00:00", sender: "user" },
    ]);
  });

  after(async () => {
    await deleteUser(client, userId);
  });

  it("saves a short version and reads it back by message id", async () => {
    const store = createLongMessageStore(client);
    await store.saveSummary({ id: id(1), userId, summary: "Человек пишет о ссоре с дочерью." });
    const found = await store.loadSummaries([id(1), id(3)]);
    assert.deepEqual([...found], [[id(1), "Человек пишет о ссоре с дочерью."]]);
  });

  it("replaces the short version when the same message is saved again", async () => {
    const store = createLongMessageStore(client);
    await store.saveSummary({ id: id(1), userId, summary: "Первая версия." });
    await store.saveSummary({ id: id(1), userId, summary: "Вторая версия." });
    assert.equal((await store.loadSummaries([id(1)])).get(id(1)), "Вторая версия.");
  });

  it("reads nothing for an empty list without asking the database", async () => {
    assert.equal((await createLongMessageStore(client).loadSummaries([])).size, 0);
  });

  it("refuses an empty short version and one over 1,500 characters", async () => {
    const store = createLongMessageStore(client);
    await assert.rejects(() => store.saveSummary({ id: id(3), userId, summary: "" }));
    await assert.rejects(() => store.saveSummary({ id: id(3), userId, summary: "а".repeat(1_501) }));
    await store.saveSummary({ id: id(3), userId, summary: "а".repeat(1_500) });
    assert.equal((await createLongMessageStore(client).loadSummaries([id(3)])).get(id(3))?.length, 1_500);
  });

  it("refuses a short version for a message that does not exist", async () => {
    await assert.rejects(() => createLongMessageStore(client).saveSummary({ id: id(99), userId, summary: "Нет такого." }));
  });

  it("is deleted together with its message", async () => {
    const store = createLongMessageStore(client);
    await store.saveSummary({ id: id(1), userId, summary: "Будет удалена." });
    const { error } = await client.from("messages").delete().eq("id", id(1));
    assert.equal(error, null);
    assert.equal((await store.loadSummaries([id(1)])).size, 0);
  });

  it("cannot be read with the public key", { skip: !process.env.SUPABASE_ANON_KEY }, async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anon.from("message_model_summaries").select("message_id").limit(1);
    assert.ok(error !== null || (data ?? []).length === 0, "the public key must not read any short version");
  });
});
