import type { MemoryV3Extraction } from "./contract.ts";
import {
  MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
  type MemoryV3DialogueEvidence,
  type MemoryV3DialogueItem,
  type MemoryV3DialogueOperationType,
  type MemoryV3DialogueProposal,
  type MemoryV3DialogueState,
  projectSafeMemoryV3DialogueContractDiagnostic,
  validateMemoryV3DialogueProposal,
  validateMemoryV3DialogueState,
  validateMemoryV3DialogueTrustedForgetKeys,
} from "./dialogueContract.ts";

type Diagnostic =
  | "dialogue_reducer_invalid_input"
  | "dialogue_reducer_transition_invalid";

type JsonRecord = Record<string, unknown>;

const OWN_ERRORS = new WeakSet<object>();
const ERROR_TOKENS = new WeakMap<object, object>();
const DIAGNOSTICS = new Set<Diagnostic>([
  "dialogue_reducer_invalid_input",
  "dialogue_reducer_transition_invalid",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEMORY_KEY = /^[0-9a-f]{64}$/;
const EMPTY_FIELDS = ["userId", "conversationId"] as const;
const STEP_FIELDS = [
  "state",
  "at",
  "conversationId",
  "extraction",
  "proposal",
  "trustedForgetMemoryKeys",
] as const;
const INTERNAL_OPERATION_FIELDS = ["type", "candidateLocalItemKey", "targetMemoryKey"] as const;
const MATERIAL_FIELDS = [
  "kind",
  "claim",
  "status",
  "sensitivity",
  "eventTimeStart",
  "eventTimeEnd",
  "alternative",
] as const;
const OPERATION_TYPES = ["create", "confirm", "revise", "mark_stale", "reject", "ignore"] as const;
const OPERATION_RANK: Record<MemoryV3DialogueOperationType, number> = {
  create: 0,
  confirm: 1,
  revise: 2,
  mark_stale: 3,
  reject: 4,
  ignore: 5,
};
const KEY_NAMESPACE = "memory-v3-production-dialogue-v1";

function makeError(token: object, diagnosticCode: Diagnostic): Error {
  const error = new Error("[memory-v3:dialogue-reducer] value is invalid");
  error.name = "MemoryV3DialogueReducerError";
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

function isOwnError(error: unknown, token: object): boolean {
  return typeof error === "object" && error !== null &&
    OWN_ERRORS.has(error) && ERROR_TOKENS.get(error) === token;
}

function boundary<T>(diagnostic: Diagnostic, fn: (token: object) => T): T {
  const token = Object.freeze({});
  try {
    return fn(token);
  } catch (error) {
    if (isOwnError(error, token)) throw error;
    projectSafeMemoryV3DialogueContractDiagnostic(error);
    throw makeError(token, diagnostic);
  }
}

async function asyncBoundary<T>(
  diagnostic: Diagnostic,
  fn: (token: object) => Promise<T>,
): Promise<T> {
  const token = Object.freeze({});
  try {
    return await fn(token);
  } catch (error) {
    if (isOwnError(error, token)) throw error;
    projectSafeMemoryV3DialogueContractDiagnostic(error);
    throw makeError(token, diagnostic);
  }
}

function inspectRecord(
  token: object,
  value: unknown,
  fields: readonly string[],
): JsonRecord {
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    if (typeof value !== "object" || value === null) fail(token, "dialogue_reducer_invalid_input");
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (isOwnError(error, token)) throw error;
    fail(token, "dialogue_reducer_invalid_input");
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length) {
    fail(token, "dialogue_reducer_invalid_input");
  }
  const allowed = new Set(fields);
  const output: JsonRecord = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) fail(token, "dialogue_reducer_invalid_input");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token, "dialogue_reducer_invalid_input");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    output[key] = descriptor.value;
  }
  for (const field of fields) {
    if (!Object.hasOwn(output, field)) fail(token, "dialogue_reducer_invalid_input");
  }
  return output;
}

function cloneJsonData(token: object, value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(token, "dialogue_reducer_invalid_input");
    return value;
  }
  if (typeof value !== "object") fail(token, "dialogue_reducer_invalid_input");
  if (seen.has(value)) fail(token, "dialogue_reducer_invalid_input");
  seen.add(value);
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(token, "dialogue_reducer_invalid_input");
  }
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    fail(token, "dialogue_reducer_invalid_input");
  }
  let length = 0;
  if (isArray) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, "length");
    } catch {
      fail(token, "dialogue_reducer_invalid_input");
    }
    if (!descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    length = descriptor.value as number;
    if (keys.length !== length + 1) fail(token, "dialogue_reducer_invalid_input");
  }
  const output: unknown[] | JsonRecord = isArray ? [] : {};
  const allowedArrayKeys = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < length; index += 1) allowedArrayKeys.add(String(index));
  for (const key of keys) {
    if (typeof key !== "string" || (isArray && !allowedArrayKeys.has(key))) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    if (key === "length") continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(token, "dialogue_reducer_invalid_input");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    (output as JsonRecord)[key] = cloneJsonData(token, descriptor.value, seen);
  }
  if (isArray && output.length !== length) fail(token, "dialogue_reducer_invalid_input");
  seen.delete(value);
  return output;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze((value as JsonRecord)[key]);
  return Object.freeze(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value as JsonRecord).sort(compareStrings).map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify((value as JsonRecord)[key])}`).join(",")}}`;
}

async function memoryKeyFor(userId: string, ordinal: number): Promise<string> {
  const payload = JSON.stringify({ namespace: KEY_NAMESPACE, userId, ordinal });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function materialFromCandidate(candidate: MemoryV3Extraction["items"][number]): JsonRecord {
  return Object.fromEntries(MATERIAL_FIELDS.map((field) => [field, candidate[field]]));
}

function evidenceIdentity(row: MemoryV3DialogueEvidence): string {
  return `${row.conversationId}\0${row.sourceMessageId}\0${row.relation}`;
}

function candidateEvidence(
  extraction: MemoryV3Extraction,
  candidateLocalItemKey: string,
  conversationId: string,
): MemoryV3DialogueEvidence[] {
  return extraction.evidence
    .filter((row) => row.itemKey === candidateLocalItemKey)
    .map((row) => ({
      conversationId,
      sourceMessageId: row.sourceMessageId,
      relation: row.relation,
      supportType: row.supportType,
      episodeKey: row.episodeKey,
      provenanceRole: row.provenanceRole,
      mentionTime: row.mentionTime,
    }))
    .sort((left, right) => compareStrings(evidenceIdentity(left), evidenceIdentity(right)));
}

function mergeEvidence(
  token: object,
  existing: MemoryV3DialogueEvidence[],
  incoming: MemoryV3DialogueEvidence[],
): MemoryV3DialogueEvidence[] {
  const byIdentity = new Map(existing.map((row) => [evidenceIdentity(row), { ...row }]));
  for (const row of incoming) {
    const identity = evidenceIdentity(row);
    const previous = byIdentity.get(identity);
    if (previous === undefined) byIdentity.set(identity, { ...row });
    else if (canonicalStringify(previous) !== canonicalStringify(row)) {
      fail(token, "dialogue_reducer_transition_invalid");
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    compareStrings(evidenceIdentity(left), evidenceIdentity(right)));
}

function cloneStateItem(item: MemoryV3DialogueItem): MemoryV3DialogueItem {
  return { ...item, evidence: item.evidence.map((row) => ({ ...row })) };
}

function canonicalStateForComparison(state: MemoryV3DialogueState): MemoryV3DialogueState {
  return {
    ...state,
    items: state.items.map((item) => ({
      ...item,
      evidence: item.evidence.map((row) => ({ ...row })).sort((left, right) =>
        compareStrings(evidenceIdentity(left), evidenceIdentity(right))),
    })).sort((left, right) => compareStrings(left.memoryKey, right.memoryKey)),
  };
}

function validateInternalProposal(
  token: object,
  value: unknown,
  state: MemoryV3DialogueState,
  extraction: MemoryV3Extraction,
): MemoryV3DialogueProposal {
  const cloned = cloneJsonData(token, value);
  if (!Array.isArray(cloned)) fail(token, "dialogue_reducer_invalid_input");
  const memoryBindings = state.items.map((item, index) => ({
    memoryRef: `memory:${String(index + 1).padStart(4, "0")}`,
    memoryKey: item.memoryKey,
  }));
  const candidateBindings = extraction.items.map((item, index) => ({
    candidateRef: `candidate:${String(index + 1).padStart(4, "0")}`,
    localItemKey: item.localItemKey,
  }));
  const memoryRefByKey = new Map(memoryBindings.map((row) => [row.memoryKey, row.memoryRef]));
  const candidateRefByKey = new Map(candidateBindings.map((row) => [row.localItemKey, row.candidateRef]));
  const operations = cloned.map((raw) => {
    const row = inspectRecord(token, raw, INTERNAL_OPERATION_FIELDS);
    if (!OPERATION_TYPES.includes(row.type as MemoryV3DialogueOperationType) ||
        typeof row.candidateLocalItemKey !== "string" || !candidateRefByKey.has(row.candidateLocalItemKey) ||
        (row.targetMemoryKey !== null &&
          (typeof row.targetMemoryKey !== "string" || !MEMORY_KEY.test(row.targetMemoryKey) ||
            !memoryRefByKey.has(row.targetMemoryKey)))) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    const candidateLocalItemKey = row.candidateLocalItemKey as string;
    const targetMemoryKey = row.targetMemoryKey as string | null;
    return {
      type: row.type,
      candidateRef: candidateRefByKey.get(candidateLocalItemKey),
      targetMemoryRef: targetMemoryKey === null ? null : memoryRefByKey.get(targetMemoryKey),
    };
  });
  return validateMemoryV3DialogueProposal(
    { operations },
    { state, extraction, bindings: { memories: memoryBindings, candidates: candidateBindings } },
  );
}

function operationComparator(
  left: MemoryV3DialogueProposal[number],
  right: MemoryV3DialogueProposal[number],
): number {
  const rank = OPERATION_RANK[left.type] - OPERATION_RANK[right.type];
  if (rank !== 0) return rank;
  const target = compareStrings(left.targetMemoryKey ?? "", right.targetMemoryKey ?? "");
  return target !== 0 ? target : compareStrings(left.candidateLocalItemKey, right.candidateLocalItemKey);
}

export function createEmptyMemoryV3DialogueState(input: { userId: string; conversationId: string }): MemoryV3DialogueState {
  return boundary("dialogue_reducer_invalid_input", (token) => {
    const projected = inspectRecord(token, input, EMPTY_FIELDS);
    if (typeof projected.userId !== "string" || !UUID.test(projected.userId)) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    if (typeof projected.conversationId !== "string" || projected.conversationId.trim().length === 0) {
      fail(token, "dialogue_reducer_invalid_input");
    }
    const state: MemoryV3DialogueState = {
      schemaVersion: MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
      userId: projected.userId,
      conversationId: projected.conversationId,
      stateRevision: 0,
      nextMemoryOrdinal: 1,
      items: [],
    };
    return deepFreeze(validateMemoryV3DialogueState(state, projected.userId, projected.conversationId));
  });
}

export async function applyMemoryV3DialogueStep(input: {
  state: MemoryV3DialogueState;
  at: string;
  conversationId: string;
  extraction: MemoryV3Extraction;
  proposal: MemoryV3DialogueProposal;
  trustedForgetMemoryKeys: string[];
}): Promise<{
  state: MemoryV3DialogueState;
  transitions: Array<{
    type: MemoryV3DialogueOperationType | "forget";
    candidateLocalItemKey: string | null;
    targetMemoryKey: string | null;
    resultingMemoryKey: string | null;
  }>;
  changed: boolean;
}> {
  return asyncBoundary("dialogue_reducer_invalid_input", async (token) => {
    const projected = inspectRecord(token, input, STEP_FIELDS);
    if (!validDateTime(projected.at) || typeof projected.conversationId !== "string" ||
        projected.conversationId.trim().length === 0) fail(token, "dialogue_reducer_invalid_input");

    const stateCopy = cloneJsonData(token, projected.state);
    const expectedUserId = typeof stateCopy === "object" && stateCopy !== null
      ? Object.getOwnPropertyDescriptor(stateCopy, "userId")?.value
      : undefined;
    if (typeof expectedUserId !== "string") fail(token, "dialogue_reducer_invalid_input");
    const originalState = validateMemoryV3DialogueState(stateCopy, expectedUserId, projected.conversationId);
    const extraction = cloneJsonData(token, projected.extraction) as MemoryV3Extraction;
    const forgetKeys = validateMemoryV3DialogueTrustedForgetKeys(
      cloneJsonData(token, projected.trustedForgetMemoryKeys),
      originalState,
    );
    const forgotten = new Set(forgetKeys);
    const working: MemoryV3DialogueState = {
      schemaVersion: MEMORY_V3_DIALOGUE_SCHEMA_VERSION,
      userId: originalState.userId,
      conversationId: originalState.conversationId,
      stateRevision: originalState.stateRevision,
      nextMemoryOrdinal: originalState.nextMemoryOrdinal,
      items: originalState.items.filter((item) => !forgotten.has(item.memoryKey)).map(cloneStateItem),
    };
    let intermediate: MemoryV3DialogueState;
    try {
      intermediate = validateMemoryV3DialogueState(working, originalState.userId, originalState.conversationId);
    } catch {
      fail(token, "dialogue_reducer_transition_invalid");
    }
    const proposal = validateInternalProposal(token, projected.proposal, intermediate, extraction)
      .sort(operationComparator);
    const candidateByKey = new Map(extraction.items.map((item) => [item.localItemKey, item]));
    const transitions: Array<{
      type: MemoryV3DialogueOperationType | "forget";
      candidateLocalItemKey: string | null;
      targetMemoryKey: string | null;
      resultingMemoryKey: string | null;
    }> = [...forgetKeys].sort(compareStrings).map((memoryKey) => ({
      type: "forget",
      candidateLocalItemKey: null,
      targetMemoryKey: memoryKey,
      resultingMemoryKey: null,
    }));

    for (const operation of proposal) {
      const candidate = candidateByKey.get(operation.candidateLocalItemKey);
      if (!candidate) fail(token, "dialogue_reducer_transition_invalid");
      const incomingEvidence = candidateEvidence(extraction, operation.candidateLocalItemKey, projected.conversationId);
      let resultingMemoryKey = operation.targetMemoryKey;
      if (operation.type === "create") {
        resultingMemoryKey = await memoryKeyFor(working.userId, working.nextMemoryOrdinal);
        if (working.items.some((item) => item.memoryKey === resultingMemoryKey)) {
          fail(token, "dialogue_reducer_transition_invalid");
        }
        working.items.push({
          memoryKey: resultingMemoryKey,
          ...materialFromCandidate(candidate),
          firstSeenAt: projected.at,
          updatedAt: projected.at,
          revision: 1,
          evidence: incomingEvidence,
        } as MemoryV3DialogueItem);
        working.nextMemoryOrdinal += 1;
      } else if (operation.type !== "ignore") {
        const index = working.items.findIndex((item) => item.memoryKey === operation.targetMemoryKey);
        if (index < 0 || Date.parse(projected.at) < Date.parse(working.items[index].updatedAt)) {
          fail(token, "dialogue_reducer_transition_invalid");
        }
        const target = working.items[index];
        const evidence = mergeEvidence(token, target.evidence, incomingEvidence);
        if (operation.type === "confirm") {
          working.items[index] = { ...target, evidence };
        } else if (operation.type === "revise") {
          const candidateMaterial = materialFromCandidate(candidate);
          const targetMaterial = Object.fromEntries(MATERIAL_FIELDS.map((field) => [field, target[field]]));
          working.items[index] = canonicalStringify(candidateMaterial) === canonicalStringify(targetMaterial)
            ? { ...target, evidence }
            : {
              ...target,
              ...candidateMaterial,
              updatedAt: projected.at,
              revision: target.revision + 1,
              evidence,
            } as MemoryV3DialogueItem;
        } else {
          working.items[index] = {
            ...target,
            status: candidate.status,
            updatedAt: projected.at,
            revision: target.revision + 1,
            evidence,
          };
        }
      }
      transitions.push({
        type: operation.type,
        candidateLocalItemKey: operation.candidateLocalItemKey,
        targetMemoryKey: operation.targetMemoryKey,
        resultingMemoryKey: operation.type === "ignore" ? null : resultingMemoryKey,
      });
    }

    working.items.sort((left, right) => compareStrings(left.memoryKey, right.memoryKey));
    let state: MemoryV3DialogueState;
    try {
      state = validateMemoryV3DialogueState(working, originalState.userId, originalState.conversationId);
    } catch {
      fail(token, "dialogue_reducer_transition_invalid");
    }
    const changed = canonicalStringify(canonicalStateForComparison(originalState)) !==
      canonicalStringify(canonicalStateForComparison(state));
    return deepFreeze({ state, transitions, changed });
  });
}

export function projectSafeMemoryV3DialogueReducerDiagnostic(error: unknown): Diagnostic | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null || !OWN_ERRORS.has(error)) {
    return null;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "diagnosticCode");
  } catch {
    return null;
  }
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !DIAGNOSTICS.has(descriptor.value)) {
    return null;
  }
  return descriptor.value as Diagnostic;
}
