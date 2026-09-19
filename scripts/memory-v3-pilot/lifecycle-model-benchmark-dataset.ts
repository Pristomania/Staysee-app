/** Offline preparation of independent synthetic lifecycle reconciler cases. */

import { createHash } from 'node:crypto';

import { canonicalStringify } from './contracts.mjs';
import { assignLifecycleItems } from './lifecycle-evaluator.mjs';
import {
  getLifecycleModelBenchmarkProfile,
} from './lifecycle-model-benchmark-profile.ts';
import type { MemoryV3Extraction } from '../../supabase/functions/_shared/memoryV3/contract.ts';
import type {
  MemoryV3LifecycleProposal,
  MemoryV3LifecycleState,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';
import {
  applyMemoryV3LifecycleStep,
  createEmptyMemoryV3LifecycleState,
} from '../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts';
import type { MemoryV3DialogueMessage } from '../../supabase/functions/_shared/memoryV3/messages.ts';

export const SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID =
  '11111111-1111-4111-8111-111111111111' as const;

const EXPECTED_MANIFEST_SHA256 =
  'F815482957C23C2077C37DB6292B8E4510E66D863EC988381074061FA3E5FBEE';
const DATASET_FIELDS = ['datasetId', 'version', 'language', 'privacy', 'scenarios'] as const;
const SCENARIO_FIELDS = ['scenarioId', 'title', 'steps'] as const;
const STEP_FIELDS = [
  'stepId', 'at', 'conversationId', 'messages', 'validatedExtraction',
  'scriptedProposal', 'forgetMemoryRefs', 'expectedState', 'mustNotRemember',
] as const;
const MESSAGE_FIELDS = ['id', 'role', 'text', 'createdAt'] as const;
const PROPOSAL_FIELDS = ['type', 'candidateLocalItemKey', 'targetGoldMemoryId'] as const;
const EXPECTED_STATE_FIELDS = ['items'] as const;
const OPTIONS_FIELDS = ['profileId', 'dataset'] as const;
const OPERATION_TYPES = new Set(['create', 'confirm', 'revise', 'mark_stale', 'reject', 'ignore']);
const OWN_ERRORS = new WeakSet<object>();

type DatasetDiagnostic =
  | 'lifecycle_model_dataset_invalid'
  | 'lifecycle_model_dataset_identity_mismatch'
  | 'lifecycle_model_dataset_selected_step_missing'
  | 'lifecycle_model_dataset_replay_failed';

type JsonRecord = Record<string, unknown>;
type JsonValue = null | string | boolean | number | JsonValue[] | { [key: string]: JsonValue };

interface AuthoringProposal {
  type: MemoryV3LifecycleProposal[number]['type'];
  candidateLocalItemKey: string;
  targetGoldMemoryId: string | null;
}

interface ExpectedGoldItem {
  goldMemoryId: string;
  tier: string;
  kind: string;
  claim: string;
  status: string;
  sensitivity: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  alternative: string | null;
  firstSeenAt: string;
  updatedAt: string;
  revision: number;
  evidence: Array<{
    conversationId: string;
    sourceMessageId: string;
    relation: string;
    supportType: string | null;
    episodeKey: string | null;
    provenanceRole: string;
    mentionTime: string;
  }>;
}

export interface PreparedLifecycleModelCase {
  stepId: string;
  scenarioId: string;
  at: string;
  userId: string;
  conversationId: string;
  messages: MemoryV3DialogueMessage[];
  state: MemoryV3LifecycleState;
  extraction: MemoryV3Extraction;
  expectedProposal: MemoryV3LifecycleProposal;
  expectedState: { items: ExpectedGoldItem[] };
  expectedTransitions: Array<AuthoringProposal | {
    type: 'forget';
    candidateLocalItemKey: null;
    targetGoldMemoryId: string;
  }>;
  expectedReducerTransitions: Array<{
    type: MemoryV3LifecycleProposal[number]['type'] | 'forget';
    candidateLocalItemKey: string | null;
    targetMemoryKey: string | null;
    resultingMemoryKey: string | null;
  }>;
  mustNotRemember: string[];
}

function fail(diagnosticCode: DatasetDiagnostic): never {
  const error = new Error(`[memory-v3:lifecycle-model-dataset] ${diagnosticCode}`);
  error.name = 'MemoryV3LifecycleModelBenchmarkDatasetError';
  Object.defineProperty(error, 'diagnosticCode', {
    value: diagnosticCode,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  OWN_ERRORS.add(error);
  throw error;
}

function scalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function cloneJsonData(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (scalar(value)) return value;
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    fail('lifecycle_model_dataset_invalid');
  }
  seen.add(value);
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail('lifecycle_model_dataset_invalid');
  }
  if (Array.isArray(value)) {
    const lengthDescriptor = safeDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      keys.length !== lengthDescriptor.value + 1) {
      fail('lifecycle_model_dataset_invalid');
    }
    const output: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = safeDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        fail('lifecycle_model_dataset_invalid');
      }
      output.push(cloneJsonData(descriptor.value, seen));
    }
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= output.length) {
        fail('lifecycle_model_dataset_invalid');
      }
    }
    return output;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail('lifecycle_model_dataset_invalid');
  }
  const output: JsonRecord = {};
  for (const key of keys) {
    if (typeof key !== 'string') fail('lifecycle_model_dataset_invalid');
    const descriptor = safeDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      fail('lifecycle_model_dataset_invalid');
    }
    Object.defineProperty(output, key, {
      value: cloneJsonData(descriptor.value, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}

function safeDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail('lifecycle_model_dataset_invalid');
  }
}

function record(value: unknown, fields: readonly string[]): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('lifecycle_model_dataset_invalid');
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    fail('lifecycle_model_dataset_invalid');
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) fail('lifecycle_model_dataset_invalid');
  }
  return value as JsonRecord;
}

function dense(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail('lifecycle_model_dataset_invalid');
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function syntheticUuid(label: string): string {
  const bytes = createHash('sha256')
    .update(`memory-v3-lifecycle-benchmark:${label}`, 'utf8')
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function syntheticMessageUuid(conversationLabel: string, messageId: string): string {
  return syntheticUuid(`${conversationLabel}:message:${messageId}`);
}

function projectExpectedState(value: unknown): { items: ExpectedGoldItem[] } {
  const root = record(value, EXPECTED_STATE_FIELDS);
  const ids = new Set<string>();
  const items = dense(root.items).map((rawItem) => {
    if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      fail('lifecycle_model_dataset_invalid');
    }
    const item = rawItem as JsonRecord;
    if (!nonEmpty(item.goldMemoryId) || ids.has(item.goldMemoryId) || !Array.isArray(item.evidence)) {
      fail('lifecycle_model_dataset_invalid');
    }
    ids.add(item.goldMemoryId);
    return {
      ...(item as unknown as ExpectedGoldItem),
      evidence: item.evidence.map((rawEvidence: unknown) => {
        if (rawEvidence === null || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
          fail('lifecycle_model_dataset_invalid');
        }
        const evidence = rawEvidence as JsonRecord;
        if (!nonEmpty(evidence.conversationId)) fail('lifecycle_model_dataset_invalid');
        return {
          ...(evidence as unknown as ExpectedGoldItem['evidence'][number]),
          conversationId: syntheticUuid(evidence.conversationId),
          sourceMessageId: syntheticMessageUuid(
            evidence.conversationId,
            evidence.sourceMessageId as string,
          ),
        };
      }),
    };
  });
  return { items };
}

function inspectMessages(value: unknown, conversationLabel: string): MemoryV3DialogueMessage[] {
  const ids = new Set<string>();
  return dense(value).map((raw) => {
    const message = record(raw, MESSAGE_FIELDS);
    if (!nonEmpty(message.id) || ids.has(message.id) ||
      !['user', 'assistant', 'system'].includes(message.role as string) ||
      !nonEmpty(message.text) || !nonEmpty(message.createdAt) ||
      !Number.isFinite(Date.parse(message.createdAt))) {
      fail('lifecycle_model_dataset_invalid');
    }
    ids.add(message.id);
    return {
      ...message,
      id: syntheticMessageUuid(conversationLabel, message.id),
    } as unknown as MemoryV3DialogueMessage;
  });
}

function projectExtraction(
  value: unknown,
  conversationLabel: string,
  conversationId: string,
): MemoryV3Extraction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('lifecycle_model_dataset_invalid');
  }
  const extraction = value as Partial<MemoryV3Extraction>;
  if (extraction.run === null || typeof extraction.run !== 'object' ||
    !Array.isArray(extraction.items) || !Array.isArray(extraction.evidence)) {
    fail('lifecycle_model_dataset_invalid');
  }
  return {
    run: {
      ...extraction.run,
      caseId: `memory-v3-shadow:${SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID}:${conversationId}`,
    },
    items: extraction.items.map((item: unknown) => ({ ...(item as object) })),
    evidence: extraction.evidence.map((row: MemoryV3Extraction['evidence'][number]) => ({
      ...row,
      sourceMessageId: syntheticMessageUuid(conversationLabel, row.sourceMessageId),
    })),
  } as MemoryV3Extraction;
}

function inspectProposal(value: unknown): AuthoringProposal[] {
  return dense(value).map((raw) => {
    const row = record(raw, PROPOSAL_FIELDS);
    if (!OPERATION_TYPES.has(row.type as string) || !nonEmpty(row.candidateLocalItemKey) ||
      (row.targetGoldMemoryId !== null && !nonEmpty(row.targetGoldMemoryId))) {
      fail('lifecycle_model_dataset_invalid');
    }
    return { ...row } as unknown as AuthoringProposal;
  });
}

function inspectStringArray(value: unknown): string[] {
  return dense(value).map((entry) => {
    if (!nonEmpty(entry)) fail('lifecycle_model_dataset_invalid');
    return entry;
  });
}

function manifestHash(dataset: JsonRecord): string {
  return createHash('sha256')
    .update(canonicalStringify({
      datasetId: dataset.datasetId,
      version: dataset.version,
      language: dataset.language,
      scenarios: dataset.scenarios,
    }))
    .digest('hex')
    .toUpperCase();
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function translateProposal(
  authored: AuthoringProposal[],
  goldToMemory: Map<string, string>,
): MemoryV3LifecycleProposal {
  return authored.map((row) => {
    const targetMemoryKey = row.targetGoldMemoryId === null
      ? null
      : goldToMemory.get(row.targetGoldMemoryId);
    if (row.targetGoldMemoryId !== null && targetMemoryKey === undefined) {
      fail('lifecycle_model_dataset_replay_failed');
    }
    return {
      type: row.type,
      candidateLocalItemKey: row.candidateLocalItemKey,
      targetMemoryKey: targetMemoryKey ?? null,
    };
  });
}

function refreshedGoldMap(expectedItems: ExpectedGoldItem[], state: MemoryV3LifecycleState): Map<string, string> {
  let pairs: Array<{ goldMemoryId: string; memoryKey: string }>;
  try {
    pairs = assignLifecycleItems({ expectedItems, actualItems: state.items }).pairs;
  } catch {
    fail('lifecycle_model_dataset_replay_failed');
  }
  if (pairs.length !== expectedItems.length || state.items.length !== expectedItems.length) {
    fail('lifecycle_model_dataset_replay_failed');
  }
  return new Map(pairs.map((pair) => [pair.goldMemoryId, pair.memoryKey]));
}

async function replaySelectedCase(
  scenarioId: string,
  rawSteps: unknown[],
  selectedStepId: string,
): Promise<PreparedLifecycleModelCase> {
  let state = createEmptyMemoryV3LifecycleState({ userId: SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID });
  let goldToMemory = new Map<string, string>();

  for (const rawStep of rawSteps) {
    const step = record(rawStep, STEP_FIELDS);
    if (!nonEmpty(step.stepId) || !nonEmpty(step.at) || !Number.isFinite(Date.parse(step.at)) ||
      !nonEmpty(step.conversationId)) {
      fail('lifecycle_model_dataset_invalid');
    }
    const conversationId = syntheticUuid(step.conversationId);
    const messages = inspectMessages(step.messages, step.conversationId);
    const extraction = projectExtraction(
      step.validatedExtraction,
      step.conversationId,
      conversationId,
    );
    const authoredProposal = inspectProposal(step.scriptedProposal);
    const proposal = translateProposal(authoredProposal, goldToMemory);
    const forgetRefs = inspectStringArray(step.forgetMemoryRefs);
    const forgetKeys = forgetRefs.map((ref) => {
      const key = goldToMemory.get(ref);
      if (key === undefined) fail('lifecycle_model_dataset_replay_failed');
      return key;
    });
    const expectedState = projectExpectedState(step.expectedState);
    const mustNotRemember = inspectStringArray(step.mustNotRemember);
    const beforeState = state;
    let applied: Awaited<ReturnType<typeof applyMemoryV3LifecycleStep>>;
    try {
      applied = await applyMemoryV3LifecycleStep({
        state: beforeState,
        at: step.at,
        conversationId,
        extraction,
        proposal,
        trustedForgetMemoryKeys: forgetKeys,
      });
    } catch {
      fail('lifecycle_model_dataset_replay_failed');
    }
    const nextGoldToMemory = refreshedGoldMap(expectedState.items, applied.state);

    if (step.stepId === selectedStepId) {
      return deepFreeze({
        stepId: step.stepId,
        scenarioId,
        at: step.at,
        userId: SYNTHETIC_LIFECYCLE_BENCHMARK_USER_ID,
        conversationId,
        messages,
        state: beforeState,
        extraction,
        expectedProposal: proposal,
        expectedState,
        expectedTransitions: [
          ...authoredProposal.map((row) => ({ ...row })),
          ...forgetRefs.map((targetGoldMemoryId) => ({
            type: 'forget' as const,
            candidateLocalItemKey: null,
            targetGoldMemoryId,
          })),
        ],
        expectedReducerTransitions: applied.transitions.map((row) => ({ ...row })),
        mustNotRemember,
      });
    }
    state = applied.state;
    goldToMemory = nextGoldToMemory;
  }
  fail('lifecycle_model_dataset_selected_step_missing');
}

export async function prepareLifecycleModelBenchmarkCases(options: {
  profileId: string;
  dataset: unknown;
}): Promise<readonly PreparedLifecycleModelCase[]> {
  try {
    const clonedOptions = cloneJsonData(options);
    const root = record(clonedOptions, OPTIONS_FIELDS);
    const profile = getLifecycleModelBenchmarkProfile(root.profileId);
    const dataset = record(root.dataset, DATASET_FIELDS);
    if (dataset.datasetId !== profile.datasetId || dataset.version !== profile.datasetVersion ||
      dataset.language !== 'ru' || dataset.privacy !== 'synthetic-only' ||
      manifestHash(dataset) !== EXPECTED_MANIFEST_SHA256) {
      fail('lifecycle_model_dataset_identity_mismatch');
    }
    const scenarios = dense(dataset.scenarios);
    if (scenarios.length !== 20) fail('lifecycle_model_dataset_invalid');
    const selected = new Map<string, { scenarioId: string; steps: unknown[] }>();
    const scenarioIds = new Set<string>();
    const allStepIds = new Set<string>();
    for (const rawScenario of scenarios) {
      const scenario = record(rawScenario, SCENARIO_FIELDS);
      if (!nonEmpty(scenario.scenarioId) || !nonEmpty(scenario.title) || scenarioIds.has(scenario.scenarioId)) {
        fail('lifecycle_model_dataset_invalid');
      }
      scenarioIds.add(scenario.scenarioId);
      const steps = dense(scenario.steps);
      if (steps.length === 0) fail('lifecycle_model_dataset_invalid');
      for (const rawStep of steps) {
        const step = record(rawStep, STEP_FIELDS);
        if (!nonEmpty(step.stepId) || allStepIds.has(step.stepId)) {
          fail('lifecycle_model_dataset_invalid');
        }
        allStepIds.add(step.stepId);
        if (profile.stepIds.includes(step.stepId)) {
          selected.set(step.stepId, { scenarioId: scenario.scenarioId, steps });
        }
      }
    }
    if (allStepIds.size !== 80 || selected.size !== profile.caseCount ||
      profile.stepIds.some((stepId) => !selected.has(stepId))) {
      fail('lifecycle_model_dataset_selected_step_missing');
    }
    const prepared: PreparedLifecycleModelCase[] = [];
    for (const stepId of profile.stepIds) {
      const owner = selected.get(stepId)!;
      prepared.push(await replaySelectedCase(owner.scenarioId, owner.steps, stepId));
    }
    return deepFreeze(prepared);
  } catch (error) {
    if ((typeof error === 'object' || typeof error === 'function') && error !== null && OWN_ERRORS.has(error)) {
      throw error;
    }
    fail('lifecycle_model_dataset_invalid');
  }
}
