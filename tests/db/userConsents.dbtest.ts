import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { adminClient, deleteUser, sha256hex } from "./helpers.ts";

// What people agreed to: which text (version and hash) and when. Registration writes two rows from the new
// account's metadata; later agreements (the pictures) are written by record_user_consent.

const hasAnon = Boolean(process.env.SUPABASE_ANON_KEY);
const HASH_TERMS = sha256hex("offer text");
const HASH_PD = sha256hex("consent text");

describe("user consents on the real database", () => {
  let admin: SupabaseClient;
  const created: string[] = [];

  before(() => {
    admin = adminClient();
  });

  after(async () => {
    for (const userId of created) await deleteUser(admin, userId);
  });

  async function newUser(label: string, metadata?: Record<string, unknown>) {
    const email = `db-test-consent-${label}-${sha256hex(`${Date.now()}-${Math.random()}`).slice(0, 10)}@example.invalid`;
    const password = `Pw-${sha256hex(`${Math.random()}`).slice(0, 16)}!`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: metadata });
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "no user"}`);
    created.push(data.user.id);
    return { userId: data.user.id, email, password };
  }

  async function rows(userId: string) {
    const { data, error } = await admin
      .from("user_consents")
      .select("consent_type, document_version, document_sha256, consented_at, user_agent")
      .eq("user_id", userId)
      .order("consent_type", { ascending: true });
    if (error) throw new Error(error.message);
    return data as Array<{ consent_type: string; document_version: string; document_sha256: string; consented_at: string; user_agent: string | null }>;
  }

  async function signedIn(email: string, password: string): Promise<SupabaseClient> {
    const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign in: ${error.message}`);
    return client;
  }

  it("writes the two agreements of a new account, with the server's time", async () => {
    const earliest = Date.now() - 5_000;
    const { userId } = await newUser("signup", {
      consents: {
        terms: { version: "1.1", sha256: HASH_TERMS },
        pd_processing: { version: "1.2", sha256: HASH_PD },
        user_agent: "Mozilla/5.0 test",
      },
    });
    const found = await rows(userId);
    assert.deepEqual(
      found.map(({ consent_type, document_version, document_sha256, user_agent }) => ({ consent_type, document_version, document_sha256, user_agent })),
      [
        { consent_type: "pd_processing", document_version: "1.2", document_sha256: HASH_PD, user_agent: "Mozilla/5.0 test" },
        { consent_type: "terms", document_version: "1.1", document_sha256: HASH_TERMS, user_agent: "Mozilla/5.0 test" },
      ],
    );
    for (const row of found) assert.ok(new Date(row.consented_at).getTime() >= earliest, "the time is the server's, now");
  });

  it("never stops a person from registering because of bad agreement data, and writes nothing from it", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["text", { consents: "yes" }],
      ["number", { consents: { terms: { version: 5, sha256: "zz" } } }],
      ["short-hash", { consents: { terms: { version: "1.0", sha256: "abc" } } }],
      ["long-version", { consents: { pd_processing: { version: "v".repeat(100), sha256: HASH_PD } } }],
      ["array", { consents: [] }],
    ];
    for (const [label, metadata] of bad) {
      const { userId } = await newUser(`bad-${label}`, metadata);
      assert.deepEqual(await rows(userId), [], label);
    }
    const { userId } = await newUser("none");
    assert.deepEqual(await rows(userId), [], "no agreements, no rows");
  });

  it("lets a signed-in person record the picture consent once per version, and a new version as a new row", { skip: !hasAnon }, async () => {
    const { userId, email, password } = await newUser("images");
    const client = await signedIn(email, password);
    const call = (version: string, hash: string, type = "images") =>
      client.rpc("record_user_consent", { p_consent_type: type, p_version: version, p_sha256: hash, p_user_agent: "UA" });
    assert.equal((await call("images_v1", HASH_PD)).error, null);
    assert.equal((await call("images_v1", HASH_PD)).error, null, "the same version again is not an error");
    assert.equal((await call("images_v2", HASH_TERMS)).error, null);
    const found = await rows(userId);
    assert.deepEqual(found.map((row) => [row.consent_type, row.document_version]), [["images", "images_v1"], ["images", "images_v2"]]);
  });

  it("refuses an unknown kind, a bad version, a bad hash and a call without signing in", { skip: !hasAnon }, async () => {
    const { email, password } = await newUser("refuse");
    const client = await signedIn(email, password);
    const call = (c: SupabaseClient, type: string, version: string, hash: string) =>
      c.rpc("record_user_consent", { p_consent_type: type, p_version: version, p_sha256: hash });
    assert.notEqual((await call(client, "marketing", "1", HASH_PD)).error, null, "unknown kind");
    assert.notEqual((await call(client, "images", "", HASH_PD)).error, null, "empty version");
    assert.notEqual((await call(client, "images", "v".repeat(41), HASH_PD)).error, null, "long version");
    assert.notEqual((await call(client, "images", "1", "not-a-hash")).error, null, "bad hash");
    const anonymous = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_ANON_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    assert.notEqual((await call(anonymous, "images", "1", HASH_PD)).error, null, "not signed in");
  });

  it("shows a person their own rows only, and lets nobody but the database write or change them", { skip: !hasAnon }, async () => {
    const a = await newUser("rls-a", { consents: { terms: { version: "1.1", sha256: HASH_TERMS } } });
    const b = await newUser("rls-b", { consents: { terms: { version: "1.1", sha256: HASH_TERMS } } });
    const client = await signedIn(a.email, a.password);

    const own = await client.from("user_consents").select("user_id");
    assert.equal(own.error, null);
    assert.deepEqual([...new Set((own.data ?? []).map((row) => row.user_id))], [a.userId], "only their own rows");

    const insert = await client.from("user_consents").insert({
      user_id: a.userId, consent_type: "images", document_version: "x", document_sha256: HASH_PD,
    });
    assert.notEqual(insert.error, null, "no direct insert");
    const update = await client.from("user_consents").update({ document_version: "forged" }).eq("user_id", a.userId).select();
    assert.deepEqual(update.data ?? [], [], "no update");
    const remove = await client.from("user_consents").delete().eq("user_id", a.userId).select();
    assert.deepEqual(remove.data ?? [], [], "no delete");
    assert.equal((await rows(a.userId)).length, 1, "the row is still there");
    assert.equal((await rows(b.userId)).length, 1, "the other person's row is untouched");
  });

  it("is removed with the account", async () => {
    const { userId } = await newUser("cascade", { consents: { terms: { version: "1.1", sha256: HASH_TERMS } } });
    assert.equal((await rows(userId)).length, 1);
    await deleteUser(admin, userId);
    created.splice(created.indexOf(userId), 1);
    assert.deepEqual(await rows(userId), []);
  });
});
