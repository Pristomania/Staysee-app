/**
 * Model router — Core V2 flat ordinary runtime cases.
 * Run: npx tsx supabase/functions/_shared/modelRouter.cases.test.ts
 */

import { APPROVED_MODEL_GPT4O, APPROVED_MODEL_SONNET } from "./approvedModels.ts";
import { resolveChatModel } from "./modelRouter.ts";

globalThis.Deno = { env: { get: () => undefined } };

let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.log(`FAIL: ${message}`);
    failed++;
    return;
  }
  console.log(`PASS: ${message}`);
}

console.log("=== modelRouter flat ordinary ===\n");

for (const depth of ["brief", "medium", "deep"] as const) {
  const route = resolveChatModel({
    depth,
    safetyCategory: "normal",
    flatOrdinary: true,
  });
  assert(route.model === APPROVED_MODEL_GPT4O, `flat ${depth} → gpt-4o primary`);
  assert(route.source === "flat_ordinary", `flat ${depth} → source flat_ordinary`);
  assert(
    route.fallbackModel === APPROVED_MODEL_SONNET,
    `flat ${depth} → sonnet fallback only`,
  );
}

console.log("\n=== modelRouter depth-routed legacy (no flat) ===\n");

const deepLegacy = resolveChatModel({ depth: "deep", safetyCategory: "normal" });
assert(deepLegacy.model === APPROVED_MODEL_SONNET, "legacy deep → sonnet primary");
assert(deepLegacy.source === "deep", "legacy deep → source deep");

const briefLegacy = resolveChatModel({ depth: "brief", safetyCategory: "normal" });
assert(briefLegacy.model === APPROVED_MODEL_GPT4O, "legacy brief → gpt-4o");

console.log("\n=== modelRouter: no separate model for a crisis (the model understands it from the prompt) ===\n");

for (const flatOrdinary of [true, false]) {
  const ordinary = resolveChatModel({ depth: "brief", safetyCategory: "normal", flatOrdinary });
  const crisis = resolveChatModel({ depth: "brief", safetyCategory: "crisis", flatOrdinary });
  assert(crisis.model === ordinary.model, `crisis (flat=${flatOrdinary}) → the same model as an ordinary turn`);
  assert(crisis.source === ordinary.source, `crisis (flat=${flatOrdinary}) → the same route as an ordinary turn`);
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("\nAll modelRouter cases passed.");
