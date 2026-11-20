import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { adminClient, deleteUser, sha256hex } from "./helpers.ts";

// Migration 099: the cost of a call is never lost. A deleted account (any way it goes) and a deleted room leave their cost rows behind,
// cut loose from the person and marked as deleted; a call made outside the app is a row with no person at all. The admin panel counts all
// three. All people, e-mails and numbers are made up.

const hasAnon = Boolean(process.env.SUPABASE_ANON_KEY);

describe("costs are kept on the real database", () => {
  let admin: SupabaseClient;
  const created: string[] = [];
  const tags: string[] = [];

  before(() => {
    admin = adminClient();
  });

  after(async () => {
    for (const userId of created) await deleteUser(admin, userId);
    for (const tag of tags) await admin.from("ai_usage_logs").delete().eq("call_kind", tag);
  });

  function newTag(label: string): string {
    const tag = `keep-test-${label}-${sha256hex(`${Date.now()}-${Math.random()}`).slice(0, 8)}`;
    tags.push(tag);
    return tag;
  }

  async function newPerson(label: string) {
    const email = `db-test-keep-${label}-${sha256hex(`${Date.now()}-${Math.random()}`).slice(0, 10)}@example.invalid`;
    const password = `Pw-${sha256hex(`${Math.random()}`).slice(0, 16)}!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
    created.push(data.user.id);
    const profile = await admin.from("profiles").upsert({ id: data.user.id }, { onConflict: "id" }).select("id");
    if (profile.error) throw new Error(`profile: ${profile.error.message}`);
    return { userId: data.user.id, email, password };
  }

  async function addUsage(row: { userId: string | null; tag: string; cost: number; category?: "automatic" | "technical"; withTraces?: boolean }) {
    const result = await admin.from("ai_usage_logs").insert({
      user_id: row.userId,
      model: "fake/model",
      cost: row.cost,
      cost_category: row.category ?? "automatic",
      call_kind: row.tag,
      request_id: row.withTraces ? "req-should-not-survive" : null,
      error_code: row.withTraces ? "provider_error" : null,
      error_message: row.withTraces ? "the text the person had written" : null,
    });
    if (result.error) throw new Error(`usage: ${result.error.message}`);
  }

  async function rowsOf(tag: string) {
    const result = await admin.from("ai_usage_logs").select("*").eq("call_kind", tag);
    if (result.error) throw new Error(`rows: ${result.error.message}`);
    return result.data as Array<Record<string, unknown>>;
  }

  async function costs() {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const result = await admin.rpc("admin_costs", { p_since: since, p_until: until });
    if (result.error) throw new Error(`admin_costs: ${result.error.message}`);
    return result.data as {
      totals: { user_usd: number | string; technical_usd: number | string };
      by_kind: Array<{ cost_class: string; kind: string; calls: number; usd: number | string }>;
      by_person: Array<{ user_id: string | null; email: string | null; who: string; cost_class: string; usd: number | string }>;
    };
  }

  it("deleting an account keeps its cost, cut loose from the person, with the label it had", async () => {
    const tag = newTag("account");
    const person = await newPerson("account");
    const labelled = await admin.from("account_label_assignments").insert({ user_id: person.userId, label_key: "technical" });
    if (labelled.error) throw new Error(`label: ${labelled.error.message}`);
    await addUsage({ userId: person.userId, tag, cost: 1.25, withTraces: true });
    await addUsage({ userId: person.userId, tag, cost: 0.75 });

    await deleteUser(admin, person.userId);
    created.splice(created.indexOf(person.userId), 1);

    const rows = await rowsOf(tag);
    assert.equal(rows.length, 2, "both rows are still there");
    for (const row of rows) {
      assert.equal(row.user_id, null, "no person any more");
      assert.equal(row.conversation_id, null);
      assert.equal(row.request_id, null, "the provider's request id is gone");
      assert.equal(row.error_message, null, "the text of an error is gone");
      assert.ok(row.account_deleted_at, "marked as belonging to a deleted account");
      assert.equal(row.account_label_key, "technical", "the label the account had is kept as a word");
    }
    assert.equal(rows.reduce((sum, row) => sum + Number(row.cost), 0), 2, "the money is the same");
    assert.ok(rows.some((row) => row.error_code === "provider_error"), "the error code (not its text) stays");

    const result = await costs();
    const kind = result.by_kind.find((item) => item.kind === tag);
    assert.ok(kind, "the panel counts the deleted account's calls");
    assert.equal(kind.cost_class, "technical", "a deleted test account still counts as technical");
    assert.equal(Number(kind.usd), 2);
    const deleted = result.by_person.find((item) => item.who === "deleted" && item.cost_class === "technical");
    assert.ok(deleted && deleted.user_id === null && deleted.email === null, "the deleted accounts are one line without a person");
  });

  it("an account without a label is counted as user cost after it is deleted", async () => {
    const tag = newTag("plain");
    const person = await newPerson("plain");
    await addUsage({ userId: person.userId, tag, cost: 0.5 });
    await deleteUser(admin, person.userId);
    created.splice(created.indexOf(person.userId), 1);

    const kind = (await costs()).by_kind.find((item) => item.kind === tag);
    assert.ok(kind);
    assert.equal(kind.cost_class, "user");
    assert.equal((await rowsOf(tag))[0].account_label_key, "person");
  });

  it("a technical row stays technical even for a person with the default label", async () => {
    const tag = newTag("tech-row");
    const person = await newPerson("techrow");
    await addUsage({ userId: person.userId, tag, cost: 0.4, category: "technical" });
    await deleteUser(admin, person.userId);
    created.splice(created.indexOf(person.userId), 1);

    const kind = (await costs()).by_kind.find((item) => item.kind === tag);
    assert.ok(kind);
    assert.equal(kind.cost_class, "technical");
  });

  it("a call made outside the app is a row with no person, technical, and is not 'deleted'", async () => {
    const tag = newTag("offapp");
    await addUsage({ userId: null, tag, cost: 0.9, category: "technical" });

    const rows = await rowsOf(tag);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, null);
    assert.equal(rows[0].account_deleted_at, null, "not a deleted account");

    const result = await costs();
    assert.equal(result.by_kind.find((item) => item.kind === tag)?.cost_class, "technical");
    assert.ok(result.by_person.some((item) => item.who === "off_app" && item.user_id === null), "its own line, apart from the deleted accounts");
  });

  it("the helper that cuts the cost loose cannot be called by a person or by the public key", { skip: !hasAnon }, async () => {
    const person = await newPerson("closed");
    const signed = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const login = await signed.auth.signInWithPassword({ email: person.email, password: person.password });
    if (login.error) throw new Error(`sign in: ${login.error.message}`);
    const mine = await signed.rpc("_keep_usage_costs", { p_user_id: person.userId });
    assert.ok(mine.error, "a signed-in person must be refused");

    const anon = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const theirs = await anon.rpc("_keep_usage_costs", { p_user_id: person.userId });
    assert.ok(theirs.error, "the public key must be refused");
  });

  it("deleting the room keeps the cost too (cut loose at once, not at the purge)", { skip: !hasAnon }, async () => {
    const tag = newTag("room");
    const person = await newPerson("room");
    await addUsage({ userId: person.userId, tag, cost: 0.6, withTraces: true });

    const signed = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const login = await signed.auth.signInWithPassword({ email: person.email, password: person.password });
    if (login.error) throw new Error(`sign in: ${login.error.message}`);
    const asked = await signed.rpc("request_room_deletion");
    if (asked.error) throw new Error(`request_room_deletion: ${asked.error.message}`);

    const rows = await rowsOf(tag);
    assert.equal(rows.length, 1, "the row is not deleted with the room");
    assert.equal(rows[0].user_id, null);
    assert.ok(rows[0].account_deleted_at);
    assert.equal(rows[0].error_message, null);
    assert.equal(Number(rows[0].cost), 0.6);
    assert.equal(rows[0].account_label_key, "person");
  });
});
