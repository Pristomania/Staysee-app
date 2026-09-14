/**
 * Deterministic evaluator for the synthetic Memory V3 lifecycle benchmark.
 * It is deliberately offline and reports only identifiers, counters, and scores.
 */

import { LIFECYCLE_OPERATION_TYPES, validateLifecycleState } from './lifecycle-contract.mjs';

const OWN_ERRORS = new WeakSet();
const CURRENT_STATUS = new Set(['active', 'candidate', 'supported']);
const EXPECTED_ITEM_FIELDS = Object.freeze([
  'goldMemoryId', 'tier', 'kind', 'claim', 'status', 'sensitivity',
  'eventTimeStart', 'eventTimeEnd', 'alternative', 'firstSeenAt', 'updatedAt',
  'revision', 'evidence',
]);
const TRANSITION_CONTEXT_FIELDS = Object.freeze([
  'expected', 'actual', 'replayEqual', 'noOpExpected', 'deletedMemoryKeys',
  'resurrectedMemoryKeys', 'forbiddenMemoryKeys', 'assistantOnlyMemoryKeys',
  'forgottenPairs',
]);
const EXPECTED_TRANSITION_FIELDS = Object.freeze([
  'type', 'candidateLocalItemKey', 'targetGoldMemoryId',
]);
const ACTUAL_TRANSITION_FIELDS = Object.freeze([
  'type', 'candidateLocalItemKey', 'targetMemoryKey', 'resultingMemoryKey',
]);
const FORGOTTEN_PAIR_FIELDS = Object.freeze(['goldMemoryId', 'memoryKey']);
const MATERIAL_FIELDS = Object.freeze([
  'kind', 'claim', 'status', 'sensitivity', 'eventTimeStart', 'eventTimeEnd',
  'alternative', 'firstSeenAt', 'updatedAt', 'revision',
]);
const EVIDENCE_FIELDS = Object.freeze([
  'conversationId', 'sourceMessageId', 'relation', 'supportType', 'episodeKey',
  'provenanceRole', 'mentionTime',
]);
const COUNT_FIELDS = Object.freeze([
  'requiredGoldCount', 'acceptableGoldCount', 'requiredMatchedCount',
  'acceptableMatchedCount', 'validMatchedCount', 'allActualCount',
  'extraFalsePositives', 'evidenceTp', 'evidenceFp', 'evidenceFn',
  'kindStatusEligible', 'kindStatusExact', 'correctionReplacementEligible',
  'correctionReplacementExact', 'duplicateActiveCount', 'supersededActiveCount',
  'noOpChurnCount', 'deletedRemnantCount', 'deletedResurrectionCount',
  'forbiddenMemoryViolationCount', 'assistantOnlyMemoryCount',
  'recurrencePartitionEligible', 'recurrencePartitionExact',
  'exactStateStepCount', 'exactStateMatchedCount',
]);

function fail(message = 'value is invalid') {
  const error = new Error(`[memory-v3:lifecycle-evaluator] ${message}`);
  error.name = 'MemoryV3LifecycleEvaluatorError';
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

function ownRecord(value, allowed, label) {
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
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label} is invalid`);
    }
    output[key] = descriptor.value;
  }
  for (const field of allowed) {
    if (!Object.hasOwn(output, field)) fail(`${label} is invalid`);
  }
  return output;
}

function denseArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} is invalid`);
  let keys;
  let lengthDescriptor;
  try {
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(`${label} is invalid`);
  }
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) fail(`${label} is invalid`);
  const length = lengthDescriptor.value;
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      fail(`${label} is invalid`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label} is invalid`);
    }
  }
  if (keys.length !== length + 1) fail(`${label} is invalid`);
  return Array.from({ length }, (_, index) =>
    Object.getOwnPropertyDescriptor(value, String(index)).value);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function f1(precision, recall) {
  return precision === 0 && recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function evidenceToken(row, includeEpisode = true) {
  return EVIDENCE_FIELDS.map((field) => {
    if (!includeEpisode && field === 'episodeKey') return '';
    return JSON.stringify(row[field]);
  }).join('\0');
}

function evidenceSet(item) {
  return new Set(item.evidence.map((row) => evidenceToken(row)));
}

function intersectionSize(left, right) {
  let count = 0n;
  for (const value of left) if (right.has(value)) count += 1n;
  return count;
}

function reduceRational(num, den) {
  function gcd(a, b) {
    while (b !== 0n) [a, b] = [b, a % b];
    return a;
  }
  const divisor = gcd(num < 0n ? -num : num, den);
  return { num: num / divisor, den: den / divisor };
}

function overlap(itemA, itemB) {
  const left = evidenceSet(itemA);
  const right = evidenceSet(itemB);
  const den = BigInt(left.size + right.size);
  if (den === 0n) return { num: 1n, den: 1n };
  return reduceRational(2n * intersectionSize(left, right), den);
}

function addRational(left, right) {
  return reduceRational(left.num * right.den + right.num * left.den, left.den * right.den);
}

function compareRational(left, right) {
  const a = left.num * right.den;
  const b = right.num * left.den;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePair(left, right) {
  return compareStrings(left.goldMemoryId, right.goldMemoryId) ||
    compareStrings(left.memoryKey, right.memoryKey);
}

function canonicalPairs(pairs) {
  return [...pairs].sort(comparePair);
}

function comparePairTuples(left, right) {
  const a = canonicalPairs(left);
  const b = canonicalPairs(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const compared = comparePair(a[index], b[index]);
    if (compared !== 0) return compared;
  }
  return a.length - b.length;
}

function better(candidate, best) {
  if (candidate.required !== best.required) return candidate.required > best.required;
  if (candidate.total !== best.total) return candidate.total > best.total;
  const overlapCompared = compareRational(candidate.overlap, best.overlap);
  if (overlapCompared !== 0) return overlapCompared > 0;
  return comparePairTuples(candidate.pairs, best.pairs) < 0;
}

function inspectExpectedItems(value) {
  const seen = new Set();
  const items = denseArray(value, 'expectedItems').map((raw) => {
    const item = ownRecord(raw, EXPECTED_ITEM_FIELDS, 'expected item');
    if (typeof item.goldMemoryId !== 'string' || item.goldMemoryId.length === 0 || seen.has(item.goldMemoryId)) {
      fail('expected item identity is invalid');
    }
    seen.add(item.goldMemoryId);
    if (item.tier !== 'required' && item.tier !== 'acceptable') fail('expected item tier is invalid');
    const evidence = denseArray(item.evidence, 'expected evidence').map((row) =>
      ownRecord(row, EVIDENCE_FIELDS, 'expected evidence'));
    return { ...item, evidence };
  });
  validateLifecycleState({
    scenarioId: 'expected-evaluation',
    nextMemoryOrdinal: items.length + 1,
    items: items.map((item, index) => {
      const { goldMemoryId, tier, ...stateItem } = item;
      return {
        memoryKey: (index + 1).toString(16).padStart(64, '0'),
        ...stateItem,
      };
    }),
  });
  return items;
}

function inspectActualItems(value) {
  const state = validateLifecycleState({ scenarioId: 'evaluation', nextMemoryOrdinal: value.length + 1, items: value });
  return state.items;
}

function assignInternal(expectedItems, actualItems) {
  let best = { required: 0, total: 0, overlap: { num: 0n, den: 1n }, pairs: [] };
  const used = new Set();
  function visit(index, pairs, required, overlapSum) {
    if (index === expectedItems.length) {
      const candidate = { required, total: pairs.length, overlap: overlapSum, pairs: [...pairs] };
      if (better(candidate, best)) best = candidate;
      return;
    }
    visit(index + 1, pairs, required, overlapSum);
    const expected = expectedItems[index];
    for (const actual of actualItems) {
      if (used.has(actual.memoryKey) || actual.kind !== expected.kind) continue;
      used.add(actual.memoryKey);
      const pair = { goldMemoryId: expected.goldMemoryId, memoryKey: actual.memoryKey };
      pairs.push(pair);
      visit(
        index + 1,
        pairs,
        required + (expected.tier === 'required' ? 1 : 0),
        addRational(overlapSum, overlap(expected, actual)),
      );
      pairs.pop();
      used.delete(actual.memoryKey);
    }
  }
  visit(0, [], 0, { num: 0n, den: 1n });
  return canonicalPairs(best.pairs);
}

export function assignLifecycleItems(options) {
  return boundary(() => {
    const root = ownRecord(options, ['expectedItems', 'actualItems'], 'options');
    const expectedItems = inspectExpectedItems(root.expectedItems);
    const actualItems = inspectActualItems(denseArray(root.actualItems, 'actualItems'));
    return deepFreeze({ pairs: assignInternal(expectedItems, actualItems) });
  });
}

function materialEqual(expected, actual) {
  return MATERIAL_FIELDS.every((field) => expected[field] === actual[field]);
}

function evidenceConfusion(expected, actual) {
  const left = evidenceSet(expected);
  const right = evidenceSet(actual);
  const tp = Number(intersectionSize(left, right));
  return { tp, fp: right.size - tp, fn: left.size - tp };
}

function observationMap(item) {
  const rows = item.evidence.filter((row) =>
    row.relation === 'supports' && row.supportType === 'episode_observation');
  return new Map(rows.map((row) => [
    `${row.conversationId}\0${row.sourceMessageId}\0${row.relation}\0${row.supportType}`,
    row.episodeKey,
  ]));
}

function partitionsEqual(expected, actual) {
  const left = observationMap(expected);
  const right = observationMap(actual);
  if (left.size !== right.size) return false;
  const ids = [...left.keys()];
  if (ids.some((id) => !right.has(id))) return false;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if ((left.get(ids[i]) === left.get(ids[j])) !== (right.get(ids[i]) === right.get(ids[j]))) {
        return false;
      }
    }
  }
  return true;
}

function inspectTransitionContext(value) {
  const root = ownRecord(value, TRANSITION_CONTEXT_FIELDS, 'transitions');
  if (typeof root.replayEqual !== 'boolean' || typeof root.noOpExpected !== 'boolean') {
    fail('transition flags are invalid');
  }
  const expected = denseArray(root.expected, 'expected transitions').map((entry) =>
    ownRecord(entry, EXPECTED_TRANSITION_FIELDS, 'expected transition'));
  const actual = denseArray(root.actual, 'actual transitions').map((entry) =>
    ownRecord(entry, ACTUAL_TRANSITION_FIELDS, 'actual transition'));
  for (const transition of [...expected, ...actual]) {
    if (!LIFECYCLE_OPERATION_TYPES.includes(transition.type) && transition.type !== 'forget') {
      fail('transition type is invalid');
    }
  }
  const ids = {};
  for (const field of ['deletedMemoryKeys', 'resurrectedMemoryKeys', 'forbiddenMemoryKeys', 'assistantOnlyMemoryKeys']) {
    ids[field] = denseArray(root[field], field);
    if (ids[field].some((entry) => typeof entry !== 'string' || entry.length === 0)) fail('transition ids are invalid');
  }
  const forgottenPairs = denseArray(root.forgottenPairs, 'forgottenPairs').map((entry) => {
    const pair = ownRecord(entry, FORGOTTEN_PAIR_FIELDS, 'forgotten pair');
    if (typeof pair.goldMemoryId !== 'string' || typeof pair.memoryKey !== 'string') {
      fail('forgotten pair is invalid');
    }
    return pair;
  });
  return { ...root, expected, actual, ...ids, forgottenPairs };
}

function transitionMetrics(context, pairByGold) {
  const expectedByType = {};
  const exactByType = {};
  for (const entry of context.expected) expectedByType[entry.type] = (expectedByType[entry.type] ?? 0) + 1;
  const used = new Set();
  for (const expected of context.expected) {
    const target = expected.targetGoldMemoryId === null
      ? null
      : pairByGold.get(expected.targetGoldMemoryId) ?? null;
    const index = context.actual.findIndex((actual, candidateIndex) =>
      !used.has(candidateIndex) &&
      actual.type === expected.type &&
      actual.candidateLocalItemKey === expected.candidateLocalItemKey &&
      actual.targetMemoryKey === target &&
      transitionResultIsExact(expected.type, actual, target, pairByGold));
    if (index >= 0) {
      used.add(index);
      exactByType[expected.type] = (exactByType[expected.type] ?? 0) + 1;
    }
  }
  return { expectedByType, exactByType };
}

function transitionResultIsExact(type, actual, target, pairByGold) {
  if (type === 'ignore' || type === 'forget') return actual.resultingMemoryKey === null;
  if (type === 'create') {
    return actual.resultingMemoryKey !== null &&
      [...pairByGold.values()].includes(actual.resultingMemoryKey);
  }
  return actual.resultingMemoryKey === target;
}

function exactCorrectionCount(context, pairByGold, expectedById, actualByKey) {
  let exact = 0;
  for (const expectedTransition of context.expected.filter((entry) => entry.type === 'revise')) {
    const memoryKey = pairByGold.get(expectedTransition.targetGoldMemoryId);
    const expectedItem = expectedById.get(expectedTransition.targetGoldMemoryId);
    const actualItem = memoryKey === undefined ? undefined : actualByKey.get(memoryKey);
    const hasTransition = context.actual.some((entry) =>
      entry.type === 'revise' &&
      entry.candidateLocalItemKey === expectedTransition.candidateLocalItemKey &&
      entry.targetMemoryKey === memoryKey);
    if (hasTransition && expectedItem && actualItem && materialEqual(expectedItem, actualItem)) exact += 1;
  }
  return exact;
}

function activeFingerprint(item) {
  return JSON.stringify([
    item.kind, item.claim.normalize('NFC').trim(), item.sensitivity,
    item.eventTimeStart, item.eventTimeEnd, item.alternative,
  ]);
}

function emptyCounts() {
  const counts = Object.fromEntries(COUNT_FIELDS.map((field) => [field, 0]));
  counts.transitionExpectedByType = {};
  counts.transitionExactByType = {};
  return counts;
}

function metricsFromCounts(counts) {
  const requiredPrecisionDenominator = counts.requiredMatchedCount + counts.extraFalsePositives;
  const requiredPrecision = ratio(counts.requiredMatchedCount, requiredPrecisionDenominator);
  const requiredRecall = ratio(counts.requiredMatchedCount, counts.requiredGoldCount);
  const overallPrecision = ratio(counts.validMatchedCount, counts.allActualCount);
  const overallRecall = requiredRecall;
  return {
    required: {
      precision: requiredPrecision,
      recall: requiredRecall,
      f1: f1(requiredPrecision, requiredRecall),
    },
    acceptable: {
      gold: counts.acceptableGoldCount,
      matched: counts.acceptableMatchedCount,
    },
    overall: {
      precision: overallPrecision,
      recall: overallRecall,
      f1: f1(overallPrecision, overallRecall),
    },
  };
}

function evidenceMetrics(counts) {
  const precision = ratio(counts.evidenceTp, counts.evidenceTp + counts.evidenceFp);
  const recall = ratio(counts.evidenceTp, counts.evidenceTp + counts.evidenceFn);
  return { tp: counts.evidenceTp, fp: counts.evidenceFp, fn: counts.evidenceFn, precision, recall, f1: f1(precision, recall) };
}

export function evaluateLifecycleStep(options) {
  return boundary(() => {
    const root = ownRecord(options, ['expectedState', 'actualState', 'transitions'], 'options');
    const expectedRoot = ownRecord(root.expectedState, ['items'], 'expectedState');
    const expectedItems = inspectExpectedItems(expectedRoot.items);
    const actualState = validateLifecycleState(root.actualState);
    const actualItems = actualState.items;
    const context = inspectTransitionContext(root.transitions);
    const pairs = assignInternal(expectedItems, actualItems);
    const expectedById = new Map(expectedItems.map((item) => [item.goldMemoryId, item]));
    const actualByKey = new Map(actualItems.map((item) => [item.memoryKey, item]));
    const pairByGold = new Map(pairs.map((pair) => [pair.goldMemoryId, pair.memoryKey]));
    for (const pair of context.forgottenPairs) pairByGold.set(pair.goldMemoryId, pair.memoryKey);
    const counts = emptyCounts();
    counts.requiredGoldCount = expectedItems.filter((item) => item.tier === 'required').length;
    counts.acceptableGoldCount = expectedItems.length - counts.requiredGoldCount;
    counts.requiredMatchedCount = pairs.filter((pair) => expectedById.get(pair.goldMemoryId).tier === 'required').length;
    counts.acceptableMatchedCount = pairs.length - counts.requiredMatchedCount;
    counts.validMatchedCount = pairs.length;
    counts.allActualCount = actualItems.length;
    counts.extraFalsePositives = actualItems.length - pairs.length;

    for (const pair of pairs) {
      const expected = expectedById.get(pair.goldMemoryId);
      const actual = actualByKey.get(pair.memoryKey);
      const confusion = evidenceConfusion(expected, actual);
      counts.evidenceTp += confusion.tp;
      counts.evidenceFp += confusion.fp;
      counts.evidenceFn += confusion.fn;
      counts.kindStatusEligible += 1;
      if (expected.kind === actual.kind && expected.status === actual.status) counts.kindStatusExact += 1;
      if (expected.kind === 'recurrence' && observationMap(expected).size >= 2) {
        counts.recurrencePartitionEligible += 1;
        if (partitionsEqual(expected, actual)) counts.recurrencePartitionExact += 1;
      }
    }
    const matchedActual = new Set(pairs.map((pair) => pair.memoryKey));
    const matchedExpected = new Set(pairs.map((pair) => pair.goldMemoryId));
    for (const actual of actualItems) {
      if (!matchedActual.has(actual.memoryKey)) counts.evidenceFp += actual.evidence.length;
    }
    for (const expected of expectedItems) {
      if (!matchedExpected.has(expected.goldMemoryId) && expected.tier === 'required') {
        counts.evidenceFn += expected.evidence.length;
      }
    }

    const transitions = transitionMetrics(context, pairByGold);
    counts.transitionExpectedByType = transitions.expectedByType;
    counts.transitionExactByType = transitions.exactByType;
    counts.correctionReplacementEligible = transitions.expectedByType.revise ?? 0;
    counts.correctionReplacementExact = exactCorrectionCount(
      context,
      pairByGold,
      expectedById,
      actualByKey,
    );

    const activeSeen = new Set();
    for (const item of actualItems.filter((entry) => CURRENT_STATUS.has(entry.status))) {
      const fingerprint = activeFingerprint(item);
      if (activeSeen.has(fingerprint)) counts.duplicateActiveCount += 1;
      activeSeen.add(fingerprint);
    }
    const closedExpected = expectedItems.filter((item) => !CURRENT_STATUS.has(item.status));
    counts.supersededActiveCount = actualItems.filter((actual) =>
      CURRENT_STATUS.has(actual.status) && closedExpected.some((expected) => activeFingerprint(expected) === activeFingerprint(actual))).length;
    counts.deletedRemnantCount = context.deletedMemoryKeys.filter((key) => actualByKey.has(key)).length;
    counts.deletedResurrectionCount = new Set(context.resurrectedMemoryKeys).size;
    counts.forbiddenMemoryViolationCount = new Set(context.forbiddenMemoryKeys).size;
    counts.assistantOnlyMemoryCount = new Set(context.assistantOnlyMemoryKeys).size;
    counts.exactStateStepCount = 1;
    const exact = pairs.length === expectedItems.length && actualItems.length === expectedItems.length &&
      pairs.every((pair) => {
        const expected = expectedById.get(pair.goldMemoryId);
        const actual = actualByKey.get(pair.memoryKey);
        const confusion = evidenceConfusion(expected, actual);
        return materialEqual(expected, actual) && confusion.fp === 0 && confusion.fn === 0;
      });
    counts.exactStateMatchedCount = exact ? 1 : 0;
    counts.noOpChurnCount = context.noOpExpected && !exact ? 1 : 0;

    return deepFreeze({
      counts,
      items: metricsFromCounts(counts),
      evidence: evidenceMetrics(counts),
      transitionAccuracy: {
        expectedByType: { ...counts.transitionExpectedByType },
        exactByType: { ...counts.transitionExactByType },
      },
      matches: pairs.map((pair) => ({ ...pair })),
      replayEqual: context.replayEqual,
      semanticClaims: { status: 'not_evaluated' },
      forbiddenClaims: { status: 'not_evaluated' },
    });
  });
}

function addTypeCounts(target, source) {
  for (const [type, value] of Object.entries(source)) target[type] = (target[type] ?? 0) + value;
}

export function evaluateLifecycleScenario(options) {
  return boundary(() => {
    const root = ownRecord(options, ['scenario', 'stepResults'], 'options');
    const scenario = ownRecord(root.scenario, ['scenarioId'], 'scenario');
    if (typeof scenario.scenarioId !== 'string' || scenario.scenarioId.length === 0) fail('scenario is invalid');
    const steps = denseArray(root.stepResults, 'stepResults');
    const counts = emptyCounts();
    let replayEqual = true;
    for (const step of steps) {
      if (step === null || typeof step !== 'object') fail('step result is invalid');
      for (const field of COUNT_FIELDS) {
        const value = step.counts?.[field];
        if (!Number.isSafeInteger(value) || value < 0) fail('step counts are invalid');
        counts[field] += value;
      }
      addTypeCounts(counts.transitionExpectedByType, step.counts.transitionExpectedByType);
      addTypeCounts(counts.transitionExactByType, step.counts.transitionExactByType);
      replayEqual = replayEqual && step.replayEqual === true;
    }
    return deepFreeze({
      scenarioId: scenario.scenarioId,
      stepCount: steps.length,
      counts,
      items: metricsFromCounts(counts),
      evidence: evidenceMetrics(counts),
      transitionAccuracy: {
        expectedByType: { ...counts.transitionExpectedByType },
        exactByType: { ...counts.transitionExactByType },
      },
      replayEqual,
      semanticClaims: { status: 'not_evaluated' },
      forbiddenClaims: { status: 'not_evaluated' },
    });
  });
}

export function assertLifecycleHardGates(report) {
  return boundary(() => {
    if (report === null || typeof report !== 'object' || report.counts === null || typeof report.counts !== 'object') {
      fail('report is invalid');
    }
    const counts = report.counts;
    for (const field of [
      'duplicateActiveCount', 'supersededActiveCount', 'noOpChurnCount',
      'deletedRemnantCount', 'deletedResurrectionCount',
      'forbiddenMemoryViolationCount', 'assistantOnlyMemoryCount',
    ]) {
      if (counts[field] !== 0) fail('absolute lifecycle gate failed');
    }
    if (counts.kindStatusEligible !== counts.kindStatusExact) fail('kind/status gate failed');
    if (counts.correctionReplacementEligible !== counts.correctionReplacementExact) fail('correction gate failed');
    if (counts.recurrencePartitionEligible !== counts.recurrencePartitionExact) fail('recurrence gate failed');
    if (counts.exactStateStepCount !== counts.exactStateMatchedCount) fail('exact state gate failed');
    if (report.replayEqual !== true) fail('replay gate failed');
    const types = new Set([
      ...Object.keys(counts.transitionExpectedByType ?? {}),
      ...Object.keys(counts.transitionExactByType ?? {}),
    ]);
    for (const type of types) {
      if ((counts.transitionExpectedByType[type] ?? 0) !== (counts.transitionExactByType[type] ?? 0)) {
        fail('transition gate failed');
      }
    }
    return deepFreeze({ status: 'PASS' });
  });
}
