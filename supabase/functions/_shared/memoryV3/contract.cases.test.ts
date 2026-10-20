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
  memoryV3ContractFailureReason,
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
    await normalizeMemoryV3LayeredResponse(value, input, MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation");
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

  it("leaves the extractor room for its real answers instead of cutting them off mid-JSON", () => {
    // Measured on live calls (2026-10-20): answers of 884-1,822 tokens, median 1,323. The old 1,200-token
    // limit cut about 60% of them off, which looked like a transport failure and could not be retried
    // (the identical request is cut at the same place). The limit is only a ceiling: only generated
    // tokens are billed.
    assert.equal(MEMORY_V3_MAX_OUTPUT_TOKENS, 4_000);
    assert.ok(MEMORY_V3_MAX_OUTPUT_TOKENS >= 2 * 1_822);
    assert.equal(MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_RUN, 39_576_000);
    assert.equal(MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_DAY, 158_304_000);
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
      rawFor(), input, MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation",
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

  it("tags items with the caseId's conversationId when scopeMode is conversation", async () => {
    const input = validateMemoryV3Dialogue(dialogue());
    const output = await normalizeMemoryV3LayeredResponse(
      rawFor(), input, MEMORY_V3_EXTRACTOR_VERSION, "conversation",
    );
    assert.equal(output.items[0].scope, "conversation");
    assert.equal(output.items[0].conversationId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  });

  it("rejects an unrecognized scopeMode", async () => {
    let caught: unknown;
    try {
      await normalizeMemoryV3LayeredResponse(rawFor(), dialogue(), MEMORY_V3_EXTRACTOR_VERSION, "everywhere" as never);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^\[memory-v3:contract\]/);
  });

  describe("the reason a response was rejected (a fixed word, never any text)", () => {
    async function reasonOf(raw: unknown, options?: { dropUnsupportedItems?: boolean }) {
      try {
        await normalizeMemoryV3LayeredResponse(raw, dialogue(), MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation", options);
      } catch (error) {
        return memoryV3ContractFailureReason(error);
      }
      return "accepted";
    }
    const twoEvents = () => {
      const first = { ...item("event", "active"), itemRef: "i1", claim: "Первый факт." };
      const second = { ...item("event", "active"), itemRef: "i2", claim: "Второй факт." };
      return {
        layerDecisions: [
          { kind: "event", decision: "emit", itemRefs: ["i1", "i2"] },
          { kind: "recurrence", decision: "omit", itemRefs: [] },
          { kind: "hypothesis", decision: "omit", itemRefs: [] },
        ],
        items: [first, second],
        evidence: [evidence({ itemRef: "i1" }), evidence({ itemRef: "i2" })],
      };
    };

    it("names the stage that failed", async () => {
      assert.equal(await reasonOf({ ...rawFor(), extra: 1 }), "response_shape");
      const emptyClaim = twoEvents();
      emptyClaim.items[0].claim = "";
      assert.equal(await reasonOf(emptyClaim), "items");
      const sameRef = twoEvents();
      sameRef.items[1].itemRef = "i1";
      assert.equal(await reasonOf(sameRef), "items");
      const badDecisions = twoEvents();
      badDecisions.layerDecisions[0].itemRefs = ["i1"];
      assert.equal(await reasonOf(badDecisions), "layer_decisions");
    });

    it("tells apart the ways the evidence can be wrong", async () => {
      const unknownMessage = twoEvents();
      unknownMessage.evidence[1] = evidence({ itemRef: "i2", sourceMessageId: "99999999-9999-4999-8999-999999999999" });
      assert.equal(await reasonOf(unknownMessage), "evidence_message");
      const assistantMessage = twoEvents();
      assistantMessage.evidence[1] = evidence({ itemRef: "i2", sourceMessageId: ASSISTANT });
      assert.equal(await reasonOf(assistantMessage), "evidence_message");
      const duplicate = twoEvents();
      duplicate.evidence.push(evidence({ itemRef: "i1", episodeKey: "episode:other" }));
      assert.equal(await reasonOf(duplicate), "evidence_duplicate");
      const unknownItem = twoEvents();
      unknownItem.evidence[1] = evidence({ itemRef: "nope" });
      assert.equal(await reasonOf(unknownItem), "evidence_fields");
    });

    it("names an item left without enough evidence", async () => {
      const lacking = twoEvents();
      lacking.evidence = [lacking.evidence[0]];
      assert.equal(await reasonOf(lacking), "item_support");
      assert.equal(await reasonOf(lacking, { dropUnsupportedItems: true }), "accepted");
    });

    it("has a reason only for contract rejections, and never carries the response text", async () => {
      assert.equal(memoryV3ContractFailureReason(new Error("boom")), null);
      assert.equal(memoryV3ContractFailureReason(null), null);
      const secret = twoEvents();
      secret.items[0].claim = "RAW_SECRET_SENTINEL";
      secret.evidence = [];
      const reason = await reasonOf(secret);
      assert.match(String(reason), /^[a-z_]+$/);
      assert.equal(String(reason).includes("SECRET"), false);
    });
  });

  describe("dropping an item the model gave no supporting evidence for", () => {
    const dropping = { dropUnsupportedItems: true };
    const normalize = (value: unknown, options?: { dropUnsupportedItems?: boolean }) =>
      normalizeMemoryV3LayeredResponse(value, dialogue(), MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation", options);

    // Two active events; the model cited evidence for the first only. A live run did exactly this
    // (4 items, 3 evidence rows) and the strict check rejected the whole answer, losing the good items.
    function twoEventsOneWithoutEvidence() {
      const first = { ...item("event", "active"), itemRef: "i1", claim: "Первый факт." };
      const second = { ...item("event", "active"), itemRef: "i2", claim: "Факт без цитаты." };
      return {
        layerDecisions: [
          { kind: "event", decision: "emit", itemRefs: ["i1", "i2"] },
          { kind: "recurrence", decision: "omit", itemRefs: [] },
          { kind: "hypothesis", decision: "omit", itemRefs: [] },
        ],
        items: [first, second],
        evidence: [evidence({ itemRef: "i1" })],
      };
    }

    it("still rejects the whole answer by default", async () => {
      await rejectsSafely(twoEventsOneWithoutEvidence());
    });

    it("keeps the supported item with its evidence and drops the unsupported one", async () => {
      const result = await normalize(twoEventsOneWithoutEvidence(), dropping);
      assert.deepEqual(result.items.map((entry) => entry.claim), ["Первый факт."]);
      assert.equal(result.evidence.length, 1);
      assert.equal(result.evidence[0].itemKey, result.items[0].localItemKey);
    });

    it("drops a recurrence that has only one observation instead of failing", async () => {
      const raw = rawFor("recurrence", "active");
      raw.evidence = raw.evidence.slice(0, 1);
      assert.deepEqual(await normalize(raw, dropping), {
        run: { caseId: dialogue().caseId, extractorVersion: MEMORY_V3_EXTRACTOR_VERSION },
        items: [],
        evidence: [],
      });
    });

    it("ends with an empty extraction when no item is supported", async () => {
      const raw = twoEventsOneWithoutEvidence();
      raw.evidence = [];
      const result = await normalize(raw, dropping);
      assert.deepEqual([result.items, result.evidence], [[], []]);
    });

    it("does not forgive other defects: unknown message, duplicate reference, empty claim", async () => {
      const unknownMessage = twoEventsOneWithoutEvidence();
      unknownMessage.evidence = [evidence({ itemRef: "i1", sourceMessageId: "99999999-9999-4999-8999-999999999999" })];
      const duplicateRef = twoEventsOneWithoutEvidence();
      duplicateRef.items[1].itemRef = "i1";
      const emptyClaim = twoEventsOneWithoutEvidence();
      emptyClaim.items[0].claim = "";
      for (const raw of [unknownMessage, duplicateRef, emptyClaim]) {
        await assert.rejects(() => normalize(raw, dropping), /^MemoryV3ContractError: \[memory-v3:contract\]/);
      }
    });
  });

  it("accepts JSON text and empty abstention", async () => {
    const empty = {
      layerDecisions: ["event", "recurrence", "hypothesis"].map((kind) => ({ kind, decision: "omit", itemRefs: [] })),
      items: [],
      evidence: [],
    };
    const output = await normalizeMemoryV3LayeredResponse(JSON.stringify(empty), dialogue(), MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation");
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
      const output = await normalizeMemoryV3LayeredResponse(rawFor(kind, status, relation), dialogue(), MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation");
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
    const output = await normalizeMemoryV3LayeredResponse(raw, dialogue(), MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation");
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
