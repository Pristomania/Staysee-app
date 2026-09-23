import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { MemoryV3Extraction } from "./contract.ts";
import {
  MEMORY_V3_LIFECYCLE_CONFIGURED_CEILING_NANODOLLARS_PER_RUN,
  MEMORY_V3_LIFECYCLE_HARD_GATE_NANODOLLARS_PER_RUN,
  MEMORY_V3_LIFECYCLE_MAX_CANDIDATES,
  MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE,
  MEMORY_V3_LIFECYCLE_MAX_DAILY_RESERVATIONS,
  MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN,
  MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL,
  MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES,
  MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE,
  MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS,
  MEMORY_V3_LIFECYCLE_MODEL,
  MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
  MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
  MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
  MEMORY_V3_LIFECYCLE_SCHEMA_VERSION,
  MEMORY_V3_LIFECYCLE_TOPICS,
  projectSafeMemoryV3LifecycleContractDiagnostic,
  validateMemoryV3LifecycleProposal,
  validateMemoryV3LifecycleState,
  validateMemoryV3TrustedForgetKeys,
} from "./lifecycleContract.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RAW_SENTINEL = "RAW_LIFECYCLE_SECRET_SENTINEL";

type JsonRecord = Record<string, unknown>;
type ProposalContext = Parameters<typeof validateMemoryV3LifecycleProposal>[1];

const dataset = JSON.parse(readFileSync(
  new URL("../../../../scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json", import.meta.url),
  "utf8",
)) as JsonRecord;

function memoryKey(index: number): string {
  return (index + 1).toString(16).padStart(64, "0");
}

function runtimeState(scenarioId: string, expectedState: JsonRecord, revision = 0): JsonRecord {
  return {
    schemaVersion: MEMORY_V3_LIFECYCLE_SCHEMA_VERSION,
    userId: USER_ID,
    stateRevision: revision,
    nextMemoryOrdinal: expectedState.items.length + 1,
    items: expectedState.items.map((entry: JsonRecord, index: number) => {
      const item = structuredClone(entry);
      delete item.goldMemoryId;
      delete item.tier;
      return {
        memoryKey: memoryKey(index),
        ...structuredClone(item),
        topic: null,
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

// Synthetic topic for a scripted operation: create/revise require a non-null
// enum member, every other operation type requires exactly null. The dataset
// predates topic classification, so tests synthesize a stable, valid value here.
function topicForOperationType(type: string): (typeof MEMORY_V3_LIFECYCLE_TOPICS)[number] | null {
  return type === "create" || type === "revise" ? MEMORY_V3_LIFECYCLE_TOPICS[0] : null;
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
  return {
    state: productionState("ignored", previousExpectedState),
    extraction: structuredClone(step.validatedExtraction) as MemoryV3Extraction,
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
        topic: topicForOperationType(operation.type as string),
      })),
    },
    expected: step.scriptedProposal.map((operation: JsonRecord) => ({
      type: operation.type,
      candidateLocalItemKey: operation.candidateLocalItemKey,
      targetMemoryKey: operation.targetGoldMemoryId === null
        ? null
        : memoryByGoldId.get(operation.targetGoldMemoryId)?.memoryKey,
      topic: topicForOperationType(operation.type as string),
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
  assert.ok(error instanceof Error, "expected lifecycle contract error");
  assert.match(error.message, /^\[memory-v3:lifecycle-contract\] /);
  assert.equal("cause" in error, false);
  assert.equal(JSON.stringify(error).includes(sentinel), false);
  assert.equal(projectSafeMemoryV3LifecycleContractDiagnostic(error), diagnosticCode);
  return error;
}

describe("Memory V3 lifecycle constants", () => {
  it("exports the locked production limits and identities", () => {
    assert.deepEqual({
      schema: MEMORY_V3_LIFECYCLE_SCHEMA_VERSION,
      pipeline: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
      reconciler: MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
      model: MEMORY_V3_LIFECYCLE_MODEL,
      sourceMessages: MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES,
      candidates: MEMORY_V3_LIFECYCLE_MAX_CANDIDATES,
      candidateEvidence: MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE,
      stateItems: MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS,
      stateEvidence: MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE,
      extractorBytes: MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES,
      reconcilerBytes: MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
      inputTokens: MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL,
      outputTokens: MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL,
      calls: MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN,
      reservations: MEMORY_V3_LIFECYCLE_MAX_DAILY_RESERVATIONS,
      ceiling: MEMORY_V3_LIFECYCLE_CONFIGURED_CEILING_NANODOLLARS_PER_RUN,
      hardGate: MEMORY_V3_LIFECYCLE_HARD_GATE_NANODOLLARS_PER_RUN,
    }, {
      schema: "memory-v3-lifecycle-state-v1",
      pipeline: "memory-v3-lifecycle-shadow-v1",
      reconciler: "memory-v3-lifecycle-reconciler-v1",
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

describe("frozen lifecycle parity", () => {
  const steps = dataset.scenarios.flatMap((scenario: JsonRecord) =>
    scenario.steps.map((step: JsonRecord, index: number) => ({ scenario, step, index })));

  it("contains exactly 80 authored synthetic steps", () => {
    assert.equal(steps.length, 80);
  });

  for (const { scenario, step, index } of steps) {
    it(`accepts ${step.stepId}`, () => {
      const previous = index === 0 ? { items: [] } : scenario.steps[index - 1].expectedState;
      const fixture = proposalFixture(step, previous);
      fixture.state.stateRevision = index;
      const before = structuredClone(fixture);
      const state = validateMemoryV3LifecycleState(fixture.state, USER_ID);
      const actual = validateMemoryV3LifecycleProposal(fixture.raw, {
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
    const actual = validateMemoryV3LifecycleState(raw, USER_ID);
    assert.deepEqual(actual, raw);
    assert.notEqual(actual, raw);
    assert.notEqual(actual.items, raw.items);
  });

  it("requires canonical matching user identity, schema, revision and ordinal", () => {
    const raw = productionState("empty", { items: [] });
    const mutations: Array<(value: JsonRecord) => void> = [
      (value) => { value.schemaVersion = "other"; },
      (value) => { value.userId = "NOT-A-UUID"; },
      (value) => { value.userId = "22222222-2222-4222-8222-222222222222"; },
      (value) => { value.stateRevision = -1; },
      (value) => { value.stateRevision = 0.5; },
      (value) => { value.nextMemoryOrdinal = 0; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(raw);
      mutate(value);
      assertContractError(
        () => validateMemoryV3LifecycleState(value, USER_ID),
        "lifecycle_contract_invalid_state",
      );
    }
  });

  it("does not coerce an attacker-controlled expected user identity", () => {
    const raw = productionState("empty", { items: [] });
    let coercionCalls = 0;
    const expected = {
      toString() { coercionCalls += 1; return USER_ID; },
    };
    assertContractError(
      () => validateMemoryV3LifecycleState(raw, expected as unknown as string),
      "lifecycle_contract_invalid_state",
    );
    assert.equal(coercionCalls, 0);
  });

  it("accepts unique existing forget keys and rejects unknown or duplicate keys", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps[0].expectedState.items.length > 0);
    const state = productionState("state", scenario.steps[0].expectedState, 1);
    const keys = state.items.map((item: JsonRecord) => item.memoryKey);
    assert.deepEqual(validateMemoryV3TrustedForgetKeys(keys, state), keys);
    assert.notEqual(validateMemoryV3TrustedForgetKeys(keys, state), keys);
    assertContractError(
      () => validateMemoryV3TrustedForgetKeys(["f".repeat(64)], state),
      "lifecycle_contract_invalid_forget",
    );
    assertContractError(
      () => validateMemoryV3TrustedForgetKeys([keys[0], keys[0]], state),
      "lifecycle_contract_invalid_forget",
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
      () => validateMemoryV3LifecycleState(tooManyItems, USER_ID),
      "lifecycle_contract_invalid_state",
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
      () => validateMemoryV3LifecycleState(tooMuchEvidence, USER_ID),
      "lifecycle_contract_invalid_state",
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
    const actual = validateMemoryV3LifecycleState(state, USER_ID);
    assert.deepEqual(actual.items.map((item) => item.memoryKey), [memoryKey(1), memoryKey(0)]);
    state.items[0].evidence[0].mentionTime = "2026-01-01T10:00:00+14:01";
    assertContractError(
      () => validateMemoryV3LifecycleState(state, USER_ID),
      "lifecycle_contract_invalid_state",
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
      () => validateMemoryV3LifecycleProposal({ operations: [], extra: true }, context),
      "lifecycle_contract_invalid_proposal",
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
        () => validateMemoryV3LifecycleProposal(raw, contextOf(fixture)),
        "lifecycle_contract_invalid_proposal",
      );
    }
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
    assert.doesNotThrow(() => validateMemoryV3LifecycleProposal({ operations: [
      { type: "confirm", candidateRef: "candidate:1", targetMemoryRef: target, topic: null },
      { type: "confirm", candidateRef: "candidate:2", targetMemoryRef: target, topic: null },
    ] }, contextOf(fixture)));
    assertContractError(() => validateMemoryV3LifecycleProposal({ operations: [
      { type: "confirm", candidateRef: "candidate:1", targetMemoryRef: target, topic: null },
      { type: "revise", candidateRef: "candidate:2", targetMemoryRef: target, topic: MEMORY_V3_LIFECYCLE_TOPICS[0] },
    ] }, contextOf(fixture)), "lifecycle_contract_invalid_proposal");
  });

  it("rejects closed targets and kind conversion", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) => entry.steps.length > 1 && entry.steps[1].scriptedProposal[0].targetGoldMemoryId);
    const fixture = proposalFixture(scenario.steps[1], scenario.steps[0].expectedState);
    fixture.state.items[0].status = "rejected";
    fixture.state.items[0].evidence[0].relation = "rejects";
    assertContractError(
      () => validateMemoryV3LifecycleProposal(fixture.raw, contextOf(fixture)),
      "lifecycle_contract_invalid_proposal",
    );

    const conversion = proposalFixture(scenario.steps[1], scenario.steps[0].expectedState);
    conversion.extraction.items[0].kind = conversion.state.items[0].kind === "event" ? "hypothesis" : "event";
    if (conversion.extraction.items[0].kind === "hypothesis") {
      conversion.extraction.items[0].alternative = "Another cautious interpretation";
    } else {
      conversion.extraction.items[0].alternative = null;
    }
    assertContractError(
      () => validateMemoryV3LifecycleProposal(conversion.raw, contextOf(conversion)),
      "lifecycle_contract_invalid_proposal",
    );
  });

  it("requires enough observations when creating recurrence memory", () => {
    const fixture = baseFixture();
    fixture.extraction.items[0].kind = "recurrence";
    fixture.extraction.items[0].status = "active";
    fixture.extraction.evidence[0].supportType = "episode_observation";
    assertContractError(
      () => validateMemoryV3LifecycleProposal(fixture.raw, contextOf(fixture)),
      "lifecycle_contract_invalid_proposal",
    );
    fixture.extraction.items[0].status = "candidate";
    assert.doesNotThrow(() => validateMemoryV3LifecycleProposal(fixture.raw, contextOf(fixture)));
  });

  it("requires contradiction for mark_stale and rejection evidence for reject", () => {
    const scenario = dataset.scenarios.find((entry: JsonRecord) =>
      entry.steps[0].expectedState.items.some((item: JsonRecord) => item.kind === "recurrence"));
    const prior = scenario.steps[0].expectedState;
    const step = structuredClone(scenario.steps[1]);
    const fixture = proposalFixture(step, prior);
    const operation = fixture.raw.operations[0];
    operation.type = "mark_stale";
    operation.topic = null;
    fixture.extraction.items[0].status = "active";
    assertContractError(
      () => validateMemoryV3LifecycleProposal(fixture.raw, contextOf(fixture)),
      "lifecycle_contract_invalid_proposal",
    );
    operation.type = "reject";
    assertContractError(
      () => validateMemoryV3LifecycleProposal(fixture.raw, contextOf(fixture)),
      "lifecycle_contract_invalid_proposal",
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
      type: "ignore", candidateRef: entry.candidateRef, targetMemoryRef: null, topic: null,
    }));
    assertContractError(
      () => validateMemoryV3LifecycleProposal(fixture.raw, contextOf(fixture)),
      "lifecycle_contract_invalid_proposal",
    );

    const evidenceFixture = baseFixture();
    evidenceFixture.extraction.evidence = Array.from({ length: 501 }, (_, index) => ({
      ...structuredClone(evidenceFixture.extraction.evidence[0]), sourceMessageId: `m${index}`,
    }));
    assertContractError(
      () => validateMemoryV3LifecycleProposal(evidenceFixture.raw, contextOf(evidenceFixture)),
      "lifecycle_contract_invalid_proposal",
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
      () => validateMemoryV3LifecycleState(raw, USER_ID),
      "lifecycle_contract_invalid_shape",
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
      () => validateMemoryV3LifecycleProposal(fixture.raw, contextOf(fixture)),
      "lifecycle_contract_invalid_proposal",
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
        () => validateMemoryV3LifecycleState(factory(), USER_ID),
        "lifecycle_contract_invalid_shape",
      );
    }
  });

  it("wraps revoked proxies and stateful traps without leaking raw messages", () => {
    const revoked = Proxy.revocable(productionState("empty", { items: [] }), {});
    revoked.revoke();
    const revokedError = assertContractError(
      () => validateMemoryV3LifecycleState(revoked.proxy, USER_ID),
      "lifecycle_contract_invalid_shape",
    );
    assert.equal(revokedError.name, "MemoryV3LifecycleContractError");

    let calls = 0;
    const stateful = new Proxy(productionState("empty", { items: [] }), {
      getOwnPropertyDescriptor(target, key) {
        calls += 1;
        if (calls > 1) throw new Error(RAW_SENTINEL);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    assertContractError(
      () => validateMemoryV3LifecycleState(stateful, USER_ID),
      "lifecycle_contract_invalid_shape",
    );
  });

  it("does not trust spoofed error names or diagnostic getters", () => {
    let getterCalls = 0;
    const spoof = {
      name: "MemoryV3LifecycleContractError",
      get diagnosticCode() { getterCalls += 1; return "lifecycle_contract_invalid_state"; },
    };
    assert.equal(projectSafeMemoryV3LifecycleContractDiagnostic(spoof), null);
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
        () => validateMemoryV3LifecycleProposal(raw, contextOf(fixture)),
        "lifecycle_contract_invalid_proposal",
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
        () => validateMemoryV3LifecycleProposal({ operations }, contextOf(fixture)),
        "lifecycle_contract_invalid_proposal",
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
        () => validateMemoryV3LifecycleProposal(fixture.raw, context as unknown as ProposalContext),
        "lifecycle_contract_invalid_proposal",
      );
    }

    let getterCalls = 0;
    const extractionAccessor = structuredClone(fixture);
    Object.defineProperty(extractionAccessor.extraction.items[0], "claim", {
      enumerable: true,
      get() { getterCalls += 1; return RAW_SENTINEL; },
    });
    assertContractError(
      () => validateMemoryV3LifecycleProposal(extractionAccessor.raw, contextOf(extractionAccessor)),
      "lifecycle_contract_invalid_proposal",
    );
    const bindingAccessor = structuredClone(fixture);
    Object.defineProperty(bindingAccessor.bindings.candidates[0], "candidateRef", {
      enumerable: true,
      get() { getterCalls += 1; return "candidate:1"; },
    });
    assertContractError(
      () => validateMemoryV3LifecycleProposal(bindingAccessor.raw, contextOf(bindingAccessor)),
      "lifecycle_contract_invalid_proposal",
    );
    assert.equal(getterCalls, 0);

    const cyclicExtraction = structuredClone(fixture);
    cyclicExtraction.extraction.items = [cyclicExtraction.extraction];
    assertContractError(
      () => validateMemoryV3LifecycleProposal(cyclicExtraction.raw, contextOf(cyclicExtraction)),
      "lifecycle_contract_invalid_proposal",
    );
    const cyclicBindings = structuredClone(fixture);
    cyclicBindings.bindings.candidates = [cyclicBindings.bindings];
    assertContractError(
      () => validateMemoryV3LifecycleProposal(cyclicBindings.raw, contextOf(cyclicBindings)),
      "lifecycle_contract_invalid_proposal",
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
        () => validateMemoryV3TrustedForgetKeys(keys, state),
        "lifecycle_contract_invalid_forget",
      );
    }
    assert.equal(getterCalls, 0);

    const inheritedState = Object.assign(Object.create({ inherited: RAW_SENTINEL }), state);
    assertContractError(
      () => validateMemoryV3TrustedForgetKeys([key], inheritedState),
      "lifecycle_contract_invalid_shape",
    );
  });

  it("rejects allowed-path cycles without leaking attacker property names", () => {
    const state: JsonRecord = productionState("empty", { items: [] });
    state.items = [state];
    const stateError = assertContractError(
      () => validateMemoryV3LifecycleState(state, USER_ID),
      "lifecycle_contract_invalid_shape",
      "SUPER_SECRET_PROPERTY_NAME",
    );
    assert.equal(stateError instanceof RangeError, false);

    const fixture = baseFixture();
    const operation: JsonRecord = {
      type: "create",
      candidateRef: "candidate:1",
      targetMemoryRef: null,
      topic: MEMORY_V3_LIFECYCLE_TOPICS[0],
    };
    operation.candidateRef = operation;
    const proposalError = assertContractError(
      () => validateMemoryV3LifecycleProposal({ operations: [operation] }, contextOf(fixture)),
      "lifecycle_contract_invalid_proposal",
      "SUPER_SECRET_PROPERTY_NAME",
    );
    assert.equal(proposalError instanceof RangeError, false);
  });

  it("does not rethrow a genuine branded error stolen across boundaries", () => {
    const genuine = assertContractError(
      () => validateMemoryV3LifecycleState(null, USER_ID),
      "lifecycle_contract_invalid_shape",
    );
    assert.equal(projectSafeMemoryV3LifecycleContractDiagnostic(genuine), "lifecycle_contract_invalid_shape");
    const fixture = baseFixture();
    const trap = new Proxy(fixture.raw, {
      ownKeys() { throw genuine; },
    });
    const wrapped = assertContractError(
      () => validateMemoryV3LifecycleProposal(trap, contextOf(fixture)),
      "lifecycle_contract_invalid_shape",
    );
    assert.notEqual(wrapped, genuine);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.equal(projectSafeMemoryV3LifecycleContractDiagnostic(revoked.proxy), null);
  });
});

function baseState(userId: string) {
  return {
    schemaVersion: "memory-v3-lifecycle-state-v1",
    userId,
    stateRevision: 0,
    nextMemoryOrdinal: 1,
    items: [],
  };
}

function baseExtraction(localItemKey: string) {
  return {
    run: { caseId: "case-1", extractorVersion: "v1" },
    items: [{
      localItemKey, kind: "event", claim: "переезд в Казань", scope: "cross_conversation",
      conversationId: null, eventTimeStart: null, eventTimeEnd: null, status: "active",
      sensitivity: "normal", alternative: null,
    }],
    evidence: [{
      itemKey: localItemKey, sourceMessageId: "m1", relation: "supports", supportType: null,
      episodeKey: "episode:m1", provenanceRole: "user", mentionTime: "2026-09-24T10:00:00.000Z",
    }],
  };
}

function candidateBindings(localItemKey: string) {
  return {
    memories: [],
    candidates: [{ candidateRef: "candidate:0001", localItemKey }],
  };
}

describe("Memory V3 lifecycle contract topic", () => {
  it("requires a valid topic on a create operation", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: candidateBindings("item-1") };
    for (const topic of MEMORY_V3_LIFECYCLE_TOPICS) {
      const result = validateMemoryV3LifecycleProposal(
        { operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null, topic }] },
        context,
      );
      assert.equal(result[0].topic, topic);
    }
  });

  it("rejects a create operation with a null topic", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: candidateBindings("item-1") };
    assert.throws(() => validateMemoryV3LifecycleProposal(
      { operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null, topic: null }] },
      context,
    ));
  });

  it("rejects a create operation with a topic from the wrong scope's enum", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: candidateBindings("item-1") };
    assert.throws(() => validateMemoryV3LifecycleProposal(
      { operations: [{ type: "create", candidateRef: "candidate:0001", targetMemoryRef: null, topic: "person" }] },
      context,
    ));
  });

  it("rejects an ignore operation that supplies a non-null topic", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const extraction = baseExtraction("item-1");
    const context = { state: baseState(userId), extraction, bindings: candidateBindings("item-1") };
    assert.throws(() => validateMemoryV3LifecycleProposal(
      { operations: [{ type: "ignore", candidateRef: "candidate:0001", targetMemoryRef: null, topic: "life_context" }] },
      context,
    ));
  });
});
