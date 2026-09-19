/** Offline model-quality engine for the synthetic Memory V3 lifecycle benchmark. */

import {
  getLifecycleModelBenchmarkProfile,
  type LifecycleModelBenchmarkProfile,
} from './lifecycle-model-benchmark-profile.ts';
import {
  prepareLifecycleModelBenchmarkCases,
  type PreparedLifecycleModelCase,
} from './lifecycle-model-benchmark-dataset.ts';
import { assertBudgetGate } from './benchmark-budget.mjs';
import {
  assertLifecycleHardGates,
  evaluateLifecycleScenario,
  evaluateLifecycleStep,
} from './lifecycle-evaluator.mjs';
import {
  buildMemoryV3LifecycleReconcileRequest,
  type MemoryV3LifecycleReconcileBundle,
} from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';
import {
  validateMemoryV3LifecycleProposal,
  projectSafeMemoryV3LifecycleContractDiagnostic,
  type MemoryV3LifecycleProposal,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';
import {
  applyMemoryV3LifecycleStep,
  projectSafeMemoryV3LifecycleReducerDiagnostic,
} from '../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts';
import {
  projectSafeMemoryV3LifecycleTransportDiagnostic,
  type MemoryV3LifecycleModelAdapter,
  type MemoryV3LifecycleTransportResult,
} from '../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts';

type PublicDiagnostic =
  | 'lifecycle_model_transport_failed'
  | 'lifecycle_model_parse_invalid'
  | 'lifecycle_model_contract_invalid'
  | 'lifecycle_model_reducer_invalid'
  | 'lifecycle_model_evaluation_invalid'
  | 'lifecycle_model_unknown_failure';

type FailureStage = 'transport' | 'parse' | 'contract' | 'reducer' | 'evaluation';
type JsonRecord = Record<string, unknown>;

export interface LifecycleModelBenchmarkCaseResult {
  stepId: string;
  expectedOperationTypes: string[];
  actualOperationTypes: string[];
  operationExact: boolean;
  stateExact: boolean;
}

export interface LifecycleModelBenchmarkResult {
  profileId: string;
  model: string;
  reconcilerVersion: string;
  stepIds: string[];
  attemptedCount: number;
  successCount: number;
  failureCount: number;
  providerHttpCalls: number;
  maxActive: number;
  retryCount: 0;
  repairCount: 0;
  configuredBudget: Record<string, unknown>;
  cases: Array<LifecycleModelBenchmarkCaseResult | { stepId: string }>;
  failures: Array<{ stepId: string; stage: FailureStage; diagnosticCode: PublicDiagnostic }>;
  aggregate: any | null;
  criticalCases: Array<{ stepId: string; exact: boolean }>;
  qualityGate: 'PASS' | 'FAIL' | 'NOT_RUN';
  actualUsage: { promptTokens: number; completionTokens: number } | null;
  actualCostUsd: number | null;
  semanticReview: {
    status: 'required';
    reason: 'Structural evaluator does not judge claim meaning or forbidden remembered meaning';
  };
}

export interface LifecycleModelReviewPacket {
  profileId: string;
  model: string;
  reconcilerVersion: string;
  cases: Array<{
    stepId: string;
    scenarioId: string;
    messages: Array<{ id: string; role: string; text: string; createdAt: string }>;
    expectedOperations: MemoryV3LifecycleProposal;
    predictedOperations: MemoryV3LifecycleProposal;
    evaluation: unknown | null;
    semanticVerdict: null;
    forbiddenMeaningVerdict: null;
    reviewerNotes: null;
  }>;
}

const PREFIX = '[memory-v3:lifecycle-model-benchmark]';
const OPTIONS_FIELDS = ['profileId', 'dataset', 'model', 'budget', 'execute', 'adapter'] as const;
const REQUIRED_OPTIONS_FIELDS = ['profileId', 'dataset', 'model', 'budget', 'execute'] as const;
const BUDGET_FIELDS = [
  'caseCount', 'maxInputTokensPerCase', 'maxOutputTokensPerCase',
  'inputUsdPerMillion', 'outputUsdPerMillion', 'maxRequests', 'maxBudgetUsd',
] as const;
const TRANSPORT_FIELDS = ['rawContent', 'usage'] as const;
const USAGE_FIELDS = ['promptTokens', 'completionTokens', 'costUsd'] as const;
const CRITICAL_STEP_IDS = new Set([
  'hypothesis-rejected-s03',
  'recurrence-stale-s03',
  'assistant-speculation-denied-s01',
  'prompt-injection-schema-s02',
]);
const OWN_ERRORS = new WeakSet<object>();
const PACKET_DETAILS = new WeakMap<object, {
  dataset: unknown;
  profile: LifecycleModelBenchmarkProfile;
  cases: ReviewCaseDetail[];
}>();

interface ReviewCaseDetail {
  testCase: PreparedLifecycleModelCase;
  predictedOperations: MemoryV3LifecycleProposal;
  evaluation: unknown | null;
}

function fail(code: PublicDiagnostic, message: string): never {
  const error = new Error(`${PREFIX} ${message}`);
  error.name = 'MemoryV3LifecycleModelBenchmarkError';
  Object.defineProperty(error, 'diagnosticCode', {
    value: code,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  OWN_ERRORS.add(error);
  throw error;
}

function safeKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    fail('lifecycle_model_unknown_failure', 'input is invalid');
  }
}

function safePrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    fail('lifecycle_model_unknown_failure', 'input is invalid');
  }
}

function safeDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail('lifecycle_model_unknown_failure', 'input is invalid');
  }
}

function strictRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  message: string,
): JsonRecord {
  if (typeof value !== 'object' || value === null) {
    fail('lifecycle_model_unknown_failure', message);
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail('lifecycle_model_unknown_failure', message);
  }
  if (isArray || (safePrototype(value) !== Object.prototype && safePrototype(value) !== null)) {
    fail('lifecycle_model_unknown_failure', message);
  }
  const keys = safeKeys(value);
  const output: JsonRecord = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedFields.includes(key)) {
      fail('lifecycle_model_unknown_failure', message);
    }
    const descriptor = safeDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
      fail('lifecycle_model_unknown_failure', message);
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(output, field)) fail('lifecycle_model_unknown_failure', message);
  }
  return output;
}

function cloneJsonData(value: unknown, message: string, seen = new WeakSet<object>()): any {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('lifecycle_model_unknown_failure', message);
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    fail('lifecycle_model_unknown_failure', message);
  }
  seen.add(value);
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail('lifecycle_model_unknown_failure', message);
  }
  const prototype = safePrototype(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    fail('lifecycle_model_unknown_failure', message);
  }
  const keys = safeKeys(value);
  if (isArray) {
    const length = safeDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) ||
      length.value < 0 || keys.length !== length.value + 1) {
      fail('lifecycle_model_unknown_failure', message);
    }
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = safeDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        fail('lifecycle_model_unknown_failure', message);
      }
      output.push(cloneJsonData(descriptor.value, message, seen));
    }
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= output.length) {
        fail('lifecycle_model_unknown_failure', message);
      }
    }
    seen.delete(value);
    return output;
  }
  const output: JsonRecord = {};
  for (const key of keys) {
    if (typeof key !== 'string') fail('lifecycle_model_unknown_failure', message);
    const descriptor = safeDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
      fail('lifecycle_model_unknown_failure', message);
    }
    Object.defineProperty(output, key, {
      value: cloneJsonData(descriptor.value, message, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(value);
  return output;
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

function inspectOptions(value: unknown): JsonRecord {
  return strictRecord(value, OPTIONS_FIELDS, REQUIRED_OPTIONS_FIELDS, 'options are invalid');
}

function inspectBudget(value: unknown, profile: LifecycleModelBenchmarkProfile): JsonRecord {
  let budget: JsonRecord;
  try {
    budget = cloneJsonData(value, 'budget preflight failed');
  } catch (error) {
    if (isOwnError(error)) throw error;
    fail('lifecycle_model_unknown_failure', 'budget preflight failed');
  }
  const root = strictRecord(budget, BUDGET_FIELDS, BUDGET_FIELDS, 'budget preflight failed');
  const exact = {
    caseCount: profile.caseCount,
    maxInputTokensPerCase: profile.maxInputTokensPerCase,
    maxOutputTokensPerCase: profile.maxOutputTokensPerCase,
    inputUsdPerMillion: profile.inputUsdPerMillion,
    outputUsdPerMillion: profile.outputUsdPerMillion,
    maxRequests: profile.maxRequests,
    maxBudgetUsd: profile.maxBudgetUsd,
  };
  for (const field of BUDGET_FIELDS) {
    if (!Object.is(root[field], exact[field])) {
      fail('lifecycle_model_unknown_failure', 'budget preflight failed');
    }
  }
  return root;
}

function isOwnError(error: unknown): error is Error {
  return (typeof error === 'object' || typeof error === 'function') &&
    error !== null && OWN_ERRORS.has(error);
}

export function createAtMostTwelveLifecycleAdapter(options: {
  adapter: MemoryV3LifecycleModelAdapter;
}): MemoryV3LifecycleModelAdapter & { readonly callCount: number } {
  const root = strictRecord(options, ['adapter'], ['adapter'], 'adapter options are invalid');
  if (typeof root.adapter !== 'function') fail('lifecycle_model_unknown_failure', 'adapter is invalid');
  const inner = root.adapter as MemoryV3LifecycleModelAdapter;
  let callCount = 0;
  const bounded = (async (request) => {
    if (callCount >= 12) {
      fail('lifecycle_model_transport_failed', 'thirteenth provider call is not allowed');
    }
    callCount += 1;
    return await inner(request);
  }) as MemoryV3LifecycleModelAdapter & { readonly callCount: number };
  Object.defineProperty(bounded, 'callCount', {
    get: () => callCount,
    enumerable: true,
    configurable: false,
  });
  return bounded;
}

function parseJsonDataOnly(rawContent: unknown): unknown {
  if (typeof rawContent !== 'string') fail('lifecycle_model_parse_invalid', 'model response is invalid');
  try {
    const parsed = JSON.parse(rawContent);
    return cloneJsonData(parsed, 'model response is invalid');
  } catch (error) {
    if (isOwnError(error) && (error as any).diagnosticCode === 'lifecycle_model_parse_invalid') throw error;
    fail('lifecycle_model_parse_invalid', 'model response is invalid');
  }
}

function inspectTransportResult(value: unknown): MemoryV3LifecycleTransportResult {
  const root = strictRecord(value, TRANSPORT_FIELDS, TRANSPORT_FIELDS, 'transport response is invalid');
  if (typeof root.rawContent !== 'string') {
    fail('lifecycle_model_transport_failed', 'transport response is invalid');
  }
  if (root.usage === null) return { rawContent: root.rawContent, usage: null };
  const usage = strictRecord(root.usage, USAGE_FIELDS, USAGE_FIELDS, 'transport response is invalid');
  if (!Number.isSafeInteger(usage.promptTokens) || (usage.promptTokens as number) < 0 ||
    !Number.isSafeInteger(usage.completionTokens) || (usage.completionTokens as number) < 0 ||
    typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    fail('lifecycle_model_transport_failed', 'transport response is invalid');
  }
  return {
    rawContent: root.rawContent,
    usage: {
      promptTokens: usage.promptTokens as number,
      completionTokens: usage.completionTokens as number,
      costUsd: usage.costUsd,
    },
  };
}

function proposalExact(expected: MemoryV3LifecycleProposal, actual: MemoryV3LifecycleProposal): boolean {
  return expected.length === actual.length && expected.every((row, index) => {
    const other = actual[index];
    return other !== undefined && row.type === other.type &&
      row.candidateLocalItemKey === other.candidateLocalItemKey &&
      row.targetMemoryKey === other.targetMemoryKey;
  });
}

function buildTransitionContext(
  testCase: PreparedLifecycleModelCase,
  proposal: MemoryV3LifecycleProposal,
  applied: any,
  replay: any,
) {
  const actualForget = applied.transitions.filter((row: any) => row.type === 'forget');
  const expectedForget = testCase.expectedTransitions.filter((row: any) => row.type === 'forget');
  const forbiddenMemoryKeys = applied.state.items
    .filter((item: any) => testCase.mustNotRemember.includes(item.claim) ||
      (item.alternative !== null && testCase.mustNotRemember.includes(item.alternative)))
    .map((item: any) => item.memoryKey);
  const assistantOnlyMemoryKeys = applied.state.items
    .filter((item: any) => item.evidence.length > 0 &&
      item.evidence.every((row: any) => row.provenanceRole !== 'user'))
    .map((item: any) => item.memoryKey);
  return {
    expected: testCase.expectedTransitions.map((row) => ({ ...row })),
    actual: applied.transitions.map((row: any) => ({ ...row })),
    replayEqual: JSON.stringify(applied) === JSON.stringify(replay),
    noOpExpected: proposal.every((row) => row.type === 'ignore') && expectedForget.length === 0,
    deletedMemoryKeys: actualForget.map((row: any) => row.targetMemoryKey).filter(Boolean),
    resurrectedMemoryKeys: [],
    forbiddenMemoryKeys,
    assistantOnlyMemoryKeys,
    forgottenPairs: expectedForget.map((row: any, index: number) => ({
      goldMemoryId: row.targetGoldMemoryId,
      memoryKey: actualForget[index]?.targetMemoryKey ?? '',
    })),
  };
}

function safeTransportDiagnostic(error: unknown): PublicDiagnostic {
  projectSafeMemoryV3LifecycleTransportDiagnostic(error);
  return 'lifecycle_model_transport_failed';
}

function safeContractDiagnostic(error: unknown): PublicDiagnostic {
  projectSafeMemoryV3LifecycleContractDiagnostic(error);
  return 'lifecycle_model_contract_invalid';
}

function safeReducerDiagnostic(error: unknown): PublicDiagnostic {
  projectSafeMemoryV3LifecycleReducerDiagnostic(error);
  return 'lifecycle_model_reducer_invalid';
}

function caseResult(
  testCase: PreparedLifecycleModelCase,
  actual: MemoryV3LifecycleProposal,
  operationExact: boolean,
  stateExact: boolean,
): LifecycleModelBenchmarkCaseResult {
  return {
    stepId: testCase.stepId,
    expectedOperationTypes: testCase.expectedProposal.map((row) => row.type),
    actualOperationTypes: actual.map((row) => row.type),
    operationExact,
    stateExact,
  };
}

function dryRunResult(
  profile: LifecycleModelBenchmarkProfile,
  budget: Record<string, unknown>,
): LifecycleModelBenchmarkResult {
  return deepFreeze({
    profileId: profile.profileId,
    model: profile.model,
    reconcilerVersion: profile.reconcilerVersion,
    stepIds: [...profile.stepIds],
    attemptedCount: 0,
    successCount: 0,
    failureCount: 0,
    providerHttpCalls: 0,
    maxActive: 1,
    retryCount: 0,
    repairCount: 0,
    configuredBudget: { ...budget },
    cases: profile.stepIds.map((stepId) => ({ stepId })),
    failures: [],
    aggregate: null,
    criticalCases: [...CRITICAL_STEP_IDS].map((stepId) => ({ stepId, exact: false })),
    qualityGate: 'NOT_RUN',
    actualUsage: null,
    actualCostUsd: null,
    semanticReview: {
      status: 'required',
      reason: 'Structural evaluator does not judge claim meaning or forbidden remembered meaning',
    },
  });
}

function publicFailure(
  testCase: PreparedLifecycleModelCase,
  stage: FailureStage,
  diagnosticCode: PublicDiagnostic,
) {
  return {
    case: caseResult(testCase, [], false, false),
    failure: { stepId: testCase.stepId, stage, diagnosticCode },
    detail: { testCase, predictedOperations: [] as MemoryV3LifecycleProposal, evaluation: null },
  };
}

export async function runLifecycleModelBenchmark(options: {
  profileId: string;
  dataset: unknown;
  model: string;
  budget: Record<string, unknown>;
  execute: boolean;
  adapter?: MemoryV3LifecycleModelAdapter;
}): Promise<LifecycleModelBenchmarkResult> {
  const root = inspectOptions(options);
  let profile: LifecycleModelBenchmarkProfile;
  try {
    profile = getLifecycleModelBenchmarkProfile(root.profileId);
  } catch {
    fail('lifecycle_model_unknown_failure', 'profile is invalid');
  }
  if (typeof root.model !== 'string' || root.model !== profile.model) {
    fail('lifecycle_model_unknown_failure', 'model is invalid');
  }
  if (typeof root.execute !== 'boolean') fail('lifecycle_model_unknown_failure', 'execute is invalid');
  const budgetConfig = inspectBudget(root.budget, profile);

  let prepared: readonly PreparedLifecycleModelCase[];
  try {
    prepared = await prepareLifecycleModelBenchmarkCases({
      profileId: profile.profileId,
      dataset: root.dataset,
    });
  } catch {
    fail('lifecycle_model_unknown_failure', 'dataset preflight failed');
  }
  if (prepared.length !== profile.caseCount ||
    prepared.some((testCase, index) => testCase.stepId !== profile.stepIds[index])) {
    fail('lifecycle_model_unknown_failure', 'dataset preflight failed');
  }

  const bundles: MemoryV3LifecycleReconcileBundle[] = [];
  try {
    for (const testCase of prepared) {
      bundles.push(buildMemoryV3LifecycleReconcileRequest({
        userId: testCase.userId,
        conversationId: testCase.conversationId,
        messages: testCase.messages,
        state: testCase.state,
        extraction: testCase.extraction,
      }));
    }
  } catch {
    fail('lifecycle_model_unknown_failure', 'request preflight failed');
  }
  try {
    const encoder = new TextEncoder();
    for (const bundle of bundles) {
      if (encoder.encode(JSON.stringify(bundle.request)).byteLength > profile.maxPromptRequestBytesPerCase) {
        fail('lifecycle_model_unknown_failure', 'prompt byte preflight failed');
      }
    }
  } catch (error) {
    if (isOwnError(error)) throw error;
    fail('lifecycle_model_unknown_failure', 'prompt byte preflight failed');
  }

  let configuredBudget: Record<string, unknown>;
  try {
    configuredBudget = assertBudgetGate(budgetConfig);
  } catch {
    fail('lifecycle_model_unknown_failure', 'budget preflight failed');
  }
  if (configuredBudget.absoluteCostUsd !== profile.configuredCeilingUsd ||
    configuredBudget.absoluteMaxRequests !== profile.maxRequests ||
    configuredBudget.maxBudgetUsd !== profile.maxBudgetUsd) {
    fail('lifecycle_model_unknown_failure', 'budget preflight failed');
  }

  if (root.execute === false) {
    const result = dryRunResult(profile, configuredBudget);
    PACKET_DETAILS.set(result, {
      dataset: root.dataset,
      profile,
      cases: prepared.map((testCase) => ({ testCase, predictedOperations: [], evaluation: null })),
    });
    return result;
  }
  if (typeof root.adapter !== 'function') fail('lifecycle_model_unknown_failure', 'adapter is invalid');
  const bounded = createAtMostTwelveLifecycleAdapter({ adapter: root.adapter as MemoryV3LifecycleModelAdapter });
  const caseResults: LifecycleModelBenchmarkCaseResult[] = [];
  const failures: LifecycleModelBenchmarkResult['failures'] = [];
  const stepReports: any[] = [];
  const reviewCases: ReviewCaseDetail[] = [];
  const usages: NonNullable<MemoryV3LifecycleTransportResult['usage']>[] = [];
  let successfulTransportCount = 0;
  let attemptedCount = 0;
  let active = 0;
  let maxActive = 0;

  for (let index = 0; index < prepared.length; index += 1) {
    const testCase = prepared[index];
    const bundle = bundles[index];
    attemptedCount += 1;
    let transport: MemoryV3LifecycleTransportResult;
    try {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        transport = inspectTransportResult(await bounded(bundle.request));
      } finally {
        active -= 1;
      }
    } catch (error) {
      const failed = publicFailure(testCase, 'transport', safeTransportDiagnostic(error));
      caseResults.push(failed.case);
      failures.push(failed.failure);
      reviewCases.push(failed.detail);
      continue;
    }
    successfulTransportCount += 1;
    if (transport.usage !== null) usages.push(transport.usage);

    let parsed: unknown;
    try {
      parsed = parseJsonDataOnly(transport.rawContent);
    } catch {
      const failed = publicFailure(testCase, 'parse', 'lifecycle_model_parse_invalid');
      caseResults.push(failed.case);
      failures.push(failed.failure);
      reviewCases.push(failed.detail);
      continue;
    }

    let proposal: MemoryV3LifecycleProposal;
    try {
      proposal = validateMemoryV3LifecycleProposal(parsed, {
        state: testCase.state,
        extraction: testCase.extraction,
        bindings: bundle.bindings,
      });
    } catch (error) {
      const failed = publicFailure(testCase, 'contract', safeContractDiagnostic(error));
      caseResults.push(failed.case);
      failures.push(failed.failure);
      reviewCases.push(failed.detail);
      continue;
    }

    let applied: any;
    let replay: any;
    try {
      applied = await applyMemoryV3LifecycleStep({
        state: testCase.state,
        at: testCase.at,
        conversationId: testCase.conversationId,
        extraction: testCase.extraction,
        proposal,
        trustedForgetMemoryKeys: [],
      });
      replay = await applyMemoryV3LifecycleStep({
        state: testCase.state,
        at: testCase.at,
        conversationId: testCase.conversationId,
        extraction: testCase.extraction,
        proposal,
        trustedForgetMemoryKeys: [],
      });
    } catch (error) {
      const failed = publicFailure(testCase, 'reducer', safeReducerDiagnostic(error));
      caseResults.push(failed.case);
      failures.push(failed.failure);
      reviewCases.push({ ...failed.detail, predictedOperations: proposal });
      continue;
    }

    let evaluation: any;
    try {
      evaluation = evaluateLifecycleStep({
        expectedState: testCase.expectedState,
        actualState: {
          scenarioId: testCase.scenarioId,
          nextMemoryOrdinal: applied.state.nextMemoryOrdinal,
          items: applied.state.items,
        },
        transitions: buildTransitionContext(testCase, proposal, applied, replay),
      });
    } catch {
      const failed = publicFailure(testCase, 'evaluation', 'lifecycle_model_evaluation_invalid');
      caseResults.push(failed.case);
      failures.push(failed.failure);
      reviewCases.push({ ...failed.detail, predictedOperations: proposal });
      continue;
    }
    const operationIsExact = proposalExact(testCase.expectedProposal, proposal);
    const stateIsExact = evaluation.counts.exactStateMatchedCount === 1;
    caseResults.push(caseResult(testCase, proposal, operationIsExact, stateIsExact));
    stepReports.push(evaluation);
    reviewCases.push({ testCase, predictedOperations: proposal, evaluation });
  }

  let aggregate: any | null = null;
  if (stepReports.length > 0) {
    try {
      aggregate = evaluateLifecycleScenario({
        scenario: { scenarioId: profile.profileId },
        stepResults: stepReports,
      });
    } catch {
      fail('lifecycle_model_evaluation_invalid', 'aggregate evaluation failed');
    }
  }
  const criticalCases = [...CRITICAL_STEP_IDS].map((stepId) => {
    const entry = caseResults.find((row) => row.stepId === stepId);
    return { stepId, exact: entry?.operationExact === true && entry?.stateExact === true };
  });
  let qualityGate: 'PASS' | 'FAIL' = 'FAIL';
  if (attemptedCount === profile.caseCount && failures.length === 0 &&
    bounded.callCount === profile.maxRequests && maxActive === 1 &&
    caseResults.every((entry) => entry.operationExact && entry.stateExact) &&
    criticalCases.every((entry) => entry.exact) && aggregate !== null) {
    try {
      assertLifecycleHardGates(aggregate);
      qualityGate = 'PASS';
    } catch {
      qualityGate = 'FAIL';
    }
  }

  let actualUsage: LifecycleModelBenchmarkResult['actualUsage'] = null;
  let actualCostUsd: number | null = null;
  if (usages.length === successfulTransportCount && successfulTransportCount > 0) {
    actualUsage = {
      promptTokens: usages.reduce((sum, row) => sum + row.promptTokens, 0),
      completionTokens: usages.reduce((sum, row) => sum + row.completionTokens, 0),
    };
    const costNanodollars = usages.reduce((sum, row) => sum + Math.round(row.costUsd * 1_000_000_000), 0);
    actualCostUsd = costNanodollars / 1_000_000_000;
  }
  const result = deepFreeze<LifecycleModelBenchmarkResult>({
    profileId: profile.profileId,
    model: profile.model,
    reconcilerVersion: profile.reconcilerVersion,
    stepIds: [...profile.stepIds],
    attemptedCount,
    successCount: profile.caseCount - failures.length,
    failureCount: failures.length,
    providerHttpCalls: bounded.callCount,
    maxActive,
    retryCount: 0,
    repairCount: 0,
    configuredBudget: { ...configuredBudget },
    cases: caseResults,
    failures,
    aggregate,
    criticalCases,
    qualityGate,
    actualUsage,
    actualCostUsd,
    semanticReview: {
      status: 'required',
      reason: 'Structural evaluator does not judge claim meaning or forbidden remembered meaning',
    },
  });
  PACKET_DETAILS.set(result, { dataset: root.dataset, profile, cases: reviewCases });
  return result;
}

export function buildLifecycleModelReviewPacket(options: {
  profileId: string;
  dataset: unknown;
  benchmarkResult: LifecycleModelBenchmarkResult;
}): LifecycleModelReviewPacket {
  const root = strictRecord(
    options,
    ['profileId', 'dataset', 'benchmarkResult'],
    ['profileId', 'dataset', 'benchmarkResult'],
    'review packet input is invalid',
  );
  let profile: LifecycleModelBenchmarkProfile;
  try {
    profile = getLifecycleModelBenchmarkProfile(root.profileId);
  } catch {
    fail('lifecycle_model_unknown_failure', 'review packet profile is invalid');
  }
  if (typeof root.benchmarkResult !== 'object' || root.benchmarkResult === null) {
    fail('lifecycle_model_unknown_failure', 'review packet result is invalid');
  }
  const details = PACKET_DETAILS.get(root.benchmarkResult as object);
  if (!details || details.dataset !== root.dataset || details.profile !== profile) {
    fail('lifecycle_model_unknown_failure', 'review packet result is invalid');
  }
  const result = root.benchmarkResult as LifecycleModelBenchmarkResult;
  if (result.profileId !== profile.profileId || result.model !== profile.model ||
    result.reconcilerVersion !== profile.reconcilerVersion ||
    result.stepIds.length !== profile.stepIds.length ||
    result.stepIds.some((stepId, index) => stepId !== profile.stepIds[index])) {
    fail('lifecycle_model_unknown_failure', 'review packet result is invalid');
  }
  return {
    profileId: profile.profileId,
    model: profile.model,
    reconcilerVersion: profile.reconcilerVersion,
    cases: details.cases.map(({ testCase, predictedOperations, evaluation }) => ({
      stepId: testCase.stepId,
      scenarioId: testCase.scenarioId,
      messages: testCase.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
      expectedOperations: testCase.expectedProposal.map((row) => ({ ...row })),
      predictedOperations: predictedOperations.map((row) => ({ ...row })),
      evaluation: evaluation === null ? null : cloneJsonData(evaluation, 'review packet result is invalid'),
      semanticVerdict: null,
      forbiddenMeaningVerdict: null,
      reviewerNotes: null,
    })),
  };
}
