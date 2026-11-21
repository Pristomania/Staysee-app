import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embeddings.ts";
import {
  DEFAULT_SEMANTIC_THRESHOLD,
  SEMANTIC_MATCH_COUNT,
  SEMANTIC_MIN_LINE_CHARS,
  ensureConversationEmbeddings,
  resolveSemanticThreshold,
  searchSemanticConversationArchive,
  semanticRowsToExcerpts,
} from "./messageEmbeddings.ts";

const migration = readFileSync(
  new URL("../../migrations/20261121000000_107_embeddings_by_model.sql", import.meta.url),
  "utf8",
);
const migration108 = readFileSync(
  new URL("../../migrations/20261121010000_108_match_user_lines_min_length.sql", import.meta.url),
  "utf8",
);
const migration111 = readFileSync(new URL("../../migrations/20261121050000_111_match_embeddings_one_access_check.sql", import.meta.url), "utf8");
const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A provider that answers with one vector of `size` numbers per input; remembers the bodies it was sent. */
function stubProvider(size: number) {
  const bodies: Array<{ model: string; input: string[] }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return {
      ok: true,
      json: async () => ({
        data: body.input.map((_: string, index: number) => ({ index, embedding: Array(size).fill(0.01) })),
        usage: { prompt_tokens: 10, total_tokens: 10, cost: 0 },
      }),
      text: async () => "",
    };
  }) as never;
  return bodies;
}

function fakeServiceClient(missing: unknown[] | null, rpcError: string | null = null) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const upserts: Array<Record<string, unknown>[]> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: missing, error: rpcError ? { message: rpcError } : null });
    },
    from(table: string) {
      assert.equal(table, "message_embeddings");
      return {
        upsert(rows: Record<string, unknown>[]) {
          upserts.push(rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as never, rpcCalls, upserts };
}

const embedConfig = { apiKey: "test-key" };

describe("the vectors are made by one named model and stored with its name", () => {
  it("uses an open model of 1024 numbers by default", () => {
    assert.equal(DEFAULT_EMBEDDING_MODEL, "baai/bge-m3");
    assert.equal(EMBEDDING_MODEL, "baai/bge-m3");
    assert.equal(EMBEDDING_DIMENSIONS, 1024);
  });

  it("asks the database for the messages that have no vector of THIS model, and stores the model's name with each vector", async () => {
    const bodies = stubProvider(1024);
    const { client, rpcCalls, upserts } = fakeServiceClient([
      { id: "m3", sender: "user", role: null, content: "  я   переехала\nв другой город ", created_at: "2026-05-12T10:00:00Z" },
      { id: "m2", sender: "ai", role: null, content: "Это большая перемена.", created_at: "2026-05-12T09:59:00Z" },
      { id: "m1", sender: null, role: "user", content: "привет", created_at: "2026-05-12T09:58:00Z" },
    ]);

    const embedded = await ensureConversationEmbeddings(client, { conversationId: "c1", userId: "u1", embedConfig, maxMessages: 12 });

    assert.equal(embedded, 3);
    assert.deepEqual(rpcCalls, [
      { name: "messages_missing_embeddings", args: { p_conversation_id: "c1", p_model: "baai/bge-m3", p_limit: 12 } },
    ]);
    assert.equal(bodies[0].model, "baai/bge-m3");
    assert.equal(bodies[0].input[0], "Пользователь: я переехала в другой город");
    assert.equal(bodies[0].input[1], "StaySee: Это большая перемена.");
    assert.equal(upserts.length, 1);
    for (const row of upserts[0]) {
      assert.equal(row.embedding_model, "baai/bge-m3");
      assert.equal((row.embedding_1024 as number[]).length, 1024);
      assert.ok(!("embedding" in row), "the old 1536 column is never written");
      assert.equal(row.conversation_id, "c1");
      assert.equal(row.user_id, "u1");
    }
    assert.deepEqual(upserts[0].map((r) => r.sender), ["user", "ai", "user"]);
  });

  it("does nothing, and spends nothing, when every message already has its vector or the lookup fails", async () => {
    const bodies = stubProvider(1024);
    assert.equal(await ensureConversationEmbeddings(fakeServiceClient([]).client, { conversationId: "c1", userId: "u1", embedConfig }), 0);
    assert.equal(await ensureConversationEmbeddings(fakeServiceClient(null, "no such function").client, { conversationId: "c1", userId: "u1", embedConfig }), 0);
    assert.equal(bodies.length, 0);
  });

  it("refuses a vector of the wrong length instead of storing it (a swapped model must be loud, never silent)", async () => {
    stubProvider(1536);
    const { client, upserts } = fakeServiceClient([{ id: "m1", sender: "user", role: null, content: "привет", created_at: "2026-05-12T09:58:00Z" }]);
    assert.equal(await ensureConversationEmbeddings(client, { conversationId: "c1", userId: "u1", embedConfig }), 0);
    assert.equal(upserts.length, 0);
  });
});

describe("the search by meaning covers the whole conversation and reads only vectors of the current model", () => {
  const hits = [
    { message_id: "a", sender: "user", role: null, content: "я переехала в другой город", created_at: "2026-05-12T10:00:00Z", similarity: 0.71, reply_sender: "ai", reply_role: null, reply_content: "Это большая перемена." },
    { message_id: "b", sender: "ai", role: null, content: "Расскажи, как ты это пережила.", created_at: "2026-05-12T10:01:00Z", similarity: 0.7, reply_sender: null, reply_role: null, reply_content: null },
    { message_id: "c", sender: "user", role: null, content: "x".repeat(900), created_at: "2026-01-03T10:00:00Z", similarity: 0.65, reply_sender: null, reply_role: null, reply_content: null },
  ];

  it("keeps only the person's lines as hits, adds the reply that followed, and never invents a reply", () => {
    const excerpts = semanticRowsToExcerpts(hits, 420);
    assert.equal(excerpts.length, 2);
    assert.equal(excerpts[0].userText, "я переехала в другой город");
    assert.equal(excerpts[0].assistantText, "Это большая перемена.");
    assert.equal(excerpts[1].assistantText, null, "a missing reply stays missing (a row with no sender must not count as Stacy's)");
    assert.ok(excerpts[1].userText.length <= 420, "a long line is clipped");
  });

  it("asks the database for the current model, the threshold and the cut-off, across the whole conversation", async () => {
    stubProvider(1024);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: hits, error: null });
      },
    } as never;

    const excerpts = await searchSemanticConversationArchive(client, {
      conversationId: "c1",
      query: "помнишь, я говорила про переезд?",
      beforeCreatedAt: "2026-06-01T00:00:00Z",
      embedConfig,
      maxExcerptChars: 420,
    });

    assert.equal(excerpts.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "match_conversation_embeddings_by_model");
    assert.equal(calls[0].args.p_model, "baai/bge-m3");
    assert.equal(calls[0].args.match_count, SEMANTIC_MATCH_COUNT);
    assert.equal(calls[0].args.match_threshold, DEFAULT_SEMANTIC_THRESHOLD);
    assert.equal(calls[0].args.p_before_created_at, "2026-06-01T00:00:00Z");
    assert.equal(calls[0].args.p_min_chars, SEMANTIC_MIN_LINE_CHARS);
    assert.equal(SEMANTIC_MIN_LINE_CHARS, 6);
    assert.equal((calls[0].args.query_embedding as number[]).length, 1024);
  });

  it("falls back to nothing (the search by words goes on) when the question cannot be turned into a vector or the database refuses", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => "down" })) as never;
    const never = { rpc: () => assert.fail("must not be called without a vector") } as never;
    assert.deepEqual(
      await searchSemanticConversationArchive(never, { conversationId: "c1", query: "помнишь про переезд", beforeCreatedAt: null, embedConfig, maxExcerptChars: 420 }),
      [],
    );
    stubProvider(1024);
    const refusing = { rpc: () => Promise.resolve({ data: null, error: { message: "function does not exist" } }) } as never;
    assert.deepEqual(
      await searchSemanticConversationArchive(refusing, { conversationId: "c1", query: "помнишь про переезд", beforeCreatedAt: null, embedConfig, maxExcerptChars: 420 }),
      [],
    );
  });

  it("the threshold comes from a setting when it is sensible, else the measured default", () => {
    assert.equal(resolveSemanticThreshold(undefined), 0.58);
    assert.equal(resolveSemanticThreshold("0.7"), 0.7);
    assert.equal(resolveSemanticThreshold("0.1"), 0.58);
    assert.equal(resolveSemanticThreshold("abc"), 0.58);
  });
});

describe("the migration only adds, reads with the caller's rights, and compares one model at a time", () => {
  it("deletes and rewrites nothing", () => {
    for (const forbidden of [/DROP\s+TABLE/i, /TRUNCATE/i, /DELETE\s+FROM/i, /DROP\s+COLUMN/i, /UPDATE\s+public\./i, /ALTER\s+COLUMN\s+embedding\s+TYPE/i]) {
      assert.doesNotMatch(migration, forbidden);
    }
    assert.match(migration, /ADD COLUMN IF NOT EXISTS embedding_model text/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS embedding_1024 vector\(1024\)/);
  });

  it("both functions run with the caller's rights, so the conversation locks keep applying", () => {
    const code = migration.replace(/\/\*[\s\S]*?\*\//, "");
    assert.equal((code.match(/SECURITY INVOKER/g) ?? []).length, 2, "both functions");
    assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 2);
    assert.doesNotMatch(code, /SECURITY DEFINER/);
  });

  it("compares only the vectors of the model it is asked for, within one conversation", () => {
    assert.match(migration, /me\.embedding_model = p_model/);
    assert.match(migration, /me\.conversation_id = p_conversation_id/);
    assert.match(migration, /to_jsonb\(m\) ->> 'role'/, "the role is read in a way that works with or without the column");
  });
});

describe("the chat keeps filling the vectors after every reply", () => {
  it("embeds the new messages in the background (so a long conversation never stops being indexed)", () => {
    const at = chat.indexOf("Embed new messages for semantic archive");
    assert.ok(at > 0);
    assert.match(chat.slice(at, at + 700), /ensureConversationEmbeddings\(svc,/);
  });
});

describe("migration 108: only the person's own lines, and not the very short ones", () => {
  const code = migration108.replace(/\/\*[\s\S]*?\*\//, "");

  it("replaces only the function of migration 107 and touches no data", () => {
    assert.match(code, /DROP FUNCTION IF EXISTS public\.match_conversation_embeddings_by_model\(/);
    for (const forbidden of [/DROP\s+TABLE/i, /TRUNCATE/i, /DELETE\s+FROM/i, /DROP\s+COLUMN/i, /UPDATE\s+public\./i, /ALTER\s+TABLE/i]) {
      assert.doesNotMatch(code, forbidden);
    }
    assert.equal((code.match(/DROP FUNCTION/g) ?? []).length, 1);
  });

  it("looks only at the person's lines, skips short ones by length, and still reads one model in one conversation with the caller's rights", () => {
    assert.match(code, /m\.sender = 'user'/);
    assert.match(code, /length\(btrim\(coalesce\(m\.content, ''\)\)\) >= GREATEST\(0, p_min_chars\)/);
    assert.match(code, /p_min_chars int DEFAULT 20/);
    assert.match(code, /me\.embedding_model = p_model/);
    assert.match(code, /me\.conversation_id = p_conversation_id/);
    assert.match(code, /SECURITY INVOKER/);
    assert.doesNotMatch(code, /SECURITY DEFINER/);
  });
});

describe("migration 111: the access to the conversation is checked once, and only the signed-in owner can use the search", () => {
  const code = migration111.replace(/\/\*[\s\S]*?\*\//, "");

  it("asks the question of the conversation locks once, before any line is read", () => {
    assert.match(code, /SECURITY DEFINER/);
    assert.match(code, /SET search_path = pg_catalog, public, pg_temp/);
    assert.match(code, /auth\.uid\(\) IS NULL OR NOT public\.can_read_my_conversation\(p_conversation_id\)/);
    assert.equal((code.match(/can_read_my_conversation\(/g) ?? []).length, 1, "one check for the whole conversation, never one per line");
    assert.ok(code.indexOf("can_read_my_conversation(") < code.indexOf("message_embeddings me"), "the check comes before the lines are read");
  });

  it("reads only the lines of that one conversation, and looks for the next message only for the best few", () => {
    assert.match(code, /me\.conversation_id = p_conversation_id/);
    assert.match(code, /m\.conversation_id = p_conversation_id/);
    assert.match(code, /WITH hits AS MATERIALIZED/);
    assert.ok(code.indexOf("LIMIT GREATEST(1, LEAST(match_count, 30))") < code.indexOf("LEFT JOIN LATERAL"), "the best lines are cut out before the lookup of the next message");
  });

  it("is open to signed-in people only (not anon, not PUBLIC, not the service role) and changes no data", () => {
    assert.match(code, /REVOKE ALL ON FUNCTION public\.match_conversation_embeddings_by_model\([^)]*\) FROM PUBLIC, anon, service_role/);
    assert.match(code, /GRANT EXECUTE ON FUNCTION public\.match_conversation_embeddings_by_model\([^)]*\) TO authenticated/);
    assert.doesNotMatch(code, /TO (anon|PUBLIC|service_role)/);
    for (const forbidden of [/DROP\s+TABLE/i, /TRUNCATE/i, /DELETE\s+FROM/i, /DROP\s+COLUMN/i, /UPDATE\s+public\./i, /ALTER\s+TABLE/i, /INSERT\s+INTO/i]) {
      assert.doesNotMatch(code, forbidden);
    }
  });
});

describe("a failure of the search by meaning is reported, not swallowed", () => {
  it("calls onFailure once when the database answers with an error (the statement timeout of 21.11.2026), and still returns nothing", async () => {
    stubProvider(1024);
    let failures = 0;
    const client = { rpc: () => Promise.resolve({ data: null, error: { message: "canceling statement due to statement timeout" } }) } as never;
    const excerpts = await searchSemanticConversationArchive(client, {
      conversationId: "c1", query: "помнишь про бабушку", beforeCreatedAt: null, embedConfig, maxExcerptChars: 420,
      onFailure: () => { failures += 1; },
    });
    assert.deepEqual(excerpts, []);
    assert.equal(failures, 1);
  });

  it("calls onFailure when the vector of the question cannot be made", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => "down" })) as never;
    let failures = 0;
    const never = { rpc: () => assert.fail("must not be called without a vector") } as never;
    await searchSemanticConversationArchive(never, {
      conversationId: "c1", query: "помнишь про бабушку", beforeCreatedAt: null, embedConfig, maxExcerptChars: 420,
      onFailure: () => { failures += 1; },
    });
    assert.equal(failures, 1);
  });

  it("stays quiet when the search worked (also when it found nothing), and a broken handler never breaks the search", async () => {
    stubProvider(1024);
    let failures = 0;
    const empty = { rpc: () => Promise.resolve({ data: [], error: null }) } as never;
    await searchSemanticConversationArchive(empty, { conversationId: "c1", query: "помнишь про бабушку", beforeCreatedAt: null, embedConfig, maxExcerptChars: 420, onFailure: () => { failures += 1; } });
    assert.equal(failures, 0);
    const broken = { rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }) } as never;
    const result = await searchSemanticConversationArchive(broken, { conversationId: "c1", query: "помнишь про бабушку", beforeCreatedAt: null, embedConfig, maxExcerptChars: 420, onFailure: () => { throw new Error("handler broke"); } });
    assert.deepEqual(result, []);
  });

  it("the chat raises the alert through the same Telegram path as the other provider alerts", () => {
    assert.match(chat, /onSemanticFailure: async \(\) => \{\s*await sendProviderAlertSafely\("search_failed"\);/);
  });
});
