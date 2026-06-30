/**
 * Stable version labels for ai_usage_logs audit columns (no prompt text).
 */

import { resolveActivePromptLayerId } from "./promptCore/promptCoreMode.ts";
import { SURGERY1_LAYER_ID } from "./surgery1Prompt.ts";

/** Legacy default — unchanged for callers expecting static surgery1 label. */
export const AI_AUDIT_PROMPT_VERSION = SURGERY1_LAYER_ID;

export function getPromptAuditVersion(
  readEnv?: () => string | undefined
): string {
  return resolveActivePromptLayerId(readEnv);
}

export const AI_AUDIT_CONSTITUTION_VERSION = "constitution-v3-beta";
export const AI_AUDIT_COGNITIVE_SIGNATURE_VERSION = "cognitive-signature-v1";
export const AI_AUDIT_MEMORY_VERSION = "structured-memory-v1";
