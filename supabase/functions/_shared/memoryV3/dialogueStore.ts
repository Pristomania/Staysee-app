import type { MemoryV3Extraction } from "./contract.ts";
import {
  MEMORY_V3_DIALOGUE_MAX_CANDIDATES,
  MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE,
  MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
  MEMORY_V3_DIALOGUE_TOPICS,
  type MemoryV3DialogueOperationType,
  type MemoryV3DialogueProposal,
  type MemoryV3DialogueState,
  type MemoryV3DialogueTopic,
  validateMemoryV3DialogueState,
} from "./dialogueContract.ts";

export type MemoryV3DialogueStoredDiagnostic =
  | "invalid_source" | "state_too_large"
  | "extractor_transport_failed" | "extractor_parse_invalid"
  | "extractor_shape_invalid" | "extractor_contract_invalid"
  | "reconciler_request_too_large" | "reconciler_transport_failed"
  | "reconciler_parse_invalid" | "reconciler_shape_invalid"
  | "reconciler_contract_invalid" | "state_conflict"
  | "state_write_failed" | "reservation_failed" | "unknown_failure";

export type MemoryV3DialogueReservationResult =
  | { status: "reserved"; runId: string; expectedStateRevision: number; state: MemoryV3DialogueState }
  | { status: "duplicate" | "daily_cap" };

export interface MemoryV3DialogueReservationInput {
  userId: string;
  conversationId: string;
  pipelineVersion: "memory-v3-dialogue-v1";
  extractorVersion: string;
  reconcilerVersion: string;
  model: "google/gemini-3.7-flash";
  inputHash: string;
  sourceLastMessageId: string;
  sourceLastCreatedAt: string;
  messageCount: number;
  userMessageCount: number;
}

export interface MemoryV3DialogueFailureWrite {
  runId: string;
  userId: string;
  diagnosticCode: MemoryV3DialogueStoredDiagnostic;
  /** The specific transport-level reason (e.g. "provider_http_5xx",
   * "transport_timeout"), when the shadow runner has one -- a free-text
   * diagnostic detail, not a closed enum like diagnosticCode, since the
   * transport modules' own code sets evolve independently of this store.
   * null when no specific transport diagnostic applies. */
  transportDetail: string | null;
  /** The reconciler's raw response text, when the shadow runner has one and
   * the failure happened after it replied (reconciler_parse_invalid,
   * reconciler_shape_invalid, reconciler_contract_invalid) -- diagnostic
   * only, never parsed or branched on here. null otherwise. */
  reconcilerRawResponse: string | null;
  /** JSON.stringify({ state, extraction, bindings }) -- the exact inputs
   * validateMemoryV3DialogueProposal() received, present for the same
   * failures as reconcilerRawResponse. Lets a future failure be replayed
   * through the real validator instead of guessed at. Ordinary
   * application data already sent to the provider and already persisted
   * on the success path; diagnostic only, never parsed here. */
  reconcilerContext: string | null;
}

export interface MemoryV3DialogueUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface MemoryV3DialogueSuccessWrite {
  runId: string;
  userId: string;
  conversationId: string;
  expectedStateRevision: number;
  state: MemoryV3DialogueState;
  changed: boolean;
  extraction: MemoryV3Extraction;
  operations: MemoryV3DialogueProposal;
  transitions: Array<{
    type: MemoryV3DialogueOperationType | "forget";
    candidateLocalItemKey: string | null;
    targetMemoryKey: string | null;
    resultingMemoryKey: string | null;
  }>;
  extractorUsage: MemoryV3DialogueUsage | null;
  reconcilerUsage: MemoryV3DialogueUsage | null;
}

export interface MemoryV3DialogueRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface MemoryV3DialogueStore {
  reserve(input: MemoryV3DialogueReservationInput): Promise<MemoryV3DialogueReservationResult>;
  fail(input: MemoryV3DialogueFailureWrite): Promise<void>;
  compareAndSwap(input: MemoryV3DialogueSuccessWrite): Promise<
    { status: "succeeded"; resultingStateRevision: number } | { status: "state_conflict" }
  >;
}

const OWN_ERRORS = new WeakSet<object>();
/**
 * Side channel for failReserve()'s stage tag -- a Symbol key so it can
 * never collide with or be reached by any enumeration of the error's own
 * properties. getMemoryV3DialogueReserveStage() is the only sanctioned way
 * to read it from outside this file.
 */
const RESERVE_STAGE = Symbol("memory-v3-dialogue-reserve-stage");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MEMORY_KEY = SHA256;
const DIAGNOSTICS = new Set<MemoryV3DialogueStoredDiagnostic>([
  "invalid_source", "state_too_large", "extractor_transport_failed",
  "extractor_parse_invalid", "extractor_shape_invalid", "extractor_contract_invalid",
  "reconciler_request_too_large", "reconciler_transport_failed",
  "reconciler_parse_invalid", "reconciler_shape_invalid", "reconciler_contract_invalid",
  "state_conflict", "state_write_failed", "reservation_failed", "unknown_failure",
]);
const OPERATION_TYPES = new Set(["create", "confirm", "revise", "mark_stale", "reject", "ignore"]);
const TRANSITION_TYPES = new Set([...OPERATION_TYPES, "forget"]);
const KINDS = new Set(["event", "recurrence", "hypothesis"]);
const RELATIONS = new Set(["supports", "contradicts", "corrects", "rejects"]);
const SUPPORT_TYPES = new Set(["episode_observation", "pattern_confirmation", "scope_boundary"]);
const STATUS: Record<string, ReadonlySet<string>> = {
  event: new Set(["active", "corrected", "rejected"]),
  recurrence: new Set(["candidate", "active", "stale", "rejected"]),
  hypothesis: new Set(["candidate", "supported", "stale", "rejected"]),
};
const REQUIRED_RELATION: Record<string, string> = {
  active: "supports", corrected: "corrects", rejected: "rejects",
  candidate: "supports", supported: "supports", stale: "contradicts",
};

interface InspectedClient { target: object; rpc: MemoryV3DialogueRpcClient["rpc"] }

function fail(): Error {
  const error = new Error("[memory-v3:dialogue-store] operation failed");
  error.name = "MemoryV3DialogueStoreError";
  OWN_ERRORS.add(error);
  return error;
}

/**
 * Same error, same generic message, same branding as fail() -- callers
 * outside this file see no difference, and every test asserting reserve()
 * always throws the one uninformative message still holds. The reason is
 * carried on a side-channel, non-enumerable property instead, read only by
 * dialogueShadowRunner.ts's own console-only diagnostics for the one case
 * (reservation_failed never reaching the database's own exception log --
 * migration 067/068) that has no other trace at all. Every string passed
 * here is a fixed literal, never interpolated from request or response
 * data, so that side channel can never leak anything either.
 */
function failReserve(reason: string): Error {
  const error = fail();
  Object.defineProperty(error, RESERVE_STAGE, { value: reason, enumerable: false });
  return error;
}

function safe<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (typeof error === "object" && error !== null && OWN_ERRORS.has(error)) throw error;
    throw fail();
  }
}

function isArray(value: unknown): value is unknown[] { return safe(() => Array.isArray(value)); }
function prototypeOf(value: object): object | null { return safe(() => Object.getPrototypeOf(value)); }
function ownKeys(value: object): PropertyKey[] { return safe(() => Reflect.ownKeys(value)); }
function descriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  return safe(() => Object.getOwnPropertyDescriptor(value, key));
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
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

function projectedRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isArray(value)) throw fail();
  const prototype = prototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();
  const copy: Record<string, unknown> = {};
  const wanted = new Set(fields);
  for (const key of ownKeys(value)) {
    if (typeof key !== "string") throw fail();
    const own = descriptor(value, key);
    if (!own || !own.enumerable || !("value" in own)) throw fail();
    if (wanted.has(key)) copy[key] = own.value;
  }
  for (const field of fields) if (!Object.hasOwn(copy, field)) throw fail();
  return copy;
}

function array(value: unknown, max = Number.MAX_SAFE_INTEGER): unknown[] {
  if (!isArray(value)) throw fail();
  const length = descriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > max) throw fail();
  const keys = ownKeys(value);
  if (keys.length !== length.value + 1) throw fail();
  const copy: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const own = descriptor(value, String(index));
    if (!own || !own.enumerable || !("value" in own) || own.value === undefined) throw fail();
    copy.push(own.value);
  }
  return copy;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4], match[5], match[6] ?? "0"].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return false;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function dateOrDateTime(value: unknown): value is string {
  if (isoDateTime(value)) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function cloneJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw fail(); return value; }
  if (typeof value !== "object") throw fail();
  if (seen.has(value)) throw fail();
  seen.add(value);
  try {
    if (isArray(value)) return array(value).map((entry) => cloneJson(entry, seen));
    const prototype = prototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail();
    const copy: Record<string, unknown> = {};
    for (const key of ownKeys(value)) {
      if (typeof key !== "string") throw fail();
      const own = descriptor(value, key);
      if (!own || !own.enumerable || !("value" in own) || own.value === undefined) throw fail();
      copy[key] = cloneJson(own.value, seen);
    }
    return copy;
  } finally { seen.delete(value); }
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
      return { target: value, rpc: own.value as MemoryV3DialogueRpcClient["rpc"] };
    }
    current = prototypeOf(current);
  }
  throw fail();
}

async function callRpc(client: InspectedClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let response: unknown;
  try { response = await client.rpc.call(client.target, name, args); } catch { throw fail(); }
  const projected = projectedRecord(response, ["data", "error"]);
  if (projected.error !== null) throw fail();
  return projected.data;
}

function projectState(value: unknown, userId: string, conversationId: string): MemoryV3DialogueState {
  const cloned = cloneJson(value);
  try { return validateMemoryV3DialogueState(cloned, userId, conversationId); } catch { throw fail(); }
}

function projectExtraction(value: unknown, userId: string, conversationId: string): MemoryV3Extraction {
  const root = record(value, ["run", "items", "evidence"]);
  const run = record(root.run, ["caseId", "extractorVersion"]);
  if (!nonEmpty(run.caseId) || !run.caseId.startsWith(`memory-v3-shadow:${userId}:`) || !nonEmpty(run.extractorVersion)) throw fail();
  const items = array(root.items, MEMORY_V3_DIALOGUE_MAX_CANDIDATES).map((raw) => {
    const item = record(raw, ["localItemKey", "kind", "claim", "scope", "conversationId", "eventTimeStart", "eventTimeEnd", "status", "sensitivity", "alternative"]);
    if (typeof item.localItemKey !== "string" || !SHA256.test(item.localItemKey) || !KINDS.has(item.kind as string) || !nonEmpty(item.claim) || item.scope !== "conversation" || item.conversationId !== conversationId || typeof item.status !== "string" || !STATUS[item.kind as string].has(item.status) || (item.sensitivity !== "normal" && item.sensitivity !== "sensitive")) throw fail();
    if ((item.eventTimeStart !== null && !dateOrDateTime(item.eventTimeStart)) || (item.eventTimeEnd !== null && !dateOrDateTime(item.eventTimeEnd))) throw fail();
    if (item.eventTimeStart !== null && item.eventTimeEnd !== null && Date.parse(item.eventTimeStart as string) > Date.parse(item.eventTimeEnd as string)) throw fail();
    if (item.kind === "hypothesis" ? !nonEmpty(item.alternative) : item.alternative !== null) throw fail();
    return { ...item } as MemoryV3Extraction["items"][number];
  });
  const itemKeys = new Set(items.map((item) => item.localItemKey));
  if (itemKeys.size !== items.length) throw fail();
  const seenEvidence = new Set<string>();
  const evidence = array(root.evidence, MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE).map((raw) => {
    const row = record(raw, ["itemKey", "sourceMessageId", "relation", "supportType", "episodeKey", "provenanceRole", "mentionTime"]);
    if (!nonEmpty(row.itemKey) || !itemKeys.has(row.itemKey) || typeof row.sourceMessageId !== "string" || !UUID.test(row.sourceMessageId) || !RELATIONS.has(row.relation as string) || row.provenanceRole !== "user" || !isoDateTime(row.mentionTime)) throw fail();
    const target = items.find((item) => item.localItemKey === row.itemKey)!;
    const typed = target.kind === "recurrence" && row.relation === "supports";
    if (typed) {
      if (typeof row.supportType !== "string" || !SUPPORT_TYPES.has(row.supportType)) throw fail();
      if (row.supportType === "episode_observation" ? !nonEmpty(row.episodeKey) : row.episodeKey !== null) throw fail();
    } else if (row.supportType !== null || !nonEmpty(row.episodeKey)) throw fail();
    const identity = `${row.itemKey}\0${row.sourceMessageId}\0${row.relation}`;
    if (seenEvidence.has(identity)) throw fail();
    seenEvidence.add(identity);
    return { ...row } as MemoryV3Extraction["evidence"][number];
  });
  for (const item of items) {
    const related = evidence.filter((row) => row.itemKey === item.localItemKey);
    if (!related.some((row) => row.relation === REQUIRED_RELATION[item.status])) throw fail();
    if (item.kind === "recurrence" && (item.status === "candidate" || item.status === "active")) {
      const episodes = new Set(related.filter((row) => row.relation === "supports" && row.supportType === "episode_observation").map((row) => row.episodeKey));
      if (episodes.size < (item.status === "active" ? 2 : 1)) throw fail();
    }
  }
  return { run: { caseId: run.caseId, extractorVersion: run.extractorVersion }, items, evidence };
}

function projectOperations(value: unknown): MemoryV3DialogueProposal {
  return array(value, MEMORY_V3_DIALOGUE_MAX_CANDIDATES).map((raw) => {
    const operation = record(raw, ["type", "candidateLocalItemKey", "targetMemoryKey", "topic"]);
    if (!OPERATION_TYPES.has(operation.type as string) || !nonEmpty(operation.candidateLocalItemKey)) throw fail();
    const hasTarget = typeof operation.targetMemoryKey === "string" && MEMORY_KEY.test(operation.targetMemoryKey);
    if (operation.type === "create" || operation.type === "ignore" ? operation.targetMemoryKey !== null : !hasTarget) throw fail();
    const requiresTopic = operation.type === "create" || operation.type === "revise";
    if (requiresTopic
      ? (operation.topic === null || !MEMORY_V3_DIALOGUE_TOPICS.includes(operation.topic as MemoryV3DialogueTopic))
      : operation.topic !== null) throw fail();
    return { ...operation } as MemoryV3DialogueProposal[number];
  });
}

function projectTransitions(value: unknown): MemoryV3DialogueSuccessWrite["transitions"] {
  return array(value, MEMORY_V3_DIALOGUE_MAX_CANDIDATES + 100).map((raw) => {
    const transition = record(raw, ["type", "candidateLocalItemKey", "targetMemoryKey", "resultingMemoryKey"]);
    if (!TRANSITION_TYPES.has(transition.type as string)) throw fail();
    for (const field of ["candidateLocalItemKey", "targetMemoryKey", "resultingMemoryKey"] as const) {
      const item = transition[field];
      if (item !== null && !nonEmpty(item)) throw fail();
      if ((field === "targetMemoryKey" || field === "resultingMemoryKey") && item !== null && !MEMORY_KEY.test(item as string)) throw fail();
    }
    if (transition.type === "forget") {
      if (transition.candidateLocalItemKey !== null || transition.targetMemoryKey === null || transition.resultingMemoryKey !== null) throw fail();
    } else if (transition.type === "ignore") {
      if (transition.candidateLocalItemKey === null || transition.targetMemoryKey !== null || transition.resultingMemoryKey !== null) throw fail();
    } else if (transition.type === "create") {
      if (transition.candidateLocalItemKey === null || transition.targetMemoryKey !== null || transition.resultingMemoryKey === null) throw fail();
    } else if (transition.candidateLocalItemKey === null || transition.targetMemoryKey === null ||
      transition.resultingMemoryKey !== transition.targetMemoryKey) throw fail();
    return { ...transition } as MemoryV3DialogueSuccessWrite["transitions"][number];
  });
}

function projectUsage(value: unknown): MemoryV3DialogueUsage | null {
  if (value === null) return null;
  const usage = record(value, ["promptTokens", "completionTokens", "costUsd"]);
  if (!Number.isSafeInteger(usage.promptTokens) || (usage.promptTokens as number) < 0 || !Number.isSafeInteger(usage.completionTokens) || (usage.completionTokens as number) < 0 || typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) throw fail();
  return usage as unknown as MemoryV3DialogueUsage;
}

/**
 * Reads failReserve()'s stage tag off an error reserve() threw, for
 * console-only diagnostics -- a fixed, closed-vocabulary string (never
 * request/response-derived) or null for any error that isn't one of
 * reserve()'s own (including a generic fail() from elsewhere in this
 * file, which carries no stage). Every caller still sees the exact same
 * generic error and message either way; this reads a side channel that
 * was never part of that contract.
 */
export function getMemoryV3DialogueReserveStage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<symbol, unknown>)[RESERVE_STAGE];
  return typeof value === "string" ? value : null;
}

export function createMemoryV3DialogueStore(clientValue: MemoryV3DialogueRpcClient): MemoryV3DialogueStore {
  const client = inspectClient(clientValue);
  return {
    async reserve(inputValue) {
      let input: Record<string, unknown>;
      try {
        input = record(inputValue, ["userId", "conversationId", "pipelineVersion", "extractorVersion", "reconcilerVersion", "model", "inputHash", "sourceLastMessageId", "sourceLastCreatedAt", "messageCount", "userMessageCount"]);
      } catch {
        throw failReserve("invalid_input");
      }
      if (typeof input.userId !== "string" || !UUID.test(input.userId) || typeof input.conversationId !== "string" || !UUID.test(input.conversationId) || input.pipelineVersion !== MEMORY_V3_DIALOGUE_PIPELINE_VERSION || !nonEmpty(input.extractorVersion) || !nonEmpty(input.reconcilerVersion) || input.model !== "google/gemini-3.7-flash" || typeof input.inputHash !== "string" || !SHA256.test(input.inputHash) || typeof input.sourceLastMessageId !== "string" || !UUID.test(input.sourceLastMessageId) || !isoDateTime(input.sourceLastCreatedAt) || !Number.isSafeInteger(input.messageCount) || (input.messageCount as number) < 1 || (input.messageCount as number) > 60 || !Number.isSafeInteger(input.userMessageCount) || (input.userMessageCount as number) < 1 || (input.userMessageCount as number) > (input.messageCount as number)) throw failReserve("invalid_input");
      let data: unknown;
      try {
        data = await callRpc(client, "reserve_memory_v3_dialogue_run", {
            p_user_id: input.userId, p_conversation_id: input.conversationId, p_pipeline_version: input.pipelineVersion,
            p_extractor_version: input.extractorVersion, p_reconciler_version: input.reconcilerVersion,
            p_model: input.model, p_input_hash: input.inputHash, p_source_last_message_id: input.sourceLastMessageId,
            p_source_last_created_at: input.sourceLastCreatedAt, p_message_count: input.messageCount,
            p_user_message_count: input.userMessageCount,
        });
      } catch {
        throw failReserve("rpc_call_failed");
      }
      let row: Record<string, unknown>;
      try {
        const rows = array(data);
        if (rows.length !== 1) throw fail();
        row = record(rows[0], ["result", "run_id", "expected_state_revision", "state"]);
      } catch {
        throw failReserve("response_shape_invalid");
      }
      if (row.result === "duplicate" || row.result === "daily_cap") {
        if (row.run_id !== null || row.expected_state_revision !== null || row.state !== null) throw failReserve("duplicate_payload_invalid");
        return { status: row.result };
      }
      if (row.result !== "reserved" || typeof row.run_id !== "string" || !UUID.test(row.run_id) || !Number.isSafeInteger(row.expected_state_revision) || (row.expected_state_revision as number) < 0) throw failReserve("result_invalid");
      let state: MemoryV3DialogueState;
      try {
        state = projectState(row.state, input.userId as string, input.conversationId as string);
      } catch {
        throw failReserve("state_invalid");
      }
      if (state.stateRevision !== row.expected_state_revision) throw failReserve("state_revision_mismatch");
      return { status: "reserved", runId: row.run_id, expectedStateRevision: row.expected_state_revision as number, state };
    },

    async fail(inputValue) {
      const input = record(inputValue, ["runId", "userId", "diagnosticCode", "transportDetail", "reconcilerRawResponse", "reconcilerContext"]);
      if (typeof input.runId !== "string" || !UUID.test(input.runId) || typeof input.userId !== "string" || !UUID.test(input.userId) || typeof input.diagnosticCode !== "string" || !DIAGNOSTICS.has(input.diagnosticCode as MemoryV3DialogueStoredDiagnostic)) throw fail();
      if (input.transportDetail !== null && !nonEmpty(input.transportDetail)) throw fail();
      if (input.reconcilerRawResponse !== null && !nonEmpty(input.reconcilerRawResponse)) throw fail();
      if (input.reconcilerContext !== null && !nonEmpty(input.reconcilerContext)) throw fail();
      const data = await callRpc(client, "fail_memory_v3_dialogue_run", {
        p_run_id: input.runId, p_user_id: input.userId, p_diagnostic_code: input.diagnosticCode,
        p_transport_detail: input.transportDetail, p_reconciler_raw_response: input.reconcilerRawResponse,
        p_reconciler_context: input.reconcilerContext,
      });
      if (data !== null) throw fail();
    },

    async compareAndSwap(inputValue) {
      const input = record(inputValue, ["runId", "userId", "conversationId", "expectedStateRevision", "state", "changed", "extraction", "operations", "transitions", "extractorUsage", "reconcilerUsage"]);
      if (typeof input.runId !== "string" || !UUID.test(input.runId) || typeof input.userId !== "string" || !UUID.test(input.userId) || typeof input.conversationId !== "string" || !UUID.test(input.conversationId) || !Number.isSafeInteger(input.expectedStateRevision) || (input.expectedStateRevision as number) < 0 || typeof input.changed !== "boolean") throw fail();
      const state = projectState(input.state, input.userId as string, input.conversationId as string);
      const expectedResultingRevision = (input.expectedStateRevision as number) + (input.changed ? 1 : 0);
      if (state.stateRevision !== expectedResultingRevision) throw fail();
      const extraction = projectExtraction(input.extraction, input.userId as string, input.conversationId as string);
      const operations = projectOperations(input.operations);
      const transitions = projectTransitions(input.transitions);
      const candidateKeys = new Set(extraction.items.map((item) => item.localItemKey));
      const operatedKeys = new Set(operations.map((operation) => operation.candidateLocalItemKey));
      if (operatedKeys.size !== operations.length || operatedKeys.size !== candidateKeys.size ||
        [...candidateKeys].some((key) => !operatedKeys.has(key))) throw fail();
      const extractorUsage = projectUsage(input.extractorUsage);
      const reconcilerUsage = projectUsage(input.reconcilerUsage);
      const data = await callRpc(client, "apply_memory_v3_dialogue_state", {
        p_run_id: input.runId, p_user_id: input.userId, p_conversation_id: input.conversationId,
        p_expected_state_revision: input.expectedStateRevision,
        p_state: state, p_changed: input.changed, p_extraction: extraction, p_operations: operations,
        p_transitions: transitions, p_extractor_usage: extractorUsage, p_reconciler_usage: reconcilerUsage,
      });
      const rows = array(data);
      if (rows.length !== 1) throw fail();
      const row = record(rows[0], ["result", "resulting_state_revision"]);
      if (row.result === "state_conflict") {
        if (row.resulting_state_revision !== null) throw fail();
        return { status: "state_conflict" };
      }
      if (row.result !== "succeeded" || row.resulting_state_revision !== expectedResultingRevision) throw fail();
      return { status: "succeeded", resultingStateRevision: expectedResultingRevision };
    },
  };
}
