import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MemoryV3Extraction } from "./contract.ts";
import type {
  MemoryV3DialogueProposal,
} from "./dialogueContract.ts";
import { MEMORY_V3_DIALOGUE_TOPICS } from "./dialogueContract.ts";
import {
  applyMemoryV3DialogueStep,
  createEmptyMemoryV3DialogueState,
  projectSafeMemoryV3DialogueReducerDiagnostic,
} from "./dialogueReducer.ts";

// No "production dialogue parity" suite here (unlike lifecycleReducer.cases.test.ts's
// 80-step comparison against scripts/memory-v3-pilot/lifecycle-reducer.mjs): that
// frozen reference script models the account-wide case only. The state-transition
// algorithm itself is not new -- it's byte-for-byte mirrored from the already
// parity-tested lifecycleReducer.ts, only the state's conversationId dimension is
// added -- so re-verifying algorithmic correctness against an external reference
// would be redundant, not just costly. This file covers the reducer's direct
// behavior and adversarial-input hardening instead, exactly like
// lifecycleReducer.cases.test.ts's second and third describe blocks.

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const RAW_SENTINEL = "RAW_DIALOGUE_REDUCER_SECRET_SENTINEL";
// Topic used across the pre-existing (non-topic-focused) fixtures below: a single constant value
// so that create/revise operations never trigger the new topic-changed revision bump by accident.
// The dedicated "Memory V3 dialogue reducer topic" suite at the end of this file is what actually
// varies topic across operations.
const TOPIC = MEMORY_V3_DIALOGUE_TOPICS[0];

type JsonRecord = Record<string, unknown>;
type EmptyStateInput = Parameters<typeof createEmptyMemoryV3DialogueState>[0];
type DialogueStepInput = Parameters<typeof applyMemoryV3DialogueStep>[0];

function assertReducerError(fn: () => unknown | Promise<unknown>, diagnosticCode: string): Promise<Error> | Error {
  const verify = (error: unknown): Error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^\[memory-v3:dialogue-reducer\] /);
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes(RAW_SENTINEL), false);
    assert.equal(projectSafeMemoryV3DialogueReducerDiagnostic(error), diagnosticCode);
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
    scope: "conversation",
    conversationId: CONVERSATION_ID,
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
    scope: "conversation",
    conversationId: CONVERSATION_ID,
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
    scope: "conversation",
    conversationId: CONVERSATION_ID,
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
  return applyMemoryV3DialogueStep({
    state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    at: "2026-01-10T10:00:00Z",
    conversationId: CONVERSATION_ID,
    extraction: eventExtraction(),
    proposal: [{ type: "create", candidateLocalItemKey: "candidate-01", targetMemoryKey: null, topic: TOPIC }],
    trustedForgetMemoryKeys: [],
    ...overrides,
  });
}

describe("production dialogue reducer behavior", () => {
  it("creates a deeply frozen empty state carrying its own conversationId", () => {
    const state = createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID });
    assert.deepEqual(state, {
      schemaVersion: "memory-v3-dialogue-state-v1",
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      stateRevision: 0,
      nextMemoryOrdinal: 1,
      items: [],
    });
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.items), true);
  });

  it("creates deterministic lowercase SHA-256 identity from the dialogue namespace payload", async () => {
    const result = await applyCreate();
    const payload = JSON.stringify({
      namespace: "memory-v3-production-dialogue-v1",
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
    const proposal: MemoryV3DialogueProposal = [
      { type: "create", candidateLocalItemKey: "a-candidate", targetMemoryKey: null, topic: TOPIC },
      { type: "create", candidateLocalItemKey: "Z-candidate", targetMemoryKey: null, topic: TOPIC },
    ];
    const input = {
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction,
      proposal,
      trustedForgetMemoryKeys: [],
    };
    const left = await applyMemoryV3DialogueStep(input);
    const right = await applyMemoryV3DialogueStep({ ...input, proposal: [...proposal].reverse() });
    assert.deepEqual(left, right);
    assert.deepEqual(left.transitions.map((row) => row.candidateLocalItemKey), ["Z-candidate", "a-candidate"]);
  });

  it("does not reuse an ordinal after forgetting", async () => {
    const first = await applyCreate();
    const forgotten = await applyMemoryV3DialogueStep({
      state: first.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: CONVERSATION_ID,
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
    const confirmed = await applyMemoryV3DialogueStep({
      state: created.state,
      at: "2026-02-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction,
      proposal: [{
        type: "confirm",
        candidateLocalItemKey: "candidate-01",
        targetMemoryKey: created.state.items[0].memoryKey,
        topic: null,
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
    const empty = createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID });
    const ignored = await applyCreate({
      state: empty,
      proposal: [{ type: "ignore", candidateLocalItemKey: "candidate-01", targetMemoryKey: null, topic: null }],
    });
    assert.equal(ignored.changed, false);
    assert.deepEqual(ignored.state, empty);

    const created = await applyCreate();
    const confirmed = await applyMemoryV3DialogueStep({
      state: created.state,
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction(),
      proposal: [{ type: "confirm", candidateLocalItemKey: "candidate-01", targetMemoryKey: created.state.items[0].memoryKey, topic: null }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(confirmed.changed, false);
    assert.deepEqual(confirmed.state, created.state);
  });

  it("does not revise timestamps or revision when material and evidence are unchanged", async () => {
    const created = await applyCreate();
    const revised = await applyMemoryV3DialogueStep({
      state: created.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction(),
      proposal: [{
        type: "revise",
        candidateLocalItemKey: "candidate-01",
        targetMemoryKey: created.state.items[0].memoryKey,
        topic: TOPIC,
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
    const created = await applyMemoryV3DialogueStep({
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction,
      proposal: extraction.items.map((item) => ({
        type: "create" as const,
        candidateLocalItemKey: item.localItemKey,
        targetMemoryKey: null,
        topic: TOPIC,
      })),
      trustedForgetMemoryKeys: [],
    });
    const reordered = structuredClone(created.state);
    reordered.items.reverse();
    const ignored = await applyMemoryV3DialogueStep({
      state: reordered,
      at: "2026-01-11T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction(),
      proposal: [{ type: "ignore", candidateLocalItemKey: "candidate-01", targetMemoryKey: null, topic: null }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(ignored.changed, false);
    assert.deepEqual(ignored.state, created.state);
  });

  it("applies revise, mark_stale, and reject with one material revision", async () => {
    const event = await applyCreate();
    const revised = await applyMemoryV3DialogueStep({
      state: event.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction({
        item: { claim: "Moved permanently to Kazan" },
        evidence: { sourceMessageId: "m2", episodeKey: "episode:m2", mentionTime: "2026-01-11T10:00:00Z" },
      }),
      proposal: [{ type: "revise", candidateLocalItemKey: "candidate-01", targetMemoryKey: event.state.items[0].memoryKey, topic: TOPIC }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(revised.state.items[0].claim, "Moved permanently to Kazan");
    assert.equal(revised.state.items[0].revision, 2);
    assert.equal(revised.state.items[0].updatedAt, "2026-01-11T10:00:00Z");

    const recurrenceInput = recurrenceExtraction();
    const recurrence = await applyMemoryV3DialogueStep({
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: recurrenceInput,
      proposal: [{ type: "create", candidateLocalItemKey: "candidate-recurrence", targetMemoryKey: null, topic: TOPIC }],
      trustedForgetMemoryKeys: [],
    });
    const stale = await applyMemoryV3DialogueStep({
      state: recurrence.state,
      at: "2026-01-12T10:00:00Z",
      conversationId: CONVERSATION_ID,
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
      proposal: [{ type: "mark_stale", candidateLocalItemKey: "candidate-recurrence", targetMemoryKey: recurrence.state.items[0].memoryKey, topic: null }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(stale.state.items[0].status, "stale");
    assert.equal(stale.state.items[0].claim, recurrence.state.items[0].claim);
    assert.equal(stale.state.items[0].revision, 2);

    const hypothesisInput = hypothesisExtraction();
    const hypothesis = await applyMemoryV3DialogueStep({
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: hypothesisInput,
      proposal: [{ type: "create", candidateLocalItemKey: "candidate-hypothesis", targetMemoryKey: null, topic: TOPIC }],
      trustedForgetMemoryKeys: [],
    });
    const rejected = await applyMemoryV3DialogueStep({
      state: hypothesis.state,
      at: "2026-01-12T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: hypothesisExtraction({ item: { status: "rejected" }, relation: "rejects" }),
      proposal: [{ type: "reject", candidateLocalItemKey: "candidate-hypothesis", targetMemoryKey: hypothesis.state.items[0].memoryKey, topic: null }],
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
    const created = await applyMemoryV3DialogueStep({
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction,
      proposal: extraction.items.map((item) => ({ type: "create" as const, candidateLocalItemKey: item.localItemKey, targetMemoryKey: null, topic: TOPIC })),
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
    await assertReducerError(() => applyMemoryV3DialogueStep({
      state,
      at: "2026-01-11T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: confirmExtraction,
      proposal: state.items.map((item, index) => ({
        type: "confirm" as const,
        candidateLocalItemKey: confirmExtraction.items[index].localItemKey,
        targetMemoryKey: item.memoryKey,
        topic: null,
      })),
      trustedForgetMemoryKeys: [],
    }), "dialogue_reducer_transition_invalid");
    assert.deepEqual(created.state, before);
    assert.equal(state.items.every((item) => item.evidence.length === 1), true);
  });

  it("rejects timestamp regression and key collision atomically", async () => {
    const created = await applyCreate();
    const before = structuredClone(created.state);
    await assertReducerError(() => applyMemoryV3DialogueStep({
      state: created.state,
      at: "2025-01-01T00:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction(),
      proposal: [{ type: "confirm", candidateLocalItemKey: "candidate-01", targetMemoryKey: created.state.items[0].memoryKey, topic: null }],
      trustedForgetMemoryKeys: [],
    }), "dialogue_reducer_transition_invalid");
    assert.deepEqual(created.state, before);

    const colliding = structuredClone(created.state);
    colliding.nextMemoryOrdinal = 1;
    await assertReducerError(() => applyCreate({ state: colliding }), "dialogue_reducer_transition_invalid");
    assert.deepEqual(created.state, before);
  });
});

describe("production dialogue reducer public boundary", () => {
  it("rejects unknown, accessor, symbol, cyclic, revoked and spoofed input safely", async () => {
    let getterCalls = 0;
    const accessor: JsonRecord = { conversationId: CONVERSATION_ID };
    Object.defineProperty(accessor, "userId", {
      enumerable: true,
      get() { getterCalls += 1; return RAW_SENTINEL; },
    });
    await assertReducerError(
      () => Promise.resolve(createEmptyMemoryV3DialogueState(accessor as unknown as EmptyStateInput)),
      "dialogue_reducer_invalid_input",
    );
    assert.equal(getterCalls, 0);

    const state = createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID });
    const cyclic: JsonRecord = {
      state,
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction(),
      proposal: [],
      trustedForgetMemoryKeys: [],
    };
    cyclic.extraction = cyclic;
    await assertReducerError(() => applyMemoryV3DialogueStep(cyclic as unknown as DialogueStepInput), "dialogue_reducer_invalid_input");
    const revoked = Proxy.revocable(cyclic, {});
    revoked.revoke();
    await assertReducerError(() => applyMemoryV3DialogueStep(revoked.proxy as unknown as DialogueStepInput), "dialogue_reducer_invalid_input");
    await assertReducerError(() => applyMemoryV3DialogueStep({ ...cyclic, [Symbol("secret")]: RAW_SENTINEL } as unknown as DialogueStepInput), "dialogue_reducer_invalid_input");
    assert.equal(projectSafeMemoryV3DialogueReducerDiagnostic({
      name: "MemoryV3DialogueReducerError",
      diagnosticCode: "dialogue_reducer_transition_invalid",
    }), null);
  });

  it("rejects setter-only, non-enumerable, inherited, sparse, stateful and stolen-brand inputs", async () => {
    const setterOnly: JsonRecord = { conversationId: CONVERSATION_ID };
    Object.defineProperty(setterOnly, "userId", { enumerable: true, set() {} });
    await assertReducerError(() => Promise.resolve(createEmptyMemoryV3DialogueState(setterOnly as unknown as EmptyStateInput)), "dialogue_reducer_invalid_input");

    const nonEnumerable = { userId: USER_ID, conversationId: CONVERSATION_ID };
    Object.defineProperty(nonEnumerable, "userId", { value: USER_ID, enumerable: false });
    await assertReducerError(() => Promise.resolve(createEmptyMemoryV3DialogueState(nonEnumerable)), "dialogue_reducer_invalid_input");
    await assertReducerError(() => Promise.resolve(createEmptyMemoryV3DialogueState(Object.create({ userId: USER_ID, conversationId: CONVERSATION_ID }))), "dialogue_reducer_invalid_input");

    const valid = {
      state: createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID }),
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction(),
      proposal: new Array(1),
      trustedForgetMemoryKeys: [],
    };
    await assertReducerError(() => applyMemoryV3DialogueStep(valid as unknown as DialogueStepInput), "dialogue_reducer_invalid_input");

    const stateful = new Proxy(valid, {
      getOwnPropertyDescriptor() { throw new Error(RAW_SENTINEL); },
    });
    await assertReducerError(() => applyMemoryV3DialogueStep(stateful as unknown as DialogueStepInput), "dialogue_reducer_invalid_input");

    let branded: Error;
    try {
      createEmptyMemoryV3DialogueState({ userId: "invalid", conversationId: CONVERSATION_ID });
      throw new Error("expected branded error");
    } catch (error) {
      branded = error as Error;
    }
    const stolen = new Proxy(valid, {
      getPrototypeOf() { throw branded; },
    });
    const wrapped = await assertReducerError(() => applyMemoryV3DialogueStep(stolen as unknown as DialogueStepInput), "dialogue_reducer_invalid_input");
    assert.notEqual(wrapped, branded);
  });
});

describe("Memory V3 dialogue reducer topic", () => {
  // Reuses the file's existing eventExtraction() fixture helper (see above) instead of a
  // self-contained inline extraction() builder, per the task brief's instruction to prefer
  // existing fixture helpers over parallel inline literals where one already exists.

  it("writes the operation's topic on a create", async () => {
    const state = createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID });
    const result = await applyMemoryV3DialogueStep({
      state,
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction({ item: { localItemKey: "item-1", claim: "Переехала в Казань" } }),
      proposal: [{ type: "create", candidateLocalItemKey: "item-1", targetMemoryKey: null, topic: "person" }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(result.state.items.length, 1);
    assert.equal(result.state.items[0].topic, "person");
  });

  it("bumps revision and updates topic on a revise even when every other field is identical", async () => {
    const state0 = createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID });
    const created = await applyMemoryV3DialogueStep({
      state: state0,
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction({ item: { localItemKey: "item-1", claim: "Переехала в Казань" } }),
      proposal: [{ type: "create", candidateLocalItemKey: "item-1", targetMemoryKey: null, topic: "fact" }],
      trustedForgetMemoryKeys: [],
    });
    const memoryKey = created.state.items[0].memoryKey;
    const revised = await applyMemoryV3DialogueStep({
      state: created.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction({ item: { localItemKey: "item-2", claim: "Переехала в Казань" } }),
      proposal: [{ type: "revise", candidateLocalItemKey: "item-2", targetMemoryKey: memoryKey, topic: "preference" }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(revised.state.items[0].topic, "preference");
    assert.equal(revised.state.items[0].revision, created.state.items[0].revision + 1);
  });

  it("leaves topic untouched on confirm", async () => {
    const state0 = createEmptyMemoryV3DialogueState({ userId: USER_ID, conversationId: CONVERSATION_ID });
    const created = await applyMemoryV3DialogueStep({
      state: state0,
      at: "2026-01-10T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction({ item: { localItemKey: "item-1", claim: "Переехала в Казань" } }),
      proposal: [{ type: "create", candidateLocalItemKey: "item-1", targetMemoryKey: null, topic: "fact" }],
      trustedForgetMemoryKeys: [],
    });
    const memoryKey = created.state.items[0].memoryKey;
    const confirmed = await applyMemoryV3DialogueStep({
      state: created.state,
      at: "2026-01-11T10:00:00Z",
      conversationId: CONVERSATION_ID,
      extraction: eventExtraction({ item: { localItemKey: "item-2", claim: "Переехала в Казань" } }),
      proposal: [{ type: "confirm", candidateLocalItemKey: "item-2", targetMemoryKey: memoryKey, topic: null }],
      trustedForgetMemoryKeys: [],
    });
    assert.equal(confirmed.state.items[0].topic, "fact");
  });
});
