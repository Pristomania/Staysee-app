export interface MemoryV3DialogueMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface MemoryV3MessageClient {
  from(table: string): unknown;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
const ROW_FIELDS = new Set(["id", "sender", "content", "created_at"]);
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

function inspectDenseArray(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value)) throw fail();
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) throw fail();
    const length = lengthDescriptor.value as number;
    if (length < 1 || length > 60 || keys.length !== length + 1) throw fail();
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

export function projectMemoryV3SourceRows(rows: unknown): MemoryV3DialogueMessage[] {
  const sourceRows = inspectDenseArray(rows);
  const ids = new Set<string>();
  let userCount = 0;
  const projected = sourceRows.map((source) => {
    const row = inspectRow(source);
    if (!isCanonicalUuid(row.id) || ids.has(row.id)) throw fail();
    ids.add(row.id);
    if (row.sender !== "user" && row.sender !== "ai") throw fail();
    if (typeof row.content !== "string" || row.content.trim().length === 0) throw fail();
    if (!isValidIsoDateTime(row.created_at)) throw fail();
    if (row.sender === "user") userCount += 1;
    return {
      id: row.id,
      role: row.sender === "user" ? "user" as const : "assistant" as const,
      text: row.content,
      createdAt: row.created_at,
    };
  });
  if (userCount === 0) throw fail();
  projected.sort((left, right) => {
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byTime !== 0 ? byTime : compareCodeUnits(left.id, right.id);
  });
  return projected;
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

export function createMemoryV3MessageLoader(
  client: MemoryV3MessageClient,
): (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]> {
  getMethod(client, "from");
  return async (userId: string, conversationId: string) => {
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(conversationId)) throw fail("invalid identifiers");
    try {
      let ownershipQuery = call(client, "from", "conversations");
      ownershipQuery = call(ownershipQuery, "select", "id");
      ownershipQuery = call(ownershipQuery, "eq", "id", conversationId);
      ownershipQuery = call(ownershipQuery, "eq", "user_id", userId);
      const ownership = inspectResponse(await call(ownershipQuery, "maybeSingle"));
      if (ownership.error !== null || ownership.data === null) throw fail("conversation is not owned");
      inspectOwnedConversation(ownership.data, conversationId);

      let messagesQuery = call(client, "from", "messages");
      messagesQuery = call(messagesQuery, "select", "id, sender, content, created_at");
      messagesQuery = call(messagesQuery, "eq", "conversation_id", conversationId);
      messagesQuery = call(messagesQuery, "order", "created_at", { ascending: true });
      messagesQuery = call(messagesQuery, "order", "id", { ascending: true });
      const response = inspectResponse(await call(messagesQuery, "limit", 60));
      if (response.error !== null) throw fail("message query failed");
      return projectMemoryV3SourceRows(response.data);
    } catch (error) {
      rethrowSafe(error, "message load failed");
    }
  };
}
