import type { MemoryV3Extraction } from "./contract.ts";
import type { MemoryV3TransportResult } from "./transport.ts";

export type MemoryV3StoredDiagnostic =
  | "invalid_source"
  | "prompt_too_large"
  | "reservation_failed"
  | "transport_failed"
  | "transport_timeout"
  | "provider_http_4xx"
  | "provider_http_5xx"
  | "provider_response_invalid"
  | "extractor_parse_invalid"
  | "extractor_shape_invalid"
  | "extractor_contract_invalid"
  | "completion_write_failed"
  | "unknown_failure";

export interface MemoryV3ReservationInput {
  userId: string;
  conversationId: string;
  extractorVersion: string;
  model: string;
  inputHash: string;
  sourceLastMessageId: string;
  sourceLastCreatedAt: string;
  messageCount: number;
  userMessageCount: number;
}

export interface MemoryV3SuccessWrite {
  runId: string;
  userId: string;
  extraction: MemoryV3Extraction;
  itemCount: number;
  evidenceCount: number;
  usage: MemoryV3TransportResult["usage"];
}

export interface MemoryV3FailureWrite {
  runId: string;
  userId: string;
  diagnosticCode: MemoryV3StoredDiagnostic;
}

export type MemoryV3ReservationResult =
  | { status: "reserved"; runId: string }
  | { status: "duplicate" | "daily_cap" };

export interface MemoryV3ShadowStore {
  reserve(input: MemoryV3ReservationInput): Promise<MemoryV3ReservationResult>;
  succeed(input: MemoryV3SuccessWrite): Promise<void>;
  fail(input: MemoryV3FailureWrite): Promise<void>;
}

interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

interface InspectedRpcClient {
  target: object;
  rpc: RpcClient["rpc"];
}

const OWN_ERRORS = new WeakSet<object>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CASE_ID = /^memory-v3-shadow:([0-9a-f-]{36}):([0-9a-f-]{36})$/;
const STORED_DIAGNOSTICS = new Set<MemoryV3StoredDiagnostic>([
  "invalid_source",
  "prompt_too_large",
  "reservation_failed",
  "transport_failed",
  "transport_timeout",
  "provider_http_4xx",
  "provider_http_5xx",
  "provider_response_invalid",
  "extractor_parse_invalid",
  "extractor_shape_invalid",
  "extractor_contract_invalid",
  "completion_write_failed",
  "unknown_failure",
]);
const KINDS = new Set(["event", "recurrence", "hypothesis"]);
const RELATIONS = new Set(["supports", "contradicts", "corrects", "rejects"]);
const SUPPORT_TYPES = new Set(["episode_observation", "pattern_confirmation", "scope_boundary"]);
const STATUS: Record<string, ReadonlySet<string>> = {
  event: new Set(["active", "corrected", "rejected"]),
  recurrence: new Set(["candidate", "active", "stale", "rejected"]),
  hypothesis: new Set(["candidate", "supported", "stale", "rejected"]),
};
const REQUIRED: Record<string, Record<string, string>> = {
  event: { active: "supports", corrected: "corrects", rejected: "rejects" },
  recurrence: { candidate: "supports", active: "supports", stale: "contradicts", rejected: "rejects" },
  hypothesis: { candidate: "supports", supported: "supports", stale: "contradicts", rejected: "rejects" },
};

function fail(): Error {
  const error = new Error("[memory-v3:shadow-store] operation failed");
  error.name = "MemoryV3ShadowStoreError";
  OWN_ERRORS.add(error);
  return error;
}

function prototypeOf(value: object): object | null {
  try { return Object.getPrototypeOf(value); } catch { throw fail(); }
}

function ownKeys(value: object): PropertyKey[] {
  try { return Reflect.ownKeys(value); } catch { throw fail(); }
}

function descriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try { return Object.getOwnPropertyDescriptor(value, key); } catch { throw fail(); }
}

function isArray(value: unknown): value is unknown[] {
  try { return Array.isArray(value); } catch { throw fail(); }
}

function inspectRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isArray(value)) throw fail();
  const prototype = prototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();
  const keys = ownKeys(value);
  if (keys.length !== fields.length) throw fail();
  const allowed = new Set(fields);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) throw fail();
    const own = descriptor(value, key);
    if (!own || !own.enumerable || !("value" in own) || own.value === undefined) throw fail();
    copy[key] = own.value;
  }
  for (const field of fields) if (!Object.hasOwn(copy, field)) throw fail();
  return copy;
}

function inspectProjectedRecord(
  value: unknown,
  requiredFields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isArray(value)) throw fail();
  const prototype = prototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();
  const required = new Set(requiredFields);
  const copy: Record<string, unknown> = {};
  for (const key of ownKeys(value)) {
    if (typeof key !== "string") throw fail();
    const own = descriptor(value, key);
    if (!own || !own.enumerable || !("value" in own)) throw fail();
    if (required.has(key)) copy[key] = own.value;
  }
  for (const field of requiredFields) if (!Object.hasOwn(copy, field)) throw fail();
  return copy;
}

function inspectArray(value: unknown): unknown[] {
  if (!isArray(value)) throw fail();
  const length = descriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) throw fail();
  const keys = ownKeys(value);
  if (keys.length !== length.value + 1) throw fail();
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const own = descriptor(value, String(index));
    if (!own || !own.enumerable || !("value" in own) || own.value === undefined) throw fail();
    result.push(own.value);
  }
  return result;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4], match[5], match[6] ?? "0"].map(Number);
  if (!isCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return false;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isDateOrDateTime(value: unknown): value is string {
  if (isIsoDateTime(value)) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isCalendarDate(year, month, day);
}

function epoch(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

function projectExtraction(value: unknown, userId: string): MemoryV3Extraction {
  const source = inspectRecord(value, ["run", "items", "evidence"]);
  const run = inspectRecord(source.run, ["caseId", "extractorVersion"]);
  if (!isNonEmptyString(run.caseId) || !isNonEmptyString(run.extractorVersion)) throw fail();
  const caseMatch = CASE_ID.exec(run.caseId);
  if (!caseMatch || !UUID.test(caseMatch[1]) || !UUID.test(caseMatch[2]) || caseMatch[1] !== userId) throw fail();

  const itemKeys = new Set<string>();
  const items = inspectArray(source.items).map((raw) => {
    const item = inspectRecord(raw, [
      "localItemKey", "kind", "claim", "scope", "conversationId", "eventTimeStart",
      "eventTimeEnd", "status", "sensitivity", "alternative",
    ]);
    if (typeof item.localItemKey !== "string" || !SHA256.test(item.localItemKey) || itemKeys.has(item.localItemKey)) throw fail();
    if (typeof item.kind !== "string" || !KINDS.has(item.kind) || !isNonEmptyString(item.claim)) throw fail();
    if (item.scope !== "cross_conversation" || item.conversationId !== null) throw fail();
    if (item.eventTimeStart !== null && !isDateOrDateTime(item.eventTimeStart)) throw fail();
    if (item.eventTimeEnd !== null && !isDateOrDateTime(item.eventTimeEnd)) throw fail();
    if (item.eventTimeStart !== null && item.eventTimeEnd !== null && epoch(item.eventTimeStart as string) > epoch(item.eventTimeEnd as string)) throw fail();
    if (typeof item.status !== "string" || !STATUS[item.kind].has(item.status)) throw fail();
    if (item.sensitivity !== "normal" && item.sensitivity !== "sensitive") throw fail();
    if (item.kind === "hypothesis" ? !isNonEmptyString(item.alternative) : item.alternative !== null) throw fail();
    itemKeys.add(item.localItemKey);
    return {
      localItemKey: item.localItemKey,
      kind: item.kind,
      claim: item.claim,
      scope: "cross_conversation" as const,
      conversationId: null,
      eventTimeStart: item.eventTimeStart as string | null,
      eventTimeEnd: item.eventTimeEnd as string | null,
      status: item.status,
      sensitivity: item.sensitivity,
      alternative: item.alternative as string | null,
    } as MemoryV3Extraction["items"][number];
  });

  const seenEvidence = new Set<string>();
  const evidence = inspectArray(source.evidence).map((raw) => {
    const row = inspectRecord(raw, [
      "itemKey", "sourceMessageId", "relation", "supportType", "episodeKey",
      "provenanceRole", "mentionTime",
    ]);
    if (typeof row.itemKey !== "string" || !itemKeys.has(row.itemKey)) throw fail();
    if (typeof row.sourceMessageId !== "string" || !UUID.test(row.sourceMessageId)) throw fail();
    if (typeof row.relation !== "string" || !RELATIONS.has(row.relation)) throw fail();
    if (row.provenanceRole !== "user" || !isIsoDateTime(row.mentionTime)) throw fail();
    const target = items.find((item) => item.localItemKey === row.itemKey)!;
    const typed = target.kind === "recurrence" && row.relation === "supports";
    if (typed) {
      if (typeof row.supportType !== "string" || !SUPPORT_TYPES.has(row.supportType)) throw fail();
      if (row.supportType === "episode_observation" ? !isNonEmptyString(row.episodeKey) : row.episodeKey !== null) throw fail();
    } else if (row.supportType !== null || !isNonEmptyString(row.episodeKey)) throw fail();
    const identity = `${row.itemKey}\0${row.sourceMessageId}\0${row.relation}`;
    if (seenEvidence.has(identity)) throw fail();
    seenEvidence.add(identity);
    return {
      itemKey: row.itemKey,
      sourceMessageId: row.sourceMessageId,
      relation: row.relation,
      supportType: row.supportType,
      episodeKey: row.episodeKey,
      provenanceRole: "user" as const,
      mentionTime: row.mentionTime,
    } as MemoryV3Extraction["evidence"][number];
  });

  for (const item of items) {
    const related = evidence.filter((row) => row.itemKey === item.localItemKey);
    if (!related.some((row) => row.relation === REQUIRED[item.kind][item.status])) throw fail();
    if (item.kind === "recurrence" && (item.status === "candidate" || item.status === "active")) {
      const episodes = new Set(related.filter((row) => row.relation === "supports" && row.supportType === "episode_observation").map((row) => row.episodeKey));
      if (episodes.size < 2) throw fail();
    }
  }

  return {
    run: { caseId: run.caseId, extractorVersion: run.extractorVersion },
    items,
    evidence,
  };
}

function projectUsage(value: unknown): MemoryV3TransportResult["usage"] {
  if (value === null) return null;
  const usage = inspectRecord(value, ["promptTokens", "completionTokens", "costUsd"]);
  if (!Number.isSafeInteger(usage.promptTokens) || (usage.promptTokens as number) < 0) throw fail();
  if (!Number.isSafeInteger(usage.completionTokens) || (usage.completionTokens as number) < 0) throw fail();
  if (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) throw fail();
  return {
    promptTokens: usage.promptTokens as number,
    completionTokens: usage.completionTokens as number,
    costUsd: usage.costUsd,
  };
}

function inspectClient(value: unknown): InspectedRpcClient {
  if (typeof value !== "object" || value === null || isArray(value)) throw fail();
  const seen = new WeakSet<object>();
  let current: object | null = value;
  while (current !== null) {
    if (seen.has(current)) throw fail();
    seen.add(current);
    const own = descriptor(current, "rpc");
    if (own) {
      if (!("value" in own) || typeof own.value !== "function") throw fail();
      return { target: value, rpc: own.value as RpcClient["rpc"] };
    }
    current = prototypeOf(current);
  }
  throw fail();
}

async function callRpc(client: InspectedRpcClient, name: string, args: Record<string, unknown>) {
  let response: unknown;
  try { response = await client.rpc.call(client.target, name, args); } catch { throw fail(); }
  const projected = inspectProjectedRecord(response, ["data", "error"]);
  if (projected.error !== null) throw fail();
  return projected.data;
}

function completionArgs(input: {
  runId: string;
  userId: string;
  status: "succeeded" | "failed";
  diagnosticCode: MemoryV3StoredDiagnostic | null;
  itemCount: number | null;
  evidenceCount: number | null;
  extraction: MemoryV3Extraction | null;
  usage: MemoryV3TransportResult["usage"];
}) {
  return {
    p_run_id: input.runId,
    p_user_id: input.userId,
    p_status: input.status,
    p_diagnostic_code: input.diagnosticCode,
    p_item_count: input.itemCount,
    p_evidence_count: input.evidenceCount,
    p_extraction: input.extraction,
    p_prompt_tokens: input.usage?.promptTokens ?? null,
    p_completion_tokens: input.usage?.completionTokens ?? null,
    p_cost_usd: input.usage?.costUsd ?? null,
    p_completed_at: new Date().toISOString(),
  };
}

export function createMemoryV3ShadowStore(clientValue: {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}): MemoryV3ShadowStore {
  const client = inspectClient(clientValue);
  return {
    async reserve(inputValue) {
      const input = inspectRecord(inputValue, [
        "userId", "conversationId", "extractorVersion", "model", "inputHash",
        "sourceLastMessageId", "sourceLastCreatedAt", "messageCount", "userMessageCount",
      ]);
      if (typeof input.userId !== "string" || !UUID.test(input.userId)) throw fail();
      if (typeof input.conversationId !== "string" || !UUID.test(input.conversationId)) throw fail();
      if (!isNonEmptyString(input.extractorVersion) || !isNonEmptyString(input.model)) throw fail();
      if (typeof input.inputHash !== "string" || !SHA256.test(input.inputHash)) throw fail();
      if (typeof input.sourceLastMessageId !== "string" || !UUID.test(input.sourceLastMessageId)) throw fail();
      if (!isIsoDateTime(input.sourceLastCreatedAt)) throw fail();
      if (!Number.isSafeInteger(input.messageCount) || (input.messageCount as number) < 1 || (input.messageCount as number) > 60) throw fail();
      if (!Number.isSafeInteger(input.userMessageCount) || (input.userMessageCount as number) < 1 || (input.userMessageCount as number) > (input.messageCount as number)) throw fail();
      const data = await callRpc(client, "reserve_memory_v3_shadow_run", {
        p_user_id: input.userId,
        p_conversation_id: input.conversationId,
        p_extractor_version: input.extractorVersion,
        p_model: input.model,
        p_input_hash: input.inputHash,
        p_source_last_message_id: input.sourceLastMessageId,
        p_source_last_created_at: input.sourceLastCreatedAt,
        p_message_count: input.messageCount,
        p_user_message_count: input.userMessageCount,
      });
      const rows = inspectArray(data);
      if (rows.length !== 1) throw fail();
      const row = inspectRecord(rows[0], ["result", "run_id"]);
      if (row.result === "reserved") {
        if (typeof row.run_id !== "string" || !UUID.test(row.run_id)) throw fail();
        return { status: "reserved", runId: row.run_id };
      }
      if (row.result === "duplicate" || row.result === "daily_cap") {
        if (row.run_id !== null) throw fail();
        return { status: row.result };
      }
      throw fail();
    },

    async succeed(inputValue) {
      const input = inspectRecord(inputValue, ["runId", "userId", "extraction", "itemCount", "evidenceCount", "usage"]);
      if (typeof input.runId !== "string" || !UUID.test(input.runId) || typeof input.userId !== "string" || !UUID.test(input.userId)) throw fail();
      const extraction = projectExtraction(input.extraction, input.userId);
      if (!Number.isSafeInteger(input.itemCount) || input.itemCount !== extraction.items.length) throw fail();
      if (!Number.isSafeInteger(input.evidenceCount) || input.evidenceCount !== extraction.evidence.length) throw fail();
      const usage = projectUsage(input.usage);
      const data = await callRpc(client, "complete_memory_v3_shadow_run", completionArgs({
        runId: input.runId,
        userId: input.userId,
        status: "succeeded",
        diagnosticCode: null,
        itemCount: input.itemCount,
        evidenceCount: input.evidenceCount,
        extraction,
        usage,
      }));
      if (data !== null) throw fail();
    },

    async fail(inputValue) {
      const input = inspectRecord(inputValue, ["runId", "userId", "diagnosticCode"]);
      if (typeof input.runId !== "string" || !UUID.test(input.runId) || typeof input.userId !== "string" || !UUID.test(input.userId)) throw fail();
      if (typeof input.diagnosticCode !== "string" || !STORED_DIAGNOSTICS.has(input.diagnosticCode as MemoryV3StoredDiagnostic)) throw fail();
      const data = await callRpc(client, "complete_memory_v3_shadow_run", completionArgs({
        runId: input.runId,
        userId: input.userId,
        status: "failed",
        diagnosticCode: input.diagnosticCode as MemoryV3StoredDiagnostic,
        itemCount: null,
        evidenceCount: null,
        extraction: null,
        usage: null,
      }));
      if (data !== null) throw fail();
    },
  };
}
