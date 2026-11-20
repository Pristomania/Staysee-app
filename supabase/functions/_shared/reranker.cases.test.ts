import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_RERANK_THRESHOLD, RERANK_MODEL, RERANK_URL, readRerankScores, rerankLines, resolveRerankThreshold } from "./reranker.ts";

/** A reranker that scores every document by a function of its text, answers in a shuffled order, and remembers what it was sent. */
function stubReranker(scoreOf: (text: string) => number, usageTokens = 100) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: { model: string; query: string; documents: string[] } }> = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const results = body.documents.map((text: string, index: number) => ({ index, document: { text }, relevance_score: scoreOf(text) })).reverse();
    return { ok: true, status: 200, json: async () => ({ model: RERANK_MODEL, usage: { prompt_tokens: usageTokens, total_tokens: usageTokens }, results }) };
  }) as never;
  return { calls, fetchImpl };
}

describe("the reranker that sorts the found lines", () => {
  it("has a measured default threshold, which a sensible setting can change", () => {
    assert.equal(DEFAULT_RERANK_THRESHOLD, 0.05);
    assert.equal(resolveRerankThreshold(undefined), 0.05);
    assert.equal(resolveRerankThreshold("0.1"), 0.1);
    assert.equal(resolveRerankThreshold("0"), 0.05);
    assert.equal(resolveRerankThreshold("1.5"), 0.05);
    assert.equal(resolveRerankThreshold("abc"), 0.05);
  });

  it("puts the scores back in the order of the documents, whatever the order of the answer", () => {
    const data = { results: [{ index: 2, relevance_score: 0.3 }, { index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] };
    assert.deepEqual(readRerankScores(data, 3), [0.9, 0.1, 0.3]);
  });

  it("takes nothing for scores when the answer is not what is expected", () => {
    assert.equal(readRerankScores(null, 1), null);
    assert.equal(readRerankScores({}, 1), null);
    assert.equal(readRerankScores({ results: [{ index: 0, relevance_score: 0.5 }] }, 2), null, "a missing score");
    assert.equal(readRerankScores({ results: [{ index: 5, relevance_score: 0.5 }] }, 1), null, "an index outside the documents");
    assert.equal(readRerankScores({ results: [{ index: 0, relevance_score: "high" }] }, 1), null);
  });

  it("sends the phrase and the lines to Cloud.ru, 20 at a time, and returns one score per line in order", async () => {
    const { calls, fetchImpl } = stubReranker((text) => (text.startsWith("№7") ? 0.8 : 0.01));
    const documents = Array.from({ length: 45 }, (_, i) => `№${i} ${"я".repeat(2000)}`);
    const scores = await rerankLines("любимый цвет", documents, { apiKey: "secret", fetchImpl });

    assert.ok(scores);
    assert.equal(scores.length, 45);
    assert.equal(scores[7], 0.8);
    assert.equal(scores[8], 0.01);
    assert.equal(calls.length, 3, "20 + 20 + 5");
    assert.deepEqual(calls.map((c) => c.body.documents.length), [20, 20, 5]);
    for (const call of calls) {
      assert.equal(call.url, RERANK_URL);
      assert.equal(call.url, "https://foundation-models.api.cloud.ru/rerank");
      assert.equal(call.body.model, "BAAI/bge-reranker-v2-m3");
      assert.equal(call.body.query, "любимый цвет");
      assert.equal(call.headers.Authorization, "Bearer secret");
      assert.ok(call.body.documents.every((d) => d.length <= 1200), "a long line is cut");
    }
  });

  it("reports what every call cost, once per call, and a failing report never breaks the search", async () => {
    const { fetchImpl } = stubReranker(() => 0.5, 77);
    const usages: number[] = [];
    await rerankLines("q", Array.from({ length: 25 }, (_, i) => `строка ${i}`), { apiKey: "k", fetchImpl, onUsage: (u) => void usages.push(u.totalTokens) });
    assert.deepEqual(usages, [77, 77]);

    const scores = await rerankLines("q", ["строка"], {
      apiKey: "k",
      fetchImpl,
      onUsage: () => {
        throw new Error("log down");
      },
    });
    assert.deepEqual(scores, [0.5]);
  });

  it("asks nothing for nothing, and returns null (never a made-up score) when the provider fails", async () => {
    const { calls, fetchImpl } = stubReranker(() => 1);
    assert.deepEqual(await rerankLines("q", [], { apiKey: "k", fetchImpl }), []);
    assert.equal(calls.length, 0);

    const down = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never;
    assert.equal(await rerankLines("q", ["a"], { apiKey: "k", fetchImpl: down }), null);
    const thrown = (async () => {
      throw new Error("network");
    }) as never;
    assert.equal(await rerankLines("q", ["a"], { apiKey: "k", fetchImpl: thrown }), null);
    const odd = (async () => ({ ok: true, status: 200, json: async () => ({ answer: "?" }) })) as never;
    assert.equal(await rerankLines("q", ["a"], { apiKey: "k", fetchImpl: odd }), null);
  });
});
