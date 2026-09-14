/**
 * Memory V3 V2 trusted frozen live-benchmark profiles.
 * Direct lookup by primitive allowlisted profileId only.
 */

const OWN_KEYS = Object.freeze([
  'profileId',
  'caseIds',
  'model',
  'extractorVersion',
  'datasetId',
  'datasetVersion',
  'reasoningEffort',
  'maxOutputTokensPerCase',
  'maxInputTokensPerCase',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'maxBudgetUsd',
  'maxRequests',
  'caseCount',
  'timeoutMs',
  'maxResponseBytes',
  'maxPromptRequestBytesPerCase',
  'maxTokensParameter',
  'allowFallbacks',
  'responseContract',
  'executeFlag',
  'maxBudgetUsdArg',
  'engineErrorPrefix',
  'engineErrorName',
  'cliErrorPrefix',
  'cliErrorName',
  'runErrorPrefix',
  'runErrorName',
  'httpCapError',
]);

const MAX_TOKENS_PARAMETERS = new Set(['max_tokens', 'max_completion_tokens']);

function assertOwnEnumerableStringDataDescriptors(profile) {
  const names = Object.getOwnPropertyNames(profile);
  if (names.length !== OWN_KEYS.length) {
    throw new Error('profile own-key count is invalid');
  }
  const expected = [...OWN_KEYS].sort();
  const actual = [...names].sort();
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error('profile own keys are invalid');
    }
  }
  if (Object.prototype.hasOwnProperty.call(profile, 'budget')) {
    throw new Error('profile must not have budget');
  }
  if (Object.prototype.hasOwnProperty.call(profile, 'errorPrefix')) {
    throw new Error('profile must not have errorPrefix');
  }
  if (Object.prototype.hasOwnProperty.call(profile, 'errorName')) {
    throw new Error('profile must not have errorName');
  }
  for (const key of OWN_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(profile, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      Object.prototype.hasOwnProperty.call(descriptor, 'get') ||
      Object.prototype.hasOwnProperty.call(descriptor, 'set')
    ) {
      throw new Error('profile field must be an enumerable string data descriptor');
    }
  }
}

function assertCaseIds(caseIds, caseCount, maxRequests) {
  if (!Array.isArray(caseIds) || Object.getPrototypeOf(caseIds) !== Array.prototype) {
    throw new Error('caseIds must be a dense array');
  }
  if (caseIds.length !== caseCount || caseIds.length !== maxRequests) {
    throw new Error('caseCount and maxRequests must equal caseIds.length');
  }
  const seen = new Set();
  for (let index = 0; index < caseIds.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(caseIds, index)) {
      throw new Error('caseIds must be dense');
    }
    const id = caseIds[index];
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
      throw new Error('caseIds must be unique non-empty strings');
    }
    seen.add(id);
  }
}

function freezeProfile(profile) {
  assertOwnEnumerableStringDataDescriptors(profile);
  assertCaseIds(profile.caseIds, profile.caseCount, profile.maxRequests);
  if (profile.datasetId !== 'memory-v3-ru-golden-v2' || profile.datasetVersion !== '2.0.0') {
    throw new Error('dataset identity is invalid');
  }
  if (profile.responseContract !== 'v2-layered') {
    throw new Error('responseContract is invalid');
  }
  if (!MAX_TOKENS_PARAMETERS.has(profile.maxTokensParameter)) {
    throw new Error('maxTokensParameter is invalid');
  }
  if (typeof profile.executeFlag !== 'string' || !profile.executeFlag.startsWith('--')) {
    throw new Error('executeFlag is invalid');
  }
  Object.freeze(profile.caseIds);
  return Object.freeze(profile);
}

const SIX_CATEGORY_V2 = freezeProfile({
  profileId: 'six-category-v2',
  caseIds: [
    'memv3-ru-event-03',
    'memv3-ru-correction-04',
    'memv3-ru-recurrence-02',
    'memv3-ru-hypothesis-01',
    'memv3-ru-counterexample-01',
    'memv3-ru-safety-03',
  ],
  model: 'google/gemini-3.7-flash',
  extractorVersion:
    'memory-v3-openrouter-gemini-3.7-flash-six-v2-layer-decision-hypothesis-admission-r3',
  datasetId: 'memory-v3-ru-golden-v2',
  datasetVersion: '2.0.0',
  reasoningEffort: 'low',
  maxOutputTokensPerCase: 1200,
  maxInputTokensPerCase: 16384,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxBudgetUsd: 0.11,
  maxRequests: 6,
  caseCount: 6,
  timeoutMs: 60000,
  maxResponseBytes: 1000000,
  maxPromptRequestBytesPerCase: 20000,
  maxTokensParameter: 'max_tokens',
  allowFallbacks: true,
  responseContract: 'v2-layered',
  executeFlag: '--execute-six-paid-requests',
  maxBudgetUsdArg: '0.11',
  engineErrorPrefix: '[memory-v3:live-benchmark-six-v2]',
  engineErrorName: 'MemoryV3SixCaseBenchmarkV2Error',
  cliErrorPrefix: '[memory-v3:live-benchmark-six-cli-v2]',
  cliErrorName: 'MemoryV3SixCaseBenchmarkCliV2Error',
  runErrorPrefix: '[memory-v3:live-benchmark-six-run-v2]',
  runErrorName: 'MemoryV3SixCaseBenchmarkRunV2Error',
  httpCapError: 'seventh fetch is not allowed',
});

const HYPOTHESIS_FOUR_V2 = freezeProfile({
  profileId: 'hypothesis-four-v2',
  caseIds: [
    'memv3-ru-hypothesis-01',
    'memv3-ru-hypothesis-02',
    'memv3-ru-hypothesis-03',
    'memv3-ru-hypothesis-04',
  ],
  model: 'google/gemini-3.7-flash',
  extractorVersion:
    'memory-v3-openrouter-gemini-3.7-flash-hypothesis-four-v2-layer-decision-hypothesis-admission-r3',
  datasetId: 'memory-v3-ru-golden-v2',
  datasetVersion: '2.0.0',
  reasoningEffort: 'low',
  maxOutputTokensPerCase: 1200,
  maxInputTokensPerCase: 16384,
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxBudgetUsd: 0.075,
  maxRequests: 4,
  caseCount: 4,
  timeoutMs: 60000,
  maxResponseBytes: 1000000,
  maxPromptRequestBytesPerCase: 20000,
  maxTokensParameter: 'max_tokens',
  allowFallbacks: true,
  responseContract: 'v2-layered',
  executeFlag: '--execute-hypothesis-four-paid-requests',
  maxBudgetUsdArg: '0.075',
  engineErrorPrefix: '[memory-v3:live-benchmark-hypothesis-four-v2]',
  engineErrorName: 'MemoryV3HypothesisFourBenchmarkV2Error',
  cliErrorPrefix: '[memory-v3:live-benchmark-hypothesis-four-cli-v2]',
  cliErrorName: 'MemoryV3HypothesisFourBenchmarkCliV2Error',
  runErrorPrefix: '[memory-v3:live-benchmark-hypothesis-four-run-v2]',
  runErrorName: 'MemoryV3HypothesisFourBenchmarkRunV2Error',
  httpCapError: 'fifth fetch is not allowed',
});

if (SIX_CATEGORY_V2.executeFlag === HYPOTHESIS_FOUR_V2.executeFlag) {
  throw new Error('execute flags must not collide');
}

const REGISTRY = new Map([
  [SIX_CATEGORY_V2.profileId, SIX_CATEGORY_V2],
  [HYPOTHESIS_FOUR_V2.profileId, HYPOTHESIS_FOUR_V2],
]);

export function getLiveBenchmarkProfileV2(profileId) {
  if (typeof profileId !== 'string' || profileId.length === 0 || profileId.trim() !== profileId) {
    throw new Error('profileId must be a primitive non-empty exact string');
  }
  const profile = REGISTRY.get(profileId);
  if (profile === undefined) {
    throw new Error('unknown profileId');
  }
  return profile;
}
