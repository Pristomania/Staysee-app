import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeLocalItemKey } from "../../../../scripts/memory-v3-pilot/contracts.mjs";

import {
  MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_DAY,
  MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_RUN,
  MEMORY_V3_EXTRACTOR_VERSION,
  MEMORY_V3_INPUT_NANODOLLARS_PER_TOKEN,
  MEMORY_V3_MAX_DAILY_RESERVATIONS,
  MEMORY_V3_MAX_OUTPUT_TOKENS,
  MEMORY_V3_OUTPUT_NANODOLLARS_PER_TOKEN,
  MEMORY_V3_RESERVED_INPUT_TOKENS,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
} from "./contract.ts";

const USER_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSISTANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const USER_3 = "11111111-1111-4111-8111-111111111111";
const USER_4 = "22222222-2222-4222-8222-222222222222";

function dialogue() {
  return {
    caseId: "memory-v3-shadow:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    messages: [
      { id: USER_1, role: "user", text: "Первый эпизод.", createdAt: "2026-09-05T10:00:00.000+14:00" },
      { id: ASSISTANT, role: "assistant", text: "Контекст.", createdAt: "2026-09-05T10:01:00.000Z" },
      { id: USER_2, role: "user", text: "Второй эпизод.", createdAt: "2026-09-05T10:02:00.000-14:00" },
      { id: USER_3, role: "user", text: "Подтверждение паттерна.", createdAt: "2026-09-05T10:03:00.000Z" },
      { id: USER_4, role: "user", text: "Граница применимости.", createdAt: "2026-09-05T10:04:00.000Z" },
    ],
  };
}

function item(kind = "hypothesis", status = "candidate") {
  return {
    itemRef: "i1",
    kind,
    claim: kind === "hypothesis" ? "Юмор может помогать выдерживать страх." : "Запомненный факт.",
    status,
    sensitivity: "normal",
    eventTimeStart: null,
    eventTimeEnd: null,
    alternative: kind === "hypothesis" ? "Юмор может поддерживать собеседника." : null,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    itemRef: "i1",
    sourceMessageId: USER_1,
    relation: "supports",
    supportType: null,
    episodeKey: `episode:${USER_1}`,
    ...overrides,
  };
}

function rawFor(kind = "hypothesis", status = "candidate", relation = "supports") {
  const selected = item(kind, status);
  const rows = kind === "recurrence" && (status === "candidate" || status === "active")
    ? [
      evidence({ supportType: "episode_observation" }),
      evidence({ sourceMessageId: USER_2, supportType: "episode_observation", episodeKey: `episode:${USER_2}` }),
    ]
    : [evidence({ relation })];
  return {
    layerDecisions: ["event", "recurrence", "hypothesis"].map((layer) => ({
      kind: layer,
      decision: layer === kind ? "emit" : "omit",
      itemRefs: layer === kind ? ["i1"] : [],
    })),
    items: [selected],
    evidence: rows,
  };
}

async function rejectsSafely(value: unknown, input = dialogue()) {
  let caught: unknown;
  try {
    await normalizeMemoryV3LayeredResponse(value, input, MEMORY_V3_EXTRACTOR_VERSION);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /^\[memory-v3:contract\]/);
  assert.equal("cause" in caught, false);
  return caught;
}

describe("Memory V3 production contract", () => {
  it("locks configured nanodollar exposure", () => {
    assert.equal(
      MEMORY_V3_RESERVED_INPUT_TOKENS * MEMORY_V3_INPUT_NANODOLLARS_PER_TOKEN +
        MEMORY_V3_MAX_OUTPUT_TOKENS * MEMORY_V3_OUTPUT_NANODOLLARS_PER_TOKEN,
      MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_RUN,
    );
    assert.equal(
      MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_RUN * MEMORY_V3_MAX_DAILY_RESERVATIONS,
      MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_DAY,
    );
  });

  it("validates dialogue without mutation and returns allowlisted copies", () => {
    const input = dialogue();
    const snapshot = structuredClone(input);
    const result = validateMemoryV3Dialogue(input);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(result, snapshot);
    assert.notEqual(result, input);
    assert.notEqual(result.messages, input.messages);
    assert.notEqual(result.messages[0], input.messages[0]);
  });

  it("normalizes a hypothesis with trusted identity and provenance", async () => {
    const input = validateMemoryV3Dialogue(dialogue());
    const output = await normalizeMemoryV3LayeredResponse(
      rawFor(), input, MEMORY_V3_EXTRACTOR_VERSION,
    );
    assert.deepEqual(output.run, { caseId: input.caseId, extractorVersion: MEMORY_V3_EXTRACTOR_VERSION });
    assert.equal(output.items.length, 1);
    assert.match(output.items[0].localItemKey, /^[0-9a-f]{64}$/);
    assert.equal(output.items[0].scope, "cross_conversation");
    assert.equal(output.items[0].conversationId, null);
    assert.equal(output.evidence[0].itemKey, output.items[0].localItemKey);
    assert.equal(output.evidence[0].provenanceRole, "user");
    assert.equal(output.evidence[0].mentionTime, input.messages[0].createdAt);
    assert.equal(JSON.stringify(output).includes("itemRef"), false);
    assert.equal(JSON.stringify(output).includes("layerDecisions"), false);
    assert.equal(output.items[0].localItemKey, makeLocalItemKey(output.items[0], 0));
  });

  it("accepts JSON text and empty abstention", async () => {
    const empty = {
      layerDecisions: ["event", "recurrence", "hypothesis"].map((kind) => ({ kind, decision: "omit", itemRefs: [] })),
      items: [],
      evidence: [],
    };
    const output = await normalizeMemoryV3LayeredResponse(JSON.stringify(empty), dialogue(), MEMORY_V3_EXTRACTOR_VERSION);
    assert.deepEqual(output.items, []);
    assert.deepEqual(output.evidence, []);
  });

  for (const [kind, status, relation] of [
    ["event", "active", "supports"], ["event", "corrected", "corrects"], ["event", "rejected", "rejects"],
    ["recurrence", "candidate", "supports"], ["recurrence", "active", "supports"],
    ["recurrence", "stale", "contradicts"], ["recurrence", "rejected", "rejects"],
    ["hypothesis", "candidate", "supports"], ["hypothesis", "supported", "supports"],
    ["hypothesis", "stale", "contradicts"], ["hypothesis", "rejected", "rejects"],
  ]) {
    it(`accepts ${kind}/${status} with ${relation}`, async () => {
      const output = await normalizeMemoryV3LayeredResponse(rawFor(kind, status, relation), dialogue(), MEMORY_V3_EXTRACTOR_VERSION);
      assert.equal(output.items[0].status, status);
    });
  }

  for (const [kind, status, required, wrong] of [
    ["event", "active", "supports", "contradicts"], ["event", "corrected", "corrects", "supports"], ["event", "rejected", "rejects", "supports"],
    ["recurrence", "stale", "contradicts", "supports"], ["recurrence", "rejected", "rejects", "contradicts"],
    ["hypothesis", "candidate", "supports", "contradicts"], ["hypothesis", "supported", "supports", "rejects"],
    ["hypothesis", "stale", "contradicts", "supports"], ["hypothesis", "rejected", "rejects", "supports"],
  ]) {
    it(`rejects ${kind}/${status} without required ${required}`, async () => {
      await rejectsSafely(rawFor(kind, status, wrong));
    });
  }

  it("rejects active recurrence with fewer than two distinct observations", async () => {
    const raw = rawFor("recurrence", "active", "supports");
    raw.evidence.pop();
    await rejectsSafely(raw);
  });

  it("rejects invalid supportType and episodeKey combinations", async () => {
    const confirmation = rawFor("recurrence", "active", "supports");
    confirmation.evidence[0].supportType = "pattern_confirmation";
    await rejectsSafely(confirmation);
    const event = rawFor("event", "active", "supports");
    event.evidence[0].supportType = "episode_observation";
    await rejectsSafely(event);
  });

  it("preserves typed recurrence evidence including null episode keys", async () => {
    const raw = rawFor("recurrence", "active", "supports");
    raw.evidence.push(evidence({ sourceMessageId: USER_3, supportType: "pattern_confirmation", episodeKey: null }));
    raw.evidence.push(evidence({ sourceMessageId: USER_4, supportType: "scope_boundary", episodeKey: null }));
    const output = await normalizeMemoryV3LayeredResponse(raw, dialogue(), MEMORY_V3_EXTRACTOR_VERSION);
    assert.deepEqual(output.evidence.map((row) => [row.supportType, row.episodeKey]), [
      ["episode_observation", `episode:${USER_1}`],
      ["episode_observation", `episode:${USER_2}`],
      ["pattern_confirmation", null],
      ["scope_boundary", null],
    ]);
  });

  for (const relation of ["supports", "contradicts", "corrects", "rejects"]) {
    it(`rejects assistant evidence for ${relation}`, async () => {
      const raw = rawFor("event", relation === "supports" ? "active" : relation === "corrects" ? "corrected" : "rejected", relation);
      raw.evidence[0].sourceMessageId = ASSISTANT;
      await rejectsSafely(raw);
    });
  }

  it("rejects invalid UTC offsets but accepts both ±14:00", async () => {
    validateMemoryV3Dialogue(dialogue());
    for (const offset of ["+14:01", "-14:01"]) {
      const input = dialogue();
      input.messages[0].createdAt = `2026-09-05T10:00:00${offset}`;
      assert.throws(
        () => validateMemoryV3Dialogue(input),
        (error: unknown) => error instanceof Error && /^\[memory-v3:contract\]/.test(error.message),
      );
    }
  });

  it("rejects duplicate evidence identity even when episode keys differ", async () => {
    const raw = rawFor("event", "active", "supports");
    raw.evidence.push(evidence({ episodeKey: "another-episode" }));
    await rejectsSafely(raw);
  });

  it("rejects incomplete layer decisions and model-created identity fields", async () => {
    const missingLayer = rawFor();
    missingLayer.layerDecisions.pop();
    await rejectsSafely(missingLayer);
    const identity = rawFor();
    Object.assign(identity.items[0], { localItemKey: "attacker" });
    await rejectsSafely(identity);
  });

  it("rejects unknown, sparse, symbol, accessor and non-enumerable fields", async () => {
    const unknown = rawFor();
    Object.assign(unknown, { extra: true });
    await rejectsSafely(unknown);
    const sparse = rawFor();
    sparse.evidence = new Array(1) as typeof sparse.evidence;
    await rejectsSafely(sparse);
    const symbol = rawFor();
    Object.defineProperty(symbol.items[0], Symbol("secret"), { value: true, enumerable: true });
    await rejectsSafely(symbol);
    let getterCalls = 0;
    const accessor = rawFor();
    Object.defineProperty(accessor.items[0], "claim", { enumerable: true, get() { getterCalls += 1; return "SECRET"; } });
    const error = await rejectsSafely(accessor);
    assert.equal(getterCalls, 0);
    assert.equal(error.message.includes("SECRET"), false);
    const hidden = rawFor();
    Object.defineProperty(hidden.items[0], "claim", { value: "hidden", enumerable: false });
    await rejectsSafely(hidden);
  });

  it("keeps attacker-controlled strings out of public diagnostics", async () => {
    const sentinel = "RAW_CONTRACT_SECRET_SENTINEL";
    const value = new Proxy({}, { ownKeys() { throw new Error(sentinel); } });
    const error = await rejectsSafely(value);
    assert.equal(error.message.includes(sentinel), false);
    assert.equal(JSON.stringify(error).includes(sentinel), false);
  });
});
