/**
 * Prompt core mode — legacy SURGERY1 vs staysee-core-v1 vs staysee-core-v2-gpts-source.
 * Default: legacy (fail-safe for unset / empty / invalid env).
 */

import { STAYSEE_CORE_LAYER_ID } from "./stayseeCorePrompt.ts";
import { STAYSEE_CORE_V2_LAYER_ID } from "./stayseeCorePromptV2GptsSource.ts";

/** Must match SURGERY1_LAYER_ID in surgery1Prompt.ts (avoid import cycle). */
const LEGACY_PROMPT_LAYER_ID = "surgery1-v3-cognitive-v1-process-core";

export const PROMPT_CORE_ENV_KEY = "STAYSEE_PROMPT_CORE";

export type PromptCoreMode = "legacy" | "v1" | "v2";

/** Parse raw env value; unknown / empty / missing → "legacy". */
export function parsePromptCoreMode(
  raw: string | undefined | null
): PromptCoreMode {
  const trimmed = raw?.trim();
  if (trimmed === "v1") return "v1";
  if (trimmed === "v2") return "v2";
  return "legacy";
}

export function getPromptCoreMode(
  readEnv: () => string | undefined = () => {
    if (typeof Deno !== "undefined") {
      return Deno.env.get(PROMPT_CORE_ENV_KEY);
    }
    return undefined;
  }
): PromptCoreMode {
  return parsePromptCoreMode(readEnv());
}

export function resolveActivePromptLayerId(
  readEnv?: () => string | undefined
): string {
  const mode = getPromptCoreMode(readEnv);
  if (mode === "v1") return STAYSEE_CORE_LAYER_ID;
  if (mode === "v2") return STAYSEE_CORE_V2_LAYER_ID;
  return LEGACY_PROMPT_LAYER_ID;
}
