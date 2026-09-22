import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX_URL = new URL("../../staysee-chat/index.ts", import.meta.url);
const README_URL = new URL("../../../../scripts/memory-v3-pilot/README.md", import.meta.url);

function source(): string {
  return readFileSync(INDEX_URL, "utf8");
}

describe("staysee-chat lifecycle shadow composition", () => {
  it("imports the exact lifecycle dependencies", () => {
    const text = source();
    for (const [name, specifier] of [
      ["parseMemoryV3ShadowMode", "../_shared/memoryV3/mode.ts"],
      ["createMemoryV3LifecycleStore", "../_shared/memoryV3/lifecycleStore.ts"],
      ["createMemoryV3LifecycleOpenRouterAdapter", "../_shared/memoryV3/lifecycleTransport.ts"],
      ["runMemoryV3LifecycleShadow", "../_shared/memoryV3/lifecycleShadowRunner.ts"],
      ["runMemoryV3LifecycleShadowBackgroundSafely", "../_shared/memoryV3/lifecycleShadowRunner.ts"],
    ] as const) {
      const escaped = specifier.replaceAll(".", "\\.");
      assert.match(text, new RegExp(`import[\\s\\S]{0,220}\\b${name}\\b[\\s\\S]{0,220}from ["']${escaped}["']`));
    }
  });

  it("dispatches exactly one mutually exclusive runner independently of the summary refresh gate", () => {
    const text = source();
    const gate = text.indexOf("if (!bgShould)");
    const promise = text.indexOf("const memoryV3ShadowPromise = conversationId &&");
    const mode = text.indexOf("const memoryV3Mode = parseMemoryV3ShadowMode");
    const legacy = text.indexOf("runMemoryV3Shadow({", mode);
    const lifecycle = text.indexOf("runMemoryV3LifecycleShadow({", mode);
    const settle = text.indexOf("EdgeRuntime.waitUntil(", mode);
    assert.equal(gate >= 0, true);
    assert.equal(promise > 0 && promise < mode, true);
    assert.equal(mode > 0 && mode < gate, true);
    assert.equal(legacy > mode, true);
    assert.equal(lifecycle > mode, true);
    assert.equal(settle > legacy && settle > lifecycle, true);
    assert.equal((text.match(/\brunMemoryV3Shadow\s*\(\{/g) ?? []).length, 1);
    assert.equal((text.match(/\brunMemoryV3LifecycleShadow\s*\(\{/g) ?? []).length, 1);
    const dispatch = text.slice(mode, settle);
    assert.match(
      dispatch,
      /return memoryV3Mode === "lifecycle_shadow"[\s\S]*?: memoryV3Mode === "shadow"[\s\S]*?: Promise\.resolve\(\);/,
    );
    assert.match(text.slice(settle), /Promise\.all\(\[[\s\S]*?memoryV3ShadowPromise,/);
  });

  it("does not require the summary context packet before dispatching lifecycle shadow", () => {
    const text = source();
    const responseStage = text.indexOf('recordReplyPipelineStage("before_http_response"');
    const promise = text.indexOf("const memoryV3ShadowPromise = conversationId &&", responseStage);
    const mode = text.indexOf("const memoryV3Mode = parseMemoryV3ShadowMode", responseStage);
    const backgroundSettlement = text.indexOf("EdgeRuntime.waitUntil(", responseStage);
    const packetGate = text.indexOf("packetForSummary &&", backgroundSettlement);
    assert.equal(responseStage >= 0, true);
    assert.equal(promise > responseStage && promise < mode && mode < packetGate, true);
    assert.equal(backgroundSettlement > mode, true);
    const dispatch = text.slice(promise, backgroundSettlement);
    assert.doesNotMatch(dispatch, /packetForSummary/);
    assert.match(
      dispatch,
      /const memoryV3ShadowPromise = conversationId &&[\s\S]*?result\.content &&[\s\S]*?!isCalmFallbackContent[\s\S]*?parseMemoryV3ShadowMode/,
    );
    const settlement = text.slice(backgroundSettlement, text.indexOf("} else if (userId && !clientConnected)", backgroundSettlement));
    assert.match(settlement, /Promise\.all\(\[[\s\S]*?memoryV3ShadowPromise,/);
  });

  it("reuses the bounded loader and exact server-only environment names", () => {
    const text = source();
    const start = text.indexOf("const memoryV3Mode = parseMemoryV3ShadowMode");
    const end = text.indexOf("EdgeRuntime.waitUntil(", start);
    const block = text.slice(start, end);
    assert.match(block, /Deno\.env\.get\("STAYSEE_MEMORY_V3_MODE"\)/);
    assert.match(block, /Deno\.env\.get\("STAYSEE_MEMORY_V3_SHADOW_USER_ID"\)/);
    assert.match(block, /Deno\.env\.get\("OPENROUTER_API_KEY"\)/);
    assert.match(block, /loadMessages:\s*createMemoryV3MessageLoader\(svc\)/);
    assert.match(block, /store:\s*createMemoryV3LifecycleStore\(svc\)/);
    assert.match(block, /extractorAdapterFactory:[\s\S]*createMemoryV3OpenRouterAdapter/);
    assert.match(block, /reconcilerAdapterFactory:[\s\S]*createMemoryV3LifecycleOpenRouterAdapter/);
    const lifecycleBranch = block.slice(
      block.indexOf('memoryV3Mode === "lifecycle_shadow"'),
      block.indexOf(': memoryV3Mode === "shadow"'),
    );
    assert.match(lifecycleBranch, /createMemoryV3LifecycleStore\(svc\)/);
    assert.match(lifecycleBranch, /createMemoryV3LifecycleOpenRouterAdapter/);
    const legacyBranch = block.slice(block.indexOf(': memoryV3Mode === "shadow"'));
    assert.doesNotMatch(legacyBranch, /createMemoryV3Lifecycle(Store|OpenRouterAdapter)/);
  });

  it("keeps lifecycle results out of replies, context, summary, legacy memory and audit", () => {
    const text = source();
    const success = /return new Response\(\s*JSON\.stringify\(\{\s*content: result\.content,[\s\S]*?\}\),\s*\{ headers: \{ \.\.\.corsHeaders/.exec(text)?.[0];
    assert.ok(success);
    assert.doesNotMatch(success, /lifecycle|memoryV3/i);
    for (const callName of ["buildContextPacket", "buildContextPrompt", "runConversationSummaryRefresh", "stampMemoryUsed"]) {
      const calls = [...text.matchAll(new RegExp(`${callName}\\s*\\(([^;]*)`, "g"))];
      for (const call of calls) assert.doesNotMatch(call[1], /lifecycleShadow|lifecycleResult/i, callName);
    }
    assert.doesNotMatch(text, /memory_v3_lifecycle_shadow_(heads|items|evidence|identities|runs)/i);
  });

  it("keeps both shadow runners inside the non-blocking background settlement", () => {
    const text = source();
    const responseStage = text.indexOf('recordReplyPipelineStage("before_http_response"');
    const legacy = text.indexOf("runMemoryV3Shadow({");
    const lifecycle = text.indexOf("runMemoryV3LifecycleShadow({");
    assert.equal(legacy > responseStage, true);
    assert.equal(lifecycle > responseStage, true);
    assert.match(text, /EdgeRuntime\.waitUntil\(\s*Promise\.all\(\[[\s\S]*?memoryV3ShadowPromise,/);
  });
});

describe("Memory V3 lifecycle shadow documentation", () => {
  it("documents the exact inactive write-only safety boundary", () => {
    const readme = readFileSync(README_URL, "utf8");
    const start = readme.indexOf("## Memory V3 lifecycle shadow");
    assert.notEqual(start, -1, "README is missing the lifecycle shadow section");
    const rest = readme.slice(start);
    const next = rest.slice(3).search(/^## /m);
    const section = (next === -1 ? rest : rest.slice(0, next + 3)).toLowerCase();
    for (const statement of [
      "experimental and write-only",
      "default off",
      "one exact allowlisted account",
      "current product memory remains unchanged",
      "two sequential model boundaries",
      "deterministic reducer",
      "one atomic reservation per utc day",
      "at most two provider calls",
      "no retry or repair",
      "30-day retention applies only to run payloads",
      "durable lifecycle state is not time-purged",
      "source-message, conversation, or account deletion",
      "the model cannot forget memory",
      "migration 034 remains unapplied",
      "no paid reconciler benchmark has been run",
      "not deployed or activated",
      "separate future approvals",
    ]) assert.ok(section.includes(statement), statement);
  });
});
