import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { canonicalStringify } from './contracts.mjs';
import {
  getLifecycleHistoryBackfillProfile,
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
} from './lifecycle-history-backfill-profile.ts';
import {
  canonicalLifecycleHistoryDigest,
} from './lifecycle-history-backfill-contract.ts';
import {
  MEMORY_V3_EXTRACTOR_VERSION,
  validateMemoryV3Dialogue,
} from '../../supabase/functions/_shared/memoryV3/contract.ts';
import { buildMemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import {
  MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
  MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
  validateMemoryV3LifecycleState,
  type MemoryV3LifecycleState,
} from '../../supabase/functions/_shared/memoryV3/lifecycleContract.ts';

export interface LifecycleHistoryReviewDecision {
  schemaVersion: 'memory-v3-lifecycle-history-review-v1';
  payloadSha256: string;
  verdict: 'PASS';
  reviewedAt: string;
  reviewer: 'Nastya';
  items: Array<{
    memoryKey: string;
    semanticVerdict: 'PASS';
    reviewerNotes: string | null;
  }>;
}

export interface LifecycleHistoryImportClient {
  loadCurrentHead(userId: string): Promise<unknown>;
  importInitialState(input: {
    importId: string;
    userId: string;
    expectedStateRevision: 0;
    artifactDigest: string;
    sourceSnapshotDigest: string;
    sourceCutoff: string;
    profileId: string;
    pipelineVersion: string;
    extractorVersion: typeof MEMORY_V3_EXTRACTOR_VERSION;
    reconcilerVersion: string;
    state: MemoryV3LifecycleState;
  }): Promise<unknown>;
}

type JsonRecord = Record<string, unknown>;

const PREFIX = '[memory-v3:lifecycle-history-backfill-import]';
const ERROR_NAME = 'MemoryV3LifecycleHistoryBackfillImportError';
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,9}))?)?(Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/u;
const MAX_REVIEWER_NOTES = 1_000;
const OWN_ERRORS = new WeakSet<object>();
const RESULT_FIELDS = [
  'schemaVersion', 'profileId', 'model', 'manifest', 'priceSnapshot', 'budget',
  'execute', 'attemptedChunkCount', 'successChunkCount', 'failureCount',
  'providerCallCount', 'maxActive', 'retryCount', 'repairCount', 'fallbackCount',
  'finalState', 'chunks', 'failures', 'actualUsage', 'actualCostUsd', 'semanticReview',
] as const;
const MANIFEST_FIELDS = [
  'schemaVersion', 'profileId', 'sourceCutoff', 'sourceSnapshotDigest',
  'conversationCount', 'messageCount', 'userMessageCount', 'chunkCount',
  'maxProviderCalls', 'conversations', 'chunks',
] as const;
const MANIFEST_CONVERSATION_FIELDS = [
  'conversationOrdinal', 'messageCount', 'userMessageCount', 'firstCreatedAt',
  'lastCreatedAt', 'chunkCount',
] as const;
const MANIFEST_CHUNK_FIELDS = [
  'chunkId', 'conversationOrdinal', 'chunkOrdinal', 'messageCount',
  'userMessageCount', 'firstCreatedAt', 'lastCreatedAt', 'extractorRequestBytes',
  'extractorRequestSha256', 'sourceDigest',
] as const;
const RESULT_CHUNK_FIELDS = [
  'chunkId', 'status', 'changed', 'resultingStateRevision', 'itemCount',
  'evidenceCount', 'transitionTypes',
] as const;
const PREPARED_CHUNK_FIELDS = [
  'chunkId', 'conversationOrdinal', 'chunkOrdinal', 'conversationId', 'messages',
  'firstCreatedAt', 'lastCreatedAt', 'firstMessageId', 'lastMessageId',
  'messageCount', 'userMessageCount', 'extractorRequestBytes',
  'extractorRequestSha256', 'sourceDigest',
] as const;

function fail(): never {
  const error = new Error(`${PREFIX} import failed`);
  error.name = ERROR_NAME;
  OWN_ERRORS.add(error);
  throw error;
}

function isValidDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth && Number.isFinite(Date.parse(value));
}

function ownKeys(value: object): PropertyKey[] {
  try {
    if (isProxy(value)) return fail();
    return Reflect.ownKeys(value);
  } catch {
    return fail();
  }
}

function prototype(value: object): object | null {
  try {
    if (isProxy(value)) return fail();
    return Object.getPrototypeOf(value);
  } catch {
    return fail();
  }
}

function descriptorValue(value: object, key: PropertyKey, enumerable: boolean): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== enumerable || !('value' in descriptor)) return fail();
    return descriptor.value;
  } catch {
    return fail();
  }
}

function cloneJson(value: unknown, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || isProxy(value)) return fail();
  if (active.has(value)) return fail();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype(value) !== Array.prototype) return fail();
      const length = descriptorValue(value, 'length', false);
      if (!Number.isSafeInteger(length) || (length as number) < 0) return fail();
      const keys = ownKeys(value);
      if (keys.length !== (length as number) + 1) return fail();
      const output: unknown[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        output.push(cloneJson(descriptorValue(value, String(index), true), active));
      }
      return output;
    }
    const proto = prototype(value);
    if (proto !== Object.prototype && proto !== null) return fail();
    const output: JsonRecord = Object.create(null);
    for (const key of ownKeys(value)) {
      if (typeof key !== 'string') return fail();
      output[key] = cloneJson(descriptorValue(value, key, true), active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function record(value: unknown, fields?: readonly string[]): JsonRecord {
  const cloned = cloneJson(value);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) return fail();
  const output = cloned as JsonRecord;
  if (fields) {
    const keys = Object.keys(output);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) return fail();
  }
  return output;
}

function projectRoot(value: unknown, fields: readonly string[]): JsonRecord {
  if (typeof value !== 'object' || value === null || isProxy(value)) return fail();
  const proto = prototype(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  const keys = ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) =>
    typeof key !== 'string' || !fields.includes(key))) return fail();
  const output: JsonRecord = Object.create(null);
  for (const field of fields) output[field] = descriptorValue(value, field, true);
  return output;
}

function denseArray(value: unknown): unknown[] {
  const cloned = cloneJson(value);
  if (!Array.isArray(cloned)) return fail();
  return cloned;
}

function countEvidence(state: MemoryV3LifecycleState): number {
  return state.items.reduce((sum, item) => sum + item.evidence.length, 0);
}

function digest(value: unknown): string {
  try {
    return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
  } catch {
    return fail();
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function validateManifest(value: unknown): JsonRecord {
  const manifest = record(value, MANIFEST_FIELDS);
  if (
    manifest.schemaVersion !== 'memory-v3-lifecycle-history-manifest-v1' ||
    manifest.profileId !== LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID ||
    !isValidDateTime(manifest.sourceCutoff) ||
    typeof manifest.sourceSnapshotDigest !== 'string' || !SHA256.test(manifest.sourceSnapshotDigest) ||
    !positiveInteger(manifest.conversationCount) || !positiveInteger(manifest.messageCount) ||
    !positiveInteger(manifest.userMessageCount) || !positiveInteger(manifest.chunkCount) ||
    !positiveInteger(manifest.maxProviderCalls)
  ) return fail();
  const conversations = denseArray(manifest.conversations).map((entry) =>
    record(entry, MANIFEST_CONVERSATION_FIELDS)
  );
  const chunks = denseArray(manifest.chunks).map((entry) => record(entry, MANIFEST_CHUNK_FIELDS));
  if (conversations.length !== manifest.conversationCount || chunks.length !== manifest.chunkCount ||
    manifest.maxProviderCalls !== (manifest.chunkCount as number) *
      getLifecycleHistoryBackfillProfile(LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID).maxCallsPerChunk) {
    return fail();
  }
  for (let index = 0; index < conversations.length; index += 1) {
    const row = conversations[index];
    if (row.conversationOrdinal !== index || !positiveInteger(row.messageCount) ||
      !positiveInteger(row.userMessageCount) || (row.userMessageCount as number) > (row.messageCount as number) ||
      !isValidDateTime(row.firstCreatedAt) || !isValidDateTime(row.lastCreatedAt) ||
      !positiveInteger(row.chunkCount)) return fail();
  }
  const totalMessages = conversations.reduce((sum, row) => sum + (row.messageCount as number), 0);
  const totalUserMessages = conversations.reduce((sum, row) => sum + (row.userMessageCount as number), 0);
  const totalChunks = conversations.reduce((sum, row) => sum + (row.chunkCount as number), 0);
  if (totalMessages !== manifest.messageCount || totalUserMessages !== manifest.userMessageCount ||
    totalChunks !== manifest.chunkCount) return fail();
  for (const row of chunks) {
    if (typeof row.chunkId !== 'string' || !SHA256.test(row.chunkId) ||
      !nonNegativeInteger(row.conversationOrdinal) || !nonNegativeInteger(row.chunkOrdinal) ||
      !positiveInteger(row.messageCount) || !positiveInteger(row.userMessageCount) ||
      (row.userMessageCount as number) > (row.messageCount as number) ||
      !isValidDateTime(row.firstCreatedAt) || !isValidDateTime(row.lastCreatedAt) ||
      !positiveInteger(row.extractorRequestBytes) ||
      typeof row.extractorRequestSha256 !== 'string' || !SHA256.test(row.extractorRequestSha256) ||
      typeof row.sourceDigest !== 'string' || !SHA256.test(row.sourceDigest)) return fail();
  }
  manifest.conversations = conversations;
  manifest.chunks = chunks;
  return manifest;
}

function validateArtifact(value: unknown): {
  benchmarkResult: JsonRecord;
  packet: JsonRecord;
  state: MemoryV3LifecycleState;
  payloadSha256: string;
  manifest: JsonRecord;
} {
  const artifact = record(value, ['benchmarkResult', 'semanticReviewPacket']);
  const result = record(artifact.benchmarkResult, RESULT_FIELDS);
  const packet = record(artifact.semanticReviewPacket, ['schemaVersion', 'payloadSha256', 'items']);
  const manifest = validateManifest(result.manifest);
  const price = record(result.priceSnapshot, [
    'model', 'inputUsdPerMillion', 'outputUsdPerMillion', 'observedAt', 'sourceUrl',
  ]);
  const budget = record(result.budget, [
    'maxRequests', 'reservedInputTokensPerCall', 'maxOutputTokensPerCall',
    'ceilingUsd', 'hardMaxUsd', 'gate',
  ]);
  const semanticReview = record(result.semanticReview, ['status']);
  const resultChunks = denseArray(result.chunks).map((entry) => record(entry, RESULT_CHUNK_FIELDS));
  const failures = denseArray(result.failures);
  if (
    result.schemaVersion !== 'memory-v3-lifecycle-history-result-v1' ||
    result.profileId !== LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID ||
    result.model !== 'google/gemini-3.7-flash' ||
    price.model !== result.model || typeof price.inputUsdPerMillion !== 'string' ||
    typeof price.outputUsdPerMillion !== 'string' || !isValidDateTime(price.observedAt) ||
    typeof price.sourceUrl !== 'string' || !price.sourceUrl.startsWith('https://') ||
    budget.maxRequests !== manifest.maxProviderCalls ||
    budget.reservedInputTokensPerCall !== 32_768 || budget.maxOutputTokensPerCall !== 4_096 ||
    typeof budget.ceilingUsd !== 'string' || typeof budget.hardMaxUsd !== 'string' ||
    budget.gate !== 'PASS' || semanticReview.status !== 'required' ||
    result.execute !== true ||
    result.failureCount !== 0 ||
    result.retryCount !== 0 || result.repairCount !== 0 || result.fallbackCount !== 0 ||
    result.maxActive !== 1 ||
    result.attemptedChunkCount !== manifest.chunkCount ||
    result.successChunkCount !== manifest.chunkCount ||
    result.providerCallCount !== manifest.maxProviderCalls ||
    resultChunks.length !== manifest.chunkCount || failures.length !== 0 ||
    packet.schemaVersion !== 'memory-v3-lifecycle-history-review-packet-v1' ||
    typeof packet.payloadSha256 !== 'string' || !SHA256.test(packet.payloadSha256)
  ) return fail();
  for (let index = 0; index < resultChunks.length; index += 1) {
    const row = resultChunks[index];
    const manifestRow = (manifest.chunks as JsonRecord[])[index];
    const transitions = denseArray(row.transitionTypes);
    if (row.chunkId !== manifestRow.chunkId || row.status !== 'succeeded' ||
      typeof row.changed !== 'boolean' || !positiveInteger(row.resultingStateRevision) ||
      !nonNegativeInteger(row.itemCount) || !nonNegativeInteger(row.evidenceCount) ||
      transitions.some((entry) => typeof entry !== 'string' || entry.length === 0)) return fail();
  }
  if (result.actualUsage !== null) {
    const usage = record(result.actualUsage, ['promptTokens', 'completionTokens']);
    if (!nonNegativeInteger(usage.promptTokens) || !nonNegativeInteger(usage.completionTokens)) return fail();
  }
  if (!(result.actualCostUsd === null ||
    (typeof result.actualCostUsd === 'number' && Number.isFinite(result.actualCostUsd) && result.actualCostUsd >= 0))) {
    return fail();
  }
  const stateValue = cloneJson(result.finalState);
  if (typeof stateValue !== 'object' || stateValue === null) return fail();
  const userId = (stateValue as JsonRecord).userId;
  if (typeof userId !== 'string') return fail();
  let state: MemoryV3LifecycleState;
  try {
    state = validateMemoryV3LifecycleState(stateValue, userId);
  } catch {
    return fail();
  }
  if (state.items.length < 1) return fail();
  if (resultChunks[resultChunks.length - 1].resultingStateRevision !== state.stateRevision ||
    resultChunks[resultChunks.length - 1].itemCount !== state.items.length ||
    resultChunks[resultChunks.length - 1].evidenceCount !== countEvidence(state)) return fail();
  const packetItems = denseArray(packet.items).map((entry) => record(entry));
  if (packetItems.length !== state.items.length) return fail();
  const expectedPacketItems = state.items.map((item) => ({
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
  if (canonicalStringify(packetItems) !== canonicalStringify(expectedPacketItems)) return fail();
  const computed = digest({ benchmarkResult: result, items: packetItems });
  if (computed !== packet.payloadSha256) return fail();
  return { benchmarkResult: result, packet, state, payloadSha256: computed, manifest };
}

function validateDecision(value: unknown, artifact: ReturnType<typeof validateArtifact>): LifecycleHistoryReviewDecision {
  const decision = record(value, [
    'schemaVersion', 'payloadSha256', 'verdict', 'reviewedAt', 'reviewer', 'items',
  ]);
  if (
    decision.schemaVersion !== 'memory-v3-lifecycle-history-review-v1' ||
    decision.payloadSha256 !== artifact.payloadSha256 ||
    decision.verdict !== 'PASS' || decision.reviewer !== 'Nastya' ||
    !isValidDateTime(decision.reviewedAt)
  ) return fail();
  const rows = denseArray(decision.items).map((entry) =>
    record(entry, ['memoryKey', 'semanticVerdict', 'reviewerNotes'])
  );
  if (rows.length !== artifact.state.items.length) return fail();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      row.memoryKey !== artifact.state.items[index].memoryKey ||
      row.semanticVerdict !== 'PASS' ||
      !(row.reviewerNotes === null ||
        (typeof row.reviewerNotes === 'string' && row.reviewerNotes.length <= MAX_REVIEWER_NOTES))
    ) return fail();
  }
  return decision as unknown as LifecycleHistoryReviewDecision;
}

function validateFreshSource(value: unknown, artifact: ReturnType<typeof validateArtifact>): JsonRecord {
  const fresh = record(value, ['userId', 'manifest', 'chunks']);
  const manifest = validateManifest(fresh.manifest);
  if (fresh.userId !== artifact.state.userId ||
    canonicalStringify(manifest) !== canonicalStringify(artifact.manifest)) return fail();
  const chunks = denseArray(fresh.chunks).map((entry) => record(entry, PREPARED_CHUNK_FIELDS));
  if (chunks.length !== manifest.chunkCount) return fail();

  const nextOrdinalByConversation = new Map<number, number>();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const manifestChunk = (manifest.chunks as JsonRecord[])[index];
    if (typeof chunk.conversationId !== 'string' || !UUID.test(chunk.conversationId) ||
      !nonNegativeInteger(chunk.conversationOrdinal) ||
      (chunk.conversationOrdinal as number) >= (manifest.conversationCount as number) ||
      !nonNegativeInteger(chunk.chunkOrdinal)) return fail();
    const conversationOrdinal = chunk.conversationOrdinal as number;
    const expectedChunkOrdinal = nextOrdinalByConversation.get(conversationOrdinal) ?? 0;
    if (chunk.chunkOrdinal !== expectedChunkOrdinal) return fail();
    nextOrdinalByConversation.set(conversationOrdinal, expectedChunkOrdinal + 1);

    let dialogue: ReturnType<typeof validateMemoryV3Dialogue>;
    try {
      dialogue = validateMemoryV3Dialogue({
        caseId: `memory-v3-shadow:${fresh.userId}:${chunk.conversationId}`,
        messages: chunk.messages,
      });
    } catch {
      return fail();
    }
    const first = dialogue.messages[0];
    const last = dialogue.messages[dialogue.messages.length - 1];
    const userMessageCount = dialogue.messages.filter((message) => message.role === 'user').length;
    const sourceDigest = canonicalLifecycleHistoryDigest({
      conversationId: chunk.conversationId,
      messages: dialogue.messages,
    });
    const chunkId = canonicalLifecycleHistoryDigest([
      LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
      sourceDigest,
      chunk.conversationOrdinal,
      chunk.chunkOrdinal,
    ]);
    const requestText = JSON.stringify(buildMemoryV3ExtractorRequest(dialogue));
    const requestBytes = new TextEncoder().encode(requestText).byteLength;
    const requestSha256 = sha256Text(requestText);
    if (
      chunk.chunkId !== chunkId || chunk.sourceDigest !== sourceDigest ||
      chunk.messageCount !== dialogue.messages.length || chunk.userMessageCount !== userMessageCount ||
      chunk.firstCreatedAt !== first.createdAt || chunk.lastCreatedAt !== last.createdAt ||
      chunk.firstMessageId !== first.id || chunk.lastMessageId !== last.id ||
      chunk.extractorRequestBytes !== requestBytes || chunk.extractorRequestSha256 !== requestSha256 ||
      canonicalStringify(manifestChunk) !== canonicalStringify({
        chunkId,
        conversationOrdinal: chunk.conversationOrdinal,
        chunkOrdinal: chunk.chunkOrdinal,
        messageCount: dialogue.messages.length,
        userMessageCount,
        firstCreatedAt: first.createdAt,
        lastCreatedAt: last.createdAt,
        extractorRequestBytes: requestBytes,
        extractorRequestSha256: requestSha256,
        sourceDigest,
      })
    ) return fail();
  }
  for (let index = 0; index < (manifest.conversations as JsonRecord[]).length; index += 1) {
    const row = (manifest.conversations as JsonRecord[])[index];
    if (nextOrdinalByConversation.get(index) !== row.chunkCount) return fail();
  }
  fresh.manifest = manifest;
  fresh.chunks = chunks;
  return fresh;
}

export function preflightReviewedLifecycleHistoryFiles(input: {
  artifact: unknown;
  reviewDecision: unknown;
}): { profileId: string; sourceCutoff: string; userId: string } {
  try {
    const root = projectRoot(input, ['artifact', 'reviewDecision']);
    const artifact = validateArtifact(root.artifact);
    validateDecision(root.reviewDecision, artifact);
    return Object.freeze({
      profileId: artifact.benchmarkResult.profileId as string,
      sourceCutoff: artifact.manifest.sourceCutoff as string,
      userId: artifact.state.userId,
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) throw error;
    return fail();
  }
}

function validateClient(value: unknown): LifecycleHistoryImportClient {
  if (typeof value !== 'object' || value === null || isProxy(value)) return fail();
  const proto = prototype(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  const keys = ownKeys(value);
  if (keys.length !== 2 || !keys.includes('loadCurrentHead') || !keys.includes('importInitialState')) return fail();
  const load = descriptorValue(value, 'loadCurrentHead', true);
  const write = descriptorValue(value, 'importInitialState', true);
  if (typeof load !== 'function' || typeof write !== 'function' || isProxy(load) || isProxy(write)) return fail();
  return value as LifecycleHistoryImportClient;
}

function validateHead(value: unknown): void {
  const head = record(value, ['stateRevision', 'itemCount']);
  if (head.stateRevision !== 0 || head.itemCount !== 0) return fail();
}

function validateResponse(value: unknown, expectedRevision: number): number {
  const response = record(value, ['result', 'resultingStateRevision']);
  if (response.result !== 'succeeded' || response.resultingStateRevision !== expectedRevision) return fail();
  return expectedRevision;
}

export async function importReviewedLifecycleHistory(input: {
  artifact: unknown;
  reviewDecision: unknown;
  freshPreparedSource: unknown;
  userId: unknown;
  importId: unknown;
  client: unknown;
}): Promise<{
  status: 'succeeded';
  artifactDigest: string;
  sourceSnapshotDigest: string;
  resultingStateRevision: number;
  itemCount: number;
  evidenceCount: number;
}> {
  try {
    const root = projectRoot(input, [
      'artifact', 'reviewDecision', 'freshPreparedSource', 'userId', 'importId', 'client',
    ]);
    if (typeof root.userId !== 'string' || !UUID.test(root.userId) ||
      typeof root.importId !== 'string' || !UUID.test(root.importId)) return fail();
    const artifact = validateArtifact(root.artifact);
    if (artifact.state.userId !== root.userId) return fail();
    validateDecision(root.reviewDecision, artifact);
    validateFreshSource(root.freshPreparedSource, artifact);
    const client = validateClient(root.client);
    validateHead(await client.loadCurrentHead(root.userId));
    const response = await client.importInitialState({
      importId: root.importId,
      userId: root.userId,
      expectedStateRevision: 0,
      artifactDigest: artifact.payloadSha256,
      sourceSnapshotDigest: artifact.manifest.sourceSnapshotDigest as string,
      sourceCutoff: artifact.manifest.sourceCutoff as string,
      profileId: artifact.benchmarkResult.profileId as string,
      pipelineVersion: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
      extractorVersion: MEMORY_V3_EXTRACTOR_VERSION,
      reconcilerVersion: MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
      state: cloneJson(artifact.state) as MemoryV3LifecycleState,
    });
    const resultingStateRevision = validateResponse(response, artifact.state.stateRevision);
    return Object.freeze({
      status: 'succeeded' as const,
      artifactDigest: artifact.payloadSha256,
      sourceSnapshotDigest: artifact.manifest.sourceSnapshotDigest as string,
      resultingStateRevision,
      itemCount: artifact.state.items.length,
      evidenceCount: countEvidence(artifact.state),
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) {
      throw error;
    }
    return fail();
  }
}
