import type { MemoryV3DialogueMessage } from "./messages.ts";

export const MEMORY_V3_EXTRACTOR_VERSION = "memory-v3-openrouter-gemini-3.7-flash-shadow-v2";
export const MEMORY_V3_MODEL = "google/gemini-3.7-flash";
export const MEMORY_V3_MAX_PROMPT_BYTES = 20_000;
export const MEMORY_V3_MAX_OUTPUT_TOKENS = 1_200;
export const MEMORY_V3_RESERVED_INPUT_TOKENS = 32_768;
export const MEMORY_V3_MAX_SOURCE_MESSAGES = 60;
export const MEMORY_V3_MAX_DAILY_RESERVATIONS = 4;
export const MEMORY_V3_INPUT_NANODOLLARS_PER_TOKEN = 750;
export const MEMORY_V3_OUTPUT_NANODOLLARS_PER_TOKEN = 3_750;
export const MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_RUN = 29_076_000;
export const MEMORY_V3_CONFIGURED_CEILING_NANODOLLARS_PER_DAY = 116_304_000;

export interface MemoryV3DialogueInput {
  caseId: string;
  messages: MemoryV3DialogueMessage[];
}

type MemoryKind = "event" | "recurrence" | "hypothesis";
type EvidenceRelation = "supports" | "contradicts" | "corrects" | "rejects";
type SupportType = "episode_observation" | "pattern_confirmation" | "scope_boundary";

export interface MemoryV3Extraction {
  run: { caseId: string; extractorVersion: string };
  items: Array<{
    localItemKey: string;
    kind: MemoryKind;
    claim: string;
    scope: "cross_conversation";
    conversationId: null;
    eventTimeStart: string | null;
    eventTimeEnd: string | null;
    status: string;
    sensitivity: "normal" | "sensitive";
    alternative: string | null;
  }>;
  evidence: Array<{
    itemKey: string;
    sourceMessageId: string;
    relation: EvidenceRelation;
    supportType: SupportType | null;
    episodeKey: string | null;
    provenanceRole: "user";
    mentionTime: string;
  }>;
}

const OWN_ERRORS = new WeakSet<object>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CASE_ID = /^memory-v3-shadow:([0-9a-f-]{36}):([0-9a-f-]{36})$/;
const MESSAGE_FIELDS = ["id", "role", "text", "createdAt"] as const;
const RESPONSE_FIELDS = ["layerDecisions", "items", "evidence"] as const;
const ITEM_FIELDS = ["itemRef", "kind", "claim", "status", "sensitivity", "eventTimeStart", "eventTimeEnd", "alternative"] as const;
const EVIDENCE_FIELDS = ["itemRef", "sourceMessageId", "relation", "supportType", "episodeKey"] as const;
const DECISION_FIELDS = ["kind", "decision", "itemRefs"] as const;
const KINDS = ["event", "recurrence", "hypothesis"] as const;
const RELATIONS = new Set<EvidenceRelation>(["supports", "contradicts", "corrects", "rejects"]);
const SUPPORT_TYPES = new Set<SupportType>(["episode_observation", "pattern_confirmation", "scope_boundary"]);
const STATUS: Record<MemoryKind, ReadonlySet<string>> = {
  event: new Set(["active", "corrected", "rejected"]),
  recurrence: new Set(["candidate", "active", "stale", "rejected"]),
  hypothesis: new Set(["candidate", "supported", "stale", "rejected"]),
};
const REQUIRED: Record<MemoryKind, Record<string, EvidenceRelation>> = {
  event: { active: "supports", corrected: "corrects", rejected: "rejects" },
  recurrence: { candidate: "supports", active: "supports", stale: "contradicts", rejected: "rejects" },
  hypothesis: { candidate: "supports", supported: "supports", stale: "contradicts", rejected: "rejects" },
};

function fail(): Error {
  const error = new Error("[memory-v3:contract] invalid input");
  error.name = "MemoryV3ContractError";
  OWN_ERRORS.add(error);
  return error;
}

function safe<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) throw error;
    throw fail();
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function inspectRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  return safe(() => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length) throw fail();
    const allowed = new Set(fields);
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !allowed.has(key)) throw fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) throw fail();
      copy[key] = descriptor.value;
    }
    for (const field of fields) if (!Object.hasOwn(copy, field)) throw fail();
    return copy;
  });
}

function inspectDenseArray(value: unknown, maximum = Number.MAX_SAFE_INTEGER): unknown[] {
  return safe(() => {
    if (!Array.isArray(value)) throw fail();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) throw fail();
    const length = lengthDescriptor.value as number;
    if (length < 0 || length > maximum) throw fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) throw fail();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail();
      result.push(descriptor.value);
    }
    if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw fail();
    return result;
  });
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4], match[5], match[6] ?? "0"].map(Number);
  if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return false;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isValidDateOrDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) : isValidDateTime(value);
}

function validateCaseId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CASE_ID.exec(value);
  return !!match && UUID.test(match[1]) && UUID.test(match[2]);
}

export function validateMemoryV3Dialogue(input: unknown): MemoryV3DialogueInput {
  return safe(() => {
    const projected = inspectRecord(input, ["caseId", "messages"]);
    if (!validateCaseId(projected.caseId)) throw fail();
    const rawMessages = inspectDenseArray(projected.messages, MEMORY_V3_MAX_SOURCE_MESSAGES);
    if (rawMessages.length === 0) throw fail();
    const ids = new Set<string>();
    let userCount = 0;
    const messages = rawMessages.map((raw) => {
      const message = inspectRecord(raw, MESSAGE_FIELDS);
      if (typeof message.id !== "string" || !UUID.test(message.id) || ids.has(message.id)) throw fail();
      ids.add(message.id);
      if (message.role !== "user" && message.role !== "assistant") throw fail();
      if (typeof message.text !== "string" || message.text.trim().length === 0) throw fail();
      if (!isValidDateTime(message.createdAt)) throw fail();
      if (message.role === "user") userCount += 1;
      return { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt } as MemoryV3DialogueMessage;
    });
    if (userCount === 0) throw fail();
    return { caseId: projected.caseId, messages };
  });
}

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  throw fail();
}

async function localItemKey(item: Omit<MemoryV3Extraction["items"][number], "localItemKey">, index: number): Promise<string> {
  const structural = {
    index,
    kind: item.kind ?? null,
    scope: item.scope ?? null,
    conversationId: item.conversationId ?? null,
    claim: item.claim ?? null,
    status: item.status ?? null,
    sensitivity: item.sensitivity ?? null,
    eventTimeStart: item.eventTimeStart ?? null,
    eventTimeEnd: item.eventTimeEnd ?? null,
    alternative: item.alternative ?? null,
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalStringify(structural)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { throw fail(); }
}

function validateItemFields(raw: unknown): Record<string, unknown> {
  const item = inspectRecord(raw, ITEM_FIELDS);
  if (!isNonEmptyString(item.itemRef) || !KINDS.includes(item.kind as MemoryKind) || !isNonEmptyString(item.claim)) throw fail();
  const kind = item.kind as MemoryKind;
  if (!STATUS[kind].has(item.status as string)) throw fail();
  if (item.sensitivity !== "normal" && item.sensitivity !== "sensitive") throw fail();
  if (item.eventTimeStart !== null && !isValidDateOrDateTime(item.eventTimeStart)) throw fail();
  if (item.eventTimeEnd !== null && !isValidDateOrDateTime(item.eventTimeEnd)) throw fail();
  if (item.eventTimeStart !== null && item.eventTimeEnd !== null && Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(item.eventTimeStart as string) ? `${item.eventTimeStart}T00:00:00Z` : item.eventTimeStart as string) > Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(item.eventTimeEnd as string) ? `${item.eventTimeEnd}T00:00:00Z` : item.eventTimeEnd as string)) throw fail();
  if (kind === "hypothesis" ? !isNonEmptyString(item.alternative) : item.alternative !== null) throw fail();
  return item;
}

export async function normalizeMemoryV3LayeredResponse(
  raw: unknown,
  input: unknown,
  extractorVersion: string,
): Promise<MemoryV3Extraction> {
  try {
    const validated = validateMemoryV3Dialogue(input);
    if (!isNonEmptyString(extractorVersion)) throw fail();
    const response = inspectRecord(parseRaw(raw), RESPONSE_FIELDS);
    const rawItems = inspectDenseArray(response.items);
    const refs = new Map<string, { key: string; kind: MemoryKind }>();
    const items: MemoryV3Extraction["items"] = [];
    for (let index = 0; index < rawItems.length; index += 1) {
      const source = validateItemFields(rawItems[index]);
      const ref = source.itemRef as string;
      if (refs.has(ref)) throw fail();
      const normalized = {
        kind: source.kind as MemoryKind,
        claim: source.claim as string,
        scope: "cross_conversation" as const,
        conversationId: null,
        eventTimeStart: source.eventTimeStart as string | null,
        eventTimeEnd: source.eventTimeEnd as string | null,
        status: source.status as string,
        sensitivity: source.sensitivity as "normal" | "sensitive",
        alternative: source.alternative as string | null,
      };
      const key = await localItemKey(normalized, index);
      refs.set(ref, { key, kind: normalized.kind });
      items.push({ ...normalized, localItemKey: key });
    }

    const rawDecisions = inspectDenseArray(response.layerDecisions);
    if (rawDecisions.length !== 3) throw fail();
    const decidedRefs = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const decision = inspectRecord(rawDecisions[index], DECISION_FIELDS);
      if (decision.kind !== KINDS[index] || (decision.decision !== "emit" && decision.decision !== "omit")) throw fail();
      const itemRefs = inspectDenseArray(decision.itemRefs);
      if ((decision.decision === "emit") !== (itemRefs.length > 0)) throw fail();
      for (const ref of itemRefs) {
        if (!isNonEmptyString(ref) || decidedRefs.has(ref) || !refs.has(ref) || refs.get(ref)!.kind !== decision.kind) throw fail();
        decidedRefs.add(ref);
      }
    }
    if (decidedRefs.size !== refs.size) throw fail();

    const messages = new Map(validated.messages.map((message) => [message.id, message]));
    const evidence: MemoryV3Extraction["evidence"] = [];
    const seenEvidence = new Set<string>();
    for (const rawRow of inspectDenseArray(response.evidence)) {
      const row = inspectRecord(rawRow, EVIDENCE_FIELDS);
      if (!isNonEmptyString(row.itemRef) || !refs.has(row.itemRef) || !isNonEmptyString(row.sourceMessageId) || !RELATIONS.has(row.relation as EvidenceRelation)) throw fail();
      const message = messages.get(row.sourceMessageId);
      if (!message || message.role !== "user") throw fail();
      const target = refs.get(row.itemRef)!;
      const relation = row.relation as EvidenceRelation;
      const typed = target.kind === "recurrence" && relation === "supports";
      if (typed) {
        if (!SUPPORT_TYPES.has(row.supportType as SupportType)) throw fail();
        if (row.supportType === "episode_observation" ? !isNonEmptyString(row.episodeKey) : row.episodeKey !== null) throw fail();
      } else if (row.supportType !== null || !isNonEmptyString(row.episodeKey)) throw fail();
      const identity = `${target.key}\0${message.id}\0${relation}`;
      if (seenEvidence.has(identity)) throw fail();
      seenEvidence.add(identity);
      evidence.push({
        itemKey: target.key,
        sourceMessageId: message.id,
        relation,
        supportType: row.supportType as SupportType | null,
        episodeKey: row.episodeKey as string | null,
        provenanceRole: "user",
        mentionTime: message.createdAt,
      });
    }

    for (const item of items) {
      const related = evidence.filter((row) => row.itemKey === item.localItemKey);
      if (!related.some((row) => row.relation === REQUIRED[item.kind][item.status])) throw fail();
      if (item.kind === "recurrence" && (item.status === "candidate" || item.status === "active")) {
        const observations = new Set(related.filter((row) => row.relation === "supports" && row.supportType === "episode_observation").map((row) => row.episodeKey));
        if (observations.size < 2) throw fail();
      }
    }
    return { run: { caseId: validated.caseId, extractorVersion }, items, evidence };
  } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) throw error;
    throw fail();
  }
}
