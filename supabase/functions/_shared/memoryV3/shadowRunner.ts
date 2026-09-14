import {
  MEMORY_V3_EXTRACTOR_VERSION,
  MEMORY_V3_MAX_PROMPT_BYTES,
  MEMORY_V3_MODEL,
  normalizeMemoryV3LayeredResponse,
  validateMemoryV3Dialogue,
} from "./contract.ts";
import type { MemoryV3DialogueInput } from "./contract.ts";
import type { MemoryV3DialogueMessage } from "./messages.ts";
import { resolveMemoryV3ShadowEligibility } from "./mode.ts";
import { buildMemoryV3ExtractorRequest } from "./prompt.ts";
import type {
  MemoryV3ShadowStore,
  MemoryV3StoredDiagnostic,
} from "./shadowStore.ts";
import {
  projectSafeMemoryV3TransportDiagnostic,
  type MemoryV3ModelAdapter,
  type MemoryV3TransportResult,
} from "./transport.ts";

export type MemoryV3ShadowDiagnostic = MemoryV3StoredDiagnostic;

export type MemoryV3ShadowResult =
  | { status: "skipped"; reason: "disabled" | "user_not_allowlisted" | "duplicate" | "daily_cap" }
  | { status: "succeeded"; runId: string; itemCount: number; evidenceCount: number }
  | { status: "failed"; runId: string | null; diagnosticCode: MemoryV3ShadowDiagnostic };

interface MemoryV3ShadowOptions {
  rawMode: string | null | undefined;
  rawAllowedUserId: string | null | undefined;
  userId: string;
  conversationId: string;
  apiKey: string | null | undefined;
  loadMessages: (userId: string, conversationId: string) => Promise<MemoryV3DialogueMessage[]>;
  store: MemoryV3ShadowStore;
  modelAdapterFactory: (apiKey: string) => MemoryV3ModelAdapter;
}

const OPTION_FIELDS = new Set([
  "rawMode",
  "rawAllowedUserId",
  "userId",
  "conversationId",
  "apiKey",
  "loadMessages",
  "store",
  "modelAdapterFactory",
]);
const DIAGNOSTICS = new Set<MemoryV3ShadowDiagnostic>([
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
const OWN_ERRORS = new WeakSet<object>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(diagnosticCode: MemoryV3ShadowDiagnostic): Error {
  const error = new Error("[memory-v3:shadow-runner] operation failed");
  error.name = "MemoryV3ShadowError";
  Object.defineProperty(error, "diagnosticCode", {
    value: diagnosticCode,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  OWN_ERRORS.add(error);
  return error;
}

export function projectSafeMemoryV3ShadowDiagnostic(
  error: unknown,
): MemoryV3ShadowDiagnostic | null {
  try {
    if (typeof error !== "object" || error === null || !OWN_ERRORS.has(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "diagnosticCode");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
    return DIAGNOSTICS.has(descriptor.value as MemoryV3ShadowDiagnostic)
      ? descriptor.value as MemoryV3ShadowDiagnostic
      : null;
  } catch {
    return null;
  }
}

function inspectOptions(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("unknown_failure");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fail("unknown_failure");
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !OPTION_FIELDS.has(key)) throw fail("unknown_failure");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail("unknown_failure");
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (error) {
    if (projectSafeMemoryV3ShadowDiagnostic(error)) throw error;
    throw fail("unknown_failure");
  }
}

function ownFunction(value: unknown, name: string): ((...args: unknown[]) => unknown) | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && descriptor.enumerable && "value" in descriptor && typeof descriptor.value === "function"
      ? descriptor.value.bind(value)
      : null;
  } catch {
    return null;
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail("unknown_failure");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (typeof value !== "object") throw fail("unknown_failure");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
}

function nullRecord(entries: Array<[string, unknown]>): Record<string, unknown> {
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) record[key] = value;
  return record;
}

async function hashDialogue(
  userId: string,
  conversationId: string,
  dialogue: MemoryV3DialogueInput,
): Promise<string> {
  try {
    const payload = nullRecord([
      ["schemaVersion", "memory-v3-shadow-input-v1"],
      ["extractorVersion", MEMORY_V3_EXTRACTOR_VERSION],
      ["userId", userId],
      ["conversationId", conversationId],
      ["messages", dialogue.messages.map(({ id, role, text, createdAt }) => nullRecord([
        ["id", id],
        ["role", role],
        ["text", text],
        ["createdAt", createdAt],
      ]))],
    ]);
    const bytes = new TextEncoder().encode(canonicalStringify(payload));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw fail("unknown_failure");
  }
}

function inspectDenseJsonArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw fail("extractor_shape_invalid");
  const length = value.length;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw fail("extractor_shape_invalid");
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) throw fail("extractor_shape_invalid");
  }
  return value;
}

function inspectExactJsonRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("extractor_shape_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail("extractor_shape_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) throw fail("extractor_shape_invalid");
  const copy: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail("extractor_shape_invalid");
    copy[field] = descriptor.value;
  }
  if (keys.some((key) => typeof key !== "string" || !fields.includes(key))) throw fail("extractor_shape_invalid");
  return copy;
}

function parseAndInspectLayeredContent(content: unknown): unknown {
  if (typeof content !== "string") throw fail("provider_response_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw fail("extractor_parse_invalid");
  }
  try {
    const response = inspectExactJsonRecord(parsed, ["layerDecisions", "items", "evidence"]);
    for (const raw of inspectDenseJsonArray(response.layerDecisions)) {
      const row = inspectExactJsonRecord(raw, ["kind", "decision", "itemRefs"]);
      inspectDenseJsonArray(row.itemRefs);
    }
    for (const raw of inspectDenseJsonArray(response.items)) {
      inspectExactJsonRecord(raw, [
        "itemRef", "kind", "claim", "status", "sensitivity",
        "eventTimeStart", "eventTimeEnd", "alternative",
      ]);
    }
    for (const raw of inspectDenseJsonArray(response.evidence)) {
      inspectExactJsonRecord(raw, ["itemRef", "sourceMessageId", "relation", "supportType", "episodeKey"]);
    }
    return parsed;
  } catch (error) {
    if (projectSafeMemoryV3ShadowDiagnostic(error)) throw error;
    throw fail("extractor_shape_invalid");
  }
}

function inspectTransportResult(value: unknown): MemoryV3TransportResult {
  try {
    const record = inspectExactJsonRecord(value, ["content", "usage"]);
    if (typeof record.content !== "string") throw fail("provider_response_invalid");
    return { content: record.content, usage: record.usage as MemoryV3TransportResult["usage"] };
  } catch {
    throw fail("provider_response_invalid");
  }
}

function failed(runId: string | null, diagnosticCode: MemoryV3ShadowDiagnostic): MemoryV3ShadowResult {
  return { status: "failed", runId, diagnosticCode };
}

async function persistFailure(
  failStore: (...args: unknown[]) => unknown,
  runId: string,
  userId: string,
  diagnosticCode: MemoryV3ShadowDiagnostic,
): Promise<MemoryV3ShadowResult> {
  try {
    await failStore({ runId, userId, diagnosticCode });
    return failed(runId, diagnosticCode);
  } catch {
    return failed(runId, "completion_write_failed");
  }
}

export async function runMemoryV3Shadow(
  options: MemoryV3ShadowOptions,
): Promise<MemoryV3ShadowResult> {
  let projected: Record<string, unknown>;
  try {
    projected = inspectOptions(options);
  } catch {
    return failed(null, "unknown_failure");
  }

  let eligibility;
  try {
    eligibility = resolveMemoryV3ShadowEligibility({
      rawMode: projected.rawMode as string | null | undefined,
      rawAllowedUserId: projected.rawAllowedUserId as string | null | undefined,
      userId: projected.userId as string,
    });
  } catch {
    return failed(null, "unknown_failure");
  }
  if (!eligibility.eligible) {
    return {
      status: "skipped",
      reason: eligibility.reason === "disabled" ? "disabled" : "user_not_allowlisted",
    };
  }
  if (eligibility.mode !== "shadow") {
    return { status: "skipped", reason: "disabled" };
  }

  const userId = eligibility.userId;
  const conversationId = projected.conversationId;
  const apiKey = projected.apiKey;
  if (typeof conversationId !== "string" || !UUID.test(conversationId)) return failed(null, "invalid_source");
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return failed(null, "invalid_source");
  if (typeof projected.loadMessages !== "function" || typeof projected.modelAdapterFactory !== "function") {
    return failed(null, "invalid_source");
  }
  const reserve = ownFunction(projected.store, "reserve");
  const succeed = ownFunction(projected.store, "succeed");
  const failStore = ownFunction(projected.store, "fail");
  if (!reserve || !succeed || !failStore) return failed(null, "invalid_source");

  let dialogue: MemoryV3DialogueInput;
  let request;
  try {
    const source = await (projected.loadMessages as MemoryV3ShadowOptions["loadMessages"])(userId, conversationId);
    dialogue = validateMemoryV3Dialogue({
      caseId: `memory-v3-shadow:${userId}:${conversationId}`,
      messages: source,
    });
    request = buildMemoryV3ExtractorRequest(dialogue);
  } catch {
    return failed(null, "invalid_source");
  }
  let promptBytes: number;
  try {
    promptBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  } catch {
    return failed(null, "invalid_source");
  }
  if (promptBytes > MEMORY_V3_MAX_PROMPT_BYTES) return failed(null, "prompt_too_large");

  let inputHash: string;
  try {
    inputHash = await hashDialogue(userId, conversationId, dialogue);
  } catch {
    return failed(null, "unknown_failure");
  }
  const last = dialogue.messages[dialogue.messages.length - 1];
  let reservation: unknown;
  try {
    reservation = await reserve({
      userId,
      conversationId,
      extractorVersion: MEMORY_V3_EXTRACTOR_VERSION,
      model: MEMORY_V3_MODEL,
      inputHash,
      sourceLastMessageId: last.id,
      sourceLastCreatedAt: last.createdAt,
      messageCount: dialogue.messages.length,
      userMessageCount: dialogue.messages.filter((message) => message.role === "user").length,
    });
  } catch {
    return failed(null, "reservation_failed");
  }

  let reservationRecord: Record<string, unknown>;
  try {
    if (typeof reservation !== "object" || reservation === null || Array.isArray(reservation)) throw fail("reservation_failed");
    const statusDescriptor = Object.getOwnPropertyDescriptor(reservation, "status");
    if (!statusDescriptor || !statusDescriptor.enumerable || !("value" in statusDescriptor)) throw fail("reservation_failed");
    const status = statusDescriptor.value;
    const fields = status === "reserved" ? ["status", "runId"] : ["status"];
    reservationRecord = inspectExactJsonRecord(reservation, fields);
    if (status === "duplicate" || status === "daily_cap") return { status: "skipped", reason: status };
    if (status !== "reserved" || typeof reservationRecord.runId !== "string" || !UUID.test(reservationRecord.runId)) {
      throw fail("reservation_failed");
    }
  } catch {
    return failed(null, "reservation_failed");
  }
  const runId = reservationRecord.runId as string;

  let transport: MemoryV3TransportResult;
  try {
    const adapter = (projected.modelAdapterFactory as MemoryV3ShadowOptions["modelAdapterFactory"])(apiKey);
    if (typeof adapter !== "function") throw fail("transport_failed");
    transport = inspectTransportResult(await adapter(request));
  } catch (error) {
    const diagnostic = projectSafeMemoryV3ShadowDiagnostic(error) ??
      projectSafeMemoryV3TransportDiagnostic(error) as MemoryV3ShadowDiagnostic | null;
    return await persistFailure(failStore, runId, userId, diagnostic ?? "transport_failed");
  }

  let parsed: unknown;
  try {
    parsed = parseAndInspectLayeredContent(transport.content);
  } catch (error) {
    return await persistFailure(
      failStore,
      runId,
      userId,
      projectSafeMemoryV3ShadowDiagnostic(error) ?? "extractor_shape_invalid",
    );
  }

  let extraction;
  try {
    extraction = await normalizeMemoryV3LayeredResponse(parsed, dialogue, MEMORY_V3_EXTRACTOR_VERSION);
  } catch {
    return await persistFailure(failStore, runId, userId, "extractor_contract_invalid");
  }

  try {
    await succeed({
      runId,
      userId,
      extraction,
      itemCount: extraction.items.length,
      evidenceCount: extraction.evidence.length,
      usage: transport.usage,
    });
  } catch {
    return failed(runId, "completion_write_failed");
  }
  return {
    status: "succeeded",
    runId,
    itemCount: extraction.items.length,
    evidenceCount: extraction.evidence.length,
  };
}

function inspectBackgroundResult(value: unknown): MemoryV3ShadowResult | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
    if (!statusDescriptor || !statusDescriptor.enumerable || !("value" in statusDescriptor)) return null;
    const status = statusDescriptor.value;
    const fields = status === "failed"
      ? ["status", "runId", "diagnosticCode"]
      : status === "skipped"
      ? ["status", "reason"]
      : status === "succeeded"
      ? ["status", "runId", "itemCount", "evidenceCount"]
      : [];
    if (fields.length === 0) return null;
    const copy = inspectExactJsonRecord(value, fields);
    if (status === "failed" && (typeof copy.diagnosticCode !== "string" || !DIAGNOSTICS.has(copy.diagnosticCode as MemoryV3ShadowDiagnostic))) return null;
    return copy as unknown as MemoryV3ShadowResult;
  } catch {
    return null;
  }
}

export async function runMemoryV3ShadowBackgroundSafely(
  run: () => Promise<MemoryV3ShadowResult>,
  logSafe: (diagnosticCode: MemoryV3ShadowDiagnostic) => void,
): Promise<void> {
  let diagnostic: MemoryV3ShadowDiagnostic | null = null;
  try {
    if (typeof run !== "function") throw fail("unknown_failure");
    const result = inspectBackgroundResult(await run());
    if (result?.status === "failed") diagnostic = result.diagnosticCode;
    else if (result === null) diagnostic = "unknown_failure";
  } catch (error) {
    diagnostic = projectSafeMemoryV3ShadowDiagnostic(error) ?? "unknown_failure";
  }
  if (diagnostic !== null && typeof logSafe === "function") {
    try {
      logSafe(diagnostic);
    } catch {
      // Shadow logging must never reject the chat path.
    }
  }
}
