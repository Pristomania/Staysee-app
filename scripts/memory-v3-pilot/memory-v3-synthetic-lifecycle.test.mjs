import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { canonicalStringify } from './contracts.mjs';
import {
  LIFECYCLE_CLOSED_STATUS_BY_KIND,
  LIFECYCLE_CURRENT_STATUS_BY_KIND,
  LIFECYCLE_OPERATION_TYPES,
  validateLifecycleProposal,
  validateLifecycleSession,
  validateLifecycleState,
} from './lifecycle-contract.mjs';

const DATASET_URL = new URL('./memory-v3-synthetic-lifecycle.v1.json', import.meta.url);
const dataset = JSON.parse(readFileSync(DATASET_URL, 'utf8'));
const README = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

const EXPECTED_SCENARIOS = Object.freeze([
  ['paraphrase-event-dedup', ['create', 'confirm', 'ignore', 'confirm']],
  ['same-topic-distinct-events', ['create', 'create', 'confirm', 'confirm']],
  ['event-date-correction', ['create', 'ignore', 'revise', 'confirm']],
  ['scope-narrowing', ['create', 'confirm', 'revise', 'confirm']],
  ['hypothesis-supported', ['create', 'confirm', 'revise', 'confirm']],
  ['hypothesis-rejected', ['create', 'confirm', 'reject', 'ignore']],
  ['recurrence-growth', ['create', 'confirm', 'revise', 'confirm']],
  ['pattern-confirmation', ['create', 'confirm', 'ignore', 'confirm']],
  ['recurrence-stale', ['create', 'confirm', 'mark_stale', 'ignore']],
  ['qualified-counterexample', ['create', 'confirm', 'revise', 'confirm']],
  ['assistant-speculation-ignored', ['ignore', 'ignore', 'ignore', 'ignore']],
  ['assistant-speculation-denied', ['ignore', 'ignore', 'ignore', 'ignore']],
  ['prompt-injection-schema', ['create', 'ignore', 'confirm', 'ignore']],
  ['explicit-forget', ['create', 'confirm', 'forget', 'ignore']],
  ['forget-no-resurrection', ['create', 'forget', 'ignore', 'ignore']],
  ['sensitivity-preserved', ['create', 'confirm', 'revise', 'confirm']],
  ['irrelevant-no-churn', ['create', 'ignore', 'ignore', 'confirm']],
  ['deterministic-equal-time', ['create+create', 'confirm+confirm', 'ignore', 'confirm+confirm']],
  ['layered-coexistence', ['create+create+create', 'confirm', 'confirm', 'revise']],
  ['time-only-stability', ['create', 'ignore', 'ignore', 'confirm']],
]);

const EXPECTED_MANIFEST_SHA256 = 'F815482957C23C2077C37DB6292B8E4510E66D863EC988381074061FA3E5FBEE';
const TOP_FIELDS = ['datasetId', 'language', 'privacy', 'scenarios', 'version'];
const SCENARIO_FIELDS = ['scenarioId', 'steps', 'title'];
const STEP_FIELDS = [
  'at',
  'conversationId',
  'expectedState',
  'forgetMemoryRefs',
  'messages',
  'mustNotRemember',
  'scriptedProposal',
  'stepId',
  'validatedExtraction',
];
const MESSAGE_FIELDS = ['createdAt', 'id', 'role', 'text'];
const AUTHORING_PROPOSAL_FIELDS = ['candidateLocalItemKey', 'targetGoldMemoryId', 'type'];
const EXPECTED_STATE_FIELDS = ['items'];
const GOLD_ITEM_FIELDS = [
  'alternative',
  'claim',
  'eventTimeEnd',
  'eventTimeStart',
  'evidence',
  'firstSeenAt',
  'goldMemoryId',
  'kind',
  'revision',
  'sensitivity',
  'status',
  'tier',
  'updatedAt',
];
const STATE_EVIDENCE_FIELDS = [
  'conversationId',
  'episodeKey',
  'mentionTime',
  'provenanceRole',
  'relation',
  'sourceMessageId',
  'supportType',
];

function clone(value) {
  return structuredClone(value);
}

function assertPlainObject(value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} must be plain`);
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields`);
}

function assertDenseArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.equal(Object.keys(value).length, value.length, `${label} must be dense`);
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.notEqual(value.trim(), '', `${label} must be non-empty`);
}

function expectedMessageTime(at, offsetSeconds) {
  return new Date(Date.parse(at) + offsetSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

function stableMemoryKey(scenarioId, goldMemoryId) {
  return createHash('sha256').update(`${scenarioId}\0${goldMemoryId}`).digest('hex');
}

function materialFingerprint(item) {
  return canonicalStringify({
    kind: item.kind,
    claim: item.claim,
    status: item.status,
    sensitivity: item.sensitivity,
    eventTimeStart: item.eventTimeStart,
    eventTimeEnd: item.eventTimeEnd,
    alternative: item.alternative,
  });
}

function validateGoldState(scenarioId, step, knownMessages) {
  assertExactKeys(step.expectedState, EXPECTED_STATE_FIELDS, `${step.stepId}.expectedState`);
  assertDenseArray(step.expectedState.items, `${step.stepId}.expectedState.items`);
  const ids = new Set();
  const projectedItems = step.expectedState.items.map((item, itemIndex) => {
    const label = `${step.stepId}.expectedState.items[${itemIndex}]`;
    assertExactKeys(item, GOLD_ITEM_FIELDS, label);
    assertNonEmptyString(item.goldMemoryId, `${label}.goldMemoryId`);
    assert.equal(ids.has(item.goldMemoryId), false, `${label}.goldMemoryId duplicate`);
    ids.add(item.goldMemoryId);
    assert.equal(item.tier, 'required', `${label}.tier`);
    assertDenseArray(item.evidence, `${label}.evidence`);
    const evidence = item.evidence.map((row, evidenceIndex) => {
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
      assertExactKeys(row, STATE_EVIDENCE_FIELDS, evidenceLabel);
      const message = knownMessages.get(`${row.conversationId}\0${row.sourceMessageId}`);
      assert.ok(message, `${evidenceLabel} must resolve to an earlier or current message`);
      assert.equal(message.role, 'user', `${evidenceLabel} must cite user`);
      assert.equal(row.provenanceRole, 'user', `${evidenceLabel}.provenanceRole`);
      assert.equal(row.mentionTime, message.createdAt, `${evidenceLabel}.mentionTime`);
      return row;
    });
    return {
      memoryKey: stableMemoryKey(scenarioId, item.goldMemoryId),
      kind: item.kind,
      claim: item.claim,
      status: item.status,
      sensitivity: item.sensitivity,
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      alternative: item.alternative,
      firstSeenAt: item.firstSeenAt,
      updatedAt: item.updatedAt,
      revision: item.revision,
      evidence,
    };
  });
  assert.doesNotThrow(() => validateLifecycleState({
    scenarioId,
    nextMemoryOrdinal: step.expectedState.items.length + 1,
    items: projectedItems,
  }));
  return new Map(step.expectedState.items.map((item) => [item.goldMemoryId, item]));
}

function projectGoldStateForContract(scenarioId, expectedState) {
  return {
    scenarioId,
    nextMemoryOrdinal: expectedState.items.length + 1,
    items: expectedState.items.map((item) => ({
      memoryKey: stableMemoryKey(scenarioId, item.goldMemoryId),
      kind: item.kind,
      claim: item.claim,
      status: item.status,
      sensitivity: item.sensitivity,
      eventTimeStart: item.eventTimeStart,
      eventTimeEnd: item.eventTimeEnd,
      alternative: item.alternative,
      firstSeenAt: item.firstSeenAt,
      updatedAt: item.updatedAt,
      revision: item.revision,
      evidence: item.evidence,
    })),
  };
}

function operationSummary(step) {
  const types = step.scriptedProposal.map((row) => row.type);
  if (step.forgetMemoryRefs.length > 0) types.push('forget');
  return types.length === 0 ? 'none' : types.join('+');
}

describe('synthetic lifecycle dataset identity and totals', () => {
  test('uses the closed dataset identity and exact top-level fields', () => {
    assertExactKeys(dataset, TOP_FIELDS, 'dataset');
    assert.equal(dataset.datasetId, 'memory-v3-synthetic-lifecycle-v1');
    assert.equal(dataset.version, '1.0.0');
    assert.equal(dataset.language, 'ru');
    assert.equal(dataset.privacy, 'synthetic-only');
  });

  test('contains exactly 20 scenarios, 80 steps, and 240 messages', () => {
    assertDenseArray(dataset.scenarios, 'dataset.scenarios');
    assert.equal(dataset.scenarios.length, 20);
    assert.equal(dataset.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0), 80);
    assert.equal(dataset.scenarios.reduce(
      (sum, scenario) => sum + scenario.steps.reduce((inner, step) => inner + step.messages.length, 0),
      0,
    ), 240);
  });

  test('uses the exact approved scenario ids and canonical order', () => {
    assert.deepEqual(dataset.scenarios.map((scenario) => scenario.scenarioId), EXPECTED_SCENARIOS.map(([id]) => id));
  });
});

describe('synthetic lifecycle sessions and dialogue', () => {
  test('has four ordered sessions and twelve messages per scenario', () => {
    const stepIds = new Set();
    const conversationIds = new Set();
    for (const scenario of dataset.scenarios) {
      assertExactKeys(scenario, SCENARIO_FIELDS, scenario.scenarioId);
      assertNonEmptyString(scenario.title, `${scenario.scenarioId}.title`);
      assertDenseArray(scenario.steps, `${scenario.scenarioId}.steps`);
      assert.equal(scenario.steps.length, 4);
      assert.equal(scenario.steps.reduce((sum, step) => sum + step.messages.length, 0), 12);
      assert.ok(new Set(scenario.steps.map((step) => step.at.slice(0, 10))).size >= 2);
      scenario.steps.forEach((step, index) => {
        assertExactKeys(step, STEP_FIELDS, step.stepId);
        assert.equal(step.stepId, `${scenario.scenarioId}-s0${index + 1}`);
        assert.equal(step.conversationId, `synthetic-${scenario.scenarioId}-c0${index + 1}`);
        assert.equal(stepIds.has(step.stepId), false);
        assert.equal(conversationIds.has(step.conversationId), false);
        stepIds.add(step.stepId);
        conversationIds.add(step.conversationId);
        assert.doesNotThrow(() => validateLifecycleSession({
          scenarioId: scenario.scenarioId,
          stepId: step.stepId,
          at: step.at,
          conversationId: step.conversationId,
        }));
        assertDenseArray(step.messages, `${step.stepId}.messages`);
        assert.equal(step.messages.length, 3);
        step.messages.forEach((message, messageIndex) => {
          assertExactKeys(message, MESSAGE_FIELDS, `${step.stepId}.messages[${messageIndex}]`);
          assert.equal(message.id, `m${messageIndex + 1}`);
          assert.ok(['user', 'assistant', 'system'].includes(message.role));
          assertNonEmptyString(message.text, `${step.stepId}.messages[${messageIndex}].text`);
          assert.equal(message.createdAt, expectedMessageTime(step.at, messageIndex));
        });
      });
    }
    assert.equal(stepIds.size, 80);
    assert.equal(conversationIds.size, 80);
  });

  test('has no exact duplicate message text across unrelated scenarios', () => {
    const ownerByText = new Map();
    for (const scenario of dataset.scenarios) {
      for (const step of scenario.steps) {
        for (const message of step.messages) {
          const owner = ownerByText.get(message.text);
          assert.ok(owner === undefined || owner === scenario.scenarioId, `duplicate dialogue across ${owner} and ${scenario.scenarioId}`);
          ownerByText.set(message.text, scenario.scenarioId);
        }
      }
    }
  });
});

describe('synthetic lifecycle extraction and authoring references', () => {
  test('validates every lifecycle V2 extraction delta and cites only same-session user messages', () => {
    for (const scenario of dataset.scenarios) {
      let previousExpectedState = { items: [] };
      for (const step of scenario.steps) {
        assert.equal(step.validatedExtraction.run.caseId, step.stepId);
        assert.equal(step.validatedExtraction.run.extractorVersion, 'memory-v3-synthetic-lifecycle-fixture-v1');
        const messageById = new Map(step.messages.map((message) => [message.id, message]));
        for (const row of step.validatedExtraction.evidence) {
          const message = messageById.get(row.sourceMessageId);
          assert.ok(message, `${step.stepId} unresolved extraction evidence`);
          assert.equal(message.role, 'user');
          assert.equal(row.provenanceRole, 'user');
          assert.equal(row.mentionTime, message.createdAt);
        }
        const runtimeProposal = step.scriptedProposal.map((row) => ({
          type: row.type,
          candidateLocalItemKey: row.candidateLocalItemKey,
          targetMemoryKey: row.targetGoldMemoryId === null
            ? null
            : stableMemoryKey(scenario.scenarioId, row.targetGoldMemoryId),
        }));
        assert.doesNotThrow(() => validateLifecycleProposal(runtimeProposal, {
          state: projectGoldStateForContract(scenario.scenarioId, previousExpectedState),
          extraction: step.validatedExtraction,
        }));
        previousExpectedState = step.expectedState;
      }
    }
  });

  test('consumes every candidate exactly once and resolves authoring targets', () => {
    for (const scenario of dataset.scenarios) {
      let previousIds = new Set();
      const forgotten = new Set();
      for (const step of scenario.steps) {
        assertDenseArray(step.scriptedProposal, `${step.stepId}.scriptedProposal`);
        const candidates = new Set(step.validatedExtraction.items.map((item) => item.localItemKey));
        const consumed = new Set();
        for (const [index, row] of step.scriptedProposal.entries()) {
          const label = `${step.stepId}.scriptedProposal[${index}]`;
          assertExactKeys(row, AUTHORING_PROPOSAL_FIELDS, label);
          assert.ok(LIFECYCLE_OPERATION_TYPES.includes(row.type), `${label}.type`);
          assert.ok(candidates.has(row.candidateLocalItemKey), `${label}.candidateLocalItemKey`);
          assert.equal(consumed.has(row.candidateLocalItemKey), false, `${label} consumes candidate twice`);
          consumed.add(row.candidateLocalItemKey);
          if (row.type === 'create' || row.type === 'ignore') {
            assert.equal(row.targetGoldMemoryId, null, `${label}.targetGoldMemoryId`);
          } else {
            assertNonEmptyString(row.targetGoldMemoryId, `${label}.targetGoldMemoryId`);
            assert.ok(previousIds.has(row.targetGoldMemoryId), `${label} target must exist before step`);
            assert.equal(forgotten.has(row.targetGoldMemoryId), false, `${label} target was forgotten`);
          }
        }
        assert.deepEqual([...consumed].sort(), [...candidates].sort(), `${step.stepId} candidate consumption`);
        assertDenseArray(step.forgetMemoryRefs, `${step.stepId}.forgetMemoryRefs`);
        for (const ref of step.forgetMemoryRefs) {
          assertNonEmptyString(ref, `${step.stepId}.forgetMemoryRefs`);
          assert.ok(previousIds.has(ref), `${step.stepId} forget target must exist`);
          forgotten.add(ref);
        }
        previousIds = new Set(step.expectedState.items.map((item) => item.goldMemoryId));
        for (const ref of forgotten) assert.equal(previousIds.has(ref), false, `${step.stepId} resurrected ${ref}`);
      }
    }
  });
});

describe('synthetic lifecycle expected state semantics', () => {
  test('validates complete expected state and all durable evidence references', () => {
    for (const scenario of dataset.scenarios) {
      const knownMessages = new Map();
      for (const step of scenario.steps) {
        for (const message of step.messages) {
          knownMessages.set(`${step.conversationId}\0${message.id}`, message);
        }
        validateGoldState(scenario.scenarioId, step, knownMessages);
      }
    }
  });

  test('keeps stable identity and increments revision only on material change', () => {
    for (const scenario of dataset.scenarios) {
      const priorById = new Map();
      for (const step of scenario.steps) {
        for (const item of step.expectedState.items) {
          assert.ok([
            ...LIFECYCLE_CURRENT_STATUS_BY_KIND[item.kind],
            ...LIFECYCLE_CLOSED_STATUS_BY_KIND[item.kind],
          ].includes(item.status));
          const prior = priorById.get(item.goldMemoryId);
          if (prior) {
            assert.equal(item.kind, prior.kind);
            assert.equal(item.firstSeenAt, prior.firstSeenAt);
            const changed = materialFingerprint(item) !== materialFingerprint(prior);
            assert.equal(item.revision, prior.revision + (changed ? 1 : 0));
            assert.equal(item.updatedAt, changed ? step.at : prior.updatedAt);
          } else {
            assert.equal(item.revision, 1);
            assert.equal(item.firstSeenAt, step.at);
            assert.equal(item.updatedAt, step.at);
          }
          priorById.set(item.goldMemoryId, item);
        }
      }
    }
  });

  test('locks the exact approved transition sequence for all scenarios', () => {
    for (const [scenarioId, expected] of EXPECTED_SCENARIOS) {
      const scenario = dataset.scenarios.find((entry) => entry.scenarioId === scenarioId);
      assert.deepEqual(scenario.steps.map(operationSummary), expected, scenarioId);
    }
  });

  test('keeps mustNotRemember closed and free of duplicate claims', () => {
    for (const scenario of dataset.scenarios) {
      for (const step of scenario.steps) {
        assertDenseArray(step.mustNotRemember, `${step.stepId}.mustNotRemember`);
        step.mustNotRemember.forEach((claim) => assertNonEmptyString(claim, `${step.stepId}.mustNotRemember`));
        assert.equal(new Set(step.mustNotRemember).size, step.mustNotRemember.length);
      }
    }
  });
});

describe('synthetic lifecycle canonical manifest lock', () => {
  test('matches the human-approved canonical fingerprint', () => {
    const fingerprint = createHash('sha256')
      .update(canonicalStringify({
        datasetId: dataset.datasetId,
        version: dataset.version,
        language: dataset.language,
        scenarios: dataset.scenarios,
      }))
      .digest('hex')
      .toUpperCase();
    assert.equal(fingerprint, EXPECTED_MANIFEST_SHA256);
  });

  test('detects a contract-valid date mutation without mutating the dataset', () => {
    const before = clone(dataset);
    const mutated = clone(dataset);
    const item = mutated.scenarios
      .find((scenario) => scenario.scenarioId === 'event-date-correction')
      .steps[0].expectedState.items[0];
    item.eventTimeStart = '2026-01-02';
    const fingerprint = (value) => createHash('sha256')
      .update(canonicalStringify({
        datasetId: value.datasetId,
        version: value.version,
        language: value.language,
        scenarios: value.scenarios,
      }))
      .digest('hex')
      .toUpperCase();
    assert.notEqual(fingerprint(mutated), fingerprint(dataset));
    assert.deepEqual(dataset, before);
  });
});

describe('synthetic lifecycle documentation contract', () => {
  test('documents the offline benchmark without implying production or paid execution', () => {
    const heading = '## Memory V3 synthetic lifecycle benchmark (offline, not production-ready)';
    const start = README.indexOf(heading);
    assert.notEqual(start, -1, 'README is missing the synthetic lifecycle section');
    const rest = README.slice(start + heading.length);
    const nextHeading = rest.search(/\n## /);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    for (const pattern of [
      /memory-v3-synthetic-lifecycle-v1/,
      /20 scenarios/i,
      /80 steps/i,
      /240 synthetic messages/i,
      /create.*confirm.*revise.*mark_stale.*reject.*ignore.*forget/is,
      /explicit forgetting/i,
      /no time-based deletion/i,
      /hard gates/i,
      /zero external calls/i,
      /no paid model/i,
      /production mode remains off/i,
      /30-day shadow purge.*does not delete.*primary memory/is,
      /scripted reference reconciler/i,
      /does not measure model quality/i,
      /passing.*does not authorize production integration/is,
      /node --test scripts\/memory-v3-pilot\/lifecycle-contract\.test\.mjs scripts\/memory-v3-pilot\/lifecycle-reducer\.test\.mjs scripts\/memory-v3-pilot\/lifecycle-evaluator\.test\.mjs scripts\/memory-v3-pilot\/memory-v3-synthetic-lifecycle\.test\.mjs scripts\/memory-v3-pilot\/lifecycle-runner\.test\.mjs/,
    ]) {
      assert.match(section, pattern);
    }
  });
});
