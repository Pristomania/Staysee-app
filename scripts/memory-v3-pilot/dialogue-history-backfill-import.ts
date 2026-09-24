/** Fork of lifecycle-history-backfill-import.ts for the dialogue-scope
 * historical backfill (see .superpowers/sdd/2026-09-24-memory-v3-dialogue-
 * history-backfill/task-6-brief.md).
 *
 * Critical divergence from the lifecycle sibling: the lifecycle importer only
 * ever imports into a conversation/account that started completely EMPTY
 * (p_expected_state_revision hardcoded to 0; any nonzero starting state is a
 * hard, whole-batch-aborting error there). This dialogue-scope fork does NOT
 * work that way -- Настя explicitly chose full reprocessing over skipping
 * (2026-09-24): every conversation in the artifact gets imported and its
 * state OVERWRITTEN, whether it started empty or already had organic live
 * data. The only thing still guarded against is a narrower race: has the
 * conversation's revision changed since the paid run captured it? If
 * `expectedStateRevision` (captured by Task 5 before the paid run, carried on
 * the artifact) still matches the conversation's actual current revision at
 * import time, the import proceeds and overwrites -- regardless of whether
 * that revision is 0 or 12. If it no longer matches, THAT ONE conversation's
 * import is rejected (status: 'rejected_state_changed') and the loop
 * continues to the next conversation -- it does not abort the whole batch.
 * There is no "must be empty" or "skip if not empty" branch anywhere below.
 *
 * A real run against production surfaced one more real edge case: a
 * conversation whose paid run found zero extractable items (a valid,
 * reported "ничего устойчивого не найдено" outcome, not a failure)
 * legitimately never advances its state past revision 0 -- but the
 * import RPC's own schema requires at least one item per call. Such a
 * conversation is reported as a normal success (there is nothing to
 * change, so nothing needs writing) without ever calling the RPC for it. */

import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { canonicalStringify } from './contracts.mjs';
import {
  getLifecycleHistoryBackfillProfile,
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_MODEL_ROUTE,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
} from './lifecycle-history-backfill-profile.ts';
import {
  canonicalDialogueHistoryDigest,
} from './dialogue-history-backfill-contract.ts';
import {
  MEMORY_V3_EXTRACTOR_VERSION,
  validateMemoryV3Dialogue,
} from '../../supabase/functions/_shared/memoryV3/contract.ts';
import { buildMemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import {
  MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
  MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
  validateMemoryV3DialogueState,
  type MemoryV3DialogueState,
} from '../../supabase/functions/_shared/memoryV3/dialogueContract.ts';

export interface DialogueHistoryReviewDecision {
  schemaVersion: 'memory-v3-dialogue-history-review-v1';
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

export interface DialogueHistoryImportClient {
  loadCurrentHead(userId: string, conversationId: string): Promise<unknown>;
  importInitialState(input: {
    importId: string;
    userId: string;
    conversationId: string;
    expectedStateRevision: number;
    artifactDigest: string;
    sourceSnapshotDigest: string;
    sourceCutoff: string;
    profileId: string;
    pipelineVersion: string;
    extractorVersion: typeof MEMORY_V3_EXTRACTOR_VERSION;
    reconcilerVersion: string;
    state: MemoryV3DialogueState;
  }): Promise<unknown>;
}

type JsonRecord = Record<string, unknown>;

const PREFIX = '[memory-v3:dialogue-history-backfill-import]';
const ERROR_NAME = 'MemoryV3DialogueHistoryBackfillImportError';
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,9}))?)?(Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/u;
const MAX_REVIEWER_NOTES = 1_000;
// The exact substring of the RPC's conflict-guard RAISE EXCEPTION message
// (see import_memory_v3_dialogue_backfill_state's migration) -- textually
// distinct from every other exception that RPC can raise. The pre-check
// above (loadCurrentHead vs. expectedStateRevision) already catches this
// race in the common case; this substring match is a backstop for the
// narrower window between that check and the RPC call itself, where the
// live incremental pipeline could still write to the same conversation.
const RPC_CONFLICT_MESSAGE = 'dialogue backfill import conflict';
const OWN_ERRORS = new WeakSet<object>();
const RESULT_FIELDS = [
  'schemaVersion', 'profileId', 'model', 'modelRoute', 'manifest', 'priceSnapshot', 'budget',
  'execute', 'conversations', 'providerCallCount', 'providerModelFallbackCount', 'resolvedModelCounts',
  'maxActive', 'retryCount', 'repairCount', 'fallbackCount', 'actualUsage', 'actualCostUsd', 'semanticReview',
] as const;
const RESULT_CONVERSATION_FIELDS = [
  'conversationId', 'conversationOrdinal', 'expectedStateRevision', 'attemptedChunkCount',
  'successChunkCount', 'failureCount', 'finalState', 'chunks', 'failures',
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
  'evidenceCount', 'transitionTypes', 'extractorResolvedModel',
  'reconcilerResolvedModel',
] as const;
const ENDPOINT_FIELDS = [
  'model', 'inputUsdPerMillion', 'outputUsdPerMillion', 'observedAt',
  'sourceUrl', 'supportedParameters', 'zdr',
] as const;
const REQUIRED_PARAMETERS = [
  'max_tokens', 'reasoning', 'reasoning_effort', 'response_format',
  'structured_outputs',
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

function countEvidence(state: MemoryV3DialogueState): number {
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
    manifest.schemaVersion !== 'memory-v3-dialogue-history-manifest-v1' ||
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

/** Validates the reviewed (benchmarkResult, semanticReviewPacket) artifact and
 * recomputes its authenticity digest from scratch. Every conversation present
 * must have fully succeeded in the paid run (failureCount 0, non-null
 * finalState, successChunkCount matching its manifest chunk count) -- this
 * mirrors exactly what buildDialogueHistoryReviewPacket itself requires
 * before it will build a packet at all (dialogue-history-backfill-
 * engine.ts), so a genuine artifact whose packet digest checks out here can
 * never contain a conversation that didn't fully succeed. */
function validateArtifact(value: unknown): {
  benchmarkResult: JsonRecord;
  packet: JsonRecord;
  conversations: Array<{
    conversationId: string;
    conversationOrdinal: number;
    expectedStateRevision: number;
    state: MemoryV3DialogueState;
  }>;
  userId: string;
  payloadSha256: string;
  manifest: JsonRecord;
} {
  const artifact = record(value, ['benchmarkResult', 'semanticReviewPacket']);
  const result = record(artifact.benchmarkResult, RESULT_FIELDS);
  const packet = record(artifact.semanticReviewPacket, ['schemaVersion', 'payloadSha256', 'items']);
  const manifest = validateManifest(result.manifest);
  const modelRoute = denseArray(result.modelRoute);
  const price = record(result.priceSnapshot, ['route']);
  const priceRoute = denseArray(price.route).map((entry) => record(entry, ENDPOINT_FIELDS));
  const resolvedModelCounts = record(result.resolvedModelCounts, ['primary', 'fallback']);
  const budget = record(result.budget, [
    'maxRequests', 'reservedInputTokensPerCall', 'maxOutputTokensPerCall',
    'ceilingUsd', 'hardMaxUsd', 'gate',
  ]);
  const semanticReview = record(result.semanticReview, ['status']);
  const conversationRows = denseArray(result.conversations).map((entry) =>
    record(entry, RESULT_CONVERSATION_FIELDS)
  );
  if (
    result.schemaVersion !== 'memory-v3-dialogue-history-result-v1' ||
    result.profileId !== 'memory-v3-dialogue-history-backfill-v1' ||
    result.model !== 'google/gemini-3.7-flash' ||
    modelRoute.length !== 2 ||
    modelRoute[0] !== LIFECYCLE_HISTORY_PRIMARY_MODEL ||
    modelRoute[1] !== LIFECYCLE_HISTORY_FALLBACK_MODEL ||
    priceRoute.length !== 2 ||
    budget.maxRequests !== manifest.maxProviderCalls ||
    budget.reservedInputTokensPerCall !== 32_768 || budget.maxOutputTokensPerCall !== 4_096 ||
    typeof budget.ceilingUsd !== 'string' || typeof budget.hardMaxUsd !== 'string' ||
    budget.gate !== 'PASS' || semanticReview.status !== 'required' ||
    result.execute !== true ||
    result.retryCount !== 0 || result.repairCount !== 0 || result.fallbackCount !== 0 ||
    result.maxActive !== 1 ||
    conversationRows.length !== manifest.conversationCount ||
    result.providerCallCount !== manifest.maxProviderCalls ||
    !nonNegativeInteger(result.providerModelFallbackCount) ||
    !nonNegativeInteger(resolvedModelCounts.primary) ||
    !nonNegativeInteger(resolvedModelCounts.fallback) ||
    result.providerModelFallbackCount !== resolvedModelCounts.fallback ||
    (resolvedModelCounts.primary as number) + (resolvedModelCounts.fallback as number) !==
      result.providerCallCount ||
    packet.schemaVersion !== 'memory-v3-dialogue-history-review-packet-v1' ||
    typeof packet.payloadSha256 !== 'string' || !SHA256.test(packet.payloadSha256)
  ) return fail();
  for (let index = 0; index < priceRoute.length; index += 1) {
    const endpoint = priceRoute[index];
    const expectedModel = LIFECYCLE_HISTORY_MODEL_ROUTE[index];
    const parameters = denseArray(endpoint.supportedParameters);
    if (
      endpoint.model !== expectedModel ||
      typeof endpoint.inputUsdPerMillion !== 'string' ||
      typeof endpoint.outputUsdPerMillion !== 'string' ||
      !isValidDateTime(endpoint.observedAt) ||
      endpoint.sourceUrl !== `https://openrouter.ai/api/v1/models/${expectedModel}/endpoints` ||
      endpoint.zdr !== true ||
      parameters.length !== REQUIRED_PARAMETERS.length ||
      parameters.some((entry, parameterIndex) => entry !== REQUIRED_PARAMETERS[parameterIndex])
    ) return fail();
  }

  const manifestConversations = manifest.conversations as JsonRecord[];
  const manifestChunks = manifest.chunks as JsonRecord[];
  let recomputedPrimary = 0;
  let recomputedFallback = 0;
  const userIds = new Set<string>();
  const conversations: Array<{
    conversationId: string;
    conversationOrdinal: number;
    expectedStateRevision: number;
    state: MemoryV3DialogueState;
  }> = [];
  for (let index = 0; index < conversationRows.length; index += 1) {
    const row = conversationRows[index];
    const manifestConversation = manifestConversations[index];
    if (
      typeof row.conversationId !== 'string' || !UUID.test(row.conversationId) ||
      row.conversationOrdinal !== index ||
      !nonNegativeInteger(row.expectedStateRevision) ||
      !nonNegativeInteger(row.attemptedChunkCount) ||
      !nonNegativeInteger(row.successChunkCount) ||
      !nonNegativeInteger(row.failureCount) ||
      row.failureCount !== 0 ||
      row.finalState === null ||
      row.successChunkCount !== manifestConversation.chunkCount ||
      row.attemptedChunkCount !== row.successChunkCount
    ) return fail();
    const failures = denseArray(row.failures);
    if (failures.length !== 0) return fail();
    const resultChunks = denseArray(row.chunks).map((entry) => record(entry, RESULT_CHUNK_FIELDS));
    const manifestChunksForConversation = manifestChunks.filter(
      (chunk) => chunk.conversationOrdinal === index,
    );
    if (resultChunks.length !== manifestConversation.chunkCount ||
      manifestChunksForConversation.length !== manifestConversation.chunkCount) return fail();
    for (let chunkIndex = 0; chunkIndex < resultChunks.length; chunkIndex += 1) {
      const chunkRow = resultChunks[chunkIndex];
      const manifestChunk = manifestChunksForConversation[chunkIndex];
      const transitions = denseArray(chunkRow.transitionTypes);
      if (chunkRow.chunkId !== manifestChunk.chunkId || chunkRow.status !== 'succeeded' ||
        typeof chunkRow.changed !== 'boolean' ||
        // A conversation whose chunks never create/revise/confirm anything
        // (a real run found a conversation with zero extractable facts --
        // "ничего устойчивого не найдено" is a valid, reported outcome, not a
        // failure) legitimately never advances its state past revision 0.
        // Requiring a POSITIVE revision here made every such conversation's
        // presence in the artifact reject the entire batch's validation.
        !nonNegativeInteger(chunkRow.resultingStateRevision) ||
        !nonNegativeInteger(chunkRow.itemCount) || !nonNegativeInteger(chunkRow.evidenceCount) ||
        transitions.some((entry) => typeof entry !== 'string' || entry.length === 0)) return fail();
      for (const resolvedModel of [chunkRow.extractorResolvedModel, chunkRow.reconcilerResolvedModel]) {
        if (resolvedModel === LIFECYCLE_HISTORY_PRIMARY_MODEL) recomputedPrimary += 1;
        else if (resolvedModel === LIFECYCLE_HISTORY_FALLBACK_MODEL) recomputedFallback += 1;
        else return fail();
      }
    }
    const stateValue = cloneJson(row.finalState);
    if (typeof stateValue !== 'object' || stateValue === null) return fail();
    const userIdFromState = (stateValue as JsonRecord).userId;
    if (typeof userIdFromState !== 'string') return fail();
    let state: MemoryV3DialogueState;
    try {
      state = validateMemoryV3DialogueState(stateValue, userIdFromState, row.conversationId);
    } catch {
      return fail();
    }
    // No minimum item count here -- a conversation that legitimately found
    // nothing extractable ("ничего устойчивого не найдено") is a valid,
    // reported success with zero items, not an invalid state.
    const lastChunk = resultChunks[resultChunks.length - 1];
    if (lastChunk.resultingStateRevision !== state.stateRevision ||
      lastChunk.itemCount !== state.items.length ||
      lastChunk.evidenceCount !== countEvidence(state)) return fail();
    userIds.add(state.userId);
    conversations.push({
      conversationId: row.conversationId,
      conversationOrdinal: index,
      expectedStateRevision: row.expectedStateRevision,
      state,
    });
  }
  if (
    recomputedPrimary !== resolvedModelCounts.primary ||
    recomputedFallback !== resolvedModelCounts.fallback ||
    recomputedFallback !== result.providerModelFallbackCount
  ) return fail();
  if (userIds.size !== 1) return fail();
  const [userId] = [...userIds];

  if (result.actualUsage !== null) {
    const usage = record(result.actualUsage, ['promptTokens', 'completionTokens']);
    if (!nonNegativeInteger(usage.promptTokens) || !nonNegativeInteger(usage.completionTokens)) return fail();
  }
  if (!(result.actualCostUsd === null ||
    (typeof result.actualCostUsd === 'number' && Number.isFinite(result.actualCostUsd) && result.actualCostUsd >= 0))) {
    return fail();
  }

  const packetItems = denseArray(packet.items).map((entry) => record(entry));
  const expectedPacketItems = conversations.flatMap((conversation) =>
    conversation.state.items.map((item) => ({
      conversationId: conversation.conversationId,
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
    }))
  );
  if (packetItems.length !== expectedPacketItems.length ||
    canonicalStringify(packetItems) !== canonicalStringify(expectedPacketItems)) return fail();
  const computed = digest({ benchmarkResult: result, items: packetItems });
  if (computed !== packet.payloadSha256) return fail();
  return { benchmarkResult: result, packet, conversations, userId, payloadSha256: computed, manifest };
}

/** Requires the decision's items to equal the exact flattened concatenation
 * produced by buildDialogueHistoryReviewPacket: conversation order (as
 * validateArtifact returned them, i.e. ascending conversationOrdinal), then
 * item order within each conversation's own finalState.items -- unsorted,
 * exactly as the reducer produced them. Position alone disambiguates which
 * conversation each row belongs to; no separate conversationId column is
 * needed on the decision row itself. */
function validateDecision(
  value: unknown,
  artifact: ReturnType<typeof validateArtifact>,
): DialogueHistoryReviewDecision {
  const decision = record(value, [
    'schemaVersion', 'payloadSha256', 'verdict', 'reviewedAt', 'reviewer', 'items',
  ]);
  if (
    decision.schemaVersion !== 'memory-v3-dialogue-history-review-v1' ||
    decision.payloadSha256 !== artifact.payloadSha256 ||
    decision.verdict !== 'PASS' || decision.reviewer !== 'Nastya' ||
    !isValidDateTime(decision.reviewedAt)
  ) return fail();
  const rows = denseArray(decision.items).map((entry) =>
    record(entry, ['memoryKey', 'semanticVerdict', 'reviewerNotes'])
  );
  const flattenedItems = artifact.conversations.flatMap((conversation) => conversation.state.items);
  if (rows.length !== flattenedItems.length) return fail();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      row.memoryKey !== flattenedItems[index].memoryKey ||
      row.semanticVerdict !== 'PASS' ||
      !(row.reviewerNotes === null ||
        (typeof row.reviewerNotes === 'string' && row.reviewerNotes.length <= MAX_REVIEWER_NOTES))
    ) return fail();
  }
  return decision as unknown as DialogueHistoryReviewDecision;
}

function validateFreshSource(value: unknown, artifact: ReturnType<typeof validateArtifact>): JsonRecord {
  const fresh = record(value, ['userId', 'manifest', 'chunks']);
  const manifest = validateManifest(fresh.manifest);
  if (fresh.userId !== artifact.userId ||
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
    const sourceDigest = canonicalDialogueHistoryDigest({
      conversationId: chunk.conversationId,
      messages: dialogue.messages,
    });
    const chunkId = canonicalDialogueHistoryDigest([
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

export function preflightReviewedDialogueHistoryFiles(input: {
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
      userId: artifact.userId,
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) throw error;
    return fail();
  }
}

function validateClient(value: unknown): DialogueHistoryImportClient {
  if (typeof value !== 'object' || value === null || isProxy(value)) return fail();
  const proto = prototype(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  const keys = ownKeys(value);
  if (keys.length !== 2 || !keys.includes('loadCurrentHead') || !keys.includes('importInitialState')) return fail();
  const load = descriptorValue(value, 'loadCurrentHead', true);
  const write = descriptorValue(value, 'importInitialState', true);
  if (typeof load !== 'function' || typeof write !== 'function' || isProxy(load) || isProxy(write)) return fail();
  return value as DialogueHistoryImportClient;
}

/** Unlike the lifecycle sibling's validateHead (which requires stateRevision
 * 0 and itemCount 0, hard-erroring on anything else), this only shape-checks
 * the head: the actual revision comparison against that conversation's
 * expectedStateRevision happens per-conversation in the main loop below, and
 * a mismatch there is a per-conversation rejection, never a thrown error. */
function validateHead(value: unknown): number {
  const head = record(value, ['stateRevision', 'itemCount']);
  if (!nonNegativeInteger(head.stateRevision) || !nonNegativeInteger(head.itemCount)) return fail();
  return head.stateRevision;
}

function validateResponse(value: unknown, expectedRevision: number): number {
  const response = record(value, ['result', 'resultingStateRevision']);
  if (response.result !== 'succeeded' || response.resultingStateRevision !== expectedRevision) return fail();
  return expectedRevision;
}

/** True only for the RPC's own conflict-guard exception (a genuine
 * server-side revision race in the narrow window between our pre-check and
 * the RPC call itself) -- never for any other client/RPC error, which must
 * still abort the batch as a real failure. Reads only the error's own
 * `message` field for this narrow textual match; never re-exposes it. */
function isRpcConflictError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'message' in error &&
    typeof (error as { message: unknown }).message === 'string' &&
    (error as { message: string }).message.includes(RPC_CONFLICT_MESSAGE);
}

export async function importReviewedDialogueHistory(input: {
  artifact: unknown;
  reviewDecision: unknown;
  freshPreparedSource: unknown;
  userId: unknown;
  importId: unknown;
  client: unknown;
}): Promise<{
  status: 'succeeded';
  results: Array<
    | {
      conversationId: string;
      status: 'succeeded';
      resultingStateRevision: number;
      itemCount: number;
      evidenceCount: number;
    }
    | { conversationId: string; status: 'rejected_state_changed' }
  >;
}> {
  try {
    const root = projectRoot(input, [
      'artifact', 'reviewDecision', 'freshPreparedSource', 'userId', 'importId', 'client',
    ]);
    if (typeof root.userId !== 'string' || !UUID.test(root.userId) ||
      typeof root.importId !== 'string' || !UUID.test(root.importId)) return fail();
    const artifact = validateArtifact(root.artifact);
    if (artifact.userId !== root.userId) return fail();
    validateDecision(root.reviewDecision, artifact);
    validateFreshSource(root.freshPreparedSource, artifact);
    const client = validateClient(root.client);

    const results: Array<
      | {
        conversationId: string;
        status: 'succeeded';
        resultingStateRevision: number;
        itemCount: number;
        evidenceCount: number;
      }
      | { conversationId: string; status: 'rejected_state_changed' }
    > = [];
    // validateArtifact only ever returns conversations that fully succeeded in
    // the paid run (see its own doc comment) -- there is no conversation here
    // to "skip" for a null finalState in practice. Every entry is attempted;
    // a mismatch below rejects just that one conversation and the loop moves
    // on to the next -- it never aborts the whole batch.
    for (const conversation of artifact.conversations) {
      const head = await client.loadCurrentHead(root.userId, conversation.conversationId);
      const currentRevision = validateHead(head);
      if (currentRevision !== conversation.expectedStateRevision) {
        results.push(Object.freeze({
          conversationId: conversation.conversationId,
          status: 'rejected_state_changed' as const,
        }));
        continue;
      }
      // A conversation whose paid run found zero extractable items has
      // nothing to write -- the RPC's own schema requires at least one item
      // per import (mirroring the lifecycle sibling), so calling it here
      // would always fail. The conversation's live state already matches
      // this "found nothing" result exactly (an untouched conversation is
      // already empty at revision 0), so this is a genuine no-op success,
      // not a skip and not a failure -- it is reported the same as any
      // other successful conversation, just without an RPC call.
      if (conversation.state.items.length === 0) {
        results.push(Object.freeze({
          conversationId: conversation.conversationId,
          status: 'succeeded' as const,
          resultingStateRevision: conversation.state.stateRevision,
          itemCount: 0,
          evidenceCount: 0,
        }));
        continue;
      }
      let response: unknown;
      try {
        response = await client.importInitialState({
          importId: root.importId,
          userId: root.userId,
          conversationId: conversation.conversationId,
          expectedStateRevision: conversation.expectedStateRevision,
          artifactDigest: artifact.payloadSha256,
          sourceSnapshotDigest: artifact.manifest.sourceSnapshotDigest as string,
          sourceCutoff: artifact.manifest.sourceCutoff as string,
          profileId: artifact.benchmarkResult.profileId as string,
          pipelineVersion: MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
          extractorVersion: MEMORY_V3_EXTRACTOR_VERSION,
          reconcilerVersion: MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
          state: cloneJson(conversation.state) as MemoryV3DialogueState,
        });
      } catch (error) {
        // A genuine race: something landed on this exact conversation between
        // our pre-check above and this RPC call. Reject just this
        // conversation and keep going -- never abort the batch for a race
        // our own pre-check already mostly (but not perfectly) covers. Any
        // OTHER error (a real bug, a malformed request) still propagates and
        // aborts, exactly as before.
        if (isRpcConflictError(error)) {
          results.push(Object.freeze({
            conversationId: conversation.conversationId,
            status: 'rejected_state_changed' as const,
          }));
          continue;
        }
        throw error;
      }
      const resultingStateRevision = validateResponse(response, conversation.state.stateRevision);
      results.push(Object.freeze({
        conversationId: conversation.conversationId,
        status: 'succeeded' as const,
        resultingStateRevision,
        itemCount: conversation.state.items.length,
        evidenceCount: countEvidence(conversation.state),
      }));
    }
    return Object.freeze({ status: 'succeeded' as const, results: Object.freeze(results) });
  } catch (error) {
    if (typeof error === 'object' && error !== null && OWN_ERRORS.has(error)) {
      throw error;
    }
    return fail();
  }
}
