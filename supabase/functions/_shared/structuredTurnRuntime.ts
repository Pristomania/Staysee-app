/**
 * Structured turn runtime — shadow audit planning and parse merge.
 * Plain pipeline always serves the user; structured output is audit-only.
 */

import {
  parseStructuredTurn,
  type StructuredParseResult,
} from "./structuredTurnParser.ts";
import type {
  OpenFigureKind,
  ProcessCertainty,
  ProcessClosure,
  ProcessContact,
  ProcessMovement,
} from "./structuredTurnSchema.ts";
import { supportsStructuredTurn } from "./structuredTurnModelSupport.ts";
import {
  type StructuredTurnMode,
} from "./structuredTurnMode.ts";

export type StructuredShadowFallbackReason =
  | import("./structuredTurnParser.ts").StructuredFallbackReason
  | "model_not_supported"
  | "structured_call_error"
  | "response_mode_not_wired";

export interface StructuredTurnDepthMeta {
  structured_turn_mode: StructuredTurnMode;
  structured_turn_enabled: boolean;
  structured_model_supported: boolean;
  structured_attempted: boolean;
  structured_parse_ok: boolean | null;
  structured_fallback_reason: StructuredShadowFallbackReason | null;
  structured_process_contact: ProcessContact | null;
  structured_process_movement: ProcessMovement | null;
  structured_process_closure: ProcessClosure | null;
  structured_process_certainty: ProcessCertainty | null;
  structured_open_figure: boolean | null;
  structured_open_figure_kind: OpenFigureKind | null;
  structured_model: string | null;
}

export interface StructuredTurnAuditPlan {
  shouldAttemptStructuredCall: boolean;
  meta: StructuredTurnDepthMeta;
}

const EMPTY_PROCESS_FIELDS = {
  structured_process_contact: null,
  structured_process_movement: null,
  structured_process_closure: null,
  structured_process_certainty: null,
  structured_open_figure: null,
  structured_open_figure_kind: null,
} as const;

export function planStructuredTurnAudit(
  mode: StructuredTurnMode,
  turnModel: string
): StructuredTurnAuditPlan {
  if (mode === "off") {
    return {
      shouldAttemptStructuredCall: false,
      meta: {
        structured_turn_mode: "off",
        structured_turn_enabled: false,
        structured_model_supported: false,
        structured_attempted: false,
        structured_parse_ok: null,
        structured_fallback_reason: null,
        structured_model: null,
        ...EMPTY_PROCESS_FIELDS,
      },
    };
  }

  if (mode === "response") {
    return {
      shouldAttemptStructuredCall: false,
      meta: {
        structured_turn_mode: "response",
        structured_turn_enabled: true,
        structured_model_supported: supportsStructuredTurn(turnModel),
        structured_attempted: false,
        structured_parse_ok: false,
        structured_fallback_reason: "response_mode_not_wired",
        structured_model: null,
        ...EMPTY_PROCESS_FIELDS,
      },
    };
  }

  const modelSupported = supportsStructuredTurn(turnModel);
  if (!modelSupported) {
    return {
      shouldAttemptStructuredCall: false,
      meta: {
        structured_turn_mode: "shadow",
        structured_turn_enabled: true,
        structured_model_supported: false,
        structured_attempted: false,
        structured_parse_ok: false,
        structured_fallback_reason: "model_not_supported",
        structured_model: null,
        ...EMPTY_PROCESS_FIELDS,
      },
    };
  }

  return {
    shouldAttemptStructuredCall: true,
    meta: {
      structured_turn_mode: "shadow",
      structured_turn_enabled: true,
      structured_model_supported: true,
      structured_attempted: false,
      structured_parse_ok: null,
      structured_fallback_reason: null,
      structured_model: null,
      ...EMPTY_PROCESS_FIELDS,
    },
  };
}

export function markStructuredShadowAttempted(
  meta: StructuredTurnDepthMeta
): StructuredTurnDepthMeta {
  return {
    ...meta,
    structured_attempted: true,
  };
}

export function applyStructuredShadowCallError(
  meta: StructuredTurnDepthMeta,
  structuredModel?: string | null
): StructuredTurnDepthMeta {
  return {
    ...meta,
    structured_attempted: true,
    structured_parse_ok: false,
    structured_fallback_reason: "structured_call_error",
    structured_model: structuredModel ?? meta.structured_model,
    ...EMPTY_PROCESS_FIELDS,
  };
}

export function finalizeStructuredShadowAudit(
  meta: StructuredTurnDepthMeta,
  structuredModel: string,
  rawContent: string | null
): StructuredTurnDepthMeta {
  const attempted = {
    ...meta,
    structured_attempted: true,
    structured_model: structuredModel,
  };

  if (!rawContent) {
    return applyStructuredShadowCallError(attempted, structuredModel);
  }

  return mergeStructuredParseResult(attempted, parseStructuredTurn(rawContent));
}

export function mergeStructuredParseResult(
  meta: StructuredTurnDepthMeta,
  parseResult: StructuredParseResult
): StructuredTurnDepthMeta {
  if (!parseResult.ok) {
    return {
      ...meta,
      structured_attempted: true,
      structured_parse_ok: false,
      structured_fallback_reason: parseResult.reason,
      ...EMPTY_PROCESS_FIELDS,
    };
  }

  return {
    ...meta,
    structured_attempted: true,
    structured_parse_ok: true,
    structured_fallback_reason: null,
    structured_process_contact: parseResult.turn.processState.contact,
    structured_process_movement: parseResult.turn.processState.movement,
    structured_process_closure: parseResult.turn.processState.closure,
    structured_process_certainty: parseResult.turn.processState.certainty,
    structured_open_figure: parseResult.turn.openFigure.isOpen,
    structured_open_figure_kind: parseResult.turn.openFigure.kind,
  };
}
