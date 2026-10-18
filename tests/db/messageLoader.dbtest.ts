import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createMemoryV3MessageLoader } from "../../supabase/functions/_shared/memoryV3/messages.ts";
import { adminClient, addMessages, createConversation, createUser, deleteUser, messageId } from "./helpers.ts";

// The delta loader filters with a PostgREST keyset string,
// created_at.gt."T",and(created_at.eq."T",id.gt.X). The offline suite can only
// check the string; this proves the real PostgREST + Postgres read it as the
// row comparison (created_at, id) > (T, X), including microsecond timestamps.

const PREFIX = "b2000001";
const id = (n: number) => messageId(PREFIX, n);
const LAST = 74;

describe("Memory V3 message loader on real PostgREST", () => {
  let client: SupabaseClient;
  let userId: string;
  let conversationId: string;

  // Messages 1..74 in strictly non-decreasing (created_at, id) order.
  // 2 and 3 share a microsecond timestamp (a tie at the cursor); 10 and 11
  // share another (a tie inside the delta).
  const timestampOf = (n: number): string => {
    if (n === 1) return "2026-10-01T10:00:00.000001+00:00";
    if (n === 2 || n === 3) return "2026-10-01T10:00:01.123456+00:00";
    if (n === 11) return timestampOf(10);
    return new Date(Date.parse("2026-10-01T10:00:00Z") + n * 1000).toISOString().replace(".000Z", "+00:00");
  };

  before(async () => {
    client = adminClient();
    userId = await createUser(client, "message-loader");
    conversationId = await createConversation(client, userId);
    await addMessages(client, conversationId,
      Array.from({ length: LAST }, (_, i) => ({ id: id(i + 1), at: timestampOf(i + 1), sender: (i + 1) % 2 === 0 ? "ai" as const : "user" as const })));
  });

  after(async () => {
    await deleteUser(client, userId);
  });

  async function cursorFor(n: number) {
    const { data, error } = await client.from("messages").select("id, created_at").eq("id", id(n)).single();
    if (error) throw error;
    return { messageId: data.id as string, createdAt: data.created_at as string };
  }

  async function window(n: number) {
    const load = createMemoryV3MessageLoader(client as never);
    return await load(userId, conversationId, await cursorFor(n)) as unknown as {
      context: Array<{ id: string }>; delta: Array<{ id: string }>; latestMessageId: string;
    };
  }

  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => id(from + i));

  it("returns the 55 oldest messages after the cursor, oldest first, never the cursor itself", async () => {
    const win = await window(15);
    // 59 messages follow message 15; only the 55 oldest are returned, the rest wait for the next run.
    assert.deepEqual(win.delta.map((m) => m.id), range(16, 15 + 55));
    assert.equal(win.latestMessageId, id(LAST));
  });

  it("returns everything after the cursor when fewer than 55 follow it", async () => {
    const win = await window(60);
    assert.deepEqual(win.delta.map((m) => m.id), range(61, LAST));
  });

  it("includes a message that shares the cursor's microsecond timestamp but has a larger id", async () => {
    const win = await window(2);
    assert.equal(win.delta[0].id, id(3));
    assert.deepEqual(win.delta.map((m) => m.id), range(3, 2 + 55));
  });

  it("excludes both tie members when the cursor is the later one", async () => {
    const win = await window(3);
    assert.equal(win.delta[0].id, id(4));
  });

  it("orders a tie inside the delta by id", async () => {
    const win = await window(10);
    assert.equal(win.delta[0].id, id(11));
  });

  it("returns up to 5 context messages at or before the cursor, oldest first", async () => {
    assert.deepEqual((await window(2)).context.map((m) => m.id), [id(1), id(2)]);
    assert.deepEqual((await window(20)).context.map((m) => m.id), range(16, 20));
  });

  it("returns the plain last-60 window when no cursor is given", async () => {
    const load = createMemoryV3MessageLoader(client as never);
    const first = await load(userId, conversationId) as unknown as Array<{ id: string }>;
    assert.equal(first.length, 60);
  });
});
