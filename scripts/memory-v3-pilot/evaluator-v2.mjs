/**
 * Memory V3 V2 structural evaluator.
 * Deterministic global assignment with exact BigInt rationals.
 * No network, filesystem, env, provider, or V1 evaluator imports.
 */

import { goldItemsV2, validateCaseV2, validateExtractionV2 } from './contracts-v2.mjs';

const RELATIONS = Object.freeze(['supports', 'corrects', 'contradicts', 'rejects']);
const DATASET_FIELDS = Object.freeze(['datasetId', 'version', 'cases']);
const OPTIONS_OPTIONAL = Object.freeze(['extractorVersion']);
const EXTRACTION_FIELDS = Object.freeze(['run', 'items', 'evidence']);
const RUN_FIELDS = Object.freeze(['caseId', 'extractorVersion']);
const NOT_EVALUATED = Object.freeze({
  semanticClaims: Object.freeze({
    status: 'not_evaluated',
    reason: 'Structural evaluator does not judge paraphrase meaning',
  }),
  forbiddenClaims: Object.freeze({
    status: 'not_evaluated',
    reason: 'Structural evaluator cannot judge mustNotRemember claims by meaning',
  }),
});

function fail(message) {
  throw new Error(`[memory-v3:v2-evaluator] ${message}`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function inspectPlainObject(value, path) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    fail(`${path} must be a plain object`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be a plain object`);
  }
  if (proto !== Object.prototype && proto !== null) {
    fail(`${path} must be a plain object`);
  }
  try {
    return Reflect.ownKeys(value);
  } catch {
    fail(`${path} has an invalid shape`);
  }
}

function dataDescriptor(value, key, path) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(`${path} has an invalid shape`);
  }
  if (
    !desc ||
    typeof desc.get === 'function' ||
    typeof desc.set === 'function' ||
    !Object.prototype.hasOwnProperty.call(desc, 'value') ||
    desc.enumerable !== true
  ) {
    fail(`${path} has an invalid field`);
  }
  if (desc.value === undefined) {
    fail(`${path} is missing a required field`);
  }
  return desc;
}

function inspectRecord(value, allowed, path) {
  const keys = inspectPlainObject(value, path);
  const allowedSet = new Set(allowed);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      fail(`${path} has an unknown field`);
    }
    copy[key] = dataDescriptor(value, key, path).value;
  }
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      fail(`${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectRecordPartial(value, required, optional, path) {
  const keys = inspectPlainObject(value, path);
  const allowedSet = new Set([...required, ...optional]);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowedSet.has(key)) {
      fail(`${path} has an unknown field`);
    }
    copy[key] = dataDescriptor(value, key, path).value;
  }
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      fail(`${path} is missing a required field`);
    }
  }
  return copy;
}

function inspectDenseArray(value, path) {
  if (!Array.isArray(value)) fail(`${path} must be a dense array`);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${path} must be a dense array`);
  }
  const length = value.length;
  const allowed = new Set(['length']);
  for (let i = 0; i < length; i += 1) allowed.add(String(i));
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      fail(`${path} has an unknown field`);
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${path} has an invalid shape`);
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value')
    ) {
      fail(`${path} has an invalid field`);
    }
    if (key !== 'length' && desc.enumerable !== true) {
      fail(`${path} has an invalid field`);
    }
  }
  const entries = [];
  for (let i = 0; i < length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) {
      fail(`${path} must be a dense array`);
    }
    entries.push(desc.value);
  }
  return entries;
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const rest = a % b;
    a = b;
    b = rest;
  }
  return a === 0n ? 1n : a;
}

function reduceRational(value) {
  if (value.den <= 0n) fail('rational denominator must be positive');
  const divisor = gcd(value.num, value.den);
  return { num: value.num / divisor, den: value.den / divisor };
}

function addRational(left, right) {
  return reduceRational({
    num: left.num * right.den + right.num * left.den,
    den: left.den * right.den,
  });
}

function assertRational(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be a rational`);
  }
  const num = value.num;
  const den = value.den;
  if (typeof num !== 'bigint' || typeof den !== 'bigint') {
    fail(`${path} must use bigint fields`);
  }
  if (den <= 0n) fail(`${path} denominator must be positive`);
}

export function compareOverlapTotalsV2(left, right) {
  assertRational(left, 'left');
  assertRational(right, 'right');
  const leftValue = left.num * right.den;
  const rightValue = right.num * left.den;
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function emptyRelations() {
  return {
    supports: new Set(),
    corrects: new Set(),
    contradicts: new Set(),
    rejects: new Set(),
  };
}

function flattenRelations(kind, relations) {
  const result = new Set();
  for (const relation of RELATIONS) {
    for (const token of relations[relation]) {
      result.add(`${relation}\0${token}`);
    }
  }
  return result;
}

function intersectCount(left, right) {
  let count = 0n;
  for (const value of left) {
    if (right.has(value)) count += 1n;
  }
  return count;
}

function overlapF1(left, right) {
  const intersection = intersectCount(left, right);
  const den = BigInt(left.size) + BigInt(right.size);
  if (den === 0n) return { num: 1n, den: 1n };
  return reduceRational({ num: 2n * intersection, den });
}

function compareCodeUnits(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    fail('code-unit compare requires strings');
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePair(left, right) {
  const goldCmp = compareCodeUnits(left.goldItemId, right.goldItemId);
  if (goldCmp !== 0) return goldCmp;
  return compareCodeUnits(left.localItemKey, right.localItemKey);
}

function canonicalPairTuple(pairs) {
  return [...pairs].sort(comparePair);
}

function comparePairTuples(left, right) {
  const limit = left.length < right.length ? left.length : right.length;
  for (let index = 0; index < limit; index += 1) {
    const cmp = comparePair(left[index], right[index]);
    if (cmp !== 0) return cmp;
  }
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  return 0;
}

function isBetterMatching(candidate, currentBest) {
  if (candidate.requiredCount !== currentBest.requiredCount) {
    return candidate.requiredCount > currentBest.requiredCount;
  }
  if (candidate.totalCount !== currentBest.totalCount) {
    return candidate.totalCount > currentBest.totalCount;
  }
  const overlapCmp = compareOverlapTotalsV2(candidate.overlapSum, currentBest.overlapSum);
  if (overlapCmp !== 0) return overlapCmp > 0;
  return comparePairTuples(canonicalPairTuple(candidate.pairs), canonicalPairTuple(currentBest.pairs)) < 0;
}

export function assignPredictedToGoldV2({ goldItems, predictedItems }) {
  const gold = goldItems;
  const predicted = predictedItems;
  const candidates = gold.map((goldItem) => {
    const edges = [];
    for (const predictedItem of predicted) {
      if (goldItem.kind !== predictedItem.kind) continue;
      if (intersectCount(goldItem.relations.supports, predictedItem.relations.supports) === 0n) {
        continue;
      }
      edges.push({
        predicted: predictedItem,
        overlap: overlapF1(
          flattenRelations(goldItem.kind, goldItem.relations),
          flattenRelations(predictedItem.kind, predictedItem.relations),
        ),
      });
    }
    return edges;
  });

  let best = {
    requiredCount: 0,
    totalCount: 0,
    overlapSum: { num: 0n, den: 1n },
    pairs: [],
  };
  const usedPredicted = new Set();

  function visit(goldIndex, pairs, requiredCount, overlapSum) {
    if (goldIndex === gold.length) {
      const candidate = {
        requiredCount,
        totalCount: pairs.length,
        overlapSum,
        pairs: pairs.map((pair) => ({
          goldItemId: pair.gold.goldItemId,
          localItemKey: pair.predicted.localItemKey,
          gold: pair.gold,
          predicted: pair.predicted,
          overlap: pair.overlap,
        })),
      };
      if (isBetterMatching(candidate, best)) best = candidate;
      return;
    }

    visit(goldIndex + 1, pairs, requiredCount, overlapSum);
    const goldItem = gold[goldIndex];
    for (const edge of candidates[goldIndex]) {
      const predictedKey = edge.predicted.localItemKey;
      if (usedPredicted.has(predictedKey)) continue;
      usedPredicted.add(predictedKey);
      pairs.push({ gold: goldItem, predicted: edge.predicted, overlap: edge.overlap });
      visit(
        goldIndex + 1,
        pairs,
        requiredCount + (goldItem.tier === 'required' ? 1 : 0),
        addRational(overlapSum, edge.overlap),
      );
      pairs.pop();
      usedPredicted.delete(predictedKey);
    }
  }

  visit(0, [], 0, { num: 0n, den: 1n });
  return { pairs: canonicalPairTuple(best.pairs) };
}

function relationSetsFromGold(kind, entry) {
  const relations = emptyRelations();
  const supportIds = entry.supportMessageIds ?? [];
  const supportTypes = entry.supportTypes ?? [];
  for (let index = 0; index < supportIds.length; index += 1) {
    const sourceMessageId = supportIds[index];
    if (kind === 'recurrence') {
      relations.supports.add(`${sourceMessageId}\0${supportTypes[index]}`);
    } else {
      relations.supports.add(sourceMessageId);
    }
  }
  for (const sourceMessageId of entry.correctedMessageIds ?? []) {
    relations.corrects.add(sourceMessageId);
  }
  for (const sourceMessageId of entry.contradictedMessageIds ?? []) {
    relations.contradicts.add(sourceMessageId);
  }
  for (const sourceMessageId of entry.rejectedMessageIds ?? []) {
    relations.rejects.add(sourceMessageId);
  }
  return relations;
}

function relationSetsFromPredicted(kind, itemKey, evidence) {
  const relations = emptyRelations();
  for (const entry of evidence) {
    if (entry.itemKey !== itemKey) continue;
    if (kind === 'recurrence' && entry.relation === 'supports') {
      relations.supports.add(`${entry.sourceMessageId}\0${entry.supportType}`);
    } else {
      relations[entry.relation].add(entry.sourceMessageId);
    }
  }
  return relations;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function harmonic(precision, recall) {
  if (precision === 0 && recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function evidenceMetric(tp, fp, fn) {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { tp, fp, fn, precision, recall, f1: harmonic(precision, recall) };
}

function itemMetricsFromCounts(counts) {
  const requiredPrecisionDenominator = counts.requiredMatchedCount + counts.extraFalsePositives;
  const requiredPrecision = ratio(counts.requiredMatchedCount, requiredPrecisionDenominator);
  const requiredRecall = ratio(counts.requiredMatchedCount, counts.requiredGoldCount);
  const overallPrecision = ratio(counts.validMatchedCount, counts.allPredictedCount);
  const overallRecall = ratio(counts.requiredMatchedCount, counts.requiredGoldCount);
  return {
    required: {
      gold: counts.requiredGoldCount,
      predictedMatchedToRequired: counts.requiredMatchedCount,
      matched: counts.requiredMatchedCount,
      precision: requiredPrecision,
      recall: requiredRecall,
      f1: harmonic(requiredPrecision, requiredRecall),
    },
    acceptable: {
      gold: counts.acceptableGoldCount,
      predictedMatchedToAcceptable: counts.acceptableMatchedCount,
      matched: counts.acceptableMatchedCount,
    },
    extraFalsePositives: counts.extraFalsePositives,
    overall: {
      gold: counts.requiredGoldCount,
      predicted: counts.allPredictedCount,
      matched: counts.validMatchedCount,
      precision: overallPrecision,
      recall: overallRecall,
      f1: harmonic(overallPrecision, overallRecall),
    },
  };
}

function countsFromNodes(goldNodes, predictedNodes, pairs) {
  const requiredGoldCount = goldNodes.filter((item) => item.tier === 'required').length;
  const acceptableGoldCount = goldNodes.filter((item) => item.tier === 'acceptable').length;
  const requiredMatchedCount = pairs.filter((pair) => pair.gold.tier === 'required').length;
  const acceptableMatchedCount = pairs.filter((pair) => pair.gold.tier === 'acceptable').length;
  const validMatchedCount = requiredMatchedCount + acceptableMatchedCount;
  const allPredictedCount = predictedNodes.length;
  return {
    requiredGoldCount,
    acceptableGoldCount,
    allPredictedCount,
    requiredMatchedCount,
    acceptableMatchedCount,
    validMatchedCount,
    extraFalsePositives: allPredictedCount - validMatchedCount,
  };
}

function relationConfusion(goldNodes, predictedNodes, pairs) {
  const byRelation = Object.fromEntries(RELATIONS.map((relation) => [relation, { tp: 0, fp: 0, fn: 0 }]));
  const matchedGold = new Set(pairs.map((pair) => pair.goldItemId));
  const matchedPredicted = new Set(pairs.map((pair) => pair.localItemKey));

  for (const pair of pairs) {
    for (const relation of RELATIONS) {
      const expected = pair.gold.relations[relation];
      const actual = pair.predicted.relations[relation];
      for (const token of expected) {
        if (actual.has(token)) byRelation[relation].tp += 1;
        else byRelation[relation].fn += 1;
      }
      for (const token of actual) {
        if (!expected.has(token)) byRelation[relation].fp += 1;
      }
    }
  }

  for (const goldItem of goldNodes) {
    if (matchedGold.has(goldItem.goldItemId)) continue;
    if (goldItem.tier !== 'required') continue;
    for (const relation of RELATIONS) {
      byRelation[relation].fn += goldItem.relations[relation].size;
    }
  }
  for (const predictedItem of predictedNodes) {
    if (matchedPredicted.has(predictedItem.localItemKey)) continue;
    for (const relation of RELATIONS) {
      byRelation[relation].fp += predictedItem.relations[relation].size;
    }
  }

  const metrics = Object.fromEntries(
    RELATIONS.map((relation) => {
      const { tp, fp, fn } = byRelation[relation];
      return [relation, evidenceMetric(tp, fp, fn)];
    }),
  );
  const totals = RELATIONS.reduce(
    (acc, relation) => ({
      tp: acc.tp + byRelation[relation].tp,
      fp: acc.fp + byRelation[relation].fp,
      fn: acc.fn + byRelation[relation].fn,
    }),
    { tp: 0, fp: 0, fn: 0 },
  );
  return { overall: evidenceMetric(totals.tp, totals.fp, totals.fn), byRelation: metrics };
}

function observationMapFromGold(entry) {
  const map = new Map();
  const ids = entry.supportMessageIds ?? [];
  const types = entry.supportTypes ?? [];
  const keys = entry.episodeKeys ?? [];
  for (let index = 0; index < ids.length; index += 1) {
    if (types[index] !== 'episode_observation') continue;
    map.set(ids[index], keys[index]);
  }
  return map;
}

function observationMapFromPredicted(predictedItem) {
  const map = new Map();
  for (const entry of predictedItem.evidence) {
    if (entry.relation !== 'supports') continue;
    if (entry.supportType !== 'episode_observation') continue;
    if (typeof entry.episodeKey !== 'string') return null;
    map.set(entry.sourceMessageId, entry.episodeKey);
  }
  return map;
}

function episodePartitionsEquivalent(expected, actual) {
  if (!actual || actual.size !== expected.size) return false;
  const ids = [...expected.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    if (!actual.has(ids[i])) return false;
    for (let j = i + 1; j < ids.length; j += 1) {
      const goldSame = expected.get(ids[i]) === expected.get(ids[j]);
      const predictedSame = actual.get(ids[i]) === actual.get(ids[j]);
      if (goldSame !== predictedSame) return false;
    }
  }
  return true;
}

function recurrenceEpisodeMetrics(goldNodes, pairs) {
  const pairByGold = new Map(pairs.map((pair) => [pair.goldItemId, pair.predicted]));
  let eligible = 0;
  let exact = 0;
  for (const goldItem of goldNodes) {
    if (goldItem.kind !== 'recurrence' || goldItem.tier !== 'required') continue;
    const expected = observationMapFromGold(goldItem.entry);
    if (expected.size < 2) continue;
    eligible += 1;
    const predicted = pairByGold.get(goldItem.goldItemId);
    if (!predicted) continue;
    const actual = observationMapFromPredicted(predicted);
    if (episodePartitionsEquivalent(expected, actual)) exact += 1;
  }
  return { eligible, exact, accuracy: ratio(exact, eligible) };
}

export function evaluateCaseV2(caseData, extraction) {
  const validatedCase = validateCaseV2(caseData);
  const validatedExtraction = validateExtractionV2(extraction, validatedCase);
  const goldList = goldItemsV2(validatedCase);
  const goldNodes = goldList.map((item) => ({
    goldItemId: item.goldItemId,
    tier: item.tier,
    kind: item.kind,
    relations: relationSetsFromGold(item.kind, item.entry),
    entry: item.entry,
  }));
  const predictedNodes = validatedExtraction.items.map((item) => ({
    localItemKey: item.localItemKey,
    kind: item.kind,
    relations: relationSetsFromPredicted(item.kind, item.localItemKey, validatedExtraction.evidence),
    evidence: validatedExtraction.evidence.filter((entry) => entry.itemKey === item.localItemKey),
  }));
  const assigned = assignPredictedToGoldV2({
    goldItems: goldNodes,
    predictedItems: predictedNodes,
  });
  const counts = countsFromNodes(goldNodes, predictedNodes, assigned.pairs);
  return {
    caseId: validatedCase.caseId,
    items: itemMetricsFromCounts(counts),
    evidence: relationConfusion(goldNodes, predictedNodes, assigned.pairs),
    recurrenceEpisodes: recurrenceEpisodeMetrics(goldNodes, assigned.pairs),
    semanticClaims: { ...NOT_EVALUATED.semanticClaims },
    forbiddenClaims: { ...NOT_EVALUATED.forbiddenClaims },
    matches: assigned.pairs.map((pair) => ({
      goldItemId: pair.goldItemId,
      localItemKey: pair.localItemKey,
    })),
    predictedEvidence: validatedExtraction.evidence.map((entry) => ({
      itemKey: entry.itemKey,
      sourceMessageId: entry.sourceMessageId,
      relation: entry.relation,
      supportType: entry.supportType,
    })),
  };
}

function inspectOptions(options) {
  if (options === undefined) return {};
  const inspected = inspectRecordPartial(options, [], OPTIONS_OPTIONAL, 'options');
  if (
    Object.prototype.hasOwnProperty.call(inspected, 'extractorVersion') &&
    !isNonEmptyString(inspected.extractorVersion)
  ) {
    fail('options.extractorVersion is invalid');
  }
  return inspected;
}

function inspectExtractionAlignment(raw, path) {
  const projected = inspectRecord(raw, EXTRACTION_FIELDS, path);
  const run = inspectRecord(projected.run, RUN_FIELDS, `${path}.run`);
  if (!isNonEmptyString(run.caseId)) fail(`${path}.run.caseId is invalid`);
  if (!isNonEmptyString(run.extractorVersion)) fail(`${path}.run.extractorVersion is invalid`);
  return { caseId: run.caseId, extractorVersion: run.extractorVersion };
}

export function evaluateDatasetV2(dataset, extractions, options) {
  const inspectedOptions = inspectOptions(options);
  const inspectedDataset = inspectRecord(dataset, DATASET_FIELDS, 'dataset');
  if (!isNonEmptyString(inspectedDataset.datasetId)) fail('dataset.datasetId is invalid');
  if (!isNonEmptyString(inspectedDataset.version)) fail('dataset.version is invalid');
  const cases = inspectDenseArray(inspectedDataset.cases, 'dataset.cases');
  const caseIds = [];
  const seenCaseIds = new Set();
  for (let index = 0; index < cases.length; index += 1) {
    const path = `dataset.cases[${index}]`;
    const keys = inspectPlainObject(cases[index], path);
    if (!keys.includes('caseId')) fail(`${path}.caseId is missing`);
    const caseId = dataDescriptor(cases[index], 'caseId', `${path}.caseId`).value;
    if (!isNonEmptyString(caseId)) fail(`${path}.caseId is invalid`);
    if (seenCaseIds.has(caseId)) fail(`dataset contains duplicate caseId: ${caseId}`);
    seenCaseIds.add(caseId);
    caseIds.push(caseId);
  }

  const extractionList = inspectDenseArray(extractions, 'extractions');
  const extractionByCaseId = new Map();
  const observedVersions = new Set();
  for (let index = 0; index < extractionList.length; index += 1) {
    const aligned = inspectExtractionAlignment(extractionList[index], `extractions[${index}]`);
    if (extractionByCaseId.has(aligned.caseId)) {
      fail(`duplicate extraction caseId: ${aligned.caseId}`);
    }
    if (!seenCaseIds.has(aligned.caseId)) {
      fail(`unknown extraction caseId: ${aligned.caseId}`);
    }
    observedVersions.add(aligned.extractorVersion);
    extractionByCaseId.set(aligned.caseId, extractionList[index]);
  }
  for (const caseId of caseIds) {
    if (!extractionByCaseId.has(caseId)) fail(`missing extraction caseId: ${caseId}`);
  }
  if (observedVersions.size > 1) fail('mixed extractorVersion values are not allowed');
  const observedVersion = observedVersions.values().next().value;
  if (
    inspectedOptions.extractorVersion !== undefined &&
    observedVersion !== undefined &&
    inspectedOptions.extractorVersion !== observedVersion
  ) {
    fail('extractorVersion mismatch');
  }
  const extractorVersion =
    inspectedOptions.extractorVersion ?? observedVersion ?? 'offline-unversioned';

  const caseReports = cases.map((caseData) =>
    evaluateCaseV2(caseData, extractionByCaseId.get(caseData.caseId)),
  );

  const totals = caseReports.reduce(
    (acc, report) => ({
      requiredGoldCount: acc.requiredGoldCount + report.items.required.gold,
      requiredMatchedCount: acc.requiredMatchedCount + report.items.required.matched,
      acceptableGoldCount: acc.acceptableGoldCount + report.items.acceptable.gold,
      acceptableMatchedCount: acc.acceptableMatchedCount + report.items.acceptable.matched,
      validMatchedCount: acc.validMatchedCount + report.items.overall.matched,
      allPredictedCount: acc.allPredictedCount + report.items.overall.predicted,
      extraFalsePositives: acc.extraFalsePositives + report.items.extraFalsePositives,
      evidenceTp: acc.evidenceTp + report.evidence.overall.tp,
      evidenceFp: acc.evidenceFp + report.evidence.overall.fp,
      evidenceFn: acc.evidenceFn + report.evidence.overall.fn,
      episodeEligible: acc.episodeEligible + report.recurrenceEpisodes.eligible,
      episodeExact: acc.episodeExact + report.recurrenceEpisodes.exact,
      evidenceByRelation: Object.fromEntries(
        RELATIONS.map((relation) => [
          relation,
          {
            tp: acc.evidenceByRelation[relation].tp + report.evidence.byRelation[relation].tp,
            fp: acc.evidenceByRelation[relation].fp + report.evidence.byRelation[relation].fp,
            fn: acc.evidenceByRelation[relation].fn + report.evidence.byRelation[relation].fn,
          },
        ]),
      ),
    }),
    {
      requiredGoldCount: 0,
      requiredMatchedCount: 0,
      acceptableGoldCount: 0,
      acceptableMatchedCount: 0,
      validMatchedCount: 0,
      allPredictedCount: 0,
      extraFalsePositives: 0,
      evidenceTp: 0,
      evidenceFp: 0,
      evidenceFn: 0,
      episodeEligible: 0,
      episodeExact: 0,
      evidenceByRelation: Object.fromEntries(
        RELATIONS.map((relation) => [relation, { tp: 0, fp: 0, fn: 0 }]),
      ),
    },
  );

  return {
    datasetId: inspectedDataset.datasetId,
    datasetVersion: inspectedDataset.version,
    extractorVersion,
    semanticClaims: { ...NOT_EVALUATED.semanticClaims },
    forbiddenClaims: { ...NOT_EVALUATED.forbiddenClaims },
    cases: caseReports,
    aggregate: {
      items: itemMetricsFromCounts(totals),
      evidence: {
        overall: evidenceMetric(totals.evidenceTp, totals.evidenceFp, totals.evidenceFn),
        byRelation: Object.fromEntries(
          RELATIONS.map((relation) => {
            const counts = totals.evidenceByRelation[relation];
            return [relation, evidenceMetric(counts.tp, counts.fp, counts.fn)];
          }),
        ),
      },
      recurrenceEpisodes: {
        eligible: totals.episodeEligible,
        exact: totals.episodeExact,
        accuracy: ratio(totals.episodeExact, totals.episodeEligible),
      },
      semanticClaims: { ...NOT_EVALUATED.semanticClaims },
      forbiddenClaims: { ...NOT_EVALUATED.forbiddenClaims },
    },
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdownReportV2(report) {
  const lines = [
    `# Memory V3 V2 structural evaluation — ${report.datasetId}`,
    '',
    `- Dataset version: ${report.datasetVersion}`,
    `- Extractor version: ${report.extractorVersion}`,
    `- Semantic claims: ${report.semanticClaims.status}`,
    `- Forbidden claims: ${report.forbiddenClaims.status}`,
    '- Privacy: report contains case ids and metrics only; no raw dialogue text',
    '',
    '## Aggregate',
    '',
    '### Required',
    '',
    `- Precision: ${percent(report.aggregate.items.required.precision)}`,
    `- Recall: ${percent(report.aggregate.items.required.recall)}`,
    `- F1: ${percent(report.aggregate.items.required.f1)}`,
    '',
    '### Acceptable',
    '',
    `- Gold: ${report.aggregate.items.acceptable.gold}`,
    `- Matched: ${report.aggregate.items.acceptable.matched}`,
    '',
    '### Overall',
    '',
    `- Precision: ${percent(report.aggregate.items.overall.precision)}`,
    `- Recall: ${percent(report.aggregate.items.overall.recall)}`,
    `- F1: ${percent(report.aggregate.items.overall.f1)}`,
    `- Extra false positives: ${report.aggregate.items.extraFalsePositives}`,
    '',
    '### Evidence',
    '',
    `- TP: ${report.aggregate.evidence.overall.tp}`,
    `- FP: ${report.aggregate.evidence.overall.fp}`,
    `- FN: ${report.aggregate.evidence.overall.fn}`,
    `- F1: ${percent(report.aggregate.evidence.overall.f1)}`,
    '',
    '## Cases',
    '',
    '| Case ID | Required F1 | Overall F1 | Extra FP |',
    '|---|---:|---:|---:|',
  ];
  for (const caseReport of report.cases) {
    lines.push(
      `| ${caseReport.caseId} | ${percent(caseReport.items.required.f1)} | ${percent(caseReport.items.overall.f1)} | ${caseReport.items.extraFalsePositives} |`,
    );
  }
  lines.push('', '## Predicted evidence', '');
  lines.push('| Case ID | itemKey | sourceMessageId | relation | supportType |');
  lines.push('|---|---|---|---|---|');
  for (const caseReport of report.cases) {
    for (const entry of caseReport.predictedEvidence ?? []) {
      const supportType = entry.supportType === null ? 'null' : String(entry.supportType);
      lines.push(
        `| ${caseReport.caseId} | ${entry.itemKey} | ${entry.sourceMessageId} | ${entry.relation} | ${supportType} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
