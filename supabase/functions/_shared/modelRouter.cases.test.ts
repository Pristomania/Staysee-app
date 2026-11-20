/**
 * Model router cases (the rule of 20.11.2026: the model is the configured one, the same for every message; nothing is chosen by the
 * words of the message, a "depth" read off them, or a category guessed from them).
 * Run: npx tsx supabase/functions/_shared/modelRouter.cases.test.ts
 */

import {
  APPROVED_MODEL_DEEPSEEK_V4_PRO,
  APPROVED_MODEL_GPT4O,
  APPROVED_MODEL_KIMI_K26,
  APPROVED_MODEL_SONNET,
} from "./approvedModels.ts";
import { resolveChatModel } from "./modelRouter.ts";

const env: Record<string, string> = {};
globalThis.Deno = { env: { get: (key: string) => env[key] } };

let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.log(`FAIL: ${message}`);
    failed++;
    return;
  }
  console.log(`PASS: ${message}`);
}

console.log("=== nothing configured: gpt-4o, with sonnet as the reserve ===\n");
{
  const route = resolveChatModel({});
  assert(route.model === APPROVED_MODEL_GPT4O, "default → gpt-4o primary");
  assert(route.source === "configured", "default → source configured");
  assert(route.fallbackModel === APPROVED_MODEL_SONNET, "default → sonnet reserve");
}

console.log("\n=== configured: the same model for every turn ===\n");
{
  env.STAYSEE_CHAT_MODEL = APPROVED_MODEL_DEEPSEEK_V4_PRO;
  const first = resolveChatModel({});
  const second = resolveChatModel({});
  assert(first.model === APPROVED_MODEL_DEEPSEEK_V4_PRO && second.model === first.model, "STAYSEE_CHAT_MODEL → that model, every time");
  assert(first.fallbackModel === APPROVED_MODEL_KIMI_K26, "DeepSeek V4 Pro → Kimi K2.6 is the reserve");

  // The older per-depth settings still name the model (the first of brief → medium → the main one), but no depth is read any more.
  env.STAYSEE_CHAT_MODEL_BRIEF = APPROVED_MODEL_KIMI_K26;
  assert(resolveChatModel({}).model === APPROVED_MODEL_KIMI_K26, "STAYSEE_CHAT_MODEL_BRIEF still wins over the main one");
  delete env.STAYSEE_CHAT_MODEL_BRIEF;
  delete env.STAYSEE_CHAT_MODEL;
}

console.log("\n=== a model may be asked in the request (dev and tests) ===\n");
{
  const route = resolveChatModel({ requestModel: APPROVED_MODEL_KIMI_K26 });
  assert(route.model === APPROVED_MODEL_KIMI_K26 && route.source === "request", "request model → that model, source request");
}

console.log("\n=== the router takes nothing that is read from the words ===\n");
{
  const input = resolveChatModel.length;
  assert(input === 1, "resolveChatModel takes one argument");
  // A leftover from the older callers is simply not used: the route does not change with it.
  const withLeftovers = resolveChatModel({ depth: "deep", safetyCategory: "crisis", flatOrdinary: false } as never);
  assert(withLeftovers.model === APPROVED_MODEL_GPT4O && withLeftovers.source === "configured", "depth / category leftovers change nothing");
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

console.log("\nAll modelRouter cases passed.");
