import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PROVIDER_ALERT_WINDOW_MS, resetProviderAlertsForTests, sendProviderAlertSafely } from "./providerAlert.ts";
import {
  RECALL_GATE_MODEL,
  RECALL_GATE_SYSTEM_PROMPT,
  askRecallGate,
  clipForRecallGate,
  parseRecallDecision,
  resolveRecallGateMode,
} from "./recallGate.ts";

const source = readFileSync(new URL("./recallGate.ts", import.meta.url), "utf8");

function answer(content: string, usage: Record<string, number> | null = { prompt_tokens: 424, completion_tokens: 43, total_tokens: 467 }) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }) };
}

describe("the small model that reads a message before the search in the past", () => {
  it("asks on words by default (the owner's choice), and can be told to ask always or never", () => {
    assert.equal(resolveRecallGateMode(undefined), "words");
    assert.equal(resolveRecallGateMode(""), "words");
    assert.equal(resolveRecallGateMode("nonsense"), "words");
    assert.equal(resolveRecallGateMode("always"), "always");
    assert.equal(resolveRecallGateMode(" OFF "), "off");
  });

  it("reads only the expected JSON, and never guesses", () => {
    assert.deepEqual(parseRecallDecision('{"recall": true, "query": "любимый цвет"}'), { recall: true, query: "любимый цвет" });
    assert.deepEqual(parseRecallDecision('```json\n{"recall": true, "query": "  поездка   летом "}\n```'), { recall: true, query: "поездка летом" });
    assert.deepEqual(parseRecallDecision('{"recall": false, "query": "что-то"}'), { recall: false, query: "" }, "no phrase when there is nothing to remember");
    assert.deepEqual(parseRecallDecision('{"recall": true}'), { recall: true, query: "" });
    for (const bad of ["", "да", '{"recall": "yes"}', '{"query": "x"}', "{broken", null, undefined, 5]) {
      assert.equal(parseRecallDecision(bad), null, String(bad));
    }
  });

  it("gives a long message by its beginning and its end", () => {
    assert.equal(clipForRecallGate("  коротко  "), "коротко");
    const long = "начало " + "я".repeat(5000) + " конец";
    const clipped = clipForRecallGate(long);
    assert.ok(clipped.length < 1300);
    assert.ok(clipped.startsWith("начало"));
    assert.ok(clipped.endsWith("конец"));
  });

  it("sends the message and the instruction to Cloud.ru, with the key in the header only, and returns the decision and the tokens", async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return answer('{"recall": true, "query": "аллергия на лекарства"}');
    }) as never;

    const result = await askRecallGate("вспомни, на что у меня аллергия", { apiKey: "secret-key", fetchImpl });

    assert.deepEqual(result.decision, { recall: true, query: "аллергия на лекарства" });
    assert.deepEqual(result.usage, { promptTokens: 424, completionTokens: 43, totalTokens: 467 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://foundation-models.api.cloud.ru/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-key");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, RECALL_GATE_MODEL);
    assert.equal(body.model, "openai/gpt-oss-120b");
    assert.equal(body.temperature, 0);
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.messages[0].content, RECALL_GATE_SYSTEM_PROMPT);
    assert.equal(body.messages[1].content, "вспомни, на что у меня аллергия");
    assert.ok(!calls[0].init.body.includes("secret-key"), "the key is never part of the body");
  });

  it("tries again without the reasoning setting when the provider refuses it, and takes nothing for an answer when it fails", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    const refusing = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      n += 1;
      return n === 1 ? { ok: false, status: 400, json: async () => ({}) } : answer('{"recall": false, "query": ""}');
    }) as never;
    const retried = await askRecallGate("как дела?", { apiKey: "k", fetchImpl: refusing });
    assert.deepEqual(retried.decision, { recall: false, query: "" });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].reasoning_effort, "low");
    assert.ok(!("reasoning_effort" in bodies[1]));

    const down = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never;
    assert.equal((await askRecallGate("x", { apiKey: "k", fetchImpl: down })).decision, null);
    const thrown = (async () => {
      throw new Error("network");
    }) as never;
    assert.equal((await askRecallGate("x", { apiKey: "k", fetchImpl: thrown })).decision, null);
    const garbage = (async () => answer("не знаю")) as never;
    assert.equal((await askRecallGate("x", { apiKey: "k", fetchImpl: garbage })).decision, null);
  });

  it("gives up after the time it is given, instead of holding the reply", async () => {
    const slow = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as never;
    const started = Date.now();
    const result = await askRecallGate("помнишь?", { apiKey: "k", fetchImpl: slow, timeoutMs: 30 });
    assert.equal(result.decision, null);
    assert.ok(Date.now() - started < 1000);
  });

  it("the instruction decides by meaning: it names no story, and the code reads no words of the message", () => {
    for (const story of ["Ксения", "Байкал", "ссора с мамой", "новый год", "пенициллин"]) {
      assert.ok(!RECALL_GATE_SYSTEM_PROMPT.includes(story), `the instruction must not carry "${story}"`);
    }
    assert.match(RECALL_GATE_SYSTEM_PROMPT, /НЕ нужно заглядывать в прошлое/);
    assert.ok(!/RegExp|\.test\(|\.match\(.*message/.test(source.replace(/parseRecallDecision[\s\S]*?\n}\n/, "")), "no word list is applied to the message");
  });
});

describe("a refused key or an empty balance of the small model is told to the owner", () => {
  it("reports the refusal (401, 402, 403) and nothing else, and still answers without a decision", async () => {
    for (const status of [401, 402, 403] as const) {
      const refusing = (async () => ({ ok: false, status, json: async () => ({}) })) as never;
      const result = await askRecallGate("помнишь?", { apiKey: "k", fetchImpl: refusing });
      assert.equal(result.decision, null);
      assert.equal(result.refusedStatus, status);
    }
    for (const status of [400 + 100, 429, 500, 503]) {
      const failing = (async () => ({ ok: false, status, json: async () => ({}) })) as never;
      assert.equal((await askRecallGate("помнишь?", { apiKey: "k", fetchImpl: failing })).refusedStatus, undefined, String(status));
    }
  });

  it("the alerts of the search say what is worse (the remembering), when the key ends, and are sent once in half an hour per kind", async () => {
    resetProviderAlertsForTests();
    const sent: string[] = [];
    const options = {
      botToken: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789",
      chatId: "123456",
      fetchImpl: async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body).text);
        return { ok: true };
      },
    };
    assert.equal(await sendProviderAlertSafely("search_key_rejected", { ...options, now: 1_000 }), true);
    assert.equal(await sendProviderAlertSafely("search_key_rejected", { ...options, now: 2_000 }), false, "the same kind again inside the window");
    assert.equal(await sendProviderAlertSafely("search_balance_empty", { ...options, now: 2_000 }), true, "another kind is not held back");
    assert.equal(await sendProviderAlertSafely("search_key_rejected", { ...options, now: 1_000 + PROVIDER_ALERT_WINDOW_MS + 1 }), true);
    assert.match(sent[0], /CLOUDRU_API_KEY/);
    assert.match(sent[0], /15\.02\.2027/, "the date the key ends is in the alert");
    assert.match(sent[0], /хуже вспоминает/);
    assert.match(sent[1], /402/);
    assert.ok(sent.every((text) => !text.includes("123456789:")), "the bot token is never in the text");
    resetProviderAlertsForTests();
  });

  it("the chat raises both alerts, and awaits them (they are sent only when something is refused)", () => {
    const chat = readFileSync(new URL("../staysee-chat/index.ts", import.meta.url), "utf8");
    assert.match(chat, /if \(recallGate\?\.refusedStatus\) \{\s*await sendProviderAlertSafely\(recallGate\.refusedStatus === 402 \? "search_balance_empty" : "search_key_rejected"\)/);
    assert.match(chat, /onRefusal: async \(status\) => \{\s*await sendProviderAlertSafely\(status === 402 \? "search_balance_empty" : "search_key_rejected"\)/);
  });
});
