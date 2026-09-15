import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { MemoryV3ShadowStore } from "./shadowStore.ts";
import {
  runMemoryV3Shadow,
  runMemoryV3ShadowBackgroundSafely,
} from "./shadowRunner.ts";

const INDEX_URL = new URL("../../staysee-chat/index.ts", import.meta.url);
const MEMORY_V3_README_URL = new URL(
  "../../../../scripts/memory-v3-pilot/README.md",
  import.meta.url,
);
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAW_SECRET = "RAW_WIRING_SECRET_SENTINEL";

function indexSource(): string {
  return readFileSync(INDEX_URL, "utf8");
}

function assertSingleShadowPlacement(source: string): void {
  const bgShould = source.indexOf("const bgShould = shouldUpdateConversationSummary");
  const shadowCalls = [...source.matchAll(/\brunMemoryV3Shadow\s*\(/g)];
  assert.equal(shadowCalls.length, 1);
  assert.equal(bgShould >= 0, true);
  assert.equal(shadowCalls[0].index > bgShould, true);
  assert.equal(
    shadowCalls[0].index > source.indexOf('recordReplyPipelineStage("before_http_response"'),
    true,
  );
}

function successfulResponseSource(source: string): string {
  const match = /return new Response\(\s*JSON\.stringify\(\{\s*content: result\.content,[\s\S]*?\}\),\s*\{ headers: \{ \.\.\.corsHeaders, "Content-Type": "application\/json" \} \}\s*\);/.exec(source);
  assert.ok(match, "successful HTTP response block is missing");
  return match[0];
}

function wiringHarness(overrides: Record<string, unknown> = {}) {
  const calls = { load: 0, reserve: 0, succeed: 0, fail: 0, factory: 0, model: 0 };
  const store: MemoryV3ShadowStore = {
    async reserve() {
      calls.reserve += 1;
      return { status: "reserved", runId: RUN_ID };
    },
    async succeed() {
      calls.succeed += 1;
    },
    async fail() {
      calls.fail += 1;
    },
  };
  return {
    calls,
    options: {
      rawMode: "shadow",
      rawAllowedUserId: USER_ID,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      apiKey: "test-key",
      async loadMessages() {
        calls.load += 1;
        return [{
          id: MESSAGE_ID,
          role: "user" as const,
          text: "Синтетическое сообщение для проверки.",
          createdAt: "2026-09-05T10:00:00.000Z",
        }];
      },
      store,
      modelAdapterFactory() {
        calls.factory += 1;
        return async () => {
          calls.model += 1;
          return {
            content: JSON.stringify({
              layerDecisions: [
                { kind: "event", decision: "omit", itemRefs: [] },
                { kind: "recurrence", decision: "omit", itemRefs: [] },
                { kind: "hypothesis", decision: "omit", itemRefs: [] },
              ],
              items: [],
              evidence: [],
            }),
            usage: null,
          };
        };
      },
      ...overrides,
    },
  };
}

describe("staysee-chat Memory V3 source wiring", () => {
  it("imports every reviewed Memory V3 composition dependency exactly", () => {
    const source = indexSource();
    for (const [name, specifier] of [
      ["createMemoryV3MessageLoader", "../_shared/memoryV3/messages.ts"],
      ["createMemoryV3ShadowStore", "../_shared/memoryV3/shadowStore.ts"],
      ["createMemoryV3OpenRouterAdapter", "../_shared/memoryV3/transport.ts"],
      ["runMemoryV3Shadow", "../_shared/memoryV3/shadowRunner.ts"],
      ["runMemoryV3ShadowBackgroundSafely", "../_shared/memoryV3/shadowRunner.ts"],
    ] as const) {
      assert.match(source, new RegExp(`import[\\s\\S]{0,180}\\b${name}\\b[\\s\\S]{0,180}from ["']${specifier.replaceAll(".", "\\.")}["']`));
    }
  });

  it("starts the shadow branch after the response stage but independently of summary refresh", () => {
    const source = indexSource();
    assertSingleShadowPlacement(source);
    const background = source.slice(source.indexOf("const bgShould = shouldUpdateConversationSummary"));
    const stop = background.indexOf("if (!bgShould)");
    const summary = background.indexOf("const summaryRefreshPromise");
    const shadow = background.indexOf("const memoryV3ShadowPromise");
    const settle = background.indexOf("await Promise.allSettled([summaryRefreshPromise, memoryV3ShadowPromise])");
    assert.equal(stop >= 0, true);
    assert.equal(shadow > 0 && shadow < stop, true);
    assert.equal(summary > stop, true);
    assert.equal(settle > summary, true);
    assert.match(
      background.slice(stop, summary),
      /await Promise\.allSettled\(\[memoryV3ShadowPromise\]\)/,
    );
    const earlyMutation = source.replace(
      "const bgShould = shouldUpdateConversationSummary",
      "runMemoryV3Shadow({});\n                  const bgShould = shouldUpdateConversationSummary",
    );
    assert.throws(() => assertSingleShadowPlacement(earlyMutation));
  });

  it("keeps the existing summary arguments and catch log while isolating API keys", () => {
    const source = indexSource();
    const summaryStart = source.indexOf("await runConversationSummaryRefresh({");
    const summaryEnd = source.indexOf("await Promise.allSettled([summaryRefreshPromise, memoryV3ShadowPromise])", summaryStart);
    assert.equal(summaryStart >= 0 && summaryEnd > summaryStart, true);
    const summaryCall = source.slice(summaryStart, summaryEnd);
    assert.match(source, /const summaryApiKey = Deno\.env\.get\(PROVIDERS\[ACTIVE_PROVIDER\]\.envKey\)/);
    for (const required of [
      "supabase: svc",
      "conversationId",
      "userId",
      "previousSummary",
      "transcript: transcriptForSummary",
      "memoryHints",
      "extraDurableCorrections: sameTurnDurableCorrection",
      "baseUrl: PROVIDERS[ACTIVE_PROVIDER].baseUrl",
      "model: PROVIDERS[ACTIVE_PROVIDER].model",
      "apiKey: summaryApiKey",
      "extraHeaders: PROVIDERS[ACTIVE_PROVIDER].extraHeaders",
      "isMemoryDiagConversation(",
      "isSummaryDiagConversation(",
      'path: "background"',
    ]) assert.ok(summaryCall.includes(required), required);
    assert.match(source, /console\.error\("\[staysee-chat\] summary update failed:", sumErr\)/);
    assert.equal((source.match(/rawMode: memoryV3Mode/g) ?? []).length, 2);
    assert.doesNotMatch(source, /rawMode: Deno\.env\.get\("STAYSEE_MEMORY_V3_MODE"\)/);
    assert.match(source, /rawAllowedUserId: Deno\.env\.get\("STAYSEE_MEMORY_V3_SHADOW_USER_ID"\)/);
    assert.match(source, /apiKey: Deno\.env\.get\("OPENROUTER_API_KEY"\)/);
    assert.match(source, /fetchImpl: globalThis\.fetch\.bind\(globalThis\)/);
  });

  it("does not feed shadow output into current memory, summary, audit, or HTTP response", () => {
    const source = indexSource();
    assert.match(source, /AI_AUDIT_MEMORY_VERSION\s*,/);
    const response = successfulResponseSource(source);
    assert.doesNotMatch(response, /memoryV3|shadow|extraction/i);
    const responseMutation = source.replace(
      "provider: result.provider,",
      "memoryV3Shadow: {},\n        provider: result.provider,",
    );
    assert.match(successfulResponseSource(responseMutation), /memoryV3Shadow/);
    for (const callName of [
      "buildContextPacket",
      "buildContextPrompt",
      "runConversationSummaryRefresh",
      "stampMemoryUsed",
    ]) {
      const calls = [...source.matchAll(new RegExp(`${callName}\\s*\\(([^;]*)`, "g"))];
      for (const call of calls) assert.doesNotMatch(call[1], /memoryV3|shadow|extraction/i, callName);
    }
    assert.doesNotMatch(source, /memory_v3_shadow_(runs|identities)/i);
    assert.doesNotMatch(source, /structured-memory-v2/);
  });

  it("keeps V3 shadow tables out of current reads and preserves the V1 audit marker", () => {
    const auditVersions = readFileSync(new URL("../aiAuditVersions.ts", import.meta.url), "utf8");
    assert.match(auditVersions, /AI_AUDIT_MEMORY_VERSION\s*=\s*["']structured-memory-v1["']/);
    for (const relativePath of [
      "../context.ts",
      "../memory.ts",
      "../memoryLayersV2.ts",
      "../../staysee-chat/index.ts",
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      assert.doesNotMatch(source, /memory_v3_shadow_(runs|identities)/i, relativePath);
    }
  });
});

describe("staysee-chat Memory V3 behavior isolation", () => {
  it("does no work for off mode or a different account", async () => {
    for (const overrides of [
      { rawMode: "off" },
      { userId: OTHER_USER_ID },
    ]) {
      const h = wiringHarness(overrides);
      const result = await runMemoryV3Shadow(h.options);
      assert.equal(result.status, "skipped");
      assert.deepEqual(h.calls, { load: 0, reserve: 0, succeed: 0, fail: 0, factory: 0, model: 0 });
    }
  });

  it("always resolves a rejected shadow run and logs only an allowlisted code", async () => {
    const logs: string[] = [];
    await runMemoryV3ShadowBackgroundSafely(
      async () => {
        throw new Error(RAW_SECRET);
      },
      (code) => logs.push(code),
    );
    assert.deepEqual(logs, ["unknown_failure"]);
    assert.equal(JSON.stringify(logs).includes(RAW_SECRET), false);
  });

  it("does not log normal skips or successful results", async () => {
    const logs: string[] = [];
    await runMemoryV3ShadowBackgroundSafely(
      async () => ({ status: "skipped", reason: "disabled" }),
      (code) => logs.push(code),
    );
    await runMemoryV3ShadowBackgroundSafely(
      async () => ({ status: "succeeded", runId: RUN_ID, itemCount: 0, evidenceCount: 0 }),
      (code) => logs.push(code),
    );
    assert.deepEqual(logs, []);
  });
});

describe("Memory V3 production shadow documentation", () => {
  it("documents the inactive pilot and deployment stop", () => {
    const readme = readFileSync(MEMORY_V3_README_URL, "utf8");
    const heading = "## Memory V3 production shadow pilot (inactive)";
    const start = readme.indexOf(heading);
    assert.notEqual(start, -1, "README is missing the production shadow pilot section");
    const nextHeading = readme.indexOf("\n## ", start + heading.length);
    const section = readme.slice(start, nextHeading === -1 ? undefined : nextHeading);

    for (const required of [
      "default off",
      "one exact account UUID",
      "four reservations per UTC day",
      "20,000 UTF-8 bytes",
      "32,768 input-token accounting reservation",
      "$0.029076",
      "$0.116304",
      "planning ceiling, not actual billing",
      "30 days",
      "identity ledger remains until account or conversation deletion",
      "does not affect replies",
      "does not write conversation_summary or user_memory",
      "not deployed",
      "no production shadow call has been authorized",
      "STAYSEE_MEMORY_V3_MODE",
      "STAYSEE_MEMORY_V3_SHADOW_USER_ID",
      "google/gemini-3.7-flash",
      "memory-v3-openrouter-gemini-3.7-flash-shadow-v2",
      "60 source messages",
      "1,200 output tokens",
      "safe source-boundary metadata",
    ]) {
      assert.ok(section.includes(required), `README missing: ${required}`);
    }

    assert.doesNotMatch(section, /run payload holds the bounded input/i);
    assert.doesNotMatch(section, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
    assert.doesNotMatch(section, /STAYSEE_MEMORY_V3_MODE\s*=\s*shadow/);
    assert.doesNotMatch(section, /supabase functions deploy/);
    assert.doesNotMatch(section, /--execute/);
  });
});
