import {
  MEMORY_V3_EXTRACTOR_VERSION,
  MEMORY_V3_MAX_PROMPT_BYTES,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
  type MemoryV3DialogueInput,
  type MemoryV3Extraction,
} from "./contract.ts";
import type { MemoryV3DialogueMessage } from "./messages.ts";
import { buildMemoryV3ExtractorRequest } from "./prompt.ts";
import {
  projectSafeMemoryV3TransportDiagnostic,
  type MemoryV3ModelAdapter,
  type MemoryV3TransportResult,
} from "./transport.ts";
import {
  MEMORY_V3_LIFECYCLE_MAX_CANDIDATES,
  MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE,
  MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES,
  MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE,
  MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS,
  MEMORY_V3_LIFECYCLE_MODEL,
  MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
  MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
  projectSafeMemoryV3LifecycleContractDiagnostic,
  validateMemoryV3LifecycleProposal,
  validateMemoryV3LifecycleState,
  type MemoryV3LifecycleState,
} from "./lifecycleContract.ts";
import { applyMemoryV3LifecycleStep } from "./lifecycleReducer.ts";
import { buildMemoryV3LifecycleReconcileRequest } from "./lifecyclePrompt.ts";
import {
  projectSafeMemoryV3LifecycleTransportDiagnostic,
  type MemoryV3LifecycleModelAdapter,
  type MemoryV3LifecycleTransportResult,
} from "./lifecycleTransport.ts";
import type {
  MemoryV3LifecycleStore,
  MemoryV3LifecycleStoredDiagnostic,
} from "./lifecycleStore.ts";

export type MemoryV3LifecycleShadowDiagnostic = MemoryV3LifecycleStoredDiagnostic;

export type MemoryV3LifecycleShadowResult =
  | { status: "skipped"; reason: "disabled" | "user_not_allowlisted" | "duplicate" | "daily_cap" }
  | { status: "succeeded"; runId: string; itemCount: number; evidenceCount: number; transitionCount: number; stateRevision: number }
  | { status: "failed"; runId: string | null; diagnosticCode: MemoryV3LifecycleShadowDiagnostic };

export interface MemoryV3LifecycleShadowOptions {
  rawMode: string | null | undefined;
  rawAllowedUserId: string | null | undefined;
  userId: string;
  conversationId: string;
  apiKey: string | null | undefined;
  loadMessages: (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
  store: MemoryV3LifecycleStore;
  extractorAdapterFactory: (apiKey: string) => MemoryV3ModelAdapter;
  reconcilerAdapterFactory: (apiKey: string) => MemoryV3LifecycleModelAdapter;
}

type JsonRecord = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPTION_FIELDS = [
  "rawMode", "rawAllowedUserId", "userId", "conversationId", "apiKey",
  "loadMessages", "store", "extractorAdapterFactory", "reconcilerAdapterFactory",
] as const;
const DIAGNOSTICS = new Set<MemoryV3LifecycleShadowDiagnostic>([
  "invalid_source", "state_too_large", "extractor_transport_failed",
  "extractor_parse_invalid", "extractor_shape_invalid", "extractor_contract_invalid",
  "reconciler_request_too_large", "reconciler_transport_failed",
  "reconciler_parse_invalid", "reconciler_shape_invalid", "reconciler_contract_invalid",
  "state_conflict", "state_write_failed", "reservation_failed", "unknown_failure",
]);
const OWN_ERRORS = new WeakSet<object>();

function fail(code: MemoryV3LifecycleShadowDiagnostic): Error {
  const error = new Error("[memory-v3:lifecycle-shadow-runner] operation failed");
  error.name = "MemoryV3LifecycleShadowError";
  Object.defineProperty(error, "diagnosticCode", {
    value: code, enumerable: true, writable: false, configurable: false,
  });
  OWN_ERRORS.add(error);
  return error;
}

function ownDiagnostic(error: unknown): MemoryV3LifecycleShadowDiagnostic | null {
  try {
    if (typeof error !== "object" || error === null || !OWN_ERRORS.has(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "diagnosticCode");
    return descriptor?.enumerable === true && "value" in descriptor &&
        typeof descriptor.value === "string" && DIAGNOSTICS.has(descriptor.value as MemoryV3LifecycleShadowDiagnostic)
      ? descriptor.value as MemoryV3LifecycleShadowDiagnostic
      : null;
  } catch {
    return null;
  }
}

function fitExtractorDialogueToByteCap(
  dialogue: MemoryV3DialogueInput,
): { dialogue: MemoryV3DialogueInput; request: ReturnType<typeof buildMemoryV3ExtractorRequest> } {
  const cap = Math.min(MEMORY_V3_MAX_PROMPT_BYTES, MEMORY_V3_LIFECYCLE_MAX_EXTRACTOR_BYTES);
  for (let start = 0; start < dialogue.messages.length; start += 1) {
    const messages = dialogue.messages.slice(start);
    if (!messages.some((message) => message.role === "user")) continue;
    const candidate = start === 0
      ? dialogue
      : validateMemoryV3Dialogue({ caseId: dialogue.caseId, messages });
    const request = buildMemoryV3ExtractorRequest(candidate);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) {
      return { dialogue: candidate, request };
    }
  }
  throw fail("invalid_source");
}

function inspectExactRecord(value: unknown, fields: readonly string[], code: MemoryV3LifecycleShadowDiagnostic): JsonRecord {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail(code);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length) throw fail(code);
    const allowed = new Set(fields);
    const copy: JsonRecord = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || !allowed.has(key)) throw fail(code);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail(code);
      copy[key] = descriptor.value;
    }
    for (const field of fields) if (!Object.hasOwn(copy, field)) throw fail(code);
    return copy;
  } catch (error) {
    if (ownDiagnostic(error)) throw error;
    throw fail(code);
  }
}

function inspectOptions(value: unknown): JsonRecord {
  return inspectExactRecord(value, OPTION_FIELDS, "unknown_failure");
}

function inspectDenseArray(value: unknown, maximum: number, code: MemoryV3LifecycleShadowDiagnostic): unknown[] {
  try {
    if (!Array.isArray(value)) throw fail(code);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) throw fail(code);
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) throw fail(code);
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail(code);
      copy.push(descriptor.value);
    }
    return copy;
  } catch (error) {
    if (ownDiagnostic(error)) throw error;
    throw fail(code);
  }
}

function ownMethod(value: unknown, name: "reserve" | "fail" | "compareAndSwap"): ((input: never) => Promise<unknown>) | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
    return descriptor.value.bind(value);
  } catch {
    return null;
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (typeof value !== "object") throw fail("unknown_failure");
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
}

async function inputHash(userId: string, conversationId: string, dialogue: MemoryV3DialogueInput): Promise<string> {
  try {
    const payload = {
      pipelineVersion: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
      userId,
      conversationId,
      messages: dialogue.messages.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalStringify(payload)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    if (ownDiagnostic(error)) throw error;
    throw fail("unknown_failure");
  }
}

function inspectExtractorEnvelope(parsed: unknown): void {
  const root = inspectExactRecord(parsed, ["layerDecisions", "items", "evidence"], "extractor_shape_invalid");
  for (const row of inspectDenseArray(root.layerDecisions, 3, "extractor_shape_invalid")) {
    const decision = inspectExactRecord(row, ["kind", "decision", "itemRefs"], "extractor_shape_invalid");
    inspectDenseArray(decision.itemRefs, MEMORY_V3_LIFECYCLE_MAX_CANDIDATES, "extractor_shape_invalid");
  }
  for (const row of inspectDenseArray(root.items, MEMORY_V3_LIFECYCLE_MAX_CANDIDATES, "extractor_shape_invalid")) {
    inspectExactRecord(row, [
      "itemRef", "kind", "claim", "status", "sensitivity",
      "eventTimeStart", "eventTimeEnd", "alternative",
    ], "extractor_shape_invalid");
  }
  for (const row of inspectDenseArray(root.evidence, MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE, "extractor_shape_invalid")) {
    inspectExactRecord(row, ["itemRef", "sourceMessageId", "relation", "supportType", "episodeKey"], "extractor_shape_invalid");
  }
}

function transportResult(value: unknown): MemoryV3TransportResult {
  const row = inspectExactRecord(value, ["content", "usage"], "extractor_transport_failed");
  if (typeof row.content !== "string") throw fail("extractor_transport_failed");
  return { content: row.content, usage: row.usage as MemoryV3TransportResult["usage"] };
}

function lifecycleTransportResult(value: unknown): MemoryV3LifecycleTransportResult {
  const row = inspectExactRecord(value, ["rawContent", "usage"], "reconciler_transport_failed");
  if (typeof row.rawContent !== "string") throw fail("reconciler_transport_failed");
  return { rawContent: row.rawContent, usage: row.usage as MemoryV3LifecycleTransportResult["usage"] };
}

function stateExceedsLimits(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const itemsDescriptor = Object.getOwnPropertyDescriptor(value, "items");
  if (!itemsDescriptor || !("value" in itemsDescriptor) || !Array.isArray(itemsDescriptor.value)) return false;
  const items = itemsDescriptor.value;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(items, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return false;
  const itemCount = lengthDescriptor.value as number;
  if (itemCount > MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS) return true;
  let evidenceCount = 0;
  for (let index = 0; index < itemCount; index += 1) {
    const itemDescriptor = Object.getOwnPropertyDescriptor(items, String(index));
    if (!itemDescriptor || !("value" in itemDescriptor) ||
        typeof itemDescriptor.value !== "object" || itemDescriptor.value === null) continue;
    const evidenceDescriptor = Object.getOwnPropertyDescriptor(itemDescriptor.value, "evidence");
    if (!evidenceDescriptor || !("value" in evidenceDescriptor) || !Array.isArray(evidenceDescriptor.value)) continue;
    const evidenceLength = Object.getOwnPropertyDescriptor(evidenceDescriptor.value, "length")?.value;
    if (!Number.isSafeInteger(evidenceLength)) continue;
    evidenceCount += evidenceLength as number;
    if (evidenceCount > MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE) return true;
  }
  return false;
}

function failed(runId: string | null, diagnosticCode: MemoryV3LifecycleShadowDiagnostic): MemoryV3LifecycleShadowResult {
  return { status: "failed", runId, diagnosticCode };
}

// Cost logging is analytics, not correctness -- a failure here must never
// affect lifecycle persistence or the reply path, so it's swallowed, same
// as reportTransportDiagnostic above.
async function logUsageSafely(
  logUsage: MemoryV3LifecycleUsageLogger | undefined,
  input: Parameters<MemoryV3LifecycleUsageLogger>[0],
): Promise<void> {
  if (typeof logUsage !== "function") return;
  try {
    await logUsage(input);
  } catch {
    // Swallowed intentionally.
  }
}

async function persistFailure(
  failStore: (input: never) => Promise<unknown>,
  runId: string,
  userId: string,
  diagnosticCode: MemoryV3LifecycleShadowDiagnostic,
): Promise<MemoryV3LifecycleShadowResult> {
  try {
    await failStore({ runId, userId, diagnosticCode } as never);
    return failed(runId, diagnosticCode);
  } catch {
    return failed(runId, "state_write_failed");
  }
}

export type MemoryV3LifecycleUsageLogger = (input: {
  userId: string;
  conversationId: string;
  runId: string;
  stage: "extractor" | "reconciler";
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}) => Promise<void>;

export async function runMemoryV3LifecycleShadow(
  options: MemoryV3LifecycleShadowOptions,
  reportTransportDiagnostic?: (
    code: NonNullable<ReturnType<typeof projectSafeMemoryV3LifecycleTransportDiagnostic>>,
  ) => void,
  logUsage?: MemoryV3LifecycleUsageLogger,
): Promise<MemoryV3LifecycleShadowResult> {
  let projected: JsonRecord;
  try {
    projected = inspectOptions(options);
  } catch {
    return failed(null, "unknown_failure");
  }

  if (projected.rawMode !== "lifecycle_shadow" && projected.rawMode !== "lifecycle_all") {
    return { status: "skipped", reason: "disabled" };
  }
  if (projected.rawMode === "lifecycle_shadow" &&
      (typeof projected.rawAllowedUserId !== "string" || !UUID.test(projected.rawAllowedUserId) ||
        projected.userId !== projected.rawAllowedUserId)) {
    return { status: "skipped", reason: "user_not_allowlisted" };
  }
  if (projected.rawMode === "lifecycle_all" &&
      (typeof projected.userId !== "string" || !UUID.test(projected.userId))) {
    return { status: "skipped", reason: "user_not_allowlisted" };
  }

  const userId = projected.userId;
  const conversationId = projected.conversationId;
  const apiKey = projected.apiKey;
  const reserve = ownMethod(projected.store, "reserve");
  const failStore = ownMethod(projected.store, "fail");
  const compareAndSwap = ownMethod(projected.store, "compareAndSwap");
  if (typeof userId !== "string" || !UUID.test(userId) || typeof conversationId !== "string" || !UUID.test(conversationId) ||
      typeof apiKey !== "string" || apiKey.trim().length === 0 || typeof projected.loadMessages !== "function" ||
      typeof projected.extractorAdapterFactory !== "function" || typeof projected.reconcilerAdapterFactory !== "function" ||
      !reserve || !failStore || !compareAndSwap) return failed(null, "invalid_source");

  let dialogue: MemoryV3DialogueInput;
  let extractorRequest;
  try {
    const source = await (projected.loadMessages as MemoryV3LifecycleShadowOptions["loadMessages"])(userId, conversationId);
    const validated = validateMemoryV3Dialogue({ caseId: `memory-v3-shadow:${userId}:${conversationId}`, messages: source });
    const fitted = fitExtractorDialogueToByteCap(validated);
    dialogue = fitted.dialogue;
    extractorRequest = fitted.request;
  } catch {
    return failed(null, "invalid_source");
  }

  let hash: string;
  try {
    hash = await inputHash(userId, conversationId, dialogue);
  } catch {
    return failed(null, "unknown_failure");
  }
  const last = dialogue.messages.at(-1)!;

  let reservation: unknown;
  try {
    reservation = await reserve({
      userId, conversationId,
      pipelineVersion: MEMORY_V3_LIFECYCLE_PIPELINE_VERSION,
      extractorVersion: MEMORY_V3_EXTRACTOR_VERSION,
      reconcilerVersion: MEMORY_V3_LIFECYCLE_RECONCILER_VERSION,
      model: MEMORY_V3_LIFECYCLE_MODEL,
      inputHash: hash,
      sourceLastMessageId: last.id,
      sourceLastCreatedAt: last.createdAt,
      messageCount: dialogue.messages.length,
      userMessageCount: dialogue.messages.filter((message) => message.role === "user").length,
    } as never);
  } catch {
    return failed(null, "reservation_failed");
  }

  let reserved: JsonRecord;
  try {
    if (typeof reservation !== "object" || reservation === null) throw fail("reservation_failed");
    const status = Object.getOwnPropertyDescriptor(reservation, "status")?.value;
    if (status === "duplicate" || status === "daily_cap") {
      inspectExactRecord(reservation, ["status"], "reservation_failed");
      return { status: "skipped", reason: status };
    }
    reserved = inspectExactRecord(
      reservation, ["status", "runId", "expectedStateRevision", "state"], "reservation_failed",
    );
    if (reserved.status !== "reserved" || typeof reserved.runId !== "string" || !UUID.test(reserved.runId) ||
        !Number.isSafeInteger(reserved.expectedStateRevision) || (reserved.expectedStateRevision as number) < 0) {
      throw fail("reservation_failed");
    }
  } catch {
    return failed(null, "reservation_failed");
  }
  const runId = reserved.runId as string;
  let state: MemoryV3LifecycleState;
  try {
    if (stateExceedsLimits(reserved.state)) throw fail("state_too_large");
    state = validateMemoryV3LifecycleState(reserved.state, userId);
    if (state.stateRevision !== reserved.expectedStateRevision || state.items.length > MEMORY_V3_LIFECYCLE_MAX_STATE_ITEMS ||
        state.items.reduce((sum, item) => sum + item.evidence.length, 0) > MEMORY_V3_LIFECYCLE_MAX_STATE_EVIDENCE) {
      throw fail("state_too_large");
    }
  } catch (error) {
    const code = ownDiagnostic(error) ?? "reservation_failed";
    return await persistFailure(failStore, runId, userId, code);
  }

  let extractor: MemoryV3TransportResult;
  try {
    const adapter = (projected.extractorAdapterFactory as MemoryV3LifecycleShadowOptions["extractorAdapterFactory"])(apiKey);
    if (typeof adapter !== "function") throw fail("extractor_transport_failed");
    extractor = transportResult(await adapter(extractorRequest));
  } catch (error) {
    const transportCode = projectSafeMemoryV3TransportDiagnostic(error);
    const code = ownDiagnostic(error) ?? (transportCode ? "extractor_transport_failed" : "extractor_transport_failed");
    return await persistFailure(failStore, runId, userId, code);
  }
  // Logged as soon as the response is in, regardless of whether the run
  // later succeeds -- the extractor call's cost is already spent either way.
  if (extractor.usage !== null) {
    await logUsageSafely(logUsage, {
      userId, conversationId, runId, stage: "extractor", model: MEMORY_V3_LIFECYCLE_MODEL,
      promptTokens: extractor.usage.promptTokens,
      completionTokens: extractor.usage.completionTokens,
      costUsd: extractor.usage.costUsd,
    });
  }

  let parsedExtraction: unknown;
  try {
    parsedExtraction = JSON.parse(extractor.content);
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_parse_invalid");
  }
  try {
    inspectExtractorEnvelope(parsedExtraction);
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_shape_invalid");
  }
  let extraction: MemoryV3Extraction;
  try {
    extraction = await normalizeMemoryV3LayeredResponse(parsedExtraction, dialogue, MEMORY_V3_EXTRACTOR_VERSION, "cross_conversation");
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  if (extraction.items.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATES ||
      extraction.evidence.length > MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE) {
    return await persistFailure(failStore, runId, userId, "state_too_large");
  }

  let bundle;
  try {
    bundle = buildMemoryV3LifecycleReconcileRequest({ userId, conversationId, messages: dialogue.messages, state, extraction });
    if (new TextEncoder().encode(JSON.stringify(bundle.request)).byteLength > MEMORY_V3_LIFECYCLE_MAX_RECONCILER_BYTES) {
      throw fail("reconciler_request_too_large");
    }
  } catch (error) {
    const code = ownDiagnostic(error) ?? "reconciler_contract_invalid";
    return await persistFailure(failStore, runId, userId, code);
  }

  let reconciler: MemoryV3LifecycleTransportResult;
  try {
    const adapter = (projected.reconcilerAdapterFactory as MemoryV3LifecycleShadowOptions["reconcilerAdapterFactory"])(apiKey);
    if (typeof adapter !== "function") throw fail("reconciler_transport_failed");
    reconciler = lifecycleTransportResult(await adapter(bundle.request));
  } catch (error) {
    const transportDiagnostic = projectSafeMemoryV3LifecycleTransportDiagnostic(error);
    if (transportDiagnostic !== null && typeof reportTransportDiagnostic === "function") {
      try {
        reportTransportDiagnostic(transportDiagnostic);
      } catch {
        // Safe diagnostics must never affect lifecycle persistence or the reply path.
      }
    }
    return await persistFailure(failStore, runId, userId, "reconciler_transport_failed");
  }
  // Same as the extractor call above: logged now, independent of whether
  // the run later succeeds.
  if (reconciler.usage !== null) {
    await logUsageSafely(logUsage, {
      userId, conversationId, runId, stage: "reconciler", model: MEMORY_V3_LIFECYCLE_MODEL,
      promptTokens: reconciler.usage.promptTokens,
      completionTokens: reconciler.usage.completionTokens,
      costUsd: reconciler.usage.costUsd,
    });
  }

  let rawProposal: unknown;
  try {
    rawProposal = JSON.parse(reconciler.rawContent);
  } catch {
    return await persistFailure(failStore, runId, userId, "reconciler_parse_invalid");
  }
  let proposal;
  try {
    const proposalRoot = inspectExactRecord(rawProposal, ["operations"], "reconciler_shape_invalid");
    for (const operation of inspectDenseArray(
      proposalRoot.operations,
      MEMORY_V3_LIFECYCLE_MAX_CANDIDATES,
      "reconciler_shape_invalid",
    )) {
      inspectExactRecord(
        operation,
        ["type", "candidateRef", "targetMemoryRef", "topic"],
        "reconciler_shape_invalid",
      );
    }
    proposal = validateMemoryV3LifecycleProposal(rawProposal, { state, extraction, bindings: bundle.bindings });
  } catch (error) {
    const own = ownDiagnostic(error);
    if (own === "reconciler_shape_invalid") {
      return await persistFailure(failStore, runId, userId, own);
    }
    const diagnostic = projectSafeMemoryV3LifecycleContractDiagnostic(error);
    const code = diagnostic === "lifecycle_contract_invalid_shape"
      ? "reconciler_shape_invalid"
      : "reconciler_contract_invalid";
    return await persistFailure(failStore, runId, userId, code);
  }

  let reduced;
  try {
    reduced = await applyMemoryV3LifecycleStep({
      state, at: last.createdAt, conversationId, extraction, proposal, trustedForgetMemoryKeys: [],
    });
  } catch {
    return await persistFailure(failStore, runId, userId, "reconciler_contract_invalid");
  }

  let resultingState: MemoryV3LifecycleState;
  try {
    resultingState = validateMemoryV3LifecycleState({
      ...reduced.state,
      stateRevision: (reserved.expectedStateRevision as number) + (reduced.changed ? 1 : 0),
    }, userId);
  } catch {
    return await persistFailure(failStore, runId, userId, "reconciler_contract_invalid");
  }
  let cas: unknown;
  try {
    cas = await compareAndSwap({
      runId, userId, expectedStateRevision: reserved.expectedStateRevision,
      state: resultingState, changed: reduced.changed, extraction, operations: proposal,
      transitions: reduced.transitions, extractorUsage: extractor.usage, reconcilerUsage: reconciler.usage,
    } as never);
  } catch {
    return failed(runId, "state_write_failed");
  }
  try {
    const status = Object.getOwnPropertyDescriptor(cas as object, "status")?.value;
    if (status === "state_conflict") {
      inspectExactRecord(cas, ["status"], "state_write_failed");
      return failed(runId, "state_conflict");
    }
    const result = inspectExactRecord(cas, ["status", "resultingStateRevision"], "state_write_failed");
    if (result.status !== "succeeded" || result.resultingStateRevision !== resultingState.stateRevision) throw fail("state_write_failed");
  } catch {
    return failed(runId, "state_write_failed");
  }
  return {
    status: "succeeded",
    runId,
    itemCount: extraction.items.length,
    evidenceCount: extraction.evidence.length,
    transitionCount: reduced.transitions.length,
    stateRevision: resultingState.stateRevision,
  };
}

function inspectBackgroundResult(value: unknown): MemoryV3LifecycleShadowResult | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const status = Object.getOwnPropertyDescriptor(value, "status")?.value;
    const fields = status === "failed"
      ? ["status", "runId", "diagnosticCode"]
      : status === "skipped"
      ? ["status", "reason"]
      : status === "succeeded"
      ? ["status", "runId", "itemCount", "evidenceCount", "transitionCount", "stateRevision"]
      : [];
    if (fields.length === 0) return null;
    const row = inspectExactRecord(value, fields, "unknown_failure");
    if (status === "failed") {
      if ((row.runId !== null && (typeof row.runId !== "string" || !UUID.test(row.runId))) ||
          typeof row.diagnosticCode !== "string" ||
          !DIAGNOSTICS.has(row.diagnosticCode as MemoryV3LifecycleShadowDiagnostic)) return null;
      if (row.runId === null && row.diagnosticCode !== "invalid_source" &&
          row.diagnosticCode !== "reservation_failed" && row.diagnosticCode !== "unknown_failure") return null;
    } else if (status === "skipped") {
      if (row.reason !== "disabled" && row.reason !== "user_not_allowlisted" &&
          row.reason !== "duplicate" && row.reason !== "daily_cap") return null;
    } else {
      if (typeof row.runId !== "string" || !UUID.test(row.runId) ||
          !Number.isSafeInteger(row.itemCount) || (row.itemCount as number) < 0 ||
          (row.itemCount as number) > MEMORY_V3_LIFECYCLE_MAX_CANDIDATES ||
          !Number.isSafeInteger(row.evidenceCount) || (row.evidenceCount as number) < 0 ||
          (row.evidenceCount as number) > MEMORY_V3_LIFECYCLE_MAX_CANDIDATE_EVIDENCE ||
          !Number.isSafeInteger(row.transitionCount) || (row.transitionCount as number) < 0 ||
          (row.transitionCount as number) > MEMORY_V3_LIFECYCLE_MAX_CANDIDATES ||
          !Number.isSafeInteger(row.stateRevision) || (row.stateRevision as number) < 0) return null;
    }
    return row as unknown as MemoryV3LifecycleShadowResult;
  } catch {
    return null;
  }
}

export async function runMemoryV3LifecycleShadowBackgroundSafely(
  run: () => Promise<MemoryV3LifecycleShadowResult>,
  logSafe: (code: MemoryV3LifecycleShadowDiagnostic) => void,
): Promise<void> {
  let diagnostic: MemoryV3LifecycleShadowDiagnostic | null = null;
  try {
    if (typeof run !== "function") throw fail("unknown_failure");
    const result = inspectBackgroundResult(await run());
    if (result?.status === "failed") diagnostic = result.diagnosticCode;
    else if (result === null) diagnostic = "unknown_failure";
  } catch (error) {
    diagnostic = ownDiagnostic(error) ?? "unknown_failure";
  }
  if (diagnostic !== null && typeof logSafe === "function") {
    try {
      logSafe(diagnostic);
    } catch {
      // Background shadow logging must never affect the reply path.
    }
  }
}
