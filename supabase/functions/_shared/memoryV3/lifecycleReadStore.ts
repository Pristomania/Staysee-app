export const MEMORY_V3_LIFECYCLE_READ_SCHEMA_VERSION =
  "memory-v3-lifecycle-read-context-v1" as const;
export const MEMORY_V3_LIFECYCLE_READ_MAX_ITEMS = 12;

export interface MemoryV3LifecycleReadContext {
  schemaVersion: typeof MEMORY_V3_LIFECYCLE_READ_SCHEMA_VERSION;
  stateRevision: number;
  items: Array<{
    kind: "event" | "recurrence" | "hypothesis";
    claim: string;
    status: "active" | "supported";
    sensitivity: "normal" | "sensitive";
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    alternative: string | null;
    updatedAt: string;
  }>;
}

export interface MemoryV3LifecycleReadRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface MemoryV3LifecycleReadStore {
  load(userId: string): Promise<MemoryV3LifecycleReadContext | null>;
}

interface InspectedClient {
  target: object;
  rpc: MemoryV3LifecycleReadRpcClient["rpc"];
}

const OWN_ERRORS = new WeakSet<object>();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_FIELDS = ["schemaVersion", "stateRevision", "items"] as const;
const ITEM_FIELDS = [
  "kind",
  "claim",
  "status",
  "sensitivity",
  "eventTimeStart",
  "eventTimeEnd",
  "alternative",
  "updatedAt",
] as const;

function fail(): Error {
  const error = new Error("[memory-v3:lifecycle-read-store] operation failed");
  error.name = "MemoryV3LifecycleReadStoreError";
  OWN_ERRORS.add(error);
  return error;
}

function safe<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) {
      throw error;
    }
    throw fail();
  }
}

function isArray(value: unknown): value is unknown[] {
  return safe(() => Array.isArray(value));
}

function prototypeOf(value: object): object | null {
  return safe(() => Object.getPrototypeOf(value));
}

function ownKeys(value: object): PropertyKey[] {
  return safe(() => Reflect.ownKeys(value));
}

function descriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  return safe(() => Object.getOwnPropertyDescriptor(value, key));
}

function inspectRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isArray(value)) throw fail();
  const prototype = prototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();

  const keys = ownKeys(value);
  if (keys.length !== fields.length) throw fail();
  const allowed = new Set(fields);
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) throw fail();
    const own = descriptor(value, key);
    if (!own || !own.enumerable || !("value" in own) || own.value === undefined) {
      throw fail();
    }
    projected[key] = own.value;
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(projected, field)) throw fail();
  }
  return projected;
}

function inspectProjectedRecord(
  value: unknown,
  requiredFields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isArray(value)) throw fail();
  const prototype = prototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();

  const required = new Set(requiredFields);
  const projected: Record<string, unknown> = {};
  for (const key of ownKeys(value)) {
    if (typeof key !== "string") throw fail();
    const own = descriptor(value, key);
    if (!own || !own.enumerable || !("value" in own)) throw fail();
    if (required.has(key)) projected[key] = own.value;
  }
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(projected, field)) throw fail();
  }
  return projected;
}

function inspectArray(value: unknown, max: number): unknown[] {
  if (!isArray(value)) throw fail();
  const length = descriptor(value, "length");
  if (
    !length || !("value" in length) || !Number.isSafeInteger(length.value) ||
    length.value < 0 || length.value > max
  ) {
    throw fail();
  }
  const keys = ownKeys(value);
  if (keys.length !== length.value + 1) throw fail();

  const projected: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const own = descriptor(value, String(index));
    if (!own || !own.enumerable || !("value" in own) || own.value === undefined) {
      throw fail();
    }
    projected.push(own.value);
  }
  return projected;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  if (!isCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (
      offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

function isDateOrDateTime(value: unknown): value is string {
  if (isIsoDateTime(value)) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return Boolean(
    match &&
      isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])),
  );
}

function epoch(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

export function projectMemoryV3LifecycleReadContext(
  value: unknown,
): MemoryV3LifecycleReadContext {
  const root = inspectRecord(value, ROOT_FIELDS);
  if (root.schemaVersion !== MEMORY_V3_LIFECYCLE_READ_SCHEMA_VERSION) throw fail();
  if (
    !Number.isSafeInteger(root.stateRevision) ||
    (root.stateRevision as number) < 0
  ) {
    throw fail();
  }

  const items = inspectArray(root.items, MEMORY_V3_LIFECYCLE_READ_MAX_ITEMS).map(
    (raw) => {
      const item = inspectRecord(raw, ITEM_FIELDS);
      if (!isNonEmptyString(item.claim)) throw fail();
      if (item.sensitivity !== "normal" && item.sensitivity !== "sensitive") {
        throw fail();
      }
      if (item.eventTimeStart !== null && !isDateOrDateTime(item.eventTimeStart)) {
        throw fail();
      }
      if (item.eventTimeEnd !== null && !isDateOrDateTime(item.eventTimeEnd)) {
        throw fail();
      }
      if (
        item.eventTimeStart !== null && item.eventTimeEnd !== null &&
        epoch(item.eventTimeStart as string) > epoch(item.eventTimeEnd as string)
      ) {
        throw fail();
      }
      if (!isIsoDateTime(item.updatedAt)) throw fail();

      if (item.kind === "event" || item.kind === "recurrence") {
        if (item.status !== "active" || item.alternative !== null) throw fail();
      } else if (item.kind === "hypothesis") {
        if (item.status !== "supported" || !isNonEmptyString(item.alternative)) {
          throw fail();
        }
      } else {
        throw fail();
      }

      return {
        kind: item.kind,
        claim: item.claim,
        status: item.status,
        sensitivity: item.sensitivity,
        eventTimeStart: item.eventTimeStart as string | null,
        eventTimeEnd: item.eventTimeEnd as string | null,
        alternative: item.alternative as string | null,
        updatedAt: item.updatedAt,
      } as MemoryV3LifecycleReadContext["items"][number];
    },
  );

  return {
    schemaVersion: MEMORY_V3_LIFECYCLE_READ_SCHEMA_VERSION,
    stateRevision: root.stateRevision as number,
    items,
  };
}

function inspectClient(value: unknown): InspectedClient {
  if (typeof value !== "object" || value === null || isArray(value)) throw fail();
  const seen = new WeakSet<object>();
  let current: object | null = value;
  while (current !== null) {
    if (seen.has(current)) throw fail();
    seen.add(current);
    const own = descriptor(current, "rpc");
    if (own) {
      if (!("value" in own) || typeof own.value !== "function") throw fail();
      return {
        target: value,
        rpc: own.value as MemoryV3LifecycleReadRpcClient["rpc"],
      };
    }
    current = prototypeOf(current);
  }
  throw fail();
}

async function callRpc(client: InspectedClient, userId: string): Promise<unknown> {
  let response: unknown;
  try {
    response = await client.rpc.call(
      client.target,
      "load_memory_v3_lifecycle_read_context",
      { p_user_id: userId },
    );
  } catch {
    throw fail();
  }
  const projected = inspectProjectedRecord(response, ["data", "error"]);
  if (projected.error !== null) throw fail();
  return projected.data;
}

export function createMemoryV3LifecycleReadStore(
  clientValue: MemoryV3LifecycleReadRpcClient,
): MemoryV3LifecycleReadStore {
  const client = inspectClient(clientValue);
  return {
    async load(userId: string) {
      if (typeof userId !== "string" || !UUID.test(userId)) throw fail();
      const data = await callRpc(client, userId);
      return data === null ? null : projectMemoryV3LifecycleReadContext(data);
    },
  };
}
