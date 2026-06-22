/**
 * PR3c-1 — session processState read/write.
 * PR3c-2 consumes legacy processState_{N-1} via sessionProcessGuidance.
 * Stores enum-only state in conversations.metadata — never reasoning or raw text.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ProcessState } from "./processState.ts";
import type {
  ProcessCertainty,
  ProcessClosure,
  ProcessContact,
  ProcessMovement,
  StructuredProcessState,
} from "./structuredTurnSchema.ts";
import {
  PROCESS_CERTAINTIES,
  PROCESS_CLOSURES,
  PROCESS_CONTACTS,
  PROCESS_MOVEMENTS,
} from "./structuredTurnSchema.ts";

export type SessionProcessStateSource = "legacy_shadow" | "structured_shadow";

export interface SessionProcessState {
  contact: ProcessContact;
  movement: ProcessMovement;
  closure: ProcessClosure;
  certainty: ProcessCertainty;
  source: SessionProcessStateSource;
  updatedAt: string;
}

export interface ConversationMetadata {
  processState?: SessionProcessState;
  processStateStructured?: SessionProcessState;
}

export interface ExtractedSessionProcessState {
  legacy: SessionProcessState | null;
  structured: SessionProcessState | null;
}

const SESSION_STATE_KEYS = [
  "contact",
  "movement",
  "closure",
  "certainty",
  "source",
  "updatedAt",
] as const;

const FORBIDDEN_METADATA_KEYS = new Set([
  "reasoning",
  "evidence",
  "diagnosis",
  "interpretation",
  "raw",
  "quote",
  "response",
  "openFigure",
  "processStateRaw",
]);

function isEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/** Parse and whitelist a persisted session processState blob. */
export function parseSessionProcessState(value: unknown): SessionProcessState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const obj = value as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) return null;
    if (!(SESSION_STATE_KEYS as readonly string[]).includes(key)) return null;
  }

  const { contact, movement, closure, certainty, source, updatedAt } = obj;

  if (
    !isEnumValue(contact, PROCESS_CONTACTS) ||
    !isEnumValue(movement, PROCESS_MOVEMENTS) ||
    !isEnumValue(closure, PROCESS_CLOSURES) ||
    !isEnumValue(certainty, PROCESS_CERTAINTIES) ||
    (source !== "legacy_shadow" && source !== "structured_shadow") ||
    !isIsoTimestamp(updatedAt)
  ) {
    return null;
  }

  return { contact, movement, closure, certainty, source, updatedAt };
}

/** Map PR3a computeProcessState output to persistable legacy session state. */
export function buildLegacySessionProcessState(
  state: ProcessState,
  updatedAt: string = new Date().toISOString()
): SessionProcessState {
  return {
    contact: state.contact,
    movement: state.movement,
    closure: state.closure,
    certainty: state.certainty,
    source: "legacy_shadow",
    updatedAt,
  };
}

/** Map structured shadow parse output to persistable session state. */
export function buildStructuredSessionProcessState(
  state: StructuredProcessState,
  updatedAt: string = new Date().toISOString()
): SessionProcessState {
  return {
    contact: state.contact,
    movement: state.movement,
    closure: state.closure,
    certainty: state.certainty,
    source: "structured_shadow",
    updatedAt,
  };
}

/** Read prior-turn processState from conversations.metadata (N-1 for current turn). */
export function extractSessionProcessStateFromMetadata(
  metadata: unknown
): ExtractedSessionProcessState {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { legacy: null, structured: null };
  }

  const obj = metadata as Record<string, unknown>;
  return {
    legacy: parseSessionProcessState(obj.processState),
    structured: parseSessionProcessState(obj.processStateStructured),
  };
}

/**
 * Build a metadata patch with allowed keys only.
 * Merges with existing metadata — never replaces unrelated keys.
 */
export function buildProcessStateMetadataPatch(
  existing: unknown,
  patch: {
    processState?: SessionProcessState | null;
    processStateStructured?: SessionProcessState | null;
  }
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const prior = extractSessionProcessStateFromMetadata(existing);

  if (patch.processState) {
    const legacy = parseSessionProcessState(patch.processState);
    if (legacy) base.processState = legacy;
  } else if (prior.legacy) {
    base.processState = prior.legacy;
  }

  if (patch.processStateStructured) {
    const structured = parseSessionProcessState(patch.processStateStructured);
    if (structured) base.processStateStructured = structured;
  } else if (prior.structured) {
    base.processStateStructured = prior.structured;
  }

  return base;
}

/** Audit log for prior-turn session state — no raw metadata, no user text. */
export function logSessionProcessStateRead(
  extracted: ExtractedSessionProcessState
): void {
  const { legacy, structured } = extracted;
  console.log(
    "[staysee-chat] session_process_state_read",
    JSON.stringify({
      has_legacy: !!legacy,
      legacy_contact: legacy?.contact ?? null,
      legacy_movement: legacy?.movement ?? null,
      legacy_closure: legacy?.closure ?? null,
      legacy_certainty: legacy?.certainty ?? null,
      has_structured: !!structured,
      structured_contact: structured?.contact ?? null,
      structured_movement: structured?.movement ?? null,
      structured_closure: structured?.closure ?? null,
      structured_certainty: structured?.certainty ?? null,
    })
  );
}

/**
 * Persist processState_N after turn completes.
 * Updates metadata column only — summary/title columns untouched (Variant A).
 * Merges with existing metadata keys.
 */
export async function persistSessionProcessState(
  supabase: SupabaseClient,
  conversationId: string,
  patch: {
    processState?: SessionProcessState | null;
    processStateStructured?: SessionProcessState | null;
  }
): Promise<void> {
  const { data, error: readError } = await supabase
    .from("conversations")
    .select("metadata")
    .eq("id", conversationId)
    .maybeSingle();

  if (readError) {
    console.error(
      "[staysee-chat] session_process_state_write read failed:",
      readError.message
    );
    return;
  }

  const merged = buildProcessStateMetadataPatch(data?.metadata ?? {}, patch);

  const { error: writeError } = await supabase
    .from("conversations")
    .update({ metadata: merged })
    .eq("id", conversationId);

  if (writeError) {
    console.error(
      "[staysee-chat] session_process_state_write failed:",
      writeError.message
    );
    return;
  }

  const legacy = parseSessionProcessState(merged.processState);
  const structured = parseSessionProcessState(merged.processStateStructured);

  console.log(
    "[staysee-chat] session_process_state_write",
    JSON.stringify({
      has_legacy: !!legacy,
      legacy_contact: legacy?.contact ?? null,
      legacy_movement: legacy?.movement ?? null,
      has_structured: !!structured,
      structured_contact: structured?.contact ?? null,
      structured_movement: structured?.movement ?? null,
    })
  );
}
