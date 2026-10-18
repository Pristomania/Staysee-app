import { estimateTokens } from "../tokenEstimate.ts";

export interface MemoryV3DialogueMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

/** A succeeded run's source position: the last message that run actually sent to its extractor. */
export interface MemoryV3SourceCursor {
  messageId: string;
  createdAt: string;
}

/** What a delta-mode load returns (spec 2026-10-13 §1). Both lists are chronological. */
export interface MemoryV3DeltaWindow {
  /** Up to 5 messages at or before the cursor -- continuity only, never new evidence. */
  context: MemoryV3DialogueMessage[];
  /** The oldest undrained messages after the cursor, trimmed from the newest end; empty when nothing is new. */
  delta: MemoryV3DialogueMessage[];
  /** The conversation's newest message id at load time; may lie beyond `delta`. */
  latestMessageId: string;
}

/** Without a cursor: exactly the pre-delta last-60 window. With one: a delta window. */
export interface MemoryV3MessageLoader {
  (userId: string, conversationId: string): Promise<MemoryV3DialogueMessage[]>;
  (userId: string, conversationId: string, sinceCursor: MemoryV3SourceCursor): Promise<MemoryV3DeltaWindow>;
}

export interface MemoryV3MessageClient {
  from(table: string): unknown;
}

/** Messages at or before the cursor re-sent for continuity (spec 2026-10-13 §1). */
export const MEMORY_V3_DELTA_CONTEXT_MESSAGES = 5;
/** Oldest undrained messages fetched per run: the 60-message source cap (MEMORY_V3_MAX_SOURCE_MESSAGES) minus the context block. */
export const MEMORY_V3_DELTA_MAX_MESSAGES = 55;
/** Estimated-token target (estimateTokens, chars/3.5) for context + delta together -- a target, not a ceiling. */
export const MEMORY_V3_DELTA_MAX_TOKENS = 4_000;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
const ROW_FIELDS = new Set(["id", "sender", "content", "created_at"]);
const CURSOR_FIELDS = new Set(["messageId", "createdAt"]);
const OWN_ERRORS = new WeakSet<object>();

function fail(message = "invalid source messages"): Error {
  const error = new Error(`[memory-v3:messages] ${message}`);
  error.name = "MemoryV3MessagesError";
  OWN_ERRORS.add(error);
  return error;
}

function rethrowSafe(error: unknown, message: string): never {
  if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) throw error;
  throw fail(message);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATETIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  return Number.isFinite(Date.parse(value));
}

function inspectDenseArray(value: unknown, minimum = 1, maximum = 60): unknown[] {
  try {
    if (!Array.isArray(value)) throw fail();
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) throw fail();
    const length = lengthDescriptor.value as number;
    if (length < minimum || length > maximum || keys.length !== length + 1) throw fail();
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail();
      copy.push(descriptor.value);
    }
    if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw fail();
    return copy;
  } catch (error) {
    rethrowSafe(error, "invalid source messages");
  }
}

function inspectRow(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== ROW_FIELDS.size) throw fail();
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !ROW_FIELDS.has(key)) throw fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail();
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (error) {
    rethrowSafe(error, "invalid source messages");
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectRow(source: unknown, ids: Set<string>): MemoryV3DialogueMessage {
  const row = inspectRow(source);
  if (!isCanonicalUuid(row.id) || ids.has(row.id)) throw fail();
  ids.add(row.id);
  if (row.sender !== "user" && row.sender !== "ai") throw fail();
  if (typeof row.content !== "string" || row.content.trim().length === 0) throw fail();
  if (!isValidIsoDateTime(row.created_at)) throw fail();
  return {
    id: row.id,
    role: row.sender === "user" ? "user" : "assistant",
    text: row.content,
    createdAt: row.created_at,
  };
}

export function projectMemoryV3SourceRows(rows: unknown): MemoryV3DialogueMessage[] {
  const sourceRows = inspectDenseArray(rows);
  const ids = new Set<string>();
  const projected = sourceRows.map((source) => projectRow(source, ids));
  if (!projected.some((message) => message.role === "user")) throw fail();
  projected.sort((left, right) => {
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byTime !== 0 ? byTime : compareCodeUnits(left.id, right.id);
  });
  return projected;
}

// Delta mode keeps the database's own (created_at, id) order exactly as
// returned and never re-sorts: Date.parse() resolves only milliseconds while
// created_at carries microseconds, so a client-side sort could swap two
// same-millisecond messages and put the next cursor on the wrong one. Only a
// gross misordering (a later millisecond before an earlier one) is
// detectable here, and it is rejected.
function projectInDatabaseOrder(rows: unknown[], ids: Set<string>): MemoryV3DialogueMessage[] {
  const messages = rows.map((row) => projectRow(row, ids));
  for (let index = 1; index < messages.length; index += 1) {
    if (Date.parse(messages[index - 1].createdAt) > Date.parse(messages[index].createdAt)) throw fail();
  }
  return messages;
}

function inspectCursor(value: unknown): MemoryV3SourceCursor {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("invalid cursor");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== CURSOR_FIELDS.size) throw fail("invalid cursor");
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !CURSOR_FIELDS.has(key)) throw fail("invalid cursor");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail("invalid cursor");
      copy[key] = descriptor.value;
    }
    const messageId = copy.messageId;
    const createdAt = copy.createdAt;
    if (!isCanonicalUuid(messageId) || !isValidIsoDateTime(createdAt)) throw fail("invalid cursor");
    return { messageId, createdAt };
  } catch (error) {
    rethrowSafe(error, "invalid cursor");
  }
}

function inspectLatestRow(value: unknown): string {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "id") throw fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !isCanonicalUuid(descriptor.value)) throw fail();
    return descriptor.value;
  } catch (error) {
    rethrowSafe(error, "invalid source messages");
  }
}

// Spec 2026-10-13 §1: the token budget is a target, not a ceiling. Keeps the
// longest OLDEST-first prefix of the chunk that fits alongside the context
// block. The trimmed newest messages are not lost -- they open the next run,
// because the cursor only advances to the last message a run actually sends.
// Never trims the context block, and never the oldest undrained message
// (without it the run would analyze nothing new), even when either alone is
// over the target.
function capDeltaToTokenTarget(
  context: MemoryV3DialogueMessage[],
  delta: MemoryV3DialogueMessage[],
): MemoryV3DialogueMessage[] {
  let total = context.reduce((sum, message) => sum + estimateTokens(message.text), 0);
  let end = 0;
  while (end < delta.length) {
    const next = total + estimateTokens(delta[end].text);
    if (end > 0 && next > MEMORY_V3_DELTA_MAX_TOKENS) break;
    total = next;
    end += 1;
  }
  return delta.slice(0, end);
}

function getMethod(target: unknown, name: string): (...args: unknown[]) => unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) throw fail("invalid database client");
  try {
    let cursor: object | null = target as object;
    const seen = new Set<object>();
    while (cursor !== null) {
      if (seen.has(cursor)) throw fail("invalid database client");
      seen.add(cursor);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") throw fail("invalid database client");
        return descriptor.value.bind(target);
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    throw fail("invalid database client");
  } catch (error) {
    rethrowSafe(error, "invalid database client");
  }
}

function call(target: unknown, name: string, ...args: unknown[]): unknown {
  return getMethod(target, name)(...args);
}

function inspectResponse(value: unknown): { data: unknown; error: unknown } {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("invalid database response");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw fail("invalid database response");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail("invalid database response");
    }
    const result: { data?: unknown; error?: unknown } = {};
    for (const name of ["data", "error"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw fail("invalid database response");
      result[name] = descriptor.value;
    }
    return { data: result.data, error: result.error };
  } catch (error) {
    rethrowSafe(error, "invalid database response");
  }
}

function inspectOwnedConversation(value: unknown, conversationId: string): void {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("conversation is not owned");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "id") throw fail("conversation is not owned");
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value !== conversationId) throw fail("conversation is not owned");
  } catch (error) {
    rethrowSafe(error, "conversation is not owned");
  }
}

function selectConversationMessages(client: MemoryV3MessageClient, conversationId: string): unknown {
  const query = call(call(client, "from", "messages"), "select", "id, sender, content, created_at");
  return call(query, "eq", "conversation_id", conversationId);
}

// PostgREST keyset filters: (created_at, id) compared lexicographically with
// the cursor -- never created_at alone, which would skip or repeat a message
// sharing the cursor's timestamp. Both values were validated by
// inspectCursor (canonical UUID; ISO timestamp, which cannot contain a quote,
// comma, or parenthesis). The timestamp is the exact string the store read
// back (microsecond precision) and is double-quoted because it contains ':'
// and '.'.
function afterCursor(cursor: MemoryV3SourceCursor): string {
  return `created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.gt.${cursor.messageId})`;
}

function atOrBeforeCursor(cursor: MemoryV3SourceCursor): string {
  return `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lte.${cursor.messageId})`;
}

// Delta mode (spec 2026-10-13 §1): the OLDEST undrained messages after the
// cursor -- a backlog bigger than one chunk drains across several runs,
// oldest-first, so nothing is ever skipped -- plus the few at/before it for
// continuity, plus the conversation's latest message id (the runner folds it
// into the run's input identity so a failed window can be retried once
// anything new is written).
async function loadDeltaWindow(
  client: MemoryV3MessageClient,
  conversationId: string,
  cursor: MemoryV3SourceCursor,
): Promise<MemoryV3DeltaWindow> {
  let deltaQuery = call(selectConversationMessages(client, conversationId), "or", afterCursor(cursor));
  deltaQuery = call(deltaQuery, "order", "created_at", { ascending: true });
  deltaQuery = call(deltaQuery, "order", "id", { ascending: true });
  const delta = inspectResponse(await call(deltaQuery, "limit", MEMORY_V3_DELTA_MAX_MESSAGES));
  if (delta.error !== null) throw fail("message query failed");

  // Newest-first so the limit keeps the 5 closest to the cursor; reversed
  // into chronological order below.
  let contextQuery = call(selectConversationMessages(client, conversationId), "or", atOrBeforeCursor(cursor));
  contextQuery = call(contextQuery, "order", "created_at", { ascending: false });
  contextQuery = call(contextQuery, "order", "id", { ascending: false });
  const context = inspectResponse(await call(contextQuery, "limit", MEMORY_V3_DELTA_CONTEXT_MESSAGES));
  if (context.error !== null) throw fail("message query failed");

  let latestQuery = call(call(client, "from", "messages"), "select", "id");
  latestQuery = call(latestQuery, "eq", "conversation_id", conversationId);
  latestQuery = call(latestQuery, "order", "created_at", { ascending: false });
  latestQuery = call(latestQuery, "order", "id", { ascending: false });
  const latest = inspectResponse(await call(latestQuery, "limit", 1));
  if (latest.error !== null) throw fail("message query failed");

  const ids = new Set<string>();
  const deltaMessages = projectInDatabaseOrder(inspectDenseArray(delta.data, 0, MEMORY_V3_DELTA_MAX_MESSAGES), ids);
  const contextMessages = projectInDatabaseOrder(
    inspectDenseArray(context.data, 0, MEMORY_V3_DELTA_CONTEXT_MESSAGES).reverse(),
    ids,
  );
  return {
    context: contextMessages,
    delta: capDeltaToTokenTarget(contextMessages, deltaMessages),
    latestMessageId: inspectLatestRow(inspectDenseArray(latest.data, 1, 1)[0]),
  };
}

export function createMemoryV3MessageLoader(client: MemoryV3MessageClient): MemoryV3MessageLoader {
  getMethod(client, "from");
  const load = async (
    userId: string,
    conversationId: string,
    sinceCursor?: MemoryV3SourceCursor,
  ): Promise<MemoryV3DialogueMessage[] | MemoryV3DeltaWindow> => {
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(conversationId)) throw fail("invalid identifiers");
    // The call shape alone picks the mode: an omitted cursor is today's
    // window; anything passed must be a valid cursor -- null included, which
    // is a caller bug, not "no cursor".
    const cursor = sinceCursor === undefined ? null : inspectCursor(sinceCursor);
    try {
      let ownershipQuery = call(client, "from", "conversations");
      ownershipQuery = call(ownershipQuery, "select", "id");
      ownershipQuery = call(ownershipQuery, "eq", "id", conversationId);
      ownershipQuery = call(ownershipQuery, "eq", "user_id", userId);
      const ownership = inspectResponse(await call(ownershipQuery, "maybeSingle"));
      if (ownership.error !== null || ownership.data === null) throw fail("conversation is not owned");
      inspectOwnedConversation(ownership.data, conversationId);

      if (cursor !== null) return await loadDeltaWindow(client, conversationId, cursor);

      // No succeeded run yet: exactly the pre-delta last-60 window, and
      // deliberately not token-capped (spec 2026-10-13 Review Focus).
      let messagesQuery = call(selectConversationMessages(client, conversationId), "order", "created_at", { ascending: false });
      messagesQuery = call(messagesQuery, "order", "id", { ascending: false });
      const response = inspectResponse(await call(messagesQuery, "limit", 60));
      if (response.error !== null) throw fail("message query failed");
      return projectMemoryV3SourceRows(response.data);
    } catch (error) {
      rethrowSafe(error, "message load failed");
    }
  };
  return load as MemoryV3MessageLoader;
}
