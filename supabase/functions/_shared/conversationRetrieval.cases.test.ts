import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import * as retrieval from "./conversationRetrieval.ts";
import {
  RETRIEVAL_MAX_FETCH,
  RETRIEVAL_RECENT_WINDOW,
  fetchConversationMessagesForRetrieval,
  formatArchiveExcerptsForPrompt,
  formatUserEvidenceForPrompt,
  hasRecallIntent,
  rankArchiveExcerpts,
  searchConversationArchive,
} from "./conversationRetrieval.ts";

const source = readFileSync(new URL("./conversationRetrieval.ts", import.meta.url), "utf8");
const memorySource = readFileSync(new URL("./recallGrounding.ts", import.meta.url), "utf8");

interface Row {
  id: string;
  sender: string;
  role: string | null;
  content: string;
  created_at: string;
}

/** A conversation of `count` messages (user, ai, user, ai …), one minute apart, message 0 the oldest. */
function conversation(count: number, special: Record<number, string> = {}): Row[] {
  const start = Date.parse("2026-01-01T10:00:00Z");
  return Array.from({ length: count }, (_, i) => ({
    id: `m${String(i).padStart(5, "0")}`,
    sender: i % 2 === 0 ? "user" : "ai",
    role: null,
    content: special[i] ?? (i % 2 === 0 ? `обычная реплика номер ${i}` : `ответ номер ${i}`),
    created_at: new Date(start + i * 60_000).toISOString(),
  }));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A client that serves the messages table the way the database does: newest first, a page at a time. */
function fakeMessagesClient(
  rows: Row[],
  options: {
    failAtPage?: number;
    rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
  } = {}
) {
  const pages: Array<[number, number]> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve(options.rpc ? options.rpc(name, args) : { data: [], error: null });
    },
    from(table: string) {
      assert.equal(table, "messages");
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range(from: number, to: number) {
          pages.push([from, to]);
          if (options.failAtPage !== undefined && pages.length === options.failAtPage) {
            return Promise.resolve({ data: null, error: { message: "boom" } });
          }
          const newestFirst = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return Promise.resolve({ data: newestFirst.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };
  return { client: client as never, pages, rpcCalls };
}

describe("the archive search reads the whole conversation, not its first messages", () => {
  it("reads only the newest window when nobody asked to remember, oldest first", async () => {
    const { client, pages } = fakeMessagesClient(conversation(1500));
    const got = await fetchConversationMessagesForRetrieval(client, "c1", "recent");
    assert.equal(got.length, RETRIEVAL_RECENT_WINDOW);
    assert.equal(got[got.length - 1].content, "ответ номер 1499", "the newest message is there");
    assert.ok(got[0].created_at < got[1].created_at, "oldest first");
    assert.equal(pages.length, 1);
  });

  it("reads every message of a long conversation when someone asks to remember (the first message too)", async () => {
    const { client, pages } = fakeMessagesClient(conversation(2500, { 0: "самое первое сообщение" }));
    const got = await fetchConversationMessagesForRetrieval(client, "c1", "all");
    assert.equal(got.length, 2500);
    assert.equal(got[0].content, "самое первое сообщение");
    assert.equal(got[0].role, "user");
    assert.equal(got[1].role, "assistant");
    assert.equal(pages.length, 3, "pages of 1000: 1000 + 1000 + 500, then it stops");
  });

  it("never reads more than the cap, and keeps the newest when it must cut", async () => {
    const { client } = fakeMessagesClient(conversation(RETRIEVAL_MAX_FETCH + 700));
    const got = await fetchConversationMessagesForRetrieval(client, "c1", "all");
    assert.equal(got.length, RETRIEVAL_MAX_FETCH);
    assert.equal(got[got.length - 1].content, `ответ номер ${RETRIEVAL_MAX_FETCH + 699}`);
  });

  it("returns what it has when a later page fails, and nothing when the first fails", async () => {
    const later = fakeMessagesClient(conversation(2500), { failAtPage: 2 });
    assert.equal((await fetchConversationMessagesForRetrieval(later.client, "c1", "all")).length, 1000);
    const first = fakeMessagesClient(conversation(2500), { failAtPage: 1 });
    assert.equal((await fetchConversationMessagesForRetrieval(first.client, "c1", "all")).length, 0);
  });

  it("finds an old exchange by the person's own words, even when it lies far before the newest messages", async () => {
    const rows = conversation(1200, { 20: "я хожу на йогу по вторникам и мне там спокойно", 21: "Рада, что у тебя есть место, где спокойно." });
    const { client } = fakeMessagesClient(rows);
    const messages = await fetchConversationMessagesForRetrieval(client, "c1", "all");
    const hits = rankArchiveExcerpts(messages, "помнишь, я говорила про йогу", 20);
    assert.ok(hits.some((h) => h.userText.includes("йогу")), "the old exchange is among the hits");
    assert.ok(hits[0].userText.includes("йогу"), "and it comes first");
  });
});

describe("nothing in the search is written for one story", () => {
  it("does not add words the person did not say, and does not guess a topic from the words", () => {
    assert.equal((retrieval as Record<string, unknown>).expandRecallTopicStems, undefined);
    for (const word of ["манипул", "улич", "обвин", "FIGHT_", "мужчин", "поругал", "ссор", "развод", "предател"]) {
      assert.ok(!source.includes(word), `conversationRetrieval.ts must not contain "${word}"`);
    }
  });

  it("the recall block has no topic written into it", () => {
    const block = memorySource.slice(memorySource.indexOf("export function buildRecallGroundingPrompt"));
    for (const word of ["ссор", "сын", "мужчин"]) {
      assert.ok(!block.includes(word), `the recall block must not contain "${word}"`);
    }
  });

  it("ordinary words of a story do not wake the recall mode", () => {
    for (const text of ["мы вчера поругались", "я ему не доверяю", "он сказал, что приедет к ужину и опять опоздал"]) {
      assert.equal(hasRecallIntent(text), text.includes("сказал"), text);
    }
    assert.equal(hasRecallIntent("помнишь, что я говорила про маму?"), true);
    assert.equal(hasRecallIntent("вспомни, пожалуйста"), true);
  });

  it("the prompt blocks speak about a person, not about one gender, and show the year of an old line", () => {
    const evidence = formatUserEvidenceForPrompt([{ createdAt: "2026-05-12T10:00:00Z", text: "я переехала в другой город" }]);
    const archive = formatArchiveExcerptsForPrompt([
      { userText: "я переехала в другой город", assistantText: "Это большая перемена.", createdAt: "2026-05-12T10:00:00Z", score: 1 },
    ]);
    for (const block of [evidence, archive]) {
      assert.match(block, /2026/, "an old line carries its year");
      assert.ok(!/\bона\b|говорила\b|\bей\b/.test(block.split("\n").slice(0, 7).join(" ")), "the instructions do not assume a gender");
    }
  });
});

describe("the search by meaning gets the question alone", () => {
  it("embeds exactly the person's question (not mixed with other lines or the summary) and asks for lines of the person only", async () => {
    const bodies: Array<{ model: string; input: string[] }> = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return {
        ok: true,
        json: async () => ({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1024).fill(0.01) })), usage: { prompt_tokens: 5, total_tokens: 5, cost: 0 } }),
        text: async () => "",
      };
    }) as never;

    const user = fakeMessagesClient(conversation(60));
    const service = fakeMessagesClient([]);
    const question = "помнишь, что я говорила про йогу?";
    await searchConversationArchive(user.client, {
      conversationId: "c1",
      query: question,
      excludeTailCount: 6,
      userId: "u1",
      embedConfig: { apiKey: "key" },
      supabaseService: service.client,
    });

    assert.equal(bodies.length, 1, "one call: the question (the service client had nothing to catch up)");
    assert.equal(bodies[0].input.length, 1);
    assert.equal(bodies[0].input[0], question);
    const search = user.rpcCalls.find((c) => c.name === "match_conversation_embeddings_by_model");
    assert.ok(search, "the search by meaning ran, as the user");
    assert.equal(search.args.p_conversation_id, "c1", "in this conversation only");
    assert.equal(search.args.p_min_chars, 10);
    assert.equal(service.rpcCalls[0].name, "messages_missing_embeddings");
  });

  it("no longer takes a context parameter or builds one in the chat", () => {
    assert.ok(!source.includes("queryContext"));
    assert.ok(!source.includes("contextBlob"));
    const chatSource = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");
    assert.ok(!chatSource.includes("queryContext"));
    assert.ok(!chatSource.includes("summaryTextForRetrieval"));
  });
});

describe("when the small model has decided that the person asks to remember", () => {
  const rows = conversation(60, {
    20: "я хожу на йогу по вторникам и мне там спокойно",
    21: "Рада, что тебе там спокойно.",
    30: "купила новые кроссовки для бега, красные",
  });
  const yoga = rows[20];
  const sneakers = rows[30];

  function semanticRow(row: Row, similarity: number, reply: Row | null) {
    return {
      message_id: row.id, sender: row.sender, role: null, content: row.content, created_at: row.created_at, similarity,
      reply_sender: reply?.sender ?? null, reply_role: null, reply_content: reply?.content ?? null,
    };
  }

  /** The providers: the vectors (always 1024 numbers) and the reranker (the line about yoga answers, the rest does not). */
  function stubProviders(options: { rerankStatus?: number } = {}) {
    const embedInputs: string[] = [];
    const rerankCalls: Array<{ query: string; documents: string[] }> = [];
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/rerank")) {
        rerankCalls.push({ query: body.query, documents: body.documents });
        if (options.rerankStatus && options.rerankStatus !== 200) return { ok: false, status: options.rerankStatus, json: async () => ({}), text: async () => "" };
        const results = body.documents.map((text: string, index: number) => ({ index, relevance_score: text.includes("йог") ? 0.9 : text.includes("кроссовки") ? 0.02 : 0.001 }));
        return { ok: true, status: 200, json: async () => ({ usage: { total_tokens: 50 }, results }), text: async () => "" };
      }
      embedInputs.push(...body.input);
      return {
        ok: true, status: 200, text: async () => "",
        json: async () => ({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1024).fill(0.01) })), usage: { prompt_tokens: 5, total_tokens: 5, cost: 0 } }),
      };
    }) as never;
    return { embedInputs, rerankCalls };
  }

  function run(decision: { recall: boolean; query: string } | null, options: { rerank?: boolean; message?: string } = {}) {
    const user = fakeMessagesClient(rows, {
      rpc: (name) => (name === "match_conversation_embeddings_by_model" ? { data: [semanticRow(yoga, 0.72, rows[21]), semanticRow(sneakers, 0.5, null)], error: null } : { data: [], error: null }),
    });
    const service = fakeMessagesClient([]);
    const usages: number[] = [];
    const promise = searchConversationArchive(user.client, {
      conversationId: "c1",
      query: options.message ?? "помнишь, я говорила про йогу?",
      excludeTailCount: 6,
      userId: "u1",
      embedConfig: { apiKey: "key" },
      supabaseService: service.client,
      decision,
      rerank: options.rerank === false ? undefined : { apiKey: "cloudru-key", onUsage: (u) => void usages.push(u.totalTokens) },
    });
    return { promise, user, usages };
  }

  it("searches for the phrase of the model (not the question), asks for 20 candidates from a low floor, and keeps only what the reranker accepts", async () => {
    const providers = stubProviders();
    const { promise, user, usages } = run({ recall: true, query: "йога по вторникам" });
    const result = await promise;

    assert.deepEqual(providers.embedInputs, ["йога по вторникам"], "the vectors get the phrase");
    const search = user.rpcCalls.find((c) => c.name === "match_conversation_embeddings_by_model");
    assert.ok(search);
    assert.equal(search.args.match_count, 20);
    assert.equal(search.args.match_threshold, 0.45);
    assert.equal(search.args.p_conversation_id, "c1");

    assert.equal(providers.rerankCalls.length, 1);
    assert.equal(providers.rerankCalls[0].query, "йога по вторникам", "the reranker gets the phrase too");
    assert.ok(providers.rerankCalls[0].documents.some((d) => d.includes("кроссовки")), "the candidate that is not an answer was sent to it");
    assert.ok(providers.rerankCalls[0].documents.length <= 40);
    assert.equal(providers.rerankCalls[0].documents.filter((d) => d.includes("йог")).length, 1, "a line found both by meaning and by words is sent once");

    assert.equal(result.excerpts.length, 1);
    assert.equal(result.excerpts[0].userText, yoga.content);
    assert.equal(result.excerpts[0].assistantText, "Рада, что тебе там спокойно.");
    assert.equal(result.excerpts[0].score, 0.9);
    assert.deepEqual(result.userEvidenceQuotes.map((q) => q.text), [yoga.content]);
    assert.deepEqual(usages, [50], "the reranker's cost is reported");
  });

  it("falls back to the closeness of the vectors when the reranker does not answer", async () => {
    stubProviders({ rerankStatus: 503 });
    const { promise } = run({ recall: true, query: "йога по вторникам" });
    const result = await promise;
    assert.deepEqual(result.excerpts.map((e) => e.userText), [yoga.content], "0.72 is close enough, 0.5 is not");
  });

  it("falls back the same way when there is no reranker at all (no key)", async () => {
    const providers = stubProviders();
    const { promise, user } = run({ recall: true, query: "йога по вторникам" }, { rerank: false });
    const result = await promise;
    assert.equal(providers.rerankCalls.length, 0);
    assert.equal(user.rpcCalls.find((c) => c.name === "match_conversation_embeddings_by_model")?.args.match_threshold, 0.58);
    assert.deepEqual(result.excerpts.map((e) => e.userText), [yoga.content]);
  });

  it("searches for the question itself when the model gave no phrase", async () => {
    const providers = stubProviders();
    await run({ recall: true, query: "" }, { message: "что я говорила про йогу" }).promise;
    assert.deepEqual(providers.embedInputs, ["что я говорила про йогу"]);
  });

  it("does not dig into the past when the model says this is not a request to remember, even if the message carries words of asking", async () => {
    const providers = stubProviders();
    const { promise, user } = run({ recall: false, query: "" }, { message: "помнишь, как в детстве мы строили шалаш? Это было лучшее лето." });
    await promise;
    assert.equal(providers.embedInputs.length, 0, "no vectors");
    assert.equal(providers.rerankCalls.length, 0, "no reranker");
    assert.equal(user.rpcCalls.filter((c) => c.name === "match_conversation_embeddings_by_model").length, 0, "no search by meaning");
  });

  it("goes on by the old rule (the words) only when the model did not answer", async () => {
    const providers = stubProviders();
    const { promise, user } = run(null, { message: "помнишь, что я говорила про йогу?" });
    await promise;
    assert.deepEqual(providers.embedInputs, ["помнишь, что я говорила про йогу?"], "the question itself, as before");
    assert.equal(providers.rerankCalls.length, 0);
    assert.equal(user.rpcCalls.find((c) => c.name === "match_conversation_embeddings_by_model")?.args.match_count, 12);
  });
});

describe("the chat function uses the decision of the small model and counts every call", () => {
  const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");

  it("starts the small model early, awaits it before the search, and passes its decision on", () => {
    const start = chat.indexOf("askRecallGate(message, { apiKey: cloudruKey })");
    const build = chat.indexOf("const builtPacket = await buildContextPacket");
    const wait = chat.indexOf("await recallGatePromise");
    const search = chat.indexOf("await searchConversationArchive(userSupabase");
    assert.ok(start > 0 && start < build, "started before the context is built (its time is spent meanwhile)");
    assert.ok(wait > build && wait < search, "awaited just before the search");
    assert.match(chat.slice(search, search + 600), /decision: recallDecision/);
    assert.match(chat, /STAYSEE_RECALL_GATE_MODE/);
    assert.match(chat, /STAYSEE_RERANK_THRESHOLD/);
  });

  it("writes the cost of the small model and of the reranker into the cost log, under their own kinds", () => {
    assert.match(chat, /callKind: "recall_gate"/);
    assert.match(chat, /callKind: "recall_rerank"/);
    assert.match(chat, /model: RECALL_GATE_MODEL/);
    assert.match(chat, /model: RERANK_MODEL/);
  });

  it("the recall instruction follows the same decision, and the key is never written to the log", () => {
    assert.match(chat, /if \(recallDecision \? recallDecision\.recall : hasRecallIntent\(message\)\)/);
    const logLines = chat.split("\n").filter((line) => /console\.(log|warn|error|info)\(/.test(line));
    for (const line of logLines) assert.doesNotMatch(line, /cloudruKey/, line);
  });
});
