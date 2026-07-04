/**
 * Core V2 Phase 1 — flat ordinary runtime.
 * Depth trajectory remains for diagnostics; it must not steer model, budget, or
 * openFigure/uncertainty guidance on ordinary non-crisis turns when prompt core is v2.
 */

import { getPromptCoreMode } from "./promptCore/promptCoreMode.ts";
import type { SafetyCategory } from "./safety.ts";

export function isFlatCoreV2OrdinaryRuntime(
  safetyCategory: SafetyCategory,
  readEnv: () => string | undefined = () => {
    if (typeof Deno !== "undefined") {
      return Deno.env.get("STAYSEE_PROMPT_CORE");
    }
    return undefined;
  },
): boolean {
  if (getPromptCoreMode(readEnv) !== "v2") return false;
  if (safetyCategory === "crisis") return false;
  return true;
}
