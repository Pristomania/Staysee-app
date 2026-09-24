/** Strict injected-I/O CLI boundary for the Memory V3 dialogue-scope historical backfill. */

import { extname, isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';

import {
  buildDialogueHistoryReviewPacket,
  runDialogueHistoryBackfill,
  type DialogueHistoryBackfillResult,
} from './dialogue-history-backfill-engine.ts';
import {
  prepareDialogueHistoryBackfill,
  type DialogueHistoryConversationInput,
} from './dialogue-history-backfill-contract.ts';
import {
  getLifecycleHistoryBackfillProfile,
  validateLifecycleHistoryPriceSnapshot,
  type LifecycleHistoryPriceSnapshot,
} from './lifecycle-history-backfill-profile.ts';
import {
  inspectLifecycleHistorySource,
  type LifecycleHistorySourceReader,
} from './lifecycle-history-backfill-source.ts';
import type {
  LifecycleHistoryPreparedChunk,
  PreparedLifecycleHistoryBackfill,
} from './lifecycle-history-backfill-contract.ts';
import { createDialogueHistoryRoutedAdapters } from
  './dialogue-history-backfill-provider.ts';
import { captureConversationRevisions } from './dialogue-history-backfill-revision.ts';

type JsonRecord = Record<string, unknown>;
type SourceReaderFactory = (
  url: string,
  serviceKey: string,
) => LifecycleHistorySourceReader;
type RevisionClientFactory = (url: string, serviceKey: string) => unknown;

const PREFIX = '[memory-v3:dialogue-history-backfill-cli]';
const ERROR_NAME = 'MemoryV3DialogueHistoryBackfillCliError';
const OPTIONS_FIELDS = [
  'argv', 'sourceReader', 'readEnvText', 'fetchImpl', 'nowMs', 'revisionClient',
] as const;
const SOURCE_READER_FIELDS = ['listConversationsPage', 'listMessagesPage'] as const;
const MEMORY_V3_DIALOGUE_HEADS_TABLE = 'memory_v3_dialogue_heads';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OWN_ERRORS = new WeakSet<object>();

function fail(): never {
  const error = new Error(`${PREFIX} command failed`);
  error.name = ERROR_NAME;
  OWN_ERRORS.add(error);
  throw error;
}

function isOwnError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && OWN_ERRORS.has(error);
}

async function boundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isOwnError(error)) throw error;
    return fail();
  }
}

function safePrototype(value: object): object | null {
  try {
    if (isProxy(value)) return fail();
    return Object.getPrototypeOf(value);
  } catch {
    return fail();
  }
}

function safeKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return fail();
  }
}

function dataValue(
  value: object,
  key: PropertyKey,
  enumerable: boolean,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return fail();
  }
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== enumerable) {
    return fail();
  }
  return descriptor.value;
}

function inspectOptions(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || safePrototype(value) !== Object.prototype) {
    return fail();
  }
  const keys = safeKeys(value);
  if (
    keys.length !== OPTIONS_FIELDS.length ||
    keys.some((key) => typeof key !== 'string' ||
      !OPTIONS_FIELDS.includes(key as typeof OPTIONS_FIELDS[number]))
  ) {
    return fail();
  }
  const projected: JsonRecord = Object.create(null);
  for (const field of OPTIONS_FIELDS) {
    projected[field] = dataValue(value, field, true);
  }
  return projected;
}

function inspectArgv(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return fail();
  let array = false;
  try {
    if (isProxy(value)) return fail();
    array = Array.isArray(value);
  } catch {
    return fail();
  }
  if (!array || safePrototype(value) !== Array.prototype) return fail();
  const lengthValue = dataValue(value, 'length', false);
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) return fail();
  const length = lengthValue as number;
  const keys = safeKeys(value);
  if (keys.length !== length + 1) return fail();
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = dataValue(value, String(index), true);
    if (typeof entry !== 'string') return fail();
    output.push(entry);
  }
  if (keys.some((key) => {
    if (key === 'length') return false;
    return typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length;
  })) return fail();
  return output;
}

function isAbsoluteJsonPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    isAbsolute(value) && extname(value).toLowerCase() === '.json';
}

function parseArgv(value: unknown): {
  mode: 'inspect' | 'execute';
  profileId: string;
  sourceCutoff: string;
  expectedSourceSha256: string | null;
  priceSnapshotFile: string;
  maxBudgetUsd: string;
  safeOutputFile: string | null;
} {
  const argv = inspectArgv(value);
  const inspect = argv[0] === '--inspect-source';
  const execute = argv[0] === '--execute-history-backfill-paid-requests';
  if ((!inspect && !execute) || argv.length !== (inspect ? 9 : 13)) return fail();
  const expectedFlags = inspect
    ? [[1, '--profile'], [3, '--source-cutoff'], [5, '--price-snapshot-file'], [7, '--max-budget-usd']] as const
    : [[1, '--profile'], [3, '--source-cutoff'], [5, '--expected-source-sha256'],
        [7, '--price-snapshot-file'], [9, '--max-budget-usd'], [11, '--safe-output-file']] as const;
  for (const [index, expected] of expectedFlags) {
    if (argv[index] !== expected) return fail();
  }
  let profile;
  try {
    profile = getLifecycleHistoryBackfillProfile(argv[2]);
  } catch {
    return fail();
  }
  const sourceCutoff = argv[4];
  if (typeof sourceCutoff !== 'string' || sourceCutoff.trim() !== sourceCutoff) return fail();
  if (inspect) {
    if (!isAbsoluteJsonPath(argv[6]) || typeof argv[8] !== 'string') return fail();
    return {
      mode: 'inspect',
      profileId: profile.profileId,
      sourceCutoff,
      expectedSourceSha256: null,
      priceSnapshotFile: argv[6],
      maxBudgetUsd: argv[8],
      safeOutputFile: null,
    };
  }
  if (!SHA256.test(argv[6]) || !isAbsoluteJsonPath(argv[8]) ||
    typeof argv[10] !== 'string' || !isAbsoluteJsonPath(argv[12])) return fail();
  return {
    mode: 'execute',
    profileId: profile.profileId,
    sourceCutoff,
    expectedSourceSha256: argv[6],
    priceSnapshotFile: argv[8],
    maxBudgetUsd: argv[10],
    safeOutputFile: argv[12],
  };
}

async function readText(reader: unknown, selector: string): Promise<string> {
  if (typeof reader !== 'function' || isProxy(reader)) return fail();
  let value: unknown;
  try {
    value = await (reader as (path: string) => Promise<string>)(selector);
  } catch {
    return fail();
  }
  if (typeof value !== 'string') return fail();
  return value;
}

function nonEmpty(value: string): string {
  if (value.length === 0 || value.trim() !== value) return fail();
  return value;
}

function httpsUrl(value: string): string {
  nonEmpty(value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    return fail();
  }
  return value;
}

function parsePriceSnapshot(text: string, nowMs: number): LifecycleHistoryPriceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  try {
    return validateLifecycleHistoryPriceSnapshot(parsed, nowMs);
  } catch {
    return fail();
  }
}

function resolveSourceReader(
  candidate: unknown,
  url: string,
  serviceKey: string,
): LifecycleHistorySourceReader {
  if (typeof candidate === 'function') {
    if (isProxy(candidate)) return fail();
    try {
      return (candidate as SourceReaderFactory)(url, serviceKey);
    } catch {
      return fail();
    }
  }
  return candidate as LifecycleHistorySourceReader;
}

function preflightSourceReader(candidate: unknown): void {
  if (typeof candidate === 'function') {
    if (isProxy(candidate)) return fail();
    return;
  }
  if (typeof candidate !== 'object' || candidate === null || isProxy(candidate)) return fail();
  let array: boolean;
  try {
    array = Array.isArray(candidate);
  } catch {
    return fail();
  }
  const prototype = safePrototype(candidate);
  if (array || (prototype !== Object.prototype && prototype !== null)) return fail();
  const keys = safeKeys(candidate);
  if (keys.length !== SOURCE_READER_FIELDS.length || keys.some((key) =>
    typeof key !== 'string' ||
    !SOURCE_READER_FIELDS.includes(key as typeof SOURCE_READER_FIELDS[number]))) return fail();
  for (const field of SOURCE_READER_FIELDS) {
    const method = dataValue(candidate, field, true);
    if (typeof method !== 'function' || isProxy(method)) return fail();
  }
}

/** Resolves the injected `revisionClient` exactly like `resolveSourceReader`
 * resolves `sourceReader`: either a factory `(url, serviceKey) => client` or
 * a client value handed over directly. In production this factory is meant
 * to close over and return the SAME Supabase client instance used to build
 * `sourceReader`'s reader (see `createLifecycleHistorySupabaseReader` in
 * lifecycle-history-backfill-source.ts for how that client is constructed
 * and shaped -- a plain `{ from(table) }`-style object), so revision reads
 * never open a second, independent connection. */
function resolveRevisionClient(candidate: unknown, url: string, serviceKey: string): unknown {
  if (typeof candidate === 'function') {
    if (isProxy(candidate)) return fail();
    try {
      return (candidate as RevisionClientFactory)(url, serviceKey);
    } catch {
      return fail();
    }
  }
  return candidate;
}

function preflightRevisionClient(candidate: unknown): void {
  if (typeof candidate === 'function') {
    if (isProxy(candidate)) return fail();
    return;
  }
  getSupabaseFromMethod(candidate);
}

/** Safely retrieves an own-or-inherited method by name, without ever invoking
 * a getter/proxy trap along the way -- mirrors the defensive method lookup
 * `lifecycle-history-backfill-source.ts` already uses internally for its own
 * Supabase client. Deliberately loose about any OTHER properties the target
 * has (a real SupabaseClient carries many), unlike preflightSourceReader's
 * exact-shape check on the narrow reader interface. */
function safeMethod(target: unknown, name: string): (...args: unknown[]) => unknown {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null || isProxy(target)) {
    return fail();
  }
  let cursor: object | null = target as object;
  const seen = new Set<object>();
  try {
    while (cursor !== null) {
      if (isProxy(cursor) || seen.has(cursor)) return fail();
      seen.add(cursor);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
          return fail();
        }
        return descriptor.value.bind(target);
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch (error) {
    if (isOwnError(error)) throw error;
    return fail();
  }
  return fail();
}

function getSupabaseFromMethod(client: unknown): (...args: unknown[]) => unknown {
  return safeMethod(client, 'from');
}

function callMethod(target: unknown, name: string, ...args: unknown[]): unknown {
  return safeMethod(target, name)(...args);
}

/** Validates a `.maybeSingle()`-style Postgrest response and extracts the
 * conversation's current `state_revision`, defaulting to 0 when no row
 * exists yet for that conversation (never touched by the live pipeline). */
function inspectRevisionResponse(value: unknown): number {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
    return fail();
  }
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return fail();
  }
  const allowed = new Set(['data', 'error', 'count', 'status', 'statusText']);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) return fail();
  }
  const dataDescriptor = Object.getOwnPropertyDescriptor(value, 'data');
  const errorDescriptor = Object.getOwnPropertyDescriptor(value, 'error');
  if (
    !dataDescriptor || !errorDescriptor ||
    dataDescriptor.enumerable !== true || errorDescriptor.enumerable !== true ||
    !('value' in dataDescriptor) || !('value' in errorDescriptor) ||
    errorDescriptor.value !== null
  ) {
    return fail();
  }
  const data = dataDescriptor.value;
  if (data === null) return 0;
  if (typeof data !== 'object' || isProxy(data) || Array.isArray(data)) return fail();
  let rowKeys: PropertyKey[];
  try {
    rowKeys = Reflect.ownKeys(data);
  } catch {
    return fail();
  }
  const rowDescriptor = Object.getOwnPropertyDescriptor(data, 'state_revision');
  if (
    rowKeys.length !== 1 || rowKeys[0] !== 'state_revision' ||
    !rowDescriptor || rowDescriptor.enumerable !== true || !('value' in rowDescriptor)
  ) {
    return fail();
  }
  const revision = rowDescriptor.value;
  if (!Number.isSafeInteger(revision) || revision < 0) return fail();
  return revision;
}

/** Builds the per-conversation revision reader used by captureConversationRevisions,
 * querying memory_v3_dialogue_heads for (user_id, conversation_id) through the
 * injected revisionClient -- the same Supabase client that built sourceReader's
 * reader (see resolveRevisionClient above), not a second connection. */
function buildReadRevision(
  client: unknown,
  userId: string,
): (conversationId: string) => Promise<number> {
  return async (conversationId: string): Promise<number> => {
    const table = callMethod(client, 'from', MEMORY_V3_DIALOGUE_HEADS_TABLE);
    const selected = callMethod(table, 'select', 'state_revision');
    const filteredByUser = callMethod(selected, 'eq', 'user_id', userId);
    const filteredByConversation = callMethod(filteredByUser, 'eq', 'conversation_id', conversationId);
    const response = await callMethod(filteredByConversation, 'maybeSingle');
    return inspectRevisionResponse(response);
  };
}

/** Bridges the UNFORKED, lifecycle-shaped result of inspectLifecycleHistorySource
 * back into the raw per-conversation snapshot shape prepareDialogueHistoryBackfill
 * needs. inspectLifecycleHistorySource always finishes by calling the lifecycle
 * contract's own prepareLifecycleHistoryBackfill (per Global Constraints, that
 * file is reused completely unchanged -- not forked), so its return value is a
 * PreparedLifecycleHistoryBackfill, not a PreparedDialogueHistoryBackfill: wrong
 * manifest.schemaVersion and wrong per-conversation grouping for Task 4's engine.
 * Every message that reader read is still present, split into pure single-
 * conversation chunks (chunkOneConversation never mixes two conversations into
 * one chunk); concatenating each conversation's own chunks back together in
 * chunkOrdinal order losslessly recovers that conversation's full, correctly
 * ordered message list. The reconstructed conversation `createdAt` uses its
 * earliest message's own timestamp as a safe stand-in for the true
 * conversations.created_at row value (not preserved by either contract's
 * chunker output) -- prepareDialogueHistoryBackfill only requires
 * createdAt <= cutoff and every message.createdAt >= createdAt, both trivially
 * satisfied by this choice. This value IS folded into
 * manifest.sourceSnapshotDigest (digestCanonicalTrusted hashes the whole
 * canonicalized `conversations` array, createdAt included -- see
 * dialogue-history-backfill-contract.ts's projectManifest), so the dialogue
 * tool's source-freeze digest does not cover conversations.created_at the
 * way the lifecycle tool's own digest does (accepted, low-risk: a
 * conversation's own creation timestamp is set once and effectively never
 * changes after creation, unlike message content, which remains fully
 * covered). It is NOT echoed into any chunk digest, the extractor request,
 * or any other observable result field. */
export function reconstructDialogueConversations(
  preparedLifecycle: PreparedLifecycleHistoryBackfill,
): DialogueHistoryConversationInput[] {
  const chunksByOrdinal = new Map<number, LifecycleHistoryPreparedChunk[]>();
  for (const chunk of preparedLifecycle.chunks) {
    const bucket = chunksByOrdinal.get(chunk.conversationOrdinal);
    if (bucket) bucket.push(chunk);
    else chunksByOrdinal.set(chunk.conversationOrdinal, [chunk]);
  }
  const ordinals = [...chunksByOrdinal.keys()].sort((left, right) => left - right);
  return ordinals.map((ordinal) => {
    const chunksForConversation = [...chunksByOrdinal.get(ordinal)!].sort(
      (left, right) => left.chunkOrdinal - right.chunkOrdinal,
    );
    const messages = chunksForConversation.flatMap((chunk) =>
      chunk.messages.map((message) => ({ ...message }))
    );
    return {
      conversationId: chunksForConversation[0].conversationId,
      createdAt: messages[0].createdAt,
      messages,
    };
  });
}

export async function runDialogueHistoryBackfillFromArgv(input: {
  argv: unknown;
  sourceReader: unknown;
  readEnvText: (path: string) => Promise<string>;
  fetchImpl: typeof fetch;
  nowMs: number;
  revisionClient: unknown;
}): Promise<{
  benchmarkResult: DialogueHistoryBackfillResult;
  semanticReviewPacket: ReturnType<typeof buildDialogueHistoryReviewPacket> | null;
}> {
  return boundary(async () => {
    const root = inspectOptions(input);
    const parsed = parseArgv(root.argv);
    if (!Number.isSafeInteger(root.nowMs)) return fail();
    preflightSourceReader(root.sourceReader);
    preflightRevisionClient(root.revisionClient);
    if (typeof root.readEnvText !== 'function' || isProxy(root.readEnvText)) return fail();
    if (typeof root.fetchImpl !== 'function' || isProxy(root.fetchImpl)) return fail();

    const priceText = await readText(root.readEnvText, parsed.priceSnapshotFile);
    const priceSnapshot = parsePriceSnapshot(priceText, root.nowMs as number);
    const supabaseUrl = httpsUrl(await readText(root.readEnvText, 'SUPABASE_URL'));
    const serviceKey = nonEmpty(await readText(root.readEnvText, 'SUPABASE_SERVICE_ROLE_KEY'));
    const userId = await readText(root.readEnvText, 'STAYSEE_MEMORY_V3_BACKFILL_USER_ID');
    if (!UUID.test(userId)) return fail();
    const reader = resolveSourceReader(root.sourceReader, supabaseUrl, serviceKey);
    const revisionClient = resolveRevisionClient(root.revisionClient, supabaseUrl, serviceKey);

    const preparedLifecycle = await inspectLifecycleHistorySource({
      profileId: parsed.profileId,
      userId,
      sourceCutoff: parsed.sourceCutoff,
      reader,
    });
    let prepared;
    try {
      prepared = prepareDialogueHistoryBackfill({
        profileId: parsed.profileId,
        snapshot: {
          userId,
          sourceCutoff: parsed.sourceCutoff,
          conversations: reconstructDialogueConversations(preparedLifecycle),
        },
      });
    } catch {
      return fail();
    }

    // conversationRevisions must be built and passed on EVERY invocation,
    // including a dry run: runDialogueHistoryBackfill's own preflight check
    // requires a complete map before it does anything else, paid or not.
    const conversationIds = [...new Set(prepared.chunks.map((chunk) => chunk.conversationId))];
    const readRevision = buildReadRevision(revisionClient, userId);
    const conversationRevisions = await captureConversationRevisions(conversationIds, readRevision);

    const preflight = await runDialogueHistoryBackfill({
      profileId: parsed.profileId,
      prepared,
      priceSnapshot,
      maxBudgetUsd: parsed.maxBudgetUsd,
      nowMs: root.nowMs as number,
      execute: false,
      conversationRevisions,
    });
    if (parsed.mode === 'inspect') {
      return { benchmarkResult: preflight, semanticReviewPacket: null };
    }
    if (prepared.manifest.sourceSnapshotDigest !== parsed.expectedSourceSha256) return fail();
    const apiKey = nonEmpty(await readText(root.readEnvText, 'OPENROUTER_API_KEY'));

    let extractorAdapter;
    let reconcilerAdapter;
    try {
      ({ extractorAdapter, reconcilerAdapter } = createDialogueHistoryRoutedAdapters({
        apiKey,
        fetchImpl: root.fetchImpl as typeof fetch,
      }));
    } catch {
      return fail();
    }
    const benchmarkResult = await runDialogueHistoryBackfill({
      profileId: parsed.profileId,
      prepared,
      priceSnapshot,
      maxBudgetUsd: parsed.maxBudgetUsd,
      nowMs: root.nowMs as number,
      execute: true,
      conversationRevisions,
      extractorAdapter,
      reconcilerAdapter,
    });
    const hasFailure = benchmarkResult.conversations.some(
      (conversation) => conversation.failureCount !== 0 || conversation.finalState === null,
    );
    if (hasFailure) return fail();
    const semanticReviewPacket = buildDialogueHistoryReviewPacket(benchmarkResult);
    return { benchmarkResult, semanticReviewPacket };
  });
}
