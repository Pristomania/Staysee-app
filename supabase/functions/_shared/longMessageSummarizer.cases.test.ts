import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLongMessageSummarizer } from "./longMessageSummarizer.ts";

const okBody = {
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Человек пишет о ссоре с дочерью." } }],
  usage: { prompt_tokens: 2_900, completion_tokens: 180, cost: 0.001 },
};
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("long message summarizer", () => {
  it("sends one private request to OpenRouter with the text and returns the short version with its usage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const summarize = createLongMessageSummarizer({
      apiKey: "test-key",
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init: init as RequestInit }); return jsonResponse(okBody); },
    });
    const result = await summarize("Длинный текст человека");
    assert.deepEqual(result, {
      summary: "Человек пишет о ссоре с дочерью.",
      usage: { promptTokens: 2_900, completionTokens: 180, costUsd: 0.001 },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-key");
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, "google/gemini-3.7-flash");
    assert.deepEqual(body.provider, { allow_fallbacks: true, data_collection: "deny", zdr: true });
    assert.equal(body.messages.at(-1).content, "Длинный текст человека");
  });

  it("returns null, and never throws, for a provider error, a broken answer, a network failure or no key", async () => {
    const attempts: Array<() => Promise<Response>> = [
      async () => jsonResponse({ error: "boom" }, 500),
      async () => jsonResponse({ error: "rate" }, 429),
      async () => new Response("not json", { status: 200 }),
      async () => jsonResponse({ choices: [] }),
      async () => { throw new Error("network down"); },
    ];
    for (const attempt of attempts) {
      const summarize = createLongMessageSummarizer({ apiKey: "k", fetchImpl: async () => attempt() });
      assert.equal(await summarize("текст"), null);
    }
    const noKey = createLongMessageSummarizer({ apiKey: "", fetchImpl: async () => { throw new Error("must not be called"); } });
    assert.equal(await noKey("текст"), null);
  });

  it("gives up after the time limit instead of holding the reply", async () => {
    const summarize = createLongMessageSummarizer({
      apiKey: "k",
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    const started = Date.now();
    assert.equal(await summarize("текст"), null);
    assert.ok(Date.now() - started < 2_000);
  });
});
