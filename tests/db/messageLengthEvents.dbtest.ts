import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { recordLongMessageEvent } from "../../supabase/functions/_shared/longMessageStore.ts";
import { addMessages, adminClient, createConversation, deleteUser, messageId, sha256hex } from "./helpers.ts";

// A log of how often messages are long and how often people hit the 10,000-character limit, with only the
// length and the time, never the text. It exists to answer, over the months, whether the limit should grow.

const PREFIX = "e5000001";
const id = (n: number) => messageId(PREFIX, n);
const hasAnon = Boolean(process.env.SUPABASE_ANON_KEY);

describe("message length events on the real database", () => {
  let admin: SupabaseClient;
  let userId: string;
  let signedIn: SupabaseClient | null = null;

  before(async () => {
    admin = adminClient();
    const email = `db-test-length-${sha256hex(`${Date.now()}-${Math.random()}`).slice(0, 12)}@example.invalid`;
    const password = `Pw-${sha256hex(`${Math.random()}`).slice(0, 16)}!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
    userId = data.user.id;
    if (hasAnon) {
      signedIn = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: signInError } = await signedIn.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(`sign in: ${signInError.message}`);
    }
    const conversationId = await createConversation(admin, userId);
    await addMessages(admin, conversationId, [
      { id: id(1), at: new Date(Date.now() - 60_000).toISOString(), sender: "user" },
    ]);
    await admin.from("messages").update({ content: "а".repeat(4_500) }).eq("id", id(1));
  });

  after(async () => {
    await deleteUser(admin, userId);
  });

  async function events(kind: string) {
    const { data, error } = await admin
      .from("message_length_events")
      .select("kind, char_count")
      .eq("user_id", userId)
      .eq("kind", kind)
      .order("id", { ascending: true });
    if (error) throw new Error(error.message);
    return data as Array<{ kind: string; char_count: number }>;
  }

  it("records a long message by its length only", async () => {
    await recordLongMessageEvent(admin, userId, 4_321);
    assert.deepEqual(await events("long_message"), [{ kind: "long_message", char_count: 4_321 }]);
    const { data } = await admin.from("message_length_events").select("*").eq("user_id", userId).limit(1);
    assert.deepEqual(Object.keys(data?.[0] ?? {}).sort(), ["char_count", "created_at", "id", "kind", "user_id"]);
  });

  it("never fails the caller when the event cannot be saved", async () => {
    await recordLongMessageEvent(admin, "00000000-0000-4000-8000-000000000000", 5_000);
    await recordLongMessageEvent(admin, userId, -5);
  });

  it("lets a signed-in person report that they went over the limit, once per ten seconds", { skip: !hasAnon }, async () => {
    const first = await (signedIn as SupabaseClient).rpc("record_over_limit_hit", { p_char_count: 12_345 });
    assert.equal(first.error, null);
    const second = await (signedIn as SupabaseClient).rpc("record_over_limit_hit", { p_char_count: 13_000 });
    assert.equal(second.error, null, "a repeat inside ten seconds is ignored, not an error");
    assert.deepEqual(await events("over_limit"), [{ kind: "over_limit", char_count: 12_345 }]);
  });

  it("refuses a report that is not over the limit, and a report from nobody signed in", { skip: !hasAnon }, async () => {
    const small = await (signedIn as SupabaseClient).rpc("record_over_limit_hit", { p_char_count: 10_000 });
    assert.notEqual(small.error, null);
    const anon = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const nobody = await anon.rpc("record_over_limit_hit", { p_char_count: 20_000 });
    assert.notEqual(nobody.error, null);
  });

  it("is not readable by a signed-in person", { skip: !hasAnon }, async () => {
    const { data, error } = await (signedIn as SupabaseClient).from("message_length_events").select("id").limit(1);
    assert.ok(error !== null || (data ?? []).length === 0);
  });

  it("answers a report of how long messages are, for the service role only", async () => {
    const { data, error } = await admin.rpc("long_message_stats", { p_days: 30 });
    assert.equal(error, null);
    const stats = data as Record<string, number>;
    assert.ok(stats.user_messages >= 1);
    assert.ok(stats.over_4000 >= 1, "the 4,500-character message counts");
    assert.ok(stats.max_length >= 4_500);
    assert.ok(stats.long_message_events >= 1);
    assert.ok(stats.long_message_users >= 1);
    for (const key of ["days", "over_1000", "over_8000", "over_limit_events", "over_limit_users", "over_limit_max", "summaries_made"]) {
      assert.ok(key in stats, `missing ${key}`);
    }
    if (hasAnon) {
      const denied = await (signedIn as SupabaseClient).rpc("long_message_stats", { p_days: 30 });
      assert.notEqual(denied.error, null);
    }
  });
});
