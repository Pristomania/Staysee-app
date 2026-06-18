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
assert(off.meta.structured_attempted === false, "off not attempted");
assert(off.meta.structured_parse_ok === null, "off parse_ok null");
assert(off.meta.structured_fallback_reason === null, "off no fallback");
console.log("✓ off → no attempt");

// 2. shadow + unsupported → no attempt, model_not_supported
const shadowUnsupported = planStructuredTurnAudit("shadow", "anthropic/claude-3.5-sonnet");
assert(shadowUnsupported.shouldAttemptStructuredCall === false, "unsupported should not attempt");
assert(shadowUnsupported.meta.structured_turn_enabled === true, "shadow enabled");
assert(shadowUnsupported.meta.structured_model_supported === false, "unsupported model");
assert(shadowUnsupported.meta.structured_attempted === false, "unsupported not attempted");
assert(shadowUnsupported.meta.structured_parse_ok === false, "unsupported parse_ok false");
assert(
  shadowUnsupported.meta.structured_fallback_reason === "model_not_supported",
  "unsupported fallback"
);
console.log("✓ shadow + unsupported → no attempt, model_not_supported");

// 3. shadow + supported → shouldAttempt=true
const shadowSupported = planStructuredTurnAudit("shadow", "openai/gpt-4o");
assert(shadowSupported.shouldAttemptStructuredCall === true, "supported should attempt");
assert(shadowSupported.meta.structured_model_supported === true, "supported model");
assert(shadowSupported.meta.structured_attempted === false, "not attempted until call");
assert(shadowSupported.meta.structured_parse_ok === null, "parse pending");
assert(shadowSupported.meta.structured_fallback_reason === null, "no fallback before call");
console.log("✓ shadow + supported → shouldAttempt=true");

// 4. response → no response mode, response_mode_not_wired
const response = planStructuredTurnAudit("response", "openai/gpt-4o");
assert(response.shouldAttemptStructuredCall === false, "response should not attempt");
assert(response.meta.structured_attempted === false, "response not attempted");
assert(
  response.meta.structured_fallback_reason === "response_mode_not_wired",
  "response not wired"
);
console.log("✓ response → response_mode_not_wired");

// 5. structured call exception → structured_call_error
const callError = applyStructuredShadowCallError(shadowSupported.meta, "openai/gpt-4o");
assert(callError.structured_attempted === true, "call error attempted");
assert(callError.structured_parse_ok === false, "call error parse_ok false");
assert(
  callError.structured_fallback_reason === "structured_call_error",
  "call error fallback"
);
console.log("✓ structured call exception → structured_call_error");

// 6. parse failure maps reason correctly
const parseFail = finalizeStructuredShadowAudit(
  shadowSupported.meta,
  "openai/gpt-4o",
  "{not json"
);
assert(parseFail.structured_attempted === true, "parse fail attempted");
assert(parseFail.structured_parse_ok === false, "parse fail parse_ok false");
assert(parseFail.structured_fallback_reason === "invalid_json", "invalid_json reason");
assert(parseFail.structured_process_contact === null, "no process on fail");
console.log("✓ parse failure maps reason correctly");

// 7. parse success maps structured fields
const parseOk = finalizeStructuredShadowAudit(
  shadowSupported.meta,
  "openai/gpt-4o",
  validStructuredJson
);
assert(parseOk.structured_attempted === true, "parse ok attempted");
assert(parseOk.structured_parse_ok === true, "parse ok true");
assert(parseOk.structured_fallback_reason === null, "parse ok no fallback");
assert(parseOk.structured_model === "openai/gpt-4o", "structured model set");
assert(parseOk.structured_process_contact === "active", "process contact");
assert(parseOk.structured_process_movement === "opening", "process movement");
assert(parseOk.structured_process_closure === "system_should_not_close", "process closure");
assert(parseOk.structured_process_certainty === "low", "process certainty");
assert(parseOk.structured_open_figure === true, "open figure");
assert(parseOk.structured_open_figure_kind === "emotional", "open figure kind");

const merged = mergeStructuredParseResult(
  shadowSupported.meta,
  parseStructuredTurn(validStructuredJson)
);
assert(merged.structured_parse_ok === true, "merge parse ok");
console.log("✓ parse success maps structured fields");

console.log("\nAll structuredTurnRuntime cases passed.");
