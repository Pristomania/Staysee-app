/**
 * The cost of embeddings (the vectors for the memory search) is written into the cost log like every other paid call.
 * Run: npx tsx supabase/functions/_shared/embeddingUsage.cases.test.ts
 *
 * Why: the panel's costs came from ai_usage_logs, and the embeddings of the app were the one paid call that never wrote a row.
 * The owner's rule: every cost is written, down to the cent.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: () => undefined } };

import { embeddingUsageInsert, logEmbeddingUsage, readEmbeddingUsage } from "./embeddingUsage.ts";
import { getModelPricing } from "./openRouterPricing.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

const MODEL = "openai/text-embedding-3-small";

// ── the price table knows the embedding model (the default $1/$3 would overstate it 50 times) ─────────────
same(getModelPricing(MODEL), { inputPer1M: 0.02, outputPer1M: 0 }, "text-embedding-3-small is priced as input only");
same(getModelPricing("openai/text-embedding-3-large"), { inputPer1M: 0.13, outputPer1M: 0 }, "text-embedding-3-large too");
same(getModelPricing("baai/bge-m3"), { inputPer1M: 0.01, outputPer1M: 0 }, "bge-m3 (the model of the search by meaning) too");

// ── reading what the provider says ─────────────────────────────────────────────────────────────────────────
{
  const reported = readEmbeddingUsage({ usage: { prompt_tokens: 120, total_tokens: 120, cost: 0.0000031 } }, MODEL, ["x"]);
  same(reported, { model: MODEL, promptTokens: 120, totalTokens: 120, cost: 0.0000031 }, "the provider's own cost wins");

  const counted = readEmbeddingUsage({ usage: { prompt_tokens: 1000, total_tokens: 1000 } }, MODEL, ["x"]);
  same(counted.cost, 0.00002, "no reported cost: counted from the table (1000 tokens at $0.02 per million)");

  const cents = readEmbeddingUsage({ usage: { prompt_tokens: 5, total_tokens: 5 } }, MODEL, ["x"]);
  same(cents.cost, 1e-7, "a tiny call is not rounded away");

  const noUsage = readEmbeddingUsage({ data: [] }, MODEL, ["a".repeat(300), "b".repeat(300)]);
  same(noUsage.promptTokens, 200, "no usage at all: the tokens are estimated from the text (3 characters a token), never dropped");
  assert(noUsage.cost > 0, "and so the cost is not lost");

  const odd = readEmbeddingUsage({ usage: { prompt_tokens: "many", total_tokens: -4, cost: "free" } }, MODEL, ["abc"]);
  assert(odd.promptTokens >= 1 && Number.isFinite(odd.cost) && odd.cost >= 0, "nonsense in the answer does not produce nonsense in the log");
}
console.log("✓ reading the usage of an embeddings answer");

// ── the row that goes into ai_usage_logs ───────────────────────────────────────────────────────────────────
{
  const row = embeddingUsageInsert({ userId: "u1", conversationId: "c1" }, { model: MODEL, promptTokens: 120, totalTokens: 120, cost: 0.0000024 });
  same(
    row,
    {
      user_id: "u1",
      conversation_id: "c1",
      model: MODEL,
      prompt_tokens: 120,
      completion_tokens: 0,
      total_tokens: 120,
      memory_tokens: 0,
      summary_tokens: 0,
      cost: 0.0000024,
      call_kind: "embedding",
      cost_category: "automatic",
    },
    "the row",
  );
  same(embeddingUsageInsert({ userId: "u1" }, { model: MODEL, promptTokens: 1, totalTokens: 1, cost: 0 }).conversation_id, null, "no conversation is null");
}
console.log("✓ the row of an embeddings call");

// ── writing it ─────────────────────────────────────────────────────────────────────────────────────────────
{
  const inserted: Array<{ table: string; row: unknown }> = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: unknown) => {
        inserted.push({ table, row });
        return { error: null };
      },
    }),
  };
  await logEmbeddingUsage(client, { userId: "u1", conversationId: "c1" }, { model: MODEL, promptTokens: 10, totalTokens: 10, cost: 2e-7 });
  same(inserted.length, 1, "one row is written");
  same(inserted[0].table, "ai_usage_logs", "into the usage log");

  const failing = { from: () => ({ insert: async () => ({ error: { message: "db down" } }) }) };
  await logEmbeddingUsage(failing, { userId: "u1" }, { model: MODEL, promptTokens: 1, totalTokens: 1, cost: 0 }); // must not throw
  const throwing = { from: () => ({ insert: async () => { throw new Error("network"); } }) };
  await logEmbeddingUsage(throwing, { userId: "u1" }, { model: MODEL, promptTokens: 1, totalTokens: 1, cost: 0 }); // must not throw
}
console.log("✓ writing the row (a failing log never breaks the answer)");

// ── the embeddings call reports its usage ──────────────────────────────────────────────────────────────────
{
  const { createEmbeddings, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } = await import("./embeddings.ts");
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
  const realFetch = globalThis.fetch;
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const reports: unknown[] = [];

  try {
    globalThis.fetch = answer({ data: [{ index: 0, embedding: vector }], usage: { prompt_tokens: 30, total_tokens: 30, cost: 6e-7 } }) as typeof fetch;
    const vectors = await createEmbeddings(["hello"], { apiKey: "k", onUsage: (u) => { reports.push(u); } });
    same(vectors.length, 1, "the vectors still come back");
    same(reports, [{ model: EMBEDDING_MODEL, promptTokens: 30, totalTokens: 30, cost: 6e-7 }], "the usage is reported once, under the model that made the vectors");

    // The provider billed the call even if the vectors are then refused: the cost is reported first.
    reports.length = 0;
    globalThis.fetch = answer({ data: [{ index: 0, embedding: [1, 2, 3] }], usage: { prompt_tokens: 7, total_tokens: 7, cost: 1e-7 } }) as typeof fetch;
    let refused = false;
    try {
      await createEmbeddings(["hello"], { apiKey: "k", onUsage: (u) => { reports.push(u); } });
    } catch {
      refused = true;
    }
    assert(refused, "wrong vectors are still refused");
    same(reports.length, 1, "but the call that was paid is still written down");

    // A refused request costs nothing and writes nothing.
    reports.length = 0;
    globalThis.fetch = answer({ error: "nope" }, 500) as typeof fetch;
    try {
      await createEmbeddings(["hello"], { apiKey: "k", onUsage: (u) => { reports.push(u); } });
    } catch {
      // expected
    }
    same(reports.length, 0, "a failed request writes nothing");

    // A broken logger must never break the answer.
    globalThis.fetch = answer({ data: [{ index: 0, embedding: vector }], usage: { prompt_tokens: 1, total_tokens: 1 } }) as typeof fetch;
    const ok = await createEmbeddings(["hello"], { apiKey: "k", onUsage: () => { throw new Error("logger broke"); } });
    same(ok.length, 1, "a throwing logger does not fail the embeddings");

    // Without a logger nothing changes.
    const plain = await createEmbeddings(["hello"], { apiKey: "k" });
    same(plain.length, 1, "no logger, no change");
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log("✓ createEmbeddings reports what it cost");

// ── the chat gives every embeddings call a logger ──────────────────────────────────────────────────────────
{
  const chat = readFileSync(resolve("supabase/functions/staysee-chat/index.ts"), "utf8").replace(/\r/g, "");
  const embedConfigs = [...chat.matchAll(/embedConfig:\s*(?:embedApiKey\s*\?\s*)?\{[\s\S]*?\}/g)].map((m) => m[0]);
  assert(embedConfigs.length >= 2, `the chat builds the embeddings config in two places (${embedConfigs.length})`);
  for (const config of embedConfigs) assert(/onUsage/.test(config) && /logEmbeddingUsage/.test(config), `every embeddings config of the chat writes its cost: ${config.slice(0, 80)}`);
}
console.log("✓ the chat writes the cost of every embeddings call");

console.log("All embeddingUsage cases passed.");
