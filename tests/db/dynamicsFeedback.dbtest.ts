import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { adminClient, deleteUser, sha256hex } from "./helpers.ts";

// Thumbs on the weekly "Динамика" (migration 096): a person marks only their own weekly dynamics, sees and changes only their own
// marks (the mark and the note, never the dynamics a row points at), and the feedback goes with the dynamics, the conversation and
// the account. The owner's view is for the service key only. All texts here are made up.

const hasAnon = Boolean(process.env.SUPABASE_ANON_KEY);

describe("feedback on the weekly dynamics on the real database", { skip: !hasAnon && "SUPABASE_ANON_KEY is not set" }, () => {
  let admin: SupabaseClient;
  const created: string[] = [];

  before(() => {
    admin = adminClient();
  });

  after(async () => {
    for (const userId of created) await deleteUser(admin, userId);
  });

  async function newPerson(label: string) {
    const email = `db-test-dynfb-${label}-${sha256hex(`${Date.now()}-${Math.random()}`).slice(0, 10)}@example.invalid`;
    const password = `Pw-${sha256hex(`${Math.random()}`).slice(0, 16)}!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
    const userId = data.user.id;
    created.push(userId);
    // The table hangs on profiles. In production the app creates the profile row when a person signs in; some databases also have
    // a trigger that does it. Either way, make sure the row is there.
    const profile = await admin.from("profiles").upsert({ id: userId }, { onConflict: "id" }).select("id");
    if (profile.error) throw new Error(`profile: ${profile.error.message}`);
    // The weekly dynamics is a paid feature: since the conversation locks (migration 103) a weekly entry is visible only to a person with
    // paid features (a basic or premium plan), so the person here is a premium one with a hand-set room limit, like the owner's accounts.
    const lifted = await admin.from("user_usage_tiers").upsert({ user_id: userId, tier: "premium", max_conversations_override: 100 }, { onConflict: "user_id" }).select("user_id");
    if (lifted.error) throw new Error(`lift limit: ${lifted.error.message}`);
    const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error(`sign in: ${signedIn.error.message}`);
    const conversation = await admin.from("conversations").insert({ user_id: userId }).select("id");
    if (conversation.error || !conversation.data?.[0]) throw new Error(`conversation: ${conversation.error?.message}`);
    const conversationId = (conversation.data[0] as { id: string }).id;
    const weekly = await admin
      .from("progress_entries")
      .insert({ user_id: userId, conversation_id: conversationId, entry_type: "weekly", content: "Вымышленная динамика недели." })
      .select("id");
    if (weekly.error || !weekly.data?.[0]) throw new Error(`weekly: ${weekly.error?.message}`);
    const note = await admin
      .from("progress_entries")
      .insert({ user_id: userId, conversation_id: conversationId, entry_type: "note", content: "Вымышленная записка." })
      .select("id");
    if (note.error || !note.data?.[0]) throw new Error(`note: ${note.error?.message}`);
    return {
      userId,
      client,
      conversationId,
      weeklyId: (weekly.data[0] as { id: string }).id,
      noteId: (note.data[0] as { id: string }).id,
    };
  }

  it("a person can mark their own weekly dynamics, change the mark, add a note and take the mark back", async () => {
    const a = await newPerson("own");
    const added = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1 });
    assert.equal(added.error, null, added.error?.message);

    const changed = await a.client.from("dynamics_feedback").update({ rating: -1, comment: "Вымышленная заметка." }).eq("entry_id", a.weeklyId);
    assert.equal(changed.error, null, changed.error?.message);

    const read = await a.client.from("dynamics_feedback").select("rating, comment").eq("entry_id", a.weeklyId);
    assert.deepEqual(read.data, [{ rating: -1, comment: "Вымышленная заметка." }]);

    const removed = await a.client.from("dynamics_feedback").delete().eq("entry_id", a.weeklyId);
    assert.equal(removed.error, null);
    const after = await a.client.from("dynamics_feedback").select("rating").eq("entry_id", a.weeklyId);
    assert.deepEqual(after.data, []);
  });

  it("changing one's mind leaves only the new mark: the old one is not kept, and the note of the old one goes", async () => {
    const a = await newPerson("flip");
    const down = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: -1 });
    assert.equal(down.error, null);
    const noted = await a.client.from("dynamics_feedback").update({ comment: "Вымышленная заметка к «не понравилось»." }).eq("entry_id", a.weeklyId);
    assert.equal(noted.error, null);

    // What the app sends when the other thumb is pressed: the new mark and no note.
    const up = await a.client.from("dynamics_feedback").update({ rating: 1, comment: null }).eq("entry_id", a.weeklyId);
    assert.equal(up.error, null);
    const rows = await admin.from("dynamics_feedback").select("rating, comment").eq("user_id", a.userId);
    assert.deepEqual(rows.data, [{ rating: 1, comment: null }], "one row, the new mark, no old note");
    const review = await admin.from("dynamics_feedback_review").select("verdict").eq("user_id", a.userId);
    assert.deepEqual(review.data, [{ verdict: "хорошо" }], "the owner sees one verdict: the last one");

    const back = await a.client.from("dynamics_feedback").update({ rating: -1, comment: null }).eq("entry_id", a.weeklyId);
    assert.equal(back.error, null);
    const again = await admin.from("dynamics_feedback_review").select("verdict").eq("user_id", a.userId);
    assert.deepEqual(again.data, [{ verdict: "плохо" }], "and the other way round");
  });

  it("one mark per dynamics: a second insert is a unique violation", async () => {
    const a = await newPerson("unique");
    const first = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1 });
    assert.equal(first.error, null);
    const second = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: -1 });
    assert.equal(second.error?.code, "23505");
  });

  it("only a weekly dynamics can be marked, not a note of the same person", async () => {
    const a = await newPerson("note");
    const result = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.noteId, rating: 1 });
    assert.ok(result.error, "marking a note must be refused");
  });

  it("nobody can mark, read, change or remove the marks of someone else", async () => {
    const a = await newPerson("alice");
    const b = await newPerson("bob");
    const mine = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1 });
    assert.equal(mine.error, null);

    const intoOther = await b.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: -1 });
    assert.ok(intoOther.error, "marking the dynamics of someone else must be refused");

    const mixed = await b.client.from("dynamics_feedback").insert({ conversation_id: b.conversationId, entry_id: a.weeklyId, rating: -1 });
    assert.ok(mixed.error, "own conversation with someone else's dynamics must be refused");

    const seen = await b.client.from("dynamics_feedback").select("rating").eq("entry_id", a.weeklyId);
    assert.deepEqual(seen.data, [], "the marks of someone else are not visible");

    await b.client.from("dynamics_feedback").update({ rating: -1 }).eq("entry_id", a.weeklyId);
    await b.client.from("dynamics_feedback").delete().eq("entry_id", a.weeklyId);
    const still = await admin.from("dynamics_feedback").select("rating").eq("entry_id", a.weeklyId);
    assert.deepEqual(still.data, [{ rating: 1 }], "the mark of the owner is untouched");
  });

  it("a person can change only the mark and the note: not the dynamics, the conversation or the owner of a row", async () => {
    const a = await newPerson("columns");
    const other = await newPerson("columns-other");
    const added = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1 });
    assert.equal(added.error, null);
    for (const patch of [{ entry_id: other.weeklyId }, { conversation_id: other.conversationId }, { user_id: other.userId }]) {
      const result = await a.client.from("dynamics_feedback").update(patch).eq("entry_id", a.weeklyId);
      assert.ok(result.error, `${Object.keys(patch)[0]} must not be changeable`);
    }
  });

  it("the mark is 1 or -1 and the note is not empty and at most 1000 characters", async () => {
    const a = await newPerson("limits");
    const bad = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 2 });
    assert.ok(bad.error, "rating 2 must be refused");
    const empty = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1, comment: "" });
    assert.ok(empty.error, "an empty note must be refused (it is stored as nothing)");
    const long = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1, comment: "я".repeat(1001) });
    assert.ok(long.error, "a note over 1000 characters must be refused");
  });

  it("the owner's view is closed to people and open to the service key, and shows the dynamics", async () => {
    const a = await newPerson("view");
    const added = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: -1, comment: "Вымышленная заметка." });
    assert.equal(added.error, null);

    const byPerson = await a.client.from("dynamics_feedback_review").select("*");
    assert.ok(byPerson.error || (byPerson.data ?? []).length === 0, "a person must not read the owner's view");

    const byService = await admin.from("dynamics_feedback_review").select("verdict, comment, dynamics_excerpt").eq("entry_id", a.weeklyId);
    assert.equal(byService.error, null, byService.error?.message);
    assert.deepEqual(byService.data, [{ verdict: "плохо", comment: "Вымышленная заметка.", dynamics_excerpt: "Вымышленная динамика недели." }]);
  });

  it("the feedback goes with the dynamics, and with the conversation", async () => {
    const a = await newPerson("cascade");
    const added = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1 });
    assert.equal(added.error, null);

    const removedEntry = await admin.from("progress_entries").delete().eq("id", a.weeklyId);
    assert.equal(removedEntry.error, null);
    const afterEntry = await admin.from("dynamics_feedback").select("id").eq("user_id", a.userId);
    assert.deepEqual(afterEntry.data, [], "the mark must go with its dynamics");

    const secondWeekly = await admin.from("progress_entries").insert({ user_id: a.userId, conversation_id: a.conversationId, entry_type: "weekly", content: "Вторая вымышленная динамика." }).select("id");
    const secondId = (secondWeekly.data?.[0] as { id: string }).id;
    const again = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: secondId, rating: 1 });
    assert.equal(again.error, null);
    const removedConversation = await admin.from("conversations").delete().eq("id", a.conversationId);
    assert.equal(removedConversation.error, null);
    const afterConversation = await admin.from("dynamics_feedback").select("id").eq("user_id", a.userId);
    assert.deepEqual(afterConversation.data, [], "the mark must go with its conversation");
  });

  it("the content wipe of an account lists the table, so a wipe leaves no feedback behind", async () => {
    const a = await newPerson("wipe");
    const added = await a.client.from("dynamics_feedback").insert({ conversation_id: a.conversationId, entry_id: a.weeklyId, rating: 1 });
    assert.equal(added.error, null);
    // The helper itself is closed to every role (migration 103 also closed it to the service key); the person's own call goes through it.
    const wiped = await a.client.rpc("delete_my_account_data");
    assert.equal(wiped.error, null, wiped.error?.message);
    const left = await admin.from("dynamics_feedback").select("id").eq("user_id", a.userId);
    assert.deepEqual(left.data, []);
  });
});
