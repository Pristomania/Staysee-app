// The vectors for the search by meaning are made in Russia (Cloud.ru) first, with OpenRouter as the reserve.
// Measured on 28.11.2026: the two hosts of bge-m3 make the same vectors (closeness 1.00000 on 23 made-up messages),
// so the stored vectors stay usable and keep their label.
// Run: npx tsx --test supabase/functions/_shared/embeddingHosts.cases.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import { createEmbeddings, createQueryEmbedding, embeddingAccess, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type EmbeddingHostOutcome } from "./embeddings.ts";
import type { EmbeddingUsage } from "./embeddingUsage.ts";
import { cloudruIsPaused, pauseCloudru, resetSearchProvidersForTests } from "./searchProviders.ts";
import { OPENROUTER_PRIVATE_ROUTE } from "./openRouterPrivateRoute.ts";

const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8").replace(/\r/g, "");

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string[]; provider?: unknown };
}

/** Two hosts behind one fetch: each answers with the status it is told to, or hangs until the request is aborted. */
function stubHosts(cloudru: number | "hangs" | "bad-vectors", openrouter: number = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const isCloudru = url.includes("cloud.ru");
    const status = isCloudru ? cloudru : openrouter;
    if (status === "hangs") {
      return await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const size = status === "bad-vectors" ? 3 : EMBEDDING_DIMENSIONS;
    const code = status === "bad-vectors" ? 200 : status;
    return new Response(
      JSON.stringify(
        code === 200
          ? { data: body.input.map((_: string, index: number) => ({ index, embedding: Array(size).fill(isCloudru ? 0.1 : 0.2) })), usage: { prompt_tokens: 1000, total_tokens: 1000 } }
          : { message: "no" },
      ),
      { status: code },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function config(fetchImpl: typeof fetch, extra: { openrouterKey?: string; timeoutMs?: number } = {}) {
  const usage: EmbeddingUsage[] = [];
  const outcomes: EmbeddingHostOutcome[] = [];
  return {
    usage,
    outcomes,
    value: {
      apiKey: "openrouterKey" in extra ? extra.openrouterKey : "or-key",
      extraHeaders: { "X-Title": "StaySee AI" },
      cloudru: { apiKey: "ru-key", ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}) },
      fetchImpl,
      onUsage: (u: EmbeddingUsage) => { usage.push(u); },
      onHostOutcome: (o: EmbeddingHostOutcome) => { outcomes.push(o); },
    },
  };
}

describe("the vectors for the search by meaning: Cloud.ru first", () => {
  beforeEach(() => resetSearchProvidersForTests());

  it("asks Cloud.ru, under its name of the model and with its key, and does not touch OpenRouter", async () => {
    const hosts = stubHosts(200);
    const { value, usage, outcomes } = config(hosts.fetchImpl);
    const vectors = await createEmbeddings(["  привет \n мир  "], value);
    assert.equal(vectors.length, 1);
    assert.equal(vectors[0][0], 0.1);
    assert.equal(hosts.calls.length, 1);
    assert.equal(hosts.calls[0].url, "https://foundation-models.api.cloud.ru/v1/embeddings");
    assert.deepEqual(hosts.calls[0].body, { model: "BAAI/bge-m3", input: ["привет мир"] });
    assert.equal(hosts.calls[0].headers.Authorization, "Bearer ru-key");
    assert.equal(hosts.calls[0].headers["X-Title"], undefined, "the headers meant for OpenRouter do not go to Cloud.ru");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].model, "BAAI/bge-m3", "the cost is written under the Cloud.ru name, so it is counted at the Cloud.ru price");
    assert.equal(usage[0].cost, 0.0000068);
    assert.deepEqual(outcomes, [{ served: true }]);
  });

  it("keeps the label of the stored vectors: both hosts run the same model", () => {
    assert.equal(EMBEDDING_MODEL, "baai/bge-m3");
  });

  it("goes to the reserve when Cloud.ru refuses, through the private route, and leaves Cloud.ru alone for a while", async () => {
    const hosts = stubHosts(403);
    const { value, usage, outcomes } = config(hosts.fetchImpl);
    const vector = await createQueryEmbedding("что я говорила про море", value);
    assert.equal(vector[0], 0.2);
    assert.deepEqual(hosts.calls.map((c) => new URL(c.url).host), ["foundation-models.api.cloud.ru", "openrouter.ai"]);
    assert.equal(hosts.calls[1].body.model, "baai/bge-m3");
    assert.deepEqual(hosts.calls[1].body.provider, OPENROUTER_PRIVATE_ROUTE);
    assert.equal(hosts.calls[1].headers.Authorization, "Bearer or-key");
    assert.equal(hosts.calls[1].headers["X-Title"], "StaySee AI");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].model, "baai/bge-m3");
    assert.deepEqual(outcomes, [{ served: true, refusedStatus: 403, switchedBecause: "refused" }]);
    assert.equal(cloudruIsPaused(), true);

    await createQueryEmbedding("ещё раз", value);
    assert.equal(new URL(hosts.calls[2].url).host, "openrouter.ai", "during the pause Cloud.ru is not asked");
    assert.equal(hosts.calls.length, 3);
    assert.deepEqual(outcomes[1], { served: true, refusedStatus: 403, switchedBecause: "paused" });
  });

  it("goes to the reserve without a pause when Cloud.ru fails, answers with wrong vectors or does not answer", async () => {
    for (const failure of [500, "bad-vectors", "hangs"] as const) {
      resetSearchProvidersForTests();
      const hosts = stubHosts(failure);
      const { value, outcomes } = config(hosts.fetchImpl, { timeoutMs: 20 });
      const vectors = await createEmbeddings(["a", "b"], value);
      assert.equal(vectors.length, 2, `${failure}: the vectors come from the reserve`);
      assert.equal(vectors[0][0], 0.2);
      assert.deepEqual(outcomes, [{ served: true, switchedBecause: "unavailable" }], String(failure));
      assert.equal(cloudruIsPaused(), false, `${failure}: no pause`);
    }
  });

  it("asks Cloud.ru even during a pause when there is no reserve to go to", async () => {
    pauseCloudru(Date.now(), 402);
    const hosts = stubHosts(200);
    const { value, outcomes } = config(hosts.fetchImpl, { openrouterKey: undefined });
    await createEmbeddings(["a"], value);
    assert.equal(hosts.calls.length, 1);
    assert.equal(new URL(hosts.calls[0].url).host, "foundation-models.api.cloud.ru");
    assert.deepEqual(outcomes, [{ served: true }]);
    assert.equal(cloudruIsPaused(), false, "a good answer ends the pause");
  });

  it("fails and says why when neither host can make the vectors", async () => {
    const hosts = stubHosts(402, 403);
    const { value, outcomes } = config(hosts.fetchImpl);
    await assert.rejects(createEmbeddings(["a"], value), /embeddings_http_403/);
    assert.deepEqual(outcomes, [{ served: false, refusedStatus: 402, switchedBecause: "refused" }]);

    resetSearchProvidersForTests();
    const alone = config(stubHosts(401).fetchImpl, { openrouterKey: undefined });
    await assert.rejects(createEmbeddings(["a"], alone.value), /embeddings_http_401/);
    assert.deepEqual(alone.outcomes, [{ served: false, refusedStatus: 401, switchedBecause: "refused" }]);
  });

  it("does not let a broken alert fail the answer", async () => {
    const { value } = config(stubHosts(200).fetchImpl);
    const vectors = await createEmbeddings(["a"], { ...value, onHostOutcome: () => { throw new Error("alert broke"); } });
    assert.equal(vectors.length, 1);
  });
});

describe("which hosts a server has", () => {
  const headers = { "X-Title": "StaySee AI" };

  it("takes the hosts from the keys it has, and nothing when it has none", () => {
    assert.deepEqual(embeddingAccess({ cloudruKey: "ru", openrouterKey: "or", openrouterHeaders: headers }), {
      apiKey: "or",
      extraHeaders: headers,
      cloudru: { apiKey: "ru" },
    });
    assert.deepEqual(embeddingAccess({ cloudruKey: "ru", openrouterKey: "", openrouterHeaders: headers }), { cloudru: { apiKey: "ru" } });
    assert.deepEqual(embeddingAccess({ cloudruKey: undefined, openrouterKey: "or", openrouterHeaders: headers }), { apiKey: "or", extraHeaders: headers });
    assert.equal(embeddingAccess({ cloudruKey: undefined, openrouterKey: undefined, openrouterHeaders: headers }), undefined);
  });

  it("is how the chat chooses, whatever model writes the replies, with an alert when Cloud.ru refuses", () => {
    assert.match(
      chat,
      /embeddingAccess\(\{\s*cloudruKey: Deno\.env\.get\(CLOUDRU_API_KEY_ENV\)[\s\S]{0,80}openrouterKey: Deno\.env\.get\(PROVIDERS\.openrouter\.envKey\)[\s\S]{0,120}openrouterHeaders: PROVIDERS\.openrouter\.extraHeaders/,
    );
    assert.match(chat, /onHostOutcome: async \(outcome: EmbeddingHostOutcome\) => \{\s*const kind = searchAlertKind\(outcome\);\s*if \(kind\) await sendProviderAlertSafely\(kind\);/);
    // The vectors no longer take the key of the model that writes the replies.
    assert.doesNotMatch(chat, /embedApiKey/);
    assert.equal((chat.match(/embedConfig: embedAccess\b|embedConfig: \{\s*\.\.\.embedAccess,/g) ?? []).length, 2, "both places that make vectors use it");
  });
});
