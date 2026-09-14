import type { MemoryV3Extraction } from "./contract.ts";

export const MEMORY_V3_LIFECYCLE_SCHEMA_VERSION = "memory-v3-lifecycle-state-v1";
export const MEMORY_V3_LIFECYCLE_PIPELINE_VERSION = "memory-v3-lifecycle-shadow-v1";
export const MEMORY_V3_LIFECYCLE_RECONCILER_VERSION = "memory-v3-lifecycle-reconciler-v1";
export const MEMORY_V3_LIFECYCLE_MODEL = "google/gemini-3.7-flash";
export const MEMORY_V3_LIFECYCLE_MAX_SOURCE_MESSAGES = 60;
export const MEMORY_V3_LIFECYCLE_MAX_CANDIDATES = 100;
export const MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE = 500;
export const MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS = 100;
export const MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE = 500;
export const MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES = 20_000;
export const MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES = 80_000;
export const MEMORY_V3_LIFECYCLE_RESERVED_INPUT_TOKENS_PER_CALL = 32_768;
export const MEMORY_V3_LIFECYCLE_MAX_OUTPUT_TOKENS_PER_CALL = 1_200;
export const MEMORY_V3_LIFECYCLE_MAX_MODEL_CALLS_PER_RUN = 2;
export const MEMORY_V3_LIFECYCLE_MAX_DAILY_RESERVATIONS = 1;
export const MEMORY_V3_LIFECYCLE_CONFIGURED_CEILING_NANODOLLARS_PER_RUN = 58_152_000;
export const MEMORY_V3_LIFECYCLE_HARD_GATE_NANODOLLARS_PER_RUN = 65_000_000;

export type MemoryV3LifecycleOperationType =
  | "create"
  | "confirm"
  | "revise"
  | "mark_stale"
  | "reject"
  | "ignore";

type MemoryKind = "event" | "recurrence" | "hypothesis";
type EvidenceRelation = "supports" | "contradicts" | "corrects" | "rejects";
type SupportType = "episode_observation" | "pattern_confirmation" | "scope_boundary";

export interface MemoryV3LifecycleEvidence {
  conversationId: string;
  sourceMessageId: string;
  relation: EvidenceRelation;
  supportType: SupportType | null;
  episodeKey: string | null;
  provenanceRole: "user";
  mentionTime: string;
}

export interface MemoryV3LifecycleItem {
  memoryKey: string;
  kind: MemoryKind;
  claim: string;
  status: string;
  sensitivity: "normal" | "sensitive";
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  alternative: string | null;
  firstSeenAt: string;
  updatedAt: string;
  revision: number;
  evidence: MemoryV3LifecycleEvidence[];
}

export interface MemoryV3LifecycleState {
  schemaVersion: "memory-v3-lifecycle-state-v1";
  userId: string;
  stateRevision: number;
  nextMemoryOrdinal: number;
  items: MemoryV3LifecycleItem[];
}

export interface MemoryV3LifecycleReferenceBindings {
  memories: Array<{ memoryRef: string; memoryKey: string }>;
  candidates: Array<{ candidateRef: string; localItemKey: string }>;
}

export type MemoryV3LifecycleProposal = Array<{
  type: MemoryV3LifecycleOperationType;
  candidateLocalItemKey: string;
  targetMemoryKey: string | null;
}>;

type Diagnostic =
  | "lifecycle_contract_invalid_shape"
  | "lifecycle_contract_invalid_state"
  | "lifecycle_contract_invalid_proposal"
  | "lifecycle_contract_invalid_forget";

const OWN_ERRORS = new WeakSet<object>();
const ERROR_TOKENS = new WeakMap<object, object>();
const DIAGNOSTICS = new Set<Diagnostic>([
  "lifecycle_contract_invalid_shape",
  "lifecycle_contract_invalid_state",
  "lifecycle_contract_invalid_proposal",
  "lifecycle_contract_invalid_forget",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEMORY_KEY = /^[0-9a-f]{64}$/;
const KINDS = ["event", "recurrence", "hypothesis"] as const;
const RELATIONS = ["supports", "contradicts", "corrects", "rejects"] as const;
const SUPPORT_TYPES = ["episode_observation", "pattern_confirmation", "scope_boundary"] as const;
const OPERATION_TYPES = ["create", "confirm", "revise", "mark_stale", "reject", "ignore"] as const;
const CURRENT: Record<MemoryKind, readonly string[]> = {
  event: ["active"],
  recurrence: ["candidate", "active"],
  hypothesis: ["candidate", "supported"],
};
const CLOSED: Record<MemoryKind, readonly string[]> = {
  event: ["corrected", "rejected"],
  recurrence: ["stale", "rejected"],
  hypothesis: ["stale", "rejected"],
};
const STATUS_RELATION: Record<string, EvidenceRelation> = {
  active: "supports",
  candidate: "supports",
  supported: "supports",
  corrected: "corrects",
  stale: "contradicts",
  rejected: "rejects",
};

const STATE_FIELDS = ["schemaVersion", "userId", "stateRevision", "nextMemoryOrdinal", "items"] as const;
const ITEM_FIELDS = [
  "memoryKey", "kind", "claim", "status", "sensitivity", "eventTimeStart",
  "eventTimeEnd", "alternative", "firstSeenAt", "updatedAt", "revision", "evidence",
] as const;
const EVIDENCE_FIELDS = [
  "conversationId", "sourceMessageId", "relation", "supportType", "episodeKey",
  "provenanceRole", "mentionTime",
] as const;
const EXTRACTION_FIELDS = ["run", "items", "evidence"] as const;
const RUN_FIELDS = ["caseId", "extractorVersion"] as const;
const EXTRACTION_ITEM_FIELDS = [
  "localItemKey", "kind", "claim", "scope", "conversationId", "eventTimeStart",
  "eventTimeEnd", "status", "sensitivity", "alternative",
] as const;
const EXTRACTION_EVIDENCE_FIELDS = [
  "itemKey", "sourceMessageId", "relation", "supportType", "episodeKey",
  "provenanceRole", "mentionTime",
] as const;
const BINDINGS_FIELDS = ["memories", "candidates"] as const;
const MEMORY_BINDING_FIELDS = ["memoryRef", "memoryKey"] as const;
const CANDIDATE_BINDING_FIELDS = ["candidateRef", "localItemKey"] as const;
const CONTEXT_FIELDS = ["state", "extraction", "bindings"] as const;
const PROPOSAL_ROOT_FIELDS = ["operations"] as const;
const MODEL_OPERATION_FIELDS = ["type", "candidateRef", "targetMemoryRef"] as const;

function makeError(token: object, diagnosticCode: Diagnostic): Error {
  const error = new Error("[memory-v3:lifecycle-contract] value is invalid");
  error.name = "MemoryV3LifecycleContractError";
  Object.defineProperty(error, "diagnosticCode", {
    value: diagnosticCode,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  OWN_ERRORS.add(error);
  ERROR_TOKENS.set(error, token);
  return error;
}

function fail(token: object, diagnosticCode: Diagnostic): never {
  throw makeError(token, diagnosticCode);
}

function boundary<T>(fallback: Diagnostic, fn: (token: object) => T): T {
  const token = Object.freeze({});
  try {
    return fn(token);
  } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error) && ERROR_TOKENS.get(error) === token) {
      throw error;
    }
    throw makeError(token, fallback);
  }
}

function record(
  token: object,
  value: unknown,
  fields: readonly string[],
  diagnostic: Diagnostic,
): Record<string, unknown> {
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    if (typeof value !== "object" || value === null) fail(token, diagnostic);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) throw error;
    fail(token, diagnostic);
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) fail(token, diagnostic);
  if (keys.length !== fields.length) fail(token, diagnostic);
  const allowed = new Set(fields);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) fail(token, diagnostic);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token, diagnostic);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      fail(token, diagnostic);
    }
    output[key] = descriptor.value;
  }
  for (const field of fields) if (!Object.hasOwn(output, field)) fail(token, diagnostic);
  return output;
}

function denseArray(
  token: object,
  value: unknown,
  maximum: number,
  diagnostic: Diagnostic,
  limitDiagnostic: Diagnostic = diagnostic,
): unknown[] {
  let isArray: boolean;
  let keys: PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = typeof value === "object" && value !== null
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
  } catch {
    fail(token, diagnostic);
  }
  if (!isArray || !lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) fail(token, diagnostic);
  if (lengthDescriptor.value > maximum) fail(token, limitDiagnostic);
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) fail(token, diagnostic);
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(token, diagnostic);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      fail(token, diagnostic);
    }
    output.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      fail(token, diagnostic);
    }
  }
  return output;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59) return false;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function validDateOrDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return validDateTime(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function instant(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

function validateEvidence(
  token: object,
  value: unknown,
  kind: MemoryKind,
  diagnostic: Diagnostic,
): MemoryV3LifecycleEvidence {
  const row = record(token, value, EVIDENCE_FIELDS, diagnostic);
  if (!nonEmpty(row.conversationId) || !nonEmpty(row.sourceMessageId) ||
      !RELATIONS.includes(row.relation as EvidenceRelation) || row.provenanceRole !== "user" ||
      !validDateTime(row.mentionTime)) fail(token, diagnostic);
  const typed = kind === "recurrence" && row.relation === "supports";
  if (typed) {
    if (!SUPPORT_TYPES.includes(row.supportType as SupportType)) fail(token, diagnostic);
    if (row.supportType === "episode_observation") {
      if (!nonEmpty(row.episodeKey)) fail(token, diagnostic);
    } else if (row.episodeKey !== null) fail(token, diagnostic);
  } else if (row.supportType !== null || !nonEmpty(row.episodeKey)) fail(token, diagnostic);
  return { ...row } as MemoryV3LifecycleEvidence;
}

function validateStateInternal(token: object, value: unknown, expectedUserId?: string): MemoryV3LifecycleState {
  const shape = "lifecycle_contract_invalid_shape";
  const code = "lifecycle_contract_invalid_state";
  const root = record(token, value, STATE_FIELDS, shape);
  if (root.schemaVersion !== MEMORY_V3_LIFECYCLE_SCHEMA_VERSION ||
      typeof root.userId !== "string" || !UUID.test(root.userId) ||
      (expectedUserId !== undefined &&
        (typeof expectedUserId !== "string" || !UUID.test(expectedUserId) || root.userId !== expectedUserId)) ||
      !Number.isSafeInteger(root.stateRevision) || (root.stateRevision as number) < 0 ||
      !Number.isSafeInteger(root.nextMemoryOrdinal) || (root.nextMemoryOrdinal as number) < 1) {
    fail(token, code);
  }
  const rawItems = denseArray(token, root.items, MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS, shape, code);
  let totalEvidence = 0;
  const keys = new Set<string>();
  const items = rawItems.map((raw): MemoryV3LifecycleItem => {
    const item = record(token, raw, ITEM_FIELDS, shape);
    if (typeof item.memoryKey !== "string" || !MEMORY_KEY.test(item.memoryKey) || keys.has(item.memoryKey) ||
        !KINDS.includes(item.kind as MemoryKind) || !nonEmpty(item.claim) ||
        ![...CURRENT[item.kind as MemoryKind], ...CLOSED[item.kind as MemoryKind]].includes(item.status as string) ||
        (item.sensitivity !== "normal" && item.sensitivity !== "sensitive")) fail(token, code);
    keys.add(item.memoryKey);
    if ((item.eventTimeStart !== null && !validDateOrDateTime(item.eventTimeStart)) ||
        (item.eventTimeEnd !== null && !validDateOrDateTime(item.eventTimeEnd)) ||
        (item.eventTimeStart !== null && item.eventTimeEnd !== null &&
          instant(item.eventTimeStart as string) > instant(item.eventTimeEnd as string))) fail(token, code);
    if (item.kind === "hypothesis" ? !nonEmpty(item.alternative) : item.alternative !== null) fail(token, code);
    if (!validDateTime(item.firstSeenAt) || !validDateTime(item.updatedAt) ||
        Date.parse(item.updatedAt) < Date.parse(item.firstSeenAt) ||
        !Number.isSafeInteger(item.revision) || (item.revision as number) < 1) fail(token, code);
    const evidence = denseArray(token, item.evidence, MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE, shape, code)
      .map((row) => validateEvidence(token, row, item.kind as MemoryKind, code));
    totalEvidence += evidence.length;
    if (totalEvidence > MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE || evidence.length === 0) fail(token, code);
    const seen = new Set<string>();
    for (const row of evidence) {
      const identity = `${row.conversationId}\0${row.sourceMessageId}\0${row.relation}`;
      if (seen.has(identity)) fail(token, code);
      seen.add(identity);
    }
    if (!evidence.some((row) => row.relation === STATUS_RELATION[item.status as string])) fail(token, code);
    if (item.kind === "recurrence" && (item.status === "candidate" || item.status === "active")) {
      const observations = new Set(evidence
        .filter((row) => row.relation === "supports" && row.supportType === "episode_observation")
        .map((row) => row.episodeKey));
      if (observations.size < (item.status === "active" ? 2 : 1)) fail(token, code);
    }
    return { ...item, evidence } as MemoryV3LifecycleItem;
  });
  return {
    schemaVersion: MEMORY_V3_LIFECYCLE_SCHEMA_VERSION,
    userId: root.userId as string,
    stateRevision: root.stateRevision as number,
    nextMemoryOrdinal: root.nextMemoryOrdinal as number,
    items,
  };
}

function validateExtraction(token: object, value: unknown): MemoryV3Extraction {
  const code = "lifecycle_contract_invalid_proposal";
  const root = record(token, value, EXTRACTION_FIELDS, code);
  const run = record(token, root.run, RUN_FIELDS, code);
  if (!nonEmpty(run.caseId) || !nonEmpty(run.extractorVersion)) fail(token, code);
  const items = denseArray(token, root.items, MEMORY_V3_LIFECYCLE_MAX_CANDIDATES, code).map((raw) => {
    const item = record(token, raw, EXTRACTION_ITEM_FIELDS, code);
    if (!nonEmpty(item.localItemKey) || !KINDS.includes(item.kind as MemoryKind) || !nonEmpty(item.claim) ||
        item.scope !== "cross_conversation" || item.conversationId !== null ||
        ![...CURRENT[item.kind as MemoryKind], ...CLOSED[item.kind as MemoryKind]].includes(item.status as string) ||
        (item.sensitivity !== "normal" && item.sensitivity !== "sensitive")) fail(token, code);
    if ((item.eventTimeStart !== null && !validDateOrDateTime(item.eventTimeStart)) ||
        (item.eventTimeEnd !== null && !validDateOrDateTime(item.eventTimeEnd)) ||
        (item.eventTimeStart !== null && item.eventTimeEnd !== null &&
          instant(item.eventTimeStart as string) > instant(item.eventTimeEnd as string))) fail(token, code);
    if (item.kind === "hypothesis" ? !nonEmpty(item.alternative) : item.alternative !== null) fail(token, code);
    return { ...item };
  }) as MemoryV3Extraction["items"];
  const itemByKey = new Map<string, MemoryV3Extraction["items"][number]>();
  for (const item of items) {
    if (itemByKey.has(item.localItemKey)) fail(token, code);
    itemByKey.set(item.localItemKey, item);
  }
  const evidence = denseArray(token, root.evidence, MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE, code)
    .map((raw) => {
      const row = record(token, raw, EXTRACTION_EVIDENCE_FIELDS, code);
      const item = itemByKey.get(row.itemKey as string);
      if (!item || !nonEmpty(row.sourceMessageId) || !RELATIONS.includes(row.relation as EvidenceRelation) ||
          row.provenanceRole !== "user" || !validDateTime(row.mentionTime)) fail(token, code);
      const typed = item.kind === "recurrence" && row.relation === "supports";
      if (typed) {
        if (!SUPPORT_TYPES.includes(row.supportType as SupportType)) fail(token, code);
        if (row.supportType === "episode_observation" ? !nonEmpty(row.episodeKey) : row.episodeKey !== null) {
          fail(token, code);
        }
      } else if (row.supportType !== null || !nonEmpty(row.episodeKey)) fail(token, code);
      return { ...row };
    }) as MemoryV3Extraction["evidence"];
  const seenEvidence = new Set<string>();
  for (const row of evidence) {
    const identity = `${row.itemKey}\0${row.sourceMessageId}\0${row.relation}`;
    if (seenEvidence.has(identity)) fail(token, code);
    seenEvidence.add(identity);
  }
  for (const item of items) {
    const related = evidence.filter((row) => row.itemKey === item.localItemKey);
    if (!related.some((row) => row.relation === STATUS_RELATION[item.status])) fail(token, code);
  }
  return { run: { caseId: run.caseId as string, extractorVersion: run.extractorVersion as string }, items, evidence };
}

function validateBindings(
  token: object,
  value: unknown,
  state: MemoryV3LifecycleState,
  extraction: MemoryV3Extraction,
): MemoryV3LifecycleReferenceBindings {
  const code = "lifecycle_contract_invalid_proposal";
  const root = record(token, value, BINDINGS_FIELDS, code);
  const memories = denseArray(token, root.memories, MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS, code).map((raw) => {
    const row = record(token, raw, MEMORY_BINDING_FIELDS, code);
    if (!nonEmpty(row.memoryRef) || typeof row.memoryKey !== "string" || !MEMORY_KEY.test(row.memoryKey)) fail(token, code);
    return { memoryRef: row.memoryRef, memoryKey: row.memoryKey };
  });
  const candidates = denseArray(token, root.candidates, MEMORY_V3_LIFECYCLE_MAX_CANDIDATES, code).map((raw) => {
    const row = record(token, raw, CANDIDATE_BINDING_FIELDS, code);
    if (!nonEmpty(row.candidateRef) || !nonEmpty(row.localItemKey)) fail(token, code);
    return { candidateRef: row.candidateRef, localItemKey: row.localItemKey };
  });
  const stateKeys = new Set(state.items.map((item) => item.memoryKey));
  const candidateKeys = new Set(extraction.items.map((item) => item.localItemKey));
  if (memories.length !== stateKeys.size || candidates.length !== candidateKeys.size) fail(token, code);
  const memoryRefs = new Set<string>();
  const boundMemoryKeys = new Set<string>();
  for (const row of memories) {
    if (memoryRefs.has(row.memoryRef) || boundMemoryKeys.has(row.memoryKey) || !stateKeys.has(row.memoryKey)) fail(token, code);
    memoryRefs.add(row.memoryRef);
    boundMemoryKeys.add(row.memoryKey);
  }
  const candidateRefs = new Set<string>();
  const boundCandidateKeys = new Set<string>();
  for (const row of candidates) {
    if (candidateRefs.has(row.candidateRef) || boundCandidateKeys.has(row.localItemKey) || !candidateKeys.has(row.localItemKey)) {
      fail(token, code);
    }
    candidateRefs.add(row.candidateRef);
    boundCandidateKeys.add(row.localItemKey);
  }
  return { memories, candidates };
}

export function validateMemoryV3LifecycleState(value: unknown, expectedUserId: string): MemoryV3LifecycleState {
  return boundary("lifecycle_contract_invalid_shape", (token) => validateStateInternal(token, value, expectedUserId));
}

export function validateMemoryV3LifecycleProposal(
  value: unknown,
  context: {
    state: MemoryV3LifecycleState;
    extraction: MemoryV3Extraction;
    bindings: MemoryV3LifecycleReferenceBindings;
  },
): MemoryV3LifecycleProposal {
  return boundary("lifecycle_contract_invalid_shape", (token) => {
    const code = "lifecycle_contract_invalid_proposal";
    const root = record(token, value, PROPOSAL_ROOT_FIELDS, code);
    const operations = denseArray(token, root.operations, MEMORY_V3_LIFECYCLE_MAX_CANDIDATES, code)
      .map((raw) => record(token, raw, MODEL_OPERATION_FIELDS, code));
    const contextRecord = record(token, context, CONTEXT_FIELDS, code);
    const state = validateStateInternal(token, contextRecord.state);
    const extraction = validateExtraction(token, contextRecord.extraction);
    const bindings = validateBindings(token, contextRecord.bindings, state, extraction);
    const candidateByRef = new Map(bindings.candidates.map((row) => [row.candidateRef, row.localItemKey]));
    const memoryByRef = new Map(bindings.memories.map((row) => [row.memoryRef, row.memoryKey]));
    const candidateByKey = new Map(extraction.items.map((item) => [item.localItemKey, item]));
    const targetByKey = new Map(state.items.map((item) => [item.memoryKey, item]));
    const consumed = new Set<string>();
    const targeted = new Map<string, MemoryV3LifecycleOperationType>();
    const translated: MemoryV3LifecycleProposal = [];
    for (const operation of operations) {
      if (!OPERATION_TYPES.includes(operation.type as MemoryV3LifecycleOperationType) || !nonEmpty(operation.candidateRef)) {
        fail(token, code);
      }
      const localItemKey = candidateByRef.get(operation.candidateRef);
      if (!localItemKey || consumed.has(localItemKey)) fail(token, code);
      consumed.add(localItemKey);
      const candidate = candidateByKey.get(localItemKey)!;
      const type = operation.type as MemoryV3LifecycleOperationType;
      let targetMemoryKey: string | null = null;
      if (type === "create" || type === "ignore") {
        if (operation.targetMemoryRef !== null) fail(token, code);
        if (type === "create" && candidate.kind === "recurrence" && CURRENT.recurrence.includes(candidate.status)) {
          const observations = new Set(extraction.evidence
            .filter((row) => row.itemKey === localItemKey && row.relation === "supports" && row.supportType === "episode_observation")
            .map((row) => row.episodeKey));
          if (observations.size < (candidate.status === "active" ? 2 : 1)) fail(token, code);
        }
      } else {
        if (!nonEmpty(operation.targetMemoryRef)) fail(token, code);
        targetMemoryKey = memoryByRef.get(operation.targetMemoryRef) ?? null;
        if (targetMemoryKey === null) fail(token, code);
        const earlier = targeted.get(targetMemoryKey);
        if (earlier !== undefined && (earlier !== "confirm" || type !== "confirm")) fail(token, code);
        targeted.set(targetMemoryKey, type);
        const target = targetByKey.get(targetMemoryKey)!;
        if (!CURRENT[target.kind].includes(target.status) || candidate.kind !== target.kind) fail(token, code);
        if (type === "confirm" && !CURRENT[candidate.kind].includes(candidate.status)) fail(token, code);
        if (type === "revise" && (candidate.status === "stale" || candidate.status === "rejected")) fail(token, code);
        if (type === "mark_stale" && ((target.kind !== "recurrence" && target.kind !== "hypothesis") ||
            candidate.status !== "stale" || !extraction.evidence.some((row) =>
              row.itemKey === localItemKey && row.relation === "contradicts"))) fail(token, code);
        if (type === "reject" && (candidate.status !== "rejected" || !extraction.evidence.some((row) =>
          row.itemKey === localItemKey && row.relation === "rejects"))) fail(token, code);
      }
      translated.push({ type, candidateLocalItemKey: localItemKey, targetMemoryKey });
    }
    if (consumed.size !== candidateByKey.size) fail(token, code);
    return translated.map((operation) => ({ ...operation }));
  });
}

export function validateMemoryV3TrustedForgetKeys(
  value: unknown,
  stateValue: MemoryV3LifecycleState,
): string[] {
  return boundary("lifecycle_contract_invalid_shape", (token) => {
    const code = "lifecycle_contract_invalid_forget";
    const state = validateStateInternal(token, stateValue);
    const existing = new Set(state.items.map((item) => item.memoryKey));
    const entries = denseArray(token, value, MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS, code);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== "string" || !MEMORY_KEY.test(entry) || !existing.has(entry) || seen.has(entry)) fail(token, code);
      seen.add(entry);
    }
    return [...entries] as string[];
  });
}

export function projectSafeMemoryV3LifecycleContractDiagnostic(error: unknown): Diagnostic | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null || !OWN_ERRORS.has(error)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "diagnosticCode");
  } catch {
    return null;
  }
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !DIAGNOSTICS.has(descriptor.value)) return null;
  return descriptor.value;
}
