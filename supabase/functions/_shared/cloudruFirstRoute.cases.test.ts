import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import { calculateCostFromTokens } from "./openRouterPricing.ts";
import { sendProviderAlertSafely } from "./providerAlert.ts";
import {
  AUX_MODEL_PROFILES,
  type CloudruFirstProfile,
  createCloudruFirstFetch,
} from "./cloudruFirstRoute.ts";
import { CLOUDRU_PAUSE_MS, cloudruIsPaused, resetSearchProvidersForTests } from "./searchProviders.ts";
import { IMAGE_DESCRIPTION_PROMPT, buildImageDescriptionRequest, createImageDescriber } from "./imageDescriber.ts";
import { buildLongMessageSummaryRequest, parseLongMessageSummaryResponse } from "./longMessages.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const chat = read("../staysee-chat/index.ts");

const PROFILE: CloudruFirstProfile = {
  model: "vendor/Test-Vision",
  extra: { reasoning_effort: "none" },
  priceUsdPer1M: { input: 2, output: 4 },
  systemAddendum: "\nДОБАВКА",
  timeoutMs: 5_000,
};
const PLAIN: CloudruFirstProfile = { ...PROFILE, systemAddendum: undefined };

const openRouterBody = () => ({
  model: "google/gemini-3.7-flash",
  messages: [
    { role: "system", content: "СИСТЕМНЫЙ ТЕКСТ" },
    { role: "user", content: [{ type: "text", text: "Опиши картинку." }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ],
  max_tokens: 3000,
  reasoning: { effort: "low" },
  temperature: 0.2,
  stream: false,
  provider: { allow_fallbacks: true, data_collection: "deny", zdr: true },
  usage: { include: true },
});

interface Call { url: string; body: Record<string, unknown>; headers: Record<string, string> }
function host(answers: Array<{ status?: number; json?: unknown; throws?: boolean; text?: string }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(init.body); } catch { /* recorded as empty */ }
    calls.push({ url: String(url), body: parsed, headers: init.headers });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer.throws) throw new TypeError("network down");
    return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const chatAnswer = (content: string, usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }) => ({
  json: { id: "x", model: "vendor/Test-Vision", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage },
});
const routed = (profile: CloudruFirstProfile, cloudru: ReturnType<typeof host> | null, reserve: ReturnType<typeof host>, extra: Record<string, unknown> = {}) =>
  createCloudruFirstFetch({
    profile,
    ...(cloudru ? { cloudru: { apiKey: "cloudru-key", fetchImpl: cloudru.fetchImpl } } : {}),
    reserve: { fetchImpl: reserve.fetchImpl },
    ...extra,
  });
const send = (fetchImpl: typeof fetch, body: unknown, signal?: AbortSignal) =>
  fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer or-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

beforeEach(() => resetSearchProvidersForTests());

describe("pictures and long messages: Cloud.ru first, the model of its own placement", () => {
  it("both jobs ask models of the own placement with the reasoning off, at the catalog price with VAT, and leave the reserve time", () => {
    assert.equal(AUX_MODEL_PROFILES.summary.model, "Qwen/Qwen3.6-35B-A3B", "the short version of a text has no speakers to mix up");
    assert.deepEqual(AUX_MODEL_PROFILES.summary.priceUsdPer1M, { input: 2.44, output: 3.66 }, "219.6 and 329.4 roubles with VAT at 90 a dollar");
    assert.equal(AUX_MODEL_PROFILES.image.model, "Qwen/Qwen3.5-397B-A17B", "the small one swapped the speakers of a chat with replies, 5 of 5 on a real screenshot");
    assert.deepEqual(AUX_MODEL_PROFILES.image.priceUsdPer1M, { input: 10.17, output: 12.06 }, "915 and 1,085.8 roubles with VAT at 90 a dollar");
    for (const kind of ["image", "summary"] as const) {
      assert.deepEqual(AUX_MODEL_PROFILES[kind].extra, { reasoning_effort: "none" }, "without it the tokens go to thinking");
    }
    assert.ok(AUX_MODEL_PROFILES.image.timeoutMs < 25_000, "less than the 25 s the describer gives a try");
    assert.ok(AUX_MODEL_PROFILES.summary.timeoutMs < 18_000, "less than the 18 s the chat gives the short version");
    assert.match(read("../staysee-chat/index.ts"), /timeoutMs: 18_000/);
    const cost = calculateCostFromTokens("Qwen/Qwen3.5-397B-A17B", 1167, 169);
    assert.ok(cost > 0.0135 && cost < 0.0145, `${cost}: about 1.25 roubles a picture, not the default price`);
    const small = calculateCostFromTokens("Qwen/Qwen3.6-35B-A3B", 1262, 136);
    assert.ok(small > 0.0035 && small < 0.0038, String(small));
  });

  it("only the summary carries the addendum about the size (counted in words, the model keeps to it), the picture does not", () => {
    assert.match(AUX_MODEL_PROFILES.summary.systemAddendum, /не больше 130 слов/);
    assert.equal(Object.hasOwn(AUX_MODEL_PROFILES.image, "systemAddendum"), false);
  });

  it("the request to Cloud.ru has the picture as it was and none of the fields of OpenRouter", async () => {
    const cloudru = host([chatAnswer("описание")]);
    const reserve = host([{}]);
    await send(routed(PLAIN, cloudru, reserve), openRouterBody());
    const call = cloudru.calls[0];
    assert.match(call.url, /\/chat\/completions$/);
    assert.equal(call.headers.Authorization, "Bearer cloudru-key");
    assert.equal(call.body.model, "vendor/Test-Vision");
    assert.deepEqual(call.body.messages, openRouterBody().messages, "the picture and the prompt go as they are");
    assert.equal(call.body.max_tokens, 3000);
    assert.equal(call.body.temperature, 0.2);
    assert.equal(call.body.stream, false);
    assert.equal(call.body.reasoning_effort, "none");
    for (const field of ["provider", "usage", "reasoning"]) assert.equal(Object.hasOwn(call.body, field), false, field);
    assert.equal(reserve.calls.length, 0);
  });

  it("the answer comes back in the shape of OpenRouter's, with the cost worked out, the name of the model and no reasoning", async () => {
    const cloudru = host([{ json: { ...chatAnswer("описание").json, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "описание", reasoning_content: "must not pass" } }] } }]);
    const response = await send(routed(PLAIN, cloudru, host([{}])), openRouterBody());
    const body = await response.json() as { model: string; usage: { cost: number; prompt_tokens: number }; choices: Array<{ message: Record<string, unknown> }> };
    assert.equal(body.model, "vendor/Test-Vision");
    assert.equal(body.usage.prompt_tokens, 1000);
    assert.equal(body.usage.cost, 0.0024, "1000 * 2 + 100 * 4 dollars per million");
    assert.equal(body.choices[0].message.content, "описание");
    assert.equal("reasoning_content" in body.choices[0].message, false);
    const parsed = parseLongMessageSummaryResponse(body);
    assert.equal(parsed?.model, "vendor/Test-Vision", "the cost log is told which model answered");
    assert.equal(parsed?.usage?.costUsd, 0.0024);
  });

  it("the addendum is put after the system text on Cloud.ru, and the reserve gets the request exactly as it was built", async () => {
    const cloudru = host([{ status: 403 }]);
    const reserve = host([chatAnswer("запас")]);
    await send(routed(PROFILE, cloudru, reserve), openRouterBody());
    assert.equal(((cloudru.calls[0].body.messages as Array<{ content: string }>)[0]).content, "СИСТЕМНЫЙ ТЕКСТ\nДОБАВКА");
    assert.deepEqual(reserve.calls[0].body, openRouterBody(), "Gemini gets the original request, nothing of Cloud.ru's");
    assert.equal(reserve.calls[0].headers.Authorization, "Bearer or-key");
  });

  it("a refusal (402/403) goes to the reserve, pauses Cloud.ru, and tells the owner; while paused it is not asked", async () => {
    const switched: Array<{ reason: string; refusedStatus?: number }> = [];
    const cloudru = host([{ status: 403, text: "Project not found" }]);
    const reserve = host([chatAnswer("запас")]);
    const fetchImpl = routed(PLAIN, cloudru, reserve, { onSwitch: (info: { reason: string; refusedStatus?: number }) => { switched.push(info); } });
    const first = await send(fetchImpl, openRouterBody());
    assert.equal(first.status, 200);
    assert.equal(cloudru.calls.length, 1);
    assert.equal(reserve.calls.length, 1);
    assert.equal(cloudruIsPaused(Date.now()), true);
    assert.deepEqual(switched[0], { reason: "refused", refusedStatus: 403 });
    await send(fetchImpl, openRouterBody());
    assert.equal(cloudru.calls.length, 1, "not asked again while paused");
    assert.equal(reserve.calls.length, 2);
    assert.equal(switched[1].reason, "paused");
    assert.ok(CLOUDRU_PAUSE_MS > 0);
  });

  it("a slow or failing Cloud.ru (429, 5xx, no network, an answer that is not a chat) goes to the reserve without a pause and without an alert", async () => {
    for (const answers of [[{ status: 429 }], [{ status: 503 }], [{ throws: true }], [{ text: "<html>" }], [{ json: { choices: [] } }]]) {
      resetSearchProvidersForTests();
      const switched: string[] = [];
      const reserve = host([chatAnswer("запас")]);
      const response = await send(routed(PLAIN, host(answers), reserve, { onSwitch: (i: { reason: string }) => { switched.push(i.reason); } }), openRouterBody());
      assert.equal(response.status, 200, JSON.stringify(answers));
      assert.equal(reserve.calls.length, 1);
      assert.equal(cloudruIsPaused(Date.now()), false, "no pause for a plain failure");
      assert.deepEqual(switched, ["unavailable"]);
    }
  });

  it("without a Cloud.ru key everything goes to the reserve, and a body that is not JSON is passed on untouched", async () => {
    const reserve = host([chatAnswer("запас")]);
    await send(routed(PLAIN, null, reserve), openRouterBody());
    assert.equal(reserve.calls.length, 1);
    const odd = host([{}]);
    await routed(PLAIN, host([chatAnswer("x")]), odd)("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "not json" });
    assert.equal(odd.calls.length, 1);
  });

  it("the deadline of the caller is not turned into a second request to the reserve", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: { signal: AbortSignal }) => {
      await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const reserve = host([chatAnswer("запас")]);
    const pending = send(createCloudruFirstFetch({ profile: PLAIN, cloudru: { apiKey: "k", fetchImpl }, reserve: { fetchImpl: reserve.fetchImpl } }), openRouterBody(), controller.signal);
    controller.abort();
    await assert.rejects(pending);
    assert.equal(reserve.calls.length, 0);
  });
});

describe("the describer and the summarizer keep their requests and pass the answering model on", () => {
  it("the request is still built for Gemini on OpenRouter: that is the reserve and it is sent as it is", () => {
    const image = buildImageDescriptionRequest({ mime: "image/png", data: "AAAA" });
    assert.equal(image.model, "google/gemini-3.7-flash");
    assert.equal(buildLongMessageSummaryRequest("текст").model, "google/gemini-3.7-flash");
  });

  it("a described picture and a failed try carry the model that answered", async () => {
    const answer = (content: string, finish = "stop") => ({
      id: "x", model: "Qwen/Qwen3.6-35B-A3B",
      choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }],
      usage: { prompt_tokens: 1262, completion_tokens: 136, total_tokens: 1398, cost: 0.0036 },
    });
    const ok = createImageDescriber({ apiKey: "k", fetchImpl: async () => new Response(JSON.stringify(answer("Скриншот переписки с Леной."))) });
    const described = await ok({ mime: "image/png", data: "AAAA" });
    assert.equal(described?.model, "Qwen/Qwen3.6-35B-A3B");
    const seen: Array<string | undefined> = [];
    const cut = createImageDescriber({
      apiKey: "k",
      fetchImpl: async () => new Response(JSON.stringify(answer("обрыв", "length"))),
      onFailure: (_code, _usage, model) => { seen.push(model); },
    });
    assert.equal(await cut({ mime: "image/png", data: "AAAA" }), null);
    assert.deepEqual(seen, ["Qwen/Qwen3.6-35B-A3B", "Qwen/Qwen3.6-35B-A3B"], "both tries are billed to the model that answered");
  });

  it("the prompt teaches who is who in a chat screenshot: the person on the right, the name in a frame is the author of the QUOTED message, no pronouns, say when unsure", () => {
    assert.match(IMAGE_DESCRIPTION_PROMPT, /Человек, приславший картинку, — тот, чьи сообщения стоят справа/);
    assert.match(IMAGE_DESCRIPTION_PROMPT, /Имя в рамке — это автор ЦИТИРУЕМОГО сообщения, а не автор текста под рамкой/);
    assert.match(IMAGE_DESCRIPTION_PROMPT, /Не приписывай ответ автору цитаты/);
    assert.match(IMAGE_DESCRIPTION_PROMPT, /без «он» и «она»/);
    assert.match(IMAGE_DESCRIPTION_PROMPT, /Если не уверен, чья реплика, так и напиши/);
    for (const name of ["Егор", "Анастасия", "Ремантадин", "Хирург"]) {
      assert.equal(IMAGE_DESCRIPTION_PROMPT.includes(name), false, `no word of the screenshot that showed the mistake in the prompt: «${name}»`);
    }
  });

  it("the prompt keeps the names as written and hides phones, addresses, mail, cards, documents, logins and passwords (the owner's decision of 22.11.2026)", () => {
    assert.match(IMAGE_DESCRIPTION_PROMPT, /Имена людей оставляй так, как они написаны/);
    assert.match(IMAGE_DESCRIPTION_PROMPT, /Не переписывай телефоны, адреса, почту, номера карт и документов, логины и пароли/);
    assert.doesNotMatch(IMAGE_DESCRIPTION_PROMPT, /Не переписывай имена/);
    assert.doesNotMatch(IMAGE_DESCRIPTION_PROMPT, /ники/);
  });
});

describe("the chat uses the route for both jobs and writes the real model into the cost log", () => {
  it("the describer and the summarizer get their own route, and no plain fetch to OpenRouter is left in front of them", () => {
    const describer = chat.slice(chat.indexOf("createImageDescriber({"), chat.indexOf("createImageDescriber({") + 400);
    assert.match(describer, /fetchImpl: auxRoutedFetch\("image"\)/);
    const summarizer = chat.slice(chat.indexOf("createLongMessageSummarizer({"), chat.indexOf("createLongMessageSummarizer({") + 400);
    assert.match(summarizer, /fetchImpl: auxRoutedFetch\("summary"\)/);
    assert.doesNotMatch(describer, /globalThis\.fetch/);
    assert.doesNotMatch(summarizer, /globalThis\.fetch/);
  });

  it("the helper reads the key of Cloud.ru from the same secret as the rest, and alerts only on a refusal", () => {
    const at = chat.indexOf("function auxRoutedFetch(");
    const body = chat.slice(at, at + 600);
    assert.match(body, /Deno\.env\.get\(CLOUDRU_API_KEY_ENV\)/);
    assert.match(body, /AUX_MODEL_PROFILES\[kind\]/);
    assert.match(body, /if \(reason === "refused" \|\| reason === "paused"\) await sendProviderAlertSafely\("aux_switched"\)/);
  });

  it("the cost log names the model that answered, with the old name only when the answer names none", () => {
    assert.match(chat, /model: answeredBy \?\? imageModel,/);
    assert.match(chat, /model: made\.model \?\? SUMMARY_MODEL,/);
  });

  it("a calm alert says that pictures go through OpenRouter (Gemini, outside Cloud.ru) and that the money is to be put on Cloud.ru", async () => {
    const sent: string[] = [];
    const delivered = await sendProviderAlertSafely("aux_switched", {
      botToken: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789",
      chatId: "123456",
      now: 9_000_000,
      fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body).text); return { ok: true }; },
    });
    assert.equal(delivered, true);
    assert.match(sent[0], /описания картинок и сжатия длинных сообщений/);
    assert.match(sent[0], /вне Cloud\.ru/);
    assert.match(sent[0], /Пополни Cloud\.ru/);
  });
});
