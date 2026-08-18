import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { validateCase } from './contracts.mjs';

const DATASET_URL = new URL('./memory-v3-ru-golden.v1.json', import.meta.url);
const CATEGORY_MINIMUMS = Object.freeze({
  event: 4,
  recurrence: 4,
  hypothesis: 4,
  correction: 4,
  counterexample: 4,
  safety: 4,
});

async function loadDataset() {
  return JSON.parse(await readFile(DATASET_URL, 'utf8'));
}

function allGoldEntries(caseData) {
  return [
    ...caseData.gold.events,
    ...caseData.gold.recurrences,
    ...caseData.gold.hypotheses,
  ];
}

describe('Memory V3 Russian golden dataset', () => {
  it('contains 24 synthetic cases with balanced behavioral coverage', async () => {
    const dataset = await loadDataset();

    assert.equal(dataset.datasetId, 'memory-v3-ru-golden-v1');
    assert.equal(dataset.version, '1.0.0');
    assert.equal(dataset.language, 'ru');
    assert.equal(dataset.privacy, 'synthetic-only');
    assert.equal(dataset.cases.length, 24);

    const ids = new Set();
    const categoryCounts = new Map();
    for (const caseData of dataset.cases) {
      assert.match(caseData.caseId, /^memv3-ru-[a-z]+-\d{2}$/);
      assert.equal(ids.has(caseData.caseId), false, `duplicate caseId ${caseData.caseId}`);
      ids.add(caseData.caseId);
      assert.equal(typeof caseData.title, 'string');
      assert.ok(caseData.title.trim().length > 0);
      assert.ok(Object.hasOwn(CATEGORY_MINIMUMS, caseData.category));
      assert.ok(Array.isArray(caseData.mustNotRemember));
      const messageIds = new Set(caseData.messages.map((message) => message.id));
      for (const exclusion of caseData.mustNotRemember) {
        assert.equal(typeof exclusion.claim, 'string');
        assert.ok(exclusion.claim.trim().length > 0);
        assert.equal(typeof exclusion.reason, 'string');
        assert.ok(exclusion.reason.trim().length > 0);
        assert.ok(Array.isArray(exclusion.sourceMessageIds));
        assert.ok(exclusion.sourceMessageIds.length > 0);
        for (const sourceId of exclusion.sourceMessageIds) {
          assert.ok(messageIds.has(sourceId), `${caseData.caseId}: unknown exclusion source ${sourceId}`);
        }
      }
      categoryCounts.set(caseData.category, (categoryCounts.get(caseData.category) ?? 0) + 1);
      assert.doesNotThrow(() => validateCase(caseData), caseData.caseId);
    }

    for (const [category, minimum] of Object.entries(CATEGORY_MINIMUMS)) {
      assert.ok(
        (categoryCounts.get(category) ?? 0) >= minimum,
        `${category} must have at least ${minimum} cases`,
      );
    }
  });

  it('uses only local fixture ids and user messages as positive gold evidence', async () => {
    const dataset = await loadDataset();

    for (const caseData of dataset.cases) {
      const messageById = new Map(caseData.messages.map((message) => [message.id, message]));
      for (const message of caseData.messages) {
        assert.match(message.id, /^m\d+$/);
        assert.doesNotMatch(message.text, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
        assert.doesNotMatch(message.text, /(?:sk-|eyJ)[A-Za-z0-9._-]{12,}/);
      }

      for (const entry of allGoldEntries(caseData)) {
        for (const sourceId of entry.supportMessageIds ?? []) {
          assert.equal(
            messageById.get(sourceId)?.role,
            'user',
            `${caseData.caseId}: positive evidence ${sourceId} must be user-authored`,
          );
        }
      }
    }
  });

  it('keeps recurrences multi-episode and hypotheses explicitly uncertain', async () => {
    const dataset = await loadDataset();

    for (const caseData of dataset.cases) {
      for (const recurrence of caseData.gold.recurrences) {
        assert.ok(recurrence.supportMessageIds.length >= 2, caseData.caseId);
        assert.equal(recurrence.supportMessageIds.length, recurrence.episodeKeys.length);
        assert.equal(new Set(recurrence.supportMessageIds).size, recurrence.supportMessageIds.length);
        assert.ok(new Set(recurrence.episodeKeys).size >= 2, caseData.caseId);
      }
      for (const hypothesis of caseData.gold.hypotheses) {
        assert.equal(typeof hypothesis.alternative, 'string');
        assert.ok(hypothesis.alternative.trim().length > 0, caseData.caseId);
        assert.equal(hypothesis.mustNotBeFact, true, caseData.caseId);
      }
    }
  });

  it('covers long time spans, corrections, contradictions, and memory abstention', async () => {
    const dataset = await loadDataset();
    const timestamps = dataset.cases.flatMap((caseData) =>
      caseData.messages.map((message) => Date.parse(message.createdAt)),
    );
    const spanDays = (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000;

    assert.ok(spanDays >= 365, 'dataset must exercise memory across at least one year');
    assert.ok(dataset.cases.some((caseData) => caseData.gold.events.some((event) => (event.correctedMessageIds ?? []).length > 0)));
    assert.ok(dataset.cases.some((caseData) => caseData.gold.hypotheses.some((hypothesis) => (hypothesis.contradictedMessageIds ?? []).length > 0)));
    assert.ok(dataset.cases.filter((caseData) => caseData.mustNotRemember.length > 0).length >= 8);
    assert.ok(dataset.cases.some((caseData) => caseData.gold.events.length === 0 && caseData.gold.recurrences.length === 0 && caseData.gold.hypotheses.length === 0));
  });
});
