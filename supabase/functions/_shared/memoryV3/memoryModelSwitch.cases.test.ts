import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { calculateCostFromTokens } from "../openRouterPricing.ts";
import { sendProviderAlertSafely } from "../providerAlert.ts";
import { MEMORY_V3_DIALOGUE_MODEL } from "./dialogueContract.ts";
import { MEMORY_V3_LIFECYCLE_MODEL } from "./lifecycleContract.ts";
import { MEMORY_V3_MODEL_PROFILES } from "./modelRoute.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../../migrations/20261122000000_112_memory_v3_model_allowlist.sql");
const code = migration.replace(/\/\*[\s\S]*?\*\//, "");
const chat = read("../../staysee-chat/index.ts");

describe("the model of the background memory (22.11.2026: DeepSeek V4.1 Flash, Cloud.ru first, OpenRouter as the reserve)", () => {
  it("both pipelines write the same host-neutral name into their runs, and the profiles agree with the constants", () => {
    assert.equal(MEMORY_V3_DIALOGUE_MODEL, "deepseek-ai/DeepSeek-V4.1-Flash");
    assert.equal(MEMORY_V3_LIFECYCLE_MODEL, "deepseek-ai/DeepSeek-V4.1-Flash");
    for (const pipeline of ["dialogue", "lifecycle"] as const) {
      const profile = MEMORY_V3_MODEL_PROFILES[pipeline];
      assert.equal(profile.recordedModel, "deepseek-ai/DeepSeek-V4.1-Flash");
      assert.equal(profile.cloudru.model, "deepseek-ai/DeepSeek-V4.1-Flash");
      assert.deepEqual(profile.cloudru.priceUsdPer1M, { input: 0.7216, output: 2.1646 }, "the price of the catalog of 22.11.2026, not the V4 Flash one");
      assert.deepEqual(profile.cloudru.extra, { reasoning_effort: "none" }, "the reasoning stays off: with it 12 of 29 runs broke the contract");
      assert.equal(profile.openrouter.model, "deepseek/deepseek-v4.1-flash");
      assert.deepEqual(profile.openrouter.extra, { reasoning: { effort: "none" } });
    }
  });

  it("the addendum of the extractor carries the rule that alone broke the contract (a date is YYYY-MM-DD or null) and asks for Russian, durable facts", () => {
    for (const pipeline of ["dialogue", "lifecycle"] as const) {
      const text = MEMORY_V3_MODEL_PROFILES[pipeline].extractorAddendum;
      assert.match(text, /ГГГГ-ММ-ДД/);
      assert.match(text, /оставь поле null/);
      assert.match(text, /неполные даты вроде «2026-07»/);
      assert.match(text, /ТОЛЬКО по-русски/);
      assert.match(text, /мелочи одного дня/);
    }
    assert.match(MEMORY_V3_MODEL_PROFILES.lifecycle.extractorAddendum, /Сквозная память нужна всем будущим беседам/);
    assert.match(MEMORY_V3_MODEL_PROFILES.dialogue.extractorAddendum, /Сохраняй только то, что стоит помнить долго/);
  });

  it("no example in an addendum repeats a fact of the test conversation the memory was measured on (a test must not be given its answers)", () => {
    for (const pipeline of ["dialogue", "lifecycle"] as const) {
      const text = MEMORY_V3_MODEL_PROFILES[pipeline].extractorAddendum;
      for (const fact of ["пенициллин", "Ксени", "Казан", "в Туле", "Муся", "14 марта", "дизайнер", "Байкал", "Андре", "левш"]) {
        assert.equal(text.includes(fact), false, `${pipeline}: «${fact}»`);
      }
    }
  });

  it("the cost of a call is known for both hosts (Cloud.ru: 64.94 / 194.81 roubles for 1M with VAT at 90 roubles a dollar, OpenRouter by its price list)", () => {
    const onCloudru = calculateCostFromTokens("deepseek-ai/DeepSeek-V4.1-Flash", 2900, 350);
    assert.ok(onCloudru > 0.0027 && onCloudru < 0.0030, String(onCloudru));
    const onReserve = calculateCostFromTokens("deepseek/deepseek-v4.1-flash", 2900, 350);
    assert.ok(onReserve > 0.0001 && onReserve < 0.0003, String(onReserve));
  });

  it("a calm alert says that the memory goes on through OpenRouter and that the money is to be put on Cloud.ru", async () => {
    const sent: string[] = [];
    const delivered = await sendProviderAlertSafely("memory_switched", {
      botToken: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789",
      chatId: "123456",
      now: 5_000_000,
      fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body).text); return { ok: true }; },
    });
    assert.equal(delivered, true);
    assert.match(sent[0], /фоновой памяти/);
    assert.match(sent[0], /OpenRouter/);
    assert.match(sent[0], /Пополни Cloud\.ru/);
  });
});

describe("the chat asks the memory models through the route", () => {
  it("the four adapters of the two pipelines use their own route; the old shadow adapter is left alone", () => {
    assert.equal((chat.match(/fetchImpl: memoryRoutedFetch\("dialogue"\)/g) ?? []).length, 2, "the extractor and the reconciler of the dialogue memory");
    assert.equal((chat.match(/fetchImpl: memoryRoutedFetch\("lifecycle"\)/g) ?? []).length, 2, "the extractor and the reconciler of the lifecycle memory");
    const dialogueAt = chat.indexOf("runMemoryV3DialogueShadow({");
    const lifecycleAt = chat.indexOf("runMemoryV3LifecycleShadow({");
    const legacyAt = chat.indexOf("runMemoryV3Shadow({");
    assert.ok(dialogueAt > 0 && lifecycleAt > dialogueAt && legacyAt > lifecycleAt);
    assert.match(chat.slice(dialogueAt, lifecycleAt), /memoryRoutedFetch\("dialogue"\)/);
    assert.doesNotMatch(chat.slice(dialogueAt, lifecycleAt), /memoryRoutedFetch\("lifecycle"\)/);
    assert.match(chat.slice(lifecycleAt, legacyAt), /memoryRoutedFetch\("lifecycle"\)/);
    assert.doesNotMatch(chat.slice(lifecycleAt, legacyAt), /memoryRoutedFetch\("dialogue"\)/);
    assert.match(chat.slice(legacyAt, legacyAt + 600), /fetchImpl: globalThis\.fetch\.bind\(globalThis\)/);
  });

  it("the route has the Cloud.ru key from the same secret as the rest, and tells the owner of a refusal (never of a plain timeout)", () => {
    const at = chat.indexOf("function memoryRoutedFetch(");
    const body = chat.slice(at, at + 700);
    assert.match(body, /Deno\.env\.get\(CLOUDRU_API_KEY_ENV\)/);
    assert.match(body, /MEMORY_V3_MODEL_PROFILES\[pipeline\]/);
    assert.match(body, /if \(reason === "refused" \|\| reason === "paused"\) await sendProviderAlertSafely\("memory_switched"\)/);
  });
});

describe("migration 112: the database accepts the new model next to the old one, and changes nothing else", () => {
  it("relaxes the two CHECK constraints on `model` to the two names", () => {
    for (const [table, name] of [["memory_v3_dialogue_runs", "memory_v3_dialogue_runs_model_check"], ["memory_v3_lifecycle_shadow_runs", "memory_v3_lifecycle_shadow_runs_model_check"]]) {
      assert.match(code, new RegExp(`ALTER TABLE public\\.${table} DROP CONSTRAINT ${name};`));
      assert.match(code, new RegExp(`ADD CONSTRAINT ${name}\\s+CHECK \\(model IN \\('google/gemini-3\\.7-flash', 'deepseek-ai/DeepSeek-V4\\.1-Flash'\\)\\)`));
    }
  });

  it("recreates exactly the two reserve functions with the model condition widened, and the 10-message rule untouched", () => {
    assert.equal((code.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 2);
    assert.match(code, /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_dialogue_run\(/);
    assert.match(code, /CREATE OR REPLACE FUNCTION public\.reserve_memory_v3_lifecycle_shadow_run\(/);
    assert.equal((code.match(/p_model NOT IN \('google\/gemini-3\.7-flash', 'deepseek-ai\/DeepSeek-V4\.1-Flash'\)/g) ?? []).length, 2);
    assert.doesNotMatch(code, /p_model <> /, "no function still insists on one model");
    assert.equal((code.match(/v_new_message_count < 10/g) ?? []).length, 2, "both functions reserve a run only after 10 new messages");
    assert.equal((code.match(/SECURITY DEFINER/g) ?? []).length, 2);
    assert.equal((code.match(/SET search_path TO ''/g) ?? []).length + (code.match(/SET search_path = ''/g) ?? []).length, 2, "the functions keep their pinned search path");
  });

  it("the memory of a conversation is now written after 10 new messages, counted after the cursor of the last succeeded run, before a run is claimed", () => {
    const dialogue = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.reserve_memory_v3_dialogue_run("), code.indexOf("CREATE OR REPLACE FUNCTION public.reserve_memory_v3_lifecycle_shadow_run("));
    const gateAt = dialogue.indexOf("v_new_message_count < 10");
    assert.ok(gateAt > 0);
    assert.match(dialogue, /FROM public\.memory_v3_dialogue_runs r\s+WHERE r\.user_id = p_user_id AND r\.conversation_id = p_conversation_id AND r\.status = 'succeeded'/);
    assert.match(dialogue, /IF v_last_cursor_at IS NOT NULL THEN/, "the first run of a conversation is never held back");
    assert.match(dialogue.slice(gateAt, gateAt + 200), /result := 'daily_cap'/, "a quiet skip the application already understands");
    assert.ok(gateAt < dialogue.indexOf("INSERT INTO public.memory_v3_dialogue_identities"), "a skipped turn claims nothing");
    assert.ok(dialogue.indexOf("v_last_cursor_at timestamptz;") > 0 && dialogue.indexOf("v_new_message_count integer;") > 0, "the variables are declared");
  });

  it("deletes and rewrites no data", () => {
    for (const forbidden of [/DROP\s+TABLE/i, /TRUNCATE/i, /DELETE\s+FROM\s+public\.memory_v3_\w+_runs/i, /DROP\s+COLUMN/i, /UPDATE\s+public\.memory_v3_(dialogue|lifecycle)_(runs|shadow_runs)/i]) {
      assert.doesNotMatch(code, forbidden);
    }
  });
});
