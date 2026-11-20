import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { adminClient, deleteUser, sha256hex } from "./helpers.ts";

// Thumbs under an answer of Stacy (migration 095), on the real database: one mark per answer; changing one's mind keeps only the
// new mark (the old one and its note are not kept); a person marks only their own answers of Stacy and sees only their own marks.
// All texts here are made up.

const hasAnon = Boolean(process.env.SUPABASE_ANON_KEY);

describe("feedback on the answers of Stacy on the real database", { skip: !hasAnon && "SUPABASE_ANON_KEY is not set" }, () => {
  let admin: SupabaseClient;
  const created: string[] = [];

  before(() => {
    admin = adminClient();
  });

  after(async () => {
    for (const userId of created) await deleteUser(admin, userId);
  });

  async function newPerson(label: string) {
    const email = `db-test-msgfb-${label}-${sha256hex(`${Date.now()}-${Math.random()}`).slice(0, 10)}@example.invalid`;
    const password = `Pw-${sha256hex(`${Math.random()}`).slice(0, 16)}!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
    const userId = data.user.id;
    created.push(userId);
    const profile = await admin.from("profiles").upsert({ id: userId }, { onConflict: "id" }).select("id");
    if (profile.error) throw new Error(`profile: ${profile.error.message}`);
    const lifted = await admin.from("user_usage_tiers").upsert({ user_id: userId, max_conversations_override: 100 }, { onConflict: "user_id" }).select("user_id");
    if (lifted.error) throw new Error(`lift limit: ${lifted.error.message}`);
    const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error(`sign in: ${signedIn.error.message}`);
    const conversation = await admin.from("conversations").insert({ user_id: userId }).select("id");
    if (conversation.error || !conversation.data?.[0]) throw new Error(`conversation: ${conversation.error?.message}`);
    const conversationId = (conversation.data[0] as { id: string }).id;
    const answer = await admin.from("messages").insert({ conversation_id: conversationId, sender: "ai", content: "Вымышленный ответ Стейси." }).select("id");
    if (answer.error || !answer.data?.[0]) throw new Error(`answer: ${answer.error?.message}`);
    const question = await admin.from("messages").insert({ conversation_id: conversationId, sender: "user", content: "Вымышленная реплика." }).select("id");
    if (question.error || !question.data?.[0]) throw new Error(`question: ${question.error?.message}`);
    return {
      userId,
      client,
      conversationId,
      answerId: (answer.data[0] as { id: string }).id,
      questionId: (question.data[0] as { id: string }).id,
    };
  }

  it("changing one's mind leaves only the new mark: the old one is not kept, and the note of the old one goes", async () => {
    const a = await newPerson("flip");
    const down = await a.client.from("message_feedback").insert({ conversation_id: a.conversationId, message_id: a.answerId, rating: -1 });
    assert.equal(down.error, null, down.error?.message);
    const noted = await a.client.from("message_feedback").update({ comment: "Вымышленная заметка к «плохо»." }).eq("message_id", a.answerId);
    assert.equal(noted.error, null);

    const up = await a.client.from("message_feedback").update({ rating: 1, comment: null }).eq("message_id", a.answerId);
    assert.equal(up.error, null);
    const rows = await admin.from("message_feedback").select("rating, comment").eq("user_id", a.userId);
    assert.deepEqual(rows.data, [{ rating: 1, comment: null }], "one row, the new mark, no old note");
    const review = await admin.from("message_feedback_review").select("verdict").eq("user_id", a.userId);
    assert.deepEqual(review.data, [{ verdict: "хорошо" }], "the owner sees one verdict: the last one");

    const back = await a.client.from("message_feedback").update({ rating: -1, comment: null }).eq("message_id", a.answerId);
    assert.equal(back.error, null);
    const again = await admin.from("message_feedback_review").select("verdict").eq("user_id", a.userId);
    assert.deepEqual(again.data, [{ verdict: "плохо" }], "and the other way round");
  });

  it("only an answer of Stacy can be marked, and only one's own", async () => {
    const a = await newPerson("own");
    const b = await newPerson("other");
    const question = await a.client.from("message_feedback").insert({ conversation_id: a.conversationId, message_id: a.questionId, rating: 1 });
    assert.ok(question.error, "marking a message of the person must be refused");
    const foreign = await b.client.from("message_feedback").insert({ conversation_id: a.conversationId, message_id: a.answerId, rating: 1 });
    assert.ok(foreign.error, "marking an answer of someone else must be refused");

    const mine = await a.client.from("message_feedback").insert({ conversation_id: a.conversationId, message_id: a.answerId, rating: 1 });
    assert.equal(mine.error, null);
    const seenByOther = await b.client.from("message_feedback").select("rating").eq("message_id", a.answerId);
    assert.deepEqual(seenByOther.data, [], "the marks of someone else are not visible");
    const second = await a.client.from("message_feedback").insert({ conversation_id: a.conversationId, message_id: a.answerId, rating: -1 });
    assert.equal(second.error?.code, "23505", "one mark per answer");
  });
});
