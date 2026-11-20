import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { adminClient, deleteUser, sha256hex } from "./helpers.ts";

// The admin panel (migration 097, stage 1) on the real database: tables for admins, account labels and the audit log, and the SQL
// functions the edge function admin-api relays to. Everything here is closed to people and open to the service key only.
// All people, e-mails and numbers are made up.

const hasAnon = Boolean(process.env.SUPABASE_ANON_KEY);

describe("admin panel core on the real database", () => {
  let admin: SupabaseClient;
  const created: string[] = [];

  before(() => {
    admin = adminClient();
  });

  after(async () => {
    for (const userId of created) await deleteUser(admin, userId);
  });

  async function newPerson(label: string) {
    const email = `db-test-adm-${label}-${sha256hex(`${Date.now()}-${Math.random()}`).slice(0, 10)}@example.invalid`;
    const password = `Pw-${sha256hex(`${Math.random()}`).slice(0, 16)}!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
    const userId = data.user.id;
    created.push(userId);
    const profile = await admin.from("profiles").upsert({ id: userId }, { onConflict: "id" }).select("id");
    if (profile.error) throw new Error(`profile: ${profile.error.message}`);
    return { userId, email, password };
  }

  async function signedIn(email: string, password: string): Promise<SupabaseClient> {
    const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await client.auth.signInWithPassword({ email, password });
    if (result.error) throw new Error(`sign in: ${result.error.message}`);
    return client;
  }

  async function makeAdmin(userId: string) {
    const result = await admin.from("admin_users").insert({ user_id: userId });
    if (result.error) throw new Error(`make admin: ${result.error.message}`);
  }

  async function auditRows(targetUserId: string) {
    const result = await admin.from("admin_audit_log").select("action, admin_id, target_user_id, details").eq("target_user_id", targetUserId);
    if (result.error) throw new Error(`audit: ${result.error.message}`);
    return result.data as Array<{ action: string; admin_id: string; target_user_id: string; details: { from: string | null; to: string } }>;
  }

  it("the seed labels exist with the cost class of the design", async () => {
    const labels = await admin.rpc("admin_list_labels");
    assert.equal(labels.error, null, labels.error?.message);
    const byKey = Object.fromEntries((labels.data as Array<{ key: string; title: string; cost_class: string }>).map((l) => [l.key, l]));
    assert.deepEqual(
      Object.keys(byKey).sort(),
      ["checker", "family", "owner", "person", "technical"],
    );
    assert.equal(byKey.person.title, "Человек");
    assert.equal(byKey.person.cost_class, "user");
    assert.equal(byKey.family.cost_class, "user");
    assert.equal(byKey.owner.cost_class, "technical");
    assert.equal(byKey.checker.cost_class, "technical");
    assert.equal(byKey.technical.cost_class, "technical");
  });

  it("setting a label writes the assignment and one audit row with the ids, never the e-mail", async () => {
    const boss = await newPerson("boss");
    const subject = await newPerson("subject");
    await makeAdmin(boss.userId);

    const done = await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: subject.userId, p_label_key: "technical" });
    assert.equal(done.error, null, done.error?.message);
    assert.deepEqual(done.data, { user_id: subject.userId, label_key: "technical", previous_label_key: null });

    const stored = await admin.from("account_label_assignments").select("label_key, assigned_by").eq("user_id", subject.userId);
    assert.deepEqual(stored.data, [{ label_key: "technical", assigned_by: boss.userId }]);

    const rows = await auditRows(subject.userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "set_label");
    assert.equal(rows[0]!.admin_id, boss.userId);
    assert.deepEqual(rows[0]!.details, { from: null, to: "technical" });
    assert.ok(!JSON.stringify(rows).includes("@"), "no e-mail address in the audit log");
  });

  it("setting a second label keeps one assignment and records from and to", async () => {
    const boss = await newPerson("boss2");
    const subject = await newPerson("subject2");
    await makeAdmin(boss.userId);
    await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: subject.userId, p_label_key: "family" });
    const second = await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: subject.userId, p_label_key: "owner" });
    assert.deepEqual(second.data, { user_id: subject.userId, label_key: "owner", previous_label_key: "family" });

    const stored = await admin.from("account_label_assignments").select("label_key").eq("user_id", subject.userId);
    assert.deepEqual(stored.data, [{ label_key: "owner" }]);
    const rows = await auditRows(subject.userId);
    assert.deepEqual(rows.map((r) => r.details), [{ from: null, to: "family" }, { from: "family", to: "owner" }]);
  });

  it("an unknown label, an unknown person and a caller who is not an admin fail cleanly and leave no audit row", async () => {
    const boss = await newPerson("boss3");
    const notAdmin = await newPerson("plain");
    const subject = await newPerson("subject3");
    await makeAdmin(boss.userId);

    const unknownLabel = await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: subject.userId, p_label_key: "no_such_label" });
    assert.match(unknownLabel.error?.message ?? "", /unknown_label/);

    const unknownPerson = await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: randomUUID(), p_label_key: "technical" });
    assert.match(unknownPerson.error?.message ?? "", /unknown_user/);

    const refused = await admin.rpc("admin_set_label", { p_admin_id: notAdmin.userId, p_user_id: subject.userId, p_label_key: "technical" });
    assert.match(refused.error?.message ?? "", /not_admin/);

    assert.deepEqual(await auditRows(subject.userId), []);
    const stored = await admin.from("account_label_assignments").select("label_key").eq("user_id", subject.userId);
    assert.deepEqual(stored.data, []);
  });

  it("admin_is_admin tells an admin from a person", async () => {
    const boss = await newPerson("boss4");
    const plain = await newPerson("plain4");
    await makeAdmin(boss.userId);
    const yes = await admin.rpc("admin_is_admin", { p_user_id: boss.userId });
    const no = await admin.rpc("admin_is_admin", { p_user_id: plain.userId });
    assert.equal(yes.data, true);
    assert.equal(no.data, false);
  });

  it("the audit log cannot be changed or deleted, even by the service key", async () => {
    const boss = await newPerson("boss5");
    const subject = await newPerson("subject5");
    await makeAdmin(boss.userId);
    await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: subject.userId, p_label_key: "technical" });

    const changed = await admin.from("admin_audit_log").update({ action: "tampered" }).eq("target_user_id", subject.userId);
    assert.ok(changed.error, "an update must be refused");
    const removed = await admin.from("admin_audit_log").delete().eq("target_user_id", subject.userId);
    assert.ok(removed.error, "a delete must be refused");
    assert.equal((await auditRows(subject.userId)).length, 1);
  });

  it("deleting a person removes the label assignment and the admin flag", async () => {
    const boss = await newPerson("boss6");
    await makeAdmin(boss.userId);
    await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: boss.userId, p_label_key: "owner" });

    await deleteUser(admin, boss.userId);
    created.splice(created.indexOf(boss.userId), 1);

    const flag = await admin.from("admin_users").select("user_id").eq("user_id", boss.userId);
    const assignment = await admin.from("account_label_assignments").select("user_id").eq("user_id", boss.userId);
    assert.deepEqual(flag.data, []);
    assert.deepEqual(assignment.data, []);
  });

  // ── Read functions (Task 2) ────────────────────────────────────────────────────────────────────────────

  async function personWithEmail(email: string) {
    const password = `Pw-${sha256hex(`${Math.random()}`).slice(0, 16)}!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
    created.push(data.user.id);
    const profile = await admin.from("profiles").upsert({ id: data.user.id }, { onConflict: "id" }).select("id");
    if (profile.error) throw new Error(`profile: ${profile.error.message}`);
    return data.user.id;
  }

  async function addUsage(userId: string, row: { cost: number; category: "automatic" | "technical"; kind?: string | null; at?: string; errorCode?: string; errorMessage?: string }) {
    const result = await admin.from("ai_usage_logs").insert({
      user_id: userId,
      model: "fake/model",
      cost: row.cost,
      cost_category: row.category,
      call_kind: row.kind ?? null,
      created_at: row.at ?? new Date().toISOString(),
      error_code: row.errorCode ?? null,
      error_message: row.errorMessage ?? null,
    });
    if (result.error) throw new Error(`usage: ${result.error.message}`);
  }

  async function people(params: Record<string, unknown>) {
    const result = await admin.rpc("admin_people", params);
    if (result.error) throw new Error(`admin_people: ${result.error.message}`);
    return result.data as { total: number; rows: Array<Record<string, any>> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  describe("read functions", () => {
    it("people search is a case-insensitive prefix match and takes % _ \\ and an apostrophe literally", async () => {
      const tag = sha256hex(`${Math.random()}`).slice(0, 8);
      const first = await personWithEmail(`wc_${tag}_one@example.invalid`);
      await personWithEmail(`wcx${tag}_two@example.invalid`);

      const underscore = await people({ p_search: `wc_${tag}` });
      assert.deepEqual(underscore.rows.map((r) => r.user_id), [first], "_ is a plain character, not 'any character'");
      assert.equal((await people({ p_search: `WC_${tag.toUpperCase()}` })).total, 1, "capitals do not matter");
      assert.equal((await people({ p_search: `  wc_${tag}  ` })).total, 1, "spaces around the text are ignored");
      assert.equal((await people({ p_search: `wc%${tag}` })).total, 0, "% is a plain character, not 'anything'");
      assert.equal((await people({ p_search: `wc\\${tag}` })).total, 0, "a backslash is a plain character");
      assert.equal((await people({ p_search: "o'brien'; drop table" })).total, 0, "an apostrophe does not break the search");
    });

    it("a person without a label row is a person, and a person who never signed in has no last login", async () => {
      const tag = sha256hex(`${Math.random()}`).slice(0, 8);
      await personWithEmail(`nolabel_${tag}@example.invalid`);
      const found = await people({ p_search: `nolabel_${tag}` });
      assert.equal(found.rows.length, 1);
      assert.equal(found.rows[0].label_key, "person");
      assert.equal(found.rows[0].label_title, "Человек");
      assert.equal(found.rows[0].last_sign_in_at, null);
      assert.equal(found.rows[0].conversations, 0);
      assert.equal(found.rows[0].user_messages, 0);
    });

    it("an offset beyond the end is an empty page with the right total; the limit is kept within 1..100", async () => {
      const tag = sha256hex(`${Math.random()}`).slice(0, 8);
      await personWithEmail(`paging_${tag}@example.invalid`);
      const past = await people({ p_search: `paging_${tag}`, p_offset: 1000 });
      assert.deepEqual(past.rows, []);
      assert.equal(past.total, 1);
      const zero = await people({ p_search: `paging_${tag}`, p_limit: 0 });
      assert.equal(zero.rows.length, 1, "a limit of 0 is raised to 1");
      const huge = await people({ p_limit: 100000 });
      assert.ok(huge.rows.length <= 100, "a huge limit is cut to 100");
    });

    it("costs are split by the label of the account; a technical row is technical whoever owns it", async () => {
      const boss = await newPerson("costboss");
      await makeAdmin(boss.userId);
      const tester = await newPerson("costtester");
      const human = await newPerson("costhuman");
      await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: tester.userId, p_label_key: "technical" });

      await addUsage(tester.userId, { cost: 1, category: "automatic" });
      await addUsage(human.userId, { cost: 2, category: "automatic" });
      await addUsage(human.userId, { cost: 4, category: "technical", kind: "memory_dialogue_extractor" });

      const testerCard = (await admin.rpc("admin_person_card", { p_user_id: tester.userId })).data;
      const humanCard = (await admin.rpc("admin_person_card", { p_user_id: human.userId })).data;
      const sum = (card: { costs: { by_kind: Array<{ cost_class: string; usd: number }> } }, cls: string) =>
        card.costs.by_kind.filter((k) => k.cost_class === cls).reduce((a, k) => a + Number(k.usd), 0);
      assert.equal(sum(testerCard, "user"), 0, "an automatic row of a technical-labelled account is not a user cost");
      assert.equal(sum(testerCard, "technical"), 1);
      assert.equal(sum(humanCard, "user"), 2);
      assert.equal(sum(humanCard, "technical"), 4);

      const row = (await people({ p_search: human.email })).rows[0];
      assert.equal(Number(row.cost_user_usd), 2);
      assert.equal(Number(row.cost_technical_usd), 4);
    });

    it("admin_costs over one day: the days add up to the totals, and the kinds name what the money went on", async () => {
      const boss = await newPerson("cdboss");
      await makeAdmin(boss.userId);
      const tester = await newPerson("cdtester");
      const human = await newPerson("cdhuman");
      await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: tester.userId, p_label_key: "technical" });
      const day = new Date(Date.UTC(2100, 0, 1 + Math.floor(Math.random() * 300), 12, 0, 0));
      const at = day.toISOString();
      await addUsage(human.userId, { cost: 2.5, category: "automatic", at });
      await addUsage(human.userId, { cost: 0.5, category: "automatic", kind: "image_description", at });
      await addUsage(tester.userId, { cost: 1, category: "automatic", at });

      const since = new Date(day.getTime() - 12 * 3600_000).toISOString();
      const until = new Date(day.getTime() + 12 * 3600_000).toISOString();
      const costs = (await admin.rpc("admin_costs", { p_since: since, p_until: until })).data;
      assert.equal(Number(costs.totals.user_usd), 3);
      assert.equal(Number(costs.totals.technical_usd), 1);
      const byDay = costs.by_day.reduce((a: number, d: { usd: number }) => a + Number(d.usd), 0);
      assert.equal(byDay, 4, "by_day adds up to the totals");
      const kinds = costs.by_kind.map((k: { cost_class: string; kind: string }) => `${k.cost_class}:${k.kind}`).sort();
      assert.deepEqual(kinds, ["technical:reply", "user:image_description", "user:reply"]);
      assert.ok(costs.by_person.length >= 2);
    });

    it("the card of an unknown person is null, and one of a known person lists consents, tier, packs and ratings", async () => {
      assert.equal((await admin.rpc("admin_person_card", { p_user_id: randomUUID() })).data, null);
      const tag = sha256hex(`${Math.random()}`).slice(0, 8);
      const userId = await personWithEmail(`card_${tag}@example.invalid`);
      const consent = await admin.from("user_consents").insert({ user_id: userId, consent_type: "terms", document_version: "test-v1", document_sha256: sha256hex("terms") });
      assert.equal(consent.error, null, consent.error?.message);
      const card = (await admin.rpc("admin_person_card", { p_user_id: userId })).data;
      assert.equal(card.person.email, `card_${tag}@example.invalid`);
      assert.deepEqual(card.consents.map((c: { consent_type: string }) => c.consent_type), ["terms"]);
      assert.ok(Array.isArray(card.packs));
      assert.deepEqual(card.feedback, { answers: { up: 0, down: 0 }, dynamics: { up: 0, down: 0 } });
      assert.equal(card.errors_7d, 0);
    });

    it("the overview counts people by label and tier and splits the costs", async () => {
      const boss = await newPerson("ovboss");
      await makeAdmin(boss.userId);
      const subject = await newPerson("ovsubject");
      await admin.rpc("admin_set_label", { p_admin_id: boss.userId, p_user_id: subject.userId, p_label_key: "family" });
      const overview = (await admin.rpc("admin_overview")).data;
      assert.ok(overview.people.total >= 2);
      assert.ok(overview.people.registered_7d >= 2);
      const family = overview.people.by_label.find((l: { key: string }) => l.key === "family");
      assert.ok(family && family.count >= 1, "family is counted");
      const person = overview.people.by_label.find((l: { key: string }) => l.key === "person");
      assert.ok(person && person.count >= 1, "unlabelled accounts are counted as person");
      assert.ok(Array.isArray(overview.people.by_tier));
      assert.equal(typeof Number(overview.costs.user_usd), "number");
      assert.equal(typeof Number(overview.costs.technical_usd), "number");
      assert.deepEqual(Object.keys(overview.feedback).sort(), ["answers", "dynamics"]);
    });

    it("ratings: answers and dynamics come with the e-mail of the person, the text and the note; an unknown kind is refused", async () => {
      const bad = await admin.rpc("admin_feedback", { p_kind: "nonsense" });
      assert.match(bad.error?.message ?? "", /bad_kind/);

      const person = await newPerson("fbperson");
      const note = `note-${sha256hex(`${Math.random()}`).slice(0, 8)}`;
      const conversation = await admin.from("conversations").insert({ user_id: person.userId }).select("id");
      const conversationId = (conversation.data?.[0] as { id: string }).id;
      const answer = await admin.from("messages").insert({ conversation_id: conversationId, sender: "ai", content: "Вымышленный ответ." }).select("id");
      const answerId = (answer.data?.[0] as { id: string }).id;
      const asked = await admin.from("message_feedback").insert({ user_id: person.userId, conversation_id: conversationId, message_id: answerId, rating: -1, comment: note });
      assert.equal(asked.error, null, asked.error?.message);
      const weekly = await admin.from("progress_entries").insert({ user_id: person.userId, conversation_id: conversationId, entry_type: "weekly", content: "Вымышленная динамика." }).select("id");
      const weeklyId = (weekly.data?.[0] as { id: string }).id;
      const dyn = await admin.from("dynamics_feedback").insert({ user_id: person.userId, conversation_id: conversationId, entry_id: weeklyId, rating: 1, comment: note });
      assert.equal(dyn.error, null, dyn.error?.message);

      const answers = (await admin.rpc("admin_feedback", { p_kind: "answers", p_rating: -1, p_limit: 100 })).data;
      const mine = answers.rows.find((r: { comment: string }) => r.comment === note);
      assert.ok(mine, "the rated answer is listed");
      assert.equal(mine.email, person.email);
      assert.equal(mine.reply_excerpt, "Вымышленный ответ.");

      const dynamics = (await admin.rpc("admin_feedback", { p_kind: "dynamics", p_limit: 100 })).data;
      const mineDyn = dynamics.rows.find((r: { comment: string }) => r.comment === note);
      assert.ok(mineDyn, "the rated dynamics is listed");
      assert.equal(mineDyn.dynamics_excerpt, "Вымышленная динамика.");
      assert.equal(mineDyn.rating, 1);
    });

    it("errors: grouped by code, the message cut to 200 characters", async () => {
      const person = await newPerson("errperson");
      const code = `test_code_${sha256hex(`${Math.random()}`).slice(0, 8)}`;
      await addUsage(person.userId, { cost: 0, category: "automatic", errorCode: code, errorMessage: "я".repeat(500) });
      await addUsage(person.userId, { cost: 0, category: "automatic", errorCode: code, errorMessage: "короткая" });
      const errors = (await admin.rpc("admin_errors", { p_since: new Date(Date.now() - 3600_000).toISOString(), p_limit: 500 })).data;
      const group = errors.by_code.find((g: { error_code: string }) => g.error_code === code);
      assert.ok(group, "the code is grouped");
      assert.equal(Number(group.count), 2);
      const recent = errors.recent.filter((r: { error_code: string }) => r.error_code === code);
      assert.equal(recent.length, 2);
      assert.ok(recent.every((r: { error_message: string }) => r.error_message.length <= 200), "messages are cut");
    });
  });

  describe("closed to people", { skip: !hasAnon && "SUPABASE_ANON_KEY is not set" }, () => {
    it("a signed-in person cannot call the admin functions or read the admin tables", async () => {
      const plain = await newPerson("closed");
      const client = await signedIn(plain.email, plain.password);

      for (const [name, args] of [
        ["admin_is_admin", { p_user_id: plain.userId }],
        ["admin_list_labels", {}],
        ["admin_set_label", { p_admin_id: plain.userId, p_user_id: plain.userId, p_label_key: "technical" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const result = await client.rpc(name, args);
        assert.ok(result.error, `${name} must be refused to a signed-in person`);
      }

      for (const table of ["admin_users", "account_labels", "account_label_assignments", "admin_audit_log"]) {
        const result = await client.from(table).select("*");
        assert.ok(result.error || (result.data ?? []).length === 0, `${table} must show a person nothing`);
      }
    });

    it("the public key alone cannot call the admin functions either", async () => {
      const anon = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const result = await anon.rpc("admin_list_labels");
      assert.ok(result.error, "the public key must be refused");
    });
  });
});
