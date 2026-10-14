import {
  MEMORY_V3_MAX_PROMPT_BYTES,
  MEMORY_V3_MAX_SOURCE_MESSAGES,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
  type MemoryV3DialogueInput,
  type MemoryV3Extraction,
} from "./contract.ts";
import type {
  MemoryV3DialogueMessage,
  MemoryV3MessageLoader,
  MemoryV3SourceCursor,
} from "./messages.ts";
import {
  MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
  buildMemoryV3DialogueExtractorRequest,
} from "./dialogueExtractorPrompt.ts";
import {
  projectSafeMemoryV3TransportDiagnostic,
  type MemoryV3ModelAdapter,
  type MemoryV3TransportResult,
} from "./transport.ts";
import {
  MEMORY_V3_DIALOGUE_MAX_CANDIDATES,
  MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE,
  MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES,
  MEMORY_V3_DIALOGUE_MAX_RECONCILER_BYTES,
  MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE,
  MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS,
  MEMORY_V3_DIALOGUE_MODEL,
  MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
  MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
  projectSafeMemoryV3DialogueContractDiagnostic,
  validateMemoryV3DialogueProposal,
  validateMemoryV3DialogueState,
  type MemoryV3DialogueState,
} from "./dialogueContract.ts";
import { applyMemoryV3DialogueStep } from "./dialogueReducer.ts";
import { buildMemoryV3DialogueReconcileRequest } from "./dialoguePrompt.ts";
import {
  projectSafeMemoryV3DialogueTransportDiagnostic,
  type MemoryV3DialogueModelAdapter,
  type MemoryV3DialogueTransportResult,
} from "./dialogueTransport.ts";
import { getMemoryV3DialogueReserveStage } from "./dialogueStore.ts";
import type {
  MemoryV3DialogueStore,
  MemoryV3DialogueStoredDiagnostic,
} from "./dialogueStore.ts";
import type { MemoryV3LifecycleUsageLogger } from "./lifecycleShadowRunner.ts";

export type MemoryV3DialogueShadowDiagnostic = MemoryV3DialogueStoredDiagnostic;

export type MemoryV3DialogueShadowResult =
  | { status: "skipped"; reason: "duplicate" | "daily_cap" }
  | { status: "succeeded"; runId: string; itemCount: number; evidenceCount: number; transitionCount: number; stateRevision: number }
  | { status: "failed"; runId: string | null; diagnosticCode: MemoryV3DialogueShadowDiagnostic };

export interface MemoryV3DialogueShadowOptions {
  userId: string;
  conversationId: string;
  apiKey: string | null | undefined;
  /** Called with two arguments for a first run (today's last-60 window), and
   * with this conversation's last succeeded cursor otherwise -- then it
   * returns a delta window (spec 2026-10-13 §1). */
  loadMessages: MemoryV3MessageLoader;
  store: MemoryV3DialogueStore;
  extractorAdapterFactory: (apiKey: string) => MemoryV3ModelAdapter;
  reconcilerAdapterFactory: (apiKey: string) => MemoryV3DialogueModelAdapter;
}

type JsonRecord = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPTION_FIELDS = [
  "userId", "conversationId", "apiKey",
  "loadMessages", "store", "extractorAdapterFactory", "reconcilerAdapterFactory",
] as const;
const DIAGNOSTICS = new Set<MemoryV3DialogueShadowDiagnostic>([
  "invalid_source", "state_too_large", "extractor_transport_failed",
  "extractor_parse_invalid", "extractor_shape_invalid", "extractor_contract_invalid",
  "reconciler_request_too_large", "reconciler_transport_failed",
  "reconciler_parse_invalid", "reconciler_shape_invalid", "reconciler_contract_invalid",
  "state_conflict", "state_write_failed", "reservation_failed", "unknown_failure",
]);
const OWN_ERRORS = new WeakSet<object>();

function fail(code: MemoryV3DialogueShadowDiagnostic): Error {
  const error = new Error("[memory-v3:dialogue-shadow-runner] operation failed");
  error.name = "MemoryV3DialogueShadowError";
  Object.defineProperty(error, "diagnosticCode", {
    value: code, enumerable: true, writable: false, configurable: false,
  });
  OWN_ERRORS.add(error);
  return error;
}

function ownDiagnostic(error: unknown): MemoryV3DialogueShadowDiagnostic | null {
  try {
    if (typeof error !== "object" || error === null || !OWN_ERRORS.has(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "diagnosticCode");
    return descriptor?.enumerable === true && "value" in descriptor &&
        typeof descriptor.value === "string" && DIAGNOSTICS.has(descriptor.value as MemoryV3DialogueShadowDiagnostic)
      ? descriptor.value as MemoryV3DialogueShadowDiagnostic
      : null;
  } catch {
    return null;
  }
}

function fitExtractorDialogueToByteCap(
  dialogue: MemoryV3DialogueInput,
): { dialogue: MemoryV3DialogueInput; request: ReturnType<typeof buildMemoryV3DialogueExtractorRequest> } {
  const cap = Math.min(MEMORY_V3_MAX_PROMPT_BYTES, MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES);
  for (let start = 0; start < dialogue.messages.length; start += 1) {
    const messages = dialogue.messages.slice(start);
    if (!messages.some((message) => message.role === "user")) continue;
    const candidate = start === 0
      ? dialogue
      : validateMemoryV3Dialogue({ caseId: dialogue.caseId, messages });
    const request = buildMemoryV3DialogueExtractorRequest(candidate);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) {
      return { dialogue: candidate, request };
    }
  }
  throw fail("invalid_source");
}

type FittedExtractorDialogue = {
  dialogue: MemoryV3DialogueInput;
  request: ReturnType<typeof buildMemoryV3DialogueExtractorRequest>;
};

// Delta mode (spec 2026-10-13 §1): the same 20 KB cap, but trimmed from the
// NEWEST end of the delta -- those messages simply open the next run, since
// the cursor only advances to the last message actually sent. (The first-run
// fit above trims the oldest end; here that would let the cursor jump past
// messages no run ever read.) Never drops the context block or the oldest
// undrained message, and stops before the window would hold no user message.
// If even that minimum is over the cap, it is sent as-is: an accepted,
// logged edge case -- never a gap.
function fitDeltaWindowToByteCap(
  caseId: string,
  context: MemoryV3DialogueMessage[],
  delta: MemoryV3DialogueMessage[],
): FittedExtractorDialogue {
  const cap = Math.min(MEMORY_V3_MAX_PROMPT_BYTES, MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES);
  let smallest: FittedExtractorDialogue | null = null;
  for (let end = delta.length; end >= 1; end -= 1) {
    const messages = [...context, ...delta.slice(0, end)];
    if (!messages.some((message) => message.role === "user")) break;
    const dialogue = validateMemoryV3Dialogue({ caseId, messages });
    const request = buildMemoryV3DialogueExtractorRequest(dialogue);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) return { dialogue, request };
    smallest = { dialogue, request };
  }
  if (smallest === null) throw fail("invalid_source");
  // The oldest undrained message alone -- plus the context block -- still
  // exceeds the cap. Never drop it (the run must analyze something new) and
  // never send it unbounded (a sufficiently long single message would risk
  // exceeding the provider's real per-call token budget, not just this
  // cap's accounting assumption, and would keep doing so on every retry).
  // Binary-search the largest prefix of its text that brings the whole
  // request back under cap; context and every other field are untouched.
  const truncated = truncateOldestMessageToFit(caseId, context, delta[0], cap);
  if (truncated !== null) {
    console.warn("[memory-v3-dialogue-delta-message-truncated]");
    return truncated;
  }
  console.warn("[memory-v3-dialogue-delta-over-byte-cap]");
  return smallest;
}

function truncateOldestMessageToFit(
  caseId: string,
  context: MemoryV3DialogueMessage[],
  oldest: MemoryV3DialogueMessage,
  cap: number,
): FittedExtractorDialogue | null {
  let low = 1;
  let high = oldest.text.length;
  let best: FittedExtractorDialogue | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      const dialogue = validateMemoryV3Dialogue({
        caseId,
        messages: [...context, { ...oldest, text: oldest.text.slice(0, mid) }],
      });
      const request = buildMemoryV3DialogueExtractorRequest(dialogue);
      if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) {
        best = { dialogue, request };
        low = mid + 1;
        continue;
      }
    } catch {
      // A prefix can be blank after trimming (leading whitespace) even when
      // the full text is not; shrink further rather than treat it as fatal.
    }
    high = mid - 1;
  }
  return best;
}

function inspectExactRecord(value: unknown, fields: readonly string[], code: MemoryV3DialogueShadowDiagnostic): JsonRecord {
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

function inspectDenseArray(value: unknown, maximum: number, code: MemoryV3DialogueShadowDiagnostic): unknown[] {
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

function ownMethod(
  value: unknown,
  name: "reserve" | "fail" | "compareAndSwap" | "lastSucceededCursor",
): ((input: never) => Promise<unknown>) | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
    return descriptor.value.bind(value);
  } catch {
    return null;
  }
}

// The store's answer is untrusted until checked here; anything malformed
// fails the run exactly like a failed lookup.
function projectSourceCursor(value: unknown): MemoryV3SourceCursor | null {
  if (value === null) return null;
  const cursor = inspectExactRecord(value, ["messageId", "createdAt"], "invalid_source");
  if (typeof cursor.messageId !== "string" || !UUID.test(cursor.messageId) ||
      typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))) {
    throw fail("invalid_source");
  }
  return { messageId: cursor.messageId, createdAt: cursor.createdAt };
}

// The loader's delta-mode answer, checked before anything trusts it. Both
// blocks are validated together (unique ids across them, at most 60 in all,
// at least one user message) and split back at the same boundary.
function inspectDeltaWindow(value: unknown, caseId: string): {
  context: MemoryV3DialogueMessage[];
  delta: MemoryV3DialogueMessage[];
  latestMessageId: string;
} {
  const window = inspectExactRecord(value, ["context", "delta", "latestMessageId"], "invalid_source");
  const context = inspectDenseArray(window.context, MEMORY_V3_MAX_SOURCE_MESSAGES, "invalid_source");
  const delta = inspectDenseArray(window.delta, MEMORY_V3_MAX_SOURCE_MESSAGES, "invalid_source");
  if (typeof window.latestMessageId !== "string" || !UUID.test(window.latestMessageId)) throw fail("invalid_source");
  const messages = validateMemoryV3Dialogue({ caseId, messages: [...context, ...delta] }).messages;
  return {
    context: messages.slice(0, context.length),
    delta: messages.slice(context.length),
    latestMessageId: window.latestMessageId,
  };
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (typeof value !== "object") throw fail("unknown_failure");
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
}

async function inputHash(
  userId: string,
  conversationId: string,
  dialogue: MemoryV3DialogueInput,
  latestMessageId: string | null,
): Promise<string> {
  try {
    const payload: JsonRecord = {
      pipelineVersion: MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
      userId,
      conversationId,
      messages: dialogue.messages.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    };
    // Delta mode only (spec 2026-10-13 §1). A delta window need not end at the
    // conversation's newest message, so after a failed run the next run can
    // rebuild the very same window -- and the reservation's duplicate check is
    // permanent (an input hash is never released, not even by a failed run),
    // which would freeze this conversation's memory for good. Folding in the
    // newest message id keeps "duplicate" meaning what it means for a first
    // run: same input, same conversation state. A retry goes ahead as soon as
    // anything new is written. First-run hashes are unchanged.
    if (latestMessageId !== null) payload.latestMessageId = latestMessageId;
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
    inspectDenseArray(decision.itemRefs, MEMORY_V3_DIALOGUE_MAX_CANDIDATES, "extractor_shape_invalid");
  }
  for (const row of inspectDenseArray(root.items, MEMORY_V3_DIALOGUE_MAX_CANDIDATES, "extractor_shape_invalid")) {
    inspectExactRecord(row, [
      "itemRef", "kind", "claim", "status", "sensitivity",
      "eventTimeStart", "eventTimeEnd", "alternative",
    ], "extractor_shape_invalid");
  }
  for (const row of inspectDenseArray(root.evidence, MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE, "extractor_shape_invalid")) {
    inspectExactRecord(row, ["itemRef", "sourceMessageId", "relation", "supportType", "episodeKey"], "extractor_shape_invalid");
  }
}

function transportResult(value: unknown): MemoryV3TransportResult {
  const row = inspectExactRecord(value, ["content", "usage"], "extractor_transport_failed");
  if (typeof row.content !== "string") throw fail("extractor_transport_failed");
  return { content: row.content, usage: row.usage as MemoryV3TransportResult["usage"] };
}

function dialogueTransportResult(value: unknown): MemoryV3DialogueTransportResult {
  const row = inspectExactRecord(value, ["rawContent", "usage"], "reconciler_transport_failed");
  if (typeof row.rawContent !== "string") throw fail("reconciler_transport_failed");
  return { rawContent: row.rawContent, usage: row.usage as MemoryV3DialogueTransportResult["usage"] };
}

function stateExceedsLimits(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const itemsDescriptor = Object.getOwnPropertyDescriptor(value, "items");
  if (!itemsDescriptor || !("value" in itemsDescriptor) || !Array.isArray(itemsDescriptor.value)) return false;
  const items = itemsDescriptor.value;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(items, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return false;
  const itemCount = lengthDescriptor.value as number;
  if (itemCount > MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS) return true;
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
    if (evidenceCount > MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE) return true;
  }
  return false;
}

function failed(runId: string | null, diagnosticCode: MemoryV3DialogueShadowDiagnostic): MemoryV3DialogueShadowResult {
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
  diagnosticCode: MemoryV3DialogueShadowDiagnostic,
  transportDetail: string | null = null,
  reconcilerRawResponse: string | null = null,
  reconcilerContext: string | null = null,
): Promise<MemoryV3DialogueShadowResult> {
  try {
    await failStore({ runId, userId, diagnosticCode, transportDetail, reconcilerRawResponse, reconcilerContext } as never);
    return failed(runId, diagnosticCode);
  } catch {
    return failed(runId, "state_write_failed");
  }
}

// The terminal compareAndSwap write plus its result check, shared by the
// normal path and the empty-extraction fast path. Returns null on success,
// otherwise the already-persisted failure result.
async function persistCompareAndSwap(
  compareAndSwap: (input: never) => Promise<unknown>,
  failStore: (input: never) => Promise<unknown>,
  runId: string,
  userId: string,
  write: JsonRecord,
  resultingStateRevision: number,
): Promise<MemoryV3DialogueShadowResult | null> {
  let cas: unknown;
  try {
    cas = await compareAndSwap(write as never);
  } catch {
    return await persistFailure(failStore, runId, userId, "state_write_failed");
  }
  try {
    const status = Object.getOwnPropertyDescriptor(cas as object, "status")?.value;
    if (status === "state_conflict") {
      inspectExactRecord(cas, ["status"], "state_write_failed");
      return await persistFailure(failStore, runId, userId, "state_conflict");
    }
    const result = inspectExactRecord(cas, ["status", "resultingStateRevision"], "state_write_failed");
    if (result.status !== "succeeded" || result.resultingStateRevision !== resultingStateRevision) {
      throw fail("state_write_failed");
    }
  } catch (error) {
    const code = ownDiagnostic(error) ?? "state_write_failed";
    return await persistFailure(failStore, runId, userId, code);
  }
  return null;
}

export async function runMemoryV3DialogueShadow(
  options: MemoryV3DialogueShadowOptions,
  reportTransportDiagnostic?: (
    code: NonNullable<ReturnType<typeof projectSafeMemoryV3DialogueTransportDiagnostic>>,
  ) => void,
  logUsage?: MemoryV3LifecycleUsageLogger,
): Promise<MemoryV3DialogueShadowResult> {
  let projected: JsonRecord;
  try {
    projected = inspectOptions(options);
  } catch {
    return failed(null, "unknown_failure");
  }

  const userId = projected.userId;
  const conversationId = projected.conversationId;
  const apiKey = projected.apiKey;
  const reserve = ownMethod(projected.store, "reserve");
  const failStore = ownMethod(projected.store, "fail");
  const compareAndSwap = ownMethod(projected.store, "compareAndSwap");
  const lastSucceededCursor = ownMethod(projected.store, "lastSucceededCursor");
  if (typeof userId !== "string" || !UUID.test(userId) || typeof conversationId !== "string" || !UUID.test(conversationId) ||
      typeof apiKey !== "string" || apiKey.trim().length === 0 || typeof projected.loadMessages !== "function" ||
      typeof projected.extractorAdapterFactory !== "function" || typeof projected.reconcilerAdapterFactory !== "function" ||
      !reserve || !failStore || !compareAndSwap || !lastSucceededCursor) return failed(null, "invalid_source");

  // Delta windowing (spec 2026-10-13 §1, §3): only this conversation's last
  // *succeeded* run counts as already analyzed. A failed or malformed lookup
  // fails the run: falling back to the first-run window could move the cursor
  // past a backlog no run has read. Console-only fixed literal; the error
  // itself is never logged.
  let sinceCursor: MemoryV3SourceCursor | null;
  try {
    sinceCursor = projectSourceCursor(await lastSucceededCursor({ userId, conversationId } as never));
  } catch {
    console.error("[memory-v3-dialogue-cursor-lookup-failed]");
    return failed(null, "invalid_source");
  }

  // extractorRequest stays null for an empty delta (nothing new to read).
  // deltaMessageIds is what this run may cite as evidence: null on a first run
  // (any loaded message), otherwise exactly the delta it sends.
  // latestMessageId feeds the input identity in delta mode only.
  let dialogue: MemoryV3DialogueInput;
  let extractorRequest: ReturnType<typeof buildMemoryV3DialogueExtractorRequest> | null;
  let deltaMessageIds: ReadonlySet<string> | null = null;
  let latestMessageId: string | null = null;
  try {
    const caseId = `memory-v3-shadow:${userId}:${conversationId}`;
    const load = projected.loadMessages as MemoryV3DialogueShadowOptions["loadMessages"];
    if (sinceCursor === null) {
      const fitted = fitExtractorDialogueToByteCap(
        validateMemoryV3Dialogue({ caseId, messages: await load(userId, conversationId) }),
      );
      dialogue = fitted.dialogue;
      extractorRequest = fitted.request;
    } else {
      const loaded = inspectDeltaWindow(await load(userId, conversationId, sinceCursor), caseId);
      latestMessageId = loaded.latestMessageId;
      if (loaded.delta.length === 0) {
        dialogue = validateMemoryV3Dialogue({ caseId, messages: loaded.context });
        extractorRequest = null;
      } else {
        const fitted = fitDeltaWindowToByteCap(caseId, loaded.context, loaded.delta);
        dialogue = fitted.dialogue;
        extractorRequest = fitted.request;
      }
      deltaMessageIds = new Set(dialogue.messages.slice(loaded.context.length).map((message) => message.id));
    }
  } catch {
    return failed(null, "invalid_source");
  }

  let hash: string;
  try {
    hash = await inputHash(userId, conversationId, dialogue, latestMessageId);
  } catch {
    return failed(null, "unknown_failure");
  }
  const last = dialogue.messages.at(-1)!;

  let reservation: unknown;
  try {
    reservation = await reserve({
      userId, conversationId,
      pipelineVersion: MEMORY_V3_DIALOGUE_PIPELINE_VERSION,
      extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
      reconcilerVersion: MEMORY_V3_DIALOGUE_RECONCILER_VERSION,
      model: MEMORY_V3_DIALOGUE_MODEL,
      inputHash: hash,
      sourceLastMessageId: last.id,
      sourceLastCreatedAt: last.createdAt,
      messageCount: dialogue.messages.length,
      userMessageCount: dialogue.messages.filter((message) => message.role === "user").length,
    } as never);
  } catch (error) {
    // Developer-console-only. getMemoryV3DialogueReserveStage() reads a
    // closed-vocabulary, hardcoded-literal side channel dialogueStore.ts's
    // reserve() tags its own errors with -- never the error's message,
    // which this file's own "sanitizes reservation and state-write
    // failures" test caught an earlier version of this logging statement
    // leaking (dialogueStore.ts's validation failures are opaque by
    // design: always the same fixed message, so logging it would have
    // taught us nothing anyway).
    console.error(
      "[memory-v3-dialogue-reserve-raw]",
      getMemoryV3DialogueReserveStage(error) ?? (error instanceof Error ? error.name : typeof error),
    );
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
  let state: MemoryV3DialogueState;
  try {
    if (stateExceedsLimits(reserved.state)) throw fail("state_too_large");
    state = validateMemoryV3DialogueState(reserved.state, userId, conversationId);
    if (state.stateRevision !== reserved.expectedStateRevision || state.items.length > MEMORY_V3_DIALOGUE_MAX_STATE_ITEMS ||
        state.items.reduce((sum, item) => sum + item.evidence.length, 0) > MEMORY_V3_DIALOGUE_MAX_STATE_EVIDENCE) {
      throw fail("state_too_large");
    }
  } catch (error) {
    const code = ownDiagnostic(error) ?? "reservation_failed";
    return await persistFailure(failStore, runId, userId, code);
  }

  // Empty delta (spec 2026-10-13 §1): nothing was written after the cursor,
  // so the extractor is never called -- not even on the context block alone,
  // which a previous run already analyzed. Same succeeded no-op contract as an
  // empty extraction (§3), with no model usage at all.
  if (extractorRequest === null) {
    const noopFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
      runId, userId, conversationId, expectedStateRevision: reserved.expectedStateRevision,
      state, changed: false,
      extraction: {
        run: { caseId: dialogue.caseId, extractorVersion: MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION },
        items: [],
        evidence: [],
      },
      operations: [], transitions: [], extractorUsage: null, reconcilerUsage: null,
    }, state.stateRevision);
    if (noopFailure !== null) return noopFailure;
    return {
      status: "succeeded",
      runId,
      itemCount: 0,
      evidenceCount: 0,
      transitionCount: 0,
      stateRevision: state.stateRevision,
    };
  }

  let extractor: MemoryV3TransportResult;
  try {
    const adapter = (projected.extractorAdapterFactory as MemoryV3DialogueShadowOptions["extractorAdapterFactory"])(apiKey);
    if (typeof adapter !== "function") throw fail("extractor_transport_failed");
    extractor = transportResult(await adapter(extractorRequest));
  } catch (error) {
    const transportCode = projectSafeMemoryV3TransportDiagnostic(error);
    const code = ownDiagnostic(error) ?? "extractor_transport_failed";
    return await persistFailure(failStore, runId, userId, code, transportCode);
  }
  // Logged as soon as the response is in, regardless of whether the run
  // later succeeds -- the extractor call's cost is already spent either way.
  if (extractor.usage !== null) {
    await logUsageSafely(logUsage, {
      userId, conversationId, runId, stage: "extractor", model: MEMORY_V3_DIALOGUE_MODEL,
      promptTokens: extractor.usage.promptTokens,
      completionTokens: extractor.usage.completionTokens,
      costUsd: extractor.usage.costUsd,
      pipeline: "dialogue",
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
    extraction = await normalizeMemoryV3LayeredResponse(
      parsedExtraction,
      dialogue,
      MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
      "conversation",
    );
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  // Spec 2026-10-13 §1: the context block informs the extractor but is never
  // new evidence -- the run that produced the cursor already analyzed it.
  // Citing it is the same contract violation as citing an unknown message.
  const citable = deltaMessageIds;
  if (citable !== null && extraction.evidence.some((row) => !citable.has(row.sourceMessageId))) {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }
  if (extraction.items.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATES ||
      extraction.evidence.length > MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE) {
    return await persistFailure(failStore, runId, userId, "state_too_large");
  }

  // Empty-extraction fast path (spec 2026-10-13 §3): nothing to reconcile, so
  // the reconciler is never called -- but the run still finishes as a normal
  // succeeded no-op through compareAndSwap, because that succeeded row is
  // what the next run's delta cursor reads.
  if (extraction.items.length === 0) {
    const noopFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
      runId, userId, conversationId, expectedStateRevision: reserved.expectedStateRevision,
      state, changed: false, extraction, operations: [], transitions: [],
      extractorUsage: extractor.usage, reconcilerUsage: null,
    }, state.stateRevision);
    if (noopFailure !== null) return noopFailure;
    return {
      status: "succeeded",
      runId,
      itemCount: 0,
      evidenceCount: 0,
      transitionCount: 0,
      stateRevision: state.stateRevision,
    };
  }

  let bundle;
  try {
    bundle = buildMemoryV3DialogueReconcileRequest({ userId, conversationId, messages: dialogue.messages, state, extraction });
    if (new TextEncoder().encode(JSON.stringify(bundle.request)).byteLength > MEMORY_V3_DIALOGUE_MAX_RECONCILER_BYTES) {
      throw fail("reconciler_request_too_large");
    }
  } catch (error) {
    const code = ownDiagnostic(error) ?? "reconciler_contract_invalid";
    return await persistFailure(failStore, runId, userId, code);
  }

  let reconciler: MemoryV3DialogueTransportResult;
  try {
    const adapter = (projected.reconcilerAdapterFactory as MemoryV3DialogueShadowOptions["reconcilerAdapterFactory"])(apiKey);
    if (typeof adapter !== "function") throw fail("reconciler_transport_failed");
    reconciler = dialogueTransportResult(await adapter(bundle.request));
  } catch (error) {
    const transportDiagnostic = projectSafeMemoryV3DialogueTransportDiagnostic(error);
    if (transportDiagnostic !== null && typeof reportTransportDiagnostic === "function") {
      try {
        reportTransportDiagnostic(transportDiagnostic);
      } catch {
        // Safe diagnostics must never affect lifecycle persistence or the reply path.
      }
    }
    return await persistFailure(failStore, runId, userId, "reconciler_transport_failed", transportDiagnostic);
  }
  // Same as the extractor call above: logged now, independent of whether
  // the run later succeeds.
  if (reconciler.usage !== null) {
    await logUsageSafely(logUsage, {
      userId, conversationId, runId, stage: "reconciler", model: MEMORY_V3_DIALOGUE_MODEL,
      promptTokens: reconciler.usage.promptTokens,
      completionTokens: reconciler.usage.completionTokens,
      costUsd: reconciler.usage.costUsd,
      pipeline: "dialogue",
    });
  }

  // The exact inputs validateMemoryV3DialogueProposal() is about to
  // receive -- captured once, before anything can go wrong, so every
  // failure branch below can hand it to persistFailure() for a replayable
  // diagnostic (migration 071). Built defensively: a circular or
  // otherwise unserializable state/extraction must never block reporting
  // the failure it would have explained.
  const reconcilerContext = (() => {
    try {
      return JSON.stringify({ state, extraction, bindings: bundle.bindings }).slice(0, 20_000);
    } catch {
      return null;
    }
  })();

  let rawProposal: unknown;
  try {
    rawProposal = JSON.parse(reconciler.rawContent);
  } catch {
    return await persistFailure(failStore, runId, userId, "reconciler_parse_invalid", null, reconciler.rawContent, reconcilerContext);
  }
  let proposal;
  try {
    const proposalRoot = inspectExactRecord(rawProposal, ["operations"], "reconciler_shape_invalid");
    for (const operation of inspectDenseArray(
      proposalRoot.operations,
      MEMORY_V3_DIALOGUE_MAX_CANDIDATES,
      "reconciler_shape_invalid",
    )) {
      inspectExactRecord(
        operation,
        ["type", "candidateRef", "targetMemoryRef", "topic", "supersedesMemoryRef"],
        "reconciler_shape_invalid",
      );
    }
    proposal = validateMemoryV3DialogueProposal(rawProposal, { state, extraction, bindings: bundle.bindings });
  } catch (error) {
    const own = ownDiagnostic(error);
    if (own === "reconciler_shape_invalid") {
      return await persistFailure(failStore, runId, userId, own, null, reconciler.rawContent, reconcilerContext);
    }
    const diagnostic = projectSafeMemoryV3DialogueContractDiagnostic(error);
    const code = diagnostic === "dialogue_contract_invalid_shape"
      ? "reconciler_shape_invalid"
      : "reconciler_contract_invalid";
    return await persistFailure(failStore, runId, userId, code, null, reconciler.rawContent, reconcilerContext);
  }

  let reduced;
  try {
    reduced = await applyMemoryV3DialogueStep({
      state, at: last.createdAt, conversationId, extraction, proposal, trustedForgetMemoryKeys: [],
    });
  } catch {
    return await persistFailure(failStore, runId, userId, "reconciler_contract_invalid", null, reconciler.rawContent, reconcilerContext);
  }

  let resultingState: MemoryV3DialogueState;
  try {
    resultingState = validateMemoryV3DialogueState({
      ...reduced.state,
      stateRevision: (reserved.expectedStateRevision as number) + (reduced.changed ? 1 : 0),
    }, userId, conversationId);
  } catch {
    return await persistFailure(failStore, runId, userId, "reconciler_contract_invalid", null, reconciler.rawContent, reconcilerContext);
  }
  const casFailure = await persistCompareAndSwap(compareAndSwap, failStore, runId, userId, {
    runId, userId, conversationId, expectedStateRevision: reserved.expectedStateRevision,
    state: resultingState, changed: reduced.changed, extraction, operations: proposal,
    transitions: reduced.transitions, extractorUsage: extractor.usage, reconcilerUsage: reconciler.usage,
  }, resultingState.stateRevision);
  if (casFailure !== null) return casFailure;
  return {
    status: "succeeded",
    runId,
    itemCount: extraction.items.length,
    evidenceCount: extraction.evidence.length,
    transitionCount: reduced.transitions.length,
    stateRevision: resultingState.stateRevision,
  };
}

function inspectBackgroundResult(value: unknown): MemoryV3DialogueShadowResult | null {
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
          !DIAGNOSTICS.has(row.diagnosticCode as MemoryV3DialogueShadowDiagnostic)) return null;
      if (row.runId === null && row.diagnosticCode !== "invalid_source" &&
          row.diagnosticCode !== "reservation_failed" && row.diagnosticCode !== "unknown_failure") return null;
    } else if (status === "skipped") {
      if (row.reason !== "duplicate" && row.reason !== "daily_cap") return null;
    } else {
      if (typeof row.runId !== "string" || !UUID.test(row.runId) ||
          !Number.isSafeInteger(row.itemCount) || (row.itemCount as number) < 0 ||
          (row.itemCount as number) > MEMORY_V3_DIALOGUE_MAX_CANDIDATES ||
          !Number.isSafeInteger(row.evidenceCount) || (row.evidenceCount as number) < 0 ||
          (row.evidenceCount as number) > MEMORY_V3_DIALOGUE_MAX_CANDIDATE_EVIDENCE ||
          !Number.isSafeInteger(row.transitionCount) || (row.transitionCount as number) < 0 ||
          (row.transitionCount as number) > MEMORY_V3_DIALOGUE_MAX_CANDIDATES ||
          !Number.isSafeInteger(row.stateRevision) || (row.stateRevision as number) < 0) return null;
    }
    return row as unknown as MemoryV3DialogueShadowResult;
  } catch {
    return null;
  }
}

export async function runMemoryV3DialogueShadowBackgroundSafely(
  run: () => Promise<MemoryV3DialogueShadowResult>,
  logSafe: (code: MemoryV3DialogueShadowDiagnostic) => void,
): Promise<void> {
  let diagnostic: MemoryV3DialogueShadowDiagnostic | null = null;
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
