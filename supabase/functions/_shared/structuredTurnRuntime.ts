/**
 * Structured turn runtime audit — PR3b-2 wiring without user-facing changes.
 * Does not invoke model calls; prepares audit metadata for depth_meta console log.
 */

import type { StructuredFallbackReason } from "./structuredTurnParser.ts";
import {
  isStructuredTurnEnabled,
  type StructuredTurnMode,
} from "./structuredTurnMode.ts";

export const STRUCTURED_CALL_NOT_WIRED = "structured_call_not_wired" as const;

export interface StructuredTurnAuditMeta {
  structured_turn_mode: StructuredTurnMode;
  structured_turn_enabled: boolean;
  structured_parse_ok: boolean | null;
  structured_fallback_reason: StructuredFallbackReason | typeof STRUCTURED_CALL_NOT_WIRED | null;
}

export interface StructuredTurnRuntimeResult {
  audit: StructuredTurnAuditMeta;
  /** Plain pipeline always runs in PR3b-2. */
  usePlainPipeline: true;
}

/**
 * PR3b-2: structured path is not wired — user response always from plain callModel.
 * PR3b-3+ will attempt parseStructuredTurn inside structured branch.
 */
export function resolveStructuredTurnRuntime(
  mode: StructuredTurnMode
): StructuredTurnRuntimeResult {
  if (!isStructuredTurnEnabled(mode)) {
    return {
      usePlainPipeline: true,
      audit: {
        structured_turn_mode: "off",
        structured_turn_enabled: false,
        structured_parse_ok: null,
        structured_fallback_reason: null,
      },
    };
  }

  return {
    usePlainPipeline: true,
    audit: {
      structured_turn_mode: mode,
      structured_turn_enabled: true,
      structured_parse_ok: false,
      structured_fallback_reason: STRUCTURED_CALL_NOT_WIRED,
    },
  };
}
