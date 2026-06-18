/**
 * Structured turn model allowlist — unit cases.
 * Run: npx tsx supabase/functions/_shared/structuredTurnModelSupport.cases.test.ts
 */

import {
  getStructuredTurnModelAllowlist,
  supportsStructuredTurn,
} from "./structuredTurnModelSupport.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const allowlist = getStructuredTurnModelAllowlist();
assert(allowlist.length === 4, "allowlist v1 has 4 models");
console.log("Allowlist v1:", allowlist.join(", "));

assert(supportsStructuredTurn("openai/gpt-4o") === true, "openai/gpt-4o");
assert(supportsStructuredTurn("openai/gpt-4o-mini") === true, "openai/gpt-4o-mini");
assert(supportsStructuredTurn("openai/gpt-4.1") === true, "openai/gpt-4.1");
assert(supportsStructuredTurn("openai/gpt-4.1-mini") === true, "openai/gpt-4.1-mini");
console.log("✓ allowed models");

assert(supportsStructuredTurn("  OpenAI/GPT-4o  ") === true, "trim + case normalize");
assert(supportsStructuredTurn("OPENAI/GPT-4.1") === true, "uppercase normalize");
console.log("✓ normalization");

assert(
  supportsStructuredTurn("anthropic/claude-sonnet-4-5") === false,
  "anthropic"
);
assert(supportsStructuredTurn("google/gemini-2.5-pro") === false, "google");
assert(supportsStructuredTurn("meta/llama-4") === false, "meta");
assert(
  supportsStructuredTurn("deepseek/deepseek-chat") === false,
  "deepseek"
);
assert(
  supportsStructuredTurn("openai/gpt-4o-preview") === false,
  "preview variant"
);
assert(supportsStructuredTurn("mistral/mistral-large") === false, "mistral");
assert(supportsStructuredTurn("x-ai/grok-2") === false, "x-ai");
console.log("✓ unsupported models");

assert(supportsStructuredTurn("") === false, "empty string");
assert(supportsStructuredTurn("   ") === false, "whitespace only");
assert(supportsStructuredTurn(null) === false, "null");
assert(supportsStructuredTurn(undefined) === false, "undefined");
console.log("✓ invalid inputs");

console.log("\nAll structuredTurnModelSupport cases passed.");
