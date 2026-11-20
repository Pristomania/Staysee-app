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
