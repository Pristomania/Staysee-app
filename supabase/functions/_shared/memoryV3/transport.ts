import {
  MEMORY_V3_MAX_OUTPUT_TOKENS,
  MEMORY_V3_MODEL,
  MEMORY_V3_MAX_SOURCE_MESSAGES,
} from "./contract.ts";
import type { MemoryV3ExtractorRequest } from "./prompt.ts";

export interface MemoryV3TransportResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  } | null;
}

export type MemoryV3ModelAdapter = (
  request: MemoryV3ExtractorRequest,
) => Promise<MemoryV3TransportResult>;

export interface MemoryV3OpenRouterAdapterOptions {
  fetchImpl: typeof fetch;
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  setTimeoutImpl?: (handler: () => void, delayMs: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

type DiagnosticCode =
  | "transport_failed"
  | "transport_timeout"
  | "provider_http_4xx"
  | "provider_http_5xx"
  | "provider_response_invalid";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const OWN_ERRORS = new WeakSet<object>();
const DIAGNOSTICS = new Set<DiagnosticCode>([
  "transport_failed",
  "transport_timeout",
  "provider_http_4xx",
  "provider_http_5xx",
  "provider_response_invalid",
]);

function nullableStringSchema() {
  return { type: ["string", "null"] };
}

function objectSchema(required: readonly string[], properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: [...required], properties };
}

const ITEM_FIELDS = [
  "itemRef", "kind", "claim", "status", "sensitivity",
  "eventTimeStart", "eventTimeEnd", "alternative",
];
const EVIDENCE_FIELDS = [
  "itemRef", "sourceMessageId", "relation", "supportType", "episodeKey",
];

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

const RESPONSE_SCHEMA = deepFreeze({
  name: "memory_v3_v2_layered_extractor_response",
  strict: true,
  schema: objectSchema(["layerDecisions", "items", "evidence"], {
    layerDecisions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: objectSchema(["kind", "decision", "itemRefs"], {
        kind: { type: "string", enum: ["event", "recurrence", "hypothesis"] },
        decision: { type: "string", enum: ["emit", "omit"] },
        itemRefs: { type: "array", items: { type: "string" } },
      }),
    },
    items: {
      type: "array",
      items: objectSchema(ITEM_FIELDS, {
        itemRef: { type: "string" },
        kind: { type: "string" },
        claim: { type: "string" },
        status: { type: "string" },
        sensitivity: { type: "string" },
        eventTimeStart: nullableStringSchema(),
        eventTimeEnd: nullableStringSchema(),
        alternative: nullableStringSchema(),
      }),
    },
    evidence: {
      type: "array",
      items: objectSchema(EVIDENCE_FIELDS, {
        itemRef: { type: "string" },
        sourceMessageId: { type: "string" },
        relation: { type: "string" },
        supportType: nullableStringSchema(),
        episodeKey: nullableStringSchema(),
      }),
    },
  }),
});

function fail(message: string, diagnosticCode?: DiagnosticCode): Error {
  const error = new Error(`[memory-v3:transport] ${message}`);
  error.name = "MemoryV3TransportError";
  if (diagnosticCode && DIAGNOSTICS.has(diagnosticCode)) {
    Object.defineProperty(error, "diagnosticCode", {
      value: diagnosticCode,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  OWN_ERRORS.add(error);
  return error;
}

function isOwnError(error: unknown): error is Error {
  return typeof error === "object" && error !== null && OWN_ERRORS.has(error);
}

export function projectSafeMemoryV3TransportDiagnostic(error: unknown): string | null {
  if (!isOwnError(error)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "diagnosticCode");
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true ||
      descriptor.writable !== false || descriptor.configurable !== false ||
      !DIAGNOSTICS.has(descriptor.value)) return null;
    return descriptor.value;
  } catch {
    return null;
  }
}

function inspectRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw fail("invalid shape");
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail("invalid shape");
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) throw fail("invalid shape");
  const allowed = new Set([...required, ...optional]);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) throw fail("invalid shape");
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { throw fail("invalid shape"); }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) throw fail("invalid shape");
    copy[key] = descriptor.value;
  }
  for (const key of required) if (!Object.hasOwn(copy, key)) throw fail("invalid shape");
  return copy;
}

function inspectProjection(
  value: unknown,
  required: readonly string[],
  picked: readonly string[],
  forbidden: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw fail("provider response is invalid", "provider_response_invalid");
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw fail("provider response is invalid", "provider_response_invalid");
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) throw fail("provider response is invalid", "provider_response_invalid");
  const wanted = new Set([...required, ...picked]);
  const blocked = new Set(forbidden);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") throw fail("provider response is invalid", "provider_response_invalid");
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { throw fail("provider response is invalid", "provider_response_invalid"); }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail("provider response is invalid", "provider_response_invalid");
    if (blocked.has(key)) throw fail("provider response is invalid", "provider_response_invalid");
    if (wanted.has(key)) copy[key] = descriptor.value;
  }
  for (const key of required) if (!Object.hasOwn(copy, key) || copy[key] === undefined) throw fail("provider response is invalid", "provider_response_invalid");
  return copy;
}

function inspectDenseArray(value: unknown): unknown[] {
  let isArray: boolean;
  let lengthDescriptor: PropertyDescriptor | undefined;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, "length") : undefined;
    keys = isArray ? Reflect.ownKeys(value) : [];
  } catch { throw fail("provider response is invalid", "provider_response_invalid"); }
  if (!isArray || !lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw fail("provider response is invalid", "provider_response_invalid");
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) throw fail("provider response is invalid", "provider_response_invalid");
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { throw fail("provider response is invalid", "provider_response_invalid"); }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw fail("provider response is invalid", "provider_response_invalid");
    copy.push(descriptor.value);
  }
  if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw fail("provider response is invalid", "provider_response_invalid");
  return copy;
}

function projectRequest(request: unknown): MemoryV3ExtractorRequest {
  const outer = inspectRecord(request, ["system", "input"]);
  if (typeof outer.system !== "string" || outer.system.trim().length === 0) throw fail("invalid request");
  const input = inspectRecord(outer.input, ["caseId", "messages"]);
  if (typeof input.caseId !== "string" || input.caseId.trim().length === 0) throw fail("invalid request");
  const rawMessages = inspectDenseRequestArray(input.messages);
  if (rawMessages.length === 0 || rawMessages.length > MEMORY_V3_MAX_SOURCE_MESSAGES) throw fail("invalid request");
  const messages = rawMessages.map((raw) => {
    const message = inspectRecord(raw, ["id", "role", "text", "createdAt"]);
    if (typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.text !== "string" || typeof message.createdAt !== "string") throw fail("invalid request");
    return { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt };
  });
  return { system: outer.system, input: { caseId: input.caseId, messages } };
}

function inspectDenseRequestArray(value: unknown): unknown[] {
  let isArray: boolean;
  let descriptor: PropertyDescriptor | undefined;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    descriptor = isArray ? Object.getOwnPropertyDescriptor(value, "length") : undefined;
    keys = isArray ? Reflect.ownKeys(value) : [];
  } catch { throw fail("invalid request"); }
  if (!isArray || !descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) throw fail("invalid request");
  const length = descriptor.value as number;
  if (keys.length !== length + 1) throw fail("invalid request");
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let item: PropertyDescriptor | undefined;
    try { item = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { throw fail("invalid request"); }
    if (!item || !item.enumerable || !("value" in item)) throw fail("invalid request");
    copy.push(item.value);
  }
  return copy;
}

function responseParts(value: unknown): { status: number; text: () => Promise<string> } {
  let isResponse: boolean;
  let status: number;
  let text: () => Promise<string>;
  try {
    isResponse = value instanceof Response;
    if (!isResponse) throw new TypeError();
    status = value.status;
    text = value.text.bind(value);
  } catch {
    throw fail("provider response is invalid", "provider_response_invalid");
  }
  if (!Number.isInteger(status)) throw fail("provider response is invalid", "provider_response_invalid");
  return { status, text };
}

function projectUsage(value: unknown): MemoryV3TransportResult["usage"] {
  if (value === undefined || value === null) return null;
  try {
    const usage = inspectProjection(value, [], ["prompt_tokens", "completion_tokens", "cost"]);
    if (!Number.isSafeInteger(usage.prompt_tokens) || (usage.prompt_tokens as number) < 0 ||
      !Number.isSafeInteger(usage.completion_tokens) || (usage.completion_tokens as number) < 0 ||
      typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) return null;
    return {
      promptTokens: usage.prompt_tokens as number,
      completionTokens: usage.completion_tokens as number,
      costUsd: usage.cost,
    };
  } catch {
    return null;
  }
}

function projectProviderBody(value: unknown): MemoryV3TransportResult {
  const body = inspectProjection(value, ["choices"], ["usage"], ["error"]);
  const choices = inspectDenseArray(body.choices);
  if (choices.length !== 1) throw fail("provider response is invalid", "provider_response_invalid");
  const choice = inspectProjection(choices[0], ["message", "finish_reason"], [], ["error"]);
  if (choice.finish_reason !== "stop") throw fail("provider response is invalid", "provider_response_invalid");
  const message = inspectProjection(choice.message, ["content"], ["role", "refusal"], ["error", "tool_calls", "function_call"]);
  if (message.role !== undefined && message.role !== "assistant") throw fail("provider response is invalid", "provider_response_invalid");
  if (message.refusal !== undefined && message.refusal !== null) throw fail("provider response is invalid", "provider_response_invalid");
  if (typeof message.content !== "string" || message.content.trim().length === 0) throw fail("provider response is invalid", "provider_response_invalid");
  return { content: message.content, usage: projectUsage(body.usage) };
}

export function createMemoryV3OpenRouterAdapter(
  options: MemoryV3OpenRouterAdapterOptions,
): MemoryV3ModelAdapter {
  const inspected = inspectRecord(
    options,
    ["fetchImpl", "apiKey"],
    ["timeoutMs", "maxResponseBytes", "setTimeoutImpl", "clearTimeoutImpl"],
  );
  if (typeof inspected.fetchImpl !== "function" ||
    typeof inspected.apiKey !== "string" || inspected.apiKey.trim().length === 0) throw fail("invalid configuration");
  const timeoutMs = inspected.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = inspected.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) || (maxResponseBytes as number) <= 0) throw fail("invalid configuration");
  const hasSet = inspected.setTimeoutImpl !== undefined;
  const hasClear = inspected.clearTimeoutImpl !== undefined;
  if (hasSet !== hasClear || (hasSet && (typeof inspected.setTimeoutImpl !== "function" || typeof inspected.clearTimeoutImpl !== "function"))) throw fail("invalid configuration");

  const fetchImpl = inspected.fetchImpl as typeof fetch;
  const apiKey = inspected.apiKey;
  const setTimer = (inspected.setTimeoutImpl as MemoryV3OpenRouterAdapterOptions["setTimeoutImpl"] | undefined) ??
    ((handler, delay) => globalThis.setTimeout(handler, delay));
  const clearTimer = (inspected.clearTimeoutImpl as MemoryV3OpenRouterAdapterOptions["clearTimeoutImpl"] | undefined) ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  return async (unsafeRequest: MemoryV3ExtractorRequest): Promise<MemoryV3TransportResult> => {
    const request = projectRequest(unsafeRequest);
    const controller = new AbortController();
    let rejectTimeout!: (reason: Error) => void;
    let timedOut = false;
    let completed = false;
    let timeoutError: Error | null = null;
    let timeoutRaceActive = false;
    let phase: "fetch" | "response" = "fetch";
    const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    let timerHandle: unknown;
    let timerInstalled = false;
    try {
      try {
        timerHandle = setTimer!(() => {
          if (timedOut || completed) return;
          timedOut = true;
          timeoutError = fail("request timed out", "transport_timeout");
          if (timeoutRaceActive) rejectTimeout(timeoutError);
          controller.abort();
        }, timeoutMs as number);
      } catch {
        throw fail("request failed", "transport_failed");
      }
      timerInstalled = true;
      if (timedOut) throw timeoutError!;
      timeoutRaceActive = true;

      const body = {
        model: MEMORY_V3_MODEL,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: JSON.stringify(request.input) },
        ],
        stream: false,
        response_format: { type: "json_schema", json_schema: structuredClone(RESPONSE_SCHEMA) },
        provider: {
          allow_fallbacks: true,
          require_parameters: true,
          data_collection: "deny",
          zdr: true,
        },
        max_tokens: MEMORY_V3_MAX_OUTPUT_TOKENS,
        reasoning: { effort: "low" },
      };
      let responseValue: Response;
      try {
        let fetchPromise: Promise<Response>;
        try {
          fetchPromise = Promise.resolve(fetchImpl(OPENROUTER_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          }));
        } catch {
          throw fail("request failed", "transport_failed");
        }
        responseValue = await Promise.race([fetchPromise, timeoutPromise]);
      } catch (error) {
        if (error === timeoutError) throw error;
        throw fail("request failed", "transport_failed");
      }
      phase = "response";
      const response = responseParts(responseValue);
      if (response.status < 200 || response.status > 299) {
        const diagnostic = response.status >= 400 && response.status <= 499
          ? "provider_http_4xx"
          : response.status >= 500 && response.status <= 599
            ? "provider_http_5xx"
            : "provider_response_invalid";
        throw fail("provider request failed", diagnostic);
      }
      let text: string;
      try {
        let textPromise: Promise<string>;
        try { textPromise = Promise.resolve(response.text()); }
        catch { throw fail("provider response is invalid", "provider_response_invalid"); }
        text = await Promise.race([textPromise, timeoutPromise]);
      } catch (error) {
        if (error === timeoutError) throw error;
        throw fail("provider response is invalid", "provider_response_invalid");
      }
      if (new TextEncoder().encode(text).byteLength > (maxResponseBytes as number)) throw fail("provider response is invalid", "provider_response_invalid");
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw fail("provider response is invalid", "provider_response_invalid"); }
      return projectProviderBody(parsed);
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw phase === "fetch"
        ? fail("request failed", "transport_failed")
        : fail("provider response is invalid", "provider_response_invalid");
    } finally {
      completed = true;
      if (timerInstalled) {
        try { clearTimer!(timerHandle); } catch { /* cleanup must not expose timer errors */ }
      }
    }
  };
}
