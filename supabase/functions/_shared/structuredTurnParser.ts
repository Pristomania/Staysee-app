/**
 * Structured turn parser — validates model JSON without runtime side effects.
 * Pure logic; Node-testable under tsx.
 */

import {
  FORBIDDEN_KEYS,
  OPEN_FIGURE_CONFIDENCES,
  OPEN_FIGURE_INTENSITIES,
  OPEN_FIGURE_KEYS,
  OPEN_FIGURE_KINDS,
  PROCESS_CERTAINTIES,
  PROCESS_CLOSURES,
  PROCESS_CONTACTS,
  PROCESS_MOVEMENTS,
  PROCESS_STATE_KEYS,
  RESPONSE_MAX_LENGTH,
  RESPONSE_MIN_LENGTH,
  STRUCTURED_TURN_TOP_LEVEL_KEYS,
  buildStructuredTurnJsonSchema,
  type StructuredOpenFigure,
  type StructuredProcessState,
  type StructuredTurn,
} from "./structuredTurnSchema.ts";

export type StructuredFallbackReason =
  | "invalid_json"
  | "schema_violation"
  | "forbidden_field"
  | "missing_response"
  | "response_empty"
  | "response_too_long"
  | "response_contains_json";

export type StructuredParseResult =
  | { ok: true; turn: StructuredTurn; warnings: string[] }
  | { ok: false; reason: StructuredFallbackReason; rawSnippet?: string };

export { buildStructuredTurnJsonSchema };

const RAW_SNIPPET_MAX = 200;

const RESPONSE_JSON_LEAK_RE =
  /"processState"\s*:|"openFigure"\s*:|processState\s*:\s*\{|openFigure\s*:\s*\{/i;

function rawSnippet(raw: string): string {
  return raw.trim().slice(0, RAW_SNIPPET_MAX);
}

/** Strip optional markdown JSON code fences. */
export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fullFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fullFence) return fullFence[1].trim();

  const leadingFence = trimmed.match(/^```(?:json)?\s*([\s\S]+)$/i);
  if (leadingFence) return leadingFence[1].replace(/```\s*$/i, "").trim();

  return trimmed;
}

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (FORBIDDEN_KEYS.has(lower)) return true;
  if (lower.endsWith("style")) return true;
  return false;
}

/** Walk object tree; return first forbidden key path or null. */
export function findForbiddenKeyPath(
  value: unknown,
  path = ""
): string | null {
  if (value === null || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const childPath = `${path}[${i}]`;
      const hit = findForbiddenKeyPath(value[i], childPath);
      if (hit) return hit;
    }
    return null;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isForbiddenKey(key)) {
      return path ? `${path}.${key}` : key;
    }
    const childPath = path ? `${path}.${key}` : key;
    const hit = findForbiddenKeyPath(
      (value as Record<string, unknown>)[key],
      childPath
    );
    if (hit) return hit;
  }

  return null;
}

function hasExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const keys = Object.keys(obj);
  if (keys.length !== allowed.length) return false;
  return allowed.every((key) => keys.includes(key));
}

function isEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function validateProcessState(value: unknown): StructuredProcessState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, PROCESS_STATE_KEYS)) return null;

  if (!isEnumValue(obj.contact, PROCESS_CONTACTS)) return null;
  if (!isEnumValue(obj.movement, PROCESS_MOVEMENTS)) return null;
  if (!isEnumValue(obj.closure, PROCESS_CLOSURES)) return null;
  if (!isEnumValue(obj.certainty, PROCESS_CERTAINTIES)) return null;

  return {
    contact: obj.contact,
    movement: obj.movement,
    closure: obj.closure,
    certainty: obj.certainty,
  };
}

function validateOpenFigure(value: unknown): StructuredOpenFigure | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, OPEN_FIGURE_KEYS)) return null;

  if (typeof obj.isOpen !== "boolean") return null;
  if (!isEnumValue(obj.kind, OPEN_FIGURE_KINDS)) return null;
  if (!isEnumValue(obj.intensity, OPEN_FIGURE_INTENSITIES)) return null;
  if (!isEnumValue(obj.confidence, OPEN_FIGURE_CONFIDENCES)) return null;

  return {
    isOpen: obj.isOpen,
    kind: obj.kind,
    intensity: obj.intensity,
    confidence: obj.confidence,
  };
}

function looksLikeEmbeddedJsonObject(text: string): boolean {
  const trimmed = text.trim();
  if (/^[\[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) return true;
  if (RESPONSE_JSON_LEAK_RE.test(text)) return true;
  return false;
}

function validateResponse(value: unknown): StructuredFallbackReason | null {
  if (value === undefined) return "missing_response";
  if (typeof value !== "string") return "schema_violation";

  const trimmed = value.trim();
  if (trimmed.length < RESPONSE_MIN_LENGTH) return "response_empty";
  if (trimmed.length > RESPONSE_MAX_LENGTH) return "response_too_long";
  if (looksLikeEmbeddedJsonObject(trimmed)) return "response_contains_json";

  return null;
}

export function parseStructuredTurn(raw: string): StructuredParseResult {
  const payload = extractJsonPayload(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "invalid_json", rawSnippet: rawSnippet(raw) };
  }

  const forbiddenPath = findForbiddenKeyPath(parsed);
  if (forbiddenPath) {
    return { ok: false, reason: "forbidden_field", rawSnippet: rawSnippet(raw) };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "schema_violation", rawSnippet: rawSnippet(raw) };
  }

  const root = parsed as Record<string, unknown>;
  if (!("response" in root)) {
    return { ok: false, reason: "missing_response", rawSnippet: rawSnippet(raw) };
  }

  if (!hasExactKeys(root, STRUCTURED_TURN_TOP_LEVEL_KEYS)) {
    return { ok: false, reason: "schema_violation", rawSnippet: rawSnippet(raw) };
  }

  const processState = validateProcessState(root.processState);
  if (!processState) {
    return { ok: false, reason: "schema_violation", rawSnippet: rawSnippet(raw) };
  }

  const openFigure = validateOpenFigure(root.openFigure);
  if (!openFigure) {
    return { ok: false, reason: "schema_violation", rawSnippet: rawSnippet(raw) };
  }

  const responseError = validateResponse(root.response);
  if (responseError) {
    return { ok: false, reason: responseError, rawSnippet: rawSnippet(raw) };
  }

  const response = (root.response as string).trim();

  return {
    ok: true,
    turn: { processState, openFigure, response },
    warnings: [],
  };
}
