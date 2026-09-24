import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  validateMemoryV3Dialogue,
} from '../../supabase/functions/_shared/memoryV3/contract.ts';
import type { MemoryV3DialogueMessage } from '../../supabase/functions/_shared/memoryV3/messages.ts';
import { buildMemoryV3ExtractorRequest } from '../../supabase/functions/_shared/memoryV3/prompt.ts';
import { canonicalStringify } from './contracts.mjs';
import {
  LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID,
  getLifecycleHistoryBackfillProfile,
  type LifecycleHistoryBackfillProfile,
} from './lifecycle-history-backfill-profile.ts';

export interface LifecycleHistoryConversationInput {
  conversationId: string;
  createdAt: string;
  messages: MemoryV3DialogueMessage[];
}

export interface LifecycleHistorySourceSnapshotInput {
  userId: string;
  sourceCutoff: string;
  conversations: LifecycleHistoryConversationInput[];
}

export interface LifecycleHistoryPreparedChunk {
  chunkId: string;
  conversationOrdinal: number;
  chunkOrdinal: number;
  conversationId: string;
  messages: MemoryV3DialogueMessage[];
  firstCreatedAt: string;
  lastCreatedAt: string;
  firstMessageId: string;
  lastMessageId: string;
  messageCount: number;
  userMessageCount: number;
  extractorRequestBytes: number;
  extractorRequestSha256: string;
  sourceDigest: string;
}

export interface LifecycleHistoryBackfillManifest {
  schemaVersion: 'memory-v3-lifecycle-history-manifest-v1';
  profileId: typeof LIFECYCLE_HISTORY_BACKFILL_PROFILE_ID;
  sourceCutoff: string;
  sourceSnapshotDigest: string;
  conversationCount: number;
  messageCount: number;
  userMessageCount: number;
  chunkCount: number;
  maxProviderCalls: number;
  conversations: Array<{
    conversationOrdinal: number;
    messageCount: number;
    userMessageCount: number;
    firstCreatedAt: string;
    lastCreatedAt: string;
    chunkCount: number;
  }>;
  chunks: Array<{
    chunkId: string;
    conversationOrdinal: number;
    chunkOrdinal: number;
    messageCount: number;
    userMessageCount: number;
    firstCreatedAt: string;
    lastCreatedAt: string;
    extractorRequestBytes: number;
    extractorRequestSha256: string;
    sourceDigest: string;
  }>;
}

export interface PreparedLifecycleHistoryBackfill {
  userId: string;
  manifest: LifecycleHistoryBackfillManifest;
  chunks: LifecycleHistoryPreparedChunk[];
}

const INPUT_FIELDS = ['profileId', 'snapshot'] as const;
const SNAPSHOT_FIELDS = ['userId', 'sourceCutoff', 'conversations'] as const;
const CONVERSATION_FIELDS = ['conversationId', 'createdAt', 'messages'] as const;
const MESSAGE_FIELDS = ['id', 'role', 'text', 'createdAt'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const OWN_ERRORS = new WeakSet<object>();
const ERROR_TOKENS = new WeakMap<object, object>();

function makeError(token: object): Error {
  const error = new Error('[memory-v3:lifecycle-history-backfill-contract] source is invalid');
  error.name = 'MemoryV3LifecycleHistoryBackfillContractError';
  OWN_ERRORS.add(error);
  ERROR_TOKENS.set(error, token);
  return error;
}

function fail(token: object): never {
  throw makeError(token);
}

function boundary<T>(operation: (token: object) => T): T {
  const token = Object.freeze({});
  try {
    return operation(token);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      OWN_ERRORS.has(error) &&
      ERROR_TOKENS.get(error) === token
    ) {
      throw error;
    }
    throw makeError(token);
  }
}

function projectRecord(
  token: object,
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
      fail(token);
    }
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      OWN_ERRORS.has(error) &&
      ERROR_TOKENS.get(error) === token
    ) {
      throw error;
    }
    fail(token);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(token);
  if (keys.length !== fields.length) fail(token);
  const allowed = new Set(fields);
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(token);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token);
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      fail(token);
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(output, field)) fail(token);
  }
  return output;
}

function projectDenseArray(token: object, value: unknown): unknown[] {
  let keys: PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || !Array.isArray(value)) {
      fail(token);
    }
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      OWN_ERRORS.has(error) &&
      ERROR_TOKENS.get(error) === token
    ) {
      throw error;
    }
    fail(token);
  }
  if (
    !lengthDescriptor ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    fail(token);
  }
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) fail(token);
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(token);
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.value === undefined
    ) {
      fail(token);
    }
    output.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= length
    ) {
      fail(token);
    }
  }
  return output;
}

function parseDateTimeNanoseconds(value: unknown): bigint | null {
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
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return null;
    }
  }
  const parsedMilliseconds = Date.parse(value);
  if (!Number.isFinite(parsedMilliseconds)) return null;
  const fractionalNanoseconds = (match[7] ?? '').padEnd(9, '0');
  const subMillisecondNanoseconds = BigInt(fractionalNanoseconds.slice(3) || '0');
  return BigInt(parsedMilliseconds) * 1_000_000n + subMillisecondNanoseconds;
}

function compareDateTimes(left: string, right: string): number {
  const leftNanoseconds = parseDateTimeNanoseconds(left);
  const rightNanoseconds = parseDateTimeNanoseconds(right);
  if (leftNanoseconds === null || rightNanoseconds === null) {
    throw new Error('trusted date-time is invalid');
  }
  return leftNanoseconds < rightNanoseconds ? -1 : leftNanoseconds > rightNanoseconds ? 1 : 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMessages(
  left: MemoryV3DialogueMessage,
  right: MemoryV3DialogueMessage,
): number {
  const byTime = compareDateTimes(left.createdAt, right.createdAt);
  return byTime !== 0 ? byTime : compareStrings(left.id, right.id);
}

function cloneJsonValue(token: object, value: unknown, active: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(token);
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)) fail(token);
  if (active.has(value)) fail(token);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return projectDenseArray(token, value).map((entry) => cloneJsonValue(token, entry, active));
    }
    let prototype: object | null;
    let keys: PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      fail(token);
    }
    if (prototype !== Object.prototype && prototype !== null) fail(token);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') fail(token);
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        fail(token);
      }
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        descriptor.value === undefined
      ) {
        fail(token);
      }
      Object.defineProperty(output, key, {
        value: cloneJsonValue(token, descriptor.value, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function digestCanonicalTrusted(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

export function canonicalLifecycleHistoryDigest(value: unknown): string {
  return boundary((token) => {
    const cloned = cloneJsonValue(token, value, new WeakSet<object>());
    return digestCanonicalTrusted(cloned);
  });
}

function validateAndCloneSourceSnapshot(
  token: object,
  value: unknown,
): LifecycleHistorySourceSnapshotInput {
  const root = projectRecord(token, value, SNAPSHOT_FIELDS);
  if (typeof root.userId !== 'string' || !UUID.test(root.userId)) fail(token);
  const cutoffNanoseconds = parseDateTimeNanoseconds(root.sourceCutoff);
  if (cutoffNanoseconds === null) fail(token);
  const sourceCutoff = root.sourceCutoff as string;
  const rawConversations = projectDenseArray(token, root.conversations);
  const conversationIds = new Set<string>();
  const messageIds = new Set<string>();
  const conversations = rawConversations.map((raw): LifecycleHistoryConversationInput => {
    const source = projectRecord(token, raw, CONVERSATION_FIELDS);
    const conversationCreatedAt = parseDateTimeNanoseconds(source.createdAt);
    if (
      typeof source.conversationId !== 'string' ||
      !UUID.test(source.conversationId) ||
      conversationIds.has(source.conversationId) ||
      conversationCreatedAt === null ||
      conversationCreatedAt > cutoffNanoseconds
    ) {
      fail(token);
    }
    conversationIds.add(source.conversationId);
    const rawMessages = projectDenseArray(token, source.messages);
    if (rawMessages.length === 0) fail(token);
    const messages = rawMessages.map((rawMessage): MemoryV3DialogueMessage => {
      const row = projectRecord(token, rawMessage, MESSAGE_FIELDS);
      const messageCreatedAt = parseDateTimeNanoseconds(row.createdAt);
      if (
        typeof row.id !== 'string' ||
        !UUID.test(row.id) ||
        messageIds.has(row.id) ||
        (row.role !== 'user' && row.role !== 'assistant') ||
        typeof row.text !== 'string' ||
        row.text.trim().length === 0 ||
        messageCreatedAt === null ||
        messageCreatedAt > cutoffNanoseconds ||
        messageCreatedAt < conversationCreatedAt
      ) {
        fail(token);
      }
      messageIds.add(row.id);
      return {
        id: row.id,
        role: row.role,
        text: row.text,
        createdAt: row.createdAt,
      } as MemoryV3DialogueMessage;
    });
    messages.sort(compareMessages);
    return {
      conversationId: source.conversationId,
      createdAt: source.createdAt,
      messages,
    };
  });
  return {
    userId: root.userId,
    sourceCutoff,
    conversations,
  } as LifecycleHistorySourceSnapshotInput;
}

function canonicalizeConversations(
  source: LifecycleHistorySourceSnapshotInput,
): LifecycleHistoryConversationInput[] {
  return [...source.conversations].sort((left, right) => {
    const byFirstMessage = compareDateTimes(
      left.messages[0].createdAt,
      right.messages[0].createdAt,
    );
    return byFirstMessage !== 0
      ? byFirstMessage
      : compareStrings(left.conversationId, right.conversationId);
  });
}

function serializeExtractorRequest(
  source: LifecycleHistorySourceSnapshotInput,
  conversation: LifecycleHistoryConversationInput,
  messages: MemoryV3DialogueMessage[],
): { bytes: number; sha256: string } {
  const dialogue = validateMemoryV3Dialogue({
    caseId: `memory-v3-shadow:${source.userId}:${conversation.conversationId}`,
    messages,
  });
  const serialized = JSON.stringify(buildMemoryV3ExtractorRequest(dialogue));
  return {
    bytes: new TextEncoder().encode(serialized).byteLength,
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function chunkOneConversation(input: {
  profile: LifecycleHistoryBackfillProfile;
  source: LifecycleHistorySourceSnapshotInput;
  conversation: LifecycleHistoryConversationInput;
  conversationOrdinal: number;
  token: object;
}): LifecycleHistoryPreparedChunk[] {
  const { profile, source, conversation, conversationOrdinal, token } = input;
  const chunks: LifecycleHistoryPreparedChunk[] = [];
  let cursor = 0;
  while (cursor < conversation.messages.length) {
    const maximumEnd = Math.min(
      cursor + profile.maxMessagesPerChunk,
      conversation.messages.length,
    );
    let selectedEnd = -1;
    let selectedRequest: { bytes: number; sha256: string } | null = null;
    for (let end = cursor + 1; end <= maximumEnd; end += 1) {
      const candidate = conversation.messages.slice(cursor, end).map((row) => ({ ...row }));
      if (!candidate.some((row) => row.role === 'user')) continue;
      let request: { bytes: number; sha256: string };
      try {
        request = serializeExtractorRequest(source, conversation, candidate);
      } catch {
        fail(token);
      }
      if (request.bytes > profile.maxExtractorRequestBytes) break;
      selectedEnd = end;
      selectedRequest = request;
    }
    if (selectedEnd < 0 || selectedRequest === null) {
      // A conversation with no usable prefix at all (chunks.length === 0)
      // stays a hard failure -- an existing test ('requires a user
      // message in every chunk and fails on an unusable assistant
      // prefix') deliberately locks in that a conversation with zero
      // real user engagement from the very start is an anomaly worth
      // surfacing loudly, not silently producing an empty result for.
      //
      // But once at least one real chunk has already been collected
      // (chunks.length > 0), a trailing stretch with no further user
      // turn is the normal, common state for an active conversation --
      // it just ends "hanging" on the AI's last reply, with nothing new
      // for the extractor to learn from a reply nobody has responded to
      // yet. Stop here instead of failing the whole conversation. Only
      // keep failing if a user message exists somewhere later that this
      // window's own size cap prevented from ever being reached -- an
      // implausibly long assistant-only run in the middle of a real
      // conversation would still be a genuine anomaly worth surfacing
      // loudly, not something to silently skip past.
      const remainder = conversation.messages.slice(cursor);
      if (chunks.length > 0 && !remainder.some((row) => row.role === 'user')) break;
      fail(token);
    }

    const messages = conversation.messages.slice(cursor, selectedEnd).map((row) => ({ ...row }));
    const first = messages[0];
    const last = messages[messages.length - 1];
    const chunkOrdinal = chunks.length;
    const sourceDigest = digestCanonicalTrusted({
      conversationId: conversation.conversationId,
      messages,
    });
    const chunkId = digestCanonicalTrusted([
      profile.profileId,
      sourceDigest,
      conversationOrdinal,
      chunkOrdinal,
    ]);
    chunks.push({
      chunkId,
      conversationOrdinal,
      chunkOrdinal,
      conversationId: conversation.conversationId,
      messages,
      firstCreatedAt: first.createdAt,
      lastCreatedAt: last.createdAt,
      firstMessageId: first.id,
      lastMessageId: last.id,
      messageCount: messages.length,
      userMessageCount: messages.filter((row) => row.role === 'user').length,
      extractorRequestBytes: selectedRequest.bytes,
      extractorRequestSha256: selectedRequest.sha256,
      sourceDigest,
    });
    cursor = selectedEnd;
  }
  return chunks;
}

function comparePreparedChunks(
  left: LifecycleHistoryPreparedChunk,
  right: LifecycleHistoryPreparedChunk,
): number {
  const byTime = compareDateTimes(left.lastCreatedAt, right.lastCreatedAt);
  if (byTime !== 0) return byTime;
  const byId = compareStrings(left.lastMessageId, right.lastMessageId);
  if (byId !== 0) return byId;
  if (left.conversationOrdinal !== right.conversationOrdinal) {
    return left.conversationOrdinal - right.conversationOrdinal;
  }
  return left.chunkOrdinal - right.chunkOrdinal;
}

function projectManifest(
  profile: LifecycleHistoryBackfillProfile,
  source: LifecycleHistorySourceSnapshotInput,
  conversations: LifecycleHistoryConversationInput[],
  chunks: LifecycleHistoryPreparedChunk[],
): LifecycleHistoryBackfillManifest {
  const messageCount = conversations.reduce(
    (total, conversation) => total + conversation.messages.length,
    0,
  );
  const userMessageCount = conversations.reduce(
    (total, conversation) =>
      total + conversation.messages.filter((row) => row.role === 'user').length,
    0,
  );
  const sourceSnapshotDigest = digestCanonicalTrusted({
    profileId: profile.profileId,
    userId: source.userId,
    sourceCutoff: source.sourceCutoff,
    conversations,
  });
  return {
    schemaVersion: 'memory-v3-lifecycle-history-manifest-v1',
    profileId: profile.profileId,
    sourceCutoff: source.sourceCutoff,
    sourceSnapshotDigest,
    conversationCount: conversations.length,
    messageCount,
    userMessageCount,
    chunkCount: chunks.length,
    maxProviderCalls: chunks.length * profile.maxCallsPerChunk,
    conversations: conversations.map((conversation, conversationOrdinal) => ({
      conversationOrdinal,
      messageCount: conversation.messages.length,
      userMessageCount: conversation.messages.filter((row) => row.role === 'user').length,
      firstCreatedAt: conversation.messages[0].createdAt,
      lastCreatedAt: conversation.messages[conversation.messages.length - 1].createdAt,
      chunkCount: chunks.filter((chunk) => chunk.conversationOrdinal === conversationOrdinal).length,
    })),
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
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

export function prepareLifecycleHistoryBackfill(input: {
  profileId: unknown;
  snapshot: unknown;
}): PreparedLifecycleHistoryBackfill {
  return boundary((token) => {
    const root = projectRecord(token, input, INPUT_FIELDS);
    const profile = getLifecycleHistoryBackfillProfile(root.profileId);
    const source = validateAndCloneSourceSnapshot(token, root.snapshot);
    const conversations = canonicalizeConversations(source);
    const chunks = conversations.flatMap((conversation, conversationOrdinal) =>
      chunkOneConversation({
        profile,
        source,
        conversation,
        conversationOrdinal,
        token,
      })
    );
    chunks.sort(comparePreparedChunks);
    const manifest = projectManifest(profile, source, conversations, chunks);
    return deepFreeze({ userId: source.userId, manifest, chunks });
  });
}
