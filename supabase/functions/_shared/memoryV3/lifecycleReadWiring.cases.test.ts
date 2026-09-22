import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

import type { ContextPacket } from "../context.ts";
import type { MemoryV3LifecycleReadContext } from "./lifecycleReadStore.ts";
import { resolveMemoryV3LifecycleReadEligibility } from "./lifecycleReadMode.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "npm:@supabase/supabase-js@2") {
      return nextResolve("@supabase/supabase-js", context);
    }
    return nextResolve(specifier, context);
  },
});

const previousDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno");
Object.defineProperty(globalThis, "Deno", {
  configurable: true,
  enumerable: true,
  writable: true,
  value: { env: { get: () => undefined } },
});

const { buildContextPrompt } = await import("../context.ts");

const STAYSEE_CHAT_SOURCE = readFileSync(
  new URL("../../staysee-chat/index.ts", import.meta.url),
  "utf8",
);
const README_SOURCE = readFileSync(
  new URL("../../../../scripts/memory-v3-pilot/README.md", import.meta.url),
  "utf8",
);
const ALLOWED_USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

if (previousDeno) {
  Object.defineProperty(globalThis, "Deno", previousDeno);
} else {
  delete (globalThis as unknown as { Deno?: unknown }).Deno;
}

const STRUCTURED_SUMMARY = JSON.stringify({
  people: [],
  themes: ["SUMMARY_THEME_SENTINEL"],
  emotional_state: ["SUMMARY_EMOTION_SENTINEL"],
  important_events: ["SUMMARY_EVENT_SENTINEL"],
  preferences: [],
  risks: [],
  open_loops: [],
  last_updated: "2026-09-20T08:00:00Z",
});

function packet(): ContextPacket {
  return {
    conversationMeta: {
      id: "conversation-1",
      title: "Synthetic conversation",
      conversation_summary: STRUCTURED_SUMMARY,
      summary: null,
      emotional_tone: "SUMMARY_TONE_SENTINEL",
      summary_updated_at: "2026-09-20T08:00:00Z",
      created_at: "2026-09-19T08:00:00Z",
      last_message_at: "2026-09-20T09:00:00Z",
      metadata: null,
    },
    recentMessages: [{
      role: "user",
      content: "RECENT_USER_SENTINEL",
      created_at: "2026-09-20T09:00:00Z",
    }],
    memoryItems: [{
      id: "legacy-memory-1",
      memory_type: "life_context",
      content: "У пользователя есть сын LEGACY_CROSS_MEMORY_SENTINEL.",
      importance: 5,
      created_at: "2026-09-01T08:00:00Z",
      updated_at: "2026-09-10T08:00:00Z",
      last_used_at: null,
    }],
    now: "2026-09-20T10:00:00Z",
    memoryItemIds: ["legacy-memory-1"],
    corrections: ["EPHEMERAL_CORRECTION_SENTINEL"],
    durableCorrections: [{
      subject_key: "synthetic_subject",
      correction_text: "DURABLE_CORRECTION_TEXT_SENTINEL",
      display_text: "DURABLE_CORRECTION_SENTINEL",
      old_text: null,
      scope: "conversation",
    }],
    messagesSinceSummary: 2,
    archiveExcerpts: [{
      userText: "ARCHIVE_SENTINEL from the user",
      assistantText: "Synthetic assistant reply",
      createdAt: "2026-09-18T08:00:00Z",
      score: 9,
    }],
    userEvidenceQuotes: [{
      createdAt: "2026-09-19T08:00:00Z",
      text: "EVIDENCE_SENTINEL from the user",
    }],
    weeklyReflections: [{
      content: "WEEKLY_REFLECTION_SENTINEL remained important this week",
      created_at: "2026-09-20T07:00:00Z",
    }],
  };
}

function lifecycleContext(): MemoryV3LifecycleReadContext {
  return {
    schemaVersion: "memory-v3-lifecycle-read-context-v1",
    stateRevision: 7,
    items: [{
      kind: "event",
      claim: "V3_EVENT_SENTINEL",
      status: "active",
      sensitivity: "normal",
      eventTimeStart: "2026-09-20",
      eventTimeEnd: null,
      alternative: null,
      updatedAt: "2026-09-20T08:00:00Z",
    }],
  };
}

function assertPreservedContext(result: string): void {
  for (const sentinel of [
    "SUMMARY_THEME_SENTINEL",
    "EPHEMERAL_CORRECTION_SENTINEL",
    "DURABLE_CORRECTION_SENTINEL",
    "WEEKLY_REFLECTION_SENTINEL",
    "ARCHIVE_SENTINEL",
    "EVIDENCE_SENTINEL",
  ]) {
    assert.equal(result.includes(sentinel), true, sentinel);
  }
}

function assertSafeOptionsFailure(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.name, "MemoryV3ContextPromptOptionsError");
    assert.equal(
      error.message,
      "[memory-v3:context-prompt-options] invalid options",
    );
    assert.equal(error.message.includes("RAW_OPTIONS_SENTINEL"), false);
    assert.equal(JSON.stringify(error).includes("RAW_OPTIONS_SENTINEL"), false);
    assert.equal("cause" in error, false);
    return true;
  });
}

type LifecycleReadDiagnostic = "load_failed" | "invalid_shape" | "too_large";

interface LifecycleReadHarnessOptions {
  rawMode: string | null | undefined;
  rawAllowedUserId: string | null | undefined;
  userId: string;
  load: (userId: string) => Promise<unknown>;
}

function ownDataString(value: unknown, key: string): string | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function classifyPromptFailure(error: unknown): LifecycleReadDiagnostic {
  return ownDataString(error, "name") === "MemoryV3LifecycleReadPromptError" &&
      ownDataString(error, "message") ===
        "[memory-v3:lifecycle-read-prompt] prompt too large"
    ? "too_large"
    : "invalid_shape";
}

async function runLifecycleReadHarness(
  options: LifecycleReadHarnessOptions,
): Promise<{
  prompt: string;
  loadCalls: string[];
  stampedIds: string[];
  diagnostics: string[];
  providerCalls: number;
  responseJson: Record<string, unknown>;
  summaryInput: ContextPacket;
  analytics: Record<string, unknown>;
  clientVisible: Record<string, unknown>;
}> {
  const input = packet();
  const summaryInput = structuredClone(input);
  const loadCalls: string[] = [];
  const stampedIds: string[] = [];
  const diagnostics: string[] = [];
  let providerCalls = 0;
  let prompt = buildContextPrompt(input);
  let memoryItemIds = input.memoryItemIds.slice();

  const eligibility = resolveMemoryV3LifecycleReadEligibility({
    rawMode: options.rawMode,
    rawAllowedUserId: options.rawAllowedUserId,
    userId: options.userId,
  });

  if (eligibility.eligible) {
    let loaded: unknown;
    try {
      loadCalls.push(eligibility.userId);
      loaded = await options.load(eligibility.userId);
    } catch {
      diagnostics.push("[memory-v3-lifecycle-read] load_failed");
      loaded = null;
    }

    if (loaded !== null) {
      try {
        prompt = buildContextPrompt(input, {
          lifecycleCrossMemory: loaded as MemoryV3LifecycleReadContext,
        });
        memoryItemIds = [];
      } catch (error) {
        diagnostics.push(
          `[memory-v3-lifecycle-read] ${classifyPromptFailure(error)}`,
        );
        prompt = buildContextPrompt(input);
      }
    }
  }

  providerCalls += 1;
  stampedIds.push(...memoryItemIds);

  return {
    prompt,
    loadCalls,
    stampedIds,
    diagnostics,
    providerCalls,
    responseJson: { content: "MAIN_REPLY_SENTINEL" },
    summaryInput,
    analytics: { providerCalls },
    clientVisible: { content: "MAIN_REPLY_SENTINEL" },
  };
}

function oversizedLifecycleContext(): MemoryV3LifecycleReadContext {
  const context = lifecycleContext();
  context.items = Array.from({ length: 4 }, (_value, index) => ({
    ...context.items[0],
    claim: `OVERSIZED_${index}_${"x".repeat(1_700)}`,
  }));
  return context;
}

describe("Memory V3 lifecycle read context wiring", () => {
  test("authoritative Memory V3 context replaces legacy cross-memory everywhere", () => {
    const input = packet();
    const context = lifecycleContext();
    const packetSnapshot = structuredClone(input);
    const contextSnapshot = structuredClone(context);

    const legacy = buildContextPrompt(input);
    const legacyMentions = legacy.match(/LEGACY_CROSS_MEMORY_SENTINEL/g) ?? [];
    assert.equal(legacyMentions.length >= 2, true);

    const loaded = buildContextPrompt(input, { lifecycleCrossMemory: context });
    assert.equal(loaded.includes("LEGACY_CROSS_MEMORY_SENTINEL"), false);
    assert.match(loaded, /\[MEMORY V3 — CROSS-CONVERSATION CONTEXT\]/);
    assert.match(loaded, /V3_EVENT_SENTINEL/);
    assertPreservedContext(loaded);
    assert.deepEqual(input, packetSnapshot);
    assert.deepEqual(context, contextSnapshot);
  });

  test("authoritative empty Memory V3 context suppresses legacy cross-memory", () => {
    const input = packet();
    const context = lifecycleContext();
    context.items = [];

    const result = buildContextPrompt(input, { lifecycleCrossMemory: context });

    assert.equal(result.includes("LEGACY_CROSS_MEMORY_SENTINEL"), false);
    assert.equal(
      result.includes("[MEMORY V3 — CROSS-CONVERSATION CONTEXT]"),
      false,
    );
    assertPreservedContext(result);
  });

  test("omitted options preserve the legacy output byte for byte", () => {
    const input = packet();
    const snapshot = structuredClone(input);

    const omitted = buildContextPrompt(input);
    const explicitUndefined = buildContextPrompt(input, undefined);

    assert.equal(explicitUndefined, omitted);
    assert.deepEqual(input, snapshot);
  });

  test("rejects hostile option shapes without executing accessors", () => {
    const input = packet();
    const context = lifecycleContext();
    let getterCalls = 0;
    let setterCalls = 0;

    const getter = {};
    Object.defineProperty(getter, "lifecycleCrossMemory", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return context;
      },
    });
    const setterOnly = {};
    Object.defineProperty(setterOnly, "lifecycleCrossMemory", {
      enumerable: true,
      set(value) {
        void value;
        setterCalls += 1;
      },
    });
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "lifecycleCrossMemory", {
      enumerable: false,
      value: context,
    });
    const symbolKeyed = {
      lifecycleCrossMemory: context,
      [Symbol("RAW_OPTIONS_SENTINEL")]: true,
    };
    const inherited = Object.create({ lifecycleCrossMemory: context });
    const throwingProxy = new Proxy({ lifecycleCrossMemory: context }, {
      getOwnPropertyDescriptor() {
        throw new Error("RAW_OPTIONS_SENTINEL");
      },
    });
    const { proxy: revoked, revoke } = Proxy.revocable(
      { lifecycleCrossMemory: context },
      {},
    );
    revoke();

    for (const options of [
      null,
      [],
      1,
      "RAW_OPTIONS_SENTINEL",
      {},
      { lifecycleCrossMemory: context, extra: "RAW_OPTIONS_SENTINEL" },
      getter,
      setterOnly,
      nonEnumerable,
      symbolKeyed,
      inherited,
      throwingProxy,
      revoked,
    ]) {
      assertSafeOptionsFailure(() => buildContextPrompt(input, options as never));
    }

    assert.equal(getterCalls, 0);
    assert.equal(setterCalls, 0);
  });

  test("staysee-chat composes the exact lifecycle read imports and environment gate", () => {
    assert.match(
      STAYSEE_CHAT_SOURCE,
      /import \{\s*resolveMemoryV3LifecycleReadEligibility\s*\} from "\.\.\/_shared\/memoryV3\/lifecycleReadMode\.ts";/,
    );
    assert.match(
      STAYSEE_CHAT_SOURCE,
      /import \{\s*createMemoryV3LifecycleReadStore\s*\} from "\.\.\/_shared\/memoryV3\/lifecycleReadStore\.ts";/,
    );
    assert.match(
      STAYSEE_CHAT_SOURCE,
      /Deno\.env\.get\("STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE"\)/,
    );
    assert.match(
      STAYSEE_CHAT_SOURCE,
      /Deno\.env\.get\("STAYSEE_MEMORY_V3_LIFECYCLE_READ_USER_ID"\)/,
    );

    const start = STAYSEE_CHAT_SOURCE.indexOf(
      "STAYSEE_MEMORY_V3_LIFECYCLE_READ_MODE",
    );
    const end = STAYSEE_CHAT_SOURCE.indexOf("// ── L5: Safety check", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const readComposition = STAYSEE_CHAT_SOURCE.slice(start, end);
    assert.equal(
      readComposition.includes("STAYSEE_MEMORY_V3_SHADOW_USER_ID"),
      false,
    );
    assert.match(readComposition, /memoryItemIds\s*=\s*\[\]/);
  });

  test("disabled, unknown, and other-account requests perform no lifecycle load", async () => {
    for (const entry of [
      { rawMode: "off", userId: ALLOWED_USER_ID },
      { rawMode: "unknown", userId: ALLOWED_USER_ID },
      { rawMode: "canary", userId: OTHER_USER_ID },
    ]) {
      const result = await runLifecycleReadHarness({
        ...entry,
        rawAllowedUserId: ALLOWED_USER_ID,
        load: async () => {
          throw new Error("RAW_LOAD_SENTINEL");
        },
      });
      assert.deepEqual(result.loadCalls, []);
      assert.match(result.prompt, /LEGACY_CROSS_MEMORY_SENTINEL/);
      assert.deepEqual(result.stampedIds, ["legacy-memory-1"]);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.providerCalls, 1);
    }
  });

  test("all mode loads isolated lifecycle state for every authenticated account", async () => {
    for (const userId of [ALLOWED_USER_ID, OTHER_USER_ID]) {
      const result = await runLifecycleReadHarness({
        rawMode: "all",
        rawAllowedUserId: undefined,
        userId,
        load: async (loadedUserId) => {
          assert.equal(loadedUserId, userId);
          return lifecycleContext();
        },
      });
      assert.deepEqual(result.loadCalls, [userId]);
      assert.equal(result.prompt.includes("LEGACY_CROSS_MEMORY_SENTINEL"), false);
      assert.deepEqual(result.stampedIds, []);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.providerCalls, 1);
    }
  });

  test("loaded non-empty and authoritative empty contexts suppress legacy stamping", async () => {
    for (const context of [
      lifecycleContext(),
      { ...lifecycleContext(), items: [] },
    ]) {
      const result = await runLifecycleReadHarness({
        rawMode: "canary",
        rawAllowedUserId: ALLOWED_USER_ID,
        userId: ALLOWED_USER_ID,
        load: async () => context,
      });
      assert.deepEqual(result.loadCalls, [ALLOWED_USER_ID]);
      assert.equal(result.prompt.includes("LEGACY_CROSS_MEMORY_SENTINEL"), false);
      assert.deepEqual(result.stampedIds, []);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.providerCalls, 1);
    }
  });

  test("missing lifecycle head preserves the legacy prompt and stamping", async () => {
    const result = await runLifecycleReadHarness({
      rawMode: "canary",
      rawAllowedUserId: ALLOWED_USER_ID,
      userId: ALLOWED_USER_ID,
      load: async () => null,
    });

    assert.deepEqual(result.loadCalls, [ALLOWED_USER_ID]);
    assert.match(result.prompt, /LEGACY_CROSS_MEMORY_SENTINEL/);
    assert.deepEqual(result.stampedIds, ["legacy-memory-1"]);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.providerCalls, 1);
  });

  test("read failures preserve legacy behavior and expose only closed diagnostics", async () => {
    const invalid = lifecycleContext() as unknown as Record<string, unknown>;
    invalid.items = [{ RAW_INVALID_SHAPE_SENTINEL: true }];
    const cases: Array<{
      load: () => Promise<unknown>;
      diagnostic: LifecycleReadDiagnostic;
    }> = [
      {
        load: async () => {
          throw new Error("RAW_LOAD_SENTINEL");
        },
        diagnostic: "load_failed",
      },
      { load: async () => invalid, diagnostic: "invalid_shape" },
      { load: async () => oversizedLifecycleContext(), diagnostic: "too_large" },
    ];

    for (const entry of cases) {
      const result = await runLifecycleReadHarness({
        rawMode: "canary",
        rawAllowedUserId: ALLOWED_USER_ID,
        userId: ALLOWED_USER_ID,
        load: entry.load,
      });
      assert.deepEqual(result.loadCalls, [ALLOWED_USER_ID]);
      assert.match(result.prompt, /LEGACY_CROSS_MEMORY_SENTINEL/);
      assert.deepEqual(result.stampedIds, ["legacy-memory-1"]);
      assert.deepEqual(result.diagnostics, [
        `[memory-v3-lifecycle-read] ${entry.diagnostic}`,
      ]);
      const publicText = JSON.stringify(result);
      assert.equal(publicText.includes("RAW_LOAD_SENTINEL"), false);
      assert.equal(publicText.includes("RAW_INVALID_SHAPE_SENTINEL"), false);
      assert.equal(result.providerCalls, 1);
    }
  });

  test("hostile lifecycle values never execute getters or leak proxy failures", async () => {
    let getterCalls = 0;
    const getterContext = lifecycleContext();
    Object.defineProperty(getterContext, "items", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("RAW_GETTER_SENTINEL");
      },
    });
    const throwingProxy = new Proxy(lifecycleContext(), {
      ownKeys() {
        throw new Error("RAW_PROXY_SENTINEL");
      },
    });

    for (const context of [getterContext, throwingProxy]) {
      const result = await runLifecycleReadHarness({
        rawMode: "canary",
        rawAllowedUserId: ALLOWED_USER_ID,
        userId: ALLOWED_USER_ID,
        load: async () => context,
      });
      assert.deepEqual(result.diagnostics, [
        "[memory-v3-lifecycle-read] invalid_shape",
      ]);
      assert.match(result.prompt, /LEGACY_CROSS_MEMORY_SENTINEL/);
      assert.equal(JSON.stringify(result).includes("RAW_"), false);
      assert.equal(result.providerCalls, 1);
    }
    assert.equal(getterCalls, 0);
  });

  test("lifecycle context remains server-only and out of summary and analytics", async () => {
    const result = await runLifecycleReadHarness({
      rawMode: "canary",
      rawAllowedUserId: ALLOWED_USER_ID,
      userId: ALLOWED_USER_ID,
      load: async () => lifecycleContext(),
    });

    assert.match(result.prompt, /V3_EVENT_SENTINEL/);
    for (const publicValue of [
      result.responseJson,
      result.summaryInput,
      result.analytics,
      result.clientVisible,
    ]) {
      assert.equal(JSON.stringify(publicValue).includes("V3_EVENT_SENTINEL"), false);
    }
    assert.equal(result.providerCalls, 1);
  });

  test("documents the inactive one-account lifecycle read boundary", () => {
    const heading = "## Memory V3 lifecycle read canary (inactive)";
    const start = README_SOURCE.indexOf(heading);
    assert.notEqual(start, -1, "README is missing the lifecycle read canary section");
    const nextHeading = README_SOURCE.indexOf("\n## ", start + heading.length);
    const section = README_SOURCE.slice(
      start,
      nextHeading === -1 ? README_SOURCE.length : nextHeading,
    );
    const normalizedSection = section.replace(/`/g, "").replace(/\s+/g, " ");

    for (const requiredText of [
      "default off",
      "one exact allowlisted account",
      "replaces only legacy cross-conversation prompt memory",
      "preserves conversation summaries and the technical fallback",
      "authoritative empty result suppresses legacy resurrection",
      "event/active, recurrence/active, and hypothesis/supported",
      "one service-only RPC",
      "zero lifecycle provider calls",
      "zero writes",
      "zero retries",
      "not exposed to the UI or HTTP response",
      "Migration 036",
      "separate explicit authorization",
      "son's and every other account remain unchanged",
    ]) {
      assert.equal(
        normalizedSection.includes(requiredText),
        true,
        `README lifecycle read canary section is missing: ${requiredText}`,
      );
    }
  });
});
