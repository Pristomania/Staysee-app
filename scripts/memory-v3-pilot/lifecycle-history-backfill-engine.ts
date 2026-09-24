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
  LIFECYCLE_HISTORY_FALLBACK_MODEL,
  LIFECYCLE_HISTORY_MODEL_ROUTE,
  LIFECYCLE_HISTORY_PRIMARY_MODEL,
  validateLifecycleHistoryPriceSnapshot,
  type LifecycleHistoryBackfillProfile,
  type LifecycleHistoryPriceSnapshot,
  type LifecycleHistoryResolvedModel,
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
  modelRoute: readonly [
    'google/gemini-3.7-flash',
    'mistralai/mistral-medium-3-5',
  ];
  manifest: LifecycleHistoryBackfillManifest;
  priceSnapshot: LifecycleHistoryPriceSnapshot;
  budget: {
    maxRequests: number;
    reservedInputTokensPerCall: 32_768;
    maxOutputTokensPerCall: 4_096;
    ceilingUsd: string;
    hardMaxUsd: string;
    gate: 'PASS';
  };
  execute: boolean;
  attemptedChunkCount: number;
  successChunkCount: number;
  failureCount: number;
  providerCallCount: number;
  providerModelFallbackCount: number;
  resolvedModelCounts: {
    primary: number;
    fallback: number;
  };
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
    extractorResolvedModel: LifecycleHistoryResolvedModel;
    reconcilerResolvedModel: LifecycleHistoryResolvedModel;
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
const TRANSPORT_FIELDS = ['content', 'usage', 'resolvedModel'] as const;
const RECONCILER_TRANSPORT_FIELDS = ['rawContent', 'usage', 'resolvedModel'] as const;
const USAGE_FIELDS = ['promptTokens', 'completionTokens', 'costUsd'] as const;
const PREPARED_FIELDS = ['userId', 'manifest', 'chunks'] as const;
const MANIFEST_FIELDS = [
  'schemaVersion', 'profileId', 'sourceCutoff', 'sourceSnapshotDigest',
  'conversationCount', 'messageCount', 'userMessageCount', 'chunkCount',
  'maxProviderCalls', 'conversations', 'chunks',
] as const;
const MANIFEST_CONVERSATION_FIELDS = [
  'conversationOrdinal', 'messageCount', 'userMessageCount',
  'firstCreatedAt', 'lastCreatedAt', 'chunkCount',
] as const;
const MANIFEST_CHUNK_FIELDS = [
  'chunkId', 'conversationOrdinal', 'chunkOrdinal', 'messageCount',
  'userMessageCount', 'firstCreatedAt', 'lastCreatedAt',
  'extractorRequestBytes', 'extractorRequestSha256', 'sourceDigest',
] as const;
const PREPARED_CHUNK_FIELDS = [
  'chunkId', 'conversationOrdinal', 'chunkOrdinal', 'conversationId', 'messages',
  'firstCreatedAt', 'lastCreatedAt', 'firstMessageId', 'lastMessageId',
  'messageCount', 'userMessageCount', 'extractorRequestBytes',
  'extractorRequestSha256', 'sourceDigest',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const OWN_ERRORS = new WeakSet<object>();
const ERROR_DETAILS = new WeakMap<object, { stage: LifecycleHistoryBackfillStage | null; code: string }>();
const AUTHENTIC_RESULTS = new WeakSet<object>();

function createEngineError(stage: LifecycleHistoryBackfillStage | null, code: string): Error {
  const error = new Error('[memory-v3:lifecycle-history-backfill-engine] operation failed');
  error.name = 'MemoryV3LifecycleHistoryBackfillEngineError';
  OWN_ERRORS.add(error);
  ERROR_DETAILS.set(error, { stage, code });
  return error;
}

function fail(stage: LifecycleHistoryBackfillStage | null, code: string): never {
  throw createEngineError(stage, code);
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

function dateTimeNanoseconds(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.trim() !== value) return null;
  const match = DATE_TIME.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  if (hour > 23 || minute > 59 || second > 59 || month < 1 || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return null;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[7] ?? '').padEnd(9, '0').slice(3) || '0');
}

function compareDateTime(left: string, right: string): number {
  const leftNs = dateTimeNanoseconds(left);
  const rightNs = dateTimeNanoseconds(right);
  if (leftNs === null || rightNs === null) fail(null, 'prepared_invalid');
  return leftNs < rightNs ? -1 : leftNs > rightNs ? 1 : 0;
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
  if (!Array.isArray(root.chunks) || root.chunks.length === 0) fail(null, 'prepared_invalid');
  const manifestRecord = strictRecord(
    root.manifest,
    MANIFEST_FIELDS,
    MANIFEST_FIELDS,
    null,
    'prepared_invalid',
  );
  if (manifestRecord.schemaVersion !== 'memory-v3-lifecycle-history-manifest-v1' ||
    manifestRecord.profileId !== profile.profileId ||
    typeof manifestRecord.sourceCutoff !== 'string' ||
    dateTimeNanoseconds(manifestRecord.sourceCutoff) === null ||
    typeof manifestRecord.sourceSnapshotDigest !== 'string' ||
    !SHA256.test(manifestRecord.sourceSnapshotDigest) ||
    !Array.isArray(manifestRecord.conversations) ||
    !Array.isArray(manifestRecord.chunks)) {
    fail(null, 'prepared_invalid');
  }
  const chunks = root.chunks.map((value) =>
    strictRecord(value, PREPARED_CHUNK_FIELDS, PREPARED_CHUNK_FIELDS, null, 'prepared_invalid')
  ) as unknown as PreparedLifecycleHistoryBackfill['chunks'];
  if (manifestRecord.chunkCount !== chunks.length ||
    manifestRecord.maxProviderCalls !== chunks.length * profile.maxCallsPerChunk ||
    manifestRecord.chunks.length !== chunks.length) fail(null, 'prepared_invalid');
  let messageCount = 0;
  let userMessageCount = 0;
  const chunkIds = new Set<string>();
  const messageIds = new Set<string>();
  const sourceCutoff = manifestRecord.sourceCutoff as string;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const projected = strictRecord(
      manifestRecord.chunks[index],
      MANIFEST_CHUNK_FIELDS,
      MANIFEST_CHUNK_FIELDS,
      null,
      'prepared_invalid',
    );
    const dialogue = validateMemoryV3Dialogue({
      caseId: `memory-v3-shadow:${root.userId}:${chunk.conversationId}`,
      messages: chunk.messages,
    });
    const first = dialogue.messages[0];
    const last = dialogue.messages[dialogue.messages.length - 1];
    for (let messageIndex = 0; messageIndex < dialogue.messages.length; messageIndex += 1) {
      const message = dialogue.messages[messageIndex];
      if (messageIds.has(message.id) || compareDateTime(message.createdAt, sourceCutoff) > 0) {
        fail(null, 'prepared_invalid');
      }
      messageIds.add(message.id);
      if (messageIndex > 0) {
        const previous = dialogue.messages[messageIndex - 1];
        const byTime = compareDateTime(previous.createdAt, message.createdAt);
        if (byTime > 0 || (byTime === 0 && previous.id >= message.id)) fail(null, 'prepared_invalid');
      }
    }
    if (!chunk || !projected || chunkIds.has(chunk.chunkId) ||
      !Number.isSafeInteger(chunk.conversationOrdinal) || chunk.conversationOrdinal < 0 ||
      !Number.isSafeInteger(chunk.chunkOrdinal) || chunk.chunkOrdinal < 0 ||
      chunk.messageCount !== dialogue.messages.length || chunk.messageCount <= 0 ||
      chunk.messageCount > profile.maxMessagesPerChunk ||
      chunk.userMessageCount !== dialogue.messages.filter((row) => row.role === 'user').length ||
      chunk.userMessageCount <= 0 ||
      chunk.firstCreatedAt !== first.createdAt || chunk.lastCreatedAt !== last.createdAt ||
      chunk.firstMessageId !== first.id || chunk.lastMessageId !== last.id ||
      chunk.sourceDigest !== canonicalLifecycleHistoryDigest({
        conversationId: chunk.conversationId,
        messages: dialogue.messages,
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
  const sorted = [...chunks].sort((left, right) => {
    const byTime = compareDateTime(left.lastCreatedAt, right.lastCreatedAt);
    if (byTime !== 0) return byTime;
    const byId = left.lastMessageId < right.lastMessageId ? -1 : left.lastMessageId > right.lastMessageId ? 1 : 0;
    if (byId !== 0) return byId;
    return left.conversationOrdinal !== right.conversationOrdinal
      ? left.conversationOrdinal - right.conversationOrdinal
      : left.chunkOrdinal - right.chunkOrdinal;
  });
  if (sorted.some((chunk, index) => chunk.chunkId !== chunks[index].chunkId)) fail(null, 'prepared_invalid');
  const ordinals = [...new Set(chunks.map((chunk) => chunk.conversationOrdinal))].sort((a, b) => a - b);
  if (ordinals.some((ordinal, index) => ordinal !== index) ||
    manifestRecord.conversationCount !== ordinals.length ||
    manifestRecord.conversations.length !== ordinals.length ||
    manifestRecord.messageCount !== messageCount ||
    manifestRecord.userMessageCount !== userMessageCount) fail(null, 'prepared_invalid');
  const conversations = ordinals.map((ordinal) => {
    const grouped = chunks.filter((chunk) => chunk.conversationOrdinal === ordinal);
    const conversationIds = new Set(grouped.map((chunk) => chunk.conversationId));
    if (conversationIds.size !== 1 || grouped.some((chunk, index) => chunk.chunkOrdinal !== index)) {
      fail(null, 'prepared_invalid');
    }
    for (let index = 1; index < grouped.length; index += 1) {
      const previous = grouped[index - 1];
      const current = grouped[index];
      const byTime = compareDateTime(previous.lastCreatedAt, current.firstCreatedAt);
      if (byTime > 0 || (byTime === 0 && previous.lastMessageId >= current.firstMessageId)) {
        fail(null, 'prepared_invalid');
      }
    }
    const fullMessages = grouped.flatMap((chunk) => chunk.messages.map((message) => ({ ...message })));
    const canonicalPartitions: typeof grouped[number]['messages'][] = [];
    let cursor = 0;
    while (cursor < fullMessages.length) {
      const maximumEnd = Math.min(cursor + profile.maxMessagesPerChunk, fullMessages.length);
      let selectedEnd = -1;
      for (let end = cursor + 1; end <= maximumEnd; end += 1) {
        const candidate = fullMessages.slice(cursor, end);
        if (!candidate.some((message) => message.role === 'user')) continue;
        const dialogue = validateMemoryV3Dialogue({
          caseId: `memory-v3-shadow:${root.userId}:${grouped[0].conversationId}`,
          messages: candidate,
        });
        const serialized = JSON.stringify(buildMemoryV3ExtractorRequest(dialogue));
        if (new TextEncoder().encode(serialized).byteLength > profile.maxExtractorRequestBytes) break;
        selectedEnd = end;
      }
      if (selectedEnd < 0) {
        // Mirrors chunkOneConversation's own trailing-assistant-tail exception
        // (lifecycle-history-backfill-contract.ts): this re-derivation must
        // tolerate the same shape it's checking against, or a legitimately
        // prepared artifact whose last chunk dropped a trailing assistant-only
        // tail fails this from-scratch recomputation instead of matching it.
        const remainder = fullMessages.slice(cursor);
        if (canonicalPartitions.length > 0 && !remainder.some((message) => message.role === 'user')) break;
        fail(null, 'prepared_invalid');
      }
      canonicalPartitions.push(fullMessages.slice(cursor, selectedEnd));
      cursor = selectedEnd;
    }
    if (canonicalPartitions.length !== grouped.length ||
      canonicalPartitions.some((messages, index) =>
        canonicalStringify(messages) !== canonicalStringify(grouped[index].messages)
      )) {
      fail(null, 'prepared_invalid');
    }
    const expected = {
      conversationOrdinal: ordinal,
      messageCount: grouped.reduce((sum, chunk) => sum + chunk.messageCount, 0),
      userMessageCount: grouped.reduce((sum, chunk) => sum + chunk.userMessageCount, 0),
      firstCreatedAt: grouped[0].firstCreatedAt,
      lastCreatedAt: grouped[grouped.length - 1].lastCreatedAt,
      chunkCount: grouped.length,
    };
    const supplied = strictRecord(
      manifestRecord.conversations[ordinal],
      MANIFEST_CONVERSATION_FIELDS,
      MANIFEST_CONVERSATION_FIELDS,
      null,
      'prepared_invalid',
    );
    if (canonicalStringify(expected) !== canonicalStringify(supplied)) fail(null, 'prepared_invalid');
    return expected;
  });
  const canonicalConversationOrder = ordinals.map((ordinal) => {
    const grouped = chunks.filter((chunk) => chunk.conversationOrdinal === ordinal);
    return {
      ordinal,
      firstCreatedAt: grouped[0].firstCreatedAt,
      conversationId: grouped[0].conversationId,
    };
  }).sort((left, right) => {
    const byTime = compareDateTime(left.firstCreatedAt, right.firstCreatedAt);
    return byTime !== 0
      ? byTime
      : left.conversationId < right.conversationId
      ? -1
      : left.conversationId > right.conversationId
      ? 1
      : 0;
  });
  if (canonicalConversationOrder.some((entry, index) => entry.ordinal !== index)) {
    fail(null, 'prepared_invalid');
  }
  const manifest: LifecycleHistoryBackfillManifest = {
    schemaVersion: 'memory-v3-lifecycle-history-manifest-v1',
    profileId: profile.profileId,
    sourceCutoff,
    sourceSnapshotDigest: manifestRecord.sourceSnapshotDigest,
    conversationCount: ordinals.length,
    messageCount,
    userMessageCount,
    chunkCount: chunks.length,
    maxProviderCalls: chunks.length * profile.maxCallsPerChunk,
    conversations,
    chunks: chunks.map((chunk) => ({
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
    })),
  };
  return { userId: root.userId, manifest, chunks };
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

type ExtractorTransport = MemoryV3TransportResult & {
  resolvedModel: LifecycleHistoryResolvedModel;
};
type ReconcilerTransport = MemoryV3LifecycleTransportResult & {
  resolvedModel: LifecycleHistoryResolvedModel;
};
type ExtractorAdapter = (
  request: Parameters<MemoryV3ModelAdapter>[0],
) => Promise<ExtractorTransport>;
type ReconcilerAdapter = (
  request: Parameters<MemoryV3LifecycleModelAdapter>[0],
) => Promise<ReconcilerTransport>;

function inspectResolvedModel(
  value: unknown,
  stage: 'extractor_transport' | 'reconciler_transport',
): LifecycleHistoryResolvedModel {
  if (value !== LIFECYCLE_HISTORY_PRIMARY_MODEL && value !== LIFECYCLE_HISTORY_FALLBACK_MODEL) {
    fail(stage, `${stage}_invalid`);
  }
  return value;
}

function inspectExtractorTransport(value: unknown): ExtractorTransport {
  const root = strictRecord(value, TRANSPORT_FIELDS, TRANSPORT_FIELDS, 'extractor_transport', 'extractor_transport_invalid');
  if (typeof root.content !== 'string') fail('extractor_transport', 'extractor_transport_invalid');
  return {
    content: root.content,
    usage: inspectUsage(root.usage, 'extractor_transport'),
    resolvedModel: inspectResolvedModel(root.resolvedModel, 'extractor_transport'),
  };
}

function inspectReconcilerTransport(value: unknown): ReconcilerTransport {
  const root = strictRecord(
    value,
    RECONCILER_TRANSPORT_FIELDS,
    RECONCILER_TRANSPORT_FIELDS,
    'reconciler_transport',
    'reconciler_transport_invalid',
  );
  if (typeof root.rawContent !== 'string') fail('reconciler_transport', 'reconciler_transport_invalid');
  return {
    rawContent: root.rawContent,
    usage: inspectUsage(root.usage, 'reconciler_transport'),
    resolvedModel: inspectResolvedModel(root.resolvedModel, 'reconciler_transport'),
  };
}

function inspectAdapter(value: unknown): void {
  if (typeof value !== 'function' || isProxy(value)) fail(null, 'adapter_invalid');
}

interface LifecycleHistoryProviderCallGate {
  call<T>(stage: 'extractor_transport' | 'reconciler_transport', inner: () => Promise<T>): Promise<T>;
  getAttemptCount(): number;
  isOwnCapError(error: unknown): boolean;
}

function createLifecycleHistoryProviderCallGate(maxRequests: number): LifecycleHistoryProviderCallGate {
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) fail(null, 'provider_call_cap_invalid');
  let attemptCount = 0;
  const capErrors = new WeakSet<object>();
  return {
    async call<T>(stage: 'extractor_transport' | 'reconciler_transport', inner: () => Promise<T>): Promise<T> {
      if (attemptCount >= maxRequests) {
        const error = createEngineError(stage, 'provider_call_cap_exceeded');
        capErrors.add(error);
        throw error;
      }
      attemptCount += 1;
      return await inner();
    },
    getAttemptCount(): number {
      return attemptCount;
    },
    isOwnCapError(error: unknown): boolean {
      return typeof error === 'object' && error !== null && capErrors.has(error);
    },
  };
}

/** Narrow test-only seam for the shared runtime call gate; not used by orchestration code. */
export function __testOnlyCreateLifecycleHistoryProviderCallGate(maxRequests: number): {
  callExtractor<T>(inner: () => Promise<T>): Promise<T>;
  callReconciler<T>(inner: () => Promise<T>): Promise<T>;
  getAttemptCount(): number;
} {
  const gate = createLifecycleHistoryProviderCallGate(maxRequests);
  return {
    callExtractor: <T>(inner: () => Promise<T>) => gate.call('extractor_transport', inner),
    callReconciler: <T>(inner: () => Promise<T>) => gate.call('reconciler_transport', inner),
    getAttemptCount: () => gate.getAttemptCount(),
  };
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
    modelRoute: LIFECYCLE_HISTORY_MODEL_ROUTE,
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
    providerModelFallbackCount: 0,
    resolvedModelCounts: { primary: 0, fallback: 0 },
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
  extractorAdapter?: ExtractorAdapter;
  reconcilerAdapter?: ReconcilerAdapter;
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
  const extractorAdapter = root.extractorAdapter as ExtractorAdapter;
  const reconcilerAdapter = root.reconcilerAdapter as ReconcilerAdapter;
  const providerCallGate = createLifecycleHistoryProviderCallGate(budget.maxRequests);
  const usages: Usage[] = [];
  let successfulTransportCount = 0;
  const resolvedModelCounts = { primary: 0, fallback: 0 };
  const recordResolvedModel = (model: LifecycleHistoryResolvedModel) => {
    if (model === LIFECYCLE_HISTORY_PRIMARY_MODEL) resolvedModelCounts.primary += 1;
    else resolvedModelCounts.fallback += 1;
  };
  const callExtractorOnce = async (request: Parameters<MemoryV3ModelAdapter>[0]) => {
    let raw: unknown;
    try {
      raw = await providerCallGate.call('extractor_transport', () => extractorAdapter(request));
    } catch (error) {
      if (providerCallGate.isOwnCapError(error)) throw error;
      fail('extractor_transport', 'extractor_transport_failed');
    }
    const inspected = inspectExtractorTransport(raw);
    successfulTransportCount += 1;
    recordResolvedModel(inspected.resolvedModel);
    if (inspected.usage !== null) usages.push(inspected.usage);
    return inspected;
  };
  const callReconcilerOnce = async (request: Parameters<MemoryV3LifecycleModelAdapter>[0]) => {
    let raw: unknown;
    try {
      raw = await providerCallGate.call('reconciler_transport', () => reconcilerAdapter(request));
    } catch (error) {
      if (providerCallGate.isOwnCapError(error)) throw error;
      fail('reconciler_transport', 'reconciler_transport_failed');
    }
    const inspected = inspectReconcilerTransport(raw);
    successfulTransportCount += 1;
    recordResolvedModel(inspected.resolvedModel);
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
        // scopeMode is 'cross_conversation' (not dialogue's 'conversation'): this
        // engine threads one continuous state across every conversation in the
        // account, matching lifecycleShadowRunner.ts's own live call to this same
        // shared contract function. Missing this argument made every real
        // execution fail on its first chunk regardless of content (25.09.2026).
        extraction = await normalizeMemoryV3LayeredResponse(
          parsedExtraction,
          dialogue,
          profile.extractorVersion,
          'cross_conversation',
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
        extractorResolvedModel: extractorTransport.resolvedModel,
        reconcilerResolvedModel: reconcilerTransport.resolvedModel,
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
  const providerCallCount = providerCallGate.getAttemptCount();
  const complete = failures.length === 0 && chunkResults.length === prepared.chunks.length &&
    providerCallCount === budget.maxRequests &&
    resolvedModelCounts.primary + resolvedModelCounts.fallback === providerCallCount;
  const result = deepFreeze<LifecycleHistoryBackfillResult>({
    ...base,
    attemptedChunkCount,
    successChunkCount: chunkResults.length,
    failureCount: failures.length,
    providerCallCount,
    providerModelFallbackCount: resolvedModelCounts.fallback,
    resolvedModelCounts,
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
