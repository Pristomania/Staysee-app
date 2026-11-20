import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOffAppUsageRow, createOffAppUsageRecorder, offAppKind, wrapForOffAppUsage } from "./off-app-usage-log.mjs";

// The cost of a call made outside the app is written into the same log the app writes. Everything here is made up: no network, no key.

const URL_DB = "https://db.example.invalid";
const KEY = "service-key-that-must-never-be-printed";
const CHAT = "https://openrouter.ai/api/v1/chat/completions";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** One recorder with a fake database write and a fake provider; `inserts` collects what would be written. */
function setup({ provider, insertStatus = 201, loadPricing } = {}) {
  const inserts = [];
  const warnings = [];
  const dbFetch = async (url, init) => {
    inserts.push({ url, init, row: JSON.parse(init.body) });
    return new Response(null, { status: insertStatus });
  };
  const recorder = createOffAppUsageRecorder({
    supabaseUrl: URL_DB,
    serviceRoleKey: KEY,
    what: "stacy-eval",
    fetchImpl: dbFetch,
    warn: (message) => warnings.push(message),
    retries: 1,
    ...(loadPricing ? { loadPricing } : {}),
  });
  const wrapped = recorder.wrapFetch(provider ?? (async () => jsonResponse({})));
  return { recorder, wrapped, inserts, warnings };
}

const chatBody = { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] };
const post = (body = chatBody) => ({ method: "POST", body: JSON.stringify(body) });

describe("what a call made outside the app is written as", () => {
  it("the kind says what the run was for, in a tidy slug", () => {
    assert.equal(offAppKind("stacy-eval"), "offapp:stacy-eval");
    assert.equal(offAppKind("Stacy Eval #1"), "offapp:stacy-eval-1");
    assert.throws(() => offAppKind(""), /say what the run is for/);
    assert.throws(() => offAppKind("только по-русски"), /say what the run is for/);
  });

  it("a row has no person, is technical, and carries tokens, money and the kind", () => {
    const row = buildOffAppUsageRow({
      what: "stacy-eval",
      model: "openai/gpt-4o",
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      cost: 0.0123,
      finishReason: "stop",
      latencyMs: 812.4,
    });
    assert.deepEqual(row, {
      user_id: null,
      model: "openai/gpt-4o",
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      cost: 0.0123,
      cost_category: "technical",
      call_kind: "offapp:stacy-eval",
      finish_reason: "stop",
      latency_ms: 812,
      error_code: null,
    });
  });

  it("what is unknown stays empty or zero, never invented", () => {
    const row = buildOffAppUsageRow({ what: "x", model: "", usage: null, cost: Number.NaN });
    assert.equal(row.model, "unknown");
    assert.equal(row.cost, 0);
    assert.equal(row.total_tokens, 0);
    assert.equal(row.finish_reason, null);
    assert.equal(row.latency_ms, null);
  });
});

describe("a run that cannot write its costs does not spend", () => {
  it("no database address or no key: it refuses, and says which", () => {
    assert.throws(() => createOffAppUsageRecorder({ supabaseUrl: "", serviceRoleKey: KEY, what: "x" }), /VITE_SUPABASE_URL/);
    assert.throws(() => createOffAppUsageRecorder({ supabaseUrl: URL_DB, serviceRoleKey: "", what: "x" }), /SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("through the usual way in, the first paid call is refused BEFORE it is sent; a call that is not a chat call, and a dry run, are not", async () => {
    const sent = [];
    const provider = async (input) => (sent.push(String(input)), jsonResponse({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.1 } }));
    const guarded = wrapForOffAppUsage(provider, "x", { env: {} });

    await assert.rejects(guarded(CHAT, post()), /не заданы VITE_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY/);
    assert.deepEqual(sent, [], "nothing reached the provider, so nothing was spent");

    await guarded("https://openrouter.ai/api/v1/models");
    assert.equal(sent.length, 1, "a call that is not a chat call goes through");
  });

  it("a run that does not say what it is for is refused at once", () => {
    assert.throws(() => wrapForOffAppUsage(async () => new Response(), "", { env: {} }), /say what the run is for/);
  });

  it("the key is never part of an error", () => {
    try {
      createOffAppUsageRecorder({ supabaseUrl: "", serviceRoleKey: KEY, what: "x" });
    } catch (error) {
      assert.doesNotMatch(String(error.message), new RegExp(KEY));
    }
  });
});

describe("a chat call made through the wrapped fetch", () => {
  it("is written once, with the cost the provider reports, and the caller still gets the answer", async () => {
    const answer = { model: "openai/gpt-4o-2024-08-06", usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550, cost: 0.0031 }, choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
    const { wrapped, inserts } = setup({ provider: async () => jsonResponse(answer) });

    const response = await wrapped(CHAT, post());

    assert.deepEqual(await response.json(), answer, "the answer is still readable after it was inspected");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].url, `${URL_DB}/rest/v1/ai_usage_logs`);
    assert.equal(inserts[0].init.headers.apikey, KEY);
    assert.equal(inserts[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(inserts[0].row.cost, 0.0031);
    assert.equal(inserts[0].row.model, "openai/gpt-4o-2024-08-06");
    assert.equal(inserts[0].row.call_kind, "offapp:stacy-eval");
    assert.equal(inserts[0].row.cost_category, "technical");
    assert.equal(inserts[0].row.user_id, null);
    assert.equal(inserts[0].row.finish_reason, "stop");
    assert.equal(inserts[0].row.error_code, null);
  });

  it("without a reported cost it is counted from the app's table of prices", async () => {
    const answer = { model: "deepseek-ai/DeepSeek-V4-Pro", usage: { prompt_tokens: 1000, completion_tokens: 500 }, choices: [{ finish_reason: "stop" }] };
    const { wrapped, inserts } = setup({ provider: async () => jsonResponse(answer) });
    await wrapped("https://foundation-models.api.cloud.ru/v1/chat/completions", post({ model: "deepseek-ai/DeepSeek-V4-Pro" }));
    // 1000 * 2.033 + 500 * 8.133 per million tokens
    assert.equal(inserts[0].row.cost, 0.0060995);
    assert.equal(inserts[0].row.error_code, null);
  });

  it("when the prices cannot be loaded, the cost is 0 and marked, loudly", async () => {
    const answer = { usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const { wrapped, inserts, warnings } = setup({
      provider: async () => jsonResponse(answer),
      loadPricing: async () => {
        throw new Error("cannot read");
      },
    });
    await wrapped(CHAT, post());
    assert.equal(inserts[0].row.cost, 0);
    assert.equal(inserts[0].row.error_code, "cost_unknown");
    assert.ok(warnings.some((message) => /цену этого вызова посчитать не удалось/.test(message)));
  });

  it("an answer with no usage is written with 0 and marked, loudly", async () => {
    const { wrapped, inserts, warnings } = setup({ provider: async () => jsonResponse({ choices: [] }) });
    await wrapped(CHAT, post());
    assert.equal(inserts[0].row.cost, 0);
    assert.equal(inserts[0].row.error_code, "usage_missing");
    assert.ok(warnings.some((message) => /usage_missing/.test(message)));
  });

  it("a stream cannot be counted: written with 0 and marked, loudly", async () => {
    const { wrapped, inserts, warnings } = setup({ provider: async () => new Response("data: x\n\n", { status: 200 }) });
    await wrapped(CHAT, post({ ...chatBody, stream: true }));
    assert.equal(inserts[0].row.error_code, "usage_not_counted_stream");
    assert.ok(warnings.some((message) => /usage_not_counted_stream/.test(message)));
  });

  it("a refusal by the provider is written with its status; the money it still reports is kept", async () => {
    const { wrapped, inserts } = setup({ provider: async () => jsonResponse({ error: { message: "nope" } }, 429) });
    await wrapped(CHAT, post());
    assert.equal(inserts[0].row.error_code, "http_429");
    assert.equal(inserts[0].row.cost, 0);
  });

  it("a call that fails on the network is written, and the failure still reaches the caller", async () => {
    const { wrapped, inserts } = setup({
      provider: async () => {
        throw new Error("socket closed");
      },
    });
    await assert.rejects(wrapped(CHAT, post()), /socket closed/);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].row.error_code, "request_failed");
    assert.equal(inserts[0].row.model, "openai/gpt-4o");
  });

  it("an embeddings call (vectors for the memory search) is paid too, and is written the same way", async () => {
    const answer = { model: "openai/text-embedding-3-small", usage: { prompt_tokens: 120, total_tokens: 120, cost: 0.0000024 }, data: [{ embedding: [0.1] }] };
    const { wrapped, inserts } = setup({ provider: async () => jsonResponse(answer) });
    const response = await wrapped("https://openrouter.ai/api/v1/embeddings", post({ model: "openai/text-embedding-3-small", input: "x" }));
    assert.deepEqual(await response.json(), answer);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].row.cost, 0.0000024);
    assert.equal(inserts[0].row.prompt_tokens, 120);
    assert.equal(inserts[0].row.model, "openai/text-embedding-3-small");
    assert.equal(inserts[0].row.call_kind, "offapp:stacy-eval");
  });

  it("a request that is not a paid call is passed on untouched and not written", async () => {
    const seen = [];
    const { wrapped, inserts } = setup({ provider: async (input) => (seen.push(input), jsonResponse({ ok: true })) });
    await wrapped("https://openrouter.ai/api/v1/models");
    assert.equal(seen.length, 1);
    assert.equal(inserts.length, 0);
  });

  it("the write to the database is not itself counted (no loop)", async () => {
    const { wrapped, inserts } = setup({ provider: async () => jsonResponse({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.1 } }) });
    await wrapped(CHAT, post());
    await wrapped(CHAT, post());
    assert.equal(inserts.length, 2, "two calls, two rows, nothing more");
  });
});

describe("when the write to the database fails", () => {
  it("it is retried, then printed in full so it can be entered by hand, and the run goes on; the key is not printed", async () => {
    const { wrapped, recorder, inserts, warnings } = setup({
      provider: async () => jsonResponse({ model: "m/x", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.5 } }),
      insertStatus: 500,
    });
    const response = await wrapped(CHAT, post());
    assert.equal(response.status, 200, "the run is not stopped");
    assert.equal(inserts.length, 2, "one try and one retry");
    assert.equal(recorder.failures.length, 1);
    const message = warnings.find((text) => /НЕ ЗАПИСАНО/.test(text));
    assert.ok(message, "the failure is loud");
    assert.match(message, /"cost":0\.5/, "the whole row is in the message");
    assert.doesNotMatch(message, new RegExp(KEY), "the key is not");
  });
});
