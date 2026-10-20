import {
  MEMORY_V3_MAX_PROMPT_BYTES,
  MEMORY_V3_MAX_SOURCE_MESSAGES,
  memoryV3ContractFailureReason,
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
import { dropMemoryV3ContextCitations, withMemoryV3EarlierContextNotice } from "./deltaContext.ts";
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
  MemoryV3DialogueUsage,
} from "./dialogueStore.ts";
import type { MemoryV3LifecycleUsageLogger } from "./lifecycleShadowRunner.ts";

export type MemoryV3DialogueShadowDiagnostic = MemoryV3DialogueStoredDiagnostic;

export type MemoryV3DialogueShadowResult =
  | { status: "skipped"; reason: "duplicate" | "daily_cap" }
  | {
      status: "succeeded"; runId: string; itemCount: number; evidenceCount: number;
      transitionCount: number; stateRevision: number;
      /** Present (true) only when this run gave up on a message that kept
       * failing (spec 2026-10-13, extended after review) instead of a
       * normal or empty-delta no-op; absent otherwise. */
      forcedSkip?: true;
    }
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
): { dialogue: MemoryV3DialogueInput; requests: ReturnType<typeof buildMemoryV3DialogueExtractorRequest>[] } {
  const cap = Math.min(MEMORY_V3_MAX_PROMPT_BYTES, MEMORY_V3_DIALOGUE_MAX_EXTRACTOR_BYTES);
  for (let start = 0; start < dialogue.messages.length; start += 1) {
    const messages = dialogue.messages.slice(start);
    if (!messages.some((message) => message.role === "user")) continue;
    const candidate = start === 0
      ? dialogue
      : validateMemoryV3Dialogue({ caseId: dialogue.caseId, messages });
    const request = buildMemoryV3DialogueExtractorRequest(candidate);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) {
      return { dialogue: candidate, requests: [request] };
    }
  }
  // Nothing fits: the newest message from the person is over the cap on its own (the system instruction
  // takes about 6 KB of the 20 KB, so a single Russian message of more than about 7,000 characters, and
  // the maximum is 10,000, does not fit). Never refuse it and never cut it: split its text into pieces
  // that each fit and read them one after another, like a later run does. Older messages are dropped, as
  // above. Only a message needing more than the piece ceiling is refused.
  let lastUser = -1;
  for (let index = dialogue.messages.length - 1; index >= 0; index -= 1) {
    if (dialogue.messages[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser >= 0) {
    const pieces = chunkOldestMessageForExtraction(dialogue.caseId, [], dialogue.messages[lastUser], cap);
    if (pieces !== null) {
      console.warn("[memory-v3-dialogue-first-run-message-chunked]");
      return {
        dialogue: validateMemoryV3Dialogue({ caseId: dialogue.caseId, messages: dialogue.messages.slice(lastUser) }),
        requests: pieces,
      };
    }
  }
  throw fail("invalid_source");
}

type FittedExtractorDialogue = {
  dialogue: MemoryV3DialogueInput;
  requests: ReturnType<typeof buildMemoryV3DialogueExtractorRequest>[];
};

// Safety ceiling on how many pieces a single oversized message is ever split
// into (spec 2026-10-13, extended after review): bounds the worst-case cost
// of one pathologically large paste to a handful of extractor calls. Chosen
// against real practice, not guessed -- messaging and chat products cap a
// single message at 4K-25K characters (Telegram 4,096; WhatsApp Web 10,000;
// ChatGPT/Claude.ai treat pastes over ~20-25K characters specially), so a
// message needing more than 5 chunks at this cap is already far outside any
// of those norms.
const MEMORY_V3_DIALOGUE_DELTA_MAX_MESSAGE_CHUNKS = 5;

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
  let smallest: { dialogue: MemoryV3DialogueInput; request: ReturnType<typeof buildMemoryV3DialogueExtractorRequest> } | null = null;
  for (let end = delta.length; end >= 1; end -= 1) {
    const messages = [...context, ...delta.slice(0, end)];
    if (!messages.some((message) => message.role === "user")) break;
    const dialogue = validateMemoryV3Dialogue({ caseId, messages });
    const request = withMemoryV3EarlierContextNotice(buildMemoryV3DialogueExtractorRequest(dialogue), context.length);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) return { dialogue, requests: [request] };
    smallest = { dialogue, request };
  }
  if (smallest === null) throw fail("invalid_source");
  // The oldest undrained message alone -- plus the context block -- still
  // exceeds the cap. Never drop it (the run must analyze something new) and
  // never silently lose part of it by truncating: a message this large is
  // still a real message a person wrote in full, and the extractor should
  // get to see every word of it eventually, just like Zep (a comparable
  // memory-extraction product) chunks oversized input rather than cutting
  // it. Split only its text into sequential pieces that each fit under cap
  // and run the extractor once per piece; `dialogue` below keeps the real,
  // whole, untruncated message for everything downstream (evidence
  // validation, the reconciler step) -- only the extractor's own per-call
  // input is ever split.
  const fullDialogue = validateMemoryV3Dialogue({ caseId, messages: [...context, delta[0]] });
  const chunks = chunkOldestMessageForExtraction(caseId, context, delta[0], cap);
  if (chunks !== null) {
    console.warn("[memory-v3-dialogue-delta-message-chunked]");
    return { dialogue: fullDialogue, requests: chunks };
  }
  console.warn("[memory-v3-dialogue-delta-over-byte-cap]");
  return { dialogue: smallest.dialogue, requests: [smallest.request] };
}

function chunkOldestMessageForExtraction(
  caseId: string,
  context: MemoryV3DialogueMessage[],
  oldest: MemoryV3DialogueMessage,
  cap: number,
): ReturnType<typeof buildMemoryV3DialogueExtractorRequest>[] | null {
  const requests: ReturnType<typeof buildMemoryV3DialogueExtractorRequest>[] = [];
  let start = 0;
  while (start < oldest.text.length) {
    if (requests.length >= MEMORY_V3_DIALOGUE_DELTA_MAX_MESSAGE_CHUNKS) return null;
    let low = start + 1;
    let high = oldest.text.length;
    let bestEnd = -1;
    let bestRequest: ReturnType<typeof buildMemoryV3DialogueExtractorRequest> | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      try {
        const dialogue = validateMemoryV3Dialogue({
          caseId,
          messages: [...context, { ...oldest, text: oldest.text.slice(start, mid) }],
        });
        const request = withMemoryV3EarlierContextNotice(buildMemoryV3DialogueExtractorRequest(dialogue), context.length);
        if (new TextEncoder().encode(JSON.stringify(request)).byteLength <= cap) {
          bestEnd = mid;
          bestRequest = request;
          low = mid + 1;
          continue;
        }
      } catch {
        // A slice can be blank after trimming (leading whitespace) even when
        // the full text is not; shrink further rather than treat it as fatal.
      }
      high = mid - 1;
    }
    if (bestEnd === -1 || bestRequest === null) return null; // context alone already over cap
    requests.push(bestRequest);
    start = bestEnd;
  }
  return requests;
}

// Merges one message's per-chunk extractions back into one (identity when
// there was only ever one chunk). Each piece of a long message is read on its
// own, so a fact mentioned in two pieces comes back twice. The same
// localItemKey is the same normalized content, so the later copy is simply
// dropped and its evidence kept once, instead of failing the whole run (an
// alert, and the message never analysed) for something a long text naturally
// does.
function mergeMemoryV3Extractions(parts: MemoryV3Extraction[]): MemoryV3Extraction {
  const keys = new Set<string>();
  const items = parts.flatMap((part) => part.items).filter((item) => {
    if (keys.has(item.localItemKey)) return false;
    keys.add(item.localItemKey);
    return true;
  });
  const seen = new Set<string>();
  const evidence = parts.flatMap((part) => part.evidence).filter((row) => {
    const identity = JSON.stringify([row.itemKey, row.sourceMessageId, row.relation]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return { run: parts[0].run, items, evidence };
}

function sumMemoryV3DialogueUsage(usages: Array<MemoryV3DialogueUsage | null>): MemoryV3DialogueUsage | null {
  const real = usages.filter((usage): usage is MemoryV3DialogueUsage => usage !== null);
  if (real.length === 0) return null;
  return {
    promptTokens: real.reduce((sum, usage) => sum + usage.promptTokens, 0),
    completionTokens: real.reduce((sum, usage) => sum + usage.completionTokens, 0),
    costUsd: real.reduce((sum, usage) => sum + usage.costUsd, 0),
  };
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
  name: "reserve" | "fail" | "compareAndSwap" | "lastSucceededCursor" | "recentConsecutiveFailureCount",
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

// After this many consecutive failed runs, stop retrying this conversation's
// stuck point and give up on just the one oldest undrained message instead
// (spec 2026-10-13, extended after review). The method is optional on the
// store: a store that doesn't implement it, or a lookup that throws, is
// treated as zero -- a missing safety net just means the run proceeds
// normally, never an extra reason to fail it.
const MEMORY_V3_DIALOGUE_DELTA_GIVE_UP_AFTER_FAILURES = 3;

async function hasExceededConsecutiveFailureLimit(
  store: unknown,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const check = ownMethod(store, "recentConsecutiveFailureCount");
  if (!check) return false;
  try {
    const count = await check({ userId, conversationId } as never);
    return typeof count === "number" && count >= MEMORY_V3_DIALOGUE_DELTA_GIVE_UP_AFTER_FAILURES;
  } catch {
    return false;
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
      // The database function that refused the write has already closed this run as
      // failed/state_conflict. Closing it again would be refused ("run is not open"), which
      // used to be reported as state_write_failed: an alert for a normal overlap of two runs,
      // and no automatic rerun (the rerun starts only on state_conflict).
      return failed(runId, "state_conflict");
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

  // extractorRequests stays null for an empty delta (nothing new to read).
  // It is almost always exactly one request; more than one only when a
  // single oversized message had to be chunked (spec 2026-10-13 §1, extended).
  // deltaMessageIds is what this run may cite as evidence: null on a first run
  // (any loaded message), otherwise exactly the delta it sends.
  // latestMessageId feeds the input identity in delta mode only.
  let dialogue: MemoryV3DialogueInput;
  let extractorRequests: ReturnType<typeof buildMemoryV3DialogueExtractorRequest>[] | null;
  let deltaMessageIds: ReadonlySet<string> | null = null;
  let latestMessageId: string | null = null;
  let forcedSkip = false;
  try {
    const caseId = `memory-v3-shadow:${userId}:${conversationId}`;
    const load = projected.loadMessages as MemoryV3DialogueShadowOptions["loadMessages"];
    if (sinceCursor === null) {
      const fitted = fitExtractorDialogueToByteCap(
        validateMemoryV3Dialogue({ caseId, messages: await load(userId, conversationId) }),
      );
      dialogue = fitted.dialogue;
      extractorRequests = fitted.requests;
    } else {
      const loaded = inspectDeltaWindow(await load(userId, conversationId, sinceCursor), caseId);
      latestMessageId = loaded.latestMessageId;
      if (loaded.delta.length === 0) {
        dialogue = validateMemoryV3Dialogue({ caseId, messages: loaded.context });
        extractorRequests = null;
      } else if (await hasExceededConsecutiveFailureLimit(projected.store, userId, conversationId)) {
        // Give up on just the single oldest undrained message: never stay
        // stuck on the same point forever. Everything after it in the
        // backlog is untouched and reaches the next run normally.
        console.warn("[memory-v3-dialogue-delta-forced-skip]");
        dialogue = validateMemoryV3Dialogue({ caseId, messages: [...loaded.context, loaded.delta[0]] });
        extractorRequests = null;
        forcedSkip = true;
      } else {
        const fitted = fitDeltaWindowToByteCap(caseId, loaded.context, loaded.delta);
        dialogue = fitted.dialogue;
        extractorRequests = fitted.requests;
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
  if (extractorRequests === null) {
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
      ...(forcedSkip ? { forcedSkip: true as const } : {}),
    };
  }

  // Almost always one iteration. More than one only when a single oversized
  // message was chunked: each chunk is its own extractor call, logged and
  // accounted separately, then merged into one extraction before the
  // existing single-extraction checks and the reconciler step run unchanged.
  const extractionParts: MemoryV3Extraction[] = [];
  const usageParts: Array<MemoryV3DialogueUsage | null> = [];
  for (const request of extractorRequests) {
    let extractor: MemoryV3TransportResult;
    try {
      const adapter = (projected.extractorAdapterFactory as MemoryV3DialogueShadowOptions["extractorAdapterFactory"])(apiKey);
      if (typeof adapter !== "function") throw fail("extractor_transport_failed");
      extractor = transportResult(await adapter(request));
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
    usageParts.push(extractor.usage);

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
    try {
      extractionParts.push(await normalizeMemoryV3LayeredResponse(
        parsedExtraction,
        dialogue,
        MEMORY_V3_DIALOGUE_EXTRACTOR_VERSION,
        "conversation",
        { dropUnsupportedItems: true },
      ));
    } catch (error) {
      // Which check failed, as a fixed word (never any text from the response).
      const reason = memoryV3ContractFailureReason(error);
      return await persistFailure(failStore, runId, userId, "extractor_contract_invalid", reason === null ? null : `contract:${reason}`);
    }
  }
  let extraction: MemoryV3Extraction;
  try {
    extraction = mergeMemoryV3Extractions(extractionParts);
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid", "contract:merge");
  }
  const extractorUsage = sumMemoryV3DialogueUsage(usageParts);
  // Spec 2026-10-13 §1: the context block informs the extractor but is never
  // new evidence -- the run that produced the cursor already analyzed it. An
  // item citing it is dropped, not a reason to fail the run: failing would
  // leave the cursor stuck on the same messages for the next attempt too.
  if (deltaMessageIds !== null) {
    const kept = dropMemoryV3ContextCitations(extraction, deltaMessageIds);
    if (kept !== extraction) {
      console.warn("[memory-v3-dialogue-context-citation-dropped]");
      extraction = kept;
    }
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
      extractorUsage, reconcilerUsage: null,
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
    transitions: reduced.transitions, extractorUsage, reconcilerUsage: reconciler.usage,
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
    const hasForcedSkip = status === "succeeded" && Object.getOwnPropertyDescriptor(value, "forcedSkip") !== undefined;
    const fields = status === "failed"
      ? ["status", "runId", "diagnosticCode"]
      : status === "skipped"
      ? ["status", "reason"]
      : status === "succeeded"
      ? (hasForcedSkip
          ? ["status", "runId", "itemCount", "evidenceCount", "transitionCount", "stateRevision", "forcedSkip"]
          : ["status", "runId", "itemCount", "evidenceCount", "transitionCount", "stateRevision"])
      : [];
    if (fields.length === 0) return null;
    const row = inspectExactRecord(value, fields, "unknown_failure");
    if (hasForcedSkip && row.forcedSkip !== true) return null;
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
  onForcedSkip?: () => void,
): Promise<void> {
  let diagnostic: MemoryV3DialogueShadowDiagnostic | null = null;
  let skipped = false;
  try {
    if (typeof run !== "function") throw fail("unknown_failure");
    const result = inspectBackgroundResult(await run());
    if (result?.status === "failed") diagnostic = result.diagnosticCode;
    else if (result === null) diagnostic = "unknown_failure";
    else if (result.status === "succeeded" && result.forcedSkip === true) skipped = true;
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
  if (skipped && typeof onForcedSkip === "function") {
    try {
      onForcedSkip();
    } catch {
      // Background shadow logging must never affect the reply path.
    }
  }
}
