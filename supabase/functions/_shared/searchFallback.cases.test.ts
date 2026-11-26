import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { searchConversationArchive } from "./conversationRetrieval.ts";
import { searchAlertKind } from "./providerAlert.ts";
import { askRecallGateWithFallback } from "./recallGate.ts";
import { rerankViaOpenRouter, rerankWithFallback } from "./reranker.ts";
import {
  CLOUDRU_PAUSE_MS,
  FALLBACK_RERANK_MODEL,
  FALLBACK_RERANK_THRESHOLD,
  OPENROUTER_RERANK_URL,
  cloudruIsPaused,
  resetSearchProvidersForTests,
  resolveFallbackRerankThreshold,
} from "./searchProviders.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const PRIVATE_ROUTE = { data_collection: "deny", zdr: true };

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A host that answers the given statuses one after another (the last one repeats) and remembers what it was asked. */
function host(answers: Array<{ status: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.json ?? {}, text: async () => "" };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const gateAnswer = (recall: boolean, query: string, usage: Record<string, number> = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) => ({
  status: 200,
  json: { choices: [{ message: { content: JSON.stringify({ recall, query }) } }], usage },
});

beforeEach(() => resetSearchProvidersForTests());
afterEach(() => resetSearchProvidersForTests());

describe("the small model: Cloud.ru first, the reserve on OpenRouter when Cloud.ru refuses", () => {
  it("asks only Cloud.ru while it answers", async () => {
    const cloudru = host([gateAnswer(true, "бабушка")]);
    const openrouter = host([gateAnswer(true, "не должна быть спрошена")]);
    const result = await askRecallGateWithFallback("помнишь про мою бабушку?", {
      cloudru: { apiKey: "c", fetchImpl: cloudru.fetchImpl },
      openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl },
    });
    assert.deepEqual(result.decision, { recall: true, query: "бабушка" });
    assert.equal(result.provider, "cloudru");
    assert.equal(result.switchedBecause, undefined);
    assert.equal(openrouter.calls.length, 0);
  });

  it("an empty balance (403 «Project not found») sends the same question to OpenRouter through the private route", async () => {
    const cloudru = host([{ status: 403 }]);
    const openrouter = host([gateAnswer(true, "бабушка", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0000162 } as never)]);
    const result = await askRecallGateWithFallback("помнишь про мою бабушку?", {
      cloudru: { apiKey: "c", fetchImpl: cloudru.fetchImpl },
      openrouter: { apiKey: "o", extraHeaders: { "X-Title": "StaySee AI" }, fetchImpl: openrouter.fetchImpl },
    });
    assert.deepEqual(result.decision, { recall: true, query: "бабушка" });
    assert.equal(result.provider, "openrouter");
    assert.equal(result.switchedBecause, "refused");
    assert.equal(result.refusedStatus, 403);
    assert.equal(result.usage?.costUsd, 0.0000162, "the cost the host states goes to the cost log as it is");
    assert.equal(openrouter.calls.length, 1);
    const call = openrouter.calls[0];
    assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(call.headers.Authorization, "Bearer o");
    assert.equal(call.headers["X-Title"], "StaySee AI");
    assert.equal(call.body.model, "openai/gpt-oss-120b");
    assert.deepEqual(call.body.provider, { ...PRIVATE_ROUTE, ignore: ["Google"] }, "the private route: no collection of data, zero retention; without the host that cuts answers off");
    assert.deepEqual(call.body.reasoning, { effort: "low", exclude: true });
    assert.deepEqual(call.body.usage, { include: true });
    assert.equal(cloudruIsPaused(), true, "Cloud.ru is left alone after the refusal");
  });

  it("while Cloud.ru is paused the next messages go straight to OpenRouter; after the pause it is asked again and a good answer ends it", async () => {
    const cloudru = host([{ status: 402 }, gateAnswer(false, "")]);
    const openrouter = host([gateAnswer(true, "поездка")]);
    const config = (now: number) => ({
      cloudru: { apiKey: "c", fetchImpl: cloudru.fetchImpl },
      openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl },
      now,
    });
    const t0 = 1_000_000;
    await askRecallGateWithFallback("первый", config(t0));
    assert.equal(cloudru.calls.length, 1);

    const paused = await askRecallGateWithFallback("второй", config(t0 + 60_000));
    assert.equal(cloudru.calls.length, 1, "Cloud.ru is not asked during the pause");
    assert.equal(paused.switchedBecause, "paused");
    assert.equal(paused.refusedStatus, 402, "the alert still knows what the refusal was");
    assert.equal(openrouter.calls.length, 2);

    const back = await askRecallGateWithFallback("третий", config(t0 + CLOUDRU_PAUSE_MS + 1));
    assert.equal(cloudru.calls.length, 2, "after the pause Cloud.ru is asked again");
    assert.equal(back.provider, "cloudru");
    assert.equal(cloudruIsPaused(t0 + CLOUDRU_PAUSE_MS + 2), false, "its good answer ends the pause");
    assert.equal(openrouter.calls.length, 2);
  });

  it("a timeout or a server error of Cloud.ru uses the reserve for that message only (no pause)", async () => {
    const cloudru = host([{ status: 503 }, gateAnswer(true, "работа")]);
    const openrouter = host([gateAnswer(true, "работа")]);
    const config = { cloudru: { apiKey: "c", fetchImpl: cloudru.fetchImpl }, openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl } };
    const first = await askRecallGateWithFallback("раз", config);
    assert.equal(first.switchedBecause, "unavailable");
    assert.equal(cloudruIsPaused(), false);
    const second = await askRecallGateWithFallback("два", config);
    assert.equal(second.provider, "cloudru", "the next message asks Cloud.ru again");
  });

  it("when neither host answers the result says so, with the refusal of Cloud.ru, and the alert is the one about the balance", async () => {
    const cloudru = host([{ status: 402 }]);
    const openrouter = host([{ status: 500 }]);
    const result = await askRecallGateWithFallback("помнишь?", {
      cloudru: { apiKey: "c", fetchImpl: cloudru.fetchImpl },
      openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl },
    });
    assert.equal(result.decision, null);
    assert.equal(result.failure, "unavailable");
    assert.equal(result.refusedStatus, 402);
    assert.equal(searchAlertKind({ served: result.decision !== null || !result.failure, refusedStatus: result.refusedStatus, switchedBecause: result.switchedBecause }), "search_balance_empty");
  });

  it("without an OpenRouter key it is the Cloud.ru result as it was; an unreadable answer is not a failure of the host (no second call)", async () => {
    const refused = host([{ status: 403 }]);
    const alone = await askRecallGateWithFallback("помнишь?", { cloudru: { apiKey: "c", fetchImpl: refused.fetchImpl } });
    assert.equal(alone.decision, null);
    assert.equal(alone.refusedStatus, 403);
    resetSearchProvidersForTests();

    const garbled = host([{ status: 200, json: { choices: [{ message: { content: "не json" } }] } }]);
    const openrouter = host([gateAnswer(true, "x")]);
    const result = await askRecallGateWithFallback("помнишь?", {
      cloudru: { apiKey: "c", fetchImpl: garbled.fetchImpl },
      openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl },
    });
    assert.equal(result.decision, null);
    assert.equal(openrouter.calls.length, 0);
  });

  it("works with the OpenRouter key alone (Cloud.ru not configured)", async () => {
    const openrouter = host([gateAnswer(true, "город")]);
    const result = await askRecallGateWithFallback("в каком городе я живу?", { openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl } });
    assert.deepEqual(result.decision, { recall: true, query: "город" });
    assert.equal(result.provider, "openrouter");
    assert.equal(result.switchedBecause, undefined, "nothing was switched: there was no Cloud.ru to begin with");
  });
});

const scoreAnswer = (scores: number[], extra: Record<string, unknown> = {}) => ({
  status: 200,
  json: { results: scores.map((relevance_score, index) => ({ index, relevance_score })), usage: { total_tokens: 272, cost: 0.0000544 }, ...extra },
});

describe("the reranker: Cloud.ru first, the open reserve on OpenRouter when Cloud.ru refuses", () => {
  it("the reserve request: the model, the private route, the key, and the cost it states goes to the log", async () => {
    const openrouter = host([scoreAnswer([0.95, 0.0001])]);
    const usages: Array<{ totalTokens: number; costUsd?: number }> = [];
    const scores = await rerankViaOpenRouter("как зовут сестру", ["Мою сестру зовут Ксения.", "мне тяжело"], {
      apiKey: "o", extraHeaders: { "X-Title": "StaySee AI" }, fetchImpl: openrouter.fetchImpl, onUsage: (u) => void usages.push(u),
    });
    assert.deepEqual(scores, [0.95, 0.0001]);
    const call = openrouter.calls[0];
    assert.equal(call.url, OPENROUTER_RERANK_URL);
    assert.equal(call.body.model, FALLBACK_RERANK_MODEL);
    assert.equal(FALLBACK_RERANK_MODEL, "qwen/qwen3-reranker-8b");
    assert.deepEqual(call.body.provider, PRIVATE_ROUTE);
    assert.equal(call.headers.Authorization, "Bearer o");
    assert.deepEqual(usages, [{ totalTokens: 272, costUsd: 0.0000544 }]);
  });

  it("Cloud.ru scores while it answers; on a refusal the reserve scores, and the pause keeps Cloud.ru out for a while", async () => {
    const cloudru = host([scoreAnswer([0.9, 0.001]), { status: 403 }]);
    const openrouter = host([scoreAnswer([0.8, 0.0002])]);
    const config = (now: number) => ({
      cloudru: { apiKey: "c", fetchImpl: cloudru.fetchImpl },
      openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl },
      now,
    });
    const docs = ["Мою сестру зовут Ксения.", "мне тяжело"];

    const ok = await rerankWithFallback("сестра", docs, config(1_000));
    assert.equal(ok.provider, "cloudru");
    assert.equal(openrouter.calls.length, 0);

    const refused = await rerankWithFallback("сестра", docs, config(2_000));
    assert.equal(refused.provider, "openrouter");
    assert.deepEqual(refused.scores, [0.8, 0.0002]);
    assert.equal(refused.refusedStatus, 403);
    assert.equal(refused.switchedBecause, "refused");

    const paused = await rerankWithFallback("сестра", docs, config(3_000));
    assert.equal(paused.provider, "openrouter");
    assert.equal(paused.switchedBecause, "paused");
    assert.equal(paused.refusedStatus, 403);
    assert.equal(cloudru.calls.length, 2, "no call to Cloud.ru during the pause");
  });

  it("when neither host scores, the scores are null (the threshold on the vectors takes over) and the refusal is reported", async () => {
    const cloudru = host([{ status: 402 }]);
    const openrouter = host([{ status: 500 }]);
    const result = await rerankWithFallback("сестра", ["a"], { cloudru: { apiKey: "c", fetchImpl: cloudru.fetchImpl }, openrouter: { apiKey: "o", fetchImpl: openrouter.fetchImpl } });
    assert.equal(result.scores, null);
    assert.equal(result.provider, null);
    assert.equal(result.refusedStatus, 402);
  });

  it("the reserve has its own threshold (its scores are sharper): 0.01 by default, changeable, never nonsense", () => {
    assert.equal(FALLBACK_RERANK_THRESHOLD, 0.01);
    assert.equal(resolveFallbackRerankThreshold(undefined), 0.01);
    assert.equal(resolveFallbackRerankThreshold("0.02"), 0.02);
    for (const bad of ["", "abc", "0", "-1", "1", "5"]) assert.equal(resolveFallbackRerankThreshold(bad), 0.01, bad);
  });
});

describe("the search uses the threshold of the host that scored, and reports who scored", () => {
  interface Row { id: string; sender: string; role: string | null; content: string; created_at: string }
  const start = Date.parse("2026-01-01T10:00:00Z");
  const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
    id: `m${String(i).padStart(5, "0")}`,
    sender: i % 2 === 0 ? "user" : "ai",
    role: null,
    content: i === 20 ? "я хожу на йогу по вторникам и мне там спокойно" : i === 30 ? "купила новые кроссовки для бега, красные" : i % 2 === 0 ? `обычная реплика номер ${i}` : `ответ номер ${i}`,
    created_at: new Date(start + i * 60_000).toISOString(),
  }));
  const hit = (row: Row, similarity: number) => ({ message_id: row.id, sender: row.sender, role: null, content: row.content, created_at: row.created_at, similarity, reply_sender: null, reply_role: null, reply_content: null });

  function userClient() {
    return {
      rpc: () => Promise.resolve({ data: [hit(rows[20], 0.7), hit(rows[30], 0.5)], error: null }),
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          order: () => query,
          range: (from: number, to: number) => Promise.resolve({ data: [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(from, to + 1), error: null }),
        };
        return query;
      },
    } as never;
  }

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubProviders(cloudruStatus: number) {
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/rerank") && String(url).includes("cloud.ru")) {
        if (cloudruStatus !== 200) return { ok: false, status: cloudruStatus, json: async () => ({}), text: async () => "" };
        const results = body.documents.map((text: string, index: number) => ({ index, relevance_score: text.includes("йог") ? 0.9 : 0.02 }));
        return { ok: true, status: 200, json: async () => ({ usage: { total_tokens: 50 }, results }), text: async () => "" };
      }
      if (String(url).endsWith("/rerank")) {
        // the reserve: sharp scores, the sneakers line at 0.02 is above its threshold 0.01
        const results = body.documents.map((text: string, index: number) => ({ index, relevance_score: text.includes("йог") ? 0.9 : text.includes("кроссовки") ? 0.02 : 0.0001 }));
        return { ok: true, status: 200, json: async () => ({ usage: { total_tokens: 50, cost: 0.00001 }, results }), text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => "", json: async () => ({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1024).fill(0.01) })), usage: { prompt_tokens: 5, total_tokens: 5, cost: 0 } }) };
    }) as never;
  }

  async function run(cloudruStatus: number) {
    stubProviders(cloudruStatus);
    const outcomes: unknown[] = [];
    const result = await searchConversationArchive(userClient(), {
      conversationId: "c1",
      query: "помнишь, я говорила про йогу?",
      excludeTailCount: 6,
      userId: "u1",
      embedConfig: { apiKey: "key" },
      supabaseService: { rpc: () => Promise.resolve({ data: [], error: null }), from: () => ({ upsert: () => Promise.resolve({ error: null }) }) } as never,
      decision: { recall: true, query: "йога по вторникам" },
      rerank: { apiKey: "cloudru-key", url: "https://foundation-models.api.cloud.ru/rerank" },
      rerankFallback: { apiKey: "openrouter-key" },
      rerankThreshold: 0.05,
      rerankFallbackThreshold: 0.01,
      onRerankOutcome: (o) => void outcomes.push(o),
    });
    return { result, outcomes };
  }

  it("Cloud.ru scores: its threshold 0.05 drops the sneakers line (0.02)", async () => {
    const { result, outcomes } = await run(200);
    assert.deepEqual(result.excerpts.map((e) => e.userText.includes("йог")), [true]);
    assert.deepEqual(outcomes, [{ provider: "cloudru", refusedStatus: undefined, switchedBecause: undefined }]);
  });

  it("the reserve scores after a refusal: its own threshold 0.01 keeps the line at 0.02, and the outcome says who scored and why", async () => {
    const { result, outcomes } = await run(403);
    assert.deepEqual(result.excerpts.map((e) => e.userText.includes("йог")), [true, false]);
    assert.deepEqual(outcomes, [{ provider: "openrouter", refusedStatus: 403, switchedBecause: "refused" }]);
  });
});

describe("which alert the search raises", () => {
  it("calm when the reserve answered because Cloud.ru refused; the old ones only when nobody answered; none for a plain timeout", () => {
    assert.equal(searchAlertKind({ served: true, refusedStatus: 403, switchedBecause: "refused" }), "search_switched");
    assert.equal(searchAlertKind({ served: true, switchedBecause: "paused" }), "search_switched");
    assert.equal(searchAlertKind({ served: true, switchedBecause: "unavailable" }), null);
    assert.equal(searchAlertKind({ served: true }), null);
    assert.equal(searchAlertKind({ served: false, refusedStatus: 402 }), "search_balance_empty");
    assert.equal(searchAlertKind({ served: false, refusedStatus: 403 }), "search_key_rejected");
    assert.equal(searchAlertKind({ served: false, refusedStatus: 401 }), "search_key_rejected");
    assert.equal(searchAlertKind({ served: false }), null);
  });
});

describe("the chat and the guards", () => {
  const chat = read("../staysee-chat/index.ts");

  it("the chat asks the small model with the reserve, hands the reranker its reserve and its threshold, and raises the alert by the outcome", () => {
    assert.match(chat, /askRecallGateWithFallback\(message, \{ cloudru: cloudruKey \? \{ apiKey: cloudruKey \} : undefined, openrouter: openrouterAccess \}\)/);
    assert.match(chat, /rerankFallback: openrouterAccess/);
    assert.match(chat, /rerankFallbackThreshold: resolveFallbackRerankThreshold\(Deno\.env\.get\("STAYSEE_RERANK_THRESHOLD_FALLBACK"\)\)/);
    assert.match(chat, /onRerankOutcome: async \(outcome\) => \{[\s\S]*searchAlertKind\(/);
    assert.match(chat, /const kind = searchAlertKind\(\{\s*served: recallGate\.decision !== null \|\| !recallGate\.failure/);
  });

  it("the spend of the reserve is in the cost log with the cost the host states, under its own names", () => {
    assert.match(chat, /model: onReserve \? `\$\{RECALL_GATE_MODEL\}@openrouter` : RECALL_GATE_MODEL/);
    assert.match(chat, /model: FALLBACK_RERANK_MODEL,[\s\S]{0,500}callKind: "recall_rerank"/);
    assert.match(read("./openRouterPricing.ts"), /"qwen\/qwen3-reranker-8b": \{ inputPer1M: 0\.2/);
  });

  it("every request to OpenRouter in the search carries the private route", () => {
    for (const file of ["./recallGate.ts", "./reranker.ts"]) {
      const code = read(file);
      assert.match(code, /OPENROUTER_PRIVATE_ROUTE/, file);
    }
    // the whole private route, narrowed by one host (recallGate.ts)
    assert.match(read("./recallGate.ts"), /provider: \{ \.\.\.OPENROUTER_PRIVATE_ROUTE, ignore: \["Google"\] \}/);
    assert.match(read("./reranker.ts"), /provider: OPENROUTER_PRIVATE_ROUTE/);
  });
});
