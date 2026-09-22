import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { MemoryV3Extraction } from "./contract.ts";
import type {
  MemoryV3LifecycleProposal,
  MemoryV3LifecycleState,
} from "./lifecycleContract.ts";
import {
  applyMemoryV3LifecycleStep,
  createEmptyMemoryV3LifecycleState,
  projectSafeMemoryV3LifecycleReducerDiagnostic,
} from "./lifecycleReducer.ts";

// Frozen reference behavior; production code never imports these modules.
import {
  applyLifecycleStep,
  createEmptyLifecycleState,
} from "../../../../scripts/memory-v3-pilot/lifecycle-reducer.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RAW_SENTINEL = "RAW_REDUCER_SECRET_SENTINEL";
const MATERIAL_FIELDS = [
  "kind", "claim", "status", "sensitivity", "eventTimeStart", "eventTimeEnd", "alternative",
] as const;

type JsonRecord = Record<string, unknown>;
type EmptyStateInput = Parameters<typeof createEmptyMemoryV3LifecycleState>[0];
type LifecycleStepInput = Parameters<typeof applyMemoryV3LifecycleStep>[0];

const dataset = JSON.parse(readFileSync(
  new URL("../../../../scripts/memory-v3-pilot/memory-v3-synthetic-lifecycle.v1.json", import.meta.url),
  "utf8",
)) as JsonRecord;

function internalProposal(step: JsonRecord, memoryByGold: Map<string, string>): MemoryV3LifecycleProposal {
  return step.scriptedProposal.map((row: JsonRecord) => ({
    type: row.type,
    candidateLocalItemKey: row.candidateLocalItemKey,
    targetMemoryKey: row.targetGoldMemoryId === null ? null : memoryByGold.get(row.targetGoldMemoryId),
  }));
}

function material(value: JsonRecord): JsonRecord {
  return Object.fromEntries(MATERIAL_FIELDS.map((field) => [field, value[field]]));
}

function sameMaterial(left: JsonRecord, right: JsonRecord): boolean {
  return JSON.stringify(material(left)) === JSON.stringify(material(right));
}

function addCreatedMappings(
  step: JsonRecord,
  previousGoldIds: Set<string>,
  transitions: JsonRecord[],
  memoryByGold: Map<string, string>,
): void {
  const newExpected = step.expectedState.items.filter((item: JsonRecord) => !previousGoldIds.has(item.goldMemoryId));
  for (const operation of step.scriptedProposal.filter((row: JsonRecord) => row.type === "create")) {
    const candidate = step.validatedExtraction.items.find(
      (item: JsonRecord) => item.localItemKey === operation.candidateLocalItemKey,
    );
    const expected = newExpected.find((item: JsonRecord) =>
      !memoryByGold.has(item.goldMemoryId) && sameMaterial(item, candidate));
    const transition = transitions.find((row) =>
      row.type === "create" && row.candidateLocalItemKey === operation.candidateLocalItemKey);
    assert.ok(expected, `missing expected create mapping for ${step.stepId}`);
    assert.equal(typeof transition?.resultingMemoryKey, "string");
    memoryByGold.set(expected.goldMemoryId, transition.resultingMemoryKey);
  }
}

function expectedProductionState(
  expectedState: JsonRecord,
  memoryByGold: Map<string, string>,
  nextMemoryOrdinal: number,
): MemoryV3LifecycleState {
  const items = expectedState.items.map((entry: JsonRecord) => {
    const { goldMemoryId, ...itemWithTier } = entry;
    const item = structuredClone(itemWithTier);
    delete item.tier;
    return {
      memoryKey: memoryByGold.get(goldMemoryId),
      ...structuredClone(item),
    };
  }).sort((left: JsonRecord, right: JsonRecord) => left.memoryKey < right.memoryKey ? -1 : left.memoryKey > right.memoryKey ? 1 : 0);
  return {
    schemaVersion: "memory-v3-lifecycle-state-v1",
    userId: USER_ID,
    stateRevision: 0,
    nextMemoryOrdinal,
    items,
  } as MemoryV3LifecycleState;
}

function normalizedTransitions(
  transitions: JsonRecord[],
  before: Map<string, string>,
  after: Map<string, string>,
): JsonRecord[] {
  const reverse = new Map<string, string>();
  for (const [gold, key] of [...before, ...after]) reverse.set(key, gold);
  return transitions.map((row) => ({
    type: row.type,
    candidateLocalItemKey: row.candidateLocalItemKey,
    targetGoldMemoryId: row.targetMemoryKey === null ? null : reverse.get(row.targetMemoryKey),
    resultingGoldMemoryId: row.resultingMemoryKey === null ? null : reverse.get(row.resultingMemoryKey),
  }));
}

function assertReducerError(fn: () => unknown | Promise<unknown>, diagnosticCode: string): Promise<Error> | Error {
  const verify = (error: unknown): Error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^\[memory-v3:lifecycle-reducer\] /);
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes(RAW_SENTINEL), false);
    assert.equal(projectSafeMemoryV3LifecycleReducerDiagnostic(error), diagnosticCode);
    return error;
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.then(
      () => { throw new assert.AssertionError({ message: "expected reducer rejection" }); },
      verify,
    );
  } catch (error) {
    return verify(error);
  }
  throw new assert.AssertionError({ message: "expected reducer error" });
}

function eventExtraction(overrides: JsonRecord = {}): MemoryV3Extraction {
  const item = {
    localItemKey: "candidate-01",
    kind: "event",
    claim: "Moved to Kazan",
    scope: "cross_conversation",
    conversationId: null,
    eventTimeStart: "2026-01-01",
    eventTimeEnd: "2026-01-31",
    status: "active",
    sensitivity: "normal",
    alternative: null,
    ...overrides.item,
  };
  return {
    run: { caseId: "case-01", extractorVersion: "fixture-v1" },
    items: [item],
    evidence: [{
      itemKey: item.localItemKey,
      sourceMessageId: "m1",
      relation: "supports",
      supportType: null,
      episodeKey: "episode:m1",
      provenanceRole: "user",
      mentionTime: "2026-01-10T10:00:00Z",
      ...overrides.evidence,
    }],
  } as MemoryV3Extraction;
}

function recurrenceExtraction(overrides: JsonRecord = {}): MemoryV3Extraction {
  const item = {
    localItemKey: "candidate-recurrence",
    kind: "recurrence",
    claim: "Often checks plans twice",
    scope: "cross_conversation",
    conversationId: null,
    eventTimeStart: null,
    eventTimeEnd: null,
    status: "active",
    sensitivity: "normal",
    alternative: null,
    ...overrides.item,
  };
  const evidence = overrides.evidence ?? [
    { sourceMessageId: "m1", episodeKey: "episode:m1" },
    { sourceMessageId: "m2", episodeKey: "episode:m2" },
  ];
  return {
    run: { caseId: "case-recurrence", extractorVersion: "fixture-v1" },
    items: [item],
    evidence: evidence.map((row: JsonRecord) => ({
      itemKey: item.localItemKey,
      sourceMessageId: row.sourceMessageId,
      relation: row.relation ?? "supports",
      supportType: row.supportType === undefined ? "episode_observation" : row.supportType,
      episodeKey: row.episodeKey,
      provenanceRole: "user",
      mentionTime: row.mentionTime ?? "2026-01-10T10:00:00Z",
    })),
  } as MemoryV3Extraction;
}

function hypothesisExtraction(overrides: JsonRecord = {}): MemoryV3Extraction {
  const item = {
    localItemKey: "candidate-hypothesis",
    kind: "hypothesis",
    claim: "May avoid uncertainty",
    scope: "cross_conversation",
    conversationId: null,
    eventTimeStart: null,
    eventTimeEnd: null,
    status: "supported",
    sensitivity: "normal",
    alternative: "May simply prefer planning",
    ...overrides.item,
  };
  return {
    run: { caseId: "case-hypothesis", extractorVersion: "fixture-v1" },
    items: [item],
    evidence: [{
      itemKey: item.localItemKey,
      sourceMessageId: "m1",
      relation: overrides.relation ?? "supports",
      supportType: null,
      episodeKey: "episode:m1",
      provenanceRole: "user",
      mentionTime: "2026-01-10T10:00:00Z",
    }],
  } as MemoryV3Extraction;
}

async function applyCreate(overrides: JsonRecord = {}) {
  return applyMemoryV3LifecycleStep({
    state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
    at: "2026-01-10T10:00:00Z",
    conversationId: "conversation-01",
    extraction: eventExtraction(),
    proposal: [{ type: "create", candidateLocalItemKey: "candidate-01", targetMemoryKey: null }],
    trustedForgetMemoryKeys: [],
    ...overrides,
  });
}

describe("production lifecycle parity", () => {
  it("replays all 20 scenarios and 80 steps beside the frozen reducer", async () => {
    let stepCount = 0;
    for (const scenario of dataset.scenarios) {
      let productionState = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
      let referenceState = createEmptyLifecycleState({ scenarioId: scenario.scenarioId });
      const productionByGold = new Map<string, string>();
      const referenceByGold = new Map<string, string>();
      for (const step of scenario.steps) {
        stepCount += 1;
        const productionBefore = new Map(productionByGold);
        const referenceBefore = new Map(referenceByGold);
        const previousGoldIds = new Set(productionByGold.keys());
        const productionProposal = internalProposal(step, productionByGold);
        const referenceProposal = internalProposal(step, referenceByGold);
        const productionForget = step.forgetMemoryRefs.map((gold: string) => productionByGold.get(gold));
        const referenceForget = step.forgetMemoryRefs.map((gold: string) => referenceByGold.get(gold));
        const productionResult = await applyMemoryV3LifecycleStep({
          state: productionState,
          at: step.at,
          conversationId: step.conversationId,
          extraction: structuredClone(step.validatedExtraction),
          proposal: productionProposal,
          trustedForgetMemoryKeys: productionForget,
        });
        const referenceResult = applyLifecycleStep({
          state: referenceState,
          session: {
            scenarioId: scenario.scenarioId,
            stepId: step.stepId,
            at: step.at,
            conversationId: step.conversationId,
          },
          extraction: structuredClone(step.validatedExtraction),
          proposal: referenceProposal,
          forgetMemoryKeys: referenceForget,
        });
        addCreatedMappings(step, previousGoldIds, productionResult.transitions, productionByGold);
        addCreatedMappings(step, previousGoldIds, referenceResult.transitions, referenceByGold);
        for (const forgotten of step.forgetMemoryRefs) {
          productionByGold.delete(forgotten);
          referenceByGold.delete(forgotten);
        }
        assert.deepEqual(
          productionResult.state,
          expectedProductionState(step.expectedState, productionByGold, referenceResult.state.nextMemoryOrdinal),
          step.stepId,
        );
        assert.equal(productionResult.state.nextMemoryOrdinal, referenceResult.state.nextMemoryOrdinal, step.stepId);
        assert.deepEqual(
          normalizedTransitions(productionResult.transitions, productionBefore, productionByGold),
          normalizedTransitions(referenceResult.transitions, referenceBefore, referenceByGold),
          step.stepId,
        );
        const referenceChanged = JSON.stringify(referenceState) !== JSON.stringify(referenceResult.state);
        assert.equal(productionResult.changed, referenceChanged, step.stepId);
        assert.equal(productionResult.state.stateRevision, productionState.stateRevision, step.stepId);
        productionState = productionResult.state;
        referenceState = referenceResult.state;
      }
    }
    assert.equal(stepCount, 80);
  });
});

describe("production lifecycle reducer behavior", () => {
  it("creates a deeply frozen empty state", () => {
    const state = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
    assert.deepEqual(state, {
      schemaVersion: "memory-v3-lifecycle-state-v1",
      userId: USER_ID,
      stateRevision: 0,
      nextMemoryOrdinal: 1,
      items: [],
    });
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.items), true);
  });

  it("creates deterministic lowercase SHA-256 identity from the exact namespace payload", async () => {
    const result = await applyCreate();
    const payload = JSON.stringify({
      namespace: "memory-v3-production-lifecycle-v1",
      userId: USER_ID,
      ordinal: 1,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    assert.equal(result.state.items[0].memoryKey, expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
    assert.equal(result.changed, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.state.items[0].evidence), true);
  });

  it("is independent of proposal order and uses code-unit ordering", async () => {
    const first = eventExtraction();
    const secondItem = { ...first.items[0], localItemKey: "Z-candidate", claim: "Second event" };
    const secondEvidence = { ...first.evidence[0], itemKey: "Z-candidate", sourceMessageId: "Z-message" };
    const extraction = {
      ...first,
      items: [secondItem, { ...first.items[0], localItemKey: "a-candidate" }],
      evidence: [secondEvidence, { ...first.evidence[0], itemKey: "a-candidate", sourceMessageId: "a-message" }],
    } as MemoryV3Extraction;
    const proposal: MemoryV3LifecycleProposal = [
      { type: "create", candidateLocalItemKey: "a-candidate", targetMemoryKey: null },
      { type: "create", candidateLocalItemKey: "Z-candidate", targetMemoryKey: null },
    ];
    const input = {
      state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction,
      proposal,
      trustedForgetMemoryKeys: [],
    };
    const left = await applyMemoryV3LifecycleStep(input);
    const right = await applyMemoryV3LifecycleStep({ ...input, proposal: [...proposal].reverse() });
    assert.deepEqual(left, right);
    assert.deepEqual(left.transitions.map((row) => row.candidateLocalItemKey), ["Z-candidate", "a-candidate"]);
  });

  it("does not reuse an ordinal after forgetting", async () => {
    const first = await applyCreate();
    const forgotten = await applyMemoryV3LifecycleStep({
      state: first.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: "conversation-02",
      extraction: { run: { caseId: "empty", extractorVersion: "fixture-v1" }, items: [], evidence: [] },
      proposal: [],
      trustedForgetMemoryKeys: [first.state.items[0].memoryKey],
    });
    const second = await applyCreate({ state: forgotten.state, at: "2026-01-12T10:00:00Z" });
    assert.equal(second.state.nextMemoryOrdinal, 3);
    assert.notEqual(second.state.items[0].memoryKey, first.state.items[0].memoryKey);
  });

  it("merges evidence by code-unit identity without revising on confirm", async () => {
    const created = await applyCreate();
    const extraction = eventExtraction({
      evidence: { sourceMessageId: "Z-message", episodeKey: "episode:Z" },
    });
    const confirmed = await applyMemoryV3LifecycleStep({
      state: created.state,
      at: "2026-02-10T10:00:00Z",
      conversationId: "conversation-02",
      extraction,
      proposal: [{
        type: "confirm",
        candidateLocalItemKey: "candidate-01",
        targetMemoryKey: created.state.items[0].memoryKey,
      }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(confirmed.state.items[0].revision, 1);
    assert.equal(confirmed.state.items[0].updatedAt, created.state.items[0].updatedAt);
    assert.deepEqual(
      confirmed.state.items[0].evidence.map((row) => `${row.conversationId}\0${row.sourceMessageId}\0${row.relation}`),
      [...confirmed.state.items[0].evidence]
        .map((row) => `${row.conversationId}\0${row.sourceMessageId}\0${row.relation}`)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    );
  });

  it("returns changed false for ignore and byte-identical repeated evidence", async () => {
    const empty = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
    const ignored = await applyCreate({
      state: empty,
      proposal: [{ type: "ignore", candidateLocalItemKey: "candidate-01", targetMemoryKey: null }],
    });
    assert.equal(ignored.changed, false);
    assert.deepEqual(ignored.state, empty);

    const created = await applyCreate();
    const confirmed = await applyMemoryV3LifecycleStep({
      state: created.state,
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction: eventExtraction(),
      proposal: [{ type: "confirm", candidateLocalItemKey: "candidate-01", targetMemoryKey: created.state.items[0].memoryKey }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(confirmed.changed, false);
    assert.deepEqual(confirmed.state, created.state);
  });

  it("does not revise timestamps or revision when material and evidence are unchanged", async () => {
    const created = await applyCreate();
    const revised = await applyMemoryV3LifecycleStep({
      state: created.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: "conversation-01",
      extraction: eventExtraction(),
      proposal: [{
        type: "revise",
        candidateLocalItemKey: "candidate-01",
        targetMemoryKey: created.state.items[0].memoryKey,
      }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(revised.changed, false);
    assert.deepEqual(revised.state, created.state);
    assert.equal(revised.state.items[0].revision, 1);
    assert.equal(revised.state.items[0].updatedAt, "2026-01-10T10:00:00Z");
  });

  it("does not treat valid item ordering differences as material state changes", async () => {
    const first = eventExtraction();
    const extraction = {
      ...first,
      items: [
        { ...first.items[0], localItemKey: "candidate-a", claim: "First event" },
        { ...first.items[0], localItemKey: "candidate-b", claim: "Second event" },
      ],
      evidence: [
        { ...first.evidence[0], itemKey: "candidate-a", sourceMessageId: "m-a" },
        { ...first.evidence[0], itemKey: "candidate-b", sourceMessageId: "m-b" },
      ],
    } as MemoryV3Extraction;
    const created = await applyMemoryV3LifecycleStep({
      state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction,
      proposal: extraction.items.map((item) => ({
        type: "create" as const,
        candidateLocalItemKey: item.localItemKey,
        targetMemoryKey: null,
      })),
      trustedForgetMemoryKeys: [],
    });
    const reordered = structuredClone(created.state);
    reordered.items.reverse();
    const ignored = await applyMemoryV3LifecycleStep({
      state: reordered,
      at: "2026-01-11T10:00:00Z",
      conversationId: "conversation-02",
      extraction: eventExtraction(),
      proposal: [{ type: "ignore", candidateLocalItemKey: "candidate-01", targetMemoryKey: null }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(ignored.changed, false);
    assert.deepEqual(ignored.state, created.state);
  });

  it("applies revise, mark_stale, and reject with one material revision", async () => {
    const event = await applyCreate();
    const revised = await applyMemoryV3LifecycleStep({
      state: event.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: "conversation-02",
      extraction: eventExtraction({
        item: { claim: "Moved permanently to Kazan" },
        evidence: { sourceMessageId: "m2", episodeKey: "episode:m2", mentionTime: "2026-01-11T10:00:00Z" },
      }),
      proposal: [{ type: "revise", candidateLocalItemKey: "candidate-01", targetMemoryKey: event.state.items[0].memoryKey }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(revised.state.items[0].claim, "Moved permanently to Kazan");
    assert.equal(revised.state.items[0].revision, 2);
    assert.equal(revised.state.items[0].updatedAt, "2026-01-11T10:00:00Z");

    const recurrenceInput = recurrenceExtraction();
    const recurrence = await applyMemoryV3LifecycleStep({
      state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction: recurrenceInput,
      proposal: [{ type: "create", candidateLocalItemKey: "candidate-recurrence", targetMemoryKey: null }],
      trustedForgetMemoryKeys: [],
    });
    const stale = await applyMemoryV3LifecycleStep({
      state: recurrence.state,
      at: "2026-01-12T10:00:00Z",
      conversationId: "conversation-02",
      extraction: recurrenceExtraction({
        item: { status: "stale", claim: "This pattern no longer holds" },
        evidence: [{
          sourceMessageId: "m3",
          relation: "contradicts",
          supportType: null,
          episodeKey: "episode:m3",
          mentionTime: "2026-01-12T10:00:00Z",
        }],
      }),
      proposal: [{ type: "mark_stale", candidateLocalItemKey: "candidate-recurrence", targetMemoryKey: recurrence.state.items[0].memoryKey }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(stale.state.items[0].status, "stale");
    assert.equal(stale.state.items[0].claim, recurrence.state.items[0].claim);
    assert.equal(stale.state.items[0].revision, 2);

    const hypothesisInput = hypothesisExtraction();
    const hypothesis = await applyMemoryV3LifecycleStep({
      state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction: hypothesisInput,
      proposal: [{ type: "create", candidateLocalItemKey: "candidate-hypothesis", targetMemoryKey: null }],
      trustedForgetMemoryKeys: [],
    });
    const rejected = await applyMemoryV3LifecycleStep({
      state: hypothesis.state,
      at: "2026-01-12T10:00:00Z",
      conversationId: "conversation-02",
      extraction: hypothesisExtraction({ item: { status: "rejected" }, relation: "rejects" }),
      proposal: [{ type: "reject", candidateLocalItemKey: "candidate-hypothesis", targetMemoryKey: hypothesis.state.items[0].memoryKey }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(rejected.state.items[0].status, "rejected");
    assert.equal(rejected.state.items[0].claim, hypothesis.state.items[0].claim);
    assert.equal(rejected.state.items[0].revision, 2);
  });

  it("rolls back after an earlier operation changed the private working copy", async () => {
    const first = eventExtraction();
    const extraction = {
      ...first,
      items: [
        { ...first.items[0], localItemKey: "candidate-a", claim: "First event" },
        { ...first.items[0], localItemKey: "candidate-b", claim: "Second event" },
      ],
      evidence: [
        { ...first.evidence[0], itemKey: "candidate-a", sourceMessageId: "m-a" },
        { ...first.evidence[0], itemKey: "candidate-b", sourceMessageId: "m-b" },
      ],
    } as MemoryV3Extraction;
    const created = await applyMemoryV3LifecycleStep({
      state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction,
      proposal: extraction.items.map((item) => ({ type: "create" as const, candidateLocalItemKey: item.localItemKey, targetMemoryKey: null })),
      trustedForgetMemoryKeys: [],
    });
    const before = structuredClone(created.state);
    const state = structuredClone(created.state);
    state.items.sort((left, right) => left.memoryKey < right.memoryKey ? -1 : left.memoryKey > right.memoryKey ? 1 : 0);
    state.items[0].updatedAt = "2026-01-10T10:00:00Z";
    state.items[1].updatedAt = "2026-01-12T10:00:00Z";
    const confirmExtraction = {
      ...extraction,
      evidence: extraction.evidence.map((row) => ({
        ...row,
        sourceMessageId: `${row.sourceMessageId}-new`,
        mentionTime: "2026-01-11T10:00:00Z",
      })),
    } as MemoryV3Extraction;
    await assertReducerError(() => applyMemoryV3LifecycleStep({
      state,
      at: "2026-01-11T10:00:00Z",
      conversationId: "conversation-02",
      extraction: confirmExtraction,
      proposal: state.items.map((item, index) => ({
        type: "confirm" as const,
        candidateLocalItemKey: confirmExtraction.items[index].localItemKey,
        targetMemoryKey: item.memoryKey,
      })),
      trustedForgetMemoryKeys: [],
    }), "lifecycle_reducer_transition_invalid");
    assert.deepEqual(created.state, before);
    assert.equal(state.items.every((item) => item.evidence.length === 1), true);
  });

  it("rejects timestamp regression and key collision atomically", async () => {
    const created = await applyCreate();
    const before = structuredClone(created.state);
    await assertReducerError(() => applyMemoryV3LifecycleStep({
      state: created.state,
      at: "2025-01-01T00:00:00Z",
      conversationId: "conversation-02",
      extraction: eventExtraction(),
      proposal: [{ type: "confirm", candidateLocalItemKey: "candidate-01", targetMemoryKey: created.state.items[0].memoryKey }],
      trustedForgetMemoryKeys: [],
    }), "lifecycle_reducer_transition_invalid");
    assert.deepEqual(created.state, before);

    const colliding = structuredClone(created.state);
    colliding.nextMemoryOrdinal = 1;
    await assertReducerError(() => applyCreate({ state: colliding }), "lifecycle_reducer_transition_invalid");
    assert.deepEqual(created.state, before);
  });
});

describe("production lifecycle reducer public boundary", () => {
  it("rejects unknown, accessor, symbol, cyclic, revoked and spoofed input safely", async () => {
    let getterCalls = 0;
    const accessor: JsonRecord = {};
    Object.defineProperty(accessor, "userId", {
      enumerable: true,
      get() { getterCalls += 1; return RAW_SENTINEL; },
    });
    await assertReducerError(
      () => Promise.resolve(createEmptyMemoryV3LifecycleState(accessor as unknown as EmptyStateInput)),
      "lifecycle_reducer_invalid_input",
    );
    assert.equal(getterCalls, 0);

    const state = createEmptyMemoryV3LifecycleState({ userId: USER_ID });
    const cyclic: JsonRecord = {
      state,
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction: eventExtraction(),
      proposal: [],
      trustedForgetMemoryKeys: [],
    };
    cyclic.extraction = cyclic;
    await assertReducerError(() => applyMemoryV3LifecycleStep(cyclic as unknown as LifecycleStepInput), "lifecycle_reducer_invalid_input");
    const revoked = Proxy.revocable(cyclic, {});
    revoked.revoke();
    await assertReducerError(() => applyMemoryV3LifecycleStep(revoked.proxy as unknown as LifecycleStepInput), "lifecycle_reducer_invalid_input");
    await assertReducerError(() => applyMemoryV3LifecycleStep({ ...cyclic, [Symbol("secret")]: RAW_SENTINEL } as unknown as LifecycleStepInput), "lifecycle_reducer_invalid_input");
    assert.equal(projectSafeMemoryV3LifecycleReducerDiagnostic({
      name: "MemoryV3LifecycleReducerError",
      diagnosticCode: "lifecycle_reducer_transition_invalid",
    }), null);
  });

  it("rejects setter-only, non-enumerable, inherited, sparse, stateful and stolen-brand inputs", async () => {
    const setterOnly: JsonRecord = {};
    Object.defineProperty(setterOnly, "userId", { enumerable: true, set() {} });
    await assertReducerError(() => Promise.resolve(createEmptyMemoryV3LifecycleState(setterOnly as unknown as EmptyStateInput)), "lifecycle_reducer_invalid_input");

    const nonEnumerable = { userId: USER_ID };
    Object.defineProperty(nonEnumerable, "userId", { value: USER_ID, enumerable: false });
    await assertReducerError(() => Promise.resolve(createEmptyMemoryV3LifecycleState(nonEnumerable)), "lifecycle_reducer_invalid_input");
    await assertReducerError(() => Promise.resolve(createEmptyMemoryV3LifecycleState(Object.create({ userId: USER_ID }))), "lifecycle_reducer_invalid_input");

    const valid = {
      state: createEmptyMemoryV3LifecycleState({ userId: USER_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: "conversation-01",
      extraction: eventExtraction(),
      proposal: new Array(1),
      trustedForgetMemoryKeys: [],
    };
    await assertReducerError(() => applyMemoryV3LifecycleStep(valid as unknown as LifecycleStepInput), "lifecycle_reducer_invalid_input");

    const stateful = new Proxy(valid, {
      getOwnPropertyDescriptor() { throw new Error(RAW_SENTINEL); },
    });
    await assertReducerError(() => applyMemoryV3LifecycleStep(stateful as unknown as LifecycleStepInput), "lifecycle_reducer_invalid_input");

    let branded: Error;
    try {
      createEmptyMemoryV3LifecycleState({ userId: "invalid" });
      throw new Error("expected branded error");
    } catch (error) {
      branded = error as Error;
    }
    const stolen = new Proxy(valid, {
      getPrototypeOf() { throw branded; },
    });
    const wrapped = await assertReducerError(() => applyMemoryV3LifecycleStep(stolen as unknown as LifecycleStepInput), "lifecycle_reducer_invalid_input");
    assert.notEqual(wrapped, branded);
  });
});
