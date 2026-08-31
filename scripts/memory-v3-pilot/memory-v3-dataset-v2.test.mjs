/**
 * Memory V3 V2 golden dataset tests.
 * Reads frozen V1 and proposed V2. No network, provider, env, or file writes.
 * Run: node --test scripts/memory-v3-pilot/memory-v3-dataset-v2.test.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { canonicalStringify, validateCase } from './contracts.mjs';
import { goldItemsV2, validateCaseV2 } from './contracts-v2.mjs';

const V1_URL = new URL('./memory-v3-ru-golden.v1.json', import.meta.url);
const V2_URL = new URL('./memory-v3-ru-golden.v2.json', import.meta.url);
const EXPECTED_GOLD_MANIFEST_SHA256 =
  'C5207B12DA69A362A227E150372AA271287CBDB21CEE0B6C41C637D17DE1EC07';
const EMPTY_REQUIRED_CASE_IDS = Object.freeze([
  'memv3-ru-counterexample-02',
  'memv3-ru-counterexample-03',
  'memv3-ru-safety-01',
  'memv3-ru-safety-03',
  'memv3-ru-safety-04',
]);
const TIERS = Object.freeze(['required', 'acceptable']);
const KIND_LISTS = Object.freeze(['events', 'recurrences', 'hypotheses']);
const KIND_BY_LIST = Object.freeze({
  events: 'event',
  recurrences: 'recurrence',
  hypotheses: 'hypothesis',
});

async function loadJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

function goldManifestFingerprint(dataset) {
  const projection = dataset.cases.map(({ caseId, gold }) => ({ caseId, gold }));
  const canonical = canonicalStringify(projection);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toUpperCase();
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(['length', ...value.map((_, index) => String(index))]);
  return keys.every((key) => allowed.has(key));
}

function goldEntries(caseData, tier) {
  return KIND_LISTS.flatMap((listName) =>
    (caseData.gold[tier][listName] ?? []).map((entry) => ({
      listName,
      kind: KIND_BY_LIST[listName],
      entry,
    })),
  );
}

function allV2Gold(caseData) {
  return TIERS.flatMap((tier) => goldEntries(caseData, tier).map((row) => ({ tier, ...row })));
}

function countByKind(rows, kind) {
  return rows.filter((row) => row.kind === kind).length;
}

describe('Memory V3 Russian golden dataset V2', () => {
  it('matches dataset identity, dense unique cases, and V1/V2 validation', async () => {
    const v1 = await loadJson(V1_URL);
    const v1Snapshot = structuredClone(v1);
    const v2 = await loadJson(V2_URL);

    assert.equal(v2.datasetId, 'memory-v3-ru-golden-v2');
    assert.equal(v2.version, '2.0.0');
    assert.equal(v2.language, 'ru');
    assert.equal(v2.privacy, 'synthetic-only');
    assert.equal(isDenseArray(v2.cases), true);
    assert.equal(v2.cases.length, 24);
    assert.deepEqual(
      v2.cases.map((caseData) => caseData.caseId),
      v1.cases.map((caseData) => caseData.caseId),
    );
    assert.equal(new Set(v2.cases.map((caseData) => caseData.caseId)).size, 24);

    for (const caseData of v1.cases) {
      assert.doesNotThrow(() => validateCase(caseData), caseData.caseId);
    }
    for (const caseData of v2.cases) {
      assert.doesNotThrow(() => validateCaseV2(caseData), caseData.caseId);
    }
    assert.deepEqual(v1, v1Snapshot);
  });

  it('copies title, category, messages, and mustNotRemember from frozen V1', async () => {
    const v1 = await loadJson(V1_URL);
    const v1Snapshot = structuredClone(v1);
    const v2 = await loadJson(V2_URL);
    const v2ById = new Map(v2.cases.map((caseData) => [caseData.caseId, caseData]));

    for (const v1Case of v1.cases) {
      const v2Case = v2ById.get(v1Case.caseId);
      assert.equal(v2Case !== undefined, true, v1Case.caseId);
      assert.deepEqual(v2Case.title, v1Case.title);
      assert.deepEqual(v2Case.category, v1Case.category);
      assert.deepEqual(v2Case.messages, v1Case.messages);
      assert.deepEqual(v2Case.mustNotRemember, v1Case.mustNotRemember);
    }
    assert.deepEqual(v1, v1Snapshot);
  });

  it('keeps required/acceptable gold structure and locked item totals', async () => {
    const v2 = await loadJson(V2_URL);
    const required = [];
    const acceptable = [];

    for (const caseData of v2.cases) {
      assert.deepEqual(Object.keys(caseData.gold).sort(), ['acceptable', 'required']);
      for (const tier of TIERS) {
        assert.deepEqual(Object.keys(caseData.gold[tier]).sort(), [
          'events',
          'hypotheses',
          'recurrences',
        ]);
      }
      const ids = new Set();
      for (const row of allV2Gold(caseData)) {
        assert.equal(ids.has(row.entry.goldItemId), false, `${caseData.caseId} ${row.entry.goldItemId}`);
        ids.add(row.entry.goldItemId);
        if (row.tier === 'required') required.push(row);
        else acceptable.push(row);
      }
      const ordered = goldItemsV2(caseData);
      const requiredCount = ordered.filter((item) => item.tier === 'required').length;
      assert.deepEqual(
        ordered.slice(0, requiredCount).map((item) => item.tier),
        Array.from({ length: requiredCount }, () => 'required'),
      );
      assert.deepEqual(
        ordered.slice(requiredCount).map((item) => item.tier),
        Array.from({ length: ordered.length - requiredCount }, () => 'acceptable'),
      );
    }

    assert.equal(required.length, 24);
    assert.equal(acceptable.length, 6);
    assert.equal(required.length + acceptable.length, 30);
    assert.equal(countByKind(required, 'event'), 15);
    assert.equal(countByKind(required, 'recurrence'), 4);
    assert.equal(countByKind(required, 'hypothesis'), 5);
    assert.equal(countByKind(acceptable, 'event'), 3);
    assert.equal(countByKind(acceptable, 'recurrence'), 3);
    assert.equal(countByKind(acceptable, 'hypothesis'), 0);

    const emptyRequired = v2.cases
      .filter((caseData) => goldEntries(caseData, 'required').length === 0)
      .map((caseData) => caseData.caseId);
    assert.deepEqual(emptyRequired, [...EMPTY_REQUIRED_CASE_IDS]);
  });

  it('keeps gold supports on existing user messages and typed recurrence rows valid', async () => {
    const v2 = await loadJson(V2_URL);
    for (const caseData of v2.cases) {
      const messageById = new Map(caseData.messages.map((message) => [message.id, message]));
      for (const row of allV2Gold(caseData)) {
        const supports = row.entry.supportMessageIds ?? [];
        for (const sourceId of supports) {
          assert.equal(messageById.has(sourceId), true, `${caseData.caseId} ${sourceId}`);
          assert.equal(messageById.get(sourceId).role, 'user', `${caseData.caseId} ${sourceId}`);
        }
        if (row.kind === 'recurrence') {
          assert.equal(row.entry.supportTypes.length, supports.length);
          assert.equal(row.entry.episodeKeys.length, supports.length);
          const observationKeys = new Set();
          row.entry.supportTypes.forEach((supportType, index) => {
            if (supportType === 'episode_observation') {
              assert.equal(typeof row.entry.episodeKeys[index], 'string');
              assert.ok(row.entry.episodeKeys[index].trim().length > 0);
              observationKeys.add(row.entry.episodeKeys[index]);
            } else {
              assert.equal(row.entry.episodeKeys[index], null);
            }
          });
          assert.ok(observationKeys.size >= 2, caseData.caseId);
        } else {
          assert.equal(Object.hasOwn(row.entry, 'supportTypes'), false, caseData.caseId);
          assert.equal(Object.hasOwn(row.entry, 'episodeKeys'), false, caseData.caseId);
        }
      }
    }
  });

  it('locks correction-04 required rejected hypothesis and acceptable bonus event', async () => {
    const v1 = await loadJson(V1_URL);
    const v2 = await loadJson(V2_URL);
    const v1Case = v1.cases.find((caseData) => caseData.caseId === 'memv3-ru-correction-04');
    const v2Case = v2.cases.find((caseData) => caseData.caseId === 'memv3-ru-correction-04');
    assert.equal(v1Case.gold.events.length, 0);
    assert.equal(v2Case.gold.required.hypotheses.length, 1);
    assert.equal(v2Case.gold.required.hypotheses[0].claim, v1Case.gold.hypotheses[0].claim);
    assert.deepEqual(v2Case.gold.required.hypotheses[0].rejectedMessageIds, ['m2']);
    assert.deepEqual(v2Case.gold.required.hypotheses[0].contradictedMessageIds, []);
    assert.equal(v2Case.gold.required.hypotheses[0].mustNotBeFact, true);
    assert.equal(v2Case.gold.acceptable.events.length, 1);
    assert.equal(v2Case.gold.acceptable.events[0].goldItemId, 'acceptable-event-01');
    assert.equal(
      v2Case.gold.acceptable.events[0].claim,
      'Сознательно остаётся на работе до выплаты годового бонуса',
    );
    assert.deepEqual(v2Case.gold.acceptable.events[0].supportMessageIds, ['m2']);
    assert.equal(v2Case.gold.required.events.length, 0);
  });

  it('locks recurrence-02 typed m4 pattern_confirmation', async () => {
    const v2 = await loadJson(V2_URL);
    const caseData = v2.cases.find((entry) => entry.caseId === 'memv3-ru-recurrence-02');
    assert.equal(caseData.gold.required.recurrences.length, 1);
    const recurrence = caseData.gold.required.recurrences[0];
    assert.deepEqual(recurrence.supportMessageIds, ['m1', 'm2', 'm4']);
    assert.deepEqual(recurrence.supportTypes, [
      'episode_observation',
      'episode_observation',
      'pattern_confirmation',
    ]);
    assert.deepEqual(recurrence.episodeKeys, ['episode:m1', 'episode:m2', null]);
  });

  it('locks correction-03 without assistant m1 correctedMessageIds', async () => {
    const v2 = await loadJson(V2_URL);
    const caseData = v2.cases.find((entry) => entry.caseId === 'memv3-ru-correction-03');
    assert.equal(caseData.gold.required.events.length, 1);
    assert.deepEqual(caseData.gold.required.events[0].correctedMessageIds, []);
    assert.equal(JSON.stringify(caseData).includes('"correctedMessageIds":["m1"]'), false);
  });

  it('locks hypothesis-01 acceptable observable recurrence', async () => {
    const v1 = await loadJson(V1_URL);
    const v2 = await loadJson(V2_URL);
    const v1Case = v1.cases.find((entry) => entry.caseId === 'memv3-ru-hypothesis-01');
    const v2Case = v2.cases.find((entry) => entry.caseId === 'memv3-ru-hypothesis-01');
    assert.equal(v2Case.gold.required.hypotheses.length, 1);
    assert.equal(v2Case.gold.required.hypotheses[0].claim, v1Case.gold.hypotheses[0].claim);
    assert.equal(v2Case.gold.acceptable.recurrences.length, 1);
    const recurrence = v2Case.gold.acceptable.recurrences[0];
    assert.equal(recurrence.goldItemId, 'acceptable-recurrence-01');
    assert.equal(recurrence.claim, 'В ситуациях страха или горя иногда реагирует шутками');
    assert.deepEqual(recurrence.supportMessageIds, ['m1', 'm2']);
    assert.deepEqual(recurrence.supportTypes, ['episode_observation', 'episode_observation']);
    assert.deepEqual(recurrence.episodeKeys, ['episode:m1', 'episode:m2']);
  });

  it('locks hypothesis-02 acceptable planning recurrence', async () => {
    const v2 = await loadJson(V2_URL);
    const caseData = v2.cases.find((entry) => entry.caseId === 'memv3-ru-hypothesis-02');
    assert.equal(caseData.gold.acceptable.recurrences.length, 1);
    const recurrence = caseData.gold.acceptable.recurrences[0];
    assert.equal(recurrence.goldItemId, 'acceptable-recurrence-01');
    assert.equal(
      recurrence.claim,
      'При бытовой неопределённости многократно перепроверяет планы и старается заранее перестроить расписание',
    );
    assert.deepEqual(recurrence.supportMessageIds, ['m1', 'm2']);
  });

  it('locks hypothesis-03 two sensitive acceptable events and no gold recurrence', async () => {
    const v2 = await loadJson(V2_URL);
    const caseData = v2.cases.find((entry) => entry.caseId === 'memv3-ru-hypothesis-03');
    assert.equal(caseData.gold.required.hypotheses.length, 1);
    assert.equal(caseData.gold.acceptable.events.length, 2);
    assert.equal(caseData.gold.acceptable.recurrences.length, 0);
    const first = caseData.gold.acceptable.events[0];
    const second = caseData.gold.acceptable.events[1];
    assert.equal(first.goldItemId, 'acceptable-event-01');
    assert.equal(first.claim, 'Полгода оплачивала родителям жильё, когда отец потерял работу');
    assert.equal(first.sensitivity, 'sensitive');
    assert.deepEqual(first.supportMessageIds, ['m1']);
    assert.equal(second.goldItemId, 'acceptable-event-02');
    assert.equal(
      second.claim,
      'После развода сестры взяла на себя её переезд, документы и заботу о ребёнке',
    );
    assert.equal(second.sensitivity, 'sensitive');
    assert.deepEqual(second.supportMessageIds, ['m2']);
    for (const event of [first, second]) {
      assert.equal(Object.hasOwn(event, 'supportTypes'), false);
      assert.equal(Object.hasOwn(event, 'episodeKeys'), false);
    }
  });

  it('locks hypothesis-04 acceptable recurrence and V1 attachment-style mustNotRemember', async () => {
    const v1 = await loadJson(V1_URL);
    const v2 = await loadJson(V2_URL);
    const v1Case = v1.cases.find((entry) => entry.caseId === 'memv3-ru-hypothesis-04');
    const v2Case = v2.cases.find((entry) => entry.caseId === 'memv3-ru-hypothesis-04');
    assert.equal(v2Case.gold.acceptable.recurrences.length, 1);
    const recurrence = v2Case.gold.acceptable.recurrences[0];
    assert.equal(recurrence.goldItemId, 'acceptable-recurrence-01');
    assert.equal(
      recurrence.claim,
      'После эпизодов усиления близости с партнёрами начинала увеличивать дистанцию',
    );
    assert.equal(recurrence.sensitivity, 'sensitive');
    assert.equal(
      v2Case.mustNotRemember.some(
        (entry) => entry.claim === 'У пользователя избегающий тип привязанности',
      ),
      true,
    );
    assert.deepEqual(v2Case.mustNotRemember, v1Case.mustNotRemember);
  });

  it('keeps empty required/acceptable gold on safety and counterexample locks', async () => {
    const v2 = await loadJson(V2_URL);
    const byId = new Map(v2.cases.map((caseData) => [caseData.caseId, caseData]));
    for (const caseId of [
      'memv3-ru-safety-03',
      'memv3-ru-counterexample-02',
      'memv3-ru-counterexample-03',
      'memv3-ru-safety-01',
      'memv3-ru-safety-04',
    ]) {
      const caseData = byId.get(caseId);
      assert.equal(goldEntries(caseData, 'required').length, 0, caseId);
      assert.equal(goldEntries(caseData, 'acceptable').length, 0, caseId);
    }
    assert.equal(byId.get('memv3-ru-recurrence-01').gold.required.events.length, 0);
    for (const caseData of v2.cases) {
      const goldClaims = new Set(allV2Gold(caseData).map((row) => row.entry.claim));
      for (const exclusion of caseData.mustNotRemember) {
        assert.equal(goldClaims.has(exclusion.claim), false, caseData.caseId);
      }
    }
  });

  it('stays synthetic-only without secrets, UUIDs, or production refs', async () => {
    const raw = await readFile(V2_URL, 'utf8');
    const v2 = JSON.parse(raw);
    assert.equal(v2.privacy, 'synthetic-only');
    assert.doesNotMatch(raw, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
    assert.doesNotMatch(raw, /(?:sk-|eyJ)[A-Za-z0-9._-]{12,}/);
    assert.doesNotMatch(raw, /supabase|production|staging/i);
    assert.doesNotMatch(raw, /@gmail\.com|Authorization:|OPENROUTER/i);
  });

  it('locks every authored V2 gold field with a canonical manifest fingerprint', async () => {
    const v2 = await loadJson(V2_URL);
    const snapshot = structuredClone(v2);
    assert.equal(goldManifestFingerprint(v2), EXPECTED_GOLD_MANIFEST_SHA256);

    const mutated = structuredClone(v2);
    const eventCase = mutated.cases.find((entry) => entry.caseId === 'memv3-ru-event-02');
    const requiredEvent = eventCase.gold.required.events.find(
      (entry) => entry.goldItemId === 'required-event-01',
    );
    requiredEvent.eventTimeStart = '2020-10-01';
    assert.doesNotThrow(() => validateCaseV2(eventCase));
    assert.notEqual(goldManifestFingerprint(mutated), EXPECTED_GOLD_MANIFEST_SHA256);
    assert.deepEqual(v2, snapshot);
  });

  it('documents V2 offline status, public identifiers, and later paid-authorization gate', async () => {
    const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
    const headingMatch = readme.match(/^#{1,3}[^\n]*Memory V3 V2[^\n]*$/m);
    assert.equal(headingMatch !== null, true, 'README is missing a Memory V3 V2 section');

    const headingStart = headingMatch.index;
    const headingLevel = headingMatch[0].match(/^#+/)[0].length;
    const afterHeading = readme.slice(headingStart + headingMatch[0].length);
    const nextHeading = afterHeading.match(new RegExp(`\\n#{1,${headingLevel}} `));
    const v2Raw = readme.slice(
      headingStart,
      headingStart + headingMatch[0].length + (nextHeading ? nextHeading.index : afterHeading.length),
    );
    const v2 = v2Raw.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');

    assert.equal(v2.includes('memory-v3-ru-golden-v2'), true);
    assert.equal(v2.includes('2.0.0'), true);
    assert.equal(v2.includes('live-benchmark-six-run-v2.mjs'), true);
    assert.equal(v2.includes('memory-v3-openrouter-luna-six-v2'), true);
    assert.equal(v2.includes('not production-ready'), true);
    assert.equal(v2.includes('--execute-six-paid-requests'), true);
    assert.equal(v2.includes('openai/gpt-5.6-luna'), true);
    assert.equal(v2.includes('--max-budget-usd 0.032'), true);
    assert.equal(
      v2.includes(
        'node scripts/memory-v3-pilot/live-benchmark-six-run-v2.mjs --model openai/gpt-5.6-luna --max-budget-usd 0.032',
      ),
      true,
    );
    assert.equal(v2.includes('node --test scripts/memory-v3-pilot/*.test.mjs'), true);
    assert.match(v2, /V1 frozen/);
    assert.match(v2, /V2 additive/);
    assert.match(v2, /Nastya/);
    assert.match(v2, /forbidden until a separate/);
    assert.match(v2, /V2 six-case paid benchmark has not been run/);
    assert.match(v2, /V1 six-case live (?:run|result) is not (?:a |the )?V2/);
    assert.match(v2, /structural evaluation does not (?:judge|score|evaluate) semantic/i);
    assert.match(v2, /forbidden remembered meaning/);
    assert.match(v2, /0 provider HTTP calls/);
    assert.match(v2, /does not require .{0,40}\.env|\.env is not required/i);
    assert.match(v2, /does not read .{0,20}\.env|\.env is not read/i);
    assert.match(v2, /not (?:saved|written|stored) (?:to |on )?disk automatically/i);
    assert.match(v2, /(?:at most|no more than|not more than) 6 sequential POST/i);
    assert.match(v2, /\$0\.032/);
    assert.match(v2, /\$0\.03113088/);
    assert.match(v2, /no retry/i);
    assert.match(v2, /fallback/i);
    assert.match(v2, /repair/i);
    assert.match(v2, /actualUsage/);
    assert.match(v2, /actualCostUsd/);
    assert.match(v2, /not actual billing/i);
    assert.match(readme, /live-benchmark-six-run\.mjs --model openai\/gpt-5\.6-luna --max-budget-usd 0\.032/);
  });
});
