import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  canonicalLifecycleHistoryDigest,
  type LifecycleHistoryBackfillManifest,
  type PreparedLifecycleHistoryBackfill,
} from './lifecycle-history-backfill-contract.ts';
import {
  calculateLifecycleHistoryBudget,
  getLifecycleHistoryBackfillProfile,
  validateLifecycleHistoryPriceSnapshot,
  type LifecycleHistoryBackfillProfile,
  type LifecycleHistoryPriceSnapshot,
} from './lifecycle-history-backfill-profile.ts';
import { canonicalStringify } from './contracts.mjs';
import {
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
} from '../../supabase/functions/_shared/memoryV3/contract.ts';
import { buildMemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import type {
  MemoryV3ModelAdapter,
  MemoryV3TransportResult,
} from '../../supabase/functions/_shared/memoryV3/transport.ts';
import {
  validateMemoryV3LifecycleProposal,
  validateMemoryV3LifecycleState,
  type MemoryV3LifecycleState,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';
import { buildMemoryV3LifecycleReconcileRequest } from '../../supabase/functions/_shared/memoryV3/lifecyclePrompt.ts';
import type {
  MemoryV3LifecycleModelAdapter,
  MemoryV3LifecycleTransportResult,
} from '../../supabase/functions/_shared/memoryV3/lifecycleTransport.ts';
import {
  applyMemoryV3LifecycleStep,
  createEmptyMemoryV3LifecycleState,
} from '../../supabase/functions/_shared/memoryV3/lifecycleReducer.ts';

export type LifecycleHistoryBackfillStage =
  | 'extractor_transport'
  | 'extractor_parse'
  | 'extractor_contract'
  | 'reconciler_request'
  | 'reconciler_transport'
  | 'reconciler_parse'
  | 'reconciler_contract'
  | 'reducer';

export interface LifecycleHistoryBackfillResult {
  schemaVersion: 'memory-v3-lifecycle-history-result-v1';
  profileId: 'memory-v3-lifecycle-history-backfill-v1';
  model: 'google/gemini-3.7-flash';
  manifest: LifecycleHistoryBackfillManifest;
  priceSnapshot: LifecycleHistoryPriceSnapshot;
  budget: {
    maxRequests: number;
    reservedInputTokensPerCall: 32_768;
    maxOutputTokensPerCall: 1_200;
    ceilingUsd: string;
    hardMaxUsd: string;
    gate: 'PASS';
  };
  execute: boolean;
  attemptedChunkCount: number;
  successChunkCount: number;
  failureCount: number;
  providerCallCount: number;
  maxActive: 1;
  retryCount: 0;
  repairCount: 0;
  fallbackCount: 0;
  finalState: MemoryV3LifecycleState | null;
  chunks: Array<{
    chunkId: string;
    status: 'succeeded';
    changed: boolean;
    resultingStateRevision: number;
    itemCount: number;
    evidenceCount: number;
    transitionTypes: string[];
  }>;
  failures: Array<{
    chunkId: string;
    stage: LifecycleHistoryBackfillStage;
    diagnosticCode: string;
  }>;
  actualUsage: { promptTokens: number; completionTokens: number } | null;
  actualCostUsd: number | null;
  semanticReview: { status: 'required' };
}

type JsonRecord = Record<string, unknown>;
type Usage = { promptTokens: number; completionTokens: number; costUsd: number };
type ReviewPacket = {
  schemaVersion: 'memory-v3-lifecycle-history-review-packet-v1';
  payloadSha256: string;
  items: Array<{
    memoryKey: string;
    kind: string;
    claim: string;
    status: string;
    sensitivity: string;
    alternative: string | null;
    evidence: Array<{
      sourceMessageId: string;
      relation: string;
      supportType: string | null;
      episodeKey: string | null;
      mentionTime: string;
    }>;
    semanticVerdict: null;
    reviewerNotes: null;
  }>;
};

const OPTIONS_FIELDS = [
  'profileId', 'prepared', 'priceSnapshot', 'maxBudgetUsd', 'nowMs', 'execute',
  'extractorAdapter', 'reconcilerAdapter',
] as const;
const REQUIRED_OPTIONS_FIELDS = [
  'profileId', 'prepared', 'priceSnapshot', 'maxBudgetUsd', 'nowMs', 'execute',
] as const;
const TRANSPORT_FIELDS = ['content', 'usage'] as const;
const RECONCILER_TRANSPORT_FIELDS = ['rawContent', 'usage'] as const;
const USAGE_FIELDS = ['promptTokens', 'completionTokens', 'costUsd'] as const;
const PREPARED_FIELDS = ['userId', 'manifest', 'chunks'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OWN_ERRORS = new WeakSet<object>();
const ERROR_DETAILS = new WeakMap<object, { stage: LifecycleHistoryBackfillStage | null; code: string }>();
const AUTHENTIC_RESULTS = new WeakSet<object>();

function fail(stage: LifecycleHistoryBackfillStage | null, code: string): never {
  const error = new Error('[memory-v3:lifecycle-history-backfill-engine] operation failed');
  error.name = 'MemoryV3LifecycleHistoryBackfillEngineError';
  OWN_ERRORS.add(error);
  ERROR_DETAILS.set(error, { stage, code });
  throw error;
}

function details(error: unknown): { stage: LifecycleHistoryBackfillStage | null; code: string } | null {
  return typeof error === 'object' && error !== null && OWN_ERRORS.has(error)
    ? ERROR_DETAILS.get(error) ?? null
    : null;
}

function safeKeys(value: object, stage: LifecycleHistoryBackfillStage | null): PropertyKey[] {
  try {
    if (isProxy(value)) fail(stage, stage === null ? 'preflight_invalid' : `${stage}_invalid`);
    return Reflect.ownKeys(value);
  } catch (error) {
    if (details(error)) throw error;
    fail(stage, stage === null ? 'preflight_invalid' : `${stage}_invalid`);
  }
}

function strictRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  stage: LifecycleHistoryBackfillStage | null,
  code: string,
): JsonRecord {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
    fail(stage, code);
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(stage, code);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(stage, code);
  const keys = safeKeys(value, stage);
  const output: JsonRecord = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(stage, code);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(stage, code);
    }
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor) || descriptor.value === undefined) {
      fail(stage, code);
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const field of required) if (!Object.hasOwn(output, field)) fail(stage, code);
  return output;
}

function cloneJsonData(
  value: unknown,
  stage: LifecycleHistoryBackfillStage | null,
  code: string,
  active = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(stage, code);
    return value;
  }
  if (typeof value !== 'object' || isProxy(value) || active.has(value)) fail(stage, code);
  active.add(value);
  try {
    const keys = safeKeys(value, stage);
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 || keys.length !== lengthDescriptor.value + 1) fail(stage, code);
      const output: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor) || descriptor.value === undefined) {
          fail(stage, code);
        }
        output.push(cloneJsonData(descriptor.value, stage, code, active));
      }
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= output.length) {
          fail(stage, code);
        }
      }
      return output;
    }
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      fail(stage, code);
    }
    if (prototype !== Object.prototype && prototype !== null) fail(stage, code);
    const output: JsonRecord = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') fail(stage, code);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor) || descriptor.value === undefined) {
        fail(stage, code);
      }
      Object.defineProperty(output, key, {
        value: cloneJsonData(descriptor.value, stage, code, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } catch (error) {
    if (details(error)) throw error;
    fail(stage, code);
  } finally {
    active.delete(value);
  }
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

function assertUtf8BytesAtMost(
  request: unknown,
  limit: number,
  stage: 'extractor_contract' | 'reconciler_request',
  exactBytes?: number,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    fail(stage, `${stage}_invalid`);
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > limit || (exactBytes !== undefined && bytes !== exactBytes)) {
    fail(stage, `${stage}_bytes_invalid`);
  }
}

function assertExtractorRequestDigest(request: unknown, expected: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    fail('extractor_contract', 'extractor_request_digest_invalid');
  }
  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  if (!SHA256.test(expected) || digest !== expected) {
    fail('extractor_contract', 'extractor_request_digest_invalid');
  }
}

function validatePreparedUnsafe(value: unknown, profile: LifecycleHistoryBackfillProfile): PreparedLifecycleHistoryBackfill {
  const cloned = cloneJsonData(value, null, 'prepared_invalid') as JsonRecord;
  const root = strictRecord(cloned, PREPARED_FIELDS, PREPARED_FIELDS, null, 'prepared_invalid');
  if (typeof root.userId !== 'string' || !UUID.test(root.userId)) fail(null, 'prepared_invalid');
  const prepared = root as unknown as PreparedLifecycleHistoryBackfill;
  if (!Array.isArray(prepared.chunks) || prepared.chunks.length === 0) fail(null, 'prepared_invalid');
  const manifest = prepared.manifest;
  if (!manifest || manifest.schemaVersion !== 'memory-v3-lifecycle-history-manifest-v1' ||
    manifest.profileId !== profile.profileId || manifest.chunkCount !== prepared.chunks.length ||
    manifest.maxProviderCalls !== prepared.chunks.length * profile.maxCallsPerChunk ||
    manifest.chunks.length !== prepared.chunks.length || !SHA256.test(manifest.sourceSnapshotDigest)) {
    fail(null, 'prepared_invalid');
  }
  let messageCount = 0;
  let userMessageCount = 0;
  const chunkIds = new Set<string>();
  for (let index = 0; index < prepared.chunks.length; index += 1) {
    const chunk = prepared.chunks[index];
    const projected = manifest.chunks[index];
    if (!chunk || !projected || chunkIds.has(chunk.chunkId) ||
      chunk.messageCount !== chunk.messages.length || chunk.messageCount <= 0 ||
      chunk.messageCount > profile.maxMessagesPerChunk ||
      chunk.userMessageCount !== chunk.messages.filter((row) => row.role === 'user').length ||
      chunk.userMessageCount <= 0 ||
      chunk.sourceDigest !== canonicalLifecycleHistoryDigest({
        conversationId: chunk.conversationId,
        messages: chunk.messages,
      }) ||
      chunk.chunkId !== canonicalLifecycleHistoryDigest([
        profile.profileId, chunk.sourceDigest, chunk.conversationOrdinal, chunk.chunkOrdinal,
      ])) {
      fail(null, 'prepared_invalid');
    }
    const projection = {
      chunkId: chunk.chunkId,
      conversationOrdinal: chunk.conversationOrdinal,
      chunkOrdinal: chunk.chunkOrdinal,
      messageCount: chunk.messageCount,
      userMessageCount: chunk.userMessageCount,
      firstCreatedAt: chunk.firstCreatedAt,
      lastCreatedAt: chunk.lastCreatedAt,
      extractorRequestBytes: chunk.extractorRequestBytes,
      extractorRequestSha256: chunk.extractorRequestSha256,
      sourceDigest: chunk.sourceDigest,
    };
    if (canonicalStringify(projection) !== canonicalStringify(projected)) fail(null, 'prepared_invalid');
    chunkIds.add(chunk.chunkId);
    messageCount += chunk.messageCount;
    userMessageCount += chunk.userMessageCount;
  }
  if (manifest.messageCount !== messageCount || manifest.userMessageCount !== userMessageCount ||
    manifest.conversationCount !== manifest.conversations.length) fail(null, 'prepared_invalid');
  return prepared;
}

function validatePrepared(value: unknown, profile: LifecycleHistoryBackfillProfile): PreparedLifecycleHistoryBackfill {
  try {
    return validatePreparedUnsafe(value, profile);
  } catch (error) {
    if (details(error)) throw error;
    fail(null, 'prepared_invalid');
  }
}

function parseJsonDataOnly(raw: unknown, stage: 'extractor_parse' | 'reconciler_parse'): unknown {
  if (typeof raw !== 'string') fail(stage, `${stage}_invalid`);
  try {
    return cloneJsonData(JSON.parse(raw), stage, `${stage}_invalid`);
  } catch (error) {
    if (details(error)?.stage === stage) throw error;
    fail(stage, `${stage}_invalid`);
  }
}

function inspectUsage(value: unknown, stage: 'extractor_transport' | 'reconciler_transport'): Usage | null {
  if (value === null) return null;
  const usage = strictRecord(value, USAGE_FIELDS, USAGE_FIELDS, stage, `${stage}_invalid`);
  if (!Number.isSafeInteger(usage.promptTokens) || (usage.promptTokens as number) < 0 ||
    !Number.isSafeInteger(usage.completionTokens) || (usage.completionTokens as number) < 0 ||
    typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    fail(stage, `${stage}_invalid`);
  }
  return usage as Usage;
}

function inspectExtractorTransport(value: unknown): MemoryV3TransportResult {
  const root = strictRecord(value, TRANSPORT_FIELDS, TRANSPORT_FIELDS, 'extractor_transport', 'extractor_transport_invalid');
  if (typeof root.content !== 'string') fail('extractor_transport', 'extractor_transport_invalid');
  return { content: root.content, usage: inspectUsage(root.usage, 'extractor_transport') };
}

function inspectReconcilerTransport(value: unknown): MemoryV3LifecycleTransportResult {
  const root = strictRecord(
    value,
    RECONCILER_TRANSPORT_FIELDS,
    RECONCILER_TRANSPORT_FIELDS,
    'reconciler_transport',
    'reconciler_transport_invalid',
  );
  if (typeof root.rawContent !== 'string') fail('reconciler_transport', 'reconciler_transport_invalid');
  return { rawContent: root.rawContent, usage: inspectUsage(root.usage, 'reconciler_transport') };
}

function inspectAdapter(value: unknown): void {
  if (typeof value !== 'function' || isProxy(value)) fail(null, 'adapter_invalid');
}

function buildBaseResult(
  profile: LifecycleHistoryBackfillProfile,
  prepared: PreparedLifecycleHistoryBackfill,
  priceSnapshot: LifecycleHistoryPriceSnapshot,
  hardMaxUsd: string,
  ceilingUsd: string,
  maxRequests: number,
  execute: boolean,
): Omit<LifecycleHistoryBackfillResult,
  'attemptedChunkCount' | 'successChunkCount' | 'failureCount' | 'providerCallCount' |
  'finalState' | 'chunks' | 'failures' | 'actualUsage' | 'actualCostUsd'> {
  return {
    schemaVersion: 'memory-v3-lifecycle-history-result-v1',
    profileId: profile.profileId,
    model: profile.model,
    manifest: prepared.manifest,
    priceSnapshot,
    budget: {
      maxRequests,
      reservedInputTokensPerCall: profile.reservedInputTokensPerCall,
      maxOutputTokensPerCall: profile.maxOutputTokensPerCall,
      ceilingUsd,
      hardMaxUsd,
      gate: 'PASS',
    },
    execute,
    maxActive: 1,
    retryCount: 0,
    repairCount: 0,
    fallbackCount: 0,
    semanticReview: { status: 'required' },
  };
}

export async function runLifecycleHistoryBackfill(input: {
  profileId: unknown;
  prepared: unknown;
  priceSnapshot: unknown;
  maxBudgetUsd: unknown;
  nowMs: number;
  execute: unknown;
  extractorAdapter?: MemoryV3ModelAdapter;
  reconcilerAdapter?: MemoryV3LifecycleModelAdapter;
}): Promise<LifecycleHistoryBackfillResult> {
  const root = strictRecord(input, OPTIONS_FIELDS, REQUIRED_OPTIONS_FIELDS, null, 'options_invalid');
  const profileDescriptor = Object.getOwnPropertyDescriptor(root, 'profileId');
  if (!profileDescriptor || !('value' in profileDescriptor) || profileDescriptor.enumerable !== true) {
    fail(null, 'profile_invalid');
  }
  let profile: LifecycleHistoryBackfillProfile;
  try {
    profile = getLifecycleHistoryBackfillProfile(root.profileId);
  } catch {
    fail(null, 'profile_invalid');
  }
  const prepared = validatePrepared(root.prepared, profile);
  let priceSnapshot: LifecycleHistoryPriceSnapshot;
  try {
    priceSnapshot = validateLifecycleHistoryPriceSnapshot(root.priceSnapshot, root.nowMs as number);
  } catch {
    fail(null, 'price_snapshot_invalid');
  }
  if (typeof root.maxBudgetUsd !== 'string') fail(null, 'budget_invalid');
  let budget: ReturnType<typeof calculateLifecycleHistoryBudget>;
  try {
    budget = calculateLifecycleHistoryBudget({
      chunkCount: prepared.chunks.length,
      priceSnapshot,
      maxBudgetUsd: root.maxBudgetUsd,
    });
  } catch {
    fail(null, 'budget_invalid');
  }
  for (const chunk of prepared.chunks) {
    let dialogue;
    let request;
    try {
      dialogue = validateMemoryV3Dialogue({
        caseId: `memory-v3-shadow:${prepared.userId}:${chunk.conversationId}`,
        messages: chunk.messages,
      });
      request = buildMemoryV3ExtractorRequest(dialogue);
    } catch {
      fail(null, 'prepared_invalid');
    }
    assertUtf8BytesAtMost(request, profile.maxExtractorRequestBytes, 'extractor_contract', chunk.extractorRequestBytes);
    assertExtractorRequestDigest(request, chunk.extractorRequestSha256);
  }
  if (prepared.manifest.maxProviderCalls !== budget.maxRequests) fail(null, 'provider_call_cap_invalid');
  if (typeof root.execute !== 'boolean') fail(null, 'execute_invalid');
  const base = buildBaseResult(
    profile,
    prepared,
    priceSnapshot,
    root.maxBudgetUsd,
    budget.ceilingUsd,
    budget.maxRequests,
    root.execute,
  );
  if (root.execute === false) {
    const result = deepFreeze<LifecycleHistoryBackfillResult>({
      ...base,
      attemptedChunkCount: 0,
      successChunkCount: 0,
      failureCount: 0,
      providerCallCount: 0,
      finalState: null,
      chunks: [],
      failures: [],
      actualUsage: null,
      actualCostUsd: null,
    });
    AUTHENTIC_RESULTS.add(result);
    return result;
  }

  inspectAdapter(root.extractorAdapter);
  inspectAdapter(root.reconcilerAdapter);
  const extractorAdapter = root.extractorAdapter as MemoryV3ModelAdapter;
  const reconcilerAdapter = root.reconcilerAdapter as MemoryV3LifecycleModelAdapter;
  let providerCallCount = 0;
  const usages: Usage[] = [];
  let successfulTransportCount = 0;
  const callExtractorOnce = async (request: Parameters<MemoryV3ModelAdapter>[0]) => {
    if (providerCallCount >= budget.maxRequests) fail('extractor_transport', 'provider_call_cap_exceeded');
    providerCallCount += 1;
    let raw: unknown;
    try {
      raw = await extractorAdapter(request);
    } catch {
      fail('extractor_transport', 'extractor_transport_failed');
    }
    const inspected = inspectExtractorTransport(raw);
    successfulTransportCount += 1;
    if (inspected.usage !== null) usages.push(inspected.usage);
    return inspected;
  };
  const callReconcilerOnce = async (request: Parameters<MemoryV3LifecycleModelAdapter>[0]) => {
    if (providerCallCount >= budget.maxRequests) fail('reconciler_transport', 'provider_call_cap_exceeded');
    providerCallCount += 1;
    let raw: unknown;
    try {
      raw = await reconcilerAdapter(request);
    } catch {
      fail('reconciler_transport', 'reconciler_transport_failed');
    }
    const inspected = inspectReconcilerTransport(raw);
    successfulTransportCount += 1;
    if (inspected.usage !== null) usages.push(inspected.usage);
    return inspected;
  };

  let state = createEmptyMemoryV3LifecycleState({ userId: prepared.userId });
  const chunkResults: LifecycleHistoryBackfillResult['chunks'] = [];
  const failures: LifecycleHistoryBackfillResult['failures'] = [];
  let attemptedChunkCount = 0;
  for (const chunk of prepared.chunks) {
    attemptedChunkCount += 1;
    try {
      const dialogue = validateMemoryV3Dialogue({
        caseId: `memory-v3-shadow:${prepared.userId}:${chunk.conversationId}`,
        messages: chunk.messages,
      });
      const extractorRequest = buildMemoryV3ExtractorRequest(dialogue);
      assertUtf8BytesAtMost(
        extractorRequest,
        profile.maxExtractorRequestBytes,
        'extractor_contract',
        chunk.extractorRequestBytes,
      );
      assertExtractorRequestDigest(extractorRequest, chunk.extractorRequestSha256);
      const extractorTransport = await callExtractorOnce(extractorRequest);
      const parsedExtraction = parseJsonDataOnly(extractorTransport.content, 'extractor_parse');
      let extraction;
      try {
        extraction = await normalizeMemoryV3LayeredResponse(
          parsedExtraction,
          dialogue,
          profile.extractorVersion,
        );
      } catch {
        fail('extractor_contract', 'extractor_contract_invalid');
      }
      let reconcileBundle;
      try {
        reconcileBundle = buildMemoryV3LifecycleReconcileRequest({
          userId: prepared.userId,
          conversationId: chunk.conversationId,
          messages: chunk.messages,
          state,
          extraction,
        });
        assertUtf8BytesAtMost(
          reconcileBundle.request,
          profile.maxReconcilerRequestBytes,
          'reconciler_request',
        );
      } catch (error) {
        if (details(error)?.stage === 'reconciler_request') throw error;
        fail('reconciler_request', 'reconciler_request_invalid');
      }
      const reconcilerTransport = await callReconcilerOnce(reconcileBundle.request);
      const parsedProposal = parseJsonDataOnly(reconcilerTransport.rawContent, 'reconciler_parse');
      let proposal;
      try {
        proposal = validateMemoryV3LifecycleProposal(parsedProposal, {
          state,
          extraction,
          bindings: reconcileBundle.bindings,
        });
      } catch {
        fail('reconciler_contract', 'reconciler_contract_invalid');
      }
      let reduced;
      try {
        reduced = await applyMemoryV3LifecycleStep({
          state,
          at: chunk.lastCreatedAt,
          conversationId: chunk.conversationId,
          extraction,
          proposal,
          trustedForgetMemoryKeys: [],
        });
        state = validateMemoryV3LifecycleState({
          ...reduced.state,
          stateRevision: state.stateRevision + (reduced.changed ? 1 : 0),
        }, prepared.userId);
      } catch {
        fail('reducer', 'reducer_invalid');
      }
      chunkResults.push({
        chunkId: chunk.chunkId,
        status: 'succeeded',
        changed: reduced.changed,
        resultingStateRevision: state.stateRevision,
        itemCount: state.items.length,
        evidenceCount: state.items.reduce((sum, item) => sum + item.evidence.length, 0),
        transitionTypes: reduced.transitions.map((transition) => transition.type),
      });
    } catch (error) {
      const own = details(error);
      const stage = own?.stage ?? 'reducer';
      failures.push({
        chunkId: chunk.chunkId,
        stage,
        diagnosticCode: own?.code ?? 'reducer_invalid',
      });
      break;
    }
  }

  let actualUsage: LifecycleHistoryBackfillResult['actualUsage'] = null;
  let actualCostUsd: number | null = null;
  if (successfulTransportCount > 0 && usages.length === successfulTransportCount) {
    actualUsage = {
      promptTokens: usages.reduce((sum, usage) => sum + usage.promptTokens, 0),
      completionTokens: usages.reduce((sum, usage) => sum + usage.completionTokens, 0),
    };
    const nanodollars = usages.reduce(
      (sum, usage) => sum + Math.round(usage.costUsd * 1_000_000_000),
      0,
    );
    actualCostUsd = nanodollars / 1_000_000_000;
  }
  const complete = failures.length === 0 && chunkResults.length === prepared.chunks.length &&
    providerCallCount === budget.maxRequests;
  const result = deepFreeze<LifecycleHistoryBackfillResult>({
    ...base,
    attemptedChunkCount,
    successChunkCount: chunkResults.length,
    failureCount: failures.length,
    providerCallCount,
    finalState: complete ? state : null,
    chunks: chunkResults,
    failures,
    actualUsage,
    actualCostUsd,
  });
  AUTHENTIC_RESULTS.add(result);
  return result;
}

export function buildLifecycleHistoryReviewPacket(result: unknown): ReviewPacket {
  if (typeof result !== 'object' || result === null || !AUTHENTIC_RESULTS.has(result)) {
    fail(null, 'review_result_invalid');
  }
  const benchmarkResult = result as LifecycleHistoryBackfillResult;
  if (!benchmarkResult.execute || benchmarkResult.failureCount !== 0 ||
    benchmarkResult.finalState === null ||
    benchmarkResult.successChunkCount !== benchmarkResult.manifest.chunkCount) {
    fail(null, 'review_result_invalid');
  }
  const items = benchmarkResult.finalState.items.map((item) => ({
    memoryKey: item.memoryKey,
    kind: item.kind,
    claim: item.claim,
    status: item.status,
    sensitivity: item.sensitivity,
    alternative: item.alternative,
    evidence: item.evidence.map((evidence) => ({
      sourceMessageId: evidence.sourceMessageId,
      relation: evidence.relation,
      supportType: evidence.supportType,
      episodeKey: evidence.episodeKey,
      mentionTime: evidence.mentionTime,
    })),
    semanticVerdict: null,
    reviewerNotes: null,
  }));
  const payloadSha256 = createHash('sha256')
    .update(canonicalStringify({ benchmarkResult, items }), 'utf8')
    .digest('hex');
  return deepFreeze({
    schemaVersion: 'memory-v3-lifecycle-history-review-packet-v1',
    payloadSha256,
    items,
  });
}
