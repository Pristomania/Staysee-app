import { validateCase, validateExtraction } from './contracts.mjs';

const KINDS = Object.freeze(['event', 'recurrence', 'hypothesis']);
const RELATIONS = Object.freeze(['supports', 'corrects', 'contradicts', 'rejects']);
const GOLD_LIST_BY_KIND = Object.freeze({
  event: 'events',
  recurrence: 'recurrences',
  hypothesis: 'hypotheses',
});
const GOLD_IDS_BY_RELATION = Object.freeze({
  supports: 'supportMessageIds',
  corrects: 'correctedMessageIds',
  contradicts: 'contradictedMessageIds',
  rejects: 'rejectedMessageIds',
});

function fail(message) {
  throw new Error(message);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function classificationMetric(gold, predicted, matched) {
  const precision = ratio(matched, predicted);
  const recall = ratio(matched, gold);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { gold, predicted, matched, precision, recall, f1 };
}

function evidenceMetric(tp, fp, fn) {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function accuracyMetric(eligible, exact) {
  return { eligible, exact, accuracy: ratio(exact, eligible) };
}

function relationSetsFromGold(entry) {
  return Object.fromEntries(
    RELATIONS.map((relation) => [
      relation,
      new Set(entry[GOLD_IDS_BY_RELATION[relation]] ?? []),
    ]),
  );
}

function relationSetsFromPrediction(itemKey, evidence) {
  const result = Object.fromEntries(RELATIONS.map((relation) => [relation, new Set()]));
  for (const entry of evidence) {
    if (entry.itemKey === itemKey) result[entry.relation].add(entry.sourceMessageId);
  }
  return result;
}

function flattenRelations(relationSets) {
  const result = new Set();
  for (const relation of RELATIONS) {
    for (const sourceId of relationSets[relation]) result.add(`${relation}\0${sourceId}`);
  }
  return result;
}

function setOverlapScore(left, right) {
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  if (intersection === 0) return 0;
  return (2 * intersection) / (left.size + right.size);
}

function goldItems(caseData) {
  return KINDS.flatMap((kind) =>
    caseData.gold[GOLD_LIST_BY_KIND[kind]].map((entry, index) => ({
      kind,
      index,
      entry,
      relations: relationSetsFromGold(entry),
    })),
  );
}

function predictedItems(extraction) {
  return extraction.items.map((entry, index) => ({
    kind: entry.kind,
    index,
    entry,
    evidence: extraction.evidence.filter(
      (evidenceEntry) => evidenceEntry.itemKey === entry.localItemKey,
    ),
    relations: relationSetsFromPrediction(entry.localItemKey, extraction.evidence),
  }));
}

function compareAssignments(left, right) {
  if (left.matched !== right.matched) return left.matched - right.matched;
  if (left.score !== right.score) return left.score - right.score;
  const leftKey = left.pairs.map((pair) => `${pair.gold.index}:${pair.predicted.index}`).join('|');
  const rightKey = right.pairs.map((pair) => `${pair.gold.index}:${pair.predicted.index}`).join('|');
  return rightKey.localeCompare(leftKey);
}

function bestPairsForKind(gold, predicted) {
  const candidates = gold.map((goldItem) =>
    predicted
      .map((predictedItem) => ({
        predicted: predictedItem,
        supportOverlap: setOverlapScore(
          goldItem.relations.supports,
          predictedItem.relations.supports,
        ),
        score: setOverlapScore(
          flattenRelations(goldItem.relations),
          flattenRelations(predictedItem.relations),
        ),
      }))
      .filter((candidate) => candidate.supportOverlap > 0 && candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.predicted.index - b.predicted.index),
  );

  let best = { matched: 0, score: 0, pairs: [] };
  const usedPredicted = new Set();

  function visit(goldIndex, pairs, score) {
    if (goldIndex === gold.length) {
      const candidate = { matched: pairs.length, score, pairs: [...pairs] };
      if (compareAssignments(candidate, best) > 0) best = candidate;
      return;
    }

    visit(goldIndex + 1, pairs, score);
    for (const candidate of candidates[goldIndex]) {
      if (usedPredicted.has(candidate.predicted.index)) continue;
      usedPredicted.add(candidate.predicted.index);
      pairs.push({
        gold: gold[goldIndex],
        predicted: candidate.predicted,
        score: candidate.score,
      });
      visit(goldIndex + 1, pairs, score + candidate.score);
      pairs.pop();
      usedPredicted.delete(candidate.predicted.index);
    }
  }

  visit(0, [], 0);
  return best.pairs;
}

function matchItems(gold, predicted) {
  return KINDS.flatMap((kind) =>
    bestPairsForKind(
      gold.filter((entry) => entry.kind === kind),
      predicted.filter((entry) => entry.kind === kind),
    ),
  );
}

function relationConfusion(gold, predicted, pairs) {
  const byRelation = Object.fromEntries(
    RELATIONS.map((relation) => [relation, { tp: 0, fp: 0, fn: 0 }]),
  );
  const matchedGold = new Set(pairs.map((pair) => `${pair.gold.kind}:${pair.gold.index}`));
  const matchedPredicted = new Set(pairs.map((pair) => pair.predicted.index));

  for (const pair of pairs) {
    for (const relation of RELATIONS) {
      const expected = pair.gold.relations[relation];
      const actual = pair.predicted.relations[relation];
      for (const sourceId of expected) {
        if (actual.has(sourceId)) byRelation[relation].tp += 1;
        else byRelation[relation].fn += 1;
      }
      for (const sourceId of actual) {
        if (!expected.has(sourceId)) byRelation[relation].fp += 1;
      }
    }
  }

  for (const goldItem of gold) {
    if (matchedGold.has(`${goldItem.kind}:${goldItem.index}`)) continue;
    for (const relation of RELATIONS) byRelation[relation].fn += goldItem.relations[relation].size;
  }
  for (const predictedItem of predicted) {
    if (matchedPredicted.has(predictedItem.index)) continue;
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

function itemMetrics(gold, predicted, pairs) {
  const byKind = Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      classificationMetric(
        gold.filter((entry) => entry.kind === kind).length,
        predicted.filter((entry) => entry.kind === kind).length,
        pairs.filter((entry) => entry.gold.kind === kind).length,
      ),
    ]),
  );
  return {
    overall: classificationMetric(gold.length, predicted.length, pairs.length),
    byKind,
  };
}

function dateMetrics(gold, pairs) {
  const eligibleGold = gold.filter(
    (entry) =>
      entry.kind === 'event' &&
      (entry.entry.eventTimeStart !== undefined || entry.entry.eventTimeEnd !== undefined),
  );
  const pairByGold = new Map(
    pairs.map((pair) => [`${pair.gold.kind}:${pair.gold.index}`, pair.predicted.entry]),
  );
  let exact = 0;
  for (const goldItem of eligibleGold) {
    const predicted = pairByGold.get(`${goldItem.kind}:${goldItem.index}`);
    if (!predicted) continue;
    const startMatches =
      (predicted.eventTimeStart ?? null) === (goldItem.entry.eventTimeStart ?? null);
    const endMatches =
      (predicted.eventTimeEnd ?? null) === (goldItem.entry.eventTimeEnd ?? null);
    if (startMatches && endMatches) exact += 1;
  }
  return accuracyMetric(eligibleGold.length, exact);
}

function predictedSupportEpisodes(predicted, expected) {
  const actual = new Map();
  for (const sourceId of expected.keys()) {
    const evidenceEntry = predicted.evidence.find(
      (entry) => entry.relation === 'supports' && entry.sourceMessageId === sourceId,
    );
    if (!evidenceEntry || typeof evidenceEntry.episodeKey !== 'string') return null;
    actual.set(sourceId, evidenceEntry.episodeKey);
  }
  return actual;
}

function episodePartitionsEquivalent(expected, actual) {
  if (!actual || actual.size !== expected.size) return false;
  const ids = [...expected.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = ids[i];
      const right = ids[j];
      const goldSame = expected.get(left) === expected.get(right);
      const predictedSame = actual.get(left) === actual.get(right);
      if (goldSame !== predictedSame) return false;
    }
  }
  return true;
}

function recurrenceEpisodeMetrics(gold, pairs) {
  const recurrences = gold.filter((entry) => entry.kind === 'recurrence');
  const pairByGold = new Map(
    pairs.map((pair) => [`${pair.gold.kind}:${pair.gold.index}`, pair.predicted]),
  );
  let exact = 0;

  for (const goldItem of recurrences) {
    const predicted = pairByGold.get(`${goldItem.kind}:${goldItem.index}`);
    if (!predicted) continue;
    const expected = new Map(
      goldItem.entry.supportMessageIds.map((sourceId, index) => [
        sourceId,
        goldItem.entry.episodeKeys[index],
      ]),
    );
    const actualSupports = predicted.relations.supports;
    if (actualSupports.size !== expected.size) continue;
    let sameSupportSet = true;
    for (const sourceId of expected.keys()) {
      if (!actualSupports.has(sourceId)) {
        sameSupportSet = false;
        break;
      }
    }
    if (!sameSupportSet) continue;
    if (episodePartitionsEquivalent(expected, predictedSupportEpisodes(predicted, expected))) {
      exact += 1;
    }
  }
  return accuracyMetric(recurrences.length, exact);
}

export function evaluateCase(caseData, extraction) {
  const validatedCase = validateCase(caseData);
  validateExtraction(extraction, validatedCase);

  const gold = goldItems(validatedCase);
  const predicted = predictedItems(extraction);
  const pairs = matchItems(gold, predicted);
  const report = {
    caseId: validatedCase.caseId,
    items: itemMetrics(gold, predicted, pairs),
    evidence: relationConfusion(gold, predicted, pairs),
    dates: dateMetrics(gold, pairs),
    recurrenceEpisodes: recurrenceEpisodeMetrics(gold, pairs),
    abstention: {
      expected: gold.length === 0,
      passed: gold.length === 0 ? predicted.length === 0 : null,
      falsePositiveItems: gold.length === 0 ? predicted.length : 0,
    },
    semanticClaims: {
      status: 'not_evaluated',
      reason: 'Structural evaluator does not judge paraphrase meaning',
    },
    forbiddenClaims: {
      status: 'not_evaluated',
      reason: 'Structural evaluator cannot judge mustNotRemember claims by meaning',
    },
    matches: pairs.map((pair) => ({
      kind: pair.gold.kind,
      goldIndex: pair.gold.index,
      predictedItemKey: pair.predicted.entry.localItemKey,
      evidenceF1: pair.score,
    })),
  };
  return report;
}

function sumClassification(reports, selector) {
  const totals = reports.reduce(
    (acc, report) => {
      const metric = selector(report);
      return {
        gold: acc.gold + metric.gold,
        predicted: acc.predicted + metric.predicted,
        matched: acc.matched + metric.matched,
      };
    },
    { gold: 0, predicted: 0, matched: 0 },
  );
  return classificationMetric(totals.gold, totals.predicted, totals.matched);
}

function sumEvidence(reports, selector) {
  const totals = reports.reduce(
    (acc, report) => {
      const metric = selector(report);
      return { tp: acc.tp + metric.tp, fp: acc.fp + metric.fp, fn: acc.fn + metric.fn };
    },
    { tp: 0, fp: 0, fn: 0 },
  );
  return evidenceMetric(totals.tp, totals.fp, totals.fn);
}

function aggregateReports(reports) {
  const itemByKind = Object.fromEntries(
    KINDS.map((kind) => [kind, sumClassification(reports, (report) => report.items.byKind[kind])]),
  );
  const evidenceByRelation = Object.fromEntries(
    RELATIONS.map((relation) => [
      relation,
      sumEvidence(reports, (report) => report.evidence.byRelation[relation]),
    ]),
  );
  const dates = reports.reduce(
    (acc, report) => ({ eligible: acc.eligible + report.dates.eligible, exact: acc.exact + report.dates.exact }),
    { eligible: 0, exact: 0 },
  );
  const episodes = reports.reduce(
    (acc, report) => ({
      eligible: acc.eligible + report.recurrenceEpisodes.eligible,
      exact: acc.exact + report.recurrenceEpisodes.exact,
    }),
    { eligible: 0, exact: 0 },
  );
  const abstention = reports.reduce(
    (acc, report) => ({
      expected: acc.expected + (report.abstention.expected ? 1 : 0),
      passed: acc.passed + (report.abstention.passed ? 1 : 0),
      falsePositiveItems: acc.falsePositiveItems + report.abstention.falsePositiveItems,
    }),
    { expected: 0, passed: 0, falsePositiveItems: 0 },
  );
  return {
    items: { overall: sumClassification(reports, (report) => report.items.overall), byKind: itemByKind },
    evidence: { overall: sumEvidence(reports, (report) => report.evidence.overall), byRelation: evidenceByRelation },
    dates: accuracyMetric(dates.eligible, dates.exact),
    recurrenceEpisodes: accuracyMetric(episodes.eligible, episodes.exact),
    abstention: { ...abstention, accuracy: ratio(abstention.passed, abstention.expected) },
    semanticClaims: {
      status: 'not_evaluated',
      reason: 'Structural evaluator does not judge paraphrase meaning',
    },
    forbiddenClaims: {
      status: 'not_evaluated',
      reason: 'Structural evaluator cannot judge mustNotRemember claims by meaning',
    },
  };
}

export function evaluateDataset(dataset, extractions, options = {}) {
  if (!dataset || typeof dataset !== 'object' || !Array.isArray(dataset.cases)) {
    fail('dataset.cases must be an array');
  }
  if (!Array.isArray(extractions)) fail('extractions must be an array');
  const caseById = new Map(dataset.cases.map((caseData) => [caseData.caseId, caseData]));
  if (caseById.size !== dataset.cases.length) fail('dataset contains duplicate caseId');

  const observedVersions = new Set(
    extractions.map((extraction) => extraction?.run?.extractorVersion),
  );
  if (observedVersions.size > 1) fail('mixed extractorVersion values are not allowed');
  const observedVersion = observedVersions.values().next().value;
  const extractorVersion =
    options.extractorVersion ?? observedVersion ?? 'offline-unversioned';

  const extractionByCaseId = new Map();
  for (const extraction of extractions) {
    const caseId = extraction?.run?.caseId;
    if (extractionByCaseId.has(caseId)) fail(`duplicate extraction caseId: ${String(caseId)}`);
    if (!caseById.has(caseId)) fail(`unknown extraction caseId: ${String(caseId)}`);
    if (
      options.extractorVersion &&
      extraction.run.extractorVersion !== options.extractorVersion
    ) {
      fail(`extractorVersion mismatch for caseId ${caseId}`);
    }
    extractionByCaseId.set(caseId, extraction);
  }

  const cases = dataset.cases.map((caseData) =>
    evaluateCase(
      caseData,
      extractionByCaseId.get(caseData.caseId) ?? {
        run: { caseId: caseData.caseId, extractorVersion },
        items: [],
        evidence: [],
      },
    ),
  );
  return {
    datasetId: dataset.datasetId,
    datasetVersion: dataset.version,
    extractorVersion,
    semanticClaims: {
      status: 'not_evaluated',
      reason: 'Structural evaluator does not judge paraphrase meaning',
    },
    forbiddenClaims: {
      status: 'not_evaluated',
      reason: 'Structural evaluator cannot judge mustNotRemember claims by meaning',
    },
    cases,
    aggregate: aggregateReports(cases),
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdownReport(report) {
  const lines = [
    `# Memory V3 structural evaluation — ${report.datasetId}`,
    '',
    `- Dataset version: ${report.datasetVersion}`,
    `- Extractor version: ${report.extractorVersion}`,
    '- Semantic claims: NOT EVALUATED',
    '- Forbidden claims: NOT EVALUATED',
    '- Privacy: report contains case ids and metrics only; no raw dialogue text',
    '',
    '## Aggregate',
    '',
    `- Item F1: ${percent(report.aggregate.items.overall.f1)}`,
    `- Evidence F1: ${percent(report.aggregate.evidence.overall.f1)}`,
    `- Event-time accuracy: ${percent(report.aggregate.dates.accuracy)}`,
    `- Recurrence episode accuracy: ${percent(report.aggregate.recurrenceEpisodes.accuracy)}`,
    `- Gold-empty abstention accuracy: ${percent(report.aggregate.abstention.accuracy)}`,
    '',
    '## Cases',
    '',
    '| Case ID | Item F1 | Evidence F1 | Abstention |',
    '|---|---:|---:|---|',
  ];
  for (const caseReport of report.cases) {
    const abstention = caseReport.abstention.expected
      ? caseReport.abstention.passed
        ? 'PASS'
        : 'FAIL'
      : 'n/a';
    lines.push(
      `| ${caseReport.caseId} | ${percent(caseReport.items.overall.f1)} | ${percent(caseReport.evidence.overall.f1)} | ${abstention} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
