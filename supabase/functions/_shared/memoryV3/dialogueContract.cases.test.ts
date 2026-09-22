import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { MemoryV3Extraction } from "./contract.ts";
import {
  MEMORY_V3_DIALOGUE_CONFIGURED_CEILING_NANODOLLARS_PER_RUN,
  MEMORY_V3_DIALOGUE_HARD_GATE_NANODOLLARS_PER_RUN,
  MEMORY_V3_DIALOGUE_MAX_CANDIDATES,
  MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE,
  MEMORY_V3_DIALOGUE_MAX_DAILY_RESERVATIONS,
  MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES,
  MEMORY_V3_DIALOGUE_MAX_MODEL_CALLS_PER_RUN,
  MEMORY_V3_DIALOGUE_MAX_OUTPUT_TOKENS_PER_CALL,
  MEMORY_V3_DIALOGUE_MAX_RECONCILER_BYTES,
  MEMORY_V3_DIALOGUE_MAX_SOURCE_MESSAGES,
  MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE,
  MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS,
  MEMORY_V3_DIALOGUE_MODEL,
  MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
  MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
  MEMORY_V3_DIALOGUE_RESERVED_INPUT_TOKENS_PER_CALL,
  MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
  projectSafeMemoryV3DialogueContractDiagnostic,
  validateMemoryV3DialogueProposal,
  validateMemoryV3DialogueState,
  validateMemoryV3DialogueTrustedForgetKeys,
} from "./dialogueContract.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const RAW_SENTINEL = "RAW_DIALOGUE_SECRET_SENTINEL";

type JsonRecord = Record<string, unknown>;
type ProposalContext = Parameters<typeof validateMemoryV3DialogueProposal>[1];

const dataset = JSON.parse(readFileSync(
  new URL("../../../../scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json", import.meta.url),
  "utf8",
)) as JsonRecord;

function memoryKey(index: number): string {
  return (index + 1).toString(16).padStart(64, "0");
}

// The dataset was authored for the cross-conversation contract: every
// extraction item carries scope: "cross_conversation", conversationId:
// null, and state evidence rows carry whatever synthetic conversationId
// the scenario used -- several scenarios (e.g. sensitivity-preserved)
// deliberately reuse the same placeholder sourceMessageId ("m1") across
// multiple synthetic conversations, to test a pattern recurring across
// separate chats. Dialogue isolation reuses the same 80 authored
// scenarios for reconciliation-logic coverage, retagged onto one fixed
// conversation -- which requires folding the original conversationId
// into sourceMessageId too, or those reused placeholder ids collide
// once every row shares one real conversationId (this is a dataset-
// placeholder artifact, not a real-world case: production sourceMessageId
// values are globally unique UUIDs that never repeat across conversations).
function retagForDialogue(evidence: JsonRecord): JsonRecord {
  return {
    ...evidence,
    conversationId: CONVERSATION_ID,
    sourceMessageId: `${evidence.conversationId}-${evidence.sourceMessageId}`,
  };
}

function runtimeState(scenarioId: string, expectedState: JsonRecord, revision = 0): JsonRecord {
  return {
    schemaVersion: MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    stateRevision: revision,
    nextMemoryOrdinal: expectedState.items.length + 1,
    items: expectedState.items.map((entry: JsonRecord, index: number) => {
      const item = structuredClone(entry);
      delete item.goldMemoryId;
      delete item.tier;
      return {
        memoryKey: memoryKey(index),
        ...structuredClone(item),
        evidence: (item.evidence as JsonRecord[]).map(retagForDialogue),
      };
    }),
    scenarioId,
  };
}

function productionState(scenarioId: string, expectedState: JsonRecord, revision = 0): JsonRecord {
  const state = runtimeState(scenarioId, expectedState, revision);
  delete state.scenarioId;
  return state;
}

function proposalFixture(step: JsonRecord, previousExpectedState: JsonRecord) {
  const memoryByGoldId = new Map<string, { memoryRef: string; memoryKey: string }>();
  previousExpectedState.items.forEach((item: JsonRecord, index: number) => {
    memoryByGoldId.set(item.goldMemoryId, {
      memoryRef: `memory:${index + 1}`,
      memoryKey: memoryKey(index),
    });
  });
  const candidates = step.validatedExtraction.items.map((item: JsonRecord, index: number) => ({
    candidateRef: `candidate:${index + 1}`,
    localItemKey: item.localItemKey,
  }));
  const candidateByKey = new Map(candidates.map((entry: JsonRecord) => [entry.localItemKey, entry]));
  const extraction = structuredClone(step.validatedExtraction) as MemoryV3Extraction;
  extraction.items = extraction.items.map((item) => ({
    ...item, scope: "conversation" as const, conversationId: CONVERSATION_ID,
  }));
  // extraction-level evidence has no conversationId field (only state-level
  // evidence does -- the store layer attaches it once messages are known to
  // belong to a conversation), so it is left exactly as the dataset authored it.
  return {
    state: productionState("ignored", previousExpectedState),
    extraction,
    bindings: {
      memories: [...memoryByGoldId.values()],
      candidates,
    },
    raw: {
      operations: step.scriptedProposal.map((operation: JsonRecord) => ({
        type: operation.type,
        candidateRef: candidateByKey.get(operation.candidateLocalItemKey).candidateRef,
        targetMemoryRef: operation.targetGoldMemoryId === null
          ? null
          : memoryByGoldId.get(operation.targetGoldMemoryId)?.memoryRef,
      })),
    },
    expected: step.scriptedProposal.map((operation: JsonRecord) => ({
      type: operation.type,
      candidateLocalItemKey: operation.candidateLocalItemKey,
      targetMemoryKey: operation.targetGoldMemoryId === null
        ? null
        : memoryByGoldId.get(operation.targetGoldMemoryId)?.memoryKey,
    })),
  };
}

function firstScenarioStep(): JsonRecord {
  return dataset.scenarios[0].steps[0];
}

function baseFixture() {
  const step = firstScenarioStep();
  return proposalFixture(step, { items: [] });
}

function contextOf(fixture: JsonRecord) {
  return {
    state: fixture.state,
    extraction: fixture.extraction,
    bindings: fixture.bindings,
  };
}

function assertContractError(
  fn: () => unknown,
  diagnosticCode: string,
  sentinel = RAW_SENTINEL,
): Error {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "expected dialogue contract error");
  assert.match(error.message, /^\[memory-v3:dialogue-contract\] /);
  assert.equal("cause" in error, false);
  assert.equal(JSON.stringify(error).includes(sentinel), false);
  assert.equal(projectSafeMemoryV3DialogueContractDiagnostic(error), diagnosticCode);
  return error;
}

describe("Memory V3 dialogue constants", () => {
  it("exports the locked production limits and identities", () => {
    assert.deepEqual({
      schema: MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
      pipeline: MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
      reconciler: MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
      model: MEMORY_V3_DIALOGUE_MODEL,
      sourceMessages: MEMORY_V3_DIALOGUE_MAX_SOURCE_MESSAGES,
      candidates: MEMORY_V3_DIALOGUE_MAX_CANDIDATES,
      candidateEvidence: MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE,
      stateItems: MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS,
      stateEvidence: MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE,
      extractorBytes: MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES,
      reconcilerBytes: MEMORY_V3_DIALOGUE_MAX_RECONCILER_BYTES,
      inputTokens: MEMORY_V3_DIALOGUE_RESERVED_INPUT_TOKENS_PER_CALL,
      outputTokens: MEMORY_V3_DIALOGUE_MAX_OUTPUT_TOKENS_PER_CALL,
      calls: MEMORY_V3_DIALOGUE_MAX_MODEL_CALLS_PER_RUN,
      reservations: MEMORY_V3_DIALOGUE_MAX_DAILY_RESERVATIONS,
      ceiling: MEMORY_V3_DIALOGUE_CONFIGURED_CEILING_NANODOLLARS_PER_RUN,
      hardGate: MEMORY_V3_DIALOGUE_HARD_GATE_NANODOLLARS_PER_RUN,
    }, {
      schema: "memory-v3-dialogue-state-v1",
      pipeline: "memory-v3-dialogue-v1",
      reconciler: "memory-v3-dialogue-reconciler-v1",
      model: "google/gemini-3.7-flash",
      sourceMessages: 60,
      candidates: 100,
      candidateEvidence: 500,
      stateItems: 100,
      stateEvidence: 500,
      extractorBytes: 20_000,
      reconcilerBytes: 80_000,
      inputTokens: 32_768,
      outputTokens: 1_200,
      calls: 2,
      reservations: 1,
      ceiling: 58_152_000,
      hardGate: 65_000_000,
    });
  });
});

describe("frozen dialogue reconciliation parity", () => {
  const steps = dataset.scenarios.flatMap((scenario: JsonRecord) =>
    scenario.steps.map((step: JsonRecord, index: number) => ({ scenario, step, index })));

  it("contains exactly 80 authored synthetic steps", () => {
    assert.equal(steps.length, 80);
  });

  for (const { scenario, step, index } of steps) {
    it(`accepts ${step.stepId} retagged onto one conversation`, () => {
      const previous = index === 0 ? { items: [] } : scenario.steps[index - 1].expectedState;
      const fixture = proposalFixture(step, previous);
      fixture.state.stateRevision = index;
      const before = structuredClone(fixture);
      const state = validateMemoryV3DialogueState(fixture.state, USER_ID, CONVERSATION_ID);
      const actual = validateMemoryV3DialogueProposal(fixture.raw, {
        state,
        extraction: fixture.extraction,
        bindings: fixture.bindings,
      });
      assert.deepEqual(actual, fixture.expected);
      assert.deepEqual(fixture, before);
      assert.notEqual(actual, fixture.expected);
    });
  }
});

describe("state and trusted forgetting", () => {
  it("accepts an empty state and returns fresh data", () => {
    const raw = productionState("empty", { items: [] }, 0);
    const actual = validateMemoryV3DialogueState(raw, USER_ID, CONVERSATION_ID);
    assert.deepEqual(actual, raw);
    assert.notEqual(actual, raw);
    assert.notEqual(actual.items, raw.items);
  });

  it("requires canonical matching user identity, conversation identity, schema, revision and ordinal", () => {
    const raw = productionState("empty", { items: [] });
    const mutations: Array<(value: JsonRecord) => void> = [
      (value) => { value.schemaVersion = "other"; },
      (value) => { value.userId = "NOT-A-UUID"; },
      (value) => { value.userId = "22222222-2222-4222-8222-222222222222"; },
      (value) => { value.conversationId = "NOT-A-UUID"; },
      (value) => { value.conversationId = OTHER_CONVERSATION_ID; },
      (value) => { value.stateRevision = -1; },
      (value) => { value.stateRevision = 0.5; },
      (value) => { value.nextMemoryOrdinal = 0; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(raw);
      mutate(value);
      assertContractError(
        () => validateMemoryV3DialogueState(value, USER_ID, CONVERSATION_ID),
        "dialogue_contract_invalid_state",
      );
    }
  });

  it("does not coerce an attacker-controlled expected user or conversation identity", () => {
    const raw = productionState("empty", { items: [] });
    let coercionCalls = 0;
    const expected = {
      toString() { coercionCalls += 1; return USER_ID; },
    };
    assertContractError(
      () => validateMemoryV3DialogueState(raw, expected as unknown as string, CONVERSATION_ID),
      "dialogue_contract_invalid_state",
    );
    assertContractError(
      () => validateMemoryV3DialogueState(raw, USER_ID, expected as unknown as string),
      "dialogue_contract_invalid_state",
    );
    assert.equal(coercionCalls, 0);
  });

  it("accepts unique existing forget keys and rejects unknown or duplicate keys", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps[0].expectedState.items.length > 0);
    const state = productionState("state", scenario.steps[0].expectedState, 1);
    const keys = state.items.map((item: JsonRecord) => item.memoryKey);
    assert.deepEqual(validateMemoryV3DialogueTrustedForgetKeys(keys, state), keys);
    assert.notEqual(validateMemoryV3DialogueTrustedForgetKeys(keys, state), keys);
    assertContractError(
      () => validateMemoryV3DialogueTrustedForgetKeys(["f".repeat(64)], state),
      "dialogue_contract_invalid_forget",
    );
    assertContractError(
      () => validateMemoryV3DialogueTrustedForgetKeys([keys[0], keys[0]], state),
      "dialogue_contract_invalid_forget",
    );
  });

  it("enforces state item and evidence caps", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps[0].expectedState.items.length > 0);
    const one = productionState("state", scenario.steps[0].expectedState, 1).items[0];
    const tooManyItems = productionState("empty", { items: [] });
    tooManyItems.items = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(one), memoryKey: memoryKey(index),
    }));
    tooManyItems.nextMemoryOrdinal = 102;
    assertContractError(
      () => validateMemoryV3DialogueState(tooManyItems, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_state",
    );
    const tooMuchEvidence = productionState("empty", { items: [] });
    tooMuchEvidence.items = [{
      ...structuredClone(one),
      evidence: Array.from({ length: 501 }, (_, index) => ({
        ...structuredClone(one.evidence[0]), sourceMessageId: `m${index}`,
      })),
    }];
    tooMuchEvidence.nextMemoryOrdinal = 2;
    assertContractError(
      () => validateMemoryV3DialogueState(tooMuchEvidence, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_state",
    );
  });

  it("accepts UTC offset +14:00, rejects +14:01, and preserves item order", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps[0].expectedState.items.length > 0);
    const state = productionState("state", scenario.steps[0].expectedState, 1);
    state.items[0].evidence[0].mentionTime = "2026-01-01T10:00:00+14:00";
    const second = structuredClone(state.items[0]);
    second.memoryKey = memoryKey(1);
    state.items = [second, state.items[0]];
    state.nextMemoryOrdinal = 3;
    const actual = validateMemoryV3DialogueState(state, USER_ID, CONVERSATION_ID);
    assert.deepEqual(actual.items.map((item) => item.memoryKey), [memoryKey(1), memoryKey(0)]);
    state.items[0].evidence[0].mentionTime = "2026-01-01T10:00:00+14:01";
    assertContractError(
      () => validateMemoryV3DialogueState(state, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_state",
    );
  });

  it("rejects evidence tagged with a different conversation", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps[0].expectedState.items.length > 0);
    const state = productionState("state", scenario.steps[0].expectedState, 1);
    state.items[0].evidence[0].conversationId = OTHER_CONVERSATION_ID;
    assertContractError(
      () => validateMemoryV3DialogueState(state, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_state",
    );
  });
});

describe("proposal rules", () => {
  it("rejects the model envelope before inspecting trusted context", () => {
    const fixture = baseFixture();
    let contextInspections = 0;
    const context = new Proxy(contextOf(fixture), {
      ownKeys(target) {
        contextInspections += 1;
        return Reflect.ownKeys(target);
      },
    });
    assertContractError(
      () => validateMemoryV3DialogueProposal({ operations: [], extra: true }, context),
      "dialogue_contract_invalid_proposal",
    );
    assert.equal(contextInspections, 0);
  });

  it("rejects unknown refs, missing candidates and model-supplied durable keys", () => {
    const fixture = baseFixture();
    for (const raw of [
      { operations: [{ ...fixture.raw.operations[0], candidateRef: "missing" }] },
      { operations: [] },
      { operations: [{ ...fixture.raw.operations[0], targetMemoryRef: memoryKey(0) }] },
    ]) {
      assertContractError(
        () => validateMemoryV3DialogueProposal(raw, contextOf(fixture)),
        "dialogue_contract_invalid_proposal",
      );
    }
  });

  it("rejects extraction items scoped to a different conversation", () => {
    const fixture = baseFixture();
    fixture.extraction.items[0].conversationId = OTHER_CONVERSATION_ID;
    assertContractError(
      () => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
    );
  });

  it("allows multiple confirms but makes a closing or revise operation exclusive per target", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps.length > 1 && entry.steps[1].scriptedProposal[0].targetGoldMemoryId);
    const step = scenario.steps[1];
    const fixture = proposalFixture(step, scenario.steps[0].expectedState);
    const candidate = fixture.extraction.items[0];
    fixture.extraction.items.push({ ...structuredClone(candidate), localItemKey: `${candidate.localItemKey}-2` });
    fixture.extraction.evidence.push(...fixture.extraction.evidence
      .filter((row: JsonRecord) => row.itemKey === candidate.localItemKey)
      .map((row: JsonRecord) => ({ ...structuredClone(row), itemKey: `${candidate.localItemKey}-2` })));
    fixture.bindings.candidates.push({ candidateRef: "candidate:2", localItemKey: `${candidate.localItemKey}-2` });
    const target = fixture.bindings.memories[0].memoryRef;
    assert.doesNotThrow(() => validateMemoryV3DialogueProposal({ operations: [
      { type: "confirm", candidateRef: "candidate:1", targetMemoryRef: target },
      { type: "confirm", candidateRef: "candidate:2", targetMemoryRef: target },
    ] }, contextOf(fixture)));
    assertContractError(() => validateMemoryV3DialogueProposal({ operations: [
      { type: "confirm", candidateRef: "candidate:1", targetMemoryRef: target },
      { type: "revise", candidateRef: "candidate:2", targetMemoryRef: target },
    ] }, contextOf(fixture)), "dialogue_contract_invalid_proposal");
  });

  it("rejects closed targets and kind conversion", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps.length > 1 && entry.steps[1].scriptedProposal[0].targetGoldMemoryId);
    const fixture = proposalFixture(scenario.steps[1], scenario.steps[0].expectedState);
    fixture.state.items[0].status = "rejected";
    fixture.state.items[0].evidence[0].relation = "rejects";
    assertContractError(
      () => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
    );

    const conversion = proposalFixture(scenario.steps[1], scenario.steps[0].expectedState);
    conversion.extraction.items[0].kind = conversion.state.items[0].kind === "event" ? "hypothesis" : "event";
    if (conversion.extraction.items[0].kind === "hypothesis") {
      conversion.extraction.items[0].alternative = "Another cautious interpretation";
    } else {
      conversion.extraction.items[0].alternative = null;
    }
    assertContractError(
      () => validateMemoryV3DialogueProposal(conversion.raw, contextOf(conversion)),
      "dialogue_contract_invalid_proposal",
    );
  });

  it("requires enough observations when creating recurrence memory", () => {
    const fixture = baseFixture();
    fixture.extraction.items[0].kind = "recurrence";
    fixture.extraction.items[0].status = "active";
    fixture.extraction.evidence[0].supportType = "episode_observation";
    assertContractError(
      () => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
    );
    fixture.extraction.items[0].status = "candidate";
    assert.doesNotThrow(() => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)));
  });

  it("requires contradiction for mark_stale and rejection evidence for reject", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) =>
      entry.steps[0].expectedState.items.some((item: JsonRecord) => item.kind === "recurrence"));
    const prior = scenario.steps[0].expectedState;
    const step = structuredClone(scenario.steps[1]);
    const fixture = proposalFixture(step, prior);
    const operation = fixture.raw.operations[0];
    operation.type = "mark_stale";
    fixture.extraction.items[0].status = "active";
    assertContractError(
      () => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
    );
    operation.type = "reject";
    assertContractError(
      () => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
    );
  });

  it("enforces candidate and candidate-evidence caps before reconciliation", () => {
    const fixture = baseFixture();
    const item = fixture.extraction.items[0];
    const row = fixture.extraction.evidence[0];
    fixture.extraction.items = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(item), localItemKey: `candidate-${index}`,
    }));
    fixture.extraction.evidence = fixture.extraction.items.map((entry: JsonRecord, index: number) => ({
      ...structuredClone(row), itemKey: entry.localItemKey, sourceMessageId: `m${index}`,
    }));
    fixture.bindings.candidates = fixture.extraction.items.map((entry: JsonRecord, index: number) => ({
      candidateRef: `candidate:${index}`, localItemKey: entry.localItemKey,
    }));
    fixture.raw.operations = fixture.bindings.candidates.map((entry: JsonRecord) => ({
      type: "ignore", candidateRef: entry.candidateRef, targetMemoryRef: null,
    }));
    assertContractError(
      () => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
    );

    const evidenceFixture = baseFixture();
    evidenceFixture.extraction.evidence = Array.from({ length: 501 }, (_, index) => ({
      ...structuredClone(evidenceFixture.extraction.evidence[0]), sourceMessageId: `m${index}`,
    }));
    assertContractError(
      () => validateMemoryV3DialogueProposal(evidenceFixture.raw, contextOf(evidenceFixture)),
      "dialogue_contract_invalid_proposal",
    );
  });
});

describe("strict JSON-data-only boundaries", () => {
  it("rejects accessors without executing them", () => {
    const raw = productionState("empty", { items: [] });
    let getterCalls = 0;
    Object.defineProperty(raw, "items", {
      enumerable: true,
      get() { getterCalls += 1; return []; },
    });
    assertContractError(
      () => validateMemoryV3DialogueState(raw, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_shape",
    );
    assert.equal(getterCalls, 0);
  });

  it("rejects setter-only proposal fields without invoking them", () => {
    const fixture = baseFixture();
    let setterCalls = 0;
    Object.defineProperty(fixture.raw.operations[0], "candidateRef", {
      enumerable: true,
      set() { setterCalls += 1; },
    });
    assertContractError(
      () => validateMemoryV3DialogueProposal(fixture.raw, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
    );
    assert.equal(setterCalls, 0);
  });

  it("rejects symbols, non-enumerable, inherited, sparse and cyclic data", () => {
    const factories: Array<() => unknown> = [
      () => Object.assign(productionState("empty", { items: [] }), { [Symbol("secret")]: RAW_SENTINEL }),
      () => {
        const raw = productionState("empty", { items: [] });
        Object.defineProperty(raw, "items", { value: [], enumerable: false });
        return raw;
      },
      () => Object.assign(Object.create({ inherited: RAW_SENTINEL }), productionState("empty", { items: [] })),
      () => {
        const raw = productionState("empty", { items: [] });
        raw.items = new Array(1);
        return raw;
      },
      () => {
        const raw = productionState("empty", { items: [] });
        raw.loop = raw;
        return raw;
      },
    ];
    for (const factory of factories) {
      assertContractError(
        () => validateMemoryV3DialogueState(factory(), USER_ID, CONVERSATION_ID),
        "dialogue_contract_invalid_shape",
      );
    }
  });

  it("wraps revoked proxies and stateful traps without leaking raw messages", () => {
    const revoked = Proxy.revocable(productionState("empty", { items: [] }), {});
    revoked.revoke();
    const revokedError = assertContractError(
      () => validateMemoryV3DialogueState(revoked.proxy, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_shape",
    );
    assert.equal(revokedError.name, "MemoryV3DialogueContractError");

    let calls = 0;
    const stateful = new Proxy(productionState("empty", { items: [] }), {
      getOwnPropertyDescriptor(target, key) {
        calls += 1;
        if (calls > 1) throw new Error(RAW_SENTINEL);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    assertContractError(
      () => validateMemoryV3DialogueState(stateful, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_shape",
    );
  });

  it("does not trust spoofed error names or diagnostic getters", () => {
    let getterCalls = 0;
    const spoof = {
      name: "MemoryV3DialogueContractError",
      get diagnosticCode() { getterCalls += 1; return "dialogue_contract_invalid_state"; },
    };
    assert.equal(projectSafeMemoryV3DialogueContractDiagnostic(spoof), null);
    assert.equal(getterCalls, 0);
  });

  it("covers proposal envelope and operations-array hostile shapes", () => {
    const fixture = baseFixture();
    let getterCalls = 0;
    const accessorRoot = {};
    Object.defineProperty(accessorRoot, "operations", {
      enumerable: true,
      get() { getterCalls += 1; return fixture.raw.operations; },
    });
    const inheritedRoot = Object.assign(Object.create({ inherited: RAW_SENTINEL }), fixture.raw);
    const symbolRoot = { ...fixture.raw, [Symbol("secret")]: RAW_SENTINEL };
    const cyclicRoot: JsonRecord = { operations: null };
    cyclicRoot.operations = cyclicRoot;
    const revokedRoot = Proxy.revocable(fixture.raw, {});
    revokedRoot.revoke();
    for (const raw of [accessorRoot, inheritedRoot, symbolRoot, cyclicRoot, revokedRoot.proxy]) {
      assertContractError(
        () => validateMemoryV3DialogueProposal(raw, contextOf(fixture)),
        "dialogue_contract_invalid_proposal",
      );
    }
    assert.equal(getterCalls, 0);

    const hostileArrays: unknown[] = [];
    hostileArrays.push(new Array(1));
    const symbolArray = structuredClone(fixture.raw.operations);
    Object.defineProperty(symbolArray, Symbol("secret"), { value: RAW_SENTINEL, enumerable: true });
    hostileArrays.push(symbolArray);
    const hiddenIndex = structuredClone(fixture.raw.operations);
    Object.defineProperty(hiddenIndex, "0", { value: hiddenIndex[0], enumerable: false });
    hostileArrays.push(hiddenIndex);
    const revokedArray = Proxy.revocable(structuredClone(fixture.raw.operations), {});
    revokedArray.revoke();
    hostileArrays.push(revokedArray.proxy);
    for (const operations of hostileArrays) {
      assertContractError(
        () => validateMemoryV3DialogueProposal({ operations }, contextOf(fixture)),
        "dialogue_contract_invalid_proposal",
      );
    }
  });

  it("covers hostile proposal context, extraction, bindings, and nested rows", () => {
    const fixture = baseFixture();
    const hostileContexts: unknown[] = [
      Object.assign(Object.create({ inherited: RAW_SENTINEL }), contextOf(fixture)),
      { ...contextOf(fixture), [Symbol("secret")]: RAW_SENTINEL },
    ];
    const hidden = contextOf(fixture);
    Object.defineProperty(hidden, "bindings", { value: hidden.bindings, enumerable: false });
    hostileContexts.push(hidden);
    const revoked = Proxy.revocable(contextOf(fixture), {});
    revoked.revoke();
    hostileContexts.push(revoked.proxy);
    for (const context of hostileContexts) {
      assertContractError(
        () => validateMemoryV3DialogueProposal(fixture.raw, context as unknown as ProposalContext),
        "dialogue_contract_invalid_proposal",
      );
    }

    let getterCalls = 0;
    const extractionAccessor = structuredClone(fixture);
    Object.defineProperty(extractionAccessor.extraction.items[0], "claim", {
      enumerable: true,
      get() { getterCalls += 1; return RAW_SENTINEL; },
    });
    assertContractError(
      () => validateMemoryV3DialogueProposal(extractionAccessor.raw, contextOf(extractionAccessor)),
      "dialogue_contract_invalid_proposal",
    );
    const bindingAccessor = structuredClone(fixture);
    Object.defineProperty(bindingAccessor.bindings.candidates[0], "candidateRef", {
      enumerable: true,
      get() { getterCalls += 1; return "candidate:1"; },
    });
    assertContractError(
      () => validateMemoryV3DialogueProposal(bindingAccessor.raw, contextOf(bindingAccessor)),
      "dialogue_contract_invalid_proposal",
    );
    assert.equal(getterCalls, 0);

    const cyclicExtraction = structuredClone(fixture);
    cyclicExtraction.extraction.items = [cyclicExtraction.extraction];
    assertContractError(
      () => validateMemoryV3DialogueProposal(cyclicExtraction.raw, contextOf(cyclicExtraction)),
      "dialogue_contract_invalid_proposal",
    );
    const cyclicBindings = structuredClone(fixture);
    cyclicBindings.bindings.candidates = [cyclicBindings.bindings];
    assertContractError(
      () => validateMemoryV3DialogueProposal(cyclicBindings.raw, contextOf(cyclicBindings)),
      "dialogue_contract_invalid_proposal",
    );
  });

  it("covers trusted-forget array and state hostile shapes", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps[0].expectedState.items.length > 0);
    const state = productionState("state", scenario.steps[0].expectedState, 1);
    const key = state.items[0].memoryKey;
    let getterCalls = 0;
    const accessor: unknown[] = [key];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() { getterCalls += 1; return key; },
    });
    const symbolArray = [key];
    Object.defineProperty(symbolArray, Symbol("secret"), { value: RAW_SENTINEL, enumerable: true });
    const hidden = [key];
    Object.defineProperty(hidden, "0", { value: key, enumerable: false });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const revoked = Proxy.revocable([key], {});
    revoked.revoke();
    for (const keys of [accessor, new Array(1), symbolArray, hidden, cycle, revoked.proxy]) {
      assertContractError(
        () => validateMemoryV3DialogueTrustedForgetKeys(keys, state),
        "dialogue_contract_invalid_forget",
      );
    }
    assert.equal(getterCalls, 0);

    const inheritedState = Object.assign(Object.create({ inherited: RAW_SENTINEL }), state);
    assertContractError(
      () => validateMemoryV3DialogueTrustedForgetKeys([key], inheritedState),
      "dialogue_contract_invalid_shape",
    );
  });

  it("rejects allowed-path cycles without leaking attacker property names", () => {
    const state: JsonRecord = productionState("empty", { items: [] });
    state.items = [state];
    const stateError = assertContractError(
      () => validateMemoryV3DialogueState(state, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_shape",
      "SUPER_SECRET_PROPERTY_NAME",
    );
    assert.equal(stateError instanceof RangeError, false);

    const fixture = baseFixture();
    const operation: JsonRecord = {
      type: "create",
      candidateRef: "candidate:1",
      targetMemoryRef: null,
    };
    operation.candidateRef = operation;
    const proposalError = assertContractError(
      () => validateMemoryV3DialogueProposal({ operations: [operation] }, contextOf(fixture)),
      "dialogue_contract_invalid_proposal",
      "SUPER_SECRET_PROPERTY_NAME",
    );
    assert.equal(proposalError instanceof RangeError, false);
  });

  it("does not rethrow a genuine branded error stolen across boundaries", () => {
    const genuine = assertContractError(
      () => validateMemoryV3DialogueState(null, USER_ID, CONVERSATION_ID),
      "dialogue_contract_invalid_shape",
    );
    assert.equal(projectSafeMemoryV3DialogueContractDiagnostic(genuine), "dialogue_contract_invalid_shape");
    const fixture = baseFixture();
    const trap = new Proxy(fixture.raw, {
      ownKeys() { throw genuine; },
    });
    const wrapped = assertContractError(
      () => validateMemoryV3DialogueProposal(trap, contextOf(fixture)),
      "dialogue_contract_invalid_shape",
    );
    assert.notEqual(wrapped, genuine);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.equal(projectSafeMemoryV3DialogueContractDiagnostic(revoked.proxy), null);
  });
});
