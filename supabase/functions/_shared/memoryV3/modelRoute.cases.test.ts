import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { CLOUDRU_PAUSE_MS, cloudruIsPaused, resetSearchProvidersForTests } from "../searchProviders.ts";
import {
  type MemoryModelProfile,
  createMemoryV3RoutedFetch,
  isExtractorRequest,
  toOpenRouterShape,
} from "./modelRoute.ts";

const PROFILE: MemoryModelProfile = {
  recordedModel: "vendor/test-model",
  cloudru: { model: "vendor/Test-Model", extra: { reasoning_effort: "none" }, priceUsdPer1M: { input: 0.5, output: 1 } },
  openrouter: { model: "vendor/test-model-or", extra: { reasoning: { effort: "none" } } },
  extractorAddendum: "\nДОБАВКА ДЛЯ ИЗВЛЕЧЕНИЯ",
};
const ROUTE = { allow_fallbacks: true, require_parameters: true, data_collection: "deny", zdr: true };

const extractorBody = () => ({
  model: "google/gemini-3.7-flash",
  messages: [{ role: "system", content: "СИСТЕМНЫЙ ТЕКСТ" }, { role: "user", content: "{}" }],
  stream: false,
  response_format: { type: "json_schema", json_schema: { name: "memory_v3_v2_layered_extractor_response", strict: true, schema: {} } },
  reasoning: { effort: "low" },
  provider: ROUTE,
  max_tokens: 4000,
  usage: { include: true },
});
const reconcilerBody = () => ({
  ...extractorBody(),
  response_format: { type: "json_schema", json_schema: { name: "memory_v3_dialogue_reconcile_response", strict: true, schema: {} } },
});

interface Call { url: string; body: Record<string, unknown>; headers: Record<string, string> }

function host(answers: Array<{ status?: number; json?: unknown; throws?: boolean; text?: string }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(init.body); } catch { /* a body that is not JSON is recorded as empty */ }
    calls.push({ url: String(url), body: parsed, headers: init.headers });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer.throws) throw new TypeError("network down");
    const status = answer.status ?? 200;
    const text = answer.text ?? JSON.stringify(answer.json ?? {});
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const chatAnswer = (content: string, usage: Record<string, number> = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }) => ({
  json: { id: "x", model: "vendor/Test-Model", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, reasoning_content: "must not pass" } }], usage },
});

function routed(cloudru: ReturnType<typeof host> | null, openrouter: ReturnType<typeof host>, extra: Record<string, unknown> = {}) {
  return createMemoryV3RoutedFetch({
    profile: PROFILE,
    ...(cloudru ? { cloudru: { apiKey: "cloudru-key", fetchImpl: cloudru.fetchImpl } } : {}),
    openrouter: { fetchImpl: openrouter.fetchImpl },
    ...extra,
  });
}

const send = (fetchImpl: typeof fetch, body: unknown, signal?: AbortSignal) =>
  fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer or-key", "Content-Type": "application/json", "X-Title": "StaySee AI" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

beforeEach(() => resetSearchProvidersForTests());

describe("the memory model route: Cloud.ru first", () => {
  it("tells the extractor from the reconciler by the name of the schema", () => {
    assert.equal(isExtractorRequest(extractorBody() as never), true);
    assert.equal(isExtractorRequest(reconcilerBody() as never), false);
    assert.equal(isExtractorRequest({} as never), false);
  });

  it("sends the request to Cloud.ru with the model of the profile, the addendum on the extractor only, and returns it in the shape of OpenRouter with the cost", async () => {
    const cloudru = host([chatAnswer('{"ok":1}')]);
    const openrouter = host([chatAnswer("never")]);
    const fetchImpl = routed(cloudru, openrouter);

    const extractor = await send(fetchImpl, extractorBody());
    const call = cloudru.calls[0];
    assert.equal(call.url, "https://foundation-models.api.cloud.ru/v1/chat/completions");
    assert.equal(call.headers.Authorization, "Bearer cloudru-key");
    assert.equal(call.body.model, "vendor/Test-Model");
    assert.equal(call.body.reasoning_effort, "none");
    assert.equal(call.body.stream, false);
    assert.equal(call.body.max_tokens, 4000);
    assert.deepEqual((call.body.response_format as { json_schema: { name: string } }).json_schema.name, "memory_v3_v2_layered_extractor_response");
    assert.equal((call.body.messages as Array<{ content: string }>)[0].content, "СИСТЕМНЫЙ ТЕКСТ\nДОБАВКА ДЛЯ ИЗВЛЕЧЕНИЯ", "the addendum is on the extractor");
    assert.equal("provider" in call.body, false, "the OpenRouter route is not sent to Cloud.ru");
    assert.equal("usage" in call.body, false);
    const shaped = await extractor.json();
    assert.equal(shaped.choices[0].message.content, '{"ok":1}');
    assert.equal(shaped.choices[0].finish_reason, "stop");
    assert.equal("reasoning_content" in shaped.choices[0].message, false, "nothing but what the adapters read is passed on");
    assert.equal(shaped.usage.prompt_tokens, 1000);
    assert.equal(shaped.usage.cost, 0.0007, "1000 tokens in at 0.5 and 200 out at 1 dollar per million");
    assert.equal(openrouter.calls.length, 0);

    await send(fetchImpl, reconcilerBody());
    assert.equal((cloudru.calls[1].body.messages as Array<{ content: string }>)[0].content, "СИСТЕМНЫЙ ТЕКСТ", "never on the reconciler");
  });

  it("an empty balance (403) sends the same request to OpenRouter through the private route; the memory goes on", async () => {
    const cloudru = host([{ status: 403, text: "Project not found" }]);
    const openrouter = host([chatAnswer('{"ok":2}')]);
    const switched: unknown[] = [];
    const fetchImpl = routed(cloudru, openrouter, { onSwitch: (info: unknown) => void switched.push(info) });

    const response = await send(fetchImpl, extractorBody());
    assert.equal(response.status, 200);
    const call = openrouter.calls[0];
    assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(call.headers.Authorization, "Bearer or-key", "the key the adapter was given");
    assert.equal(call.headers["X-Title"], "StaySee AI");
    assert.equal(call.body.model, "vendor/test-model-or");
    assert.deepEqual(call.body.reasoning, { effort: "none" });
    assert.deepEqual(call.body.provider, ROUTE, "the private route of the adapter is kept");
    assert.deepEqual(call.body.usage, { include: true });
    assert.equal((call.body.messages as Array<{ content: string }>)[0].content, "СИСТЕМНЫЙ ТЕКСТ\nДОБАВКА ДЛЯ ИЗВЛЕЧЕНИЯ");
    assert.deepEqual(switched, [{ reason: "refused", refusedStatus: 403 }]);
    assert.equal(cloudruIsPaused(), true);
  });

  it("during the pause the requests go straight to OpenRouter; after it Cloud.ru is asked again and a good answer ends the pause", async () => {
    const cloudru = host([{ status: 402 }, chatAnswer("{}")]);
    const openrouter = host([chatAnswer("{}")]);
    let clock = 1_000_000;
    const switched: Array<{ reason: string; refusedStatus?: number }> = [];
    const fetchImpl = routed(cloudru, openrouter, { now: () => clock, onSwitch: (info: { reason: string; refusedStatus?: number }) => void switched.push(info) });

    await send(fetchImpl, reconcilerBody());
    clock += 60_000;
    await send(fetchImpl, reconcilerBody());
    assert.equal(cloudru.calls.length, 1, "Cloud.ru is left alone");
    assert.deepEqual(switched.at(-1), { reason: "paused", refusedStatus: 402 });
    assert.equal(openrouter.calls.length, 2);

    clock += CLOUDRU_PAUSE_MS;
    await send(fetchImpl, reconcilerBody());
    assert.equal(cloudru.calls.length, 2, "asked again after the pause");
    assert.equal(cloudruIsPaused(clock + 1), false);
    assert.equal(openrouter.calls.length, 2);
  });

  it("a timeout, a server error, a rate limit (429) or an answer that is not a chat answer use the reserve for that request only", async () => {
    for (const bad of [{ throws: true }, { status: 500 }, { status: 429, text: "Too many requests" }, { status: 200, text: "not json" }, { status: 200, json: { nothing: true } }]) {
      resetSearchProvidersForTests();
      const cloudru = host([bad, chatAnswer("{}")]);
      const openrouter = host([chatAnswer('{"r":1}')]);
      const fetchImpl = routed(cloudru, openrouter);
      const first = await send(fetchImpl, extractorBody());
      assert.equal((await first.json()).choices[0].message.content, '{"r":1}', JSON.stringify(bad));
      assert.equal(cloudruIsPaused(), false, `no pause for ${JSON.stringify(bad)}`);
      await send(fetchImpl, extractorBody());
      assert.equal(cloudru.calls.length, 2, "the next request asks Cloud.ru again");
    }
  });

  it("without a Cloud.ru key everything goes to OpenRouter; and the end of the adapter's own deadline is never answered by a second request", async () => {
    const openrouter = host([chatAnswer("{}")]);
    await send(routed(null, openrouter), extractorBody());
    assert.equal(openrouter.calls.length, 1);

    const controller = new AbortController();
    const cloudru = { calls: [] as Call[], fetchImpl: (async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch };
    const reserve = host([chatAnswer("{}")]);
    await assert.rejects(() => send(routed(cloudru as never, reserve), extractorBody(), controller.signal));
    assert.equal(reserve.calls.length, 0);
  });

  it("a request that is not one of the adapters is sent on as it is", async () => {
    const cloudru = host([chatAnswer("{}")]);
    const openrouter = host([chatAnswer("{}")]);
    await routed(cloudru, openrouter)("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "not json" });
    assert.equal(cloudru.calls.length, 0, "Cloud.ru is not asked");
    assert.equal(openrouter.calls.length, 1);
  });

  it("toOpenRouterShape reads only a chat answer, and rounds the cost", () => {
    assert.equal(toOpenRouterShape(null, { input: 1, output: 1 }), null);
    assert.equal(toOpenRouterShape({ choices: [] }, { input: 1, output: 1 }), null);
    const shaped = toOpenRouterShape(
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "x", refusal: null } }], usage: { prompt_tokens: 3, completion_tokens: 3 } },
      { input: 0.481, output: 0.962 },
    ) as { usage: { total_tokens: number; cost: number }; choices: Array<{ message: Record<string, unknown> }> };
    assert.equal(shaped.usage.total_tokens, 6);
    assert.equal(shaped.usage.cost, 0.00000433);
    assert.equal("refusal" in shaped.choices[0].message, false, "a null refusal is not passed on");
  });
});
