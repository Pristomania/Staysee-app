/**
 * Structured turn runtime audit — unit cases.
 * Run: npx tsx supabase/functions/_shared/structuredTurnRuntime.cases.test.ts
 */

import { parseStructuredTurn } from "./structuredTurnParser.ts";
import {
  applyStructuredShadowCallError,
  finalizeStructuredShadowAudit,
  mergeStructuredParseResult,
  planStructuredTurnAudit,
} from "./structuredTurnRuntime.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const validStructuredJson = JSON.stringify({
  processState: {
    contact: "active",
    movement: "opening",
    closure: "system_should_not_close",
    certainty: "low",
  },
  openFigure: {
    isOpen: true,
    kind: "emotional",
    intensity: "medium",
    confidence: "low",
  },
  response: "Похоже, сейчас непросто. Что для тебя самое тяжёлое?",
});

// 1. off → no attempt
const off = planStructuredTurnAudit("off", "openai/gpt-4o");
assert(off.shouldAttemptStructuredCall === false, "off should not attempt");
assert(off.meta.structured_turn_enabled === false, "off not enabled");
assert(off.meta.structured_shadow_pct === null, "off shadow pct null");
assert(off.meta.structured_shadow_pct_passed === null, "off pct passed null");
assert(off.meta.structured_attempted === false, "off not attempted");
assert(off.meta.structured_parse_ok === null, "off parse_ok null");
assert(off.meta.structured_fallback_reason === null, "off no fallback");
console.log("✓ off → no attempt");

// 2. shadow + pct undefined → shadow_pct_skip
const shadowPctUnset = planStructuredTurnAudit("shadow", "openai/gpt-4o");
assert(shadowPctUnset.shouldAttemptStructuredCall === false, "unset pct no attempt");
assert(shadowPctUnset.meta.structured_shadow_pct === null, "unset pct null");
assert(shadowPctUnset.meta.structured_shadow_pct_passed === false, "unset pct not passed");
assert(
  shadowPctUnset.meta.structured_fallback_reason === "shadow_pct_skip",
  "unset pct skip"
);
console.log("✓ shadow + pct undefined → shadow_pct_skip");

// 3. shadow + pct=0 → shadow_pct_skip
const shadowPctZero = planStructuredTurnAudit("shadow", "openai/gpt-4o", "0");
assert(shadowPctZero.shouldAttemptStructuredCall === false, "pct 0 no attempt");
assert(shadowPctZero.meta.structured_shadow_pct === 0, "pct 0 audit");
assert(
  shadowPctZero.meta.structured_fallback_reason === "shadow_pct_skip",
  "pct 0 skip"
);
console.log("✓ shadow + pct=0 → shadow_pct_skip");

// 4. shadow + unsupported + pct=100 → model_not_supported
const shadowUnsupported = planStructuredTurnAudit(
  "shadow",
  "anthropic/claude-3.5-sonnet",
  "100"
);
assert(shadowUnsupported.shouldAttemptStructuredCall === false, "unsupported should not attempt");
assert(shadowUnsupported.meta.structured_shadow_pct === 100, "pct 100 audit");
assert(shadowUnsupported.meta.structured_shadow_pct_passed === true, "pct passed");
assert(shadowUnsupported.meta.structured_model_supported === false, "unsupported model");
assert(
  shadowUnsupported.meta.structured_fallback_reason === "model_not_supported",
  "unsupported fallback"
);
console.log("✓ shadow + pct=100 + unsupported → model_not_supported");

// 5. shadow + supported + pct=100 → shouldAttempt=true
const shadowSupported = planStructuredTurnAudit("shadow", "openai/gpt-4o", "100");
assert(shadowSupported.shouldAttemptStructuredCall === true, "supported should attempt");
assert(shadowSupported.meta.structured_shadow_pct === 100, "pct 100");
assert(shadowSupported.meta.structured_shadow_pct_passed === true, "pct passed");
assert(shadowSupported.meta.structured_model_supported === true, "supported model");
assert(shadowSupported.meta.structured_fallback_reason === null, "no fallback before call");
console.log("✓ shadow + pct=100 + supported → shouldAttempt=true");

// 6. shadow + pct=5 + random fail → shadow_pct_skip
const shadowPctFail = planStructuredTurnAudit("shadow", "openai/gpt-4o", "5", () => 0.05);
assert(shadowPctFail.shouldAttemptStructuredCall === false, "pct fail no attempt");
assert(shadowPctFail.meta.structured_shadow_pct === 5, "pct 5 audit");
assert(shadowPctFail.meta.structured_shadow_pct_passed === false, "pct not passed");
assert(
  shadowPctFail.meta.structured_fallback_reason === "shadow_pct_skip",
  "pct fail skip"
);
console.log("✓ shadow + pct=5 + random fail → shadow_pct_skip");

// 7. shadow + pct=5 + random pass + supported → attempt
const shadowPctPass = planStructuredTurnAudit("shadow", "openai/gpt-4o", "5", () => 0.04);
assert(shadowPctPass.shouldAttemptStructuredCall === true, "pct pass should attempt");
assert(shadowPctPass.meta.structured_shadow_pct_passed === true, "pct passed");
console.log("✓ shadow + pct=5 + random pass + supported → attempt");

// 8. response → unchanged
const response = planStructuredTurnAudit("response", "openai/gpt-4o", "100");
assert(response.shouldAttemptStructuredCall === false, "response should not attempt");
assert(response.meta.structured_shadow_pct === null, "response pct null");
assert(
  response.meta.structured_fallback_reason === "response_mode_not_wired",
  "response not wired"
);
console.log("✓ response → response_mode_not_wired");

// 9. structured call exception → structured_call_error
const callError = applyStructuredShadowCallError(shadowSupported.meta, "openai/gpt-4o");
assert(callError.structured_fallback_reason === "structured_call_error", "call error fallback");
console.log("✓ structured call exception → structured_call_error");

// 10. parse failure maps reason correctly
const parseFail = finalizeStructuredShadowAudit(
  shadowSupported.meta,
  "openai/gpt-4o",
  "{not json"
);
assert(parseFail.structured_fallback_reason === "invalid_json", "invalid_json reason");
console.log("✓ parse failure maps reason correctly");

// 11. parse success maps structured fields
const parseOk = finalizeStructuredShadowAudit(
  shadowSupported.meta,
  "openai/gpt-4o",
  validStructuredJson
);
assert(parseOk.structured_parse_ok === true, "parse ok true");
assert(parseOk.structured_process_movement === "opening", "process movement");

const merged = mergeStructuredParseResult(
  shadowSupported.meta,
  parseStructuredTurn(validStructuredJson)
);
assert(merged.structured_parse_ok === true, "merge parse ok");
console.log("✓ parse success maps structured fields");

console.log("\nAll structuredTurnRuntime cases passed.");
