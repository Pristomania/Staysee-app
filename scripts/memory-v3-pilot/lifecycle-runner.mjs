/** Fully offline sequential runner for the synthetic Memory V3 lifecycle benchmark. */

import { canonicalStringify } from './contracts.mjs';
import {
  validateLifecycleProposal,
  validateLifecycleSession,
  validateLifecycleState,
} from './lifecycle-contract.mjs';
import { applyLifecycleStep, createEmptyLifecycleState } from './lifecycle-reducer.mjs';
import {
  assignLifecycleItems,
  assertLifecycleHardGates,
  evaluateLifecycleScenario,
  evaluateLifecycleStep,
} from './lifecycle-evaluator.mjs';

const OWN_ERRORS = new WeakSet();
const DATASET_FIELDS = ['datasetId', 'version', 'language', 'privacy', 'scenarios'];
const SCENARIO_FIELDS = ['scenarioId', 'title', 'steps'];
const STEP_FIELDS = [
  'stepId', 'at', 'conversationId', 'messages', 'validatedExtraction',
  'scriptedProposal', 'forgetMemoryRefs', 'expectedState', 'mustNotRemember',
];
const MESSAGE_FIELDS = ['id', 'role', 'text', 'createdAt'];
const AUTHORING_PROPOSAL_FIELDS = ['type', 'candidateLocalItemKey', 'targetGoldMemoryId'];
const EXPECTED_STATE_FIELDS = ['items'];
const EXPECTED_ITEM_FIELDS = [
  'goldMemoryId', 'tier', 'kind', 'claim', 'status', 'sensitivity',
  'eventTimeStart', 'eventTimeEnd', 'alternative', 'firstSeenAt', 'updatedAt',
  'revision', 'evidence',
];
const STATE_EVIDENCE_FIELDS = [
  'conversationId', 'sourceMessageId', 'relation', 'supportType', 'episodeKey',
  'provenanceRole', 'mentionTime',
];
const OPTIONS_FIELDS = ['dataset', 'reconciliationAdapter'];

function fail(message = 'value is invalid') {
  const error = new Error(`[memory-v3:lifecycle-runner] ${message}`);
  error.name = 'MemoryV3LifecycleRunnerError';
  OWN_ERRORS.add(error);
  throw error;
}

function boundary(fn) {
  try {
    return fn();
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail();
  }
}

async function asyncBoundary(fn, message = 'execution failed') {
  try {
    return await fn();
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail(message);
  }
}

function record(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`);
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} is invalid`);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} is invalid`);
  const output = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(`${label} is invalid`);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label} is invalid`);
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} is invalid`);
    output[key] = descriptor.value;
  }
  for (const field of allowed) if (!Object.hasOwn(output, field)) fail(`${label} is invalid`);
  return output;
}

function dense(value, label) {
  if (!Array.isArray(value)) fail(`${label} is invalid`);
  let keys;
  let lengthDescriptor;
  try {
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(`${label} is invalid`);
  }
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value)) {
    fail(`${label} is invalid`);
  }
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1) fail(`${label} is invalid`);
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} is invalid`);
    output.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) fail(`${label} is invalid`);
  }
  return output;
}

function scalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function cloneJsonData(value, seen = new WeakSet()) {
  if (scalar(value)) return value;
  if (typeof value !== 'object' || value === null || seen.has(value)) fail();
  seen.add(value);
  if (Array.isArray(value)) return dense(value, 'array').map((entry) => cloneJsonData(entry, seen));
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const output = {};
  for (const key of keys) {
    if (typeof key !== 'string') fail();
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[key] = cloneJsonData(descriptor.value, seen);
  }
  return output;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function runtimeKey(index) {
  return (index + 1).toString(16).padStart(64, '0');
}

function expectedRuntimeState(scenarioId, expectedState) {
  return {
    scenarioId,
    nextMemoryOrdinal: expectedState.items.length + 1,
    items: expectedState.items.map(({ goldMemoryId, tier, ...item }, index) => ({
      memoryKey: runtimeKey(index),
      ...item,
      evidence: item.evidence.map((row) => ({ ...row })),
    })),
  };
}

function inspectExpectedState(raw, scenarioId) {
  const root = record(raw, EXPECTED_STATE_FIELDS, 'expectedState');
  const ids = new Set();
  const items = dense(root.items, 'expectedState.items').map((entry) => {
    const item = record(entry, EXPECTED_ITEM_FIELDS, 'expected item');
    if (!nonEmpty(item.goldMemoryId) || ids.has(item.goldMemoryId) || item.tier !== 'required') fail();
    ids.add(item.goldMemoryId);
    const evidence = dense(item.evidence, 'expected evidence').map((row) => ({
      ...record(row, STATE_EVIDENCE_FIELDS, 'expected evidence'),
    }));
    return { ...item, evidence };
  });
  const output = { items };
  validateLifecycleState(expectedRuntimeState(scenarioId, output));
  return output;
}

function inspectExtraction(raw) {
  return cloneJsonData(raw);
}

function inspectScenario(raw) {
  const root = record(raw, SCENARIO_FIELDS, 'scenario');
  if (!nonEmpty(root.scenarioId) || !nonEmpty(root.title)) fail();
  const steps = dense(root.steps, 'scenario.steps');
  if (steps.length === 0) fail();
  let previousTime = -Infinity;
  let previousExpected = { items: [] };
  const knownGold = new Set();
  const knownMessages = new Map();
  const outputSteps = steps.map((rawStep, index) => {
    const step = record(rawStep, STEP_FIELDS, 'step');
    if (step.stepId !== `${root.scenarioId}-s${String(index + 1).padStart(2, '0')}` || !nonEmpty(step.conversationId)) fail();
    const timestamp = Date.parse(step.at);
    if (!Number.isFinite(timestamp) || timestamp < previousTime) fail();
    previousTime = timestamp;
    const session = validateLifecycleSession({
      scenarioId: root.scenarioId,
      stepId: step.stepId,
      at: step.at,
      conversationId: step.conversationId,
    });
    const messageIds = new Set();
    const messages = dense(step.messages, 'step.messages').map((entry) => {
      const message = record(entry, MESSAGE_FIELDS, 'message');
      if (
        !nonEmpty(message.id) || messageIds.has(message.id) ||
        !['user', 'assistant', 'system'].includes(message.role) ||
        !nonEmpty(message.text) || !Number.isFinite(Date.parse(message.createdAt))
      ) fail();
      messageIds.add(message.id);
      return { ...message };
    });
    for (const message of messages) {
      knownMessages.set(`${step.conversationId}\0${message.id}`, message);
    }
    const extraction = inspectExtraction(step.validatedExtraction);
    if (extraction?.run?.caseId !== step.stepId) fail();
    for (const row of extraction?.evidence ?? []) {
      const message = messages.find((entry) => entry.id === row.sourceMessageId);
      if (!message || message.role !== 'user' || row.mentionTime !== message.createdAt) fail();
    }
    const scriptedProposal = dense(step.scriptedProposal, 'scriptedProposal').map((entry) => {
      const row = record(entry, AUTHORING_PROPOSAL_FIELDS, 'scripted proposal');
      if (!nonEmpty(row.candidateLocalItemKey)) fail();
      if (row.targetGoldMemoryId !== null && !knownGold.has(row.targetGoldMemoryId)) fail();
      return { ...row };
    });
    const forgetMemoryRefs = dense(step.forgetMemoryRefs, 'forgetMemoryRefs').map((ref) => {
      if (!nonEmpty(ref) || !knownGold.has(ref)) fail();
      return ref;
    });
    const expectedState = inspectExpectedState(step.expectedState, root.scenarioId);
    for (const item of expectedState.items) {
      for (const row of item.evidence) {
        const message = knownMessages.get(`${row.conversationId}\0${row.sourceMessageId}`);
        if (!message || message.role !== 'user' || row.provenanceRole !== 'user' || row.mentionTime !== message.createdAt) fail();
      }
    }
    const mustNotRemember = dense(step.mustNotRemember, 'mustNotRemember').map((claim) => {
      if (!nonEmpty(claim)) fail();
      return claim;
    });
    const preflightKeys = new Map([...knownGold].map((id, keyIndex) => [id, runtimeKey(keyIndex)]));
    const preflightState = expectedRuntimeState(root.scenarioId, previousExpected);
    const proposal = scriptedProposal.map((row) => ({
      type: row.type,
      candidateLocalItemKey: row.candidateLocalItemKey,
      targetMemoryKey: row.targetGoldMemoryId === null ? null : preflightKeys.get(row.targetGoldMemoryId),
    }));
    validateLifecycleProposal(proposal, { state: preflightState, extraction });
    for (const ref of forgetMemoryRefs) knownGold.delete(ref);
    knownGold.clear();
    for (const item of expectedState.items) knownGold.add(item.goldMemoryId);
    previousExpected = expectedState;
    return { session, messages, extraction, scriptedProposal, forgetMemoryRefs, expectedState, mustNotRemember };
  });
  return { scenarioId: root.scenarioId, title: root.title, steps: outputSteps };
}

function inspectDataset(raw) {
  const cloned = cloneJsonData(raw);
  const root = record(cloned, DATASET_FIELDS, 'dataset');
  if (root.datasetId !== 'memory-v3-synthetic-lifecycle-v1' || root.version !== '1.0.0') fail();
  if (root.language !== 'ru' || root.privacy !== 'synthetic-only') fail();
  const scenarios = dense(root.scenarios, 'dataset.scenarios');
  if (scenarios.length === 0) fail();
  const ids = new Set();
  const projected = scenarios.map((scenario) => {
    const value = inspectScenario(scenario);
    if (ids.has(value.scenarioId)) fail();
    ids.add(value.scenarioId);
    return value;
  });
  return { datasetId: root.datasetId, version: root.version, scenarios: projected };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function goldMap(expectedItems, actualItems) {
  return new Map(assignLifecycleItems({ expectedItems, actualItems }).pairs.map((pair) => [
    pair.goldMemoryId,
    pair.memoryKey,
  ]));
}

export function createScriptedLifecycleAdapter(options) {
  return boundary(() => {
    const root = record(options, ['scenario'], 'options');
    const scenario = inspectScenario(cloneJsonData(root.scenario));
    const stepById = new Map(scenario.steps.map((step) => [step.session.stepId, step]));
    return async (request) => asyncBoundary(async () => {
      const input = record(request, ['session', 'currentState', 'extraction'], 'request');
      const session = validateLifecycleSession(input.session);
      const currentState = validateLifecycleState(input.currentState);
      const extraction = cloneJsonData(input.extraction);
      const step = stepById.get(session.stepId);
      if (!step || session.scenarioId !== scenario.scenarioId || currentState.scenarioId !== scenario.scenarioId) fail();
      const index = scenario.steps.indexOf(step);
      const previousExpected = index === 0 ? [] : scenario.steps[index - 1].expectedState.items;
      const mapping = goldMap(previousExpected, currentState.items);
      const proposal = step.scriptedProposal.map((row) => ({
        type: row.type,
        candidateLocalItemKey: row.candidateLocalItemKey,
        targetMemoryKey: row.targetGoldMemoryId === null ? null : mapping.get(row.targetGoldMemoryId),
      }));
      validateLifecycleProposal(proposal, { state: currentState, extraction });
      return deepFreeze(proposal.map((row) => ({ ...row })));
    });
  });
}

function sumScenarioReports(reports) {
  return evaluateLifecycleScenario({
    scenario: { scenarioId: 'synthetic-lifecycle-aggregate' },
    stepResults: reports.flatMap((entry) => entry.stepReports),
  });
}

function stageFor(error) {
  if (OWN_ERRORS.has(error)) return 'runner';
  return 'adapter';
}

export async function runSyntheticLifecycleBenchmark(options) {
  let prepared;
  let adapter;
  try {
    const root = record(options, OPTIONS_FIELDS, 'options');
    if (typeof root.reconciliationAdapter !== 'function') fail('reconciliationAdapter must be a function');
    prepared = inspectDataset(root.dataset);
    adapter = root.reconciliationAdapter;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail();
  }

  let attemptedStepCount = 0;
  let successfulStepCount = 0;
  let failureCount = 0;
  let active = 0;
  let maxActive = 0;
  const scenarioReports = [];

  for (const scenario of prepared.scenarios) {
    let state = createEmptyLifecycleState({ scenarioId: scenario.scenarioId });
    const stepReports = [];
    const failures = [];
    const forgotten = new Set();
    for (const step of scenario.steps) {
      attemptedStepCount += 1;
      const beforeState = state;
      const previousExpected = stepReports.length === 0 ? [] : scenario.steps[stepReports.length - 1].expectedState.items;
      const beforeMap = goldMap(previousExpected, beforeState.items);
      const forgetMemoryKeys = step.forgetMemoryRefs.map((ref) => beforeMap.get(ref));
      const forgottenPairs = step.forgetMemoryRefs.map((goldMemoryId) => ({
        goldMemoryId,
        memoryKey: beforeMap.get(goldMemoryId),
      }));
      try {
        active += 1;
        maxActive = Math.max(maxActive, active);
        let proposal;
        try {
          proposal = await adapter({
            session: step.session,
            currentState: beforeState,
            extraction: step.extraction,
          });
        } finally {
          active -= 1;
        }
        const applied = applyLifecycleStep({
          state: beforeState,
          session: step.session,
          extraction: step.extraction,
          proposal,
          forgetMemoryKeys,
        });
        const replay = applyLifecycleStep({
          state: beforeState,
          session: step.session,
          extraction: step.extraction,
          proposal,
          forgetMemoryKeys,
        });
        for (const key of forgetMemoryKeys) forgotten.add(key);
        const forbidden = applied.state.items
          .filter((item) => step.mustNotRemember.includes(item.claim) || step.mustNotRemember.includes(item.alternative))
          .map((item) => item.memoryKey);
        const assistantOnly = applied.state.items
          .filter((item) => item.evidence.length > 0 && item.evidence.every((row) => row.provenanceRole !== 'user'))
          .map((item) => item.memoryKey);
        const report = evaluateLifecycleStep({
          expectedState: step.expectedState,
          actualState: applied.state,
          transitions: {
            expected: [
              ...step.scriptedProposal,
              ...step.forgetMemoryRefs.map((targetGoldMemoryId) => ({
                type: 'forget', candidateLocalItemKey: null, targetGoldMemoryId,
              })),
            ],
            actual: applied.transitions,
            replayEqual: canonicalStringify(applied) === canonicalStringify(replay),
            noOpExpected: step.scriptedProposal.every((row) => row.type === 'ignore') && step.forgetMemoryRefs.length === 0,
            deletedMemoryKeys: forgetMemoryKeys,
            resurrectedMemoryKeys: [...forgotten].filter((key) => applied.state.items.some((item) => item.memoryKey === key)),
            forbiddenMemoryKeys: forbidden,
            assistantOnlyMemoryKeys: assistantOnly,
            forgottenPairs,
          },
        });
        state = applied.state;
        stepReports.push(report);
        successfulStepCount += 1;
      } catch (error) {
        failureCount += 1;
        failures.push({
          stepId: step.session.stepId,
          stage: stageFor(error),
          diagnosticCode: stageFor(error) === 'adapter'
            ? 'lifecycle_runner_adapter_failed'
            : 'lifecycle_runner_step_failed',
        });
        break;
      }
    }
    const scenarioReport = evaluateLifecycleScenario({
      scenario: { scenarioId: scenario.scenarioId },
      stepResults: stepReports,
    });
    scenarioReports.push({
      scenarioId: scenario.scenarioId,
      stepCount: stepReports.length,
      counts: scenarioReport.counts,
      items: scenarioReport.items,
      evidence: scenarioReport.evidence,
      transitionAccuracy: scenarioReport.transitionAccuracy,
      replayEqual: scenarioReport.replayEqual,
      semanticClaims: scenarioReport.semanticClaims,
      forbiddenClaims: scenarioReport.forbiddenClaims,
      failures,
      stepReports,
    });
  }

  const aggregate = sumScenarioReports(scenarioReports);
  const hardGates = failureCount === 0 ? assertLifecycleHardGates(aggregate) : { status: 'FAIL' };
  const sanitizedScenarios = scenarioReports.map(({ stepReports, ...row }) => row);
  return deepFreeze({
    datasetId: prepared.datasetId,
    version: prepared.version,
    scenarioCount: prepared.scenarios.length,
    stepCount: prepared.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0),
    attemptedStepCount,
    successfulStepCount,
    failureCount,
    maxActive,
    scenarios: sanitizedScenarios,
    aggregate,
    hardGates,
    externalCalls: 0,
  });
}
