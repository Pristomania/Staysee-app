/**
 * Prompt core mode — legacy SURGERY1 vs staysee-core-v1 vs staysee-core-v2-gpts-source.
 * Default: legacy (fail-safe for unset / empty / invalid env).
 *
 * Within v2, a second independent flag STAYSEE_PROMPT_CORE_DOC selects which BASE
 * document is mounted. It does NOT change the runtime: getPromptCoreMode stays "v2",
 * so flat ordinary runtime / model routing / budget / safety / pause-closure guidance
 * are all unaffected. Only the base prompt text + audit label change.
 */

import { STAYSEE_CORE_LAYER_ID } from "./stayseeCorePrompt.ts";
import {
  buildStayseeCorePromptV2GptsSource,
  STAYSEE_CORE_V2_LAYER_ID,
} from "./stayseeCorePromptV2GptsSource.ts";
import {
  buildLegacyDocFlatCleanPrompt,
  buildLegacyDocFlatPrompt,
  LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
  LEGACY_DOC_FLAT_LAYER_ID,
} from "./legacyDocFlatPrompt.ts";

/** Must match SURGERY1_LAYER_ID in surgery1Prompt.ts (avoid import cycle). */
const LEGACY_PROMPT_LAYER_ID = "surgery1-v3-cognitive-v1-process-core";

export const PROMPT_CORE_ENV_KEY = "STAYSEE_PROMPT_CORE";
export const PROMPT_CORE_DOC_ENV_KEY = "STAYSEE_PROMPT_CORE_DOC";

export type PromptCoreMode = "legacy" | "v1" | "v2";

/** Base document mounted under v2. Default keeps the approved GPTs source. */
export type PromptCoreDoc =
  | "gpts_source"
  | "legacy_doc_flat"
  | "legacy_doc_flat_clean";

/** Parse raw env value; unknown / empty / missing → "legacy". */
export function parsePromptCoreMode(
  raw: string | undefined | null
): PromptCoreMode {
  const trimmed = raw?.trim();
  if (trimmed === "v1") return "v1";
  if (trimmed === "v2") return "v2";
  return "legacy";
}

/** Parse doc flag; only known experiment values opt in, everything else → gpts_source. */
export function parsePromptCoreDoc(
  raw: string | undefined | null
): PromptCoreDoc {
  const trimmed = raw?.trim();
  if (trimmed === "legacy_doc_flat") return "legacy_doc_flat";
  if (trimmed === "legacy_doc_flat_clean") return "legacy_doc_flat_clean";
  return "gpts_source";
}

function defaultCoreEnvReader(): string | undefined {
  if (typeof Deno !== "undefined") {
    return Deno.env.get(PROMPT_CORE_ENV_KEY);
  }
  return undefined;
}

function defaultDocEnvReader(): string | undefined {
  if (typeof Deno !== "undefined") {
    return Deno.env.get(PROMPT_CORE_DOC_ENV_KEY);
  }
  return undefined;
}

export function getPromptCoreMode(
  readEnv: () => string | undefined = defaultCoreEnvReader
): PromptCoreMode {
  return parsePromptCoreMode(readEnv());
}

export function getPromptCoreDoc(
  readDocEnv: () => string | undefined = defaultDocEnvReader
): PromptCoreDoc {
  return parsePromptCoreDoc(readDocEnv());
}

/**
 * Resolve the v2 base document (text + audit label) from STAYSEE_PROMPT_CORE_DOC.
 * Synchronous — safe for module-load use in staysee-chat.
 */
export function resolveV2Document(
  readDocEnv: () => string | undefined = defaultDocEnvReader
): { text: string; layerId: string } {
  const doc = getPromptCoreDoc(readDocEnv);
  if (doc === "legacy_doc_flat") {
    return {
      text: buildLegacyDocFlatPrompt(),
      layerId: LEGACY_DOC_FLAT_LAYER_ID,
    };
  }
  if (doc === "legacy_doc_flat_clean") {
    return {
      text: buildLegacyDocFlatCleanPrompt(),
      layerId: LEGACY_DOC_FLAT_CLEAN_LAYER_ID,
    };
  }
  return {
    text: buildStayseeCorePromptV2GptsSource(),
    layerId: STAYSEE_CORE_V2_LAYER_ID,
  };
}

/** Layer id for the active v2 base document (no prompt text loaded). */
export function resolveV2DocumentLayerId(
  readDocEnv: () => string | undefined = defaultDocEnvReader
): string {
  return resolveV2Document(readDocEnv).layerId;
}

export function resolveActivePromptLayerId(
  readEnv?: () => string | undefined,
  readDocEnv?: () => string | undefined
): string {
  const mode = getPromptCoreMode(readEnv);
  if (mode === "v1") return STAYSEE_CORE_LAYER_ID;
  if (mode === "v2") return resolveV2DocumentLayerId(readDocEnv);
  return LEGACY_PROMPT_LAYER_ID;
}
