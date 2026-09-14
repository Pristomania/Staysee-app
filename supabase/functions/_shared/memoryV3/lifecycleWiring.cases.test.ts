import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX_URL = new URL("../../staysee-chat/index.ts", import.meta.url);

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

  it("dispatches exactly one mutually exclusive runner after the background gate", () => {
    const text = source();
    const gate = text.indexOf("if (!bgShould)");
    const mode = text.indexOf("parseMemoryV3ShadowMode", gate);
    const legacy = text.indexOf("runMemoryV3Shadow({", gate);
    const lifecycle = text.indexOf("runMemoryV3LifecycleShadow({", gate);
    const settle = text.indexOf("await Promise.allSettled", gate);
    assert.equal(gate >= 0, true);
    assert.equal(mode > gate, true);
    assert.equal(legacy > mode, true);
    assert.equal(lifecycle > mode, true);
    assert.equal(settle > legacy && settle > lifecycle, true);
    assert.equal((text.match(/\brunMemoryV3Shadow\s*\(\{/g) ?? []).length, 1);
    assert.equal((text.match(/\brunMemoryV3LifecycleShadow\s*\(\{/g) ?? []).length, 1);
    const dispatch = text.slice(mode, settle);
    assert.match(
      dispatch,
      /const memoryV3ShadowPromise = memoryV3Mode === "lifecycle_shadow"[\s\S]*?: memoryV3Mode === "shadow"[\s\S]*?: Promise\.resolve\(\);/,
    );
  });

  it("reuses the bounded loader and exact server-only environment names", () => {
    const text = source();
    const start = text.indexOf("const memoryV3Mode = parseMemoryV3ShadowMode");
    const end = text.indexOf("await Promise.allSettled", start);
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
    assert.match(text, /Promise\.allSettled\(\[summaryRefreshPromise, memoryV3ShadowPromise\]\)/);
  });
});
