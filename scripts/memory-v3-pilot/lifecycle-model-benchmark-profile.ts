/** Frozen configuration for the synthetic Memory V3 lifecycle model benchmark. */

export const LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID =
  'lifecycle-reconciler-critical-twelve-v1' as const;

export interface LifecycleModelBenchmarkProfile {
  profileId: typeof LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID;
  datasetId: 'memory-v3-synthetic-lifecycle-v1';
  datasetVersion: '1.0.0';
  model: 'google/gemini-3.7-flash';
  reconcilerVersion: 'memory-v3-lifecycle-reconciler-v1';
  stepIds: readonly string[];
  caseCount: 12;
  maxRequests: 12;
  maxPromptRequestBytesPerCase: 80_000;
  maxInputTokensPerCase: 32_768;
  maxOutputTokensPerCase: 1_200;
  inputUsdPerMillion: 0.75;
  outputUsdPerMillion: 3.75;
  configuredCeilingUsd: '0.348912';
  maxBudgetUsd: 0.36;
  executeFlag: '--execute-twelve-paid-requests';
}

const STEP_IDS = [
  'paraphrase-event-dedup-s02',
  'same-topic-distinct-events-s02',
  'event-date-correction-s03',
  'scope-narrowing-s03',
  'hypothesis-supported-s03',
  'hypothesis-rejected-s03',
  'recurrence-growth-s02',
  'pattern-confirmation-s03',
  'recurrence-stale-s03',
  'assistant-speculation-denied-s01',
  'prompt-injection-schema-s02',
  'layered-coexistence-s01',
] as const;

function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

const PROFILE = deepFreeze<LifecycleModelBenchmarkProfile>({
  profileId: LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID,
  datasetId: 'memory-v3-synthetic-lifecycle-v1',
  datasetVersion: '1.0.0',
  model: 'google/gemini-3.7-flash',
  reconcilerVersion: 'memory-v3-lifecycle-reconciler-v1',
  stepIds: [...STEP_IDS],
  caseCount: 12,
  maxRequests: 12,
  maxPromptRequestBytesPerCase: 80_000,
  maxInputTokensPerCase: 32_768,
  maxOutputTokensPerCase: 1_200,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  configuredCeilingUsd: '0.348912',
  maxBudgetUsd: 0.36,
  executeFlag: '--execute-twelve-paid-requests',
});

function invalidProfileId(): never {
  const error = new Error('[memory-v3:lifecycle-model-profile] invalid profile id');
  error.name = 'MemoryV3LifecycleModelBenchmarkProfileError';
  throw error;
}

export function getLifecycleModelBenchmarkProfile(
  profileId: unknown,
): LifecycleModelBenchmarkProfile {
  if (typeof profileId !== 'string' || profileId !== LIFECYCLE_MODEL_BENCHMARK_PROFILE_ID) {
    return invalidProfileId();
  }
  return PROFILE;
}
