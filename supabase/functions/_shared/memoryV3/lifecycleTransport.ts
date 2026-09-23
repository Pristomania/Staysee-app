import { MEMORY_V3_MAX_SOURCE_MESSAGES } from "./contract.ts";
import {
  MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION,
  type MemoryV3LifecycleReconcileRequest,
} from "./lifecyclePrompt.ts";

export interface MemoryV3LifecycleTransportResult {
  rawContent: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  } | null;
}

export type MemoryV3LifecycleModelAdapter = (
  request: MemoryV3LifecycleReconcileRequest,
) => Promise<MemoryV3LifecycleTransportResult>;

export interface MemoryV3LifecycleOpenRouterAdapterOptions {
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type DiagnosticCode =
  | "transport_failed"
  | "transport_timeout"
  | "provider_http_400"
  | "provider_http_429"
  | "provider_http_4xx"
  | "provider_http_5xx"
  | "provider_response_invalid";

type JsonRecord = Record<string, unknown>;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-3.7-flash";
const MAX_COMPLETION_TOKENS = 1_200;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ITEMS = 100;
const MAX_EVIDENCE = 500;
const OWN_ERRORS = new WeakSet<object>();
const ERROR_TOKENS = new WeakMap<object, object>();
const DIAGNOSTICS = new Set<DiagnosticCode>([
  "transport_failed",
  "transport_timeout",
  "provider_http_400",
  "provider_http_429",
  "provider_http_4xx",
  "provider_http_5xx",
  "provider_response_invalid",
]);

const ITEM_FIELDS = [
  "memoryRef", "kind", "claim", "status", "sensitivity", "eventTimeStart",
  "eventTimeEnd", "alternative", "revision", "evidence",
] as const;
const CANDIDATE_FIELDS = [
  "candidateRef", "kind", "claim", "status", "sensitivity", "eventTimeStart",
  "eventTimeEnd", "alternative", "evidence",
] as const;
const EVIDENCE_FIELDS = [
  "sourceMessageId", "relation", "supportType", "episodeKey", "mentionTime",
] as const;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as JsonRecord)) deepFreeze(nested);
  return Object.freeze(value);
}

const LIFECYCLE_RESPONSE_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "candidateRef", "targetMemoryRef", "topic"],
        properties: {
          type: {
            type: "string",
            enum: ["create", "confirm", "revise", "mark_stale", "reject", "ignore"],
          },
          candidateRef: { type: "string" },
          targetMemoryRef: { type: ["string", "null"] },
          topic: { type: ["string", "null"], enum: ["life_context", "communication", "preference", null] },
        },
      },
    },
  },
});

function makeError(token: object, message: string, diagnosticCode?: DiagnosticCode): Error {
  const error = new Error(`[memory-v3:lifecycle-transport] ${message}`);
  error.name = "MemoryV3LifecycleTransportError";
  if (diagnosticCode && DIAGNOSTICS.has(diagnosticCode)) {
    Object.defineProperty(error, "diagnosticCode", {
      value: diagnosticCode,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  OWN_ERRORS.add(error);
  ERROR_TOKENS.set(error, token);
  return error;
}

function fail(token: object, message: string, diagnosticCode?: DiagnosticCode): never {
  throw makeError(token, message, diagnosticCode);
}

function isOwnError(error: unknown, token?: object): error is Error {
  if (typeof error !== "object" || error === null || !OWN_ERRORS.has(error)) return false;
  return token === undefined || ERROR_TOKENS.get(error) === token;
}

export function projectSafeMemoryV3LifecycleTransportDiagnostic(error: unknown): DiagnosticCode | null {
  if (!isOwnError(error)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "diagnosticCode");
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true ||
      descriptor.writable !== false || descriptor.configurable !== false ||
      !DIAGNOSTICS.has(descriptor.value)) return null;
    return descriptor.value as DiagnosticCode;
  } catch {
    return null;
  }
}

function inspectRecord(
  token: object,
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  response = false,
): JsonRecord {
  const invalid = () => fail(
    token,
    response ? "provider response is invalid" : "invalid input",
    response ? "provider_response_invalid" : undefined,
  );
  if (typeof value !== "object" || value === null) return invalid();
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid();
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) return invalid();
  const allowed = new Set([...required, ...optional]);
  const copy: JsonRecord = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) return invalid();
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return invalid(); }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) return invalid();
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const key of required) if (!Object.hasOwn(copy, key)) return invalid();
  return copy;
}

function inspectProjection(
  token: object,
  value: unknown,
  required: readonly string[],
  picked: readonly string[],
  forbidden: readonly string[] = [],
): JsonRecord {
  if (typeof value !== "object" || value === null) {
    return fail(token, "provider response is invalid", "provider_response_invalid");
  }
  let isArray: boolean;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(token, "provider response is invalid", "provider_response_invalid");
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    return fail(token, "provider response is invalid", "provider_response_invalid");
  }
  const wanted = new Set([...required, ...picked]);
  const blocked = new Set(forbidden);
  const copy: JsonRecord = {};
  for (const key of keys) {
    if (typeof key !== "string") fail(token, "provider response is invalid", "provider_response_invalid");
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      return fail(token, "provider response is invalid", "provider_response_invalid");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || blocked.has(key)) {
      fail(token, "provider response is invalid", "provider_response_invalid");
    }
    if (wanted.has(key)) {
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(copy, key) || copy[key] === undefined) {
      fail(token, "provider response is invalid", "provider_response_invalid");
    }
  }
  return copy;
}

function inspectDenseArray(token: object, value: unknown, response = false): unknown[] {
  const invalid = () => fail(
    token,
    response ? "provider response is invalid" : "invalid input",
    response ? "provider_response_invalid" : undefined,
  );
  let isArray: boolean;
  let lengthDescriptor: PropertyDescriptor | undefined;
  let keys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value as object, "length") : undefined;
    keys = isArray ? Reflect.ownKeys(value as object) : [];
  } catch {
    return invalid();
  }
  if (!isArray || !lengthDescriptor || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return invalid();
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) return invalid();
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value as object, String(index)); } catch { return invalid(); }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) return invalid();
    copy.push(descriptor.value);
  }
  if (keys.some((key) => key !== "length" &&
    (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) return invalid();
  return copy;
}

function requireString(token: object, value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") fail(token, "invalid input");
  return value;
}

function projectEvidence(token: object, value: unknown): JsonRecord {
  const row = inspectRecord(token, value, EVIDENCE_FIELDS);
  return {
    sourceMessageId: requireString(token, row.sourceMessageId),
    relation: requireString(token, row.relation),
    supportType: requireString(token, row.supportType, true),
    episodeKey: requireString(token, row.episodeKey, true),
    mentionTime: requireString(token, row.mentionTime),
  };
}

function projectItem(token: object, value: unknown, candidate: boolean): JsonRecord {
  const fields = candidate ? CANDIDATE_FIELDS : ITEM_FIELDS;
  const item = inspectRecord(token, value, fields);
  const evidence = inspectDenseArray(token, item.evidence);
  if (evidence.length > MAX_EVIDENCE) fail(token, "invalid input");
  const projected: JsonRecord = {
    [candidate ? "candidateRef" : "memoryRef"]: requireString(
      token,
      item[candidate ? "candidateRef" : "memoryRef"],
    ),
    kind: requireString(token, item.kind),
    claim: requireString(token, item.claim),
    status: requireString(token, item.status),
    sensitivity: requireString(token, item.sensitivity),
    eventTimeStart: requireString(token, item.eventTimeStart, true),
    eventTimeEnd: requireString(token, item.eventTimeEnd, true),
    alternative: requireString(token, item.alternative, true),
    evidence: evidence.map((row) => projectEvidence(token, row)),
  };
  if (!candidate) {
    if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) fail(token, "invalid input");
    projected.revision = item.revision;
  }
  return projected;
}

function projectRequest(token: object, unsafeRequest: unknown): MemoryV3LifecycleReconcileRequest {
  const outer = inspectRecord(token, unsafeRequest, ["system", "input"]);
  if (outer.system !== MEMORY_V3_LIFECYCLE_SYSTEM_INSTRUCTION) fail(token, "invalid input");
  const input = inspectRecord(token, outer.input, [
    "schemaVersion", "userLanguage", "session", "messages", "currentItems", "candidates",
  ]);
  if (input.schemaVersion !== "memory-v3-lifecycle-reconcile-request-v1" || input.userLanguage !== "ru") {
    fail(token, "invalid input");
  }
  const session = inspectRecord(token, input.session, [
    "conversationId", "sourceLastMessageId", "sourceLastCreatedAt",
  ]);
  const messages = inspectDenseArray(token, input.messages);
  const currentItems = inspectDenseArray(token, input.currentItems);
  const candidates = inspectDenseArray(token, input.candidates);
  if (messages.length === 0 || messages.length > MEMORY_V3_MAX_SOURCE_MESSAGES ||
    currentItems.length > MAX_ITEMS || candidates.length > MAX_ITEMS) fail(token, "invalid input");
  const projectedMessages = messages.map((value) => {
    const message = inspectRecord(token, value, ["id", "role", "text", "createdAt"]);
    if (message.role !== "user" && message.role !== "assistant") fail(token, "invalid input");
    return {
      id: requireString(token, message.id),
      role: message.role,
      text: requireString(token, message.text),
      createdAt: requireString(token, message.createdAt),
    };
  });
  const projectedCurrentItems = currentItems.map((value) => projectItem(token, value, false));
  const projectedCandidates = candidates.map((value) => projectItem(token, value, true));
  const currentEvidenceCount = projectedCurrentItems.reduce(
    (total, item) => total + (item.evidence as unknown[]).length,
    0,
  );
  const candidateEvidenceCount = projectedCandidates.reduce(
    (total, item) => total + (item.evidence as unknown[]).length,
    0,
  );
  if (currentEvidenceCount > MAX_EVIDENCE || candidateEvidenceCount > MAX_EVIDENCE) {
    fail(token, "invalid input");
  }
  return {
    system: outer.system,
    input: {
      schemaVersion: "memory-v3-lifecycle-reconcile-request-v1",
      userLanguage: "ru",
      session: {
        conversationId: requireString(token, session.conversationId),
        sourceLastMessageId: requireString(token, session.sourceLastMessageId),
        sourceLastCreatedAt: requireString(token, session.sourceLastCreatedAt),
      },
      messages: projectedMessages,
      currentItems: projectedCurrentItems as never,
      candidates: projectedCandidates as never,
    },
  };
}

function responseParts(token: object, value: unknown): { status: number; text: () => Promise<string> } {
  let isResponse: boolean;
  let status: number;
  try {
    isResponse = value instanceof Response;
    if (!isResponse) fail(token, "provider response is invalid", "provider_response_invalid");
    const statusGetter = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
    if (typeof statusGetter !== "function") fail(token, "provider response is invalid", "provider_response_invalid");
    status = statusGetter.call(value);
  } catch (error) {
    if (isOwnError(error, token)) throw error;
    return fail(token, "provider response is invalid", "provider_response_invalid");
  }
  if (!Number.isInteger(status)) fail(token, "provider response is invalid", "provider_response_invalid");
  return {
    status,
    text: () => Response.prototype.text.call(value as Response),
  };
}

function projectUsage(token: object, value: unknown): MemoryV3LifecycleTransportResult["usage"] {
  if (value === undefined || value === null) return null;
  try {
    const usage = inspectProjection(token, value, [], ["prompt_tokens", "completion_tokens", "cost"]);
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

function projectProviderBody(token: object, value: unknown): MemoryV3LifecycleTransportResult {
  const body = inspectProjection(token, value, ["choices"], ["usage"], ["error"]);
  const choices = inspectDenseArray(token, body.choices, true);
  if (choices.length !== 1) fail(token, "provider response is invalid", "provider_response_invalid");
  const choice = inspectProjection(token, choices[0], ["message", "finish_reason"], [], ["error"]);
  if (choice.finish_reason !== "stop") fail(token, "provider response is invalid", "provider_response_invalid");
  const message = inspectProjection(
    token,
    choice.message,
    ["role", "content"],
    ["refusal"],
    ["error", "tool_calls", "function_call"],
  );
  if (message.role !== "assistant") {
    fail(token, "provider response is invalid", "provider_response_invalid");
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    fail(token, "provider response is invalid", "provider_response_invalid");
  }
  if (typeof message.content !== "string" || message.content.trim().length === 0) {
    fail(token, "provider response is invalid", "provider_response_invalid");
  }
  return { rawContent: message.content, usage: projectUsage(token, body.usage) };
}

export function createMemoryV3LifecycleOpenRouterAdapter(
  options: MemoryV3LifecycleOpenRouterAdapterOptions,
): MemoryV3LifecycleModelAdapter {
  const configToken = {};
  const inspected = inspectRecord(
    configToken,
    options,
    ["apiKey", "fetchImpl"],
    ["timeoutMs", "maxResponseBytes"],
  );
  if (typeof inspected.apiKey !== "string" || inspected.apiKey.trim().length === 0 ||
    typeof inspected.fetchImpl !== "function") fail(configToken, "invalid configuration");
  const timeoutMs = inspected.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = inspected.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) || (maxResponseBytes as number) <= 0) {
    fail(configToken, "invalid configuration");
  }

  const apiKey = inspected.apiKey;
  const fetchImpl = inspected.fetchImpl as typeof fetch;
  const setTimer = globalThis.setTimeout.bind(globalThis);
  const clearTimer = globalThis.clearTimeout.bind(globalThis);

  return async (unsafeRequest: MemoryV3LifecycleReconcileRequest) => {
    const token = {};
    try {
      const request = projectRequest(token, unsafeRequest);
      const controller = new AbortController();
      let timedOut = false;
      let completed = false;
      let timeoutRaceActive = false;
      let timeoutError: Error | null = null;
      let rejectTimeout!: (reason: Error) => void;
      const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      let timerInstalled = false;
      let phase: "fetch" | "response" = "fetch";
      try {
        try {
          timerHandle = setTimer(() => {
            if (timedOut || completed) return;
            timedOut = true;
            timeoutError = makeError(token, "request timed out", "transport_timeout");
            if (timeoutRaceActive) rejectTimeout(timeoutError);
            controller.abort();
          }, timeoutMs as number);
        } catch {
          fail(token, "request failed", "transport_failed");
        }
        timerInstalled = true;
        if (timedOut) throw timeoutError!;
        timeoutRaceActive = true;

        const body = {
          model: MODEL,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: JSON.stringify(request.input) },
          ],
          stream: false,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "memory_v3_lifecycle_reconcile_response",
              strict: true,
              schema: structuredClone(LIFECYCLE_RESPONSE_SCHEMA),
            },
          },
          reasoning: { effort: "low" },
          provider: {
            allow_fallbacks: true,
            require_parameters: true,
            data_collection: "deny",
            zdr: true,
          },
          max_tokens: MAX_COMPLETION_TOKENS,
          // Without this, OpenRouter omits usage.cost and projectUsage() below
          // always returns null -- no per-account spend tracking is possible.
          usage: { include: true },
        };

        let responseValue: Response;
        try {
          let fetchPromise: Promise<Response>;
          try {
            fetchPromise = Promise.resolve(fetchImpl(OPENROUTER_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            }));
          } catch {
            fail(token, "request failed", "transport_failed");
          }
          responseValue = await Promise.race([fetchPromise, timeoutPromise]);
        } catch (error) {
          if (error === timeoutError) throw error;
          fail(token, "request failed", "transport_failed");
        }

        phase = "response";
        const response = responseParts(token, responseValue);
        if (response.status < 200 || response.status > 299) {
          const diagnostic = response.status === 400
            ? "provider_http_400"
            : response.status === 429
              ? "provider_http_429"
              : response.status >= 400 && response.status <= 499
                ? "provider_http_4xx"
            : response.status >= 500 && response.status <= 599
              ? "provider_http_5xx"
              : "provider_response_invalid";
          fail(token, "provider request failed", diagnostic);
        }

        let text: string;
        try {
          let textPromise: Promise<string>;
          try { textPromise = Promise.resolve(response.text()); } catch {
            fail(token, "provider response is invalid", "provider_response_invalid");
          }
          text = await Promise.race([textPromise, timeoutPromise]);
        } catch (error) {
          if (error === timeoutError) throw error;
          fail(token, "provider response is invalid", "provider_response_invalid");
        }
        if (new TextEncoder().encode(text).byteLength > (maxResponseBytes as number)) {
          fail(token, "provider response is invalid", "provider_response_invalid");
        }
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch {
          fail(token, "provider response is invalid", "provider_response_invalid");
        }
        return projectProviderBody(token, parsed);
      } catch (error) {
        if (isOwnError(error, token)) throw error;
        throw phase === "fetch"
          ? makeError(token, "request failed", "transport_failed")
          : makeError(token, "provider response is invalid", "provider_response_invalid");
      } finally {
        completed = true;
        if (timerInstalled) {
          try { clearTimer(timerHandle); } catch { /* cleanup must not expose timer errors */ }
        }
      }
    } catch (error) {
      if (isOwnError(error, token)) throw error;
      throw makeError(token, "invalid input");
    }
  };
}
