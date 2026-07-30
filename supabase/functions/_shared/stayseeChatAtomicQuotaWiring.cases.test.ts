/**
 * Architecture regression only for staysee-chat atomic quota wiring.
 * Concurrency proves staging parallel smoke.
 *
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/stayseeChatAtomicQuotaWiring.cases.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractBalanced(
  src: string,
  openIdx: number,
  openCh: string,
  closeCh: string,
): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error(`unbalanced ${openCh}${closeCh}`);
}

const raw = readFileSync(resolve("supabase/functions/staysee-chat/index.ts"), "utf8");
const noComments = stripComments(raw);

const servePos = noComments.indexOf("Deno.serve(");
assert(servePos >= 0, "Deno.serve( must exist");
const handler = noComments.slice(servePos);

assert(
  /checkRateLimit\s*\(/.test(handler),
  "handler must contain preliminary checkRateLimit(",
);

const gatedAssignRe = /const\s+gated\s*=\s*await\s+runAtomicModelGate\s*\(/;
const gatedMatch = handler.match(gatedAssignRe);
assert(
  gatedMatch !== null && gatedMatch.index !== undefined,
  "const gated = await runAtomicModelGate(...) required",
);
const gatedPos = gatedMatch.index;

const prelimPos = handler.search(/checkRateLimit\s*\(/);
assert(prelimPos >= 0 && prelimPos < gatedPos, "preliminary checkRateLimit before gate");

const beforeGated = handler.slice(0, gatedPos);
assert(
  /safety\.immediateResponse/.test(beforeGated),
  "safety.immediateResponse must appear before gate",
);
assert(
  /detectExplicitPromptAttackHardStop|explicitPromptAttackStop/.test(beforeGated),
  "prompt hard-stop must appear before gate",
);

const gateCallOpen = handler.indexOf("(", gatedPos);
const gateCall = extractBalanced(handler, gateCallOpen, "(", ")");
const optsOpen = gateCall.indexOf("{");
assert(optsOpen >= 0, "gate options object required");
const gateOpts = extractBalanced(gateCall, optsOpen, "{", "}");

const reserveCb = gateOpts.search(/reserve\s*:/);
const providerCb = gateOpts.search(/callModel\s*:/);
assert(reserveCb >= 0 && providerCb >= 0, "reserve and callModel callbacks required");
assert(reserveCb < providerCb, "inside gate opts: reserve before callModel");
assert(
  /reserve\s*:[\s\S]*?reserveAiRequest\s*\(/.test(gateOpts),
  "reserve callback must call reserveAiRequest(",
);
assert(
  /callModel\s*:[\s\S]*?\bcallModel\s*\(/.test(gateOpts),
  "callModel callback must invoke helper callModel(",
);

const reserveCalls = handler.match(/\breserveAiRequest\s*\(/g) ?? [];
assert(
  reserveCalls.length === 1,
  `handler must contain exactly one reserveAiRequest( call, got ${reserveCalls.length}`,
);

const afterGated = handler.slice(gatedPos);
const denyIdx = afterGated.search(/if\s*\(\s*!gated\.ok\s*\)/);
const valueIdx = afterGated.search(/let\s+result\s*=\s*gated\.value/);
assert(denyIdx >= 0, "if (!gated.ok) deny block required after gate");
assert(valueIdx >= 0, "let result = gated.value required");
assert(denyIdx < valueIdx, "deny block must be before gated.value use");

const denyBlock = afterGated.slice(denyIdx, valueIdx);
assert(
  /mapQuotaDenyResponse\s*\(/.test(denyBlock),
  "atomic deny must call mapQuotaDenyResponse(",
);

assert(
  !/\bincrementUsage\s*\(/.test(handler),
  "incrementUsage( must be absent from handler",
);

const afterValue = afterGated.slice(valueIdx);
assert(
  /recordTokenUsage\s*\(/.test(afterValue),
  "recordTokenUsage( must appear after gated.value",
);

console.log("=== stayseeChatAtomicQuotaWiring.cases.test.ts OK ===");
