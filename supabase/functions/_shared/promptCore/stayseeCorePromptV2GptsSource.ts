/**
 * StaySee prompt core v2 — GPTs source transplant layer.
 * Active only when STAYSEE_PROMPT_CORE=v2.
 *
 * Core body is NOT authored here. Product owner inserts approved GPTs source text
 * in place of TODO_APPROVED_GPTS_SOURCE_CORE_TEXT_WILL_BE_INSERTED_SEPARATELY.
 *
 * Source snapshots: docs/gpts-source/*.md
 */

export const STAYSEE_CORE_V2_LAYER_ID = "staysee-core-v2-gpts-source";

const STAYSEE_CORE_V2_GPTS_SOURCE_TEXT = `
# STAYSEE CORE V2 (GPTs SOURCE)

TODO_APPROVED_GPTS_SOURCE_CORE_TEXT_WILL_BE_INSERTED_SEPARATELY
`.trim();

export function buildStayseeCorePromptV2GptsSource(): string {
  return STAYSEE_CORE_V2_GPTS_SOURCE_TEXT;
}
